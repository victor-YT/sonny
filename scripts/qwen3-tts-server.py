#!/usr/bin/env python3

from __future__ import annotations

import asyncio
import io
import logging
import os
import sys
import wave
from dataclasses import dataclass
from typing import Iterator

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

LOGGER = logging.getLogger("qwen3-tts-server")

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8001
DEFAULT_MODEL_ID = os.getenv(
    "QWEN3_TTS_MODEL",
    "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
)
DEFAULT_LANGUAGE = os.getenv("QWEN3_TTS_LANGUAGE", "English")
DEFAULT_SPEAKER = os.getenv("QWEN3_TTS_SPEAKER", "Ryan")
DEFAULT_CHUNK_BYTES = 32_768
DEFAULT_BACKEND = os.getenv("SONNY_TTS_BACKEND", "auto").strip().lower()

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
    exaggeration: float = Field(default=1.0, ge=0.25, le=2.0)
    stream: bool = Field(default=False)


@dataclass
class GeneratedAudio:
    wav_bytes: bytes
    sample_rate: int


class Qwen3Backend:
    def __init__(self) -> None:
        self._model = None

    def synthesize(self, request: SynthesizeRequest) -> GeneratedAudio:
        audio, sample_rate = self._collect_audio(request)
        wav_bytes = encode_wav_bytes(audio, sample_rate)

        return GeneratedAudio(
            wav_bytes=wav_bytes,
            sample_rate=sample_rate,
        )

    def synthesize_stream(self, request: SynthesizeRequest) -> Iterator[bytes]:
        audio, sample_rate = self._collect_audio(request)
        wav_bytes = encode_wav_bytes(audio, sample_rate)
        return iter_audio_chunks(wav_bytes)

    def _collect_audio(self, request: SynthesizeRequest) -> tuple[np.ndarray, int]:
        model = self._ensure_model()
        chunks: list[np.ndarray] = []
        sample_rate: int | None = None

        for result in self._generate(model, request):
            chunk = np.asarray(result.audio, dtype=np.float32)

            if chunk.size == 0:
                continue

            chunks.append(chunk)
            sample_rate = int(result.sample_rate)

        if not chunks or sample_rate is None:
            raise RuntimeError("Qwen3-TTS did not return any audio")

        return np.concatenate(chunks), sample_rate

    def _generate(self, model, request: SynthesizeRequest):
        instruct = self._build_instruction(
            emotion=request.emotion,
            exaggeration=request.exaggeration,
        )

        generation_kwargs = {
            "text": request.text,
            "language": request.language or DEFAULT_LANGUAGE,
            "speaker": request.speaker or DEFAULT_SPEAKER,
            "instruct": instruct,
        }

        try:
            return model.generate(**generation_kwargs)
        except TypeError:
            LOGGER.warning(
                "Qwen3-TTS model.generate does not accept custom voice kwargs; "
                "falling back to text-only generation",
            )
            return model.generate(text=request.text)

    def _ensure_model(self):
        if self._model is not None:
            return self._model

        try:
            import torch
            from qwen_tts import Qwen3TTSModel
        except ImportError as error:
            raise RuntimeError(
                "Qwen3-TTS dependencies are missing. Install fastapi, uvicorn, "
                "numpy, torch, and qwen-tts before starting this service."
            ) from error

        if torch.cuda.is_available():
            device_map = "cuda:0"
            dtype = torch.bfloat16
            attn_implementation = "flash_attention_2"
        else:
            device_map = "cpu"
            dtype = torch.float32
            attn_implementation = "eager"

        LOGGER.info(
            "Loading Qwen3-TTS model %s on %s",
            DEFAULT_MODEL_ID,
            device_map,
        )

        self._model = Qwen3TTSModel.from_pretrained(
            DEFAULT_MODEL_ID,
            device_map=device_map,
            dtype=dtype,
            attn_implementation=attn_implementation,
        )

        return self._model

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


