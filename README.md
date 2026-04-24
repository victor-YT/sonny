# Sonny

Sonny is a local-first AI voice assistant runtime. It runs on your machine, exposes a localhost control center, and keeps the voice pipeline inspectable end to end.

The current launch/demo path is intentionally narrow:

```text
microphone -> silence detection -> sherpa-onnx STT -> routed LLM -> Qwen3-TTS streaming -> local playback
```

Sonny is not a hosted chatbot and does not require a cloud control plane. Model assets, runtime state, logs, and memory stay local unless you explicitly configure a remote provider.

## Current Architecture

- `src/app/voice-control-center.ts`: main runtime entrypoint for the Electron/control-center path
- `console-web/`: React control center served from localhost
- `src/core/`: gateway, provider routing, config, runtime state, memory/session plumbing
- `src/core/providers/`: swappable LLM providers
- `src/voice/`: microphone capture, STT/TTS/playback providers, voice orchestration, diagnostics
- `src/voice/providers/`: swappable voice providers
- `scripts/`: local service helpers for Qwen3-TTS, VAD, wake word experiments, and faster-whisper fallback
- `docs/voice-runtime.md`: maintained voice runtime map
- `docs/open-source-readiness.md`: cleanup audit and remaining safe refactor targets

The primary UI is the control center at `http://127.0.0.1:3001`. Electron is currently a small tray host that starts the runtime and opens the control center; there is no separate production chat window, capsule overlay, or legacy panel UI.

## Provider Defaults

| Layer | Default | Notes |
| --- | --- | --- |
| STT | `sherpa-onnx` | In-process realtime STT using `sherpa-onnx-node` |
| STT fallback | `faster-whisper` | HTTP service via `scripts/whisper-server.py` |
| Foreground LLM | `olmx-foreground` | OLMX OpenAI-compatible API, default model `Qwen2.5-1.5B-Instruct-4bit` |
| Background LLM | `ollama-background` | Ollama, default model `qwen3:8b` |
| TTS | `qwen3-tts` | Local Qwen3-TTS service with true `/synthesize/stream` audio streaming |
| Playback | `system-player` | Local system playback through the streaming audio queue |

The LLM router sends short conversational turns to the foreground OLMX model and longer/complex turns to the background Ollama model. Provider selection is visible in the pipeline diagnostics.

## Quick Start

Prerequisites for the current macOS demo path:

- Node.js `22+`
- `pnpm`
- Python `3.11+`
- `sox`
- OLMX with an OpenAI-compatible API enabled
- Ollama for background/fallback generation
- enough local CPU/GPU/RAM for sherpa-onnx STT and Qwen3-TTS

Install dependencies:

```bash
pnpm install
cp .env.example .env
```

Download the default sherpa-onnx streaming model:

```bash
pnpm run stt:sherpa:model
```

Start Ollama and pull the background model:

```bash
ollama serve
ollama pull qwen3:8b
```

Start OLMX separately and verify its API is reachable. Sonny expects:

```text
http://127.0.0.1:8000/v1/chat/completions
```

Install the Python dependencies for Qwen3-TTS/VAD in your local environment, then start services:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install fastapi uvicorn numpy soundfile mlx-audio webrtcvad
pnpm run start:services
```

Start Sonny:

```bash
pnpm start
```

Open:

```text
http://127.0.0.1:3001
```

## Environment

Copy `.env.example` to `.env` and adjust local paths/ports. Important values:

```env
SONNY_STT_PROVIDER=sherpa-onnx
SHERPA_ONNX_MODEL_DIR=models/sherpa-onnx-streaming-paraformer-bilingual-zh-en
SHERPA_ONNX_ENCODER=encoder.int8.onnx
SHERPA_ONNX_DECODER=decoder.int8.onnx
SHERPA_ONNX_TOKENS=tokens.txt
SHERPA_ONNX_LANGUAGE=zh
SHERPA_ONNX_MODEL_TYPE=paraformer
SHERPA_ONNX_PROVIDER=cpu
SHERPA_ONNX_NUM_THREADS=2

