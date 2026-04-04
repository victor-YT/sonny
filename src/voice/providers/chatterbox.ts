import type { TtsOptions, TtsProvider } from './tts.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8001';
const DEFAULT_SYNTHESIZE_PATH = '/synthesize';
const DEFAULT_STREAM_PATH = '/synthesize/stream';
const DEFAULT_TIMEOUT_MS = 120_000;

interface ChatterboxJsonResponse {
  audio: string;
}

export interface ChatterboxConfig {
  baseUrl?: string;
  synthesizePath?: string;
  streamPath?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export class ChatterboxProvider implements TtsProvider {
  public readonly name = 'chatterbox';
  public readonly supportsStreaming = true;

  private readonly baseUrl: string;
  private readonly synthesizePath: string;
  private readonly streamPath: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  public constructor(config: ChatterboxConfig = {}) {
    this.baseUrl = this.normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.synthesizePath = this.normalizePath(
      config.synthesizePath ?? DEFAULT_SYNTHESIZE_PATH,
    );
    this.streamPath = this.normalizePath(config.streamPath ?? DEFAULT_STREAM_PATH);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.headers = config.headers ?? {};
  }

  public async synthesize(
    text: string,
    options: TtsOptions = {},
  ): Promise<Buffer> {
    const response = await this.request(this.synthesizePath, text, options, false);

    if (!response.ok) {
      throw new Error(await this.buildHttpError(response));
    }

    return this.readAudioResponse(response);
  }

  public async *streamSynthesize(
    text: string,
    options: TtsOptions = {},
  ): AsyncIterable<Buffer> {
    const response = await this.request(this.streamPath, text, options, true);

    if (!response.ok) {
      throw new Error(await this.buildHttpError(response));
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
      yield await this.readAudioResponse(response);
      return;
    }

    if (response.body === null) {
      yield await this.readAudioResponse(response);
      return;
    }

    const reader = response.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        if (value !== undefined && value.byteLength > 0) {
          yield Buffer.from(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
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
    stream: boolean,
  ): Promise<Response> {
    return this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify(this.buildPayload(text, options, stream)),
    });
  }

  private buildPayload(
    text: string,
    options: TtsOptions,
    stream: boolean,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      text,
      stream,
    };

    if (options.voice !== undefined) {
      payload.voice = options.voice;
    }

    if (options.speed !== undefined) {
      payload.speed = options.speed;
    }

    if (options.emotion !== undefined) {
      payload.emotion = options.emotion;
    }

    return payload;
  }

  private async fetchWithTimeout(
    input: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      return await fetch(input, {
        ...init,
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.name === 'AbortError'
      ) {
        throw new Error(`Chatterbox request timed out after ${this.timeoutMs}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async buildHttpError(response: Response): Promise<string> {
    const errorBody = (await response.text()).trim();
    const detail = errorBody.length > 0 ? `: ${errorBody}` : '';

    return `Chatterbox request failed with status ${response.status} ${response.statusText}${detail}`;
  }

  private async readAudioResponse(response: Response): Promise<Buffer> {
    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
      const payload: unknown = await response.json();
      const data = this.parseJsonPayload(payload);

      return Buffer.from(data.audio, 'base64');
    }

    const audioBuffer = await response.arrayBuffer();

    return Buffer.from(audioBuffer);
  }

  private parseJsonPayload(payload: unknown): ChatterboxJsonResponse {
    if (!this.isRecord(payload)) {
      throw new Error('Chatterbox response payload must be an object');
    }

    const audioValue = this.readAudioField(payload);

    if (audioValue === undefined || audioValue.length === 0) {
      throw new Error('Chatterbox response payload is missing audio data');
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
