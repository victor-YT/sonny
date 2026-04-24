# Sonny

Local-first AI voice assistant runtime with inspectable provider-based speech and LLM pipelines.

## Stack
- TypeScript / Node.js / pnpm
- Electron tray host + localhost React control center
- OLMX foreground LLM, Ollama background/fallback LLM
- sherpa-onnx realtime STT, faster-whisper fallback
- Qwen3-TTS streaming HTTP service
- Porcupine/openWakeWord experiments
- Markdown + SQLite (memory)
- Playwright (browser automation)

## Structure
- `src/core/` — gateway, provider routing, config, runtime state
- `src/core/providers/` — LLM providers
- `src/voice/` — microphone, STT, TTS, playback, orchestration, diagnostics
- `src/voice/providers/` — swappable voice providers
- `src/memory/` — three-tier memory system
- `src/skills/` — built-in skills, sandbox, permissions
- `src/ui/` — Electron tray host for the control center
- `console-web/` — React control center

## Rules
- TypeScript strict mode, no `any`
- ESM modules only
- Define provider interfaces before implementations
- All voice/LLM components must be swappable providers
- English only, including comments
- kebab-case files, PascalCase classes, UPPER_SNAKE_CASE constants

## Commits
`feat:` `fix:` `refactor:` `docs:` `chore:`

## Session Management
Commit progress every 30-60 minutes or after each phase completes.
If uncertain about a large refactor, pause and summarize before proceeding.
