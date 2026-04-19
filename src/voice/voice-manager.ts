import { setTimeout as delay } from 'node:timers/promises';

import { loadConfig, type RuntimeConfig } from '../core/config.js';
import { Gateway } from '../core/gateway.js';
import { TimingTracker } from '../core/timing.js';
import { ChatterboxProvider } from './providers/chatterbox.js';
import { FasterWhisperProvider } from './providers/faster-whisper.js';
import { PorcupineProvider } from './providers/porcupine.js';
import type { SttDebugInfo, SttOptions, SttProvider, SttResult } from './providers/stt.js';
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
  | 'transcription_partial'
  | 'first_token'
  | 'response_partial'
  | 'sentence_ready'
  | 'tts_request_started'
  | 'tts_first_audio_ready'
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
  timingTracker?: TimingTracker;
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
  timingTracker?: TimingTracker;
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

interface TtsRetryState {
  failures: number;
}

const TTS_MAX_FAILURES = 3;
const TTS_INITIAL_BACKOFF_MS = 250;

class VoicePipelineInterruptedError extends Error {
  public constructor(message: string = 'Voice pipeline interrupted') {
    super(message);
    this.name = 'VoicePipelineInterruptedError';
  }
}

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
  speechSegmentationStrategy?: 'conservative' | 'aggressive';
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
  private readonly speechSegmentationStrategy: 'conservative' | 'aggressive';
  private readonly listeners = new Set<VoiceManagerListener>();
  private readonly wakeWordListener: WakeWordListener;
  private readonly speakerListener: SpeakerListener | undefined;

  private state: VoiceManagerState = 'idle';
  private pipelineTask: Promise<unknown> | undefined;
  private pipelineAbortController: AbortController | undefined;
  private pendingTimingTracker: TimingTracker | undefined;
  private firstTtsRequestStartedEmitted = false;
  private firstTtsAudioReadyEmitted = false;
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
    this.speechSegmentationStrategy =
      config.speechSegmentationStrategy ?? 'aggressive';
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

    const keywords = runtimeConfig.voice.porcupine.wakeWords.length > 0
      ? runtimeConfig.voice.porcupine.wakeWords
      : [runtimeConfig.voice.porcupine.wakeWord];

    if (keywords.every((keyword) => keyword.trim().length === 0)) {
      return undefined;
    }

    return new PorcupineProvider({
      baseUrl: runtimeConfig.voice.porcupine.url,
      keywords,
    });
  }

  public get currentState(): VoiceManagerState {
    return this.state;
  }

  public get sttDebugInfo(): SttDebugInfo | null {
    return this.sttProvider.getLastDebugInfo?.() ?? null;
  }

  public get isRunning(): boolean {
    return this.started;
  }

  public get audioQueue(): StreamingAudioQueue {
    return this.playbackQueue;
  }

  public async warmupTts(): Promise<void> {
    await this.ttsProvider.warmup?.();
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
      this.setState(this.getRestingState());
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
    await this.interruptCurrentInteraction();

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
    return this.processCaptureResult({
      audio,
      timingTracker: new TimingTracker(),
    }, options);
  }

  public async transcribeAudio(
    audio: Buffer,
    options: SttOptions = {},
  ): Promise<SttResult> {
    return this.sttProvider.transcribe(audio, {
      ...this.defaultSttOptions,
      ...options,
      timingTracker: options.timingTracker,
    });
  }

  public async processCapture(
    capture: VoiceCaptureResult,
    options: VoiceInteractionOptions = {},
  ): Promise<VoiceInteractionResult> {
    return this.processCaptureResult(capture, this.mergeCaptureOptions(capture, options));
  }

  public async respondToText(
    userMessage: string,
    options: {
      tts?: TtsOptions;
    } = {},
  ): Promise<string> {
    if (this.pipelineTask !== undefined) {
      throw new Error('Voice pipeline is already processing another request');
    }

    const abortController = new AbortController();
    const timingTracker = new TimingTracker();
    this.resetInteractionMetrics();
    const task = this.runTextPipeline(
      userMessage,
      {
        ...this.defaultTtsOptions,
        ...options.tts,
        signal: abortController.signal,
        timingTracker,
      },
      abortController.signal,
      timingTracker,
    );
    this.pipelineTask = task;
    this.pipelineAbortController = abortController;

    try {
      return await task;
    } finally {
      this.pipelineTask = undefined;
      this.pipelineAbortController = undefined;
      this.flushTimingReportIfReady();
      this.setState(this.getRestingState());
    }
  }

  public async interruptCurrentInteraction(): Promise<void> {
    const pipelineTask = this.pipelineTask;

    this.pipelineAbortController?.abort();
    this.playbackQueue.clear();
    await this.speaker?.interrupt();

    if (pipelineTask !== undefined) {
      await pipelineTask.catch(() => undefined);
    }

    this.pendingTimingTracker = undefined;
    this.setState(this.getRestingState());
  }

  private async processCaptureResult(
    capture: VoiceCaptureResult,
    options: VoiceInteractionOptions,
  ): Promise<VoiceInteractionResult> {
    if (this.pipelineTask !== undefined) {
      throw new Error('Voice pipeline is already processing another request');
    }

    const abortController = new AbortController();
    this.resetInteractionMetrics();
    const task = this.runPipeline(capture, options, abortController.signal);
    this.pipelineTask = task;
    this.pipelineAbortController = abortController;

    try {
      return await task;
    } finally {
      this.pipelineTask = undefined;
      this.pipelineAbortController = undefined;
      this.flushTimingReportIfReady();
      this.setState(this.getRestingState());
    }
  }

  public async speak(text: string, options: TtsOptions = {}): Promise<Buffer> {
    this.setState('synthesizing');
    this.resetInteractionMetrics();

    try {
      const processedResponse = this.responseProcessor.process(text);
      const audio = await this.synthesizeForPlayback(processedResponse, {
        ...this.defaultTtsOptions,
        ...options,
      }, this.createTtsRetryState());

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
    signal: AbortSignal,
  ): Promise<VoiceInteractionResult> {
    try {
      const timingTracker = capture.timingTracker ?? new TimingTracker();
      this.setState('transcribing');
      const sttResult = await this.transcribeCapture(capture, {
        ...capture.sttOptions,
        ...this.defaultSttOptions,
        ...options.stt,
        timingTracker,
      });
      this.throwIfInterrupted(signal);

      this.emit({
        type: 'transcription',
        text: sttResult.text,
        wakeWord: options.wakeWord,
      });

      const ttsOptions = {
        ...this.defaultTtsOptions,
        ...options.tts,
        signal,
        timingTracker,
      };
      const responseResult = await this.streamAssistantResponse(
        sttResult.text,
        ttsOptions,
        signal,
        timingTracker,
      );

      this.emit({
        type: 'response',
        text: responseResult.response,
        wakeWord: options.wakeWord,
      });

      const result: VoiceInteractionResult = {
        wakeWord: options.wakeWord,
        transcription: sttResult.text,
        response: responseResult.response,
        audio: responseResult.audio,
        sttResult,
        timingTracker,
      };

      this.emit({
        type: 'audio',
        audio: responseResult.audio,
        wakeWord: options.wakeWord,
        result,
      });

      return result;
    } catch (error: unknown) {
      if (this.isInterruptedError(error)) {
        throw error;
      }

      this.handleError(this.toError(error, 'Voice pipeline failed'));
      throw error;
    }
  }

  private async runTextPipeline(
    userMessage: string,
    ttsOptions: TtsOptions,
    signal: AbortSignal,
    timingTracker: TimingTracker,
  ): Promise<string> {
    try {
      const responseResult = await this.streamAssistantResponse(
        userMessage,
        ttsOptions,
        signal,
        timingTracker,
      );

      this.emit({
        type: 'response',
        text: responseResult.response,
      });
      this.emit({
        type: 'audio',
        audio: responseResult.audio,
      });

      return responseResult.response;
    } catch (error: unknown) {
      if (this.isInterruptedError(error)) {
        throw error;
      }

      this.handleError(this.toError(error, 'Voice text pipeline failed'));
      throw error;
    }
  }

  private async handleWakeWordEvent(event: WakeWordEvent): Promise<void> {
    if (event.type === 'ready') {
      this.setState(this.getRestingState());
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

  private mergeCaptureOptions(
    capture: VoiceCaptureResult,
    options: VoiceInteractionOptions,
  ): VoiceInteractionOptions {
    return {
      ...options,
      stt: {
        ...capture.sttOptions,
        ...options.stt,
      },
    };
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
        options,
      )) {
        latestResult = result;
        this.emit({
          type: 'transcription_partial',
          text: result.text,
        });
      }

      if (latestResult !== undefined) {
        return latestResult;
      }
    }

    const audio = await this.resolveCapturedAudio(capture);

    return this.sttProvider.transcribe(audio, this.toBufferedAudioSttOptions(options));
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

  private async streamAssistantResponse(
    userMessage: string,
    ttsOptions: TtsOptions,
    signal: AbortSignal,
    timingTracker: TimingTracker,
  ): Promise<{ response: string; audio: Buffer }> {
    this.setState('thinking');
    const retryState = this.createTtsRetryState();
    const sentenceAudioTasks: Array<Promise<Buffer>> = [];
    const responseChunks: string[] = [];
    let bufferedText = '';
    let partialResponse = '';
    let firstTokenEmitted = false;
    let firstSentenceReadyEmitted = false;

    for await (const chunk of this.gateway.streamChat(userMessage, {
      signal,
      timingTracker,
    })) {
      this.throwIfInterrupted(signal);

      if (chunk.type !== 'text' || chunk.text === undefined) {
        continue;
      }

      responseChunks.push(chunk.text);
      bufferedText += chunk.text;
      partialResponse += chunk.text;

      this.emit({
        type: 'response_partial',
        text: partialResponse,
      });

      if (!firstTokenEmitted) {
        firstTokenEmitted = true;
        this.emit({
          type: 'first_token',
          text: chunk.text,
        });
      }

      const extracted = this.extractReadySpeechSegments(bufferedText);

      bufferedText = extracted.remainder;

      for (const sentence of extracted.sentences) {
        this.throwIfInterrupted(signal);
        if (!firstSentenceReadyEmitted) {
          firstSentenceReadyEmitted = true;
          this.emit({
            type: 'sentence_ready',
            text: sentence,
          });
        }
        this.setState('synthesizing');
        sentenceAudioTasks.push(
          this.speakStreamingSentence(sentence, ttsOptions, signal, retryState),
        );
      }
    }

    const trailingSentence = bufferedText.trim();

    if (trailingSentence.length > 0) {
      this.throwIfInterrupted(signal);
      if (!firstSentenceReadyEmitted) {
        firstSentenceReadyEmitted = true;
        this.emit({
          type: 'sentence_ready',
          text: trailingSentence,
        });
      }
      this.setState('synthesizing');
      sentenceAudioTasks.push(
        this.speakStreamingSentence(trailingSentence, ttsOptions, signal, retryState),
      );
    }

    const response = responseChunks.join('');
    this.throwIfInterrupted(signal);
    this.pendingTimingTracker = timingTracker;

    return {
      response,
      audio: Buffer.concat(await Promise.all(sentenceAudioTasks)),
    };
  }

  private async synthesizeForPlayback(
    response: ProcessedVoiceResponse,
    options: TtsOptions,
    retryState: TtsRetryState,
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
        retryState,
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
    retryState: TtsRetryState,
  ): Promise<Buffer> {
    if (retryState.failures >= TTS_MAX_FAILURES) {
      throw new Error(
        `TTS synthesis is disabled after ${TTS_MAX_FAILURES} consecutive failures`,
      );
    }

    let attempt = 0;

    while (attempt < TTS_MAX_FAILURES) {
      this.throwIfAborted(options.signal);
      attempt += 1;

      try {
        const audio = await this.synthesizeSentenceForPlaybackOnce(sentence, options);

        retryState.failures = 0;
        return audio;
      } catch (error: unknown) {
        if (this.isInterruptedError(error)) {
          throw error;
        }

        retryState.failures += 1;
        const resolvedError = this.toError(error, 'TTS synthesis failed');

        if (retryState.failures >= TTS_MAX_FAILURES || attempt >= TTS_MAX_FAILURES) {
          throw new Error(
            `TTS synthesis failed after ${retryState.failures} consecutive failures: ${resolvedError.message}`,
          );
        }

        const backoffMs = TTS_INITIAL_BACKOFF_MS * (2 ** (attempt - 1));

        console.warn(
          `[voice] TTS synthesis failed (attempt ${attempt}/${TTS_MAX_FAILURES}, consecutive=${retryState.failures}). ` +
          `Retrying in ${backoffMs}ms: ${resolvedError.message}`,
        );

        await this.waitWithAbort(backoffMs, options.signal);
      }
    }

    throw new Error('TTS synthesis failed after exhausting retries');
  }

  private async synthesizeSentenceForPlaybackOnce(
    sentence: ProcessedVoiceResponse['sentences'][number],
    options: TtsOptions,
  ): Promise<Buffer> {
    if (!this.firstTtsRequestStartedEmitted) {
      this.firstTtsRequestStartedEmitted = true;
      this.emit({
        type: 'tts_request_started',
        text: sentence.text,
      });
    }

    if (
      this.ttsProvider.supportsStreaming &&
      this.ttsProvider.streamSynthesize !== undefined
    ) {
      const sourceStream = this.ttsProvider.streamSynthesize(
        sentence.taggedText,
        options,
      );
      const collectedStream = this.createPrefetchedStream(sourceStream);

      this.playbackQueue.enqueueStream(collectedStream.stream, {
        text: sentence.text,
        timingTracker: options.timingTracker,
        voice: options.voice,
      });

      return collectedStream.completed;
    }

    const audio = await this.ttsProvider.synthesize(sentence.taggedText, options);

    this.playbackQueue.enqueue(audio, {
      text: sentence.text,
      timingTracker: options.timingTracker,
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

  private async speakStreamingSentence(
    text: string,
    options: TtsOptions,
    signal: AbortSignal,
    retryState: TtsRetryState,
  ): Promise<Buffer> {
    this.throwIfInterrupted(signal);
    const processedResponse = this.responseProcessor.process(text);

    return this.synthesizeForPlayback(processedResponse, options, retryState);
  }

  private extractReadySpeechSegments(
    text: string,
  ): { sentences: string[]; remainder: string } {
    return this.speechSegmentationStrategy === 'conservative'
      ? extractConservativeSpeechSegments(text)
      : extractAggressiveSpeechSegments(text);
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
      rejectCompleted = (error) => {
        reject(error);
      };
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
      const streamingError = this.toError(error, 'Streaming synthesis failed');

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
      const waiter = waiters.shift();

      waiter?.();
    }
  }

  private handlePlaybackQueueEvent(event: StreamingAudioQueueEvent): void {
    if (event.type === 'item_started') {
      this.setState('playing');
      return;
    }

    if (event.type === 'chunk' && event.chunk !== undefined) {
      if (!this.firstTtsAudioReadyEmitted) {
        this.firstTtsAudioReadyEmitted = true;
        this.emit({
          type: 'tts_first_audio_ready',
          audio: event.chunk,
        });
      }

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
      this.flushTimingReportIfReady();
      this.setState(this.getRestingState());
    }
  }

  private handleSpeakerEvent(event: { type: string; error?: Error }): void {
    if (event.type === 'error' && event.error !== undefined) {
      if (this.isInterruptedError(event.error)) {
        return;
      }

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

  private toBufferedAudioSttOptions(options: SttOptions): SttOptions {
    if (options.encoding !== 'pcm_s16le') {
      return options;
    }

    return {
      language: options.language,
      prompt: options.prompt,
      encoding: 'wav',
      timingTracker: options.timingTracker,
    };
  }

  private throwIfInterrupted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new VoicePipelineInterruptedError();
    }
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
      throw new VoicePipelineInterruptedError();
    }
  }

  private isInterruptedError(error: unknown): boolean {
    return (
      error instanceof VoicePipelineInterruptedError ||
      (error instanceof Error && error.name === 'AbortError')
    );
  }

  private createTtsRetryState(): TtsRetryState {
    return {
      failures: 0,
    };
  }

  private resetInteractionMetrics(): void {
    this.firstTtsRequestStartedEmitted = false;
    this.firstTtsAudioReadyEmitted = false;
  }

  private flushTimingReportIfReady(): void {
    if (
      this.pipelineTask !== undefined ||
      this.playbackQueue.isPlaying ||
      this.playbackQueue.pendingItems > 0
    ) {
      return;
    }

    const timingReport = this.pendingTimingTracker?.report();

    if (timingReport !== undefined && timingReport.length > 0) {
      console.log(timingReport);
    }

    this.pendingTimingTracker = undefined;
  }

  private async waitWithAbort(
    milliseconds: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      await delay(milliseconds, undefined, signal === undefined ? undefined : { signal });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new VoicePipelineInterruptedError();
      }

      throw error;
    }
  }
}

