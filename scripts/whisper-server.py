from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Any, AsyncIterator

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from faster_whisper import WhisperModel

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
DEFAULT_MODEL_NAME = "small"
DEFAULT_COMPUTE_TYPE = "int8"
DEFAULT_DEVICE = "auto"
DEFAULT_STREAM_CHUNK_BYTES = 32_000


class WhisperService:
    def __init__(self) -> None:
        self._model: WhisperModel | None = None
        self.model_name = os.getenv("FASTER_WHISPER_MODEL", DEFAULT_MODEL_NAME)
        self.device = os.getenv("FASTER_WHISPER_DEVICE", DEFAULT_DEVICE)
        self.compute_type = os.getenv(
            "FASTER_WHISPER_COMPUTE_TYPE",
            DEFAULT_COMPUTE_TYPE,
        )

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
                vad_filter=True,
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


@app.post("/transcribe")
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

    async for chunk in request.stream():
        if not chunk:
            continue

        buffer.extend(chunk)

        if len(buffer) - last_processed_size < DEFAULT_STREAM_CHUNK_BYTES:
            continue

        last_processed_size = len(buffer)
        payload = await _transcribe_snapshot(
            bytes(buffer),
            suffix=suffix,
            language=language,
            prompt=prompt,
        )

        if payload["text"] and payload["text"] != emitted_text:
            emitted_text = payload["text"]
            payload["final"] = False
            yield _encode_ndjson(payload)

    if len(buffer) == 0:
        raise HTTPException(status_code=400, detail="Audio payload is empty")

    final_payload = await _transcribe_snapshot(
        bytes(buffer),
        suffix=suffix,
        language=language,
        prompt=prompt,
    )
    final_payload["final"] = True

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


def _read_text_value(value: str | None) -> str | None:
    if value is None:
        return None

    normalized = value.strip()

    return normalized if normalized else None


def _encode_ndjson(payload: dict[str, Any]) -> bytes:
    return f"{json.dumps(payload, ensure_ascii=True)}\n".encode("utf-8")


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=os.getenv("FASTER_WHISPER_HOST", DEFAULT_HOST),
        port=int(os.getenv("FASTER_WHISPER_PORT", str(DEFAULT_PORT))),
        reload=False,
    )
