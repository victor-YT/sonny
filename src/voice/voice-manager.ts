import { Gateway } from '../core/gateway.js';
import type { SttOptions, SttProvider, SttResult } from './providers/stt.js';
import type { TtsOptions, TtsProvider } from './providers/tts.js';
import type {
  WakeWordEvent,
  WakeWordListener,
  WakeWordProvider,
} from './providers/wake-word.js';

export type VoiceManagerState =
  | 'idle'
  | 'listening'
  | 'capturing'
  | 'transcribing'
  | 'thinking'
  | 'synthesizing'
  | 'error';

export type VoiceManagerEventType =
  | 'state_changed'
  | 'wake_word_detected'
  | 'transcription'
  | 'response'
  | 'audio'
  | 'error';

export interface VoiceCaptureResult {
  audio: Buffer;
  sttOptions?: SttOptions;
}

export interface VoiceInteractionOptions {
  stt?: SttOptions;
  tts?: TtsOptions;
  wakeWord?: string;
}

export interface VoiceInteractionResult {
  wakeWord?: string;
  transcription: string;
  response: string;
  audio: Buffer;
  sttResult: SttResult;
}

export interface VoiceManagerEvent {
  type: VoiceManagerEventType;
  timestamp: number;
  state?: VoiceManagerState;
  wakeWord?: string;
  text?: string;
  audio?: Buffer;
  result?: VoiceInteractionResult;
  error?: Error;
}

export type VoiceManagerListener = (event: VoiceManagerEvent) => void;

export interface VoiceManagerConfig {
  gateway: Gateway;
  sttProvider: SttProvider;
  ttsProvider: TtsProvider;
  wakeWordProvider?: WakeWordProvider;
  captureAudio?: (event: WakeWordEvent) => Promise<Buffer | VoiceCaptureResult>;
  defaultSttOptions?: SttOptions;
  defaultTtsOptions?: TtsOptions;
}

export class VoiceManager {
  private readonly gateway: Gateway;
  private readonly sttProvider: SttProvider;
  private readonly ttsProvider: TtsProvider;
  private readonly wakeWordProvider: WakeWordProvider | undefined;
  private readonly captureAudio:
    | ((event: WakeWordEvent) => Promise<Buffer | VoiceCaptureResult>)
    | undefined;
  private readonly defaultSttOptions: SttOptions;
  private readonly defaultTtsOptions: TtsOptions;
  private readonly listeners = new Set<VoiceManagerListener>();
  private readonly wakeWordListener: WakeWordListener;

  private state: VoiceManagerState = 'idle';
  private pipelineTask: Promise<VoiceInteractionResult> | undefined;
  private started = false;

  public constructor(config: VoiceManagerConfig) {
    this.gateway = config.gateway;
    this.sttProvider = config.sttProvider;
    this.ttsProvider = config.ttsProvider;
    this.wakeWordProvider = config.wakeWordProvider;
    this.captureAudio = config.captureAudio;
    this.defaultSttOptions = config.defaultSttOptions ?? {};
    this.defaultTtsOptions = config.defaultTtsOptions ?? {};
    this.wakeWordListener = (event) => {
      void this.handleWakeWordEvent(event);
    };
  }

  public get currentState(): VoiceManagerState {
    return this.state;
  }

  public get isRunning(): boolean {
    return this.started;
  }

  public onEvent(listener: VoiceManagerListener): void {
    this.listeners.add(listener);
  }

