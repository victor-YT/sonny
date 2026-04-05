import { loadConfig, type RuntimeConfig } from '../core/config.js';
import { Gateway } from '../core/gateway.js';
import { ChatterboxProvider } from './providers/chatterbox.js';
import { FasterWhisperProvider } from './providers/faster-whisper.js';
import { PorcupineProvider } from './providers/porcupine.js';
import type { SttOptions, SttProvider, SttResult } from './providers/stt.js';
import type { TtsOptions, TtsProvider } from './providers/tts.js';
import type {
  WakeWordEvent,
  WakeWordListener,
  WakeWordProvider,
} from './providers/wake-word.js';
import {
  ResponseProcessor,
  type ProcessedVoiceResponse,
} from './response-processor.js';
import type { Speaker, SpeakerListener } from './speaker.js';
import {
  StreamingAudioQueue,
  type StreamingAudioQueueEvent,
} from './streaming-audio-queue.js';
import { getThinkingSound } from './thinking-sounds.js';

export type VoiceManagerState =
  | 'idle'
  | 'listening'
  | 'capturing'
  | 'transcribing'
  | 'thinking'
  | 'synthesizing'
  | 'playing'
  | 'error';

export type VoiceManagerEventType =
  | 'state_changed'
  | 'wake_word_detected'
  | 'transcription'
  | 'response'
  | 'audio_chunk'
  | 'audio'
  | 'error';

export interface VoiceCaptureResult {
  audio?: Buffer;
  audioPromise?: Promise<Buffer>;
  audioStream?: AsyncIterable<Buffer>;
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
  runtimeConfig?: RuntimeConfig;
  sttProvider?: SttProvider;
  ttsProvider?: TtsProvider;
  wakeWordProvider?: WakeWordProvider;
  captureAudio?: (event: WakeWordEvent) => Promise<Buffer | VoiceCaptureResult>;
  defaultSttOptions?: SttOptions;
  defaultTtsOptions?: TtsOptions;
  playbackQueue?: StreamingAudioQueue;
  speaker?: Speaker;
  responseProcessor?: ResponseProcessor;
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
  private readonly playbackQueue: StreamingAudioQueue;
  private readonly speaker: Speaker | undefined;
  private readonly responseProcessor: ResponseProcessor;
  private readonly listeners = new Set<VoiceManagerListener>();
  private readonly wakeWordListener: WakeWordListener;
  private readonly speakerListener: SpeakerListener | undefined;

  private state: VoiceManagerState = 'idle';
  private pipelineTask: Promise<VoiceInteractionResult> | undefined;
  private started = false;

  public constructor(config: VoiceManagerConfig) {
    const runtimeConfig = this.resolveRuntimeConfig(config);

    this.gateway = config.gateway;
    this.sttProvider = this.createSttProvider(config, runtimeConfig);
    this.ttsProvider = this.createTtsProvider(config, runtimeConfig);
    this.wakeWordProvider = this.createWakeWordProvider(config, runtimeConfig);
    this.captureAudio = config.captureAudio;
    this.defaultSttOptions = config.defaultSttOptions ?? {};
    this.defaultTtsOptions = config.defaultTtsOptions ?? {};
    this.playbackQueue = config.playbackQueue ?? new StreamingAudioQueue();
    this.speaker = config.speaker;
    this.responseProcessor = config.responseProcessor ?? new ResponseProcessor();
    this.wakeWordListener = (event) => {
      void this.handleWakeWordEvent(event);
    };
    this.speakerListener = this.speaker === undefined
      ? undefined
      : (event) => {
          this.handleSpeakerEvent(event);
        };
    this.playbackQueue.onEvent((event) => {
      this.handlePlaybackQueueEvent(event);
    });
    this.speakerListener && this.speaker?.onEvent(this.speakerListener);
  }

  private resolveRuntimeConfig(config: VoiceManagerConfig): RuntimeConfig | undefined {
    if (config.runtimeConfig !== undefined) {
      return config.runtimeConfig;
    }

    if (
      config.sttProvider === undefined ||
      config.ttsProvider === undefined
    ) {
      return loadConfig();
    }

    return undefined;
  }

  private createSttProvider(
    config: VoiceManagerConfig,
    runtimeConfig: RuntimeConfig | undefined,
  ): SttProvider {
    if (config.sttProvider !== undefined) {
      return config.sttProvider;
    }

    if (runtimeConfig !== undefined) {
      return new FasterWhisperProvider({
        baseUrl: runtimeConfig.voice.fasterWhisper.url,
      });
    }

    throw new Error(
      'Voice manager requires either sttProvider or runtimeConfig to initialize.',
    );
  }