const EARLY_SPEECH_MIN_CHARS = 32;
const EARLY_SPEECH_MIN_WORDS = 5;
const EARLY_SPEECH_FORCE_CHARS = 48;

export function extractConservativeSpeechSegments(
  text: string,
): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  let startIndex = 0;
  let index = 0;

  while (index < text.length) {
    const current = text[index];

    if (
      current !== '.' &&
      current !== '!' &&
      current !== '?'
    ) {
      index += 1;
      continue;
    }

    let endIndex = index + 1;

    while (
      endIndex < text.length &&
      isSentencePunctuation(text[endIndex] ?? '')
    ) {
      endIndex += 1;
    }

    while (
      endIndex < text.length &&
      isTrailingSentenceCloser(text[endIndex] ?? '')
    ) {
      endIndex += 1;
    }

    const nextCharacter = text[endIndex];

    if (nextCharacter !== undefined && !/\s/u.test(nextCharacter)) {
      index += 1;
      continue;
    }

    const sentence = text.slice(startIndex, endIndex).trim();

    if (sentence.length > 0) {
      sentences.push(sentence);
    }

    while (endIndex < text.length && /\s/u.test(text[endIndex] ?? '')) {
      endIndex += 1;
    }

    startIndex = endIndex;
    index = endIndex;
  }

  return {
    sentences,
    remainder: text.slice(startIndex),
  };
}

