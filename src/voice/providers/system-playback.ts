import type { StreamingAudioQueue } from '../streaming-audio-queue.js';
import type { PlaybackOptions, PlaybackProvider } from './playback.js';

export interface SystemPlaybackProviderConfig {
  playbackQueue: StreamingAudioQueue;
}

export class SystemPlaybackProvider implements PlaybackProvider {
  public readonly name = 'system-player';

  private readonly playbackQueue: StreamingAudioQueue;

  public constructor(config: SystemPlaybackProviderConfig) {
    this.playbackQueue = config.playbackQueue;
  }

  public async play(audio: Buffer, options: PlaybackOptions = {}): Promise<Buffer> {
    this.playbackQueue.enqueue(audio, {
      text: options.text,
      timingTracker: options.timingTracker,
      voice: options.voice,
    });

    return audio;
  }

  public async playStream(
    audioStream: AsyncIterable<Buffer>,
    options: PlaybackOptions = {},
  ): Promise<Buffer> {
    const prefetched = this.createPrefetchedStream(audioStream);

    this.playbackQueue.enqueueStream(prefetched.stream, {
      text: options.text,
      timingTracker: options.timingTracker,
      voice: options.voice,
    });

    return prefetched.completed;
  }

  private createPrefetchedStream(
    source: AsyncIterable<Buffer>,
  ): { stream: AsyncIterable<Buffer>; completed: Promise<Buffer> } {
    const chunks: Buffer[] = [];
    const bufferedChunks: Buffer[] = [];
    const waiters: Array<() => void> = [];
    let completed = false;
    let failed: Error | undefined;
    let resolveCompleted: ((audio: Buffer) => void) | undefined;
    let rejectCompleted: ((error: Error) => void) | undefined;
    const completedPromise = new Promise<Buffer>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });

    void this.prefetchStream(
      source,
      chunks,
      bufferedChunks,
      waiters,
      () => {
        completed = true;
      },
      (error) => {
        failed = error;
      },
      (audio) => {
        resolveCompleted?.(audio);
      },
      (error) => {
        rejectCompleted?.(error);
      },
    );

    return {
      stream: this.readPrefetchedStream(
        bufferedChunks,
        waiters,
        () => completed,
        () => failed,
      ),
      completed: completedPromise,
    };
  }

  private async prefetchStream(
    source: AsyncIterable<Buffer>,
    chunks: Buffer[],
    bufferedChunks: Buffer[],
    waiters: Array<() => void>,
    markCompleted: () => void,
    setFailed: (error: Error) => void,
    resolveCompleted: (audio: Buffer) => void,
    rejectCompleted: (error: Error) => void,
  ): Promise<void> {
    try {
      for await (const chunk of source) {
        chunks.push(chunk);
        bufferedChunks.push(chunk);
        this.flushPrefetchedWaiters(waiters);
      }

      markCompleted();
      this.flushPrefetchedWaiters(waiters);
      resolveCompleted(Buffer.concat(chunks));
    } catch (error: unknown) {
      const streamingError =
        error instanceof Error
          ? error
          : new Error('Streaming playback failed');

      setFailed(streamingError);
      this.flushPrefetchedWaiters(waiters);
      rejectCompleted(streamingError);
    }
  }

  private async *readPrefetchedStream(
    bufferedChunks: Buffer[],
    waiters: Array<() => void>,
    isCompleted: () => boolean,
    getFailed: () => Error | undefined,
  ): AsyncIterable<Buffer> {
    while (true) {
      const failed = getFailed();

      if (failed !== undefined) {
        throw failed;
      }

      const chunk = bufferedChunks.shift();

      if (chunk !== undefined) {
        yield chunk;
        continue;
      }

      if (isCompleted()) {
        return;
      }

      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
  }

  private flushPrefetchedWaiters(waiters: Array<() => void>): void {
    while (waiters.length > 0) {
      waiters.shift()?.();
    }
  }
}
