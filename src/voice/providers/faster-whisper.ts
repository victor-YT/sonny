import type { SttOptions, SttProvider, SttResult, SttSegment } from './stt.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000';
const DEFAULT_TRANSCRIBE_PATH = '/transcribe';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_AUDIO_FIELD_NAME = 'audio';
const DEFAULT_FILENAME = 'audio.wav';
const DEFAULT_MIME_TYPE = 'audio/wav';

interface FasterWhisperResponse {
  text: string;
  language?: string;
  confidence?: number;
  segments?: SttSegment[];
}

export interface FasterWhisperConfig {
  baseUrl?: string;
  transcribePath?: string;
  timeoutMs?: number;
  audioFieldName?: string;
  filename?: string;
  mimeType?: string;
  headers?: Record<string, string>;
}

export class FasterWhisperProvider implements SttProvider {
  public readonly name = 'faster-whisper';
  public readonly supportsStreaming = false;

  private readonly baseUrl: string;
  private readonly transcribePath: string;
  private readonly timeoutMs: number;
  private readonly audioFieldName: string;
  private readonly filename: string;
  private readonly mimeType: string;
  private readonly headers: Record<string, string>;

  public constructor(config: FasterWhisperConfig = {}) {
    this.baseUrl = this.normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.transcribePath = this.normalizePath(
      config.transcribePath ?? DEFAULT_TRANSCRIBE_PATH,
    );
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.audioFieldName = config.audioFieldName ?? DEFAULT_AUDIO_FIELD_NAME;
    this.filename = config.filename ?? DEFAULT_FILENAME;
    this.mimeType = config.mimeType ?? DEFAULT_MIME_TYPE;
    this.headers = config.headers ?? {};
  }

  public async transcribe(
    audio: Buffer,
    options: SttOptions = {},
  ): Promise<SttResult> {
    const formData = new FormData();
    const audioBlob = new Blob([new Uint8Array(audio)], { type: this.mimeType });

    formData.set(this.audioFieldName, audioBlob, this.filename);

    if (options.language !== undefined) {
      formData.set('language', options.language);
    }

    if (options.prompt !== undefined) {
      formData.set('prompt', options.prompt);
    }

    const response = await this.fetchWithTimeout(
      `${this.baseUrl}${this.transcribePath}`,
      {
        method: 'POST',
        headers: this.headers,
        body: formData,
      },
    );

    if (!response.ok) {
      throw new Error(await this.buildHttpError(response, 'faster-whisper'));
    }

    const result = await this.parseResponse(response);

    return {
      text: result.text,
      language: result.language,
      confidence: result.confidence,
      segments: result.segments,
    };
  }

  private normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '');
  }

  private normalizePath(path: string): string {
    return path.startsWith('/') ? path : `/${path}`;
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
        throw new Error(
          `faster-whisper request timed out after ${this.timeoutMs}ms`,
        );
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async buildHttpError(
    response: Response,
    providerName: string,
  ): Promise<string> {
    const errorBody = (await response.text()).trim();
    const detail = errorBody.length > 0 ? `: ${errorBody}` : '';

    return `${providerName} request failed with status ${response.status} ${response.statusText}${detail}`;
  }

  private async parseResponse(
    response: Response,
  ): Promise<FasterWhisperResponse> {
    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
      const payload: unknown = await response.json();

      return this.parseJsonPayload(payload);
    }

    const text = (await response.text()).trim();

    if (text.length === 0) {
      throw new Error('faster-whisper response did not include transcribed text');
    }

    return { text };
  }

  private parseJsonPayload(payload: unknown): FasterWhisperResponse {
    if (!this.isRecord(payload)) {
      throw new Error('faster-whisper response payload must be an object');
    }

    const text = payload.text;

    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('faster-whisper response payload is missing a text field');
    }

    const language = this.readOptionalString(payload.language);
    const confidence = this.readOptionalNumber(payload.confidence);
    const segments = this.parseSegments(payload.segments);

    return {
      text,
      language,
      confidence,
      segments,
    };
  }

  private parseSegments(payload: unknown): SttSegment[] | undefined {
    if (payload === undefined) {
      return undefined;
    }

    if (!Array.isArray(payload)) {
      throw new Error('faster-whisper response segments must be an array');
    }

    return payload.map((segment, index) => {
      if (!this.isRecord(segment)) {
        throw new Error(`faster-whisper segment at index ${index} must be an object`);
      }

      const text = segment.text;
      const start = segment.start;
      const end = segment.end;

      if (typeof text !== 'string') {
        throw new Error(`faster-whisper segment at index ${index} is missing text`);
      }

      if (typeof start !== 'number' || typeof end !== 'number') {
        throw new Error(
          `faster-whisper segment at index ${index} must include numeric start and end`,
        );
      }

      return {
        text,
        start,
        end,
      };
    });
  }

  private readOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private readOptionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
