#!/usr/bin/env python3

from __future__ import annotations

import logging
import os

import uvicorn
import webrtcvad
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

LOGGER = logging.getLogger("vad-server")

DEFAULT_HOST = os.getenv("VAD_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.getenv("VAD_PORT", "8003"))
DEFAULT_AGGRESSIVENESS = int(os.getenv("VAD_AGGRESSIVENESS", "2"))
SAMPLE_RATE = 16_000
FRAME_DURATION_MS = 30
FRAME_BYTES = 2 * SAMPLE_RATE * FRAME_DURATION_MS // 1000  # 960 bytes per 30ms frame

vad = webrtcvad.Vad(DEFAULT_AGGRESSIVENESS)
app = FastAPI(title="Sonny VAD Service", version="1.0.0")


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "aggressiveness": str(DEFAULT_AGGRESSIVENESS),
    }


@app.post("/detect")
async def detect(request: Request) -> JSONResponse:
    body = await request.body()

    if len(body) < FRAME_BYTES:
        return JSONResponse({"speech": False, "frames": 0, "speech_frames": 0})

    speech_frames = 0
    total_frames = 0

    for offset in range(0, len(body) - FRAME_BYTES + 1, FRAME_BYTES):
        frame = body[offset : offset + FRAME_BYTES]
        total_frames += 1

        try:
            if vad.is_speech(frame, SAMPLE_RATE):
                speech_frames += 1
        except Exception:
            continue

    has_speech = speech_frames > 0 and speech_frames >= total_frames // 3

    return JSONResponse({
        "speech": has_speech,
        "frames": total_frames,
        "speech_frames": speech_frames,
    })


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
