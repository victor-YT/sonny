# Open-Source Readiness Cleanup

This document records the public-launch cleanup pass and the remaining low-risk refactor targets. It is intentionally conservative: behavior should stay unchanged while obsolete files and noisy defaults are removed.

## Removed Or Obsolete UI Remnants

- Removed unused Vite/React template assets from `console-web/src/assets/`.
- Removed the unused `menubar` runtime dependency. Electron now acts as a small tray host for the localhost control center.
- Searched for legacy preload, capsule, old panel, and old asset references. No active legacy preload, capsule overlay, or separate panel implementation remains in the source tree.
- Kept tray code because it is the current Electron host path, not stale UI.

## Logs Gated By Environment Flags

Normal demo runs should not print verbose tray/STT/TTS/gateway timing logs.

- `SONNY_UI_DEBUG`: Electron/tray startup details.
- `SONNY_GATEWAY_DEBUG`: raw gateway response and LLM route debug lines.
- `SONNY_STT_DEBUG`: faster-whisper request/stream diagnostics.
- `SONNY_TTS_DEBUG`: TTS retry/debug warnings in the voice manager.
- `SONNY_TTS_DIAG`: Qwen3-TTS timing diagnostics in TypeScript and Python server paths.
- `SONNY_TIMING_DEBUG`: local voice timing report dumps.

Errors that stop startup or indicate a real failure still print normally.

## Giant File Audit

Files over roughly 1000 lines remain intentionally untouched in this pass. They are working runtime-critical code and need focused tests before extraction.

| File | Current risk | Safe extraction points |
| --- | --- | --- |
| `src/voice/voice-session-orchestrator.ts` | Central state machine with many timing and diagnostics responsibilities. | Extract timeline builders, health snapshot builders, manual/sample turn helpers, and pure event mapping functions. |
| `console-web/src/App.tsx` | Large control-center component mixing API state, SSE handling, and diagnostics rendering. | Extract service stack panel, timeline panel, STT debug panel, pipeline debug panel, and hooks for runtime state/SSE polling. |
| `src/voice/microphone.ts` | Capture backends, device discovery, VAD interaction, and audio statistics live together. | Extract device discovery, recorder process adapters, WAV helpers, audio level calculations, and VAD client code. |
| `src/voice/voice-manager.ts` | Voice turn orchestration with TTS scheduling, playback, diagnostics, and gateway adaptation. | Extract speech segmentation helpers, TTS retry/scheduling helpers, playback event adapters, and response sanitization checks. |
| `src/voice/voice-gateway.ts` | Service startup/health orchestration plus provider-facing helpers. | Extract managed service process helpers, environment resolution helpers, and provider health formatting. |

Recommended rule: extract only pure helpers or leaf components first, then add regression tests around voice timeline metrics before moving core state transitions.

## Local Data And Model Hygiene

The repo ignores local-only output and model paths:

- `.env` and `.env.*` except `.env.example`
- `.local/`
- `models/`
- `dist/`
- `dist-test/`
- generated control-center assets under `src/ui/console/public/`

Do not commit downloaded model files, local runtime logs, memory stores, or generated app bundles.

## Remaining Cleanup Risks

- `console-web/src/App.tsx` should be split soon, but a broad UI refactor before launch would be higher risk than useful.
- The voice orchestrator and manager need targeted tests before extracting state-machine logic.
- Some warning logs from microphone/service startup are intentionally left visible because they indicate actionable local setup issues.
- Dependency metadata is still minimal; public package naming, screenshots, and release workflow can be handled separately from runtime cleanup.
