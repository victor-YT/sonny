import { randomUUID } from 'node:crypto';

import type { TimingTracker } from '../core/timing.js';

export type StreamingAudioQueueEventType =
  | 'item_started'
  | 'chunk'
  | 'item_completed'
  | 'item_interrupted'
  | 'queue_drained'
  | 'error';

export interface StreamingAudioQueueItemMetadata {
  text?: string;
  voice?: string;
  timingTracker?: TimingTracker;
}

export interface StreamingAudioQueueEvent {
  type: StreamingAudioQueueEventType;
  timestamp: number;
  itemId?: string;
  metadata?: StreamingAudioQueueItemMetadata;
  chunk?: Buffer;
  pendingItems: number;
  error?: Error;
}

export type StreamingAudioQueueListener = (event: StreamingAudioQueueEvent) => void;

export interface StreamingAudioQueueEntry {
  id: string;
  completed: Promise<void>;
}

interface QueueItem {
  id: string;
  metadata?: StreamingAudioQueueItemMetadata;
  stream: AsyncIterable<Buffer>;
  resolve(): void;
  reject(error: Error): void;
}

export class StreamingAudioQueue {
  private readonly listeners = new Set<StreamingAudioQueueListener>();
  private readonly queue: QueueItem[] = [];

  private processing = false;
  private generation = 0;

  public get isPlaying(): boolean {
    return this.processing;
  }

  public get pendingItems(): number {
    return this.queue.length + (this.processing ? 1 : 0);
  }

  public onEvent(listener: StreamingAudioQueueListener): void {
    this.listeners.add(listener);
  }

  public removeListener(listener: StreamingAudioQueueListener): void {
    this.listeners.delete(listener);
  }

  public enqueue(
    audio: Buffer,
    metadata?: StreamingAudioQueueItemMetadata,
  ): StreamingAudioQueueEntry {
    return this.enqueueStream(this.singleChunk(audio), metadata);
  }

  public enqueueStream(
    stream: AsyncIterable<Buffer>,
    metadata?: StreamingAudioQueueItemMetadata,
  ): StreamingAudioQueueEntry {
    let resolveCompleted: (() => void) | undefined;
    let rejectCompleted: ((error: Error) => void) | undefined;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });

    const item: QueueItem = {
      id: randomUUID(),
      metadata,
      stream,
      resolve: () => {
        resolveCompleted?.();
      },
      reject: (error) => {
        rejectCompleted?.(error);
      },
    };

    this.queue.push(item);
    void this.pump();

    return {
      id: item.id,
      completed,
    };
  }

  public clear(): void {
    const interruptedError = new Error('Audio queue was cleared');
    const interruptedItems = this.queue.splice(0);

    this.generation += 1;

    for (const item of interruptedItems) {
      item.reject(interruptedError);
      this.emit({
        type: 'item_interrupted',
        itemId: item.id,
        metadata: item.metadata,
      });
    }
  }

  private async *singleChunk(audio: Buffer): AsyncIterable<Buffer> {
    yield audio;
  }

  private async pump(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();

        if (item === undefined) {
          break;
        }

        const itemGeneration = this.generation;

        this.emit({
          type: 'item_started',
          itemId: item.id,
          metadata: item.metadata,
        });

        try {
          for await (const chunk of item.stream) {
            if (itemGeneration !== this.generation) {
              item.reject(new Error('Audio queue item was interrupted'));
              this.emit({
                type: 'item_interrupted',
                itemId: item.id,
                metadata: item.metadata,
              });
              break;
            }

            if (chunk.length === 0) {
              continue;
            }

            this.emit({
              type: 'chunk',
              itemId: item.id,
              metadata: item.metadata,
              chunk,
            });
          }

          if (itemGeneration === this.generation) {
            item.resolve();
            this.emit({
              type: 'item_completed',
              itemId: item.id,
              metadata: item.metadata,
            });
          }
        } catch (error: unknown) {
          const queueError = this.toError(error, 'Audio queue item failed');

          item.reject(queueError);
          this.emit({
            type: 'error',
            itemId: item.id,
            metadata: item.metadata,
            error: queueError,
          });
        }
      }
    } finally {
      this.processing = false;
      this.emit({
        type: 'queue_drained',
      });
    }
  }

  private emit(
    event: Omit<StreamingAudioQueueEvent, 'pendingItems' | 'timestamp'>,
  ): void {
    const payload: StreamingAudioQueueEvent = {
      ...event,
      pendingItems: this.pendingItems,
      timestamp: Date.now(),
    };

    for (const listener of this.listeners) {
      listener(payload);
    }
  }

  private toError(error: unknown, fallbackMessage: string): Error {
    if (error instanceof Error) {
      return error;
    }

    return new Error(fallbackMessage);
  }
}
