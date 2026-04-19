import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { TimingTracker } from '../core/timing.js';
import type { VoiceCaptureResult } from './voice-manager.js';

const DEFAULT_SAMPLE_RATE_HERTZ = 16_000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_MAX_CAPTURE_MS = 8_000;
const DEFAULT_RECORD_PROGRAM = process.platform === 'darwin' ? 'ffmpeg' : 'sox';
const DEFAULT_VAD_URL = 'http://127.0.0.1:8003';
const DEFAULT_VAD_POLL_MS = 100;
const DEFAULT_SPEECH_THRESHOLD_MS = 500;
const DEFAULT_SILENCE_THRESHOLD_MS = 800;
const MIN_CAPTURE_BYTES = 10_240;

export interface MicrophoneCaptureOptions {
  signal?: AbortSignal;
  onSilenceDetected?: () => void;
}

export interface MicrophoneConfig {
  sampleRateHertz?: number;
  channels?: number;
  threshold?: number;
  silenceSeconds?: number;
  maxCaptureMs?: number;
  recordProgram?: string;
  readyDelayMs?: number;
  vadUrl?: string;
}

export class Microphone {
  private readonly sampleRateHertz: number;
  private readonly channels: number;
  private readonly maxCaptureMs: number;
  private readonly recordProgram: string;
  private readonly vadUrl: string;
  private readonly silenceThresholdMs: number;

  public constructor(config: MicrophoneConfig = {}) {
    this.sampleRateHertz = config.sampleRateHertz ?? DEFAULT_SAMPLE_RATE_HERTZ;
    this.channels = config.channels ?? DEFAULT_CHANNELS;
    this.maxCaptureMs = config.maxCaptureMs ?? DEFAULT_MAX_CAPTURE_MS;
    this.recordProgram = config.recordProgram ?? DEFAULT_RECORD_PROGRAM;
    this.vadUrl = config.vadUrl ?? DEFAULT_VAD_URL;
    this.silenceThresholdMs = Math.max(
      DEFAULT_VAD_POLL_MS,
      Math.round((config.silenceSeconds ?? DEFAULT_SILENCE_THRESHOLD_MS / 1000) * 1000),
    );
  }

  public async capture(options: MicrophoneCaptureOptions = {}): Promise<VoiceCaptureResult> {
    const timingTracker = new TimingTracker();
    timingTracker.start('vad_detection');

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
    const audioPromise = this.recordWithVad(audioStream, timingTracker, options);

    return {
      audioStream,
      audioPromise,
      timingTracker,
      sttOptions: {
        sampleRateHertz: this.sampleRateHertz,
        channels: this.channels,
        encoding: 'pcm_s16le',
        timingTracker,
      },
    };
  }

  private shouldUseFfmpeg(): boolean {
    return process.platform === 'darwin' && this.recordProgram === 'ffmpeg';
  }

