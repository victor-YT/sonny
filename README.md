# Sonny

Sonny is a local-first personal AI assistant built to live on your machine, remember what matters, and develop a consistent voice over time.

The project takes its name from Sonny in *I, Robot*: the one machine in the story that feels less like a tool and more like an individual. That is the design target here. Sonny should not behave like a stateless chatbot tab. It should feel like a durable assistant with memory, judgment, and a point of view.

## Philosophy

Most assistants are optimized for breadth, not continuity. They can answer almost anything, but they forget who they are talking to as soon as the window closes.

Sonny is built around a different assumption:

- Your assistant should be local-first by default.
- Your assistant should accumulate useful memory, not just logs.
- Your assistant should have a stable personality instead of a random tone per session.
- Your assistant should be able to speak, listen, monitor, and surface important changes proactively.
- Your assistant should expose risky capabilities through explicit permissions, not hidden magic.

The goal is not “yet another chat UI.” The goal is a personal AI runtime you can own, inspect, extend, and trust.

## 🚀 Quick Demo (No Microphone Required)

If you want to validate Sonny’s current voice stack without speaking into the mic:

```bash
pnpm voice:simulate
```

That runs the existing voice pipeline through a local sample path:

- STT
- LLM
- TTS
- playback

It works without live microphone input and prints transcript output, latency fields, and pipeline verdicts for a full sample turn.

## Feature Overview

### Available now

- Local-first runtime via Ollama
- Streaming voice pipeline with STT, LLM, TTS, and speaker playback
- Emotion-aware response processing for speech
- Minimal tray host
- Localhost control center on port `3001`
- Diagnostics and latency instrumentation
- No-microphone simulation path for pipeline validation
- Built-in tool/skill system with permission levels

### In progress / planned

- Wake word voice flow
- Proactive web monitoring and notifications
- Richer multi-layer memory system
- Community-extensible skill registry

## Sonny vs OpenClaw

This is a positioning comparison, not a benchmark shootout. The point is to explain what Sonny is trying to optimize for.

| Area | OpenClaw | Sonny |
| --- | --- | --- |
| Core model | General assistant runtime | Personal assistant runtime |
| Memory model | Conversation-centric | Durable user memory plus recent recall |
| Personality | Usually prompt-level | Explicit personality and voice shaping |
| Voice | Optional or external depending on setup | Built into the architecture |
| UI | Primarily chat-oriented | Tray host plus localhost control center |
| Proactive behavior | Limited by default | Web monitors, schedules, notifications |
| Extensibility | Agent/tool oriented | Built-in skills with runtime permission controls |
| Security posture | Varies by deployment | Allowlists, permission levels, sandboxed execution path |
| Data ownership | Depends on deployment | Local-first by design |

## Architecture

The main pieces are:

- `src/core/`: gateway, session state, config, proactive runtime, notifications
- `src/memory/`: long-term Markdown memory, recent SQLite memory, extraction/injection
- `src/voice/`: microphone, STT, TTS, speaker playback, response shaping, voice runtime orchestration
- `src/skills/`: built-in tool skills, permissions, monitor registry, web monitor
- `src/ui/`: tray host, Electron entrypoint, localhost control center

## Setup Guide

### Prerequisites

Sonny is easiest to run on macOS today because local playback uses `afplay` and the bootstrap script assumes Homebrew.

Install these first:

- Node.js `22+`
- `pnpm`
- Python `3`
- `Ollama`
- `sox`
- a local Ollama model such as `qwen3:8b`

Optional, but required for specific flows:

- a Picovoice Porcupine access key only if you are working on wake-word flows
- Electron-compatible desktop environment for the tray host
- enough local CPU/GPU/RAM for `faster-whisper` and Qwen3-TTS

On macOS with Homebrew:

```bash
brew install node pnpm ollama sox
```

### Project Setup

Fast path:

```bash
./scripts/install.sh
```

That script verifies macOS/Homebrew, installs missing packages, runs `pnpm install`, creates the expected `.local/` runtime layout, copies `.env.example` to `.env` if needed, and pulls the default Ollama model.

Manual setup:

```bash
pnpm install
cp .env.example .env
mkdir -p .local/memory
touch .local/memory/facts.md .local/memory/preferences.md .local/memory/goals.md .local/memory/patterns.md
```

Make sure `.local/monitors.json` exists:

```json
{
  "monitors": []
}
```

Start Ollama and pull the model Sonny should use:

```bash
ollama serve
ollama pull qwen3:8b
```

### Environment Configuration

Sonny reads startup values from `.env`, tracked default settings from `config/config.json`, and local runtime state from `.local/`.

The default `.env.example` contains:

```env
OLLAMA_MODEL=qwen3:8b
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_KEEP_ALIVE=-1
PORCUPINE_ACCESS_KEY=replace-me
FASTER_WHISPER_URL=http://127.0.0.1:8000
CHATTERBOX_URL=http://127.0.0.1:8001
VAD_URL=http://127.0.0.1:8003
SONNY_VOICE_MODE=0
```

