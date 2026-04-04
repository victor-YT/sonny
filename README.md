# Sonny

> The first open-source AI that actually knows you.

Sonny is a local-first personal AI assistant that runs on your machine, remembers who you are, and talks to you — not at you.

Unlike other AI assistants that reset every conversation, Sonny builds a persistent model of you over time: your habits, preferences, goals, and context. It has a voice, a name you choose, and a personality that stays consistent.

**Named after Sonny from I, Robot** — the only AI in that story with genuine self-awareness, emotion, and moral reasoning.

## What makes Sonny different

| | OpenClaw | Sonny |
|---|---|---|
| Memory | Chat logs | Builds a model of you |
| Personality | None | Consistent voice and character |
| Interaction | Message apps | Voice wake word + menubar |
| Proactive | Reactive only | Monitors and reaches out |
| Security | Minimal | Sandboxed skills + permission tiers |

## Status

🚧 **Active development** — Star to follow along.

## Tech Stack

- **Runtime**: Node.js / TypeScript
- **UI**: Electron menubar
- **LLM**: Ollama (local) or OpenAI/Anthropic (bring your own key)
- **Wake word**: Porcupine
- **STT**: WhisperKit / faster-whisper
- **TTS**: Chatterbox Turbo
- **Memory**: Markdown + SQLite

## Quickstart

The current setup flow targets macOS because Sonny uses `afplay` for local audio playback and Homebrew for dependency bootstrapping.

1. Run the installer:

   ```bash
   ./scripts/install.sh
   ```

2. Edit `.env`:
   - Set `PORCUPINE_ACCESS_KEY` if you want wake-word voice mode.
   - Keep `SONNY_VOICE_MODE=0` for text-only startup.
   - Set `SONNY_VOICE_MODE=1` only after `FASTER_WHISPER_URL` and `CHATTERBOX_URL` point at running services.

3. Build and start Sonny:

   ```bash
   pnpm build
   pnpm start
   ```

### What the installer does

- Checks for `node`, `pnpm`, `ollama`, and `sox`
- Installs missing system dependencies with Homebrew
- Runs `pnpm install`
- Pulls the default Ollama model: `qwen3:8b`
- Creates the `data/` directory structure Sonny expects
- Copies `.env.example` to `.env` if `.env` does not already exist

### Voice mode

- `SONNY_VOICE_MODE=1` enables the full loop: wake word -> microphone -> STT -> LLM -> TTS -> speaker
- Voice mode requires a valid `PORCUPINE_ACCESS_KEY`
- `FASTER_WHISPER_URL` must point to a running faster-whisper HTTP service
- `CHATTERBOX_URL` must point to a running Chatterbox HTTP service
- Startup validation fails fast with a clear error if required env vars are missing or invalid

## Roadmap

- [ ] Phase 1 — Core: text conversation, memory, basic skills
- [ ] Phase 2 — Voice: wake word, STT, TTS, streaming
- [ ] Phase 3 — Proactive: always-on monitoring, push alerts
- [ ] Phase 4 — Skills ecosystem: sandboxed community skills

## Contributing

Coming soon.

## License

MIT
