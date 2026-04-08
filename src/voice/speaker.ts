import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectRuntimePlatform,
  type RuntimePlatform,
} from '../core/config.js';
import {
  type StreamingAudioQueue,
  type StreamingAudioQueueEvent,
  type StreamingAudioQueueItemMetadata,
  type StreamingAudioQueueListener,
} from './streaming-audio-queue.js';

const TEMP_DIR_PREFIX = 'sonny-speaker-';
const TEMP_FILE_NAME = 'response.audio';

export type SpeakerState = 'idle' | 'playing' | 'error';

export type SpeakerEventType =
  | 'state_changed'
  | 'playback_started'
  | 'playback_completed'
  | 'error';

export interface SpeakerEvent {
  type: SpeakerEventType;
  timestamp: number;
  state?: SpeakerState;
  itemId?: string;
  metadata?: StreamingAudioQueueItemMetadata;
  error?: Error;
}

export type SpeakerListener = (event: SpeakerEvent) => void;

export interface SpeakerConfig {
  audioQueue: StreamingAudioQueue;
  playerCommand?: string;
  platform?: RuntimePlatform;
}

interface PlaybackItem {
  id: string;
  metadata?: StreamingAudioQueueItemMetadata;
  audio: Buffer;
}

interface PlayerInvocation {
  command: string;
  args: string[];
}

export class Speaker {
  private readonly audioQueue: StreamingAudioQueue;
  private readonly playerCommand: string | undefined;
  private readonly platform: RuntimePlatform;
  private readonly listeners = new Set<SpeakerListener>();
  private readonly queuedChunks = new Map<string, Buffer[]>();
  private readonly itemMetadata = new Map<string, StreamingAudioQueueItemMetadata | undefined>();
  private readonly playbackQueue: PlaybackItem[] = [];
  private readonly queueListener: StreamingAudioQueueListener;

  private started = false;
  private stopping = false;
  private processing = false;
  private state: SpeakerState = 'idle';
  private currentProcess: ChildProcess | undefined;
  private currentTempDir: string | undefined;
  private currentItem: PlaybackItem | undefined;

  public constructor(config: SpeakerConfig) {
    this.audioQueue = config.audioQueue;
    this.playerCommand = config.playerCommand;
    this.platform = detectRuntimePlatform(config.platform);
    this.queueListener = (event) => {
      void this.handleQueueEvent(event);
    };
  }

  public get isPlaying(): boolean {
    return (
      this.state === 'playing' ||
      this.processing ||
      this.currentProcess !== undefined ||
      this.playbackQueue.length > 0
    );
  }

  public onEvent(listener: SpeakerListener): void {
    this.listeners.add(listener);
  }

  public removeListener(listener: SpeakerListener): void {
    this.listeners.delete(listener);
  }

  public start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.stopping = false;
    this.audioQueue.onEvent(this.queueListener);
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;
    this.stopping = true;
    this.audioQueue.removeListener(this.queueListener);
    this.queuedChunks.clear();
    this.itemMetadata.clear();
    this.playbackQueue.splice(0);

    if (this.currentProcess !== undefined) {
      this.currentProcess.kill('SIGTERM');
    }

    await this.cleanupCurrentTempDir();

