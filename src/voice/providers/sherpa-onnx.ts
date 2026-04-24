import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';

import type {
  SttDebugInfo,
  SttOptions,
  SttProvider,
  SttResult,
} from './stt.js';

const require = createRequire(import.meta.url);
const DEFAULT_SAMPLE_RATE_HERTZ = 16_000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_FEATURE_DIM = 80;
const DEFAULT_PROVIDER = 'cpu';
const DEFAULT_NUM_THREADS = 2;
const DEFAULT_DECODING_METHOD = 'greedy_search';
const DEFAULT_MODEL_TYPE = 'auto';
const STREAM_TAIL_PADDING_SECONDS = 0.4;

export interface SherpaOnnxConfig {
  modelDir?: string;
  encoder?: string;
  decoder?: string;
  joiner?: string;
  tokens?: string;
  language?: string;
  modelType?: 'auto' | 'transducer' | 'paraformer';
  provider?: string;
  numThreads?: number;
  decodingMethod?: string;
}

interface SherpaOnnxModule {
  OnlineRecognizer: new (config: OnlineRecognizerConfig) => OnlineRecognizer;
  version?: string;
}

interface OnlineRecognizer {
  createStream(): OnlineStream;
  isReady(stream: OnlineStream): boolean;
  decode(stream: OnlineStream): void;
  getResult(stream: OnlineStream): OnlineRecognizerResult;
}

interface OnlineStream {
  acceptWaveform(input: {
    samples: Float32Array;
    sampleRate: number;
  }): void;
  inputFinished(): void;
}

interface OnlineRecognizerResult {
  text?: string;
  tokens?: string[];
  timestamps?: number[] | string;
  is_final?: boolean;
  is_eof?: boolean;
}

interface OnlineRecognizerConfig {
  featConfig: {
    sampleRate: number;
    featureDim: number;
  };
  modelConfig: {
    transducer?: {
      encoder?: string;
      decoder?: string;
      joiner?: string;
    };
    paraformer?: {
      encoder?: string;
      decoder?: string;
    };
    tokens: string;
    numThreads: number;
    provider: string;
    debug: boolean | number;
    modelType?: string;
  };
  decodingMethod: string;
  maxActivePaths: number;
  enableEndpoint: boolean | number;
}

interface ResolvedSherpaConfig {
  modelDir: string;
  encoder: string;
  decoder: string;
  joiner: string | null;
  tokens: string;
  language: string | null;
  modelType: 'transducer' | 'paraformer';
  provider: string;
  numThreads: number;
  decodingMethod: string;
}

interface StreamMetrics {
  requestStartedAt: number;
  firstPartialAt: number | null;
  finalTranscriptAt: number | null;
  streamBytesSent: number;
  streamNonEmptyChunkCount: number;
  partialCount: number;
}

export class SherpaOnnxProvider implements SttProvider {
  public readonly name = 'Sherpa ONNX Realtime STT';
  public readonly supportsStreaming = true;

  private readonly config: ResolvedSherpaConfig;
  private recognizer: OnlineRecognizer | null = null;
  private lastDebugInfo: SttDebugInfo | null = null;

  public constructor(config: SherpaOnnxConfig = {}) {
    this.config = resolveSherpaConfig(config);
    validateSherpaConfig(this.config);
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
    const { samples, sampleRate } = decodeAudioBuffer(audio, options);
    let latest: SttResult | undefined;

    for await (const result of this.transcribeStream(
      createFloatChunkStream(samples, sampleRate),
      {
        ...options,
        sampleRateHertz: sampleRate,
        channels: 1,
        encoding: 'pcm_s16le',
      },
    )) {
      latest = result;
    }

    if (latest === undefined || latest.text.trim().length === 0) {
      this.lastDebugInfo = {
        ...this.createBaseDebug(null),
        failureReason: 'stt_empty_transcript',
      };
      throw new Error('stt_empty_transcript: sherpa-onnx returned an empty transcript');
    }

    return latest;
  }

