import type {
  SttDebugInfo,
  SttFailureReason,
  SttOptions,
  SttProvider,
  SttResult,
  SttSegment,
} from './stt.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000';
const DEFAULT_TRANSCRIBE_PATH = '/transcribe';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_FILENAME = 'audio.wav';
const DEFAULT_MIME_TYPE = 'audio/wav';
const RAW_BODY_PREVIEW_LIMIT = 800;

interface FasterWhisperResponse {
  text: string;
  language?: string;
  confidence?: number;
  segments?: SttSegment[];
  final?: boolean;
}

export interface FasterWhisperConfig {
  baseUrl?: string;
  transcribePath?: string;
  timeoutMs?: number;
  filename?: string;
  mimeType?: string;
  headers?: Record<string, string>;
}

export class FasterWhisperProvider implements SttProvider {
  public readonly name = 'faster-whisper';
  public readonly supportsStreaming = true;

  private readonly baseUrl: string;
  private readonly transcribePath: string;
  private readonly timeoutMs: number;
  private readonly filename: string;
  private readonly mimeType: string;
  private readonly headers: Record<string, string>;

  private lastDebugInfo: SttDebugInfo | null = null;

  public constructor(config: FasterWhisperConfig = {}) {
    this.baseUrl = this.normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.transcribePath = this.normalizePath(
      config.transcribePath ?? DEFAULT_TRANSCRIBE_PATH,
    );
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.filename = config.filename ?? DEFAULT_FILENAME;
    this.mimeType = config.mimeType ?? DEFAULT_MIME_TYPE;
    this.headers = config.headers ?? {};
  }

  public getLastDebugInfo(): SttDebugInfo | null {
    return this.lastDebugInfo === null
      ? null
      : {
          ...this.lastDebugInfo,
          responseKeys: [...this.lastDebugInfo.responseKeys],
        };
  }

  public async transcribe(
    audio: Buffer,
    options: SttOptions = {},
  ): Promise<SttResult> {
    const requestUrl = `${this.baseUrl}${this.transcribePath}`;
    const response = await this.fetchWithTimeout(
      requestUrl,
      {
        method: 'POST',
        headers: this.buildHeaders(options),
        body: new Uint8Array(audio),
      },
    );

    if (!response.ok) {
      const debugInfo = await this.buildHttpErrorDebugInfo(response, requestUrl);
      const detail = debugInfo.rawBodyPreview === null ? '' : `: ${debugInfo.rawBodyPreview}`;

      this.lastDebugInfo = debugInfo;
      throw new Error(
        `stt_http_error: faster-whisper request failed with status ${response.status} ${response.statusText}${detail}`,
      );
    }

    const result = await this.parseResponse(response, requestUrl);

    this.lastDebugInfo = {
      requestUrl,
      httpStatus: response.status,
      contentType: response.headers.get('content-type') ?? '',
      rawBodyPreview: this.lastDebugInfo?.rawBodyPreview ?? null,
      responseKeys: this.lastDebugInfo?.responseKeys ?? [],
      transcript: result.text,
      transcriptLength: result.text.length,
      failureReason: null,
    };

    return {
      text: result.text,
      language: result.language,
      confidence: result.confidence,
      segments: result.segments,
    };
  }

  public async *streamTranscribe(
    audioStream: AsyncIterable<Buffer>,
    options: SttOptions = {},
  ): AsyncIterable<SttResult> {
    const requestUrl = `${this.baseUrl}${this.transcribePath}?stream=true`;
    const response = await this.fetchWithTimeout(
      requestUrl,
      {
        method: 'POST',
        headers: this.buildHeaders(options),
        body: this.toReadableStream(audioStream),
        duplex: 'half',
      },
    );

    if (!response.ok) {
      const debugInfo = await this.buildHttpErrorDebugInfo(response, requestUrl);
      const detail = debugInfo.rawBodyPreview === null ? '' : `: ${debugInfo.rawBodyPreview}`;

      this.lastDebugInfo = debugInfo;
      throw new Error(
        `stt_http_error: faster-whisper request failed with status ${response.status} ${response.statusText}${detail}`,
      );
    }

    if (response.body === null) {
      this.lastDebugInfo = {
        requestUrl,
        httpStatus: response.status,
        contentType: response.headers.get('content-type') ?? '',
        rawBodyPreview: null,
        responseKeys: [],
        transcript: null,
        transcriptLength: null,
        failureReason: 'stt_invalid_json',
      };
      throw new Error('stt_invalid_json: faster-whisper streaming response body is unavailable');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });

      while (true) {
        const newlineIndex = buffer.indexOf('\n');

        if (newlineIndex < 0) {
          break;
        }

        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line.length === 0) {
          continue;
        }

        const parsed = this.parseJsonText(line, requestUrl, response);
        const result = this.toSttResult(parsed);

        yield result;
      }
    }

    const trailing = `${buffer}${decoder.decode()}`.trim();

    if (trailing.length > 0) {
      const parsed = this.parseJsonText(trailing, requestUrl, response);

      yield this.toSttResult(parsed);
    }
  }

  private normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '');
  }

  private normalizePath(path: string): string {
    return path.startsWith('/') ? path : `/${path}`;
  }

  private async fetchWithTimeout(
    input: string,
    init: RequestInitWithDuplex,
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
          `stt_http_error: faster-whisper request timed out after ${this.timeoutMs}ms`,
        );
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private buildHeaders(options: SttOptions = {}): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': this.mimeType,
      'x-audio-filename': this.filename,
      ...this.headers,
    };

    if (options.language !== undefined) {
      headers['x-language'] = options.language;
    }

    if (options.prompt !== undefined) {
      headers['x-prompt'] = options.prompt;
    }

    if (options.sampleRateHertz !== undefined) {
      headers['x-sample-rate-hertz'] = options.sampleRateHertz.toString();
    }

    if (options.channels !== undefined) {
      headers['x-audio-channels'] = options.channels.toString();
    }

    if (options.encoding !== undefined) {
      headers['x-audio-encoding'] = options.encoding;
    }

    return headers;
  }

  private async buildHttpErrorDebugInfo(
    response: Response,
    requestUrl: string,
  ): Promise<SttDebugInfo> {
    const body = (await response.text()).trim();

    return {
      requestUrl,
      httpStatus: response.status,
      contentType: response.headers.get('content-type') ?? '',
      rawBodyPreview: truncateBody(body),
      responseKeys: [],
      transcript: null,
      transcriptLength: null,
      failureReason: 'stt_http_error',
    };
  }

  private async parseResponse(
    response: Response,
    requestUrl: string,
  ): Promise<FasterWhisperResponse> {
    const contentType = response.headers.get('content-type') ?? '';
    const rawBody = (await response.text()).trim();

    if (contentType.includes('application/json')) {
      return this.parseJsonText(rawBody, requestUrl, response);
    }

    if (rawBody.length === 0) {
      this.lastDebugInfo = {
        requestUrl,
        httpStatus: response.status,
        contentType,
        rawBodyPreview: null,
        responseKeys: [],
        transcript: null,
        transcriptLength: null,
        failureReason: 'stt_empty_transcript',
      };
      throw new Error('stt_empty_transcript: faster-whisper response did not include transcribed text');
    }

    this.lastDebugInfo = {
      requestUrl,
      httpStatus: response.status,
      contentType,
      rawBodyPreview: truncateBody(rawBody),
      responseKeys: [],
      transcript: rawBody,
      transcriptLength: rawBody.length,
      failureReason: null,
    };

    return { text: rawBody };
  }

  private parseJsonText(
    rawBody: string,
    requestUrl: string,
    response: Response,
  ): FasterWhisperResponse {
    let payload: unknown;

    try {
      payload = rawBody.length === 0 ? {} : JSON.parse(rawBody) as unknown;
    } catch (error: unknown) {
      this.lastDebugInfo = {
        requestUrl,
        httpStatus: response.status,
        contentType: response.headers.get('content-type') ?? '',
        rawBodyPreview: truncateBody(rawBody),
        responseKeys: [],
        transcript: null,
        transcriptLength: null,
        failureReason: 'stt_invalid_json',
      };
      throw new Error(
        `stt_invalid_json: faster-whisper returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return this.parseJsonPayload(
      payload,
      {
        requestUrl,
        httpStatus: response.status,
        contentType: response.headers.get('content-type') ?? '',
        rawBodyPreview: truncateBody(rawBody),
      },
    );
  }

  private parseJsonPayload(
    payload: unknown,
    baseDebug: Pick<SttDebugInfo, 'requestUrl' | 'httpStatus' | 'contentType' | 'rawBodyPreview'>,
  ): FasterWhisperResponse {
    if (!this.isRecord(payload)) {
      this.lastDebugInfo = {
        ...baseDebug,
        responseKeys: [],
        transcript: null,
        transcriptLength: null,
        failureReason: 'stt_unrecognized_payload_shape',
      };
      throw new Error('stt_unrecognized_payload_shape: faster-whisper response payload must be an object');
    }

    const responseKeys = Object.keys(payload);
    let segments: SttSegment[] | undefined;
    let transcript = '';

    try {
      segments = this.parseSegments(payload.segments);
      transcript = extractTranscriptFromWhisperPayload(payload, segments);
    } catch (error: unknown) {
      this.lastDebugInfo = {
        ...baseDebug,
        responseKeys,
        transcript: null,
        transcriptLength: null,
        failureReason: 'stt_unrecognized_payload_shape',
      };
      throw error;
    }

    this.lastDebugInfo = {
      ...baseDebug,
      responseKeys,
      transcript,
      transcriptLength: transcript.length,
      failureReason: transcript.length === 0 ? 'stt_empty_transcript' : null,
    };

    if (transcript.length === 0) {
      throw new Error(
        `stt_empty_transcript: faster-whisper returned an empty transcript. keys=${responseKeys.join(',') || '(none)'}`,
      );
    }

    const language = this.readOptionalString(payload.language);
    const confidence = this.readOptionalNumber(payload.confidence);

    return {
      text: transcript,
      language,
      confidence,
      segments,
    };
  }

  private toSttResult(result: FasterWhisperResponse): SttResult {
    return {
      text: result.text,
      language: result.language,
      confidence: result.confidence,
      segments: result.segments,
    };
  }

  private toReadableStream(
    audioStream: AsyncIterable<Buffer>,
  ): ReadableStream<Uint8Array> {
    const iterator = audioStream[Symbol.asyncIterator]();

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const nextChunk = await iterator.next();

        if (nextChunk.done) {
          controller.close();
          return;
        }

        controller.enqueue(new Uint8Array(nextChunk.value));
      },
      cancel: async () => {
        if (iterator.return !== undefined) {
          await iterator.return();
        }
      },
    });
  }

  private parseSegments(payload: unknown): SttSegment[] | undefined {
    if (payload === undefined) {
      return undefined;
    }

    if (!Array.isArray(payload)) {
      throw new Error('stt_unrecognized_payload_shape: faster-whisper response segments must be an array');
    }

    return payload.map((segment, index) => {
      if (!this.isRecord(segment)) {
        throw new Error(`stt_unrecognized_payload_shape: faster-whisper segment at index ${index} must be an object`);
      }

      const text = segment.text;
      const start = segment.start;
      const end = segment.end;

      if (typeof text !== 'string') {
        throw new Error(`stt_unrecognized_payload_shape: faster-whisper segment at index ${index} is missing text`);
      }

      if (typeof start !== 'number' || typeof end !== 'number') {
        throw new Error(
          `stt_unrecognized_payload_shape: faster-whisper segment at index ${index} must include numeric start and end`,
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

export function extractTranscriptFromWhisperPayload(
  payload: Record<string, unknown>,
  segments: SttSegment[] | undefined,
): string {
  const directText = readTrimmedString(payload.text);

  if (directText !== null) {
    return directText;
  }

  const transcript = readTrimmedString(payload.transcript);

  if (transcript !== null) {
    return transcript;
  }

  const nestedResult = payload.result;

  if (isRecord(nestedResult)) {
    const nestedText = readTrimmedString(nestedResult.text);

    if (nestedText !== null) {
      return nestedText;
    }
  }

  if (segments !== undefined) {
    return segments
      .map((segment) => segment.text.trim())
      .filter((value) => value.length > 0)
      .join(' ')
      .trim();
  }

  throw new Error(
    `stt_unrecognized_payload_shape: faster-whisper response did not include transcript fields. keys=${Object.keys(payload).join(',') || '(none)'}`,
  );
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return value.trim();
}

function truncateBody(value: string): string | null {
  if (value.length === 0) {
    return null;
  }

  return value.length <= RAW_BODY_PREVIEW_LIMIT
    ? value
    : `${value.slice(0, RAW_BODY_PREVIEW_LIMIT)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface RequestInitWithDuplex extends RequestInit {
  duplex?: 'half';
}