SONNY_FOREGROUND_LLM_PROVIDER=olmx-foreground
SONNY_FOREGROUND_MODEL=Qwen2.5-1.5B-Instruct-4bit
OLMX_BASE_URL=http://127.0.0.1:8000
OLMX_API_KEY=
OLMX_MODEL=Qwen2.5-1.5B-Instruct-4bit

SONNY_BACKGROUND_LLM_PROVIDER=ollama-background
SONNY_BACKGROUND_MODEL=qwen3:8b
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_KEEP_ALIVE=-1

SONNY_TTS_PROVIDER=qwen3-tts
CHATTERBOX_URL=http://127.0.0.1:8001
SONNY_TTS_BASE_URL=http://127.0.0.1:8001
SONNY_TTS_VOICE=Ryan
QWEN3_TTS_MODEL=mlx-community/Qwen3-TTS-1.7B-4bit
QWEN3_TTS_LANGUAGE=English
QWEN3_TTS_SPEAKER=Ryan
QWEN3_TTS_STREAMING_INTERVAL=0.32

SONNY_PLAYBACK_PROVIDER=system-player
VAD_URL=http://127.0.0.1:8003
SONNY_VOICE_MODE=0
```

Diagnostic flags are disabled by default so demos do not spam the terminal:

```env
SONNY_UI_DEBUG=0
SONNY_GATEWAY_DEBUG=0
SONNY_STT_DEBUG=0
SONNY_TTS_DEBUG=0
SONNY_TTS_DIAG=0
SONNY_TIMING_DEBUG=0
```

Set `SONNY_STT_PROVIDER=faster-whisper` and `FASTER_WHISPER_URL=http://127.0.0.1:8000` to use the fallback STT service.

## Voice Runtime

A normal voice turn is:

1. Capture PCM from the microphone.
2. Detect end-of-turn from VAD/silence.
3. Stream audio chunks to sherpa-onnx and emit partial transcripts.
4. Submit the final transcript to the gateway.
5. Route the LLM request to OLMX foreground or Ollama background.
6. Stream assistant text into sentence-sized speech segments.
7. Stream each segment through Qwen3-TTS.
8. Queue audio chunks directly to local playback.

The control center shows:

- service health and selected provider names
- live microphone RMS bar
- STT partial/final transcript details
- LLM route/model/provider diagnostics
- first token, first sentence, first audio, and first sound timing
- raw pipeline/debug snapshots for local troubleshooting

## Developer Commands

```bash
pnpm build
pnpm test
pnpm run voice:providers
pnpm run voice:simulate
pnpm run llm:olmx:test
pnpm run stt:sherpa:test -- --file models/sherpa-onnx-streaming-paraformer-bilingual-zh-en/test_wavs/0.wav
pnpm run stt:benchmark -- --file models/sherpa-onnx-streaming-paraformer-bilingual-zh-en/test_wavs/0.wav
pnpm run tts:benchmark
```

`pnpm run voice:providers` prints the resolved provider stack, OLMX reachability, model names, and service URLs. Run it before demos.

## Local Data And Models

Ignored local paths include:

- `.env`
- `.local/`
- `models/`
- `dist/`
- `dist-test/`
- `src/ui/console/public/`

Do not commit model files, generated runtime data, logs, local memory, or built control-center assets.

## Troubleshooting

- OLMX is unreachable: confirm the OLMX server is running and `OLMX_BASE_URL` points to the OpenAI-compatible base URL, not a UI-only URL.
- Background LLM fails: start Ollama and verify `OLLAMA_BASE_URL`.
- sherpa-onnx model missing: run `pnpm run stt:sherpa:model`.
- Qwen3-TTS fails: start `scripts/qwen3-tts-server.py`, then check `http://127.0.0.1:8001/health`.
- No playback: install `sox`; macOS file fallback also uses `afplay`.
- Mic permissions fail on macOS: grant terminal/Electron microphone permission and restart.

## Contributing

Keep changes small and provider-friendly:

- TypeScript strict mode
- ESM only
- no `any`
- provider interfaces before provider implementations
- local-first defaults
- no raw stderr/tool output in assistant speech
- diagnostics behind env flags unless they are user-facing control-center state

Before opening a PR:

```bash
pnpm build
pnpm test
pnpm run voice:providers
```

## License

Sonny is currently licensed as `ISC` in `package.json`.
