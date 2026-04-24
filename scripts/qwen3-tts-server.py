#!/usr/bin/env python3

from __future__ import annotations

import asyncio
import atexit
import fcntl
import io
import logging
import os
import time
import uuid
from pathlib import Path
import threading
import sys

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

LOGGER = logging.getLogger("qwen3-tts-server")

DEFAULT_HOST = os.getenv("QWEN3_TTS_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.getenv("QWEN3_TTS_PORT", "8001"))
DEFAULT_MODEL_ID = os.getenv(
    "QWEN3_TTS_MODEL",
    "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16",
)
DEFAULT_LANGUAGE = os.getenv("QWEN3_TTS_LANGUAGE", "English")
DEFAULT_SPEAKER = os.getenv("QWEN3_TTS_SPEAKER", "Ryan")
DEFAULT_STREAMING_INTERVAL = float(os.getenv("QWEN3_TTS_STREAMING_INTERVAL", "0.32"))
TTS_TIMING_ENABLED = os.getenv("SONNY_TTS_DIAG", "").lower() in {"1", "true", "yes", "on"}
LOCK_PATH = Path(os.getenv("TMPDIR", "/tmp")) / "sonny-services" / "locks" / "qwen3-tts-server.pid"

EMOTION_INSTRUCTIONS = {
    "neutral": "Speak in a natural, balanced, neutral tone.",
    "hesitant": "Speak with a slight hesitation, softer pacing, and mild uncertainty.",
    "confident": "Speak clearly, steadily, and with confident delivery.",
    "humorous": "Speak with playful warmth, light amusement, and a subtle smile.",
    "assertive": "Speak directly, firmly, and with crisp emphasis.",
    "happy": "Speak in a warm, upbeat, happy tone.",
    "sad": "Speak gently in a subdued, slightly sad tone.",
    "excited": "Speak energetically with lively excitement and strong momentum.",
    "calm": "Speak in a calm, relaxed, reassuring tone.",
}


_TRACE_START: dict[str, float] = {}
_STREAM_END = object()


def log_tts_timing(message: str, *args) -> None:
    if TTS_TIMING_ENABLED:
        LOGGER.info(message, *args)


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1)
    emotion: str = Field(default="neutral")
    language: str = Field(default=DEFAULT_LANGUAGE)
    speaker: str = Field(default=DEFAULT_SPEAKER)
    voice: str = Field(default="ryan")
    exaggeration: float = Field(default=1.0, ge=0.25, le=2.0)


