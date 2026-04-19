#!/usr/bin/env python3

from __future__ import annotations

import asyncio
import atexit
import fcntl
import io
import logging
import os
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

    def synthesize(self, request: SynthesizeRequest) -> bytes:
        chunks, sample_rate = self._generate_audio_chunks(request)
        audio = np.concatenate(chunks)

        if audio.ndim > 1:
            audio = audio.reshape(-1)

        buffer = io.BytesIO()
        sf.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")

        return buffer.getvalue()

    def stream_synthesize(self, request: SynthesizeRequest):
        header_sent = False
        sample_rate: int | None = None

        chunks, sample_rate = self._generate_audio_chunks(request)

        for chunk in chunks:
            if not header_sent:
                yield build_streaming_wav_header(sample_rate=sample_rate)
                header_sent = True

            clipped = np.clip(chunk, -1.0, 1.0)
            pcm = (clipped * np.int16(32767)).astype(np.int16)
            yield pcm.tobytes()

        if not header_sent:
            raise RuntimeError("Model did not return any audio")

    def _generate_audio_chunks(
        self,
        request: SynthesizeRequest,
    ) -> tuple[list[np.ndarray], int]:
        model = self.ensure_model()
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
            try:
                results = model.generate(**generate_kwargs)
            except TypeError:
                LOGGER.warning(
                    "model.generate does not accept custom voice kwargs; "
                    "falling back to text-only generation",
                )
                results = model.generate(text=request.text)

            for result in results:
                chunk = np.asarray(result.audio, dtype=np.float32)

                if chunk.size == 0:
                    continue

                chunks.append(chunk)
                sample_rate = int(result.sample_rate)

        if not chunks or sample_rate is None:
            raise RuntimeError("Model did not return any audio")

        return chunks, sample_rate

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
    try:
        wav_bytes = await asyncio.to_thread(service.synthesize, request)
    except Exception as error:
        LOGGER.exception("Synthesis failed")
        raise HTTPException(status_code=500, detail=str(error)) from error

    return Response(
        content=wav_bytes,
        media_type="audio/wav",
    )


@app.post("/synthesize/stream")
async def synthesize_stream(request: SynthesizeRequest) -> StreamingResponse:
    try:
        stream = service.stream_synthesize(request)
    except Exception as error:
        LOGGER.exception("Streaming synthesis setup failed")
        raise HTTPException(status_code=500, detail=str(error)) from error

    return StreamingResponse(
        iterate_stream(stream),
        media_type="audio/wav",
    )


async def iterate_stream(stream):
    iterator = iter(stream)

    while True:
      try:
          chunk = await asyncio.to_thread(next, iterator)
      except StopIteration:
          return
      except Exception as error:
          LOGGER.exception("Streaming synthesis failed")
          raise HTTPException(status_code=500, detail=str(error)) from error

      yield chunk


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
