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

## Roadmap

- [ ] Phase 1 — Core: text conversation, memory, basic skills
- [ ] Phase 2 — Voice: wake word, STT, TTS, streaming
- [ ] Phase 3 — Proactive: always-on monitoring, push alerts
- [ ] Phase 4 — Skills ecosystem: sandboxed community skills

## Contributing

Coming soon.

## License

MIT