class Qwen3TTSService:
    def __init__(self) -> None:
        self._model = None
        self._model_lock = threading.Lock()
        self._generate_lock = threading.Lock()

    def ensure_model(self):
        with self._model_lock:
            if self._model is not None:
                return self._model

            from mlx_audio.tts.utils import load

            LOGGER.info("Loading mlx-audio model %s", DEFAULT_MODEL_ID)
            self._model = load(DEFAULT_MODEL_ID)
            LOGGER.info("Model loaded successfully")

            return self._model

    def synthesize(self, request: SynthesizeRequest, trace_id: str | None = None) -> bytes:
        chunks, sample_rate = self._generate_audio_chunks(request, trace_id=trace_id)
        audio = np.concatenate(chunks)

        if audio.ndim > 1:
            audio = audio.reshape(-1)

        buffer = io.BytesIO()
        sf.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")

        return buffer.getvalue()

    def stream_synthesize(self, request: SynthesizeRequest, trace_id: str | None = None):
        header_sent = False
        chunk_count = 0
        t0 = _TRACE_START.get(trace_id, time.perf_counter())
        model = self.ensure_model()
        log_tts_timing(
            "[tts-timing] trace=%s event=model_ready t=%.1fms",
            trace_id,
            (time.perf_counter() - t0) * 1000,
        )

        if not hasattr(model, "batch_generate"):
            raise RuntimeError("Loaded mlx-audio model does not support batch_generate")

        instruct = self._build_instruction(
            emotion=request.emotion,
            exaggeration=request.exaggeration,
        )
        voice = request.speaker or request.voice or DEFAULT_SPEAKER

        with self._generate_lock:
            log_tts_timing(
                "[tts-timing] trace=%s event=inference_started api=batch_generate text_len=%d voice=%s speaker=%s emotion=%s streaming_interval=%.2f t=%.1fms",
                trace_id,
                len(request.text),
                request.voice,
                request.speaker,
                request.emotion,
                DEFAULT_STREAMING_INTERVAL,
                (time.perf_counter() - t0) * 1000,
            )
            t_before_generate = time.perf_counter()
            results = model.batch_generate(
                texts=[request.text],
                voices=[voice],
                instructs=[instruct],
                lang_code=request.language or DEFAULT_LANGUAGE,
                stream=True,
                streaming_interval=DEFAULT_STREAMING_INTERVAL,
            )
            log_tts_timing(
                "[tts-timing] trace=%s event=batch_generate_call_returned type=%s t=%.1fms",
                trace_id,
                type(results).__name__,
                (time.perf_counter() - t0) * 1000,
            )

            yield_index = 0
            last_yield_ts = t_before_generate
            first_non_empty_logged = False

            for result in results:
                now = time.perf_counter()
                chunk = self._audio_array_from_result(result)
                delta_ms = (now - last_yield_ts) * 1000
                since_call_ms = (now - t_before_generate) * 1000
                sample_rate = int(getattr(result, "sample_rate", 0) or 0)
                is_final_chunk = getattr(result, "is_final_chunk", None)
                log_tts_timing(
                    "[tts-timing] trace=%s event=batch_generate_yield idx=%d samples=%d sample_rate=%s has_audio_chunk=%s has_audio=%s has_is_final_chunk=%s is_final_chunk=%s since_call=%.1fms delta=%.1fms t=%.1fms",
                    trace_id,
                    yield_index,
                    int(chunk.size),
                    sample_rate or "?",
                    hasattr(result, "audio_chunk"),
                    hasattr(result, "audio"),
                    hasattr(result, "is_final_chunk"),
                    is_final_chunk,
                    since_call_ms,
                    delta_ms,
                    (now - t0) * 1000,
                )
                last_yield_ts = now
                yield_index += 1

                if chunk.size == 0:
                    continue

                if sample_rate <= 0:
                    raise RuntimeError("Streaming result did not include a sample rate")

                if not first_non_empty_logged:
                    log_tts_timing(
                        "[tts-timing] trace=%s event=first_chunk_generated samples=%d t=%.1fms",
                        trace_id,
                        int(chunk.size),
                        (now - t0) * 1000,
                    )
                    first_non_empty_logged = True

                if not header_sent:
                    yield build_streaming_wav_header(sample_rate=sample_rate)
                    header_sent = True
                    log_tts_timing(
                        "[tts-timing] trace=%s event=first_chunk_sent t=%.1fms",
                        trace_id,
                        (time.perf_counter() - t0) * 1000,
                    )

                if chunk.ndim > 1:
                    chunk = chunk.reshape(-1)

                clipped = np.clip(chunk, -1.0, 1.0)
                pcm = (clipped * np.int16(32767)).astype(np.int16)
                chunk_count += 1
                yield pcm.tobytes()

            log_tts_timing(
                "[tts-timing] trace=%s event=inference_finished total_yields=%d chunks=%d t=%.1fms",
                trace_id,
                yield_index,
                chunk_count,
                (time.perf_counter() - t0) * 1000,
            )

        if not header_sent:
            raise RuntimeError("Model did not return any audio")

        log_tts_timing(
            "[tts-timing] trace=%s event=full_synth_sent chunks=%d t=%.1fms",
            trace_id,
            chunk_count,
            (time.perf_counter() - t0) * 1000,
        )

    def _generate_audio_chunks(
        self,
        request: SynthesizeRequest,
        trace_id: str | None = None,
    ) -> tuple[list[np.ndarray], int]:
        t0 = _TRACE_START.get(trace_id, time.perf_counter())
        model = self.ensure_model()
        log_tts_timing(
            "[tts-timing] trace=%s event=model_ready t=%.1fms",
            trace_id,
            (time.perf_counter() - t0) * 1000,
        )
        instruct = self._build_instruction(
            emotion=request.emotion,
            exaggeration=request.exaggeration,
        )

        generate_kwargs = {
            "text": request.text,
            "language": request.language or DEFAULT_LANGUAGE,
            "speaker": request.speaker or DEFAULT_SPEAKER,
            "voice": request.voice or "ryan",
            "instruct": instruct,
        }

        chunks: list[np.ndarray] = []
        sample_rate: int | None = None

        with self._generate_lock:
            log_tts_timing(
                "[tts-timing] trace=%s event=inference_started text_len=%d voice=%s speaker=%s emotion=%s t=%.1fms",
                trace_id,
                len(request.text),
                request.voice,
                request.speaker,
                request.emotion,
                (time.perf_counter() - t0) * 1000,
            )
            t_before_generate = time.perf_counter()
            try:
                results = model.generate(**generate_kwargs)
            except TypeError:
                LOGGER.warning(
                    "model.generate does not accept custom voice kwargs; "
                    "falling back to text-only generation",
                )
                results = model.generate(text=request.text)

            log_tts_timing(
                "[tts-timing] trace=%s event=generate_call_returned type=%s t=%.1fms",
                trace_id,
                type(results).__name__,
                (time.perf_counter() - t0) * 1000,
            )

            yield_index = 0
            last_yield_ts = t_before_generate
            first_non_empty_logged = False

            for result in results:
                now = time.perf_counter()
                chunk = np.asarray(result.audio, dtype=np.float32)
                delta_ms = (now - last_yield_ts) * 1000
                since_call_ms = (now - t_before_generate) * 1000
                log_tts_timing(
                    "[tts-timing] trace=%s event=generate_yield idx=%d samples=%d sample_rate=%s since_call=%.1fms delta=%.1fms t=%.1fms",
                    trace_id,
                    yield_index,
                    int(chunk.size),
                    getattr(result, "sample_rate", "?"),
                    since_call_ms,
                    delta_ms,
                    (now - t0) * 1000,
                )
                last_yield_ts = now
                yield_index += 1

                if chunk.size == 0:
                    continue

                if not first_non_empty_logged:
                    log_tts_timing(
                        "[tts-timing] trace=%s event=first_chunk_generated samples=%d t=%.1fms",
                        trace_id,
                        int(chunk.size),
                        (now - t0) * 1000,
                    )
                    first_non_empty_logged = True

                chunks.append(chunk)
                sample_rate = int(result.sample_rate)

            log_tts_timing(
                "[tts-timing] trace=%s event=inference_finished total_yields=%d chunks=%d t=%.1fms",
                trace_id,
                yield_index,
                len(chunks),
                (time.perf_counter() - t0) * 1000,
            )

        if not chunks or sample_rate is None:
            raise RuntimeError("Model did not return any audio")

        return chunks, sample_rate

    def _audio_array_from_result(self, result) -> np.ndarray:
        audio = getattr(result, "audio_chunk", None)
        if audio is None:
            audio = getattr(result, "audio", None)
        if audio is None:
            return np.asarray([], dtype=np.float32)
        return np.asarray(audio, dtype=np.float32)

    def _build_instruction(self, emotion: str, exaggeration: float) -> str:
        normalized_emotion = emotion.strip().lower()
        base_instruction = EMOTION_INSTRUCTIONS.get(
            normalized_emotion,
            EMOTION_INSTRUCTIONS["neutral"],
        )

        if exaggeration >= 1.6:
            intensity = "Make the style clearly pronounced."
        elif exaggeration >= 1.2:
            intensity = "Lean into the style in a noticeable way."
        elif exaggeration <= 0.6:
            intensity = "Keep the style restrained and subtle."
        else:
            intensity = "Keep the style natural and controlled."

        return f"{base_instruction} {intensity}"


