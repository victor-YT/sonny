from __future__ import annotations

import asyncio
import json
import os
import tempfile
import wave
from pathlib import Path
from time import perf_counter
from typing import Any, AsyncIterator

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from faster_whisper import WhisperModel
from starlette.requests import ClientDisconnect

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
DEFAULT_MODEL_NAME = "small"
DEFAULT_COMPUTE_TYPE = "int8"
DEFAULT_DEVICE = "auto"
DEFAULT_STREAM_CHUNK_BYTES = 64_000
DEFAULT_STREAM_SAMPLE_RATE = 16_000
DEFAULT_STREAM_CHANNELS = 1
DEFAULT_VAD_FILTER = False


def _read_bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)

    if value is None:
        return default

    normalized = value.strip().lower()

    if normalized in {"1", "true", "yes", "on"}:
        return True

    if normalized in {"0", "false", "no", "off"}:
        return False

    return default


class WhisperService:
    def __init__(self) -> None:
        self._model: WhisperModel | None = None
        self.model_name = os.getenv("FASTER_WHISPER_MODEL", DEFAULT_MODEL_NAME)
        self.device = os.getenv("FASTER_WHISPER_DEVICE", DEFAULT_DEVICE)
        self.compute_type = os.getenv(
            "FASTER_WHISPER_COMPUTE_TYPE",
            DEFAULT_COMPUTE_TYPE,
        )
        self.vad_filter = _read_bool_env("FASTER_WHISPER_VAD_FILTER", DEFAULT_VAD_FILTER)

    @property
    def model(self) -> WhisperModel:
        if self._model is None:
            self._model = WhisperModel(
                self.model_name,
                device=self.device,
                compute_type=self.compute_type,
            )

        return self._model

    def transcribe_bytes(
        self,
        audio_bytes: bytes,
        *,
        suffix: str,
        language: str | None,
        prompt: str | None,
    ) -> dict[str, Any]:
        if len(audio_bytes) == 0:
            raise ValueError("Audio payload is empty")

        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
            temp_file.write(audio_bytes)
            temp_path = Path(temp_file.name)

        try:
            segments, info = self.model.transcribe(
                str(temp_path),
                beam_size=1,
                best_of=1,
                vad_filter=self.vad_filter,
                language=language,
                initial_prompt=prompt,
            )
            materialized_segments = list(segments)
        finally:
            temp_path.unlink(missing_ok=True)

        text = " ".join(
            segment.text.strip()
            for segment in materialized_segments
            if segment.text.strip()
        ).strip()
        confidence = self._estimate_confidence(materialized_segments)

        if len(text) == 0:
            print(
                "[voice] whisper: empty transcript "
                + json.dumps(
                    {
                        "audio_bytes": len(audio_bytes),
                        "suffix": suffix,
                        "vad_filter": self.vad_filter,
                    },
                    ensure_ascii=True,
                ),
                flush=True,
            )

        return {
            "text": text,
            "language": getattr(info, "language", None),
            "confidence": confidence,
            "segments": [
                {
                    "text": segment.text,
                    "start": float(segment.start),
                    "end": float(segment.end),
                }
                for segment in materialized_segments
            ],
        }

    def _estimate_confidence(self, segments: list[Any]) -> float | None:
        if len(segments) == 0:
            return None

        scores = [
            max(0.0, min(1.0, 1.0 + float(segment.avg_logprob)))
            for segment in segments
            if hasattr(segment, "avg_logprob")
        ]

        if len(scores) == 0:
            return None

        return round(sum(scores) / len(scores), 4)


app = FastAPI(title="Sonny faster-whisper service")
service = WhisperService()


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "model": service.model_name,
        "vad_filter": str(service.vad_filter).lower(),
    }