  private createTtsProvider(
    config: VoiceManagerConfig,
    runtimeConfig: RuntimeConfig | undefined,
  ): TtsProvider {
    if (config.ttsProvider !== undefined) {
      return config.ttsProvider;
    }

    if (runtimeConfig !== undefined) {
      return new ChatterboxProvider({
        baseUrl: runtimeConfig.voice.chatterbox.url,
      });
    }

    throw new Error(
      'Voice manager requires either ttsProvider or runtimeConfig to initialize.',
    );
  }

  private createWakeWordProvider(
    config: VoiceManagerConfig,
    runtimeConfig: RuntimeConfig | undefined,
  ): WakeWordProvider | undefined {
    if (config.wakeWordProvider !== undefined) {
      return config.wakeWordProvider;
    }

    if (runtimeConfig === undefined) {
      return undefined;
    }

    return new PorcupineProvider({
      accessKey: runtimeConfig.voice.porcupine.accessKey,
      keywords: [runtimeConfig.voice.porcupine.wakeWord],
    });
  }

  public get currentState(): VoiceManagerState {
    return this.state;
  }

  public get isRunning(): boolean {
    return this.started;
  }

  public get audioQueue(): StreamingAudioQueue {
    return this.playbackQueue;
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
    this.speaker?.start();

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
      await this.speaker?.stop();
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

    try {
      if (this.wakeWordProvider !== undefined) {
        this.wakeWordProvider.removeListener(this.wakeWordListener);
        await this.wakeWordProvider.stop();
      }
    } finally {
      await this.speaker?.stop();
      this.setState('idle');
    }
  }

  public async processAudio(
    audio: Buffer,
    options: VoiceInteractionOptions = {},
  ): Promise<VoiceInteractionResult> {
    return this.processCaptureResult({ audio }, options);
  }

  private async processCaptureResult(
    capture: VoiceCaptureResult,
    options: VoiceInteractionOptions,
  ): Promise<VoiceInteractionResult> {
    if (this.pipelineTask !== undefined) {
      throw new Error('Voice pipeline is already processing another request');
    }

    const task = this.runPipeline(capture, options);
    this.pipelineTask = task;

    try {
      return await task;
    } finally {
      this.pipelineTask = undefined;
      this.setState(this.getRestingState());
    }
  }