app = FastAPI(title="Sonny Qwen3-TTS Service", version="1.0.0")
service = Qwen3TTSService()


def _new_trace() -> str:
    trace_id = uuid.uuid4().hex[:8]
    _TRACE_START[trace_id] = time.perf_counter()
    return trace_id


def _release_trace(trace_id: str) -> None:
    _TRACE_START.pop(trace_id, None)


class SingleInstancePidLock:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._file: io.TextIOWrapper | None = None

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_file = self.path.open("a+", encoding="utf-8")

        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock_file.seek(0)
            existing_pid = lock_file.read().strip()

            if existing_pid:
                LOGGER.warning(
                    "qwen3-tts-server is already running with pid %s. Exiting.",
                    existing_pid,
                )
            else:
                LOGGER.warning("qwen3-tts-server is already running. Exiting.")

            lock_file.close()
            return False

        lock_file.seek(0)
        lock_file.truncate()
        lock_file.write(str(os.getpid()))
        lock_file.flush()
        os.fsync(lock_file.fileno())
        self._file = lock_file

        return True

    def release(self) -> None:
        if self._file is None:
            return

        try:
            self._file.seek(0)
            self._file.truncate()
            self._file.flush()
        finally:
            fcntl.flock(self._file.fileno(), fcntl.LOCK_UN)
            self._file.close()
            self._file = None


