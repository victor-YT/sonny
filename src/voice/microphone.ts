import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { TimingTracker } from '../core/timing.js';
import type { VoiceCaptureResult } from './voice-manager.js';
import type { StreamingSttDebugContext } from './providers/stt.js';

const DEFAULT_SAMPLE_RATE_HERTZ = 16_000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_MAX_CAPTURE_MS = 8_000;
const DEFAULT_RECORD_PROGRAM = 'sox';
const DEFAULT_VAD_URL = 'http://127.0.0.1:8003';
const DEFAULT_VAD_POLL_MS = 100;
const DEFAULT_SPEECH_THRESHOLD_MS = 300;
const DEFAULT_SILENCE_THRESHOLD_MS = 600;
const DEFAULT_MIC_GAIN_DB = 12;
const MIN_CAPTURE_BYTES = 10_240;
const MIN_AUTO_STOP_CAPTURE_MS = 400;
const DEFAULT_DEBUG_MODE = process.env.SONNY_MIC_DEBUG_MODE ?? null;
export const MANUAL_CAPTURE_STOP_REASON = 'manual_capture_stop';

export interface MicrophoneCaptureOptions {
  signal?: AbortSignal;
  onSilenceDetected?: () => void;
  onAudioLevel?: (event: MicrophoneAudioLevelEvent) => void;
}

export interface MicrophoneAudioLevelEvent {
  rmsLevel: number;
  speechStarted: boolean;
  silenceDetected: boolean;
}

export interface MicrophoneConfig {
  sampleRateHertz?: number;
  channels?: number;
  threshold?: number;
  silenceSeconds?: number;
  maxCaptureMs?: number;
  recordProgram?: string;
  debugMode?: string;
  readyDelayMs?: number;
  vadUrl?: string;
  gainDb?: number;
}

export interface MicrophoneCaptureDiagnostics {
  backend: string;
  backendPath: string | null;
  backendAvailable: boolean;
  command: string | null;
  args: string[];
  inputSource: string | null;
  requestedSampleRateHertz: number | null;
  requestedChannels: number | null;
  outputFormat: string | null;
  outputTransport: string | null;
  debugMode: string | null;
  device: string | null;
  defaultInputDeviceName: string | null;
  availableInputDevices: string[];
  usingDefaultDevice: boolean;
  bytesCaptured: number | null;
  captureEndedBy: 'silence' | 'max_timeout' | 'manual' | 'abort' | 'unknown';
  endOfTurnReason: 'silence' | 'max_timeout' | 'manual' | 'interrupted' | 'unknown';
  firstNonEmptyChunkReceived: boolean;
  endedBeforeFirstChunk: boolean;
  vadRequestCount: number;
  vadSpeechChunkCount: number;
  vadSilenceChunkCount: number;
  vadDroppedChunkCount: number;
  vadSpeechMs: number;
  vadSilenceMs: number;
  speechStarted: boolean;
  silenceDetected: boolean;
  speechThresholdMs: number;
  silenceThresholdMs: number;
  minAutoStopCaptureMs: number;
  micGainDb: number;
  lastChunkRmsLevel: number | null;
  avgChunkRmsLevel: number | null;
  maxChunkRmsLevel: number | null;
  captureAborted: boolean;
  lastCaptureError: string | null;
  likelyFailureCause: string | null;
}

export class MicrophoneCaptureError extends Error {
  public readonly diagnostics: MicrophoneCaptureDiagnostics;

  public constructor(message: string, diagnostics: MicrophoneCaptureDiagnostics) {
    super(message);
    this.name = 'MicrophoneCaptureError';
    this.diagnostics = diagnostics;
  }
}

export class Microphone {
  private readonly sampleRateHertz: number;
  private readonly channels: number;
  private readonly maxCaptureMs: number;
  private readonly recordProgram: string;
  private readonly debugMode: string | null;
  private readonly vadUrl: string;
  private readonly silenceThresholdMs: number;
  private readonly gainDb: number;
  private lastDiagnostics: MicrophoneCaptureDiagnostics | null = null;

  public constructor(config: MicrophoneConfig = {}) {
    this.sampleRateHertz = config.sampleRateHertz ?? DEFAULT_SAMPLE_RATE_HERTZ;
    this.channels = config.channels ?? DEFAULT_CHANNELS;
    this.maxCaptureMs = config.maxCaptureMs ?? DEFAULT_MAX_CAPTURE_MS;
    this.recordProgram = config.recordProgram ?? DEFAULT_RECORD_PROGRAM;
    this.debugMode = normalizeDebugMode(config.debugMode ?? DEFAULT_DEBUG_MODE);
    this.vadUrl = config.vadUrl ?? DEFAULT_VAD_URL;
    this.gainDb = config.gainDb ?? DEFAULT_MIC_GAIN_DB;
    this.silenceThresholdMs = Math.max(
      DEFAULT_VAD_POLL_MS,
      Math.round((config.silenceSeconds ?? DEFAULT_SILENCE_THRESHOLD_MS / 1000) * 1000),
    );
  }

