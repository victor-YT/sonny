import type { TimingTracker } from '../../core/timing.js';

export interface PlaybackProvider {
  readonly name: string;
  play(audio: Buffer, options?: PlaybackOptions): Promise<Buffer>;
  playStream?(audioStream: AsyncIterable<Buffer>, options?: PlaybackOptions): Promise<Buffer>;
}

export interface PlaybackOptions {
  text?: string;
  voice?: string;
  timingTracker?: TimingTracker;
}
