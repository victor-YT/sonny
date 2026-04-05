import { setTimeout as delay } from 'node:timers/promises';

import type { VoiceCaptureResult } from './voice-manager.js';

const NODE_RECORD_LPCM16_MODULE = 'node-record-lpcm16';
const DEFAULT_SAMPLE_RATE_HERTZ = 16_000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_THRESHOLD = 0;
const DEFAULT_SILENCE_SECONDS = 1;
const DEFAULT_MAX_CAPTURE_MS = 15_000;
const DEFAULT_RECORD_PROGRAM = 'sox';
const PCM_BITS_PER_SAMPLE = 16;
const WAV_PCM_FORMAT = 1;
const WAV_HEADER_BYTES = 44;

interface RecorderOptions {
  sampleRate: number;
  channels: number;
  audioType: string;
  recorder: string;
  threshold: number;
  thresholdStart: number;
  thresholdStop: number;
  silence: string;
  verbose: boolean;
}

interface RecorderRuntime {
  stream(): NodeJS.ReadableStream;
  stop?(): void;
}

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
  private readonly threshold: number;
  private readonly silenceSeconds: number;
  private readonly maxCaptureMs: number;
  private readonly recordProgram: string;
  private readonly readyDelayMs: number;

  public constructor(config: MicrophoneConfig = {}) {
    this.sampleRateHertz = config.sampleRateHertz ?? DEFAULT_SAMPLE_RATE_HERTZ;
    this.channels = config.channels ?? DEFAULT_CHANNELS;
    this.threshold = config.threshold ?? DEFAULT_THRESHOLD;
    this.silenceSeconds = config.silenceSeconds ?? DEFAULT_SILENCE_SECONDS;
    this.maxCaptureMs = config.maxCaptureMs ?? DEFAULT_MAX_CAPTURE_MS;
    this.recordProgram = config.recordProgram ?? DEFAULT_RECORD_PROGRAM;
    this.readyDelayMs = config.readyDelayMs ?? 100;
  }

  public async capture(): Promise<VoiceCaptureResult> {
    let recorder: RecorderRuntime;

    try {
      recorder = await this.createRecorder();
    } catch (error: unknown) {
      throw this.toError(error, 'Failed to initialize microphone recorder');
    }

    let source: NodeJS.ReadableStream;

    try {
      source = recorder.stream();
    } catch (error: unknown) {
      throw this.toError(error, 'Failed to start microphone recording stream');
    }

    const audioStream = new BufferAsyncIterable();
    const pcmChunks: Buffer[] = [];
    let resolveAudio: ((audio: Buffer) => void) | undefined;
    let rejectAudio: ((error: Error) => void) | undefined;
    const audioPromise = new Promise<Buffer>((resolve, reject) => {
      resolveAudio = resolve;
      rejectAudio = reject;
    });
    let settled = false;

    const stopRecorder = (): void => {
      try {
        recorder.stop?.();
      } catch {
        return;
      }
    };

    const finalizeSuccess = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      audioStream.end();
      resolveAudio?.(this.wrapPcmAsWav(Buffer.concat(pcmChunks)));
    };

    const finalizeError = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      const microphoneError = this.toError(error, 'Microphone capture failed');

      audioStream.fail(microphoneError);
      rejectAudio?.(microphoneError);
      stopRecorder();
    };

    source.on('data', (chunk: unknown) => {
      try {
        const audioChunk = this.toBuffer(chunk);

        if (audioChunk.length === 0) {
          return;
        }

        pcmChunks.push(audioChunk);
        audioStream.push(audioChunk);
      } catch (error: unknown) {
        finalizeError(error);
      }
    });

    source.once('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const isNullExitCode = message.includes('error code null');

      if (isNullExitCode && pcmChunks.length > 0) {
        console.warn('Microphone: sox exited with null error code, finalizing with captured audio.');
        finalizeSuccess();
        return;
      }

      if (isNullExitCode) {
        console.warn('Microphone: sox exited with null error code before capturing audio.');
        finalizeSuccess();
        return;
      }

      console.error('Microphone: recording stream error:', message);
      finalizeError(error);
    });

    source.once('end', () => {
      finalizeSuccess();
    });

    source.once('close', () => {
      finalizeSuccess();
    });

    void delay(this.maxCaptureMs).then(() => {
      if (!settled) {
        stopRecorder();
      }
    });

    if (this.readyDelayMs > 0) {
      await delay(this.readyDelayMs);
    }

    return {
      audioStream,
      audioPromise,
    };
  }

  private async createRecorder(): Promise<RecorderRuntime> {
    const module = await this.loadModule(NODE_RECORD_LPCM16_MODULE);
    const container = this.resolveExportContainer(module);
    const options: RecorderOptions = {
      sampleRate: this.sampleRateHertz,
      channels: this.channels,
      audioType: 'wav',
      recorder: this.recordProgram,
      threshold: this.threshold,
      thresholdStart: 0.5,
      thresholdStop: 0.5,
      silence: this.silenceSeconds.toFixed(1),
      verbose: false,
    };
    const candidates = [
      this.readFactory(container, 'record'),
      this.readFactory(container, 'start'),
    ];

    for (const candidate of candidates) {
      if (candidate === undefined) {
        continue;
      }

      const created = await candidate(options);

      return this.assertRecorderRuntime(created);
    }

    if (typeof module === 'function') {
      const created = await module(options);

      return this.assertRecorderRuntime(created);
    }

    throw new Error(
      'Unable to initialize node-record-lpcm16. Expected record() or start() export.',
    );
  }

  private async loadModule(specifier: string): Promise<unknown> {
    const dynamicImport = new Function(
      'moduleSpecifier',
      'return import(moduleSpecifier);',
    ) as (moduleSpecifier: string) => Promise<unknown>;

    try {
      return await dynamicImport(specifier);
    } catch (error: unknown) {
      throw this.toError(
        error,
        `Missing runtime dependency ${specifier}. Install it before enabling voice capture.`,
      );
    }
  }

  private resolveExportContainer(module: unknown): Record<string, unknown> {
    if (!this.isRecord(module)) {
      throw new Error('Dynamic module export must be an object');
    }

    const defaultExport = module.default;

    if (this.isRecord(defaultExport)) {
      return defaultExport;
    }

    return module;
  }

  private readFactory(
    container: Record<string, unknown>,
    property: string,
  ): ((options: RecorderOptions) => unknown | Promise<unknown>) | undefined {
    const value = container[property];

    return typeof value === 'function'
      ? (value as (options: RecorderOptions) => unknown | Promise<unknown>)
      : undefined;
  }

  private assertRecorderRuntime(value: unknown): RecorderRuntime {
    if (this.isReadableStream(value)) {
      return {
        stream: () => value,
      };
    }

    if (!this.isRecord(value)) {
      throw new Error('Microphone recorder must be an object or readable stream');
    }

    if (typeof value.stream !== 'function') {
      throw new Error('Microphone recorder is missing stream()');
    }

    const stream = value.stream as () => NodeJS.ReadableStream;
    const stop =
      typeof value.stop === 'function' ? value.stop.bind(value) as () => void : undefined;

    return {
      stream,
      stop,
    };
  }

  private isReadableStream(value: unknown): value is NodeJS.ReadableStream {
    return (
      this.isRecord(value) &&
      typeof value.on === 'function' &&
      typeof value.once === 'function'
    );
  }

  private toBuffer(chunk: unknown): Buffer {
    if (Buffer.isBuffer(chunk)) {
      return chunk;
    }

    if (chunk instanceof Uint8Array) {
      return Buffer.from(chunk);
    }

    if (typeof chunk === 'string') {
      return Buffer.from(chunk);
    }

    throw new Error('Microphone recorder emitted an unsupported chunk type');
  }

  private wrapPcmAsWav(pcm: Buffer): Buffer {
    const bytesPerSample = PCM_BITS_PER_SAMPLE / 8;
    const blockAlign = this.channels * bytesPerSample;
    const byteRate = this.sampleRateHertz * blockAlign;
    const wav = Buffer.allocUnsafe(WAV_HEADER_BYTES + pcm.length);

    wav.write('RIFF', 0, 4, 'ascii');
    wav.writeUInt32LE(36 + pcm.length, 4);
    wav.write('WAVE', 8, 4, 'ascii');
    wav.write('fmt ', 12, 4, 'ascii');
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(WAV_PCM_FORMAT, 20);
    wav.writeUInt16LE(this.channels, 22);
    wav.writeUInt32LE(this.sampleRateHertz, 24);
    wav.writeUInt32LE(byteRate, 28);
    wav.writeUInt16LE(blockAlign, 32);
    wav.writeUInt16LE(PCM_BITS_PER_SAMPLE, 34);
    wav.write('data', 36, 4, 'ascii');
    wav.writeUInt32LE(pcm.length, 40);
    pcm.copy(wav, WAV_HEADER_BYTES);

    return wav;
  }

  private toError(error: unknown, fallbackMessage: string): Error {
    if (error instanceof Error) {
      return error;
    }

    return new Error(fallbackMessage);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}