    this.currentItem = undefined;
    this.currentProcess = undefined;
    this.processing = false;
    this.stopping = false;
    this.setState('idle');
  }

  public async interrupt(): Promise<void> {
    this.stopping = true;
    this.playbackQueue.splice(0);
    this.queuedChunks.clear();
    this.itemMetadata.clear();

    const process = this.currentProcess;

    if (process !== undefined) {
      process.kill('SIGTERM');
    }

    await this.cleanupCurrentTempDir();

    this.currentItem = undefined;
    this.currentProcess = undefined;
    this.stopping = false;

    if (!this.processing) {
      this.setState('idle');
    }
  }

  private async handleQueueEvent(event: StreamingAudioQueueEvent): Promise<void> {
    switch (event.type) {
      case 'item_started':
        if (event.itemId !== undefined) {
          this.queuedChunks.set(event.itemId, []);
          this.itemMetadata.set(event.itemId, event.metadata);
        }
        return;
      case 'chunk':
        if (event.itemId !== undefined && event.chunk !== undefined) {
          const chunks = this.queuedChunks.get(event.itemId);

          chunks?.push(event.chunk);
        }
        return;
      case 'item_completed':
        if (event.itemId !== undefined) {
          const chunks = this.queuedChunks.get(event.itemId) ?? [];
          const metadata = this.itemMetadata.get(event.itemId);

          this.queuedChunks.delete(event.itemId);
          this.itemMetadata.delete(event.itemId);
          this.playbackQueue.push({
            id: event.itemId,
            metadata,
            audio: Buffer.concat(chunks),
          });
          void this.pump();
        }
        return;
      case 'item_interrupted':
        if (event.itemId !== undefined) {
          this.queuedChunks.delete(event.itemId);
          this.itemMetadata.delete(event.itemId);
          this.removePendingPlayback(event.itemId);
        }
        return;
      case 'error':
        if (event.itemId !== undefined) {
          this.queuedChunks.delete(event.itemId);
          this.itemMetadata.delete(event.itemId);
          this.removePendingPlayback(event.itemId);
        }

        if (event.error !== undefined) {
          this.handleError(event.error);
        }
        return;
      case 'queue_drained':
        if (!this.isPlaying) {
          this.setState('idle');
        }
        return;
      default:
        return;
    }
  }

  private removePendingPlayback(itemId: string): void {
    const index = this.playbackQueue.findIndex((item) => item.id === itemId);

    if (index >= 0) {
      this.playbackQueue.splice(index, 1);
    }
  }

  private async pump(): Promise<void> {
    if (this.processing || !this.started) {
      return;
    }

    this.processing = true;

    try {
      while (this.playbackQueue.length > 0 && this.started) {
        const item = this.playbackQueue.shift();

        if (item === undefined) {
          break;
        }

        this.currentItem = item;
        item.metadata?.timingTracker?.start('audio_playback');
        this.setState('playing');
        this.emit({
          type: 'playback_started',
          itemId: item.id,
          metadata: item.metadata,
        });

        try {
          await this.playItem(item);
        } finally {
          item.metadata?.timingTracker?.end('audio_playback');
          this.emit({
            type: 'playback_completed',
            itemId: item.id,
            metadata: item.metadata,
          });
        }
      }
    } catch (error: unknown) {
      if (!this.stopping) {
        this.handleError(this.toError(error, 'Speaker playback failed'));
      }
    } finally {
      this.currentItem = undefined;
      this.processing = false;

      if (!this.isPlaying) {
        this.setState('idle');
      }
    }
  }

  private async playItem(item: PlaybackItem): Promise<void> {
    if (item.audio.length === 0) {
      return;
    }

    const tempDir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
    const tempFile = join(tempDir, TEMP_FILE_NAME);

    this.currentTempDir = tempDir;

    try {
      await writeFile(tempFile, item.audio);
      await this.runPlayer(tempFile);
    } finally {
      await this.cleanupCurrentTempDir();
    }
  }

  private async runPlayer(audioPath: string): Promise<void> {
    const invocations = this.resolvePlayerInvocations(audioPath);
    let missingCommandError: Error | undefined;

    for (const invocation of invocations) {
      try {
        await this.spawnAndWait(invocation);
        return;
      } catch (error: unknown) {
        if (this.isMissingCommandError(error)) {
          missingCommandError = error;
          continue;
        }

        throw error;
      }
    }

    if (missingCommandError !== undefined) {
      throw new Error(this.buildMissingPlayerMessage(missingCommandError));
    }
  }

  private async spawnAndWait(invocation: PlayerInvocation): Promise<void> {
    const child = spawn(invocation.command, invocation.args, {
      stdio: 'ignore',
      windowsHide: true,
    });

    this.currentProcess = child;

    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', (error: Error) => {
          reject(error);
        });

        child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
          if (this.stopping && signal === 'SIGTERM') {
            resolve();
            return;
          }

          if (code === 0) {
            resolve();
            return;
          }

          reject(
            new Error(
              `${invocation.command} exited with code ${code ?? 'unknown'} and signal ${signal ?? 'none'}`,
            ),
          );
        });
      });
    } finally {
      this.currentProcess = undefined;
    }
  }

  private resolvePlayerInvocations(audioPath: string): PlayerInvocation[] {
    if (this.playerCommand !== undefined) {
      return [{
        command: this.playerCommand,
        args: [audioPath],
      }];
    }

    switch (this.platform) {
      case 'darwin':
        return [{
          command: 'afplay',
          args: [audioPath],
        }];
      case 'win32':
        return [{
          command: 'powershell',
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            [
              `Add-Type -AssemblyName System`,
              `$player = New-Object System.Media.SoundPlayer('${this.escapePowerShellString(audioPath)}')`,
              '$player.PlaySync()',
            ].join('; '),
          ],
        }];
      default:
        return [
          {
            command: 'paplay',
            args: [audioPath],
          },
          {
            command: 'aplay',
            args: [audioPath],
          },
          {
            command: 'ffplay',
            args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', audioPath],
          },
        ];
    }
  }

  private escapePowerShellString(value: string): string {
    return value.replace(/'/g, "''");
  }

  private isMissingCommandError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
  }

  private buildMissingPlayerMessage(error: Error): string {
    const configuredCommand = this.playerCommand;

    if (configuredCommand !== undefined) {
      return `Audio playback command "${configuredCommand}" is not available: ${error.message}`;
    }

    switch (this.platform) {
      case 'win32':
        return `Windows audio playback failed because PowerShell is not available: ${error.message}`;
      case 'darwin':
        return `macOS audio playback failed because afplay is not available: ${error.message}`;
      default:
        return `Linux audio playback requires one of paplay, aplay, or ffplay: ${error.message}`;
    }
  }

  private async cleanupCurrentTempDir(): Promise<void> {
    const tempDir = this.currentTempDir;

    this.currentTempDir = undefined;

    if (tempDir !== undefined) {
      await rm(tempDir, {
        force: true,
        recursive: true,
      });
    }
  }

  private setState(state: SpeakerState): void {
    if (this.state === state) {
      return;
    }

    this.state = state;
    this.emit({
      type: 'state_changed',
      state,
    });
  }

  private handleError(error: Error): void {
    this.state = 'error';
    this.emit({
      type: 'state_changed',
      state: 'error',
      error,
    });
    this.emit({
      type: 'error',
      error,
      itemId: this.currentItem?.id,
      metadata: this.currentItem?.metadata,
    });
  }

  private emit(event: Omit<SpeakerEvent, 'timestamp'>): void {
    const payload: SpeakerEvent = {
      ...event,
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
