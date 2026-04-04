# Sonny

Local-first personal AI assistant with persistent memory, voice, and personality.

## Stack
- TypeScript / Node.js / pnpm
- Electron + menubar (UI)
- Ollama (local LLM), OpenAI/Anthropic (optional)
- Porcupine (wake word, Node SDK)
- faster-whisper (STT, HTTP service)
- Chatterbox Turbo (TTS, HTTP service)
- Markdown + SQLite (memory)
- Playwright (browser automation)

## Structure
- `src/core/` — gateway, session, tool routing
- `src/voice/` — wake word, STT, TTS providers
- `src/memory/` — three-tier memory system
- `src/skills/` — built-in skills, sandbox, permissions
- `src/ui/` — electron menubar + capsule overlay

## Rules
- TypeScript strict mode, no `any`
- ESM modules only
- Define provider interfaces before implementations
- All voice/LLM components must be swappable providers
- English only, including comments
- kebab-case files, PascalCase classes, UPPER_SNAKE_CASE constants

## Commits
`feat:` `fix:` `refactor:` `docs:` `chore:`