class ChatterboxBackend:
    def __init__(self) -> None:
        self._model = None

    def synthesize(self, request: SynthesizeRequest) -> GeneratedAudio:
        model = self._ensure_model()
        generate_kwargs: dict[str, float] = {}

        if request.exaggeration != 1.0:
            generate_kwargs["exaggeration"] = request.exaggeration

        audio = model.generate(
            request.text,
            **generate_kwargs,
        )
        sample_rate = int(getattr(model, "sr", 24_000))
        wav_bytes = encode_wav_bytes(self._to_numpy(audio), sample_rate)

        return GeneratedAudio(
            wav_bytes=wav_bytes,
            sample_rate=sample_rate,
        )

    def _ensure_model(self):
        if self._model is not None:
            return self._model

        try:
            import torch
            from chatterbox.tts import ChatterboxTTS
        except ImportError as error:
            raise RuntimeError(
                "Chatterbox dependencies are missing. Install fastapi, uvicorn, "
                "numpy, torch, and chatterbox-tts before starting this service."
            ) from error

        if torch.cuda.is_available():
            device = "cuda"
        elif torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"

        LOGGER.info(
            "Loading Chatterbox TTS model on %s",
            device,
        )

        self._model = ChatterboxTTS.from_pretrained(device=device)

        return self._model

    def _to_numpy(self, audio) -> np.ndarray:
        if hasattr(audio, "detach"):
            audio = audio.detach()

        if hasattr(audio, "cpu"):
            audio = audio.cpu()

        if hasattr(audio, "numpy"):
            audio = audio.numpy()

        array = np.asarray(audio, dtype=np.float32)

        if array.ndim > 1:
            array = array.reshape(-1)

        return array


class Qwen3TTSService:
    def __init__(self) -> None:
        self._backend = None
        self._backend_name = "uninitialized"

    @property
    def backend_name(self) -> str:
        self._ensure_backend()
        return self._backend_name

    def synthesize(self, request: SynthesizeRequest) -> GeneratedAudio:
        backend = self._ensure_backend()
        return backend.synthesize(request)

    def _ensure_backend(self):
        if self._backend is not None:
            return self._backend

        preferred_backend = resolve_backend_name()

        if preferred_backend == "chatterbox":
            self._backend = ChatterboxBackend()
            self._backend_name = "chatterbox"
            return self._backend

        self._backend = Qwen3Backend()
        self._backend_name = "qwen3"
        return self._backend


def resolve_backend_name() -> str:
    if DEFAULT_BACKEND in {"qwen3", "chatterbox"}:
        return DEFAULT_BACKEND

    if sys.platform == "win32":
        return "chatterbox"

    return "qwen3"


def encode_wav_bytes(audio: np.ndarray, sample_rate: int) -> bytes:
    normalized = np.clip(audio, -1.0, 1.0)
    pcm = (normalized * 32767).astype(np.int16)
    buffer = io.BytesIO()

    with wave.open(buffer, "wb") as wave_file:
        wave_file.setnchannels(1)
        wave_file.setsampwidth(2)
        wave_file.setframerate(sample_rate)
        wave_file.writeframes(pcm.tobytes())

    return buffer.getvalue()


def iter_audio_chunks(wav_bytes: bytes, chunk_size: int = DEFAULT_CHUNK_BYTES) -> Iterator[bytes]:
    for index in range(0, len(wav_bytes), chunk_size):
        yield wav_bytes[index:index + chunk_size]


app = FastAPI(title="Sonny Qwen3-TTS Service", version="1.0.0")
service = Qwen3TTSService()


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "backend": service.backend_name,
        "model": DEFAULT_MODEL_ID if service.backend_name == "qwen3" else "ChatterboxTTS",
    }


@app.post("/synthesize")
async def synthesize(request: SynthesizeRequest) -> Response:
    try:
        if request.stream:
            stream = await asyncio.to_thread(service.synthesize_stream, request)
            return StreamingResponse(
                stream,
                media_type="audio/wav",
            )

        generated = await asyncio.to_thread(service.synthesize, request)
    except Exception as error:  # pragma: no cover - service boundary logging
        LOGGER.exception("Synthesis failed")
        raise HTTPException(status_code=500, detail=str(error)) from error

    return Response(
        content=generated.wav_bytes,
        media_type="audio/wav",
    )


@app.post("/synthesize/stream")
async def synthesize_stream(request: SynthesizeRequest) -> StreamingResponse:
    try:
        stream = await asyncio.to_thread(service.synthesize_stream, request)
    except Exception as error:  # pragma: no cover - service boundary logging
        LOGGER.exception("Streaming synthesis failed")
        raise HTTPException(status_code=500, detail=str(error)) from error

    return StreamingResponse(
        stream,
        media_type="audio/wav",
    )


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(
        app,
        host=DEFAULT_HOST,
        port=DEFAULT_PORT,
        reload=False,
    )


if __name__ == "__main__":
    main()
