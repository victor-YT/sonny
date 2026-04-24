# Sonny Voice Runtime

This document is the maintained map for the local-first voice path. Keep it updated whenever the voice pipeline, provider contracts, or runtime state model changes.

## Target Pipeline

The voice runtime has one primary turn shape:

1. `Listening`: capture microphone PCM at 16 kHz mono.
2. `Silence Detected`: VAD marks end-of-turn after speech has started and enough trailing silence has accumulated.
3. `STT`: sherpa-onnx consumes live PCM chunks by default, emits partial transcripts, and returns a final transcript after end-of-turn. faster-whisper remains available as a fallback provider.
4. `LLM`: `Gateway.streamChat()` sends the transcript through prompt/context/memory and streams assistant text. The default foreground provider is OLMX via OpenAI-compatible `/v1/chat/completions`; Ollama remains the background/fallback provider.
5. `TTS`: streamed assistant text is segmented into spoken sentences and sent to Qwen3-TTS.
6. `Playback`: synthesized audio is queued and played by the system speaker.

The runtime should prefer streaming between stages, but correctness wins over latency. Spoken sentences must be queued in response order even when later TTS requests would finish faster.

## Runtime Entry Points

- `src/app/voice-control-center.ts`: primary app runtime used by the Electron/control-center path.
- `src/index.ts`: CLI/runtime entry point, including text chat and push-to-talk fallback.
- `src/voice/voice-gateway.ts`: wires microphone, speaker, providers, local service processes, and environment overrides.
- `src/voice/voice-session-orchestrator.ts`: UI-facing state machine, health polling, diagnostics, and manual/sample turn controls.
- `src/voice/voice-manager.ts`: core turn pipeline from capture to STT, LLM, TTS, and playback.

## Provider Boundaries

Provider interfaces live under `src/voice/providers/` and `src/core/providers/`.

- `SttProvider`: owns transcript extraction and STT debug information. The default implementation is `SherpaOnnxProvider`; `FasterWhisperProvider` remains selectable with `SONNY_STT_PROVIDER=faster-whisper`.
- `TtsProvider`: owns text-to-audio synthesis. The default implementation is `Qwen3TTSProvider` in `chatterbox.ts`; the compatibility file name is historical.
- `PlaybackProvider`: owns adding synthesized audio to playback. The default implementation is `SystemPlaybackProvider`.
- `WakeWordProvider`: owns wake word events. Current local service implementation is `PorcupineProvider`, but its runtime name is `openwakeword`.
- `LlmProvider`: owns generation. `OlmxForegroundProvider` is the default foreground realtime provider; `OllamaProvider` remains selectable for foreground and is the default background provider. `Gateway` wraps providers with prompt building, session persistence, memory, and tools.

## State Ownership

`VoiceManager` owns the actual voice turn state:

- `idle`
- `listening`
- `capturing`
- `transcribing`
- `thinking`
- `synthesizing`
- `playing`
- `error`

`VoiceSessionOrchestrator` maps those events into control-center runtime state and pipeline diagnostics. It should not duplicate provider logic. Its responsibilities are:

- service readiness checks
- UI/runtime state transitions
- microphone and audio diagnostics
- manual/sample turn orchestration
- logs and latency fields

## End-Of-Turn Rules

`Microphone.capture()` is the live microphone boundary. In normal mode it:

- captures raw PCM with `sox`
- pushes chunks into an `AsyncIterable<Buffer>` for streaming STT
- sends fixed-size chunks to VAD at `VAD_URL/detect`
- starts silence counting only after speech threshold is reached
- calls `onSilenceDetected` once when trailing silence threshold is reached
- closes the stream and finalizes WAV audio for diagnostics

The important diagnostic fields are:

- `captureEndedBy`
- `endOfTurnReason`
- `speechStarted`
- `silenceDetected`
- `vadSpeechMs`
- `vadSilenceMs`
- `firstNonEmptyChunkReceived`
- `endedBeforeFirstChunk`

## Verification Commands

Run these before committing voice runtime changes:

```bash
pnpm build
pnpm test
```

Useful manual checks:

```bash
pnpm voice:providers
pnpm llm:olmx:test
pnpm voice:simulate
pnpm stt:sherpa:test -- --file models/sherpa-onnx-streaming-paraformer-bilingual-zh-en/test_wavs/0.wav
pnpm stt:benchmark -- --file models/sherpa-onnx-streaming-paraformer-bilingual-zh-en/test_wavs/0.wav
pnpm start
```

`pnpm voice:simulate` validates STT, LLM, TTS, and playback with a sample file. It does not prove live microphone permissions or VAD behavior.

Use `pnpm run stt:sherpa:model` to download the default sherpa-onnx streaming Paraformer model before running sherpa smoke tests.

## Cleanup Rules

- Keep provider interfaces small and explicit before adding provider implementations.
- Keep `VoiceManager` focused on the turn pipeline. Do not add UI diagnostics there.
- Keep `VoiceSessionOrchestrator` focused on runtime state and diagnostics. Do not add STT/TTS provider behavior there.
- Prefer tests around provider contracts and pipeline ordering over UI-only checks.
- Treat generated assets and local experiments as ignored output. Root `dev/` is ignored; tracked `src/dev/` scripts remain source code until they are removed or moved intentionally.

## Current Known Risks

- `voice-session-orchestrator.ts` is too large and should be split by diagnostics, timeline construction, and manual/sample turn control.
- `microphone.ts` combines process management, VAD, macOS input discovery, WAV wrapping, and diagnostics. Split only after live mic behavior is covered by tests or a reproducible fixture.
- The TTS provider implementation is named `Qwen3TTSProvider`, while several config names still use `chatterbox` for compatibility.
- Wake-word naming mixes `Porcupine` and `openwakeword`; provider IDs should be normalized before the public API is documented as stable.
