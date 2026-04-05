import { spawn, type ChildProcess } from 'node:child_process';

import type { VoiceCaptureResult } from './voice-manager.js';

const DEFAULT_SAMPLE_RATE_HERTZ = 16_000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_MAX_CAPTURE_MS = 15_000;
const DEFAULT_RECORD_PROGRAM = 'sox';
const DEFAULT_SILENCE_SECONDS = 1;

export interface MicrophoneConfig {
  sampleRateHertz?: number;
  channels?: number;
  threshold?: number;
  silenceSeconds?: number;
  maxCaptureMs?: number;
  recordProgram?: string;
  readyDelayMs?: number;
}

export class Microphone {
  private readonly sampleRateHertz: number;
  private readonly channels: number;
  private readonly silenceSeconds: number;
  private readonly maxCaptureMs: number;
  private readonly recordProgram: string;

  public constructor(config: MicrophoneConfig = {}) {
    this.sampleRateHertz = config.sampleRateHertz ?? DEFAULT_SAMPLE_RATE_HERTZ;
    this.channels = config.channels ?? DEFAULT_CHANNELS;
    this.silenceSeconds = config.silenceSeconds ?? DEFAULT_SILENCE_SECONDS;
    this.maxCaptureMs = config.maxCaptureMs ?? DEFAULT_MAX_CAPTURE_MS;
    this.recordProgram = config.recordProgram ?? DEFAULT_RECORD_PROGRAM;
  }

  public async capture(): Promise<VoiceCaptureResult> {
    const maxSeconds = Math.ceil(this.maxCaptureMs / 1000);
    const audioStream = new BufferAsyncIterable();
    const audioPromise = this.recordWithSox(maxSeconds, audioStream);

    return {
      audioStream,
      audioPromise,
      sttOptions: {
        sampleRateHertz: this.sampleRateHertz,
        channels: this.channels,
        encoding: 'pcm_s16le',
      },
    };
  }

  private recordWithSox(
    maxSeconds: number,
    audioStream: BufferAsyncIterable,
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      let child: ChildProcess;

      try {
        child = spawn(this.recordProgram, [
          '-d',                       // default audio input
          '-r', String(this.sampleRateHertz),
          '-c', String(this.channels),
          '-b', '16',                 // 16-bit samples
          '-e', 'signed-integer',
          '-t', 'raw',                // raw PCM for streaming STT
          '-',                        // write to stdout
          'trim', '0', String(maxSeconds),
          'silence', '1', '0.1', '1%',
          '1', this.silenceSeconds.toFixed(1), '1%',
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

      const chunks: Buffer[] = [];
      let settled = false;

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

      const killTimeout = setTimeout(() => {
        if (!settled) {
          try {
            child.kill('SIGTERM');
          } catch {
            // already exited
          }
        }
      }, this.maxCaptureMs + 2000);

      if (child.stdout !== null) {
        child.stdout.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          audioStream.push(chunk);
        });

        child.stdout.on('error', (err: Error) => {
          console.warn('[mic] sox stdout error:', err.message);
        });
      }

      if (child.stderr !== null) {
        child.stderr.on('data', (data: Buffer) => {
          const message = data.toString().trim();

          if (message.length > 0) {
            console.warn('[mic] sox:', message);
          }
        });
      }

      child.on('error', (err: Error) => {
        clearTimeout(killTimeout);
        finish(new Error(`Failed to start ${this.recordProgram}: ${err.message}`));
      });

      child.on('close', (code: number | null) => {
        clearTimeout(killTimeout);

        if (chunks.length === 0) {
          finish(new Error(`sox exited with code ${code} and produced no audio`));
          return;
        }

        audioStream.end();
        const wav = this.wrapPcmAsWav(Buffer.concat(chunks));

        if (code !== null && code !== 0) {
          console.warn(`[mic] sox exited with code ${code}, returning captured audio.`);
        }

        finish(wav);
      });
    });
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
