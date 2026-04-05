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

## Feature Overview

- Local-first chat via Ollama
- Persistent multi-layer memory using Markdown and SQLite
- Voice loop with wake word, STT, TTS, and speaker playback
- Emotion-aware response processing for speech
- Electron menubar UI and capsule overlay
- Localhost control panel on port `3000`
- Built-in tool/skill system with permission levels
- Proactive web monitoring and notifications
- Community-extensible skill registry

## Sonny vs OpenClaw

This is a positioning comparison, not a benchmark shootout. The point is to explain what Sonny is trying to optimize for.

| Area | OpenClaw | Sonny |
| --- | --- | --- |
| Core model | General assistant runtime | Personal assistant runtime |
| Memory model | Conversation-centric | Durable user memory plus recent recall |
| Personality | Usually prompt-level | Explicit personality and voice shaping |
| Voice | Optional or external depending on setup | Built into the architecture |
| UI | Primarily chat-oriented | CLI, menubar UI, capsule overlay, localhost console |
| Proactive behavior | Limited by default | Web monitors, schedules, notifications |
| Extensibility | Agent/tool oriented | Built-in skills with runtime permission controls |
| Security posture | Varies by deployment | Allowlists, permission levels, sandboxed execution path |
| Data ownership | Depends on deployment | Local-first by design |

## Architecture

The main pieces are:

- `src/core/`: gateway, session state, config, proactive runtime, notifications
- `src/memory/`: long-term Markdown memory, recent SQLite memory, extraction/injection
- `src/voice/`: wake word, microphone, STT, TTS, speaker playback, response shaping
- `src/skills/`: built-in tool skills, permissions, monitor registry, web monitor
- `src/ui/`: menubar app, tray, capsule overlay, localhost console

## Requirements

Sonny currently targets macOS for the easiest path to a fully working local install because playback uses `afplay` and the installer uses Homebrew.

Required:

- Node.js `22+`
- `pnpm`
- `Ollama`
- `sox`
- Python-hosted speech services:
  - faster-whisper HTTP service
  - Chatterbox HTTP service

Also used by specific features:

- Porcupine access key for wake-word voice mode
- Homebrew for `scripts/install.sh`
- Electron runtime dependencies for the menubar UI

## Installation

### One-liner

From the repo root:

```bash
./scripts/install.sh
```

What the installer does:

- verifies macOS and Homebrew
- installs missing `node`, `pnpm`, `ollama`, and `sox`
- runs `pnpm install`
- creates the expected `data/` layout
- copies `.env.example` to `.env` if needed
- pulls the default Ollama model `qwen3:8b`

### Manual setup

If you want to install everything yourself:

1. Install system dependencies.

   ```bash
   brew install node pnpm ollama sox
   ```

2. Install Node dependencies.

   ```bash
   pnpm install
   ```

3. Create the local data layout.

   ```bash
   mkdir -p data/memory
   touch data/memory/facts.md data/memory/preferences.md data/memory/goals.md data/memory/patterns.md
   ```

4. Create `data/monitors.json`.

   ```json
   {
     "monitors": []
   }
   ```

5. Copy the environment template.

   ```bash
   cp .env.example .env
   ```

6. Start Ollama and pull a model.

   ```bash
   ollama serve
   ollama pull qwen3:8b
   ```

7. If you want voice mode, start your Python speech services:
   - faster-whisper at `http://127.0.0.1:8000`
   - Chatterbox at `http://127.0.0.1:8001`

## Configuration

Sonny reads startup settings from `.env` and richer runtime settings from `data/config.json`.

### `.env.example` walkthrough

The shipped template contains:

```env
OLLAMA_MODEL=qwen3:8b
OLLAMA_BASE_URL=http://127.0.0.1:11434
PORCUPINE_ACCESS_KEY=replace-me
FASTER_WHISPER_URL=http://127.0.0.1:8000
CHATTERBOX_URL=http://127.0.0.1:8001
SONNY_VOICE_MODE=0
```

What each variable does:

- `OLLAMA_MODEL`
  Selects the Ollama model Sonny uses for chat generation.

- `OLLAMA_BASE_URL`
  Points Sonny at the Ollama HTTP API.

- `PORCUPINE_ACCESS_KEY`
  Required only for wake-word voice mode.

- `FASTER_WHISPER_URL`
  The speech-to-text HTTP endpoint. Required when `SONNY_VOICE_MODE=1`.

- `CHATTERBOX_URL`
  The text-to-speech HTTP endpoint. Required when `SONNY_VOICE_MODE=1`.

- `SONNY_VOICE_MODE`
  `0` or `false` starts the text CLI.
  `1` or `true` enables the full voice pipeline.

### Runtime config

`data/config.json` controls runtime behavior that does not belong in `.env`, including:

- Ollama defaults
- voice service URLs and wake word settings
- memory retention and token limits
- per-skill permission policies

This is also where you tighten or expand what built-in skills are allowed to do.

## Usage

### Text mode

Text mode is the default.

```bash
pnpm build
pnpm start
```

You will get a terminal prompt:

```text
> 
```

Type messages directly. Use `exit` or `quit` to stop.

While Sonny is running, it also starts the localhost console and prints the URL:

```text
[console] http://127.0.0.1:3000
```

### Voice mode

Voice mode requires:

- `SONNY_VOICE_MODE=1`
- a valid `PORCUPINE_ACCESS_KEY`
- a running faster-whisper service
- a running Chatterbox service

Then start Sonny the same way:

```bash
pnpm build
pnpm start
```

In voice mode, Sonny:

1. listens for the wake word
2. captures microphone audio
3. transcribes with faster-whisper
4. generates a response with the LLM
5. processes the response for speech
6. synthesizes speech with Chatterbox
7. plays audio locally

The response processor strips Markdown, injects speech tags such as `[hesitation]`, `[laugh]`, and `[pause]`, and splits responses into sentence-sized chunks for smoother streaming playback.

### Menubar mode

The Electron menubar app is implemented in `src/ui/main.ts`.

After building, launch it directly with:

```bash
node dist/ui/main.js
```

The menubar UI provides:

- tray presence
- panel conversation view
- capsule status overlay
- status binding to the voice manager when attached

### Localhost console

The control panel runs on port `3000` when the main CLI starts.

Current endpoints and UI features include:

- memory file inspection and editing
- recent conversation history
- installed skill listing
- gateway and voice status snapshots

## Memory System

Sonny uses a three-part memory model.

### 1. Long-term memory

Long-term memory is stored as Markdown files in `data/memory/`:

- `facts.md`
- `preferences.md`
- `goals.md`
- `patterns.md`

These are intended to capture durable information about the user, not every transcript line.

### 2. Recent memory

Recent interactions are stored in `data/memory/recent.json`.

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

- `MonitorRegistry` persists watch targets in `data/monitors.json`
- `WebMonitor` polls enabled URLs and emits proactive notifications when content changes

### Permission model

Skill permissions are defined in `data/config.json` with:

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
4. Add permission settings for the tool in `data/config.json`.
5. Build again with `pnpm build`.

A minimal workflow looks like this:

```text
src/skills/my-skill.ts
  -> implement BuiltInSkill
src/skills/skill-registry.ts
  -> register new MySkill()
data/config.json
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
- UI polish for the menubar and console
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
