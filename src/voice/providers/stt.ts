import type { TimingTracker } from '../../core/timing.js';

export type SttFailureReason =
  | 'stt_http_error'
  | 'stt_invalid_json'
  | 'stt_unrecognized_payload_shape'
  | 'stt_empty_transcript'
  | 'stt_empty_audio'
  | 'stt_model_missing'
  | 'stt_provider_unavailable';

export interface SttDebugInfo {
  requestUrl: string | null;
  httpStatus: number | null;
  contentType: string | null;
  rawBodyPreview: string | null;
  responseKeys: string[];
  transcript: string | null;
  transcriptLength: number | null;
  failureReason: SttFailureReason | null;
  streamBytesSent?: number | null;
  streamNonEmptyChunkCount?: number | null;
  streamFirstChunkAt?: string | null;
  streamClosedBeforeFirstChunk?: boolean | null;
  captureEndedBy?: 'silence' | 'max_timeout' | 'manual' | 'abort' | 'unknown' | null;
  firstNonEmptyChunkReceived?: boolean | null;
  endedBeforeFirstChunk?: boolean | null;
  sttRequestSkippedBecauseEmpty?: boolean | null;
  providerName?: string | null;
  modelType?: string | null;
  modelDir?: string | null;
  modelProvider?: string | null;
  numThreads?: number | null;
  firstPartialAt?: string | null;
  finalTranscriptAt?: string | null;
  firstPartialLatencyMs?: number | null;
  finalTranscriptLatencyMs?: number | null;
  totalLatencyMs?: number | null;
  partialsEmitted?: boolean | null;
  partialCount?: number | null;
}

export interface SttResult {
  text: string;
  language?: string;
  confidence?: number;
  segments?: SttSegment[];
}

export interface SttSegment {
  text: string;
  start: number;
  end: number;
}

export interface SttProvider {
  readonly name: string;
  transcribe(audio: Buffer, options?: SttOptions): Promise<SttResult>;
  supportsStreaming: boolean;
  getLastDebugInfo?(): SttDebugInfo | null;
  transcribeStream?(
    audioStream: AsyncIterable<Buffer>,
    options?: SttOptions,
  ): AsyncIterable<SttResult>;
  streamTranscribe?(
    audioStream: AsyncIterable<Buffer>,
    options?: SttOptions,
  ): AsyncIterable<SttResult>;
}

export interface StreamingSttDebugContext {
  source: 'live-mic';
  streamBytesSent: number;
  streamNonEmptyChunkCount: number;
  captureEndedBy: 'silence' | 'max_timeout' | 'manual' | 'abort' | 'unknown';
  firstNonEmptyChunkReceived: boolean;
  endedBeforeFirstChunk: boolean;
  sttRequestSkippedBecauseEmpty: boolean;
}

export interface SttOptions {
  language?: string;
  prompt?: string;
  sampleRateHertz?: number;
  channels?: number;
  encoding?: 'wav' | 'pcm_s16le';
  timingTracker?: TimingTracker;
  streamingDebug?: StreamingSttDebugContext;
}
