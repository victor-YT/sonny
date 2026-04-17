import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { stdin, stdout } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import type { RuntimeStateSnapshot } from '../core/runtime-state.js';
import { startVoiceControlCenter } from '../app/voice-control-center.js';
import {
  readVoiceEnvironmentConfig,
} from '../voice/voice-gateway.js';
import type {
  LastAudioDebugInfo,
  RecorderRuntimeDebugInfo,
  RetranscribeLastAudioResult,
  VoicePipelineDebugInfo,
} from '../voice/voice-session-orchestrator.js';

const PIPELINE_SETTLE_TIMEOUT_MS = 90_000;
const PIPELINE_POLL_INTERVAL_MS = 250;

async function main(): Promise<void> {
  const runtime = await startVoiceControlCenter();
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
  });

  try {
    await runtime.orchestrator.resetToIdle();
    runtime.orchestrator.clearLogs();
    await runtime.orchestrator.refreshHealth();

    const voiceEnvironment = readVoiceEnvironmentConfig(process.env);
    const configuredRecorder = voiceEnvironment.micRecordProgram ?? 'sox';
    const configuredRecorderPath = findExecutablePath(configuredRecorder);

    printSection('Sonny Voice Smoke', [
      `Control Center: ${runtime.consoleServer.address.url}`,
      'Manual voice acceptance flow for recorder -> STT -> gateway -> TTS -> playback.',
      'Target recorder output: 1ch / 16000Hz / pcm_s16le / wav',
      `Configured recorder backend: ${configuredRecorder}`,
      `Configured recorder path: ${configuredRecorderPath ?? 'not found in PATH'}`,
    ]);

    printSection('Services', formatServices(runtime.runtimeState.getSnapshot()));

    await rl.question('Press Enter to start listening...');

    try {
      await runtime.orchestrator.startListening();
    } catch (error: unknown) {
      printSection('Recorder Start Failed', [
        error instanceof Error ? error.message : String(error),
        ...formatRecorder(runtime.orchestrator.getRecorderDebug()),
      ]);
      throw error;
    }

    printSection('Recorder Live', formatRecorder(runtime.orchestrator.getRecorderDebug()));
    await rl.question('Listening now. Say one short, clear sentence, then press Enter to stop...');

    await runtime.orchestrator.stopListening();

    stdout.write('Waiting for pipeline to settle...\n');
    const settled = await waitForPipelineToSettle(runtime.runtimeState.getSnapshot.bind(runtime.runtimeState), () => runtime.orchestrator.getPipelineDebug());
    const snapshot = runtime.runtimeState.getSnapshot();
    const recorder = runtime.orchestrator.getRecorderDebug();
    const lastAudio = runtime.orchestrator.getLastAudioDebug();
    const pipeline = runtime.orchestrator.getPipelineDebug();

    let retranscribeResult: RetranscribeLastAudioResult | null = null;
    let retranscribeError: string | null = null;

    if (lastAudio.exists) {
      try {
        retranscribeResult = await runtime.orchestrator.retranscribeLastAudio();
      } catch (error: unknown) {
        retranscribeError = error instanceof Error ? error.message : String(error);
      }
    } else {
      retranscribeError = 'No saved audio available for STT replay.';
    }

    printSection('Services', formatServices(snapshot));
    printSection('Recorder Debug', formatRecorder(recorder));
    printSection('Last Audio', formatLastAudio(lastAudio));
    printSection('Pipeline', formatPipeline(pipeline, settled.timedOut));
    printSection('Latency', formatLatency(pipeline));
    printSection(
      'STT Debug',
      formatSttDebug(
        retranscribeResult,
        retranscribeError,
        pipeline,
      ),
    );
    printSection('Closure', formatClosure(snapshot, pipeline, settled.timedOut));
  } finally {
    rl.close();
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

function formatServices(snapshot: RuntimeStateSnapshot): string[] {
  return Object.values(snapshot.services).map((service) => {
    const details = service.error ?? service.url ?? 'no details';
    return `${service.label}: ${service.online ? 'online' : 'offline'} (${details})`;
  });
}

function formatRecorder(recorder: RecorderRuntimeDebugInfo): string[] {
  return [
    `Backend: ${recorder.backend}`,
    `Backend Path: ${recorder.backendPath ?? 'not found'}`,
    `Available: ${String(recorder.backendAvailable)}`,
    `Input Device: ${recorder.device ?? 'default'}`,
    `Default Device: ${String(recorder.usingDefaultDevice)}`,
    `Spawn Started: ${String(recorder.spawnStarted)}`,
    `First Chunk Received: ${String(recorder.firstChunkReceived)}`,
    `Last Failure Reason: ${recorder.lastFailureReason ?? 'none'}`,
    `Last Spawn Error: ${recorder.lastSpawnError ?? 'none'}`,
    `Last Stderr: ${recorder.lastStderr ?? 'none'}`,
    `Mic Permission Hint: ${recorder.micPermissionHint ?? 'none'}`,
  ];
}

function formatLastAudio(lastAudio: LastAudioDebugInfo): string[] {
  if (!lastAudio.exists) {
    return ['No saved audio found.'];
  }

  return [
    `Path: ${lastAudio.path ?? 'unknown'}`,
    `Byte Length: ${formatMaybe(lastAudio.byteLength)}`,
    `Duration: ${formatMaybe(lastAudio.durationMs, 'ms')}`,
    `Sample Rate: ${formatMaybe(lastAudio.sampleRate, 'Hz')}`,
    `Channels: ${formatMaybe(lastAudio.channels)}`,
    `Bits Per Sample: ${formatMaybe(lastAudio.bitsPerSample)}`,
    `Format: ${lastAudio.format ?? 'unknown'}`,
    `Encoding: ${lastAudio.encoding ?? 'unknown'}`,
    `Peak Amplitude: ${formatMetric(lastAudio.peakAmplitude)}`,
    `RMS Level: ${formatMetric(lastAudio.rmsLevel)}`,
    `Silent Ratio: ${formatMetric(lastAudio.silentRatio)}`,
    `Audio Quality Hint: ${lastAudio.audioQualityHint ?? 'unknown'}`,
    `Whisper Target: ${lastAudio.targetChannels}ch / ${lastAudio.targetSampleRate}Hz / ${lastAudio.targetEncoding} / ${lastAudio.targetFormat}`,
    `Target Match: ${String(lastAudio.matchesWhisperInputTarget ?? 'unknown')}`,
    `Target Risk: ${lastAudio.whisperInputRisk ?? 'none'}`,
  ];
}

function formatPipeline(
  pipeline: VoicePipelineDebugInfo,
  timedOut: boolean,
): string[] {
  const lines = [
    `Flow: ${pipeline.flow ?? 'none'}`,
    `Updated: ${pipeline.updatedAt ?? 'never'}`,
  ];

  for (const stage of ['recording', 'stt', 'gateway', 'tts', 'playback'] as const) {
    const stageState = pipeline[stage];
    lines.push(
      `${stage}: ${stageState.status}${stageState.error === null ? '' : ` (${stageState.error})`}`,
    );
  }

  if (timedOut) {
    lines.push(`Settle Timeout: exceeded ${PIPELINE_SETTLE_TIMEOUT_MS}ms`);
  }

  return lines;
}

function formatLatency(pipeline: VoicePipelineDebugInfo): string[] {
  return [
    `Stop Listening At: ${pipeline.latency.timestamps.stopListeningAt ?? 'unknown'}`,
    `STT Started At: ${pipeline.latency.timestamps.sttStartedAt ?? 'unknown'}`,
    `STT Finished At: ${pipeline.latency.timestamps.sttFinishedAt ?? 'unknown'}`,
    `Gateway Started At: ${pipeline.latency.timestamps.gatewayStartedAt ?? 'unknown'}`,
    `First Token At: ${pipeline.latency.timestamps.firstTokenAt ?? 'unknown'}`,
    `First Sentence Ready At: ${pipeline.latency.timestamps.firstSentenceReadyAt ?? 'unknown'}`,
    `TTS Request Started At: ${pipeline.latency.timestamps.ttsRequestStartedAt ?? 'unknown'}`,
    `TTS First Audio Ready At: ${pipeline.latency.timestamps.ttsFirstAudioReadyAt ?? 'unknown'}`,
    `TTS Finished At: ${pipeline.latency.timestamps.ttsFinishedAt ?? 'unknown'}`,
    `Playback Started At: ${pipeline.latency.timestamps.playbackStartedAt ?? 'unknown'}`,
    `Playback Finished At: ${pipeline.latency.timestamps.playbackFinishedAt ?? 'unknown'}`,
    `STT Latency: ${formatDuration(pipeline.latency.durations.sttLatencyMs)}`,
    `Gateway -> First Token: ${formatDuration(pipeline.latency.durations.gatewayToFirstTokenMs)}`,
    `Gateway -> First Sentence: ${formatDuration(pipeline.latency.durations.gatewayToFirstSentenceMs)}`,
    `TTS -> First Audio: ${formatDuration(pipeline.latency.durations.ttsToFirstAudioMs)}`,
    `TTS Full Synthesis: ${formatDuration(pipeline.latency.durations.ttsFullSynthesisMs)}`,
    `Stop -> First Sound: ${formatDuration(pipeline.latency.durations.stopToFirstSoundMs)}`,
    `Stop -> Playback Finished: ${formatDuration(pipeline.latency.durations.stopToPlaybackFinishedMs)}`,
  ];
}

function formatSttDebug(
  retranscribeResult: RetranscribeLastAudioResult | null,
  retranscribeError: string | null,
  pipeline: VoicePipelineDebugInfo,
): string[] {
  const debug = retranscribeResult?.sttDebug ?? pipeline.sttDebug;

  return [
    `Retranscribe Result: ${retranscribeError ?? 'ok'}`,
    `Request URL: ${debug.requestUrl ?? 'unknown'}`,
    `HTTP Status: ${debug.httpStatus ?? 'unknown'}`,
    `Content Type: ${debug.contentType ?? 'unknown'}`,
    `Response Keys: ${debug.responseKeys.length === 0 ? 'none' : debug.responseKeys.join(', ')}`,
    `Transcript Length: ${debug.transcriptLength ?? 'unknown'}`,
    `Transcript: ${debug.transcript ?? retranscribeResult?.transcript ?? 'none'}`,
    `Failure Reason: ${debug.failureReason ?? 'none'}`,
    `Raw Body: ${debug.rawBodyPreview ?? 'none'}`,
  ];
}

function formatClosure(
  snapshot: RuntimeStateSnapshot,
  pipeline: VoicePipelineDebugInfo,
  timedOut: boolean,
): string[] {
  const closedLoop =
    pipeline.recording.status === 'succeeded' &&
    pipeline.stt.status === 'succeeded' &&
    pipeline.gateway.status === 'succeeded' &&
    pipeline.tts.status === 'succeeded' &&
    pipeline.playback.status === 'succeeded' &&
    snapshot.currentState === 'idle' &&
    snapshot.lastError === null &&
    !timedOut;

  return [
    `Closed Loop: ${closedLoop ? 'yes' : 'no'}`,
    `Final Runtime State: ${snapshot.currentState}`,
    `Last Error: ${snapshot.lastError ?? 'none'}`,
    `Last Transcript Length: ${snapshot.lastTranscript?.length ?? 0}`,
    `Last Response Length: ${snapshot.lastResponseText?.length ?? 0}`,
  ];
}

function printSection(title: string, lines: string[]): void {
  stdout.write(`\n=== ${title} ===\n`);

  for (const line of lines) {
    stdout.write(`${line}\n`);
  }
}

function formatMaybe(value: number | null, suffix = ''): string {
  if (value === null) {
    return 'unknown';
  }

  return `${value}${suffix}`;
}

function formatMetric(value: number | null): string {
  if (value === null) {
    return 'unknown';
  }

  return value.toFixed(4);
}

function formatDuration(value: number | null): string {
  if (value === null) {
    return 'unknown';
  }

  return `${value}ms`;
}

function findExecutablePath(command: string): string | null {
  const result = spawnSync('which', [command], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    return null;
  }

  const output = result.stdout.trim();

  return output.length > 0 ? output : null;
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