  public async *transcribeStream(
    audioStream: AsyncIterable<Buffer>,
    options: SttOptions = {},
  ): AsyncIterable<SttResult> {
    const metrics: StreamMetrics = {
      requestStartedAt: Date.now(),
      firstPartialAt: null,
      finalTranscriptAt: null,
      streamBytesSent: 0,
      streamNonEmptyChunkCount: 0,
      partialCount: 0,
    };
    const sampleRate = options.sampleRateHertz ?? DEFAULT_SAMPLE_RATE_HERTZ;
    const channels = options.channels ?? DEFAULT_CHANNELS;
    const stream = this.getRecognizer().createStream();
    let latestText = '';
    let sawAudio = false;

    try {
      for await (const chunk of audioStream) {
        if (chunk.byteLength === 0) {
          continue;
        }

        sawAudio = true;
        metrics.streamBytesSent += chunk.byteLength;
        metrics.streamNonEmptyChunkCount += 1;
        stream.acceptWaveform({
          samples: pcm16ToFloat32(chunk, channels),
          sampleRate,
        });

        const partial = this.decodeReady(stream);

        if (partial.length > 0 && partial !== latestText) {
          latestText = partial;
          metrics.partialCount += 1;

          if (metrics.firstPartialAt === null) {
            metrics.firstPartialAt = Date.now();
          }

          this.lastDebugInfo = this.createSuccessDebug(latestText, metrics);
          yield { text: latestText, language: options.language ?? this.config.language ?? undefined };
        }
      }

      if (!sawAudio) {
        this.lastDebugInfo = {
          ...this.createBaseDebug(metrics),
          failureReason: 'stt_empty_audio',
          streamClosedBeforeFirstChunk: true,
          sttRequestSkippedBecauseEmpty: true,
        };
        throw new Error('stt_empty_audio: sherpa-onnx stream closed before receiving audio');
      }

      stream.acceptWaveform({
        samples: new Float32Array(Math.round(sampleRate * STREAM_TAIL_PADDING_SECONDS)),
        sampleRate,
      });
      stream.inputFinished();
      const finalText = this.decodeReady(stream) || latestText;
      metrics.finalTranscriptAt = Date.now();
      this.lastDebugInfo = this.createSuccessDebug(finalText, metrics);

      if (finalText.trim().length === 0) {
        this.lastDebugInfo = {
          ...this.lastDebugInfo,
          failureReason: 'stt_empty_transcript',
        };
        throw new Error('stt_empty_transcript: sherpa-onnx returned an empty final transcript');
      }

      yield {
        text: finalText,
        language: options.language ?? this.config.language ?? undefined,
      };
    } catch (error: unknown) {
      if (this.lastDebugInfo === null) {
        this.lastDebugInfo = {
          ...this.createBaseDebug(metrics),
          failureReason: classifySherpaFailure(error),
          rawBodyPreview: error instanceof Error ? error.message : String(error),
        };
      }

      throw error;
    }
  }

  public streamTranscribe(
    audioStream: AsyncIterable<Buffer>,
    options: SttOptions = {},
  ): AsyncIterable<SttResult> {
    return this.transcribeStream(audioStream, options);
  }