Important values:

- `OLLAMA_MODEL`: model name for chat generation
- `OLLAMA_BASE_URL`: Ollama HTTP endpoint
- `PORCUPINE_ACCESS_KEY`: required only for wake-word experiments
- `FASTER_WHISPER_URL`: STT service URL
- `CHATTERBOX_URL`: TTS service URL
- `VAD_URL`: end-of-turn VAD service URL
- `SONNY_VOICE_MODE`: `0`/`false` for non-voice startup, `1`/`true` for voice runtime startup

`config/config.json` controls memory retention, skill permissions, and default voice service URLs. Keep `.env` for machine-specific startup values and `.local/` for machine-local runtime data.

### Python Services Setup

Sonny expects three local HTTP services for voice mode and starts them automatically when they are not already healthy:

- faster-whisper on `http://127.0.0.1:8000`
- Qwen3-TTS on `http://127.0.0.1:8001`
- VAD on `http://127.0.0.1:8003`

The runtime still uses the compatibility name `CHATTERBOX_URL` for the TTS endpoint, but the bundled server script is `scripts/qwen3-tts-server.py`.

#### STT: faster-whisper

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install fastapi uvicorn faster-whisper python-multipart
python3 scripts/whisper-server.py
```

Useful overrides:

```bash
FASTER_WHISPER_MODEL=small
FASTER_WHISPER_DEVICE=auto
FASTER_WHISPER_COMPUTE_TYPE=int8
python3 scripts/whisper-server.py
```

The STT service exposes:

- `POST /transcribe` for buffered transcription
- `POST /transcribe?stream=true` for streaming NDJSON transcript updates

#### TTS: Qwen3-TTS

```bash
source .venv/bin/activate
pip install fastapi uvicorn numpy torch qwen-tts
python3 scripts/qwen3-tts-server.py
```

Health check:

```bash
curl http://127.0.0.1:8001/health
```

The TTS service accepts `POST /synthesize` and `POST /synthesize/stream`. Sonny’s app-level `voice` option is sent to that service as its `speaker` field.

#### Starting both services together

If your Python environment is already prepared, you can use the helper script:

```bash
pnpm run start:services
```

On Unix it prefers `.venv/bin/python` when present.

### Running Sonny

Build first:

```bash
pnpm build
```

The main interface is the localhost control center:

```bash
pnpm start
```

That starts:

- the Sonny runtime
- the localhost control center
- the minimal tray host

The primary UI is:

```text
http://127.0.0.1:3001
```

Sonny prints the control center URL on startup. The terminal is no longer the primary interaction surface.
Set `SONNY_CONSOLE_PORT` if you need a different localhost port.

#### Voice mode setup

Before starting voice mode:

1. Set `SONNY_VOICE_MODE=1` in `.env`.
2. Start faster-whisper and Qwen3-TTS.
3. Verify `FASTER_WHISPER_URL` and `CHATTERBOX_URL` match the services you started.
4. Open the localhost control center.

Then start Sonny normally:

```bash
pnpm start
```

In voice mode Sonny:

1. runs the voice runtime locally
2. accepts manual or simulated voice turns through the control center
3. transcribes with faster-whisper
4. generates a response with the gateway
5. reshapes the response for speech
6. synthesizes streamed audio with Qwen3-TTS
7. plays the result locally

Optional voice-related environment overrides supported by `src/voice/voice-gateway.ts` include:

- `SONNY_WAKE_WORDS`
- `SONNY_STT_PROVIDER`
- `SONNY_FOREGROUND_LLM_PROVIDER`
- `SONNY_BACKGROUND_LLM_PROVIDER`
- `SONNY_TTS_PROVIDER`
- `SONNY_PLAYBACK_PROVIDER`
- `SONNY_FOREGROUND_MODEL`
- `SONNY_BACKGROUND_MODEL`
- `SONNY_STT_LANGUAGE`
- `SONNY_TTS_VOICE`
- `SONNY_WAKE_WORD_SENSITIVITY`
- `SONNY_MIC_SAMPLE_RATE_HERTZ`
- `SONNY_MIC_SILENCE_SECONDS`
- `SONNY_MIC_MAX_CAPTURE_MS`
- `SONNY_MIC_RECORD_PROGRAM`
- `SONNY_MIC_GAIN_DB`
- `SONNY_VAD_BASE_URL`
- `VAD_URL`

Provider resolution can be inspected with:

```bash
pnpm run voice:providers
```

#### Desktop host behavior

`pnpm start` launches Sonny’s Electron shell as a minimal tray host. It does not open a separate popup chat window.

The tray remains useful for presence and quick access:

- tray status reflects runtime state
- clicking the tray opens the localhost control center in the default browser

### Keyboard Shortcuts

- `Ctrl+C` stops Sonny from the terminal that launched it

### Integration Tests

The repo now includes integration coverage for voice service connectivity and the gateway send-message flow:

```bash
pnpm test
```

That compiles `src/` plus `tests/` with `tsconfig.test.json` and runs:

- `tests/voice-pipeline.test.ts`
- `tests/gateway.test.ts`

### Troubleshooting

- Startup validation fails: copy `.env.example` to `.env` and fill in the missing values called out in the error message.
- Ollama requests fail: make sure `ollama serve` is running and `OLLAMA_BASE_URL` matches it.
- Voice mode starts but STT/TTS/VAD calls fail: confirm the local services are running on `8000`, `8001`, and `8003`, or update `FASTER_WHISPER_URL`, `CHATTERBOX_URL`, and `VAD_URL`.
- TTS server exits immediately: install `fastapi`, `uvicorn`, `numpy`, `torch`, and `qwen-tts` in the Python environment used to launch `scripts/qwen3-tts-server.py`.
- Microphone capture fails with a missing module error: Sonny loads `node-record-lpcm16` at runtime. Install it with `pnpm add node-record-lpcm16` if your environment does not already provide it.
- Wake-word experiments never trigger: verify `PORCUPINE_ACCESS_KEY`, check your microphone permissions, and lower `SONNY_WAKE_WORD_SENSITIVITY` only if you are getting false positives rather than misses.
- No local playback: confirm `sox` is installed and that macOS can run `afplay`.

## Memory System

Sonny uses a three-part memory model.

### 1. Long-term memory

Long-term memory is stored as Markdown files in `.local/memory/`:

- `facts.md`
- `preferences.md`
- `goals.md`
- `patterns.md`

These are intended to capture durable information about the user, not every transcript line.

### 2. Recent memory

Recent interactions are stored in `.local/memory/recent.json`.

This gives Sonny short-horizon recall for the last several days without polluting long-term memory with temporary details.

### 3. Memory extraction and injection

After a session, Sonny can summarize the conversation into structured long-term memory categories:

- facts
- preferences
- goals
- patterns

When the next user message arrives, Sonny ranks relevant long-term snippets and recent entries, then injects only the most relevant context into the system prompt.

That gives you:

- better continuity than plain chat history
- lower prompt noise than dumping everything every time
- a clearer separation between durable memory and temporary context

## Skills

Sonny has a built-in skill system that attaches tool definitions to the gateway and gates risky operations with permission levels.

### Built-in skills

Current built-in skills include:

- `sandbox.execute`
  Sandboxed code or command execution path

- `web.search`
  Read-only DuckDuckGo Instant Answer search

- `file.tool`
  Allowlisted file reads and writes

- `shell.tool`
  Allowlisted shell commands with risk-based confirmation

There are also runtime subsystems around monitoring:

- `MonitorRegistry` persists watch targets in `.local/monitors.json`
- `WebMonitor` polls enabled URLs and emits proactive notifications when content changes

### Permission model

Skill permissions are defined in `config/config.json` with:

- `enabled`
- `defaultLevel`
- `maxLevel`

Permission levels are:

- `low`
- `medium`
- `high`

Medium and high risk operations require explicit confirmation.

### Installing community skills

Sonny does not yet ship a packaged plugin marketplace. Today, “community skills” means source-level installation.

The current install path is:

1. Add the skill implementation under `src/skills/`.
2. Make it expose a `ToolDefinition` and `execute(args)` method compatible with the built-in skill interface.
3. Register it in `SkillRegistry`.
4. Add permission settings for the tool in `config/config.json`.
5. Build again with `pnpm build`.

A minimal workflow looks like this:

```text
src/skills/my-skill.ts
  -> implement BuiltInSkill
src/skills/skill-registry.ts
  -> register new MySkill()
config/config.json
  -> add skills.permissions.my.skill
```

That is intentionally simple for now. A true community skill installer can be layered on later without changing the core tool contract.

## Contributing

Contributions are welcome, but keep the project’s design bar in mind.

### Ground rules

- TypeScript strict mode
- ESM only
- no `any`
- keep provider interfaces swappable
- English only in code comments and docs
- prefer local-first, inspectable behavior over opaque convenience

### Recommended workflow

1. Fork the repo.
2. Create a focused branch.
3. Make a small, coherent change.
4. Run `pnpm build`.
5. Open a PR with a clear explanation of behavior changes and risks.

### Good contribution areas

- new skills
- memory quality improvements
- safer permission handling
- UI polish for the tray host and control center
- voice stability and streaming improvements
- documentation and onboarding

### Before adding a new subsystem

Ask:

- Does this preserve local-first behavior?
- Does it expose risk clearly?
- Can the provider be swapped later?
- Does it improve continuity, usefulness, or trust?

If the answer is mostly “no,” it probably belongs outside Sonny.

## License

Sonny is currently licensed as `ISC` in `package.json`.
