import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

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
    const audioPromise = this.recordWithSox(maxSeconds);

    return { audioPromise };
  }

  private recordWithSox(maxSeconds: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      let child: ChildProcess;

      try {
        child = spawn(this.recordProgram, [
          '-d',                       // default audio input
          '-r', String(this.sampleRateHertz),
          '-c', String(this.channels),
          '-b', '16',                 // 16-bit samples
          '-e', 'signed-integer',
          '-t', 'wav',                // WAV output format
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

        const wav = Buffer.concat(chunks);

        if (code !== null && code !== 0) {
          console.warn(`[mic] sox exited with code ${code}, returning captured audio.`);
        }

        finish(wav);
      });
    });
  }
}