@app.post("/transcribe", response_model=None)
async def transcribe(
    request: Request,
    stream: bool = Query(default=False),
    audio: UploadFile | None = File(default=None),
    language: str | None = Form(default=None),
    prompt: str | None = Form(default=None),
) -> JSONResponse | StreamingResponse:
    if stream:
        return StreamingResponse(
            _stream_transcription(
                request,
                language=_read_text_value(request.headers.get("x-language")),
                prompt=_read_text_value(request.headers.get("x-prompt")),
                suffix=_normalize_suffix(request.headers.get("x-audio-filename")),
            ),
            media_type="application/x-ndjson",
        )

    request_language = language or _read_text_value(request.headers.get("x-language"))
    request_prompt = prompt or _read_text_value(request.headers.get("x-prompt"))
    audio_bytes, suffix = await _read_audio_payload(request, audio)

    try:
        payload = service.transcribe_bytes(
            audio_bytes,
            suffix=suffix,
            language=request_language,
            prompt=request_prompt,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    return JSONResponse(payload)


async def _stream_transcription(
    request: Request,
    *,
    language: str | None,
    prompt: str | None,
    suffix: str,
) -> AsyncIterator[bytes]:
    buffer = bytearray()
    emitted_text = ""
    last_processed_size = 0
    request_started_at = perf_counter()
    total_bytes_received = 0
    encoding = _read_audio_encoding(request.headers.get("x-audio-encoding"))
    sample_rate_hertz = _read_integer_header(
        request.headers.get("x-sample-rate-hertz"),
        DEFAULT_STREAM_SAMPLE_RATE,
    )
    channels = _read_integer_header(
        request.headers.get("x-audio-channels"),
        DEFAULT_STREAM_CHANNELS,
    )
    pending_snapshot_task: asyncio.Task[tuple[dict[str, Any], float]] | None = None
    client_disconnected = False

    _log_stream_event(
        "request stream started",
        encoding=encoding,
        sample_rate_hertz=sample_rate_hertz,
        channels=channels,
    )

    async def flush_pending_snapshot() -> dict[str, Any] | None:
        nonlocal pending_snapshot_task

        if pending_snapshot_task is None:
            return None

        payload, duration_ms = await pending_snapshot_task
        pending_snapshot_task = None
        _log_stream_event(
            "snapshot finished",
            text_length=len(payload.get("text", "")),
            duration_ms=duration_ms,
            final=bool(payload.get("final", False)),
        )
        return payload

    def start_snapshot(snapshot_bytes: bytes, *, final: bool) -> None:
        nonlocal pending_snapshot_task
        snapshot_label = "final" if final else "partial"
        _log_stream_event(
            "snapshot started",
            snapshot_type=snapshot_label,
            audio_bytes=len(snapshot_bytes),
            total_bytes_received=total_bytes_received,
        )
        pending_snapshot_task = asyncio.create_task(
            _transcribe_snapshot_with_metrics(
                _prepare_audio_bytes(
                    snapshot_bytes,
                    encoding=encoding,
                    sample_rate_hertz=sample_rate_hertz,
                    channels=channels,
                ),
                suffix=suffix,
                language=language,
                prompt=prompt,
                final=final,
            ),
        )

    try:
        async for chunk in request.stream():
            if pending_snapshot_task is not None and pending_snapshot_task.done():
                payload = await flush_pending_snapshot()

                if (
                    payload is not None and
                    payload["text"] and
                    payload["text"] != emitted_text
                ):
                    emitted_text = payload["text"]
                    yield _encode_ndjson(payload)

            if not chunk:
                continue

            buffer.extend(chunk)
            total_bytes_received += len(chunk)
            _log_stream_event(
                "bytes received so far",
                total_bytes_received=total_bytes_received,
            )

            if pending_snapshot_task is not None:
                continue

            if len(buffer) - last_processed_size < DEFAULT_STREAM_CHUNK_BYTES:
                continue

            last_processed_size = len(buffer)
            start_snapshot(bytes(buffer), final=False)
    except ClientDisconnect:
        client_disconnected = True
        _log_stream_event(
            "client disconnect",
            total_bytes_received=total_bytes_received,
            buffered_bytes=len(buffer),
            elapsed_ms=round((perf_counter() - request_started_at) * 1000, 2),
        )

    pending_payload = await flush_pending_snapshot()

    if (
        pending_payload is not None and
        pending_payload["text"] and
        pending_payload["text"] != emitted_text
    ):
        emitted_text = pending_payload["text"]
        yield _encode_ndjson(pending_payload)

    if len(buffer) == 0:
        _log_stream_event(
            "request stream ended without audio",
            client_disconnected=client_disconnected,
        )
        return

    _log_stream_event(
        "final transcript attempt after disconnect" if client_disconnected else "final transcript attempt",
        total_bytes_received=total_bytes_received,
        buffered_bytes=len(buffer),
    )
    start_snapshot(bytes(buffer), final=True)
    final_payload = await flush_pending_snapshot()

    if final_payload is None:
        return

    if final_payload["text"] != emitted_text or emitted_text == "":
        yield _encode_ndjson(final_payload)
        return

    yield _encode_ndjson(final_payload)


async def _transcribe_snapshot(
    audio_bytes: bytes,
    *,
    suffix: str,
    language: str | None,
    prompt: str | None,
) -> dict[str, Any]:
    return await asyncio.to_thread(
        service.transcribe_bytes,
        audio_bytes,
        suffix=suffix,
        language=language,
        prompt=prompt,
    )


async def _transcribe_snapshot_with_metrics(
    audio_bytes: bytes,
    *,
    suffix: str,
    language: str | None,
    prompt: str | None,
    final: bool,
) -> tuple[dict[str, Any], float]:
    started_at = perf_counter()
    payload = await _transcribe_snapshot(
        audio_bytes,
        suffix=suffix,
        language=language,
        prompt=prompt,
    )
    payload["final"] = final
    return payload, round((perf_counter() - started_at) * 1000, 2)


async def _read_audio_payload(
    request: Request,
    audio: UploadFile | None,
) -> tuple[bytes, str]:
    if audio is not None:
        return await audio.read(), _normalize_suffix(audio.filename)

    return await request.body(), _normalize_suffix(request.headers.get("x-audio-filename"))


def _normalize_suffix(filename: str | None) -> str:
    if filename is None or len(filename.strip()) == 0:
        return ".wav"

    suffix = Path(filename).suffix.lower()

    return suffix if suffix else ".wav"


def _prepare_audio_bytes(
    audio_bytes: bytes,
    *,
    encoding: str,
    sample_rate_hertz: int,
    channels: int,
) -> bytes:
    if encoding == "wav":
        return audio_bytes

    if encoding != "pcm_s16le":
        raise HTTPException(status_code=400, detail=f"Unsupported audio encoding: {encoding}")

    buffer = tempfile.SpooledTemporaryFile()

    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate_hertz)
        wav_file.writeframes(audio_bytes)

    buffer.seek(0)

    return buffer.read()


