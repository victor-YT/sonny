import type { TimingTracker } from '../../core/timing.js';

export type SttFailureReason =
  | 'stt_http_error'
  | 'stt_invalid_json'
  | 'stt_unrecognized_payload_shape'
  | 'stt_empty_transcript';

export interface SttDebugInfo {
  requestUrl: string | null;
  httpStatus: number | null;
  contentType: string | null;
  rawBodyPreview: string | null;
  responseKeys: string[];
  transcript: string | null;
  transcriptLength: number | null;
  failureReason: SttFailureReason | null;
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
  streamTranscribe?(
    audioStream: AsyncIterable<Buffer>,
    options?: SttOptions,
  ): AsyncIterable<SttResult>;
}

export interface SttOptions {
  language?: string;
  prompt?: string;
  sampleRateHertz?: number;
  channels?: number;
  encoding?: 'wav' | 'pcm_s16le';
  timingTracker?: TimingTracker;
}
