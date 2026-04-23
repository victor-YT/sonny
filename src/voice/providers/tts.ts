import type { TimingTracker } from '../../core/timing.js';

export interface TtsProvider {
  readonly name: string;
  synthesize(text: string, options?: TtsOptions): Promise<Buffer>;
  supportsStreaming: boolean;
  synthesizeStream?(text: string, options?: TtsOptions): AsyncIterable<Buffer>;
  streamSynthesize?(text: string, options?: TtsOptions): AsyncIterable<Buffer>;
  warmup?(): Promise<void>;
}

export interface TtsOptions {
  voice?: string;
  speed?: number;
  emotion?: TtsEmotion;
  exaggeration?: number;
  signal?: AbortSignal;
  timingTracker?: TimingTracker;
}

export type TtsEmotion = 'neutral' | 'happy' | 'sad' | 'excited' | 'calm';
