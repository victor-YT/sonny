import { logTtsDiag as logTtsDiagShared } from '../tts-diagnostics.js';
import type { TtsOptions, TtsProvider } from './tts.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8001';
const DEFAULT_SYNTHESIZE_PATH = '/synthesize';
const DEFAULT_STREAM_SYNTHESIZE_PATH = '/synthesize/stream';
const DEFAULT_WARMUP_PATH = '/warmup';
const DEFAULT_TIMEOUT_MS = 120_000;

function logTtsDiag(event: string, fields: Record<string, string | number>): void {
  logTtsDiagShared('tts-client', event, fields);
}

interface Qwen3TtsJsonResponse {
  audio: string;
}

export interface Qwen3TtsConfig {
  baseUrl?: string;
  synthesizePath?: string;
  warmupPath?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export class Qwen3TTSProvider implements TtsProvider {
  public readonly name = 'qwen3-tts';
  public readonly supportsStreaming = true;

  private readonly baseUrl: string;
  private readonly synthesizePath: string;
  private readonly streamSynthesizePath: string;
  private readonly warmupPath: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  public constructor(config: Qwen3TtsConfig = {}) {
    this.baseUrl = this.normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.synthesizePath = this.normalizePath(
      config.synthesizePath ?? DEFAULT_SYNTHESIZE_PATH,
    );
    this.streamSynthesizePath = this.normalizePath(
      DEFAULT_STREAM_SYNTHESIZE_PATH,
    );
    this.warmupPath = this.normalizePath(
      config.warmupPath ?? DEFAULT_WARMUP_PATH,
    );
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.headers = config.headers ?? {};
  }

  public async warmup(): Promise<void> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}${this.warmupPath}`, {
      method: 'POST',
      headers: {
        ...this.headers,
      },
    });

    if (!response.ok) {
      throw new Error(await this.buildHttpError(response));
    }

    await response.arrayBuffer();
  }

  public async synthesize(
    text: string,
    options: TtsOptions = {},
  ): Promise<Buffer> {
    options.timingTracker?.start('tts_synthesis');

    const requestStartedAt = Date.now();
    logTtsDiag('request_started', {
      text_len: text.length,
      voice: options.voice ?? 'default',
      mode: 'non-stream',
    });

    try {
      const response = await this.request(this.synthesizePath, text, options);
      logTtsDiag('headers_received', {
        t: Date.now() - requestStartedAt,
        status: response.status,
        mode: 'non-stream',
      });

      if (!response.ok) {
        throw new Error(await this.buildHttpError(response));
      }

      const audio = await this.readAudioResponse(response);
      logTtsDiag('full_response_received', {
        t: Date.now() - requestStartedAt,
        bytes: audio.byteLength,
        mode: 'non-stream',
      });

      return audio;
    } finally {
      options.timingTracker?.end('tts_synthesis');
    }
  }

  public async *synthesizeStream(
    text: string,
    options: TtsOptions = {},
  ): AsyncIterable<Buffer> {
    options.timingTracker?.start('tts_synthesis');

    const requestStartedAt = Date.now();
    logTtsDiag('request_started', {
      text_len: text.length,
      voice: options.voice ?? 'default',
    });

    let totalBytes = 0;
    let chunkCount = 0;
    let firstChunkLogged = false;

    try {
      const response = await this.request(this.streamSynthesizePath, text, options);
      logTtsDiag('headers_received', {
        t: Date.now() - requestStartedAt,
        status: response.status,
      });

      if (!response.ok) {
        throw new Error(await this.buildHttpError(response));
      }

      if (response.body === null) {
        throw new Error('Qwen3-TTS streaming response body was unavailable');
      }

      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);

        if (buffer.byteLength === 0) {
          continue;
        }

        if (!firstChunkLogged) {
          logTtsDiag('first_chunk_received', {
            t: Date.now() - requestStartedAt,
            bytes: buffer.byteLength,
          });
          firstChunkLogged = true;
        }

        totalBytes += buffer.byteLength;
        chunkCount += 1;
        yield buffer;
      }

      logTtsDiag('stream_done', {
        t: Date.now() - requestStartedAt,
        total_bytes: totalBytes,
        chunks: chunkCount,
      });
    } finally {
      options.timingTracker?.end('tts_synthesis');
    }
  }

  public streamSynthesize(
    text: string,
    options: TtsOptions = {},
  ): AsyncIterable<Buffer> {
    return this.synthesizeStream(text, options);
  }

  private normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '');
  }

  private normalizePath(path: string): string {
    return path.startsWith('/') ? path : `/${path}`;
  }

  private async request(
    path: string,
    text: string,
    options: TtsOptions,
  ): Promise<Response> {
    return this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify(this.buildPayload(text, options)),
      signal: options.signal,
    });
  }

  private buildPayload(
    text: string,
    options: TtsOptions,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      text,
    };

    if (options.voice !== undefined) {
      payload.speaker = options.voice;
      payload.voice = options.voice;
    }

    if (options.speed !== undefined) {
      payload.speed = options.speed;
    }

    if (options.emotion !== undefined) {
      payload.emotion = options.emotion;
    }

    if (options.exaggeration !== undefined) {
      payload.exaggeration = options.exaggeration;
    }

    return payload;
  }

  private async fetchWithTimeout(
    input: string,
    init: RequestInit,
  ): Promise<Response> {
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
      timeoutController.abort();
    }, this.timeoutMs);
    const requestSignal = init.signal ?? undefined;
    const signal = requestSignal === undefined
      ? timeoutController.signal
      : AbortSignal.any([requestSignal, timeoutController.signal]);

    try {
      return await fetch(input, {
        ...init,
        signal,
      });
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.name === 'AbortError' &&
        !timeoutController.signal.aborted
      ) {
        throw error;
      }

      if (
        error instanceof Error &&
        error.name === 'AbortError'
      ) {
        throw new Error(`Qwen3-TTS request timed out after ${this.timeoutMs}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async buildHttpError(response: Response): Promise<string> {
    const errorBody = (await response.text()).trim();
    const detail = errorBody.length > 0 ? `: ${errorBody}` : '';

    return `Qwen3-TTS request failed with status ${response.status} ${response.statusText}${detail}`;
  }

