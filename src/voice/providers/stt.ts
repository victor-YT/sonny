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
  streamTranscribe?(audioStream: AsyncIterable<Buffer>): AsyncIterable<SttResult>;
}

export interface SttOptions {
  language?: string;
  prompt?: string;
}