  private getRecognizer(): OnlineRecognizer {
    if (this.recognizer !== null) {
      return this.recognizer;
    }

    let sherpa: SherpaOnnxModule;

    try {
      sherpa = require('sherpa-onnx-node') as SherpaOnnxModule;
    } catch (error: unknown) {
      throw new Error(
        'stt_provider_unavailable: unable to load sherpa-onnx-node. ' +
        'Run "pnpm install" and, on macOS, ensure the package native addon can load. ' +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      this.recognizer = new sherpa.OnlineRecognizer(this.buildRecognizerConfig());
      return this.recognizer;
    } catch (error: unknown) {
      throw new Error(
        'stt_provider_unavailable: failed to initialize sherpa-onnx recognizer. ' +
        'Check SHERPA_ONNX_MODEL_DIR/ENCODER/DECODER/JOINER/TOKENS and model compatibility. ' +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private buildRecognizerConfig(): OnlineRecognizerConfig {
    const modelConfig: OnlineRecognizerConfig['modelConfig'] = {
      tokens: this.config.tokens,
      numThreads: this.config.numThreads,
      provider: this.config.provider,
      debug: false,
    };

    if (this.config.modelType === 'transducer') {
      modelConfig.transducer = {
        encoder: this.config.encoder,
        decoder: this.config.decoder,
        joiner: this.config.joiner ?? undefined,
      };
    } else {
      modelConfig.paraformer = {
        encoder: this.config.encoder,
        decoder: this.config.decoder,
      };
    }

    return {
      featConfig: {
        sampleRate: DEFAULT_SAMPLE_RATE_HERTZ,
        featureDim: DEFAULT_FEATURE_DIM,
      },
      modelConfig,
      decodingMethod: this.config.decodingMethod,
      maxActivePaths: 4,
      enableEndpoint: true,
    };
  }

  private decodeReady(stream: OnlineStream): string {
    const recognizer = this.getRecognizer();

    while (recognizer.isReady(stream)) {
      recognizer.decode(stream);
    }

    const result = recognizer.getResult(stream);
    return normalizeTranscript(result.text);
  }

  private createBaseDebug(metrics: StreamMetrics | null): SttDebugInfo {
    return {
      requestUrl: 'sherpa-onnx-node',
      httpStatus: null,
      contentType: 'application/octet-stream',
      rawBodyPreview: null,
      responseKeys: ['text', 'tokens', 'timestamps', 'is_final'],
      transcript: null,
      transcriptLength: null,
      failureReason: null,
      streamBytesSent: metrics?.streamBytesSent ?? null,
      streamNonEmptyChunkCount: metrics?.streamNonEmptyChunkCount ?? null,
      streamFirstChunkAt: metrics === null ? null : new Date(metrics.requestStartedAt).toISOString(),
      streamClosedBeforeFirstChunk: metrics === null ? null : metrics.streamNonEmptyChunkCount === 0,
      sttRequestSkippedBecauseEmpty: false,
      providerName: this.name,
      modelType: this.config.modelType,
      modelDir: this.config.modelDir,
      modelProvider: this.config.provider,
      numThreads: this.config.numThreads,
      firstPartialAt: metrics?.firstPartialAt === null || metrics?.firstPartialAt === undefined
        ? null
        : new Date(metrics.firstPartialAt).toISOString(),
      finalTranscriptAt: metrics?.finalTranscriptAt === null || metrics?.finalTranscriptAt === undefined
        ? null
        : new Date(metrics.finalTranscriptAt).toISOString(),
      firstPartialLatencyMs:
        metrics?.firstPartialAt === null || metrics?.firstPartialAt === undefined
          ? null
          : Math.max(0, metrics.firstPartialAt - metrics.requestStartedAt),
      finalTranscriptLatencyMs:
        metrics?.finalTranscriptAt === null || metrics?.finalTranscriptAt === undefined
          ? null
          : Math.max(0, metrics.finalTranscriptAt - metrics.requestStartedAt),
      totalLatencyMs:
        metrics?.finalTranscriptAt === null || metrics?.finalTranscriptAt === undefined
          ? null
          : Math.max(0, metrics.finalTranscriptAt - metrics.requestStartedAt),
      partialsEmitted: metrics === null ? null : metrics.partialCount > 0,
      partialCount: metrics?.partialCount ?? null,
    };
  }

  private createSuccessDebug(text: string, metrics: StreamMetrics): SttDebugInfo {
    const normalized = normalizeTranscript(text);

    return {
      ...this.createBaseDebug(metrics),
      transcript: normalized,
      transcriptLength: normalized.length,
    };
  }
}

function resolveSherpaConfig(config: SherpaOnnxConfig): ResolvedSherpaConfig {
  const modelDir = resolvePath(config.modelDir ?? '');
  const encoder = resolveModelPath(modelDir, config.encoder);
  const decoder = resolveModelPath(modelDir, config.decoder);
  const joiner = resolveOptionalModelPath(modelDir, config.joiner);
  const tokens = resolveModelPath(modelDir, config.tokens);
  const requestedType = config.modelType ?? DEFAULT_MODEL_TYPE;
  const modelType =
    requestedType === 'auto'
      ? joiner === null ? 'paraformer' : 'transducer'
      : requestedType;

  return {
    modelDir,
    encoder,
    decoder,
    joiner,
    tokens,
    language: config.language?.trim() || null,
    modelType,
    provider: config.provider?.trim() || DEFAULT_PROVIDER,
    numThreads: config.numThreads ?? DEFAULT_NUM_THREADS,
    decodingMethod: config.decodingMethod?.trim() || DEFAULT_DECODING_METHOD,
  };
}

function validateSherpaConfig(config: ResolvedSherpaConfig): void {
  const missing: string[] = [];

  if (config.modelDir.length === 0 || !existsSync(config.modelDir)) {
    missing.push(`SHERPA_ONNX_MODEL_DIR/config.voice.sherpaOnnx.modelDir (${config.modelDir || 'not set'})`);
  }

  for (const [label, value] of [
    ['SHERPA_ONNX_ENCODER', config.encoder],
    ['SHERPA_ONNX_DECODER', config.decoder],
    ['SHERPA_ONNX_TOKENS', config.tokens],
  ] as const) {
    if (!existsSync(value)) {
      missing.push(`${label} (${value})`);
    }
  }

  if (config.modelType === 'transducer' && (config.joiner === null || !existsSync(config.joiner))) {
    missing.push(`SHERPA_ONNX_JOINER (${config.joiner ?? 'not set'})`);
  }

  if (missing.length > 0) {
    throw new Error(
      'stt_model_missing: sherpa-onnx model assets are missing. ' +
      `Missing: ${missing.join(', ')}. ` +
      'Download a streaming sherpa-onnx model and set SHERPA_ONNX_MODEL_DIR, ' +
      'SHERPA_ONNX_ENCODER, SHERPA_ONNX_DECODER, SHERPA_ONNX_TOKENS, and SHERPA_ONNX_JOINER for transducer models.',
    );
  }
}

function resolveModelPath(modelDir: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    return '';
  }

  return resolvePath(value, modelDir);
}

function resolveOptionalModelPath(modelDir: string, value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }

  return resolvePath(value, modelDir);
}

function resolvePath(value: string, baseDir = process.cwd()): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    return '';
  }