  private async readAudioResponse(response: Response): Promise<Buffer> {
    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
      const payload: unknown = await response.json();
      const data = this.parseJsonPayload(payload);
      const audio = Buffer.from(data.audio, 'base64');

      if (audio.byteLength === 0) {
        throw new Error('Qwen3-TTS response payload decoded to empty audio data');
      }

      return audio;
    }

    const audioBuffer = await response.arrayBuffer();
    const audio = Buffer.from(audioBuffer);

    if (audio.byteLength === 0) {
      throw new Error('Qwen3-TTS response body was empty');
    }

    return audio;
  }

  private parseJsonPayload(payload: unknown): Qwen3TtsJsonResponse {
    if (!this.isRecord(payload)) {
      throw new Error('Qwen3-TTS response payload must be an object');
    }

    const audioValue = this.readAudioField(payload);

    if (audioValue === undefined || audioValue.length === 0) {
      throw new Error('Qwen3-TTS response payload is missing audio data');
    }

    return {
      audio: audioValue,
    };
  }

  private readAudioField(payload: Record<string, unknown>): string | undefined {
    const candidateKeys = ['audio', 'audioBase64', 'audio_base64', 'data'];

    for (const key of candidateKeys) {
      const value = payload[key];

      if (typeof value === 'string') {
        return value;
      }
    }

    return undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}

export {
  Qwen3TTSProvider as ChatterboxProvider,
};

export type {
  Qwen3TtsConfig as ChatterboxConfig,
};
