import { setTimeout as delay } from 'node:timers/promises';

import type { RuntimeStateSnapshot } from '../core/runtime-state.js';
import { startVoiceControlCenter } from '../app/voice-control-center.js';
import type { VoicePipelineDebugInfo } from '../voice/voice-session-orchestrator.js';

const PIPELINE_SETTLE_TIMEOUT_MS = 90_000;
const PIPELINE_POLL_INTERVAL_MS = 250;

async function main(): Promise<void> {
  const filePath = parseFileArgument(process.argv.slice(2));
  const runtime = await startVoiceControlCenter();

  try {
    await runtime.orchestrator.resetToIdle();
    runtime.orchestrator.clearLogs();
    await runtime.orchestrator.refreshHealth();

    const result = await runtime.orchestrator.runSampleVoiceTurn(filePath);
    const settled = await waitForPipelineToSettle(
      runtime.runtimeState.getSnapshot.bind(runtime.runtimeState),
      runtime.orchestrator.getPipelineDebug.bind(runtime.orchestrator),
    );
    const snapshot = runtime.runtimeState.getSnapshot();
    const pipeline = runtime.orchestrator.getPipelineDebug();

    printSection('Sonny Voice File Validation', [
      `Control Center: ${runtime.consoleServer.address.url}`,
      `Input File: ${result.filePath}`,
      `Timed Out: ${String(settled.timedOut)}`,
    ]);
    printSection('Runtime', [
      `State: ${snapshot.currentState}`,
      `Mic Active: ${String(snapshot.micActive)}`,
      `Playback Active: ${String(snapshot.playbackActive)}`,
      `User Partial Transcript: ${snapshot.userPartialTranscript ?? 'none'}`,
      `Final Transcript: ${snapshot.lastTranscript ?? 'none'}`,
      `Assistant Partial Response: ${snapshot.assistantPartialResponse ?? 'none'}`,
      `Final Response: ${snapshot.lastResponseText ?? 'none'}`,
    ]);
    printSection('Pipeline Verdict', formatVerdict(pipeline));
    printSection('Latency', formatLatency(pipeline));
    printSection('Playback', [
      `Playback Mode: ${pipeline.playbackMode}`,
      `Player Command: ${pipeline.playerCommand ?? 'unknown'}`,
      `Playback Started At: ${pipeline.latency.timestamps.playbackStartedAt ?? 'unknown'}`,
      `Playback Finished At: ${pipeline.latency.timestamps.playbackFinishedAt ?? 'unknown'}`,
    ]);
  } finally {
    await runtime.stop();
  }
}

async function waitForPipelineToSettle(
  readSnapshot: () => RuntimeStateSnapshot,
  readPipeline: () => VoicePipelineDebugInfo,
): Promise<{ timedOut: boolean }> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < PIPELINE_SETTLE_TIMEOUT_MS) {
    const snapshot = readSnapshot();
    const pipeline = readPipeline();
    const hasRunningStage = [
      pipeline.recording,
      pipeline.stt,
      pipeline.gateway,
      pipeline.tts,
      pipeline.playback,
    ].some((stage) => stage.status === 'running');

    if (
      !snapshot.micActive &&
      !snapshot.playbackActive &&
      !hasRunningStage &&
      (snapshot.currentState === 'idle' || snapshot.currentState === 'error')
    ) {
      return {
        timedOut: false,
      };
    }

    await delay(PIPELINE_POLL_INTERVAL_MS);
  }

  return {
    timedOut: true,
  };
}

function formatVerdict(pipeline: VoicePipelineDebugInfo): string[] {
  return [
    `STT partials: ${pipeline.verdict.sttPartials ? 'yes' : 'no'}`,
    `Transcript final: ${pipeline.verdict.transcriptFinal ? 'yes' : 'no'}`,
    `LLM streaming: ${pipeline.verdict.llmStreaming ? 'yes' : 'no'}`,
    `TTS streaming path: ${pipeline.verdict.ttsStreamingPath ? 'yes' : 'no'}`,
    `Playback started: ${pipeline.verdict.playbackStarted ? 'yes' : 'no'}`,
    `Playback mode: ${pipeline.verdict.playbackMode}`,
    `Full turn success: ${pipeline.verdict.fullTurnSuccess ? 'yes' : 'no'}`,
  ];
}

function formatLatency(pipeline: VoicePipelineDebugInfo): string[] {
  return [
    `Mic Start At: ${pipeline.latency.timestamps.micStartAt ?? 'unknown'}`,
    `Silence Detected At: ${pipeline.latency.timestamps.silenceDetectedAt ?? 'unknown'}`,
    `STT First Chunk At: ${pipeline.latency.timestamps.sttFirstChunkAt ?? 'unknown'}`,
    `First Token At: ${pipeline.latency.timestamps.firstTokenAt ?? 'unknown'}`,
    `TTS First Audio At: ${pipeline.latency.timestamps.ttsFirstAudioReadyAt ?? 'unknown'}`,
    `Playback Finished At: ${pipeline.latency.timestamps.playbackFinishedAt ?? 'unknown'}`,
    `First Token Latency: ${String(pipeline.latency.durations.silenceToFirstTokenMs ?? 'unknown')}ms`,
    `Total Response Latency: ${String(pipeline.latency.durations.silenceToPlaybackFinishedMs ?? 'unknown')}ms`,
  ];
}

function parseFileArgument(argv: string[]): string | undefined {
  const envValue = process.env.npm_config_file;

  if (typeof envValue === 'string' && envValue.trim().length > 0) {
    return envValue.trim();
  }

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--file') {
      return argv[index + 1];
    }
  }

  return undefined;
}

function printSection(title: string, lines: string[]): void {
  process.stdout.write(`\n=== ${title} ===\n`);

  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