  public removeListener(listener: VoiceManagerListener): void {
    this.listeners.delete(listener);
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    if (this.wakeWordProvider === undefined) {
      this.setState('idle');
      return;
    }

    this.wakeWordProvider.onDetection(this.wakeWordListener);

    try {
      await this.wakeWordProvider.start();
      this.setState('listening');
    } catch (error: unknown) {
      this.wakeWordProvider.removeListener(this.wakeWordListener);
      this.started = false;
      this.handleError(this.toError(error, 'Voice manager failed to start'));
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;

    if (this.wakeWordProvider !== undefined) {
      this.wakeWordProvider.removeListener(this.wakeWordListener);
      await this.wakeWordProvider.stop();
    }

    this.setState('idle');
  }

  public async processAudio(
    audio: Buffer,
    options: VoiceInteractionOptions = {},
  ): Promise<VoiceInteractionResult> {
    if (this.pipelineTask !== undefined) {
      throw new Error('Voice pipeline is already processing another request');
    }

    const task = this.runPipeline(audio, options);
    this.pipelineTask = task;

    try {
      return await task;
    } finally {
      this.pipelineTask = undefined;
      this.setState(this.wakeWordProvider?.isListening === true ? 'listening' : 'idle');
    }
  }

  public async speak(text: string, options: TtsOptions = {}): Promise<Buffer> {
    this.setState('synthesizing');

    try {
      const audio = await this.ttsProvider.synthesize(text, {
        ...this.defaultTtsOptions,
        ...options,
      });

      this.emit({
        type: 'audio',
        audio,
      });

      return audio;
    } catch (error: unknown) {
      this.handleError(this.toError(error, 'Voice synthesis failed'));
      throw error;
    } finally {
      this.setState(this.wakeWordProvider?.isListening === true ? 'listening' : 'idle');
    }
  }

  private async runPipeline(
    audio: Buffer,
    options: VoiceInteractionOptions,
  ): Promise<VoiceInteractionResult> {
    try {
      this.setState('transcribing');
      const sttResult = await this.sttProvider.transcribe(audio, {
        ...this.defaultSttOptions,
        ...options.stt,
      });

      this.emit({
        type: 'transcription',
        text: sttResult.text,
        wakeWord: options.wakeWord,
      });

      this.setState('thinking');
      const response = await this.gateway.chat(sttResult.text);

      this.emit({
        type: 'response',
        text: response,
        wakeWord: options.wakeWord,
      });

      this.setState('synthesizing');
      const spokenAudio = await this.ttsProvider.synthesize(response, {
        ...this.defaultTtsOptions,
        ...options.tts,
      });

      const result: VoiceInteractionResult = {
        wakeWord: options.wakeWord,
        transcription: sttResult.text,
        response,
        audio: spokenAudio,
        sttResult,
      };

      this.emit({
        type: 'audio',
        audio: spokenAudio,
        wakeWord: options.wakeWord,
        result,
      });

      return result;
    } catch (error: unknown) {
      this.handleError(this.toError(error, 'Voice pipeline failed'));
      throw error;
    }
  }

  private async handleWakeWordEvent(event: WakeWordEvent): Promise<void> {
    if (event.type === 'ready') {
      this.setState('listening');
      return;
    }

    if (event.type === 'error') {
      this.handleError(event.error ?? new Error('Wake word provider emitted an error'));
      return;
    }

    if (event.type !== 'detected') {
      return;
    }

    this.emit({
      type: 'wake_word_detected',
      wakeWord: event.keyword,
    });

    if (this.captureAudio === undefined || this.pipelineTask !== undefined) {
      return;
    }

    this.setState('capturing');

    try {
      const captureResult = await this.captureAudio(event);
      const normalized = this.normalizeCaptureResult(captureResult);

      await this.processAudio(normalized.audio, {
        wakeWord: event.keyword,
        stt: normalized.sttOptions,
      });
    } catch (error: unknown) {
      this.handleError(this.toError(error, 'Voice capture failed'));
    }
  }

  private normalizeCaptureResult(
    result: Buffer | VoiceCaptureResult,
  ): VoiceCaptureResult {
    if (Buffer.isBuffer(result)) {
      return { audio: result };
    }

    return result;
  }

  private setState(state: VoiceManagerState): void {
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
    });
  }

  private emit(event: Omit<VoiceManagerEvent, 'timestamp'>): void {
    const payload: VoiceManagerEvent = {
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
