#!/usr/bin/env python3

from __future__ import annotations

import asyncio
import io
import logging
import os

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
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


class Qwen3TTSService:
    def __init__(self) -> None:
        self._model = None

    def ensure_model(self):
        if self._model is not None:
            return self._model

        from mlx_audio.tts.utils import load

        LOGGER.info("Loading mlx-audio model %s", DEFAULT_MODEL_ID)
        self._model = load(DEFAULT_MODEL_ID)
        LOGGER.info("Model loaded successfully")

        return self._model

    def synthesize(self, request: SynthesizeRequest) -> bytes:
        model = self.ensure_model()
        instruct = self._build_instruction(
            emotion=request.emotion,
            exaggeration=request.exaggeration,
        )

        generate_kwargs = {
            "text": request.text,
            "language": request.language or DEFAULT_LANGUAGE,
            "speaker": request.speaker or DEFAULT_SPEAKER,
            "instruct": instruct,
        }

        try:
            results = model.generate(**generate_kwargs)
        except TypeError:
            LOGGER.warning(
                "model.generate does not accept custom voice kwargs; "
                "falling back to text-only generation",
            )
            results = model.generate(text=request.text)

        chunks: list[np.ndarray] = []
        sample_rate: int | None = None

        for result in results:
            chunk = np.asarray(result.audio, dtype=np.float32)

            if chunk.size == 0:
                continue

            chunks.append(chunk)
            sample_rate = int(result.sample_rate)

        if not chunks or sample_rate is None:
            raise RuntimeError("Model did not return any audio")

        audio = np.concatenate(chunks)

        if audio.ndim > 1:
            audio = audio.reshape(-1)

        buffer = io.BytesIO()
        sf.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")

        return buffer.getvalue()

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


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
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