  return isAbsolute(normalized) ? normalized : resolve(baseDir, normalized);
}

function decodeAudioBuffer(
  audio: Buffer,
  options: SttOptions,
): { samples: Float32Array; sampleRate: number } {
  if (options.encoding === 'pcm_s16le') {
    return {
      samples: pcm16ToFloat32(audio, options.channels ?? DEFAULT_CHANNELS),
      sampleRate: options.sampleRateHertz ?? DEFAULT_SAMPLE_RATE_HERTZ,
    };
  }

  const wave = parsePcm16Wave(audio);

  return {
    samples: pcm16ToFloat32(wave.pcm, wave.channels),
    sampleRate: wave.sampleRate,
  };
}

function parsePcm16Wave(audio: Buffer): {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
} {
  if (
    audio.byteLength < 44 ||
    audio.toString('ascii', 0, 4) !== 'RIFF' ||
    audio.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('stt_invalid_json: sherpa-onnx expected PCM WAV audio for buffered transcription');
  }

  let offset = 12;
  let sampleRate = DEFAULT_SAMPLE_RATE_HERTZ;
  let channels = DEFAULT_CHANNELS;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= audio.byteLength) {
    const chunkId = audio.toString('ascii', offset, offset + 4);
    const chunkSize = audio.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ') {
      channels = audio.readUInt16LE(chunkStart + 2);
      sampleRate = audio.readUInt32LE(chunkStart + 4);
      bitsPerSample = audio.readUInt16LE(chunkStart + 14);
    } else if (chunkId === 'data') {
      dataOffset = chunkStart;
      dataSize = chunkSize;
      break;
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || bitsPerSample !== 16) {
    throw new Error('stt_unrecognized_payload_shape: sherpa-onnx only supports PCM16 WAV audio');
  }

  return {
    pcm: audio.subarray(dataOffset, Math.min(audio.byteLength, dataOffset + dataSize)),
    sampleRate,
    channels,
  };
}

function pcm16ToFloat32(buffer: Buffer, channels: number): Float32Array {
  const sampleCount = Math.floor(buffer.byteLength / 2 / Math.max(1, channels));
  const samples = new Float32Array(sampleCount);

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    let value = 0;

    for (let channel = 0; channel < channels; channel += 1) {
      const byteOffset = (sampleIndex * channels + channel) * 2;
      value += buffer.readInt16LE(byteOffset) / 32768;
    }

    samples[sampleIndex] = value / Math.max(1, channels);
  }

  return samples;
}

async function* createFloatChunkStream(
  samples: Float32Array,
  sampleRate: number,
): AsyncIterable<Buffer> {
  const chunkSamples = Math.max(1, Math.round(sampleRate * 0.1));

  for (let offset = 0; offset < samples.length; offset += chunkSamples) {
    yield float32ToPcm16(samples.subarray(offset, Math.min(samples.length, offset + chunkSamples)));
  }
}

function float32ToPcm16(samples: Float32Array): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);

  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index] ?? 0));
    buffer.writeInt16LE(Math.round(value * 32767), index * 2);
  }

  return buffer;
}

function normalizeTranscript(value: string | undefined): string {
  return value?.trim() ?? '';
}

function classifySherpaFailure(error: unknown): SttDebugInfo['failureReason'] {
  const message = error instanceof Error ? error.message : String(error);

  if (message.startsWith('stt_model_missing:')) {
    return 'stt_model_missing';
  }

  if (message.startsWith('stt_empty_audio:')) {
    return 'stt_empty_audio';
  }

  if (message.startsWith('stt_empty_transcript:')) {
    return 'stt_empty_transcript';
  }

  return 'stt_provider_unavailable';
}