  public async speak(text: string, options: TtsOptions = {}): Promise<Buffer> {
    this.setState('synthesizing');

    try {
      const processedResponse = this.responseProcessor.process(text);
      const audio = await this.synthesizeForPlayback(processedResponse, {
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
      this.setState(this.getRestingState());
    }
  }

  private async runPipeline(
    capture: VoiceCaptureResult,
    options: VoiceInteractionOptions,
  ): Promise<VoiceInteractionResult> {
    try {
      this.setState('transcribing');
      const sttResult = await this.transcribeCapture(capture, {
        ...this.defaultSttOptions,
        ...options.stt,
      });

      this.emit({
        type: 'transcription',
        text: sttResult.text,
        wakeWord: options.wakeWord,
      });

      this.setState('thinking');
      const thinkingSoundTask = this.playThinkingSound(sttResult.text, {
        ...this.defaultTtsOptions,
        ...options.tts,
      });
      const response = await this.gateway.chat(sttResult.text);
      await thinkingSoundTask;

      this.emit({
        type: 'response',
        text: response,
        wakeWord: options.wakeWord,
      });

      this.setState('synthesizing');
      const processedResponse = this.responseProcessor.process(response);
      const spokenAudio = await this.synthesizeForPlayback(processedResponse, {
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

      await this.processCaptureResult(normalized, {
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

  private async transcribeCapture(
    capture: VoiceCaptureResult,
    options: SttOptions,
  ): Promise<SttResult> {
    if (
      capture.audioStream !== undefined &&
      this.sttProvider.supportsStreaming &&
      this.sttProvider.streamTranscribe !== undefined
    ) {
      let latestResult: SttResult | undefined;

      for await (const result of this.sttProvider.streamTranscribe(
        capture.audioStream,
      )) {
        latestResult = result;
      }

      if (latestResult !== undefined) {
        return latestResult;
      }
    }

    const audio = await this.resolveCapturedAudio(capture);

    return this.sttProvider.transcribe(audio, options);
  }

  private async resolveCapturedAudio(capture: VoiceCaptureResult): Promise<Buffer> {
    if (capture.audio !== undefined) {
      return capture.audio;
    }

    if (capture.audioPromise !== undefined) {
      return capture.audioPromise;
    }

    throw new Error('Voice capture did not provide any audio to transcribe');
  }

  private async playThinkingSound(
    input: string,
    options: TtsOptions,
  ): Promise<void> {
    const thinkingSound = getThinkingSound(input);

    if (thinkingSound.trim().length === 0) {
      return;
    }

    try {
      const processedResponse = this.responseProcessor.process(thinkingSound);
      await this.synthesizeForPlayback(processedResponse, options);
    } catch (error: unknown) {
      this.emit({
        type: 'error',
        error: this.toError(error, 'Thinking sound playback failed'),
      });
    }
  }

  private async synthesizeForPlayback(
    response: ProcessedVoiceResponse,
    options: TtsOptions,
  ): Promise<Buffer> {
    const resolvedOptions = this.resolveTtsOptions(response, options);
    const sentences = this.getPlayableSentences(response);
    const audioChunks: Buffer[] = [];

    for (const sentence of sentences) {
      if (sentence.taggedText.trim().length === 0) {
        continue;
      }

      const audio = await this.synthesizeSentenceForPlayback(
        sentence,
        resolvedOptions,
      );
      audioChunks.push(audio);
    }

    return Buffer.concat(audioChunks);
  }

  private getPlayableSentences(
    response: ProcessedVoiceResponse,
  ): ProcessedVoiceResponse['sentences'] {
    if (response.sentences.length > 0) {
      return response.sentences;
    }

    if (response.taggedText.trim().length === 0) {
      return [];
    }

    return [
      {
        index: 0,
        text: response.plainText,
        taggedText: response.taggedText,
        emotion: response.emotion.primary,
      },
    ];
  }

  private async synthesizeSentenceForPlayback(
    sentence: ProcessedVoiceResponse['sentences'][number],
    options: TtsOptions,
  ): Promise<Buffer> {
    if (
      this.ttsProvider.supportsStreaming &&
      this.ttsProvider.streamSynthesize !== undefined
    ) {
      const sourceStream = this.ttsProvider.streamSynthesize(
        sentence.taggedText,
        options,
      );
      const collectedStream = this.createCollectedStream(sourceStream);

      this.playbackQueue.enqueueStream(collectedStream.stream, {
        text: sentence.text,
        voice: options.voice,
      });

      return collectedStream.completed;
    }

    const audio = await this.ttsProvider.synthesize(sentence.taggedText, options);

    this.playbackQueue.enqueue(audio, {
      text: sentence.text,
      voice: options.voice,
    });

    return audio;
  }

  private resolveTtsOptions(
    response: ProcessedVoiceResponse,
    options: TtsOptions,
  ): TtsOptions {
    return {
      ...options,
      exaggeration:
        options.exaggeration ?? response.emotion.chatterboxExaggeration,
    };
  }

  private createCollectedStream(
    source: AsyncIterable<Buffer>,
  ): { stream: AsyncIterable<Buffer>; completed: Promise<Buffer> } {
    const chunks: Buffer[] = [];
    let resolveCompleted: ((audio: Buffer) => void) | undefined;
    let rejectCompleted: ((error: Error) => void) | undefined;
    const completed = new Promise<Buffer>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = (error) => {
        reject(error);
      };
    });

    return {
      stream: this.collectStream(
        source,
        chunks,
        (audio) => {
          resolveCompleted?.(audio);
        },
        (error) => {
          rejectCompleted?.(error);
        },
      ),
      completed,
    };
  }

  private async *collectStream(
    source: AsyncIterable<Buffer>,
    chunks: Buffer[],
    resolveCompleted: (audio: Buffer) => void,
    rejectCompleted: (error: Error) => void,
  ): AsyncIterable<Buffer> {
    try {
      for await (const chunk of source) {
        chunks.push(chunk);
        yield chunk;
      }

      resolveCompleted(Buffer.concat(chunks));
    } catch (error: unknown) {
      const streamingError = this.toError(error, 'Streaming synthesis failed');

      rejectCompleted(streamingError);
      throw streamingError;
    }
  }

  private handlePlaybackQueueEvent(event: StreamingAudioQueueEvent): void {
    if (event.type === 'item_started') {
      this.setState('playing');
      return;
    }

    if (event.type === 'chunk' && event.chunk !== undefined) {
      this.emit({
        type: 'audio_chunk',
        audio: event.chunk,
      });
      return;
    }

    if (event.type === 'error' && event.error !== undefined) {
      this.handleError(event.error);
      return;
    }

    if (
      event.type === 'queue_drained' &&
      this.pipelineTask === undefined
    ) {
      this.setState(this.getRestingState());
    }
  }

  private handleSpeakerEvent(event: { type: string; error?: Error }): void {
    if (event.type === 'error' && event.error !== undefined) {
      this.handleError(event.error);
      return;
    }

    if (this.pipelineTask === undefined) {
      this.setState(this.getRestingState());
    }
  }

  private getRestingState(): VoiceManagerState {
    if (
      this.speaker?.isPlaying === true ||
      this.playbackQueue.isPlaying ||
      this.playbackQueue.pendingItems > 0
    ) {
      return 'playing';
    }

    return this.wakeWordProvider?.isListening === true ? 'listening' : 'idle';
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
