#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import signal
import sys
import time
from typing import Any


DEFAULT_SENSITIVITY = 0.5


def emit(event_type: str, **payload: Any) -> None:
    message = {
        "type": event_type,
        "timestamp": int(time.time() * 1000),
        **payload,
    }
    sys.stdout.write(f"{json.dumps(message, ensure_ascii=True)}\n")
    sys.stdout.flush()


def read_keywords() -> list[str]:
    raw_value = os.getenv("SONNY_WAKE_WORDS") or os.getenv("PORCUPINE_WAKE_WORD")

    if raw_value is None:
        return ["porcupine"]

    keywords = [
        keyword.strip()
        for keyword in raw_value.split(",")
        if keyword.strip()
    ]

    return keywords if keywords else ["porcupine"]


def read_optional_int(name: str) -> int | None:
    raw_value = os.getenv(name)

    if raw_value is None or raw_value.strip() == "":
        return None

    return int(raw_value)


def main() -> None:
    access_key = os.getenv("PORCUPINE_ACCESS_KEY") or os.getenv("SONNY_PORCUPINE_ACCESS_KEY")

    if access_key is None or access_key.strip() == "":
        raise RuntimeError("PORCUPINE_ACCESS_KEY is required")

    keywords = read_keywords()
    sensitivity = float(os.getenv("SONNY_WAKE_WORD_SENSITIVITY", str(DEFAULT_SENSITIVITY)))
    model_path = os.getenv("SONNY_PORCUPINE_MODEL_PATH")
    device_index = read_optional_int("SONNY_AUDIO_DEVICE_INDEX")
    should_stop = False

    def handle_stop(_: int, __) -> None:
        nonlocal should_stop
        should_stop = True

    signal.signal(signal.SIGTERM, handle_stop)
    signal.signal(signal.SIGINT, handle_stop)

    try:
        import pvporcupine
        from pvrecorder import PvRecorder
    except ImportError as error:
        raise RuntimeError(
            "Wake-word dependencies are missing. Install pvporcupine and pvrecorder."
        ) from error

    porcupine = None
    recorder = None

    try:
        create_kwargs: dict[str, Any] = {
            "access_key": access_key,
            "keywords": keywords,
            "sensitivities": [sensitivity for _ in keywords],
        }

        if model_path:
            create_kwargs["model_path"] = model_path

        porcupine = pvporcupine.create(**create_kwargs)
        recorder = PvRecorder(device_index=device_index, frame_length=porcupine.frame_length)
        recorder.start()
        emit("ready", keywords=keywords)

        while not should_stop:
            pcm = recorder.read()
            keyword_index = porcupine.process(pcm)

            if keyword_index >= 0:
                emit("detected", keyword=keywords[keyword_index])
    except Exception:
        raise
    finally:
        if recorder is not None:
            recorder.delete()

        if porcupine is not None:
            porcupine.delete()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # pragma: no cover - process boundary
        emit("error", error=str(error))
        raise