  public async capture(options: MicrophoneCaptureOptions = {}): Promise<VoiceCaptureResult> {
    const timingTracker = new TimingTracker();
    timingTracker.start('vad_detection');

    if (this.shouldUseDirectSoxFileCapture()) {
      const audioPromise = this.recordWithDirectSoxFile(timingTracker, options.signal);

      return {
        audioPromise,
        timingTracker,
        sttOptions: {
          sampleRateHertz: this.sampleRateHertz,
          channels: this.channels,
          encoding: 'wav',
          timingTracker,
        },
      };
    }

    if (this.shouldUseFfmpeg()) {
      const audioPromise = this.recordWithFfmpeg(timingTracker, options.signal);

      return {
        audioPromise,
        timingTracker,
        sttOptions: {
          sampleRateHertz: this.sampleRateHertz,
          channels: this.channels,
          timingTracker,
        },
      };
    }

    const audioStream = new BufferAsyncIterable();
    const streamingDebug = createStreamingSttDebugContext();
    const audioPromise = this.recordWithVad(audioStream, timingTracker, options, streamingDebug);

    return {
      audioStream,
      audioPromise,
      timingTracker,
      sttOptions: {
        sampleRateHertz: this.sampleRateHertz,
        channels: this.channels,
        encoding: 'pcm_s16le',
        timingTracker,
        streamingDebug,
      },
    };
  }

  public async inspectEnvironment(): Promise<MicrophoneCaptureDiagnostics> {
    const diagnostics = await this.buildCaptureDiagnostics();
    this.lastDiagnostics = diagnostics;
    return { ...diagnostics, availableInputDevices: [...diagnostics.availableInputDevices] };
  }

  public getLastDiagnostics(): MicrophoneCaptureDiagnostics | null {
    if (this.lastDiagnostics === null) {
      return null;
    }

    return {
      ...this.lastDiagnostics,
      availableInputDevices: [...this.lastDiagnostics.availableInputDevices],
    };
  }

  private shouldUseFfmpeg(): boolean {
    return process.platform === 'darwin' && this.recordProgram === 'ffmpeg';
  }

  private shouldUseDirectSoxFileCapture(): boolean {
    return process.platform === 'darwin' &&
      this.recordProgram === 'sox' &&
      this.debugMode === 'direct-sox-file';
  }