PROCESS_LOCK = SingleInstancePidLock(LOCK_PATH)


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "model": DEFAULT_MODEL_ID,
    }


@app.post("/warmup")
async def warmup() -> dict[str, str]:
    try:
        await asyncio.to_thread(service.ensure_model)
    except Exception as error:
        LOGGER.exception("Warmup failed")
        raise HTTPException(status_code=500, detail=str(error)) from error

    return {
        "status": "ok",
        "warmed": "true",
        "model": DEFAULT_MODEL_ID,
    }


@app.post("/synthesize")
async def synthesize(request: SynthesizeRequest) -> Response:
    trace_id = _new_trace()
    log_tts_timing(
        "[tts-timing] trace=%s event=request_received endpoint=/synthesize text_len=%d voice=%s",
        trace_id,
        len(request.text),
        request.voice,
    )

    try:
        wav_bytes = await asyncio.to_thread(service.synthesize, request, trace_id)
    except Exception as error:
        LOGGER.exception("Synthesis failed")
        _release_trace(trace_id)
        raise HTTPException(status_code=500, detail=str(error)) from error
    finally:
        _release_trace(trace_id)

    return Response(
        content=wav_bytes,
        media_type="audio/wav",
    )


@app.post("/synthesize/stream")
async def synthesize_stream(request: SynthesizeRequest) -> StreamingResponse:
    trace_id = _new_trace()
    log_tts_timing(
        "[tts-timing] trace=%s event=request_received endpoint=/synthesize/stream text_len=%d voice=%s",
        trace_id,
        len(request.text),
        request.voice,
    )

    try:
        stream = service.stream_synthesize(request, trace_id=trace_id)
    except Exception as error:
        LOGGER.exception("Streaming synthesis setup failed")
        _release_trace(trace_id)
        raise HTTPException(status_code=500, detail=str(error)) from error

    return StreamingResponse(
        iterate_stream(stream, trace_id),
        media_type="audio/wav",
    )


async def iterate_stream(stream, trace_id: str):
    iterator = iter(stream)

    try:
        while True:
            try:
                chunk = await asyncio.to_thread(_next_stream_chunk, iterator)
            except Exception as error:
                LOGGER.exception("Streaming synthesis failed")
                raise HTTPException(status_code=500, detail=str(error)) from error

            if chunk is _STREAM_END:
                return

            yield chunk
    finally:
        _release_trace(trace_id)


def _next_stream_chunk(iterator):
    try:
        return next(iterator)
    except StopIteration:
        return _STREAM_END


def build_streaming_wav_header(
    sample_rate: int,
    channels: int = 1,
    bits_per_sample: int = 16,
) -> bytes:
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    unknown_length = 0xFFFFFFFF
    header = bytearray(44)

    header[0:4] = b"RIFF"
    header[4:8] = unknown_length.to_bytes(4, "little", signed=False)
    header[8:12] = b"WAVE"
    header[12:16] = b"fmt "
    header[16:20] = (16).to_bytes(4, "little", signed=False)
    header[20:22] = (1).to_bytes(2, "little", signed=False)
    header[22:24] = channels.to_bytes(2, "little", signed=False)
    header[24:28] = sample_rate.to_bytes(4, "little", signed=False)
    header[28:32] = byte_rate.to_bytes(4, "little", signed=False)
    header[32:34] = block_align.to_bytes(2, "little", signed=False)
    header[34:36] = bits_per_sample.to_bytes(2, "little", signed=False)
    header[36:40] = b"data"
    header[40:44] = unknown_length.to_bytes(4, "little", signed=False)

    return bytes(header)


def main() -> None:
    logging.basicConfig(level=logging.INFO)

    if not PROCESS_LOCK.acquire():
        sys.exit(0)

    atexit.register(PROCESS_LOCK.release)

    try:
        uvicorn.run(
            app,
            host=DEFAULT_HOST,
            port=DEFAULT_PORT,
            reload=False,
        )
    finally:
        PROCESS_LOCK.release()


if __name__ == "__main__":
    main()