class BufferAsyncIterable implements AsyncIterable<Buffer> {
  private readonly queue: Buffer[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<Buffer>) => void;
    reject: (error: Error) => void;
  }> = [];

  private ended = false;
  private failure: Error | undefined;

  public push(chunk: Buffer): void {
    if (this.ended || this.failure !== undefined) {
      return;
    }

    const waiter = this.waiters.shift();

    if (waiter !== undefined) {
      waiter.resolve({
        done: false,
        value: chunk,
      });
      return;
    }

    this.queue.push(chunk);
  }

  public end(): void {
    if (this.ended || this.failure !== undefined) {
      return;
    }

    this.ended = true;

    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();

      waiter?.resolve({
        done: true,
        value: undefined,
      });
    }
  }

  public fail(error: Error): void {
    if (this.failure !== undefined || this.ended) {
      return;
    }

    this.failure = error;

    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();

      waiter?.reject(error);
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    return {
      next: async (): Promise<IteratorResult<Buffer>> => {
        if (this.failure !== undefined) {
          throw this.failure;
        }

        const chunk = this.queue.shift();

        if (chunk !== undefined) {
          return {
            done: false,
            value: chunk,
          };
        }

        if (this.ended) {
          return {
            done: true,
            value: undefined,
          };
        }

        return new Promise<IteratorResult<Buffer>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}