  private async recordWithFfmpeg(
    timingTracker: TimingTracker,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const input = await this.resolveMacOsAudioInput();
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

    return new Promise<Buffer>((resolve, reject) => {
      let child: ChildProcess;

      try {
        child = spawn(this.recordProgram, args, {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (error: unknown) {
        reject(
          error instanceof Error
            ? error
            : new Error('Failed to spawn ffmpeg recording process'),
        );
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
        reject(new Error(`Failed to start ffmpeg: ${err.message}`));
      });

      child.on('close', async (code: number | null) => {
        signal?.removeEventListener('abort', handleAbort);

        if (signal?.aborted) {
          await this.cleanupFile(outputPath);
          reject(new Error('Microphone capture aborted'));
          return;
        }

        if (code !== null && code !== 0) {
          await this.cleanupFile(outputPath);
          reject(new Error(
            `ffmpeg exited with code ${code}: ${stderrLines.join(' | ') || 'unknown error'}`,
          ));
          return;
        }

        try {
          const fileStat = await stat(outputPath);

          if (fileStat.size <= 0) {
            throw new Error('[mic] ffmpeg recorded an empty audio file');
          }

          const wav = await readFile(outputPath);
          const validated = this.finalizeRecordedWav(wav, 'ffmpeg');
          timingTracker.end('vad_detection');
          resolve(validated);
        } catch (error: unknown) {
          reject(error instanceof Error ? error : new Error(String(error)));
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
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      let child: ChildProcess;

      try {
        child = spawn(this.recordProgram, [
          '-d',
          '-r', String(this.sampleRateHertz),
          '-c', String(this.channels),
          '-b', '16',
          '-e', 'signed-integer',
          '-t', 'raw',
          '-',
        ], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error: unknown) {
        reject(
          error instanceof Error
            ? error
            : new Error('Failed to spawn sox recording process'),
        );
        return;
      }

      this.consumeRecordingProcess({
        child,
        audioStream,
        sourceName: 'sox',
        timingTracker,
        options,
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
    resolve: (value: Buffer) => void;
    reject: (reason?: unknown) => void;
  }): void {
    const {
      child,
      audioStream,
      sourceName,
      timingTracker,
      options,
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

    const stopRecording = (): void => {
      if (settled) {
        return;
      }

      try {
        audioStream.end();
        const wav = this.finalizeCapture(Buffer.concat(allChunks), sourceName);
        timingTracker.end('vad_detection');
        killChild();
        finish(wav);
      } catch (error: unknown) {
        killChild();
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const maxTimeout = setTimeout(() => {
      if (!settled) {
        console.warn('[mic] max capture timeout reached, stopping capture');
        stopRecording();
      }
    }, this.maxCaptureMs + 1000);

    const handleAbort = (): void => {
      clearTimeout(maxTimeout);
      killChild();
      finish(new Error('Microphone capture aborted'));
    };

    options.signal?.addEventListener('abort', handleAbort, { once: true });

    const checkVad = async (pcmChunk: Buffer): Promise<void> => {
      if (vadBusy || settled) {
        return;
      }

      vadBusy = true;

      try {
        const response = await fetch(vadUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: new Uint8Array(pcmChunk),
        });

        if (!response.ok) {
          vadBusy = false;
          return;
        }

        const result = await response.json() as { speech: boolean };

        if (result.speech) {
          speechMs += DEFAULT_VAD_POLL_MS;
          silenceMs = 0;

          if (speechMs >= DEFAULT_SPEECH_THRESHOLD_MS) {
            speechStarted = true;
          }
        } else if (speechStarted) {
          silenceMs += DEFAULT_VAD_POLL_MS;

          if (silenceMs >= this.silenceThresholdMs) {
            if (!silenceDetected) {
              silenceDetected = true;
              options.onSilenceDetected?.();
            }
            stopRecording();
          }
        }
      } catch {
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

        allChunks.push(chunk);
        audioStream.push(chunk);

        pendingVadChunk = Buffer.concat([pendingVadChunk, chunk]);
        const bytesPerPoll = 2 * this.sampleRateHertz * DEFAULT_VAD_POLL_MS / 1000;

        if (pendingVadChunk.length >= bytesPerPoll) {
          const vadChunk = pendingVadChunk;
          pendingVadChunk = Buffer.alloc(0);
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
      finish(new Error(`Failed to start ${sourceName}: ${err.message}`));
    });

    child.on('close', (code: number | null) => {
      clearTimeout(maxTimeout);
      options.signal?.removeEventListener('abort', handleAbort);

      if (settled) {
        return;
      }

      if (allChunks.length === 0) {
        finish(new Error(`${sourceName} exited with code ${code} and produced no audio`));
        return;
      }

      let wav: Buffer;

      try {
        audioStream.end();
        wav = this.finalizeCapture(Buffer.concat(allChunks), sourceName);
      } catch (error: unknown) {
        finish(error instanceof Error ? error : new Error(String(error)));
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

  private async resolveMacOsAudioInput(): Promise<string> {
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