def _read_text_value(value: str | None) -> str | None:
    if value is None:
        return None

    normalized = value.strip()

    return normalized if normalized else None


def _read_integer_header(value: str | None, default: int) -> int:
    if value is None:
        return default

    normalized = value.strip()

    if len(normalized) == 0:
        return default

    try:
        parsed = int(normalized)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=f"Expected integer header, received {normalized!r}") from error

    if parsed <= 0:
        raise HTTPException(status_code=400, detail="Audio header values must be positive integers")

    return parsed


def _read_audio_encoding(value: str | None) -> str:
    normalized = _read_text_value(value)

    return normalized if normalized is not None else "wav"


def _encode_ndjson(payload: dict[str, Any]) -> bytes:
    return f"{json.dumps(payload, ensure_ascii=True)}\n".encode("utf-8")


def _log_stream_event(message: str, **fields: Any) -> None:
    payload = {
        key: value
        for key, value in fields.items()
        if value is not None
    }
    print(
        f"[voice] whisper-stream: {message}"
        + (f" {json.dumps(payload, ensure_ascii=True, default=str)}" if payload else ""),
        flush=True,
    )


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=os.getenv("FASTER_WHISPER_HOST", DEFAULT_HOST),
        port=int(os.getenv("FASTER_WHISPER_PORT", str(DEFAULT_PORT))),
        reload=False,
    )