  private async recordWithFfmpeg(
    timingTracker: TimingTracker,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const inputDiagnostics = await this.buildCaptureDiagnostics();
    const input = await this.resolveMacOsAudioInput(inputDiagnostics);
    const outputPath = join(tmpdir(), `sonny-mic-${randomUUID()}.wav`);
    const durationSeconds = Math.max(1, Math.ceil(this.maxCaptureMs / 1000));
    const args = [
      '-y',
      '-f', 'avfoundation',
      '-i', input,
      '-ar', String(this.sampleRateHertz),
      '-ac', String(this.channels),
      '-acodec', 'pcm_s16le',
      '-t', String(durationSeconds),
      outputPath,
    ];
    const diagnostics = this.withInvocation(inputDiagnostics, {
      command: this.recordProgram,
      args,
      inputSource: input,
      outputFormat: 'wav / pcm_s16le',
      outputTransport: 'temp_file',
    });

    this.lastDiagnostics = diagnostics;

    return new Promise<Buffer>((resolve, reject) => {
      let child: ChildProcess;

      try {
        child = spawn(this.recordProgram, args, {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (error: unknown) {
        const resolvedError =
          error instanceof Error
            ? error
            : new Error('Failed to spawn ffmpeg recording process');
        reject(this.toCaptureError(resolvedError, diagnostics));
        return;
      }

      const stderrLines: string[] = [];

      child.stderr?.on('data', (data: Buffer) => {
        appendLogLines(stderrLines, data.toString('utf8'));
      });

      const handleAbort = (): void => {
        child.kill('SIGTERM');
      };

      signal?.addEventListener('abort', handleAbort, { once: true });

      child.on('error', async (err: Error) => {
        await this.cleanupFile(outputPath);
        reject(this.toCaptureError(new Error(`Failed to start ffmpeg: ${err.message}`), diagnostics));
      });

      child.on('close', async (code: number | null) => {
        signal?.removeEventListener('abort', handleAbort);

        if (signal?.aborted) {
          await this.cleanupFile(outputPath);
          reject(this.toCaptureError(new Error('Microphone capture aborted'), {
            ...diagnostics,
            captureAborted: true,
          }));
          return;
        }

        if (code !== null && code !== 0) {
          await this.cleanupFile(outputPath);
          reject(this.toCaptureError(new Error(
            `ffmpeg exited with code ${code}: ${stderrLines.join(' | ') || 'unknown error'}`,
          ), diagnostics));
          return;
        }

        try {
          const fileStat = await stat(outputPath);

          if (fileStat.size <= 0) {
            throw new Error('[mic] ffmpeg recorded an empty audio file');
          }

          const wav = await readFile(outputPath);
          this.lastDiagnostics = {
            ...diagnostics,
            bytesCaptured: wav.byteLength,
          };
          const validated = this.finalizeRecordedWav(wav, 'ffmpeg');
          timingTracker.end('vad_detection');
          resolve(validated);
        } catch (error: unknown) {
          reject(this.toCaptureError(
            error instanceof Error ? error : new Error(String(error)),
            {
              ...diagnostics,
              bytesCaptured: await this.readCapturedFileSize(outputPath),
            },
          ));
        } finally {
          await this.cleanupFile(outputPath);
        }
      });
    });
  }

  private async recordWithDirectSoxFile(
    timingTracker: TimingTracker,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const inputDiagnostics = await this.buildCaptureDiagnostics();
    const outputPath = join(tmpdir(), `sonny-mic-sox-${randomUUID()}.wav`);
    const durationSeconds = Math.max(1, Math.ceil(this.maxCaptureMs / 1000));
    const args = [
      '-d',
      '-r', String(this.sampleRateHertz),
      '-c', String(this.channels),
      '-t', 'wav',
      '-e', 'signed-integer',
      '-b', '16',
      outputPath,
      'trim', '0', String(durationSeconds),
    ];
    const diagnostics = this.withInvocation(inputDiagnostics, {
      command: this.recordProgram,
      args,
      inputSource: '-d',
      outputFormat: 'wav / pcm_s16le',
      outputTransport: 'temp_file',
    });

    this.lastDiagnostics = diagnostics;

    return new Promise<Buffer>((resolve, reject) => {
      let child: ChildProcess;

      try {
        child = spawn(this.recordProgram, args, {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (error: unknown) {
        const resolvedError =
          error instanceof Error
            ? error
            : new Error('Failed to spawn sox recording process');
        reject(this.toCaptureError(resolvedError, diagnostics));
        return;
      }

      const stderrLines: string[] = [];

      child.stderr?.on('data', (data: Buffer) => {
        appendLogLines(stderrLines, data.toString('utf8'));
      });

      const handleAbort = (): void => {
        child.kill('SIGTERM');
      };

      signal?.addEventListener('abort', handleAbort, { once: true });

      child.on('error', async (err: Error) => {
        await this.cleanupFile(outputPath);
        reject(this.toCaptureError(new Error(`Failed to start sox: ${err.message}`), diagnostics));
      });

      child.on('close', async (code: number | null) => {
        signal?.removeEventListener('abort', handleAbort);

        if (signal?.aborted) {
          await this.cleanupFile(outputPath);
          reject(this.toCaptureError(new Error('Microphone capture aborted'), {
            ...diagnostics,
            captureAborted: true,
          }));
          return;
        }

        if (code !== null && code !== 0) {
          await this.cleanupFile(outputPath);
          reject(this.toCaptureError(new Error(
            `sox exited with code ${code}: ${stderrLines.join(' | ') || 'unknown error'}`,
          ), diagnostics));
          return;
        }

        try {
          const fileStat = await stat(outputPath);

          if (fileStat.size <= 0) {
            throw new Error('[mic] sox recorded an empty audio file');
          }

          const wav = await readFile(outputPath);
          this.lastDiagnostics = {
            ...diagnostics,
            bytesCaptured: wav.byteLength,
          };
          const validated = this.finalizeRecordedWav(wav, 'sox');
          timingTracker.end('vad_detection');
          resolve(validated);
        } catch (error: unknown) {
          reject(this.toCaptureError(
            error instanceof Error ? error : new Error(String(error)),
            {
              ...diagnostics,
              bytesCaptured: await this.readCapturedFileSize(outputPath),
            },
          ));
        } finally {
          await this.cleanupFile(outputPath);
        }
      });
    });
  }

  private recordWithVad(
    audioStream: BufferAsyncIterable,
    timingTracker: TimingTracker,
    options: MicrophoneCaptureOptions,
    streamingDebug: StreamingSttDebugContext,
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      let child: ChildProcess;
      const diagnostics = this.withInvocation(this.buildFallbackDiagnostics(), {
        command: this.recordProgram,
        args: [
          '-d',
          '-r', String(this.sampleRateHertz),
          '-c', String(this.channels),
          '-b', '16',
          '-e', 'signed-integer',
          '-t', 'raw',
          '-',
        ],
        inputSource: '-d',
        outputFormat: 'raw / pcm_s16le',
        outputTransport: 'stdout_pipe_then_wrap_wav',
      });
      this.lastDiagnostics = diagnostics;

      try {
        child = spawn(this.recordProgram, diagnostics.args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error: unknown) {
        reject(this.toCaptureError(
          error instanceof Error
            ? error
            : new Error('Failed to spawn sox recording process'),
          diagnostics,
        ));
        return;
      }

      this.consumeRecordingProcess({
        child,
        audioStream,
        sourceName: 'sox',
        timingTracker,
        options,
        streamingDebug,
        diagnostics,
        resolve,
        reject,
      });
    });
  }

  private consumeRecordingProcess(config: {
    child: ChildProcess;
    audioStream: BufferAsyncIterable;
    sourceName: string;
    timingTracker: TimingTracker;
    options: MicrophoneCaptureOptions;
    streamingDebug: StreamingSttDebugContext;
    diagnostics: MicrophoneCaptureDiagnostics;
    resolve: (value: Buffer) => void;
    reject: (reason?: unknown) => void;
  }): void {
    const {
      child,
      audioStream,
      sourceName,
      timingTracker,
      options,
      streamingDebug,
      diagnostics,
      resolve,
      reject,
    } = config;
    const allChunks: Buffer[] = [];
    let pendingVadChunk = Buffer.alloc(0);
    let settled = false;
    let speechStarted = false;
    let speechMs = 0;
    let silenceMs = 0;
    const vadUrl = `${this.vadUrl}/detect`;
    let vadBusy = false;
    let silenceDetected = false;
    let firstChunkReceivedAt: number | null = null;
    let pendingAutoStop: { reason: 'silence' } | null = null;
    let captureEndedBy: MicrophoneCaptureDiagnostics['captureEndedBy'] = 'unknown';
    let vadRequestCount = 0;
    let vadSpeechChunkCount = 0;
    let vadSilenceChunkCount = 0;
    let vadDroppedChunkCount = 0;
    let vadUnavailableLogged = false;
    let lastChunkRmsLevel: number | null = null;
    let rmsTotal = 0;
    let rmsSamples = 0;
    let maxChunkRmsLevel = 0;
    const vadChunkQueue: Buffer[] = [];
    const killChild = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        // already exited
      }
    };

    const finish = (result: Buffer | Error): void => {
      if (settled) {
        return;
      }

      settled = true;

      if (result instanceof Error) {
        audioStream.fail(result);
        reject(result);
      } else {
        resolve(result);
      }
    };

    const buildCompletedDiagnostics = (
      baseDiagnostics: MicrophoneCaptureDiagnostics,
      bytesCaptured: number,
    ): MicrophoneCaptureDiagnostics => {
      const firstNonEmptyChunkReceived = firstChunkReceivedAt !== null;

      return {
        ...baseDiagnostics,
        bytesCaptured,
        captureEndedBy,
        endOfTurnReason: mapCaptureEndedByToEndOfTurnReason(captureEndedBy),
        firstNonEmptyChunkReceived,
        endedBeforeFirstChunk: !firstNonEmptyChunkReceived,
        vadRequestCount,
        vadSpeechChunkCount,
        vadSilenceChunkCount,
        vadDroppedChunkCount,
        vadSpeechMs: speechMs,
        vadSilenceMs: silenceMs,
        speechStarted,
        silenceDetected,
        speechThresholdMs: DEFAULT_SPEECH_THRESHOLD_MS,
        silenceThresholdMs: this.silenceThresholdMs,
        minAutoStopCaptureMs: MIN_AUTO_STOP_CAPTURE_MS,
        micGainDb: this.gainDb,
        lastChunkRmsLevel,
        avgChunkRmsLevel: rmsSamples === 0 ? null : Number((rmsTotal / rmsSamples).toFixed(4)),
        maxChunkRmsLevel: rmsSamples === 0 ? null : Number(maxChunkRmsLevel.toFixed(4)),
      };
    };

    const syncStreamingDebug = (): void => {
      if (streamingDebug === undefined) {
        return;
      }

      streamingDebug.streamBytesSent = Buffer.concat(allChunks).byteLength;
      streamingDebug.streamNonEmptyChunkCount = firstChunkReceivedAt === null ? 0 : allChunks.filter((chunk) => chunk.length > 0).length;
      streamingDebug.captureEndedBy = captureEndedBy;
      streamingDebug.firstNonEmptyChunkReceived = firstChunkReceivedAt !== null;
      streamingDebug.endedBeforeFirstChunk = firstChunkReceivedAt === null;
    };

    const failBeforeFirstChunk = (
      message: string,
      endedBy: MicrophoneCaptureDiagnostics['captureEndedBy'],
    ): void => {
      captureEndedBy = endedBy;
      syncStreamingDebug();

      if (streamingDebug !== undefined) {
        streamingDebug.sttRequestSkippedBecauseEmpty = true;
      }

      timingTracker.end('vad_detection');
      killChild();
      finish(
        this.toCaptureError(
          new Error(message),
          buildCompletedDiagnostics(diagnostics, Buffer.concat(allChunks).byteLength),
        ),
      );
    };

    const stopRecording = (
      endedBy: MicrophoneCaptureDiagnostics['captureEndedBy'],
    ): void => {
      if (settled) {
        return;
      }

      captureEndedBy = endedBy;
      syncStreamingDebug();
      console.warn(
        `[mic] stopping capture via ${endedBy} `
        + JSON.stringify({
          speechStarted,
          silenceDetected,
          speechMs,
          silenceMs,
          vadRequestCount,
          vadSpeechChunkCount,
          vadSilenceChunkCount,
          vadDroppedChunkCount,
          lastChunkRmsLevel,
          avgChunkRmsLevel: rmsSamples === 0 ? null : Number((rmsTotal / rmsSamples).toFixed(4)),
          maxChunkRmsLevel: rmsSamples === 0 ? null : Number(maxChunkRmsLevel.toFixed(4)),
        }),
      );

      try {
        const wav = this.finalizeCapture(Buffer.concat(allChunks), sourceName);
        this.lastDiagnostics = buildCompletedDiagnostics(diagnostics, wav.byteLength);
        timingTracker.end('vad_detection');
        audioStream.end();
        killChild();
        finish(wav);
      } catch (error: unknown) {
        killChild();
        finish(this.toCaptureError(
          error instanceof Error ? error : new Error(String(error)),
          buildCompletedDiagnostics(diagnostics, Buffer.concat(allChunks).byteLength),
        ));
      }
    };

    const canAutoStopNow = (): boolean => {
      if (firstChunkReceivedAt === null) {
        return false;
      }

      return Date.now() - firstChunkReceivedAt >= MIN_AUTO_STOP_CAPTURE_MS;
    };

    const requestAutoStop = (reason: 'silence'): void => {
      if (settled) {
        return;
      }

      if (canAutoStopNow()) {
        stopRecording(reason);
        return;
      }

      if (pendingAutoStop === null) {
        pendingAutoStop = { reason };
        console.warn(
          `[mic] ${sourceName} deferred auto-stop (${reason}); no audio chunks pushed yet`,
        );
      }
    };

    const maxTimeout = setTimeout(() => {
      if (!settled) {
        console.warn('[mic] max capture timeout reached, stopping capture');
        if (firstChunkReceivedAt === null) {
          failBeforeFirstChunk(
            'capture_timed_out_before_audio: max capture timeout reached before the first non-empty audio chunk',
            'max_timeout',
          );
          return;
        }

        stopRecording('max_timeout');
      }
    }, this.maxCaptureMs + 1000);

    const handleAbort = (): void => {
      clearTimeout(maxTimeout);
      if (options.signal?.reason === MANUAL_CAPTURE_STOP_REASON) {
        if (firstChunkReceivedAt === null) {
          failBeforeFirstChunk(
            'capture_manually_stopped_before_audio: manual stop requested before the first non-empty audio chunk',
            'manual',
          );
          return;
        }

        stopRecording('manual');
        return;
      }

      captureEndedBy = 'abort';
      killChild();
      finish(this.toCaptureError(new Error('Microphone capture aborted'), {
        ...buildCompletedDiagnostics(diagnostics, Buffer.concat(allChunks).byteLength),
        captureAborted: true,
      }));
    };

    options.signal?.addEventListener('abort', handleAbort, { once: true });

    const checkVad = async (pcmChunk: Buffer): Promise<void> => {
      if (settled) {
        return;
      }
      vadChunkQueue.push(pcmChunk);

      if (vadBusy) {
        return;
      }

      vadBusy = true;

      try {
        while (vadChunkQueue.length > 0 && !settled) {
          const queuedChunk = vadChunkQueue.shift();

          if (queuedChunk === undefined) {
            continue;
          }

          const rmsLevel = calculatePcm16Rms(queuedChunk);
          const vadChunkDurationMs = calculatePcm16DurationMs(
            queuedChunk,
            this.sampleRateHertz,
            this.channels,
          );
          lastChunkRmsLevel = rmsLevel;
          rmsTotal += rmsLevel;
          rmsSamples += 1;
          maxChunkRmsLevel = Math.max(maxChunkRmsLevel, rmsLevel);
          vadRequestCount += 1;
          options.onAudioLevel?.({
            rmsLevel,
            speechStarted,
            silenceDetected,
          });

          const response = await fetch(vadUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: new Uint8Array(queuedChunk),
          });

          if (!response.ok) {
            vadDroppedChunkCount += 1;
            continue;
          }

          const result = await response.json() as { speech: boolean };

          if (result.speech) {
            vadSpeechChunkCount += 1;
            speechMs += vadChunkDurationMs;
            silenceMs = 0;

            if (speechMs >= DEFAULT_SPEECH_THRESHOLD_MS) {
              speechStarted = true;
            }
          } else {
            vadSilenceChunkCount += 1;

            if (speechStarted) {
              silenceMs += vadChunkDurationMs;

              if (silenceMs >= this.silenceThresholdMs) {
                if (!silenceDetected) {
                  silenceDetected = true;
                  options.onSilenceDetected?.();
                }
                requestAutoStop('silence');
              }
            }
          }
        }
      } catch (error: unknown) {
        vadDroppedChunkCount += 1;
        if (!vadUnavailableLogged) {
          vadUnavailableLogged = true;
          console.warn(
            `[mic] VAD request failed; falling back to max capture timeout until VAD recovers `
            + JSON.stringify({
              vadUrl,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        // VAD service unavailable, fall back to max timeout
      } finally {
        vadBusy = false;
      }
    };

    if (child.stdout !== null) {
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) {
          return;
        }

        const amplifiedChunk = applyPcm16Gain(chunk, this.gainDb);

        allChunks.push(amplifiedChunk);
        audioStream.push(amplifiedChunk);

        if (amplifiedChunk.length > 0 && firstChunkReceivedAt === null) {
          firstChunkReceivedAt = Date.now();
        }

        syncStreamingDebug();

        if (pendingAutoStop !== null && canAutoStopNow()) {
          pendingAutoStop = null;
          stopRecording('silence');
          return;
        }

        pendingVadChunk = Buffer.concat([pendingVadChunk, amplifiedChunk]);
        const bytesPerPoll = 2 * this.sampleRateHertz * DEFAULT_VAD_POLL_MS / 1000;

        while (pendingVadChunk.length >= bytesPerPoll) {
          const vadChunk = Buffer.from(pendingVadChunk.subarray(0, bytesPerPoll));
          pendingVadChunk = pendingVadChunk.subarray(bytesPerPoll);
          void checkVad(vadChunk);
        }
      });

      child.stdout.on('error', (err: Error) => {
        console.warn(`[mic] ${sourceName} stdout error: ${err.message}`);
      });
    }

    if (child.stderr !== null) {
      const stderrLines: string[] = [];

      child.stderr.on('data', (data: Buffer) => {
        appendLogLines(stderrLines, data.toString('utf8'));
      });

      child.on('close', (code: number | null) => {
        if (!settled && code !== null && code !== 0 && stderrLines.length > 0) {
          console.warn(`[mic] ${sourceName} exited with stderr: ${stderrLines.join(' | ')}`);
        }
      });
    }

    child.on('error', (err: Error) => {
      clearTimeout(maxTimeout);
      options.signal?.removeEventListener('abort', handleAbort);
      finish(this.toCaptureError(new Error(`Failed to start ${sourceName}: ${err.message}`), diagnostics));
    });

    child.on('close', (code: number | null) => {
      clearTimeout(maxTimeout);
      options.signal?.removeEventListener('abort', handleAbort);

      if (settled) {
        return;
      }

      if (allChunks.length === 0) {
        finish(this.toCaptureError(
          new Error(`${sourceName} exited with code ${code} and produced no audio`),
          buildCompletedDiagnostics(diagnostics, 0),
        ));
        return;
      }

      let wav: Buffer;

      try {
        captureEndedBy = captureEndedBy === 'unknown' ? 'manual' : captureEndedBy;
        syncStreamingDebug();
        wav = this.finalizeCapture(Buffer.concat(allChunks), sourceName);
        this.lastDiagnostics = buildCompletedDiagnostics(diagnostics, wav.byteLength);
        audioStream.end();
      } catch (error: unknown) {
        finish(this.toCaptureError(
          error instanceof Error ? error : new Error(String(error)),
          buildCompletedDiagnostics(diagnostics, Buffer.concat(allChunks).byteLength),
        ));
        return;
      }

      if (code !== null && code !== 0) {
        console.warn(`[mic] ${sourceName} exited with code ${code}, returning captured audio`);
      }

      finish(wav);
    });
  }

  private finalizeCapture(pcm: Buffer, sourceName: string): Buffer {
    const wav = this.wrapPcmAsWav(pcm);

    return this.finalizeRecordedWav(wav, sourceName);
  }

  private finalizeRecordedWav(wav: Buffer, sourceName: string): Buffer {
    if (wav.byteLength <= MIN_CAPTURE_BYTES) {
      throw new Error(
        `[mic] ${sourceName} captured only ${wav.byteLength} bytes; microphone input appears empty`,
      );
    }

    return wav;
  }

  private async resolveMacOsAudioInput(
    diagnostics?: MicrophoneCaptureDiagnostics,
  ): Promise<string> {
    const selected = diagnostics?.device === null
      ? undefined
      : await this.resolveMacOsSelectedInputDevice();

    if (selected !== undefined) {
      return `:${selected.index}`;
    }

    console.warn('[mic] no named macOS audio input detected, falling back to avfoundation :0');
    return ':0';
  }

  private pickPreferredMacOsDevice(
    devices: Array<{ index: string; name: string }>,
  ): { index: string; name: string } | undefined {
    const matchByName = (pattern: RegExp): { index: string; name: string } | undefined =>
      devices.find((device) => pattern.test(device.name));

    return matchByName(/MacBook.*Microphone/i)
      ?? matchByName(/built-?in.*microphone/i)
      ?? matchByName(/microphone/i)
      ?? devices[0];
  }

  private listMacOsAudioDevices(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess;

      try {
        child = spawn('ffmpeg', [
          '-f', 'avfoundation',
          '-list_devices', 'true',
          '-i', '',
        ], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (error: unknown) {
        reject(
          error instanceof Error
            ? error
            : new Error('Failed to enumerate macOS audio devices with ffmpeg'),
        );
        return;
      }

      const stderrChunks: Buffer[] = [];

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      child.on('error', (err: Error) => {
        reject(new Error(`Failed to enumerate macOS audio devices: ${err.message}`));
      });

      child.on('close', () => {
        resolve(Buffer.concat(stderrChunks).toString('utf8'));
      });
    });
  }

  private async buildCaptureDiagnostics(): Promise<MicrophoneCaptureDiagnostics> {
    const backendPath = resolveCommandPath(this.recordProgram);
    const selectedInput = process.platform === 'darwin'
      ? await this.resolveMacOsSelectedInputDevice()
      : undefined;
    const defaultInputDeviceName = process.platform === 'darwin'
      ? this.readMacOsDefaultInputDeviceName()
      : null;

    return {
      backend: this.recordProgram,
      backendPath,
      backendAvailable: backendPath !== null,
      command: null,
      args: [],
      inputSource: null,
      requestedSampleRateHertz: this.sampleRateHertz,
      requestedChannels: this.channels,
      outputFormat: null,
      outputTransport: null,
      debugMode: this.debugMode,
      device: selectedInput?.name ?? 'default',
      defaultInputDeviceName,
      availableInputDevices: selectedInput?.availableInputDevices ?? [],
      usingDefaultDevice: selectedInput === undefined || defaultInputDeviceName === null
        ? true
        : selectedInput.name === defaultInputDeviceName,
      bytesCaptured: null,
      captureEndedBy: 'unknown',
      endOfTurnReason: 'unknown',
      firstNonEmptyChunkReceived: false,
      endedBeforeFirstChunk: false,
      vadRequestCount: 0,
      vadSpeechChunkCount: 0,
      vadSilenceChunkCount: 0,
      vadDroppedChunkCount: 0,
      vadSpeechMs: 0,
      vadSilenceMs: 0,
      speechStarted: false,
      silenceDetected: false,
      speechThresholdMs: DEFAULT_SPEECH_THRESHOLD_MS,
      silenceThresholdMs: this.silenceThresholdMs,
      minAutoStopCaptureMs: MIN_AUTO_STOP_CAPTURE_MS,
      micGainDb: this.gainDb,
      lastChunkRmsLevel: null,
      avgChunkRmsLevel: null,
      maxChunkRmsLevel: null,
      captureAborted: false,
      lastCaptureError: null,
      likelyFailureCause: null,
    };
  }

  private buildFallbackDiagnostics(): MicrophoneCaptureDiagnostics {
    const backendPath = resolveCommandPath(this.recordProgram);

    return {
      backend: this.recordProgram,
      backendPath,
      backendAvailable: backendPath !== null,
      command: null,
      args: [],
      inputSource: null,
      requestedSampleRateHertz: this.sampleRateHertz,
      requestedChannels: this.channels,
      outputFormat: null,
      outputTransport: null,
      debugMode: this.debugMode,
      device: 'default',
      defaultInputDeviceName: null,
      availableInputDevices: [],
      usingDefaultDevice: true,
      bytesCaptured: null,
      captureEndedBy: 'unknown',
      endOfTurnReason: 'unknown',
      firstNonEmptyChunkReceived: false,
      endedBeforeFirstChunk: false,
      vadRequestCount: 0,
      vadSpeechChunkCount: 0,
      vadSilenceChunkCount: 0,
      vadDroppedChunkCount: 0,
      vadSpeechMs: 0,
      vadSilenceMs: 0,
      speechStarted: false,
      silenceDetected: false,
      speechThresholdMs: DEFAULT_SPEECH_THRESHOLD_MS,
      silenceThresholdMs: this.silenceThresholdMs,
      minAutoStopCaptureMs: MIN_AUTO_STOP_CAPTURE_MS,
      micGainDb: this.gainDb,
      lastChunkRmsLevel: null,
      avgChunkRmsLevel: null,
      maxChunkRmsLevel: null,
      captureAborted: false,
      lastCaptureError: null,
      likelyFailureCause: null,
    };
  }

  private async resolveMacOsSelectedInputDevice(): Promise<{
    index: string;
    name: string;
    availableInputDevices: string[];
  } | undefined> {
    const devicesOutput = await this.listMacOsAudioDevices();
    const audioSection = devicesOutput.split('AVFoundation audio devices:')[1] ?? '';
    const devices = Array.from(audioSection.matchAll(/\[(\d+)\]\s+(.+)$/gm))
      .flatMap((match) => {
        const index = match[1];
        const name = match[2];

        if (index === undefined || name === undefined) {
          return [];
        }

        return [{
          index,
          name: name.trim(),
        }];
      });
    const selected = this.pickPreferredMacOsDevice(devices);

    if (selected === undefined) {
      return undefined;
    }

    return {
      ...selected,
      availableInputDevices: devices.map((device) => device.name),
    };
  }

  private readMacOsDefaultInputDeviceName(): string | null {
    if (process.platform !== 'darwin') {
      return null;
    }

    const result = spawnSync('system_profiler', ['SPAudioDataType'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const output = result.stdout?.trim();

    if (!output) {
      return null;
    }

    const lines = output.split(/\r?\n/u);
    let currentDeviceName: string | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      const deviceMatch = /^\s{8}([^:]+):\s*$/u.exec(rawLine);

      if (deviceMatch?.[1] !== undefined) {
        currentDeviceName = deviceMatch[1].trim();
        continue;
      }

      if (
        currentDeviceName !== null &&
        /Default Input Device:\s*Yes/iu.test(line)
      ) {
        return currentDeviceName;
      }
    }

    return null;
  }

  private toCaptureError(
    error: Error,
    diagnostics: MicrophoneCaptureDiagnostics,
  ): MicrophoneCaptureError {
    const nextDiagnostics: MicrophoneCaptureDiagnostics = {
      ...diagnostics,
      lastCaptureError: error.message,
      likelyFailureCause: inferLikelyFailureCause(error.message, diagnostics),
    };

    this.lastDiagnostics = nextDiagnostics;

    return new MicrophoneCaptureError(error.message, nextDiagnostics);
  }

  private async readCapturedFileSize(path: string): Promise<number | null> {
    try {
      return (await stat(path)).size;
    } catch {
      return null;
    }
  }

  private async cleanupFile(path: string): Promise<void> {
    try {
      await rm(path, { force: true });
    } catch {
      // best effort
    }
  }

  private wrapPcmAsWav(pcm: Buffer): Buffer {
    const bytesPerSample = 2;
    const byteRate = this.sampleRateHertz * this.channels * bytesPerSample;
    const blockAlign = this.channels * bytesPerSample;
    const header = Buffer.alloc(44);

    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(this.channels, 22);
    header.writeUInt32LE(this.sampleRateHertz, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(pcm.length, 40);

    return Buffer.concat([header, pcm]);
  }

  private withInvocation(
    diagnostics: MicrophoneCaptureDiagnostics,
    invocation: {
      command: string;
      args: string[];
      inputSource: string;
      outputFormat: string;
      outputTransport: string;
    },
  ): MicrophoneCaptureDiagnostics {
    return {
      ...diagnostics,
      command: invocation.command,
      args: [...invocation.args],
      inputSource: invocation.inputSource,
      outputFormat: invocation.outputFormat,
      outputTransport: invocation.outputTransport,
    };
  }

}

function resolveCommandPath(command: string): string | null {
  const result = spawnSync('which', [command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const value = result.stdout?.trim();

  return value && value.length > 0 ? value : null;
}

function applyPcm16Gain(chunk: Buffer, gainDb: number): Buffer {
  if (chunk.byteLength === 0 || gainDb === 0) {
    return chunk;
  }

  const multiplier = 10 ** (gainDb / 20);
  const amplified = Buffer.alloc(chunk.byteLength);
  const sampleBytes = chunk.byteLength - (chunk.byteLength % 2);

  for (let offset = 0; offset < sampleBytes; offset += 2) {
    const sample = chunk.readInt16LE(offset);
    const nextSample = Math.max(
      -32768,
      Math.min(32767, Math.round(sample * multiplier)),
    );

    amplified.writeInt16LE(nextSample, offset);
  }

  if (sampleBytes < chunk.byteLength) {
    amplified[chunk.byteLength - 1] = chunk[chunk.byteLength - 1] ?? 0;
  }

  return amplified;
}

function calculatePcm16DurationMs(
  chunk: Buffer,
  sampleRateHertz: number,
  channels: number,
): number {
  const bytesPerSecond = sampleRateHertz * channels * 2;

  if (bytesPerSecond <= 0) {
    return DEFAULT_VAD_POLL_MS;
  }

  return Math.max(1, Math.round((chunk.byteLength / bytesPerSecond) * 1000));
}

function inferLikelyFailureCause(
  message: string,
  diagnostics: MicrophoneCaptureDiagnostics,
): string {
  const normalized = message.toLowerCase();

  if (diagnostics.captureAborted || normalized.includes('aborted')) {
    return 'Capture was aborted before a usable microphone turn completed.';
  }

  if (
    diagnostics.captureEndedBy === 'max_timeout' &&
    diagnostics.endedBeforeFirstChunk
  ) {
    return 'Microphone capture hit the max timeout before the first non-empty audio chunk arrived.';
  }

  if (
    normalized.includes('permission') ||
    normalized.includes('not authorized') ||
    normalized.includes('operation not permitted') ||
    normalized.includes('input/output error')
  ) {
    return 'macOS likely blocked microphone access. Check System Settings > Privacy & Security > Microphone.';
  }

  if (normalized.includes('produced no audio') || normalized.includes('appears empty')) {
    return diagnostics.defaultInputDeviceName === null
      ? 'Recorder started but captured no usable input. Check microphone permissions and the active input device.'
      : `Recorder started but captured no usable input from "${diagnostics.device ?? 'default'}". Check macOS Sound > Input and microphone permissions.`;
  }

  if (!diagnostics.backendAvailable) {
    return `Recorder backend "${diagnostics.backend}" is not available on PATH.`;
  }

  return 'Microphone capture failed before usable audio was produced.';
}

function normalizeDebugMode(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized.length === 0) {
    return null;
  }

  if (normalized === 'direct-sox-file') {
    return 'direct-sox-file';
  }

  return normalized;
}

function mapCaptureEndedByToEndOfTurnReason(
  value: MicrophoneCaptureDiagnostics['captureEndedBy'],
): MicrophoneCaptureDiagnostics['endOfTurnReason'] {
  switch (value) {
    case 'silence':
      return 'silence';
    case 'max_timeout':
      return 'max_timeout';
    case 'manual':
      return 'manual';
    case 'abort':
      return 'interrupted';
    case 'unknown':
    default:
      return 'unknown';
  }
}

function calculatePcm16Rms(chunk: Buffer): number {
  if (chunk.byteLength < 2) {
    return 0;
  }

  let sampleCount = 0;
  let sumSquares = 0;

  for (let index = 0; index + 1 < chunk.byteLength; index += 2) {
    const sample = chunk.readInt16LE(index) / 32768;
    sumSquares += sample * sample;
    sampleCount += 1;
  }

  if (sampleCount === 0) {
    return 0;
  }

  return Number(Math.sqrt(sumSquares / sampleCount).toFixed(4));
}

function createStreamingSttDebugContext(): StreamingSttDebugContext {
  return {
    source: 'live-mic',
    streamBytesSent: 0,
    streamNonEmptyChunkCount: 0,
    captureEndedBy: 'unknown',
    firstNonEmptyChunkReceived: false,
    endedBeforeFirstChunk: false,
    sttRequestSkippedBecauseEmpty: false,
  };
}

function appendLogLines(lines: string[], raw: string): void {
  for (const line of raw.split(/\r?\n/u)) {
    const normalized = line.trim();

    if (normalized.length === 0) {
      continue;
    }

    lines.push(normalized);

    if (lines.length > 10) {
      lines.shift();
    }
  }
}

class BufferAsyncIterable implements AsyncIterable<Buffer> {
  private readonly chunks: Buffer[] = [];
  private readonly waiters: Array<() => void> = [];
  private completed = false;
  private failed: Error | undefined;

  public push(chunk: Buffer): void {
    if (this.completed || this.failed !== undefined || chunk.length === 0) {
      return;
    }

    this.chunks.push(chunk);
    this.flushWaiters();
  }

  public end(): void {
    if (this.completed || this.failed !== undefined) {
      return;
    }

    this.completed = true;
    this.flushWaiters();
  }

  public fail(error: Error): void {
    if (this.completed || this.failed !== undefined) {
      return;
    }

    this.failed = error;
    this.flushWaiters();
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
    while (true) {
      if (this.failed !== undefined) {
        throw this.failed;
      }

      const chunk = this.chunks.shift();

      if (chunk !== undefined) {
        yield chunk;
        continue;
      }

      if (this.completed) {
        return;
      }

      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }

  private flushWaiters(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();

      waiter?.();
    }
  }
}