export function extractAggressiveSpeechSegments(
  text: string,
): { sentences: string[]; remainder: string } {
  const conservative = extractConservativeSpeechSegments(text);

  if (conservative.sentences.length > 0) {
    return conservative;
  }

  const earlySplitIndex = findEarlySpeechSplitIndex(text);

  if (earlySplitIndex === null) {
    return conservative;
  }

  const sentence = text.slice(0, earlySplitIndex).trim();
  const remainder = text.slice(earlySplitIndex).trimStart();

  if (sentence.length === 0) {
    return conservative;
  }

  return {
    sentences: [sentence],
    remainder,
  };
}

function findEarlySpeechSplitIndex(text: string): number | null {
  const trimmed = text.trim();

  if (
    trimmed.length < EARLY_SPEECH_MIN_CHARS ||
    countWords(trimmed) < EARLY_SPEECH_MIN_WORDS
  ) {
    return null;
  }

  const clauseMatches = [...text.matchAll(/[,;:]\s+/gu)];

  for (let index = clauseMatches.length - 1; index >= 0; index -= 1) {
    const match = clauseMatches[index];

    if (match === undefined) {
      continue;
    }

    const candidateEnd = (match.index ?? -1) + 1;
    const candidate = text.slice(0, candidateEnd).trim();

    if (
      candidate.length >= EARLY_SPEECH_MIN_CHARS &&
      countWords(candidate) >= EARLY_SPEECH_MIN_WORDS
    ) {
      return candidateEnd;
    }
  }

  const endsAtSoftBoundary = /[\s"'”’)\]]$/u.test(text);

  if (!endsAtSoftBoundary && trimmed.length < EARLY_SPEECH_FORCE_CHARS) {
    return null;
  }

  const trailingWhitespace = text.length - text.trimEnd().length;

  return text.length - trailingWhitespace;
}

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .length;
}

function isSentencePunctuation(value: string): boolean {
  return value === '.' || value === '!' || value === '?';
}

function isTrailingSentenceCloser(value: string): boolean {
  return value === '"' || value === '\'' || value === ')' || value === ']';
}
