import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setInterval } from 'node:timers';

import type { RuntimeConfig } from '../core/config.js';
import {
  type RuntimeServiceName,
  RuntimeStateStore,
  type SonnyRuntimeState,
} from '../core/runtime-state.js';
import type { Gateway } from '../core/gateway.js';
import {
  type VoiceManagerEvent,
  type VoiceManagerState,
} from './voice-manager.js';
import {
  ManualRecorderError,
  ManualRecorderSession,
  type RecorderDebugInfo,
  type RecorderDiagnosticEvent,
} from './manual-recorder.js';
import type { SttDebugInfo, SttFailureReason } from './providers/stt.js';
import {
  type VoiceEnvironmentConfig,
  type VoiceGateway,
} from './voice-gateway.js';

const DEFAULT_HEALTH_POLL_MS = 15_000;
const DEBUG_AUDIO_DIR = join(tmpdir(), 'sonny-debug');
const DEBUG_AUDIO_FILE = join(DEBUG_AUDIO_DIR, 'last-manual-recording.wav');
const MIN_RECORDING_BYTES = 4_096;
const MIN_RECORDING_DURATION_MS = 250;
const TARGET_RECORDING_SAMPLE_RATE_HERTZ = 16_000;
const TARGET_RECORDING_CHANNELS = 1;
const TARGET_RECORDING_ENCODING = 'pcm_s16le';
const TARGET_RECORDING_FORMAT = 'wav';

type PipelineStageName = 'recording' | 'stt' | 'gateway' | 'tts' | 'playback';
type PipelineStageStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'interrupted';
type FlowKind = 'manual' | 'tts';
type AudioQualityHint =
  | 'ok'
  | 'too_quiet'
  | 'mostly_silence'
  | 'too_short'
  | 'invalid_format';

export interface VoiceSessionOrchestratorConfig {
  gateway: Gateway;
  voiceGateway: VoiceGateway;
  runtimeConfig: RuntimeConfig;
  environmentConfig: VoiceEnvironmentConfig;
  runtimeState: RuntimeStateStore;
  healthPollMs?: number;
}

export interface LastAudioDebugInfo {
  exists: boolean;
  path: string | null;
  size: number | null;
  byteLength: number | null;
  durationMs: number | null;
  sampleRate: number | null;
  channels: number | null;
  bitsPerSample: number | null;
  encoding: string | null;
  format: string | null;
  peakAmplitude: number | null;
  rmsLevel: number | null;
  silentRatio: number | null;
  suspectedSilent: boolean | null;
  audioQualityHint: AudioQualityHint | null;
  targetSampleRate: number;
  targetChannels: number;
  targetEncoding: string;
  targetFormat: string;
  matchesWhisperInputTarget: boolean | null;
  whisperInputRisk: string | null;
  device: string | null;
  usingDefaultDevice: boolean;
  createdAt: string | null;
}

export interface PipelineStageDebug {
  status: PipelineStageStatus;
  error: string | null;
  updatedAt: string | null;
}

export interface VoiceLatencyTimestamps {
  stopListeningAt: string | null;
  sttStartedAt: string | null;
  sttFinishedAt: string | null;
  gatewayStartedAt: string | null;
  firstTokenAt: string | null;
  firstSentenceReadyAt: string | null;
  ttsRequestStartedAt: string | null;
  ttsFirstAudioReadyAt: string | null;
  ttsFinishedAt: string | null;
  playbackStartedAt: string | null;
  playbackFinishedAt: string | null;
}

export interface VoiceLatencyDurations {
  sttLatencyMs: number | null;
  gatewayToFirstTokenMs: number | null;
  gatewayToFirstSentenceMs: number | null;
  ttsToFirstAudioMs: number | null;
  ttsFullSynthesisMs: number | null;
  stopToFirstSoundMs: number | null;
  stopToPlaybackFinishedMs: number | null;
}

export interface VoicePipelineDebugInfo {
  recording: PipelineStageDebug;
  stt: PipelineStageDebug;
  gateway: PipelineStageDebug;
  tts: PipelineStageDebug;
  playback: PipelineStageDebug;
  latency: {
    timestamps: VoiceLatencyTimestamps;
    durations: VoiceLatencyDurations;
  };
  sttDebug: {
    requestUrl: string | null;
    httpStatus: number | null;
    contentType: string | null;
    responseKeys: string[];
    rawBodyPreview: string | null;
    transcript: string | null;
    transcriptLength: number | null;
    failureReason: SttFailureReason | null;
  };
  flow: FlowKind | null;
  updatedAt: string | null;
}

export interface RecorderRuntimeDebugInfo extends RecorderDebugInfo {}

export interface RetranscribeLastAudioResult {
  transcript: string;
  transcriptLength: number;
  sttDebug: VoicePipelineDebugInfo['sttDebug'];
}

export class VoiceSessionOrchestrator {
  private readonly gateway: Gateway;
  private readonly voiceGateway: VoiceGateway;
  private readonly runtimeConfig: RuntimeConfig;
  private readonly environmentConfig: VoiceEnvironmentConfig;
  private readonly runtimeState: RuntimeStateStore;
  private readonly healthPollMs: number;

  private healthTimer: NodeJS.Timeout | undefined;
  private manualRecorder: ManualRecorderSession | undefined;
  private servicesStarted = false;
  private started = false;
  private activeFlow: FlowKind | null = null;
  private activeFailureStage: PipelineStageName | null = null;
  private awaitingPlaybackCompletion = false;
  private playbackStartedForFlow = false;
  private lastReplayText: string | null = null;
  private lastAudioDebug: LastAudioDebugInfo = createEmptyAudioDebug();
  private pipelineDebug: VoicePipelineDebugInfo = createEmptyPipelineDebug();
  private recorderDebug: RecorderRuntimeDebugInfo = createEmptyRecorderDebug();

  public constructor(config: VoiceSessionOrchestratorConfig) {
    this.gateway = config.gateway;
    this.voiceGateway = config.voiceGateway;
    this.runtimeConfig = config.runtimeConfig;
    this.environmentConfig = config.environmentConfig;
    this.runtimeState = config.runtimeState;
    this.healthPollMs = config.healthPollMs ?? DEFAULT_HEALTH_POLL_MS;

    this.voiceGateway.manager.onEvent((event) => {
      void this.handleVoiceManagerEvent(event);
    });
    this.voiceGateway.speaker.onEvent((event) => {
      void this.handleSpeakerEvent(event);
    });
  }

  public get state(): RuntimeStateStore {
    return this.runtimeState;
  }

  public getLastAudioDebug(): LastAudioDebugInfo {
    return { ...this.lastAudioDebug };
  }

  public getPipelineDebug(): VoicePipelineDebugInfo {
    return clonePipelineDebug(this.pipelineDebug);
  }

  public getRecorderDebug(): RecorderRuntimeDebugInfo {
    return {
      ...this.recorderDebug,
    };
  }

  public async retranscribeLastAudio(): Promise<RetranscribeLastAudioResult> {
    if (!this.lastAudioDebug.exists || this.lastAudioDebug.path === null) {
      throw new Error('No saved manual recording is available to re-transcribe.');
    }

    const audio = await readFile(this.lastAudioDebug.path);

    this.log('stt_retranscribe_started', 'Re-transcribing the latest saved recording.', {
      path: this.lastAudioDebug.path,
      bytes: audio.byteLength,
    });

    try {
      const result = await this.voiceGateway.manager.transcribeAudio(audio, {
        language: this.environmentConfig.sttLanguage,
        sampleRateHertz: this.lastAudioDebug.sampleRate ?? this.getSampleRate(),
        channels: this.lastAudioDebug.channels ?? this.getChannels(),
        encoding: 'wav',
      });
      const debug = this.syncSttDebugInfo();

      this.log('stt_retranscribe_finished', 'Re-transcription completed.', {
        transcriptLength: result.text.length,
        ...this.buildSttLogMeta(),
      });

      return {
        transcript: result.text,
        transcriptLength: result.text.length,
        sttDebug: {
          requestUrl: debug?.requestUrl ?? null,
          httpStatus: debug?.httpStatus ?? null,
          contentType: debug?.contentType ?? null,
          responseKeys: debug?.responseKeys ?? [],
          rawBodyPreview: debug?.rawBodyPreview ?? null,
          transcript: debug?.transcript ?? result.text,
          transcriptLength: debug?.transcriptLength ?? result.text.length,
          failureReason: debug?.failureReason ?? null,
        },
      };
    } catch (error: unknown) {
      const message = classifySttError(toErrorMessage(error));

      this.syncSttDebugInfo();
      this.runtimeState.setError(message);
      this.log('stt_retranscribe_failed', message, this.buildSttLogMeta(), 'error');
      throw new Error(message);
    }
  }

  public clearLogs(): void {
    this.runtimeState.clearLogs();
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    await this.hydrateDebugAudioFromDisk();
    this.runtimeState.setCurrentSessionId(this.gateway.currentSession.id);
    this.log('runtime_started', 'Voice control runtime started.');
    await this.ensureServicesReady();
    this.voiceGateway.speaker.start();
    await this.warmupTts();
    await this.refreshHealth();
    this.healthTimer = setInterval(() => {
      void this.refreshHealth();
    }, this.healthPollMs);
    this.healthTimer.unref();
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;

    if (this.healthTimer !== undefined) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }

    if (this.manualRecorder !== undefined) {
      await this.manualRecorder.cancel();
      this.manualRecorder = undefined;
    }

    await this.voiceGateway.manager.interruptCurrentInteraction();
    await this.voiceGateway.speaker.stop();

    if (this.servicesStarted) {
      await this.voiceGateway.stopServices();
      this.servicesStarted = false;
    }

    this.runtimeState.setMicActive(false);
    this.runtimeState.setPlaybackActive(false);
    this.runtimeState.transition('idle', {
      message: 'Voice control runtime stopped.',
      meta: {},
    });
    this.resetFlowState();
  }

  public async startListening(): Promise<void> {
    this.log('manual_listen_started', 'Manual listen requested.');

    try {
      await this.ensureServicesReady();

      if (this.manualRecorder !== undefined) {
        return;
      }

      this.resetPipelineDebug('manual');
      this.markStage('recording', 'running');
      this.manualRecorder = await ManualRecorderSession.start({
        sampleRateHertz: this.getSampleRate(),
        channels: this.getChannels(),
        recorder: this.environmentConfig.micRecordProgram ?? 'sox',
        device:
          this.environmentConfig.audioDeviceIndex === undefined
            ? 'default'
            : `input-index:${this.environmentConfig.audioDeviceIndex}`,
        audioType: 'wav',
        onDiagnosticEvent: (event) => {
          this.handleRecorderDiagnosticEvent(event);
        },
      });
      this.recorderDebug = this.manualRecorder.getDebugInfo();
      this.runtimeState.setMicActive(true);
      this.runtimeState.transition('listening', {
        meta: {},
      });
      this.log('recording_started', 'Manual recording started.', {
        sampleRate: this.getSampleRate(),
        channels: this.getChannels(),
        recorder: this.environmentConfig.micRecordProgram ?? 'sox',
      });
    } catch (error: unknown) {
      if (error instanceof ManualRecorderError) {
        this.recorderDebug = error.diagnostics;
      }

      const message = classifyRecordingStartError(error);

      this.failStage('recording', 'recording_failed', message);
      throw new Error(message);
    }
  }

  public async stopListening(): Promise<void> {
    const recorder = this.manualRecorder;

    this.log('manual_listen_stopped', 'Manual listen stop requested.');

    if (recorder === undefined) {
      return;
    }

    try {
      this.manualRecorder = undefined;
      this.runtimeState.setMicActive(false);
      this.markLatencyTimestamp('stopListeningAt');

      const audio = await recorder.stop();
      this.recorderDebug = recorder.getDebugInfo();
      const audioDebug = await this.persistDebugAudio(audio);

      this.lastAudioDebug = audioDebug;

      this.log('recording_stopped', 'Manual recording stopped.', {
        bytes: audio.byteLength,
      });

      if (audioDebug.exists) {
        this.log('recording_saved', 'Saved latest manual recording.', {
          path: audioDebug.path,
          size: audioDebug.size,
          byteLength: audioDebug.byteLength,
          durationMs: audioDebug.durationMs,
          sampleRate: audioDebug.sampleRate,
          channels: audioDebug.channels,
          bitsPerSample: audioDebug.bitsPerSample,
          format: audioDebug.format,
          encoding: audioDebug.encoding,
          rmsLevel: audioDebug.rmsLevel,
          peakAmplitude: audioDebug.peakAmplitude,
          silentRatio: audioDebug.silentRatio,
          suspectedSilent: audioDebug.suspectedSilent,
          audioQualityHint: audioDebug.audioQualityHint,
          device: audioDebug.device,
        });

        if (audioDebug.whisperInputRisk !== null) {
          this.log(
            'recording_format_warning',
            audioDebug.whisperInputRisk,
            {
              sampleRate: audioDebug.sampleRate,
              channels: audioDebug.channels,
              encoding: audioDebug.encoding,
              format: audioDebug.format,
              targetSampleRate: audioDebug.targetSampleRate,
              targetChannels: audioDebug.targetChannels,
              targetEncoding: audioDebug.targetEncoding,
              targetFormat: audioDebug.targetFormat,
            },
            'warn',
          );
        }
      }

      this.validateRecordedAudio(audio, audioDebug);
      this.markStage('recording', 'succeeded');
      this.markStage('stt', 'running');
      this.activeFailureStage = 'stt';
      this.markLatencyTimestamp('sttStartedAt');
      this.log('stt_started', 'Submitting audio to STT.', {
        bytes: audio.byteLength,
        sampleRate: audioDebug.sampleRate,
        channels: audioDebug.channels,
        ...this.buildLatencyLogMeta(),
      });
      this.runtimeState.transition('transcribing', {
        meta: {},
      });

      await this.voiceGateway.manager.processAudio(audio, {
        stt: {
          language: this.environmentConfig.sttLanguage,
          sampleRateHertz: audioDebug.sampleRate ?? this.getSampleRate(),
          channels: audioDebug.channels ?? this.getChannels(),
          encoding: 'wav',
        },
        tts: {
          voice: this.environmentConfig.ttsVoice,
        },
      });
      this.runtimeState.setCurrentSessionId(this.gateway.currentSession.id);
    } catch (error: unknown) {
      if (error instanceof ManualRecorderError) {
        this.recorderDebug = error.diagnostics;
      }

      if (this.findFailedPipelineStage() !== null) {
        throw error instanceof Error ? error : new Error(toErrorMessage(error));
      }

      const message = toErrorMessage(error);
      const stage = this.activeFailureStage ?? 'recording';

      if (stage === 'recording') {
        this.failStage('recording', 'recording_failed', message);
      } else {
        this.failActiveFlow(stage, message);
      }

      throw error instanceof Error ? error : new Error(message);
    }
  }

  public async testTts(text: string, voice?: string): Promise<void> {
    const normalized = text.trim();

    if (normalized.length === 0) {
      throw new Error('TTS test text must not be empty.');
    }

    await this.ensureServicesReady();
    this.resetPipelineDebug('tts');
    this.activeFailureStage = 'tts';
    this.markStage('tts', 'running');
    this.lastReplayText = normalized;
    this.log('tts_started', 'TTS test started.', {
      textLength: normalized.length,
      voice: voice?.trim().length ? voice.trim() : this.environmentConfig.ttsVoice ?? null,
    });

    try {
      await this.voiceGateway.manager.speak(normalized, {
        voice: voice?.trim().length ? voice.trim() : this.environmentConfig.ttsVoice,
      });
    } catch (error: unknown) {
      this.failStage('tts', 'tts_failed', toErrorMessage(error));
      throw error instanceof Error ? error : new Error(toErrorMessage(error));
    }
  }

  public async replayLastTts(): Promise<void> {
    if (this.lastReplayText === null) {
      throw new Error('No previous TTS text is available to replay.');
    }

    await this.testTts(this.lastReplayText, this.environmentConfig.ttsVoice);
  }

  public async interruptPlayback(): Promise<void> {
    await this.voiceGateway.manager.interruptCurrentInteraction();
    this.runtimeState.setMicActive(false);
    this.runtimeState.setPlaybackActive(false);
    this.runtimeState.markConversationInterrupted();
    this.markStage('playback', 'interrupted');
    this.log('playback_interrupted', 'Playback interrupted.', {});

    if (this.activeFlow === 'manual') {
      this.pipelineDebug.updatedAt = new Date().toISOString();
      this.awaitingPlaybackCompletion = false;
      this.playbackStartedForFlow = false;
    }

    this.activeFlow = null;
    this.activeFailureStage = null;

    this.runtimeState.transition('idle', {
      meta: {},
    });
  }

  public async resetToIdle(): Promise<void> {
    if (this.manualRecorder !== undefined) {
      await this.manualRecorder.cancel();
      this.manualRecorder = undefined;
    }

    await this.voiceGateway.manager.interruptCurrentInteraction();
    this.runtimeState.resetToIdle();
    this.resetFlowState();
    this.log('runtime_reset', 'Runtime reset to idle.', {});
  }

  public async refreshHealth(): Promise<void> {
    await Promise.all([
      this.checkHealth('ollama', `${normalizeBaseUrl(this.runtimeConfig.ollama.baseUrl)}/api/tags`),
      this.checkHealth(
        'stt',
        `${normalizeBaseUrl(this.runtimeConfig.voice.fasterWhisper.url)}/health`,
      ),
      this.checkHealth(
        'tts',
        `${normalizeBaseUrl(this.runtimeConfig.voice.chatterbox.url)}/health`,
      ),
      this.checkHealth(
        'wake_word',
        normalizeOptionalHealthUrl(this.runtimeConfig.voice.porcupine.url),
      ),
      this.checkHealth(
        'vad',
        normalizeOptionalHealthUrl(process.env.VAD_URL ?? 'http://127.0.0.1:8003'),
      ),
    ]);
  }

  private async ensureServicesReady(): Promise<void> {
    if (this.servicesStarted) {
      return;
    }

    try {
      await this.voiceGateway.startServices();
      this.servicesStarted = true;
    } catch (error: unknown) {
      const message = `Failed to start local voice services: ${toErrorMessage(error)}`;

      this.runtimeState.transition('error', {
        error: message,
        meta: {},
      });
      this.runtimeState.setError(message);
      throw new Error(message);
    }
  }

  private async warmupTts(): Promise<void> {
    this.log('tts_warmup_started', 'Warming up TTS model.', {});

    try {
      await this.voiceGateway.manager.warmupTts();
      this.log('tts_warmup_finished', 'TTS warmup completed.', {});
    } catch (error: unknown) {
      this.log(
        'tts_warmup_failed',
        `TTS warmup failed: ${toErrorMessage(error)}`,
        {},
        'warn',
      );
    }
  }

  private async hydrateDebugAudioFromDisk(): Promise<void> {
    try {
      const audio = await readFile(DEBUG_AUDIO_FILE);

      if (audio.byteLength === 0) {
        return;
      }

      const metadata = await stat(DEBUG_AUDIO_FILE);
      const analyzed = analyzeAudioBuffer(audio, this.getSampleRate(), this.getChannels());

      this.lastAudioDebug = {
        exists: true,
        path: DEBUG_AUDIO_FILE,
        size: metadata.size,
        byteLength: audio.byteLength,
        durationMs: analyzed.durationMs,
        sampleRate: analyzed.sampleRate,
        channels: analyzed.channels,
        bitsPerSample: analyzed.bitsPerSample,
        encoding: analyzed.encoding,
        format: analyzed.format,
        peakAmplitude: analyzed.peakAmplitude,
        rmsLevel: analyzed.rmsLevel,
        silentRatio: analyzed.silentRatio,
        suspectedSilent: analyzed.suspectedSilent,
        audioQualityHint: analyzed.audioQualityHint,
        targetSampleRate: analyzed.targetSampleRate,
        targetChannels: analyzed.targetChannels,
        targetEncoding: analyzed.targetEncoding,
        targetFormat: analyzed.targetFormat,
        matchesWhisperInputTarget: analyzed.matchesWhisperInputTarget,
        whisperInputRisk: analyzed.whisperInputRisk,
        device: this.lastAudioDebug.device ?? this.recorderDebug.device,
        usingDefaultDevice: this.lastAudioDebug.usingDefaultDevice,
        createdAt: metadata.mtime.toISOString(),
      };
    } catch {
      // Ignore missing debug audio on startup.
    }
  }

  private async handleVoiceManagerEvent(event: VoiceManagerEvent): Promise<void> {
    if (event.type === 'wake_word_detected' && event.wakeWord !== undefined) {
      this.runtimeState.transition('wake_detected', {
        meta: {
          wakeWord: event.wakeWord,
        },
      });
      this.log('wake_word_detected', `Wake word detected: ${event.wakeWord}`, {
        wakeWord: event.wakeWord,
      });
      return;
    }

    if (event.type === 'first_token' && event.text !== undefined) {
      if (this.pipelineDebug.latency.timestamps.firstTokenAt === null) {
        this.markLatencyTimestamp('firstTokenAt');
        this.log('gateway_first_token', 'Gateway streamed the first token.', {
          preview: event.text.slice(0, 80),
          ...this.buildLatencyLogMeta(),
        });
      }
      return;
    }

    if (event.type === 'sentence_ready' && event.text !== undefined) {
      if (this.pipelineDebug.latency.timestamps.firstSentenceReadyAt === null) {
        this.markLatencyTimestamp('firstSentenceReadyAt');
        this.log('gateway_first_sentence_ready', 'First spoken sentence is ready for TTS.', {
          sentenceLength: event.text.length,
          sentencePreview: event.text.slice(0, 120),
          ...this.buildLatencyLogMeta(),
        });
      }
      return;
    }

    if (event.type === 'tts_request_started' && event.text !== undefined) {
      if (this.pipelineDebug.latency.timestamps.ttsRequestStartedAt === null) {
        this.markLatencyTimestamp('ttsRequestStartedAt');
        this.log('tts_request_started', 'First TTS request started.', {
          sentenceLength: event.text.length,
          sentencePreview: event.text.slice(0, 120),
          ...this.buildLatencyLogMeta(),
        });
      }
      return;
    }

    if (event.type === 'tts_first_audio_ready' && event.audio !== undefined) {
      if (this.pipelineDebug.latency.timestamps.ttsFirstAudioReadyAt === null) {
        this.markLatencyTimestamp('ttsFirstAudioReadyAt');
        this.log('tts_first_audio_ready', 'First TTS audio bytes are ready.', {
          audioBytes: event.audio.byteLength,
          ...this.buildLatencyLogMeta(),
        });
      }
      return;
    }

    if (event.type === 'transcription' && event.text !== undefined) {
      if (event.text.trim().length === 0) {
        this.failActiveFlow('stt', 'Whisper STT returned an empty transcript.');
        return;
      }

      this.markLatencyTimestamp('sttFinishedAt');
      this.markStage('stt', 'succeeded');
      this.log('stt_finished', 'STT completed.', {
        transcriptLength: event.text.length,
        ...this.buildSttLogMeta(),
        ...this.buildLatencyLogMeta(),
      });
      this.runtimeState.setLastTranscript(event.text);
      this.markStage('gateway', 'running');
      this.activeFailureStage = 'gateway';
      this.markLatencyTimestamp('gatewayStartedAt');
      this.log('gateway_started', 'Submitting transcript to gateway.', {
        transcriptLength: event.text.length,
        ...this.buildLatencyLogMeta(),
      });
      return;
    }

    if (event.type === 'response' && event.text !== undefined) {
      if (event.text.trim().length === 0) {
        this.failActiveFlow('gateway', 'Assistant response was empty.');
        return;
      }

      this.markStage('gateway', 'succeeded');
      this.log('gateway_finished', 'Gateway response completed.', {
        responseLength: event.text.length,
        ...this.buildLatencyLogMeta(),
      });
      this.runtimeState.setLastResponseText(event.text);
      this.lastReplayText = event.text;
      return;
    }

    if (event.type === 'audio' && event.audio !== undefined) {
      if (event.audio.byteLength === 0) {
        this.failActiveFlow('tts', 'Generated TTS audio was empty.');
        return;
      }

      this.markLatencyTimestamp('ttsFinishedAt');
      this.markStage('tts', 'succeeded');
      this.awaitingPlaybackCompletion = true;
      this.log('tts_finished', 'TTS audio generated.', {
        audioBytes: event.audio.byteLength,
        ...this.buildLatencyLogMeta(),
      });
      return;
    }

    if (event.type === 'error' && event.error !== undefined) {
      this.failActiveFlow(this.activeFailureStage ?? 'recording', event.error.message);
      return;
    }

    if (event.type === 'state_changed' && event.state !== undefined) {
      if (
        event.state === 'idle' &&
        this.runtimeState.getSnapshot().currentState === 'error'
      ) {
        return;
      }

      const mapped = mapVoiceManagerState(event.state);

      if (mapped !== undefined) {
        this.runtimeState.transition(mapped, {
          meta: {},
        });
      }

      if (event.state === 'transcribing') {
        this.activeFailureStage = 'stt';
        return;
      }

      if (event.state === 'thinking') {
        this.activeFailureStage = 'gateway';
        return;
      }

      if (event.state === 'synthesizing') {
        if (this.pipelineDebug.tts.status !== 'running') {
          this.markStage('tts', 'running');
          this.log('tts_started', 'TTS generation started.', this.buildLatencyLogMeta());
        }

        this.activeFailureStage = 'tts';
      }
    }
  }

  private async handleSpeakerEvent(event: {
    type: string;
    error?: Error;
  }): Promise<void> {
    if (event.type === 'playback_started') {
      this.markLatencyTimestamp('playbackStartedAt');
      this.runtimeState.setPlaybackActive(true);
      this.runtimeState.markConversationSpeaking();
      this.runtimeState.transition('speaking', {
        meta: {},
      });

      if (!this.playbackStartedForFlow) {
        this.playbackStartedForFlow = true;
        this.markStage('playback', 'running');
        this.log('playback_started', 'Playback started.', this.buildLatencyLogMeta());
      }

      this.activeFailureStage = 'playback';
      return;
    }

    if (event.type === 'state_changed') {
      const active = this.voiceGateway.speaker.isPlaying;

      this.runtimeState.setPlaybackActive(active);

      if (!active && this.playbackStartedForFlow) {
        this.markLatencyTimestamp('playbackFinishedAt');
        this.markStage('playback', 'succeeded');
        this.runtimeState.markConversationCompleted();
        this.log('playback_finished', 'Playback finished.', this.buildLatencyLogMeta());

        if (this.activeFlow === 'manual' && this.awaitingPlaybackCompletion) {
          this.log('voice_pipeline_completed', 'Manual voice pipeline completed.', this.buildLatencyLogMeta());
        }

        this.awaitingPlaybackCompletion = false;
        this.playbackStartedForFlow = false;
        this.activeFlow = null;
        this.activeFailureStage = null;

        if (!this.runtimeState.getSnapshot().micActive) {
          this.runtimeState.transition('idle', {
            meta: {},
          });
        }
      }

      return;
    }

    if (event.type === 'error' && event.error !== undefined) {
      this.failStage('playback', 'playback_failed', event.error.message);
    }
  }

  private handleRecorderDiagnosticEvent(event: RecorderDiagnosticEvent): void {
    this.recorderDebug = event.snapshot;
    this.log(event.type, event.message, event.meta, event.level);
  }

  private syncSttDebugInfo(): SttDebugInfo | null {
    const debug = this.voiceGateway.manager.sttDebugInfo;

    this.pipelineDebug = {
      ...this.pipelineDebug,
      sttDebug: {
        requestUrl: debug?.requestUrl ?? null,
        httpStatus: debug?.httpStatus ?? null,
        contentType: debug?.contentType ?? null,
        responseKeys: debug?.responseKeys ?? [],
        rawBodyPreview: debug?.rawBodyPreview ?? null,
        transcript: debug?.transcript ?? null,
        transcriptLength: debug?.transcriptLength ?? null,
        failureReason: debug?.failureReason ?? null,
      },
      updatedAt: new Date().toISOString(),
    };

    return debug;
  }

  private markLatencyTimestamp(
    name: keyof VoiceLatencyTimestamps,
    at: Date = new Date(),
  ): void {
    if (this.pipelineDebug.latency.timestamps[name] !== null) {
      return;
    }

    this.pipelineDebug = {
      ...this.pipelineDebug,
      latency: computeLatencyDebug({
        ...this.pipelineDebug.latency.timestamps,
        [name]: at.toISOString(),
      }),
      updatedAt: at.toISOString(),
    };
  }

  private buildLatencyLogMeta(): Record<string, string | number | boolean | null> {
    const { timestamps, durations } = this.pipelineDebug.latency;

    return {
      stopListeningAt: timestamps.stopListeningAt,
      sttStartedAt: timestamps.sttStartedAt,
      sttFinishedAt: timestamps.sttFinishedAt,
      gatewayStartedAt: timestamps.gatewayStartedAt,
      firstTokenAt: timestamps.firstTokenAt,
      firstSentenceReadyAt: timestamps.firstSentenceReadyAt,
      ttsRequestStartedAt: timestamps.ttsRequestStartedAt,
      ttsFirstAudioReadyAt: timestamps.ttsFirstAudioReadyAt,
      ttsFinishedAt: timestamps.ttsFinishedAt,
      playbackStartedAt: timestamps.playbackStartedAt,
      playbackFinishedAt: timestamps.playbackFinishedAt,
      sttLatencyMs: durations.sttLatencyMs,
      gatewayToFirstTokenMs: durations.gatewayToFirstTokenMs,
      gatewayToFirstSentenceMs: durations.gatewayToFirstSentenceMs,
      ttsToFirstAudioMs: durations.ttsToFirstAudioMs,
      ttsFullSynthesisMs: durations.ttsFullSynthesisMs,
      stopToFirstSoundMs: durations.stopToFirstSoundMs,
      stopToPlaybackFinishedMs: durations.stopToPlaybackFinishedMs,
    };
  }

  private buildSttLogMeta(): Record<string, string | number | boolean | null> {
    const debug = this.syncSttDebugInfo();

    return {
      sttRequestUrl: debug?.requestUrl ?? null,
      sttStatus: debug?.httpStatus ?? null,
      sttContentType: debug?.contentType ?? null,
      sttResponseKeys:
        debug === null || debug.responseKeys.length === 0
          ? null
          : debug.responseKeys.join(','),
      sttRawBodyPreview: debug?.rawBodyPreview ?? null,
      sttTranscript: debug?.transcript ?? null,
      sttTranscriptLength: debug?.transcriptLength ?? null,
      sttFailureReason: debug?.failureReason ?? null,
    };
  }

  private findFailedPipelineStage(): PipelineStageName | null {
    const entries: Array<[PipelineStageName, PipelineStageDebug]> = [
      ['recording', this.pipelineDebug.recording],
      ['stt', this.pipelineDebug.stt],
      ['gateway', this.pipelineDebug.gateway],
      ['tts', this.pipelineDebug.tts],
      ['playback', this.pipelineDebug.playback],
    ];

    const failed = entries.find(([, stage]) => stage.status === 'failed');

    return failed?.[0] ?? null;
  }

  private async checkHealth(
    name: RuntimeServiceName,
    url: string | null,
  ): Promise<void> {
    if (url === null) {
      this.runtimeState.setServiceHealth(name, {
        online: false,
        checkedAt: new Date().toISOString(),
        error: 'Service URL is not configured.',
      });
      return;
    }

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(2_000),
      });

      this.runtimeState.setServiceHealth(name, {
        url,
        online: response.ok,
        checkedAt: new Date().toISOString(),
        error: response.ok ? null : `HTTP ${response.status} ${response.statusText}`,
      });
    } catch (error: unknown) {
      this.runtimeState.setServiceHealth(name, {
        url,
        online: false,
        checkedAt: new Date().toISOString(),
        error: toErrorMessage(error),
      });
    }
  }

  private async persistDebugAudio(audio: Buffer): Promise<LastAudioDebugInfo> {
    if (audio.byteLength === 0) {
      return createEmptyAudioDebug();
    }

    await mkdir(DEBUG_AUDIO_DIR, { recursive: true });
    await writeFile(DEBUG_AUDIO_FILE, audio);
    const metadata = await stat(DEBUG_AUDIO_FILE);
    const analyzed = analyzeAudioBuffer(audio, this.getSampleRate(), this.getChannels());

    return {
      exists: true,
      path: DEBUG_AUDIO_FILE,
      size: metadata.size,
      byteLength: audio.byteLength,
      durationMs: analyzed.durationMs,
      sampleRate: analyzed.sampleRate,
      channels: analyzed.channels,
      bitsPerSample: analyzed.bitsPerSample,
      encoding: analyzed.encoding,
      format: analyzed.format,
      peakAmplitude: analyzed.peakAmplitude,
      rmsLevel: analyzed.rmsLevel,
      silentRatio: analyzed.silentRatio,
      suspectedSilent: analyzed.suspectedSilent,
      audioQualityHint: analyzed.audioQualityHint,
      targetSampleRate: analyzed.targetSampleRate,
      targetChannels: analyzed.targetChannels,
      targetEncoding: analyzed.targetEncoding,
      targetFormat: analyzed.targetFormat,
      matchesWhisperInputTarget: analyzed.matchesWhisperInputTarget,
      whisperInputRisk: analyzed.whisperInputRisk,
      device: this.recorderDebug.device,
      usingDefaultDevice: this.recorderDebug.usingDefaultDevice,
      createdAt: metadata.mtime.toISOString(),
    };
  }

  private validateRecordedAudio(
    audio: Buffer,
    audioDebug: LastAudioDebugInfo,
  ): void {
    if (audio.byteLength === 0) {
      throw new Error('No audio data was captured.');
    }

    if (audioDebug.audioQualityHint === 'invalid_format') {
      throw new Error('Recorded audio is not a PCM WAV file that Whisper can reliably parse.');
    }

    if (audio.byteLength < MIN_RECORDING_BYTES) {
      throw new Error(
        `Recorded audio is too small (${audio.byteLength} bytes).`,
      );
    }

    if (
      audioDebug.durationMs !== null &&
      audioDebug.durationMs < MIN_RECORDING_DURATION_MS
    ) {
      throw new Error(
        `Recorded audio is too short (${audioDebug.durationMs}ms).`,
      );
    }
  }

  private getSampleRate(): number {
    return this.environmentConfig.micSampleRateHertz ?? 16_000;
  }

  private getChannels(): number {
    return this.environmentConfig.micChannels ?? 1;
  }

  private markStage(
    name: PipelineStageName,
    status: PipelineStageStatus,
    error: string | null = null,
  ): void {
    const now = new Date().toISOString();

    this.pipelineDebug = {
      ...this.pipelineDebug,
      updatedAt: now,
      [name]: {
        status,
        error,
        updatedAt: now,
      },
    };
  }

  private failActiveFlow(
    stage: PipelineStageName,
    message: string,
  ): void {
    switch (stage) {
      case 'stt':
        this.syncSttDebugInfo();
        this.failStage('stt', 'stt_failed', classifySttError(message));
        break;
      case 'gateway':
        this.failStage('gateway', 'gateway_failed', classifyGatewayError(message));
        break;
      case 'tts':
        this.failStage('tts', 'tts_failed', classifyTtsError(message));
        break;
      case 'playback':
        this.failStage('playback', 'playback_failed', classifyPlaybackError(message));
        break;
      case 'recording':
      default:
        this.failStage('recording', 'recording_failed', classifyRecordingStopError(message));
        break;
    }
  }

  private failStage(
    stage: PipelineStageName,
    logType: string,
    message: string,
  ): void {
    this.markStage(stage, 'failed', message);
    this.runtimeState.transition('error', {
      error: message,
      meta: {
        stage,
      },
    });
    this.runtimeState.setError(message);
    this.log(logType, message, {
      stage,
      ...this.buildLatencyLogMeta(),
      ...(stage === 'stt' ? this.buildSttLogMeta() : {}),
    }, 'error');

    if (this.activeFlow === 'manual') {
      this.log('voice_pipeline_failed', 'Manual voice pipeline failed.', {
        stage,
        error: message,
        ...this.buildLatencyLogMeta(),
      }, 'error');
    }

    this.runtimeState.setMicActive(false);
    this.runtimeState.setPlaybackActive(false);
    this.awaitingPlaybackCompletion = false;
    this.playbackStartedForFlow = false;
    this.activeFlow = null;
    this.activeFailureStage = null;
  }

  private log(
    type: string,
    message: string,
    meta: Record<string, string | number | boolean | null> = {},
    level: 'info' | 'warn' | 'error' = 'info',
  ): void {
    this.runtimeState.addLog({
      level,
      type,
      message,
      meta,
    });
  }

  private resetPipelineDebug(flow: FlowKind): void {
    this.pipelineDebug = createEmptyPipelineDebug(flow);
    this.activeFlow = flow;
    this.activeFailureStage = 'recording';
    this.awaitingPlaybackCompletion = false;
    this.playbackStartedForFlow = false;
  }

  private resetFlowState(): void {
    this.activeFlow = null;
    this.activeFailureStage = null;
    this.awaitingPlaybackCompletion = false;
    this.playbackStartedForFlow = false;
    this.pipelineDebug = createEmptyPipelineDebug();
  }
}

function createEmptyAudioDebug(): LastAudioDebugInfo {
  return {
    exists: false,
    path: null,
    size: null,
    byteLength: null,
    durationMs: null,
    sampleRate: null,
    channels: null,
    bitsPerSample: null,
    encoding: null,
    format: null,
    peakAmplitude: null,
    rmsLevel: null,
    silentRatio: null,
    suspectedSilent: null,
    audioQualityHint: null,
    targetSampleRate: TARGET_RECORDING_SAMPLE_RATE_HERTZ,
    targetChannels: TARGET_RECORDING_CHANNELS,
    targetEncoding: TARGET_RECORDING_ENCODING,
    targetFormat: TARGET_RECORDING_FORMAT,
    matchesWhisperInputTarget: null,
    whisperInputRisk: null,
    device: null,
    usingDefaultDevice: true,
    createdAt: null,
  };
}

function createStageDebug(): PipelineStageDebug {
  return {
    status: 'idle',
    error: null,
    updatedAt: null,
  };
}

function createEmptyPipelineDebug(flow: FlowKind | null = null): VoicePipelineDebugInfo {
  return {
    recording: createStageDebug(),
    stt: createStageDebug(),
    gateway: createStageDebug(),
    tts: createStageDebug(),
    playback: createStageDebug(),
    latency: createEmptyLatencyDebug(),
    sttDebug: {
      requestUrl: null,
      httpStatus: null,
      contentType: null,
      responseKeys: [],
      rawBodyPreview: null,
      transcript: null,
      transcriptLength: null,
      failureReason: null,
    },
    flow,
    updatedAt: null,
  };
}

function createEmptyRecorderDebug(): RecorderRuntimeDebugInfo {
  return {
    backend: 'sox',
    backendPath: null,
    backendAvailable: false,
    device: 'default',
    usingDefaultDevice: true,
    spawnStarted: false,
    firstChunkReceived: false,
    startTimeoutMs: 5_000,
    lastStderr: null,
    lastSpawnError: null,
    lastFailureReason: null,
    micPermissionHint:
      process.platform === 'darwin'
        ? 'Check System Settings > Privacy & Security > Microphone and allow Terminal or Electron.'
        : null,
  };
}

function clonePipelineDebug(value: VoicePipelineDebugInfo): VoicePipelineDebugInfo {
  return {
    recording: { ...value.recording },
    stt: { ...value.stt },
    gateway: { ...value.gateway },
    tts: { ...value.tts },
    playback: { ...value.playback },
    latency: {
      timestamps: { ...value.latency.timestamps },
      durations: { ...value.latency.durations },
    },
    sttDebug: {
      requestUrl: value.sttDebug.requestUrl,
      httpStatus: value.sttDebug.httpStatus,
      contentType: value.sttDebug.contentType,
      responseKeys: [...value.sttDebug.responseKeys],
      rawBodyPreview: value.sttDebug.rawBodyPreview,
      transcript: value.sttDebug.transcript,
      transcriptLength: value.sttDebug.transcriptLength,
      failureReason: value.sttDebug.failureReason,
    },
    flow: value.flow,
    updatedAt: value.updatedAt,
  };
}

function createEmptyLatencyDebug(): {
  timestamps: VoiceLatencyTimestamps;
  durations: VoiceLatencyDurations;
} {
  return {
    timestamps: {
      stopListeningAt: null,
      sttStartedAt: null,
      sttFinishedAt: null,
      gatewayStartedAt: null,
      firstTokenAt: null,
      firstSentenceReadyAt: null,
      ttsRequestStartedAt: null,
      ttsFirstAudioReadyAt: null,
      ttsFinishedAt: null,
      playbackStartedAt: null,
      playbackFinishedAt: null,
    },
    durations: {
      sttLatencyMs: null,
      gatewayToFirstTokenMs: null,
      gatewayToFirstSentenceMs: null,
      ttsToFirstAudioMs: null,
      ttsFullSynthesisMs: null,
      stopToFirstSoundMs: null,
      stopToPlaybackFinishedMs: null,
    },
  };
}

function computeLatencyDebug(
  timestamps: VoiceLatencyTimestamps,
): {
  timestamps: VoiceLatencyTimestamps;
  durations: VoiceLatencyDurations;
} {
  return {
    timestamps,
    durations: {
      sttLatencyMs: diffMs(timestamps.sttStartedAt, timestamps.sttFinishedAt),
      gatewayToFirstTokenMs: diffMs(timestamps.gatewayStartedAt, timestamps.firstTokenAt),
      gatewayToFirstSentenceMs: diffMs(
        timestamps.gatewayStartedAt,
        timestamps.firstSentenceReadyAt,
      ),
      ttsToFirstAudioMs: diffMs(
        timestamps.ttsRequestStartedAt,
        timestamps.ttsFirstAudioReadyAt,
      ),
      ttsFullSynthesisMs: diffMs(
        timestamps.ttsRequestStartedAt,
        timestamps.ttsFinishedAt,
      ),
      stopToFirstSoundMs: diffMs(
        timestamps.stopListeningAt,
        timestamps.playbackStartedAt,
      ),
      stopToPlaybackFinishedMs: diffMs(
        timestamps.stopListeningAt,
        timestamps.playbackFinishedAt,
      ),
    },
  };
}

function diffMs(start: string | null, end: string | null): number | null {
  if (start === null || end === null) {
    return null;
  }

  const startTime = Date.parse(start);
  const endTime = Date.parse(end);

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    return null;
  }

  return Math.max(0, endTime - startTime);
}

function mapVoiceManagerState(
  state: VoiceManagerState,
): SonnyRuntimeState | undefined {
  switch (state) {
    case 'idle':
      return 'idle';
    case 'listening':
    case 'capturing':
      return 'listening';
    case 'transcribing':
      return 'transcribing';
    case 'thinking':
      return 'thinking';
    case 'synthesizing':
    case 'playing':
      return 'speaking';
    case 'error':
      return 'error';
    default:
      return undefined;
  }
}

function analyzeAudioBuffer(
  audio: Buffer,
  fallbackSampleRate: number,
  fallbackChannels: number,
): {
  durationMs: number | null;
  sampleRate: number;
  channels: number;
  bitsPerSample: number | null;
  encoding: string | null;
  format: string | null;
  peakAmplitude: number | null;
  rmsLevel: number | null;
  silentRatio: number | null;
  suspectedSilent: boolean;
  audioQualityHint: AudioQualityHint;
  targetSampleRate: number;
  targetChannels: number;
  targetEncoding: string;
  targetFormat: string;
  matchesWhisperInputTarget: boolean;
  whisperInputRisk: string | null;
} {
  const parsed = parseWaveAudioMetadata(audio);

  if (parsed === null) {
    return {
      durationMs: null,
      sampleRate: fallbackSampleRate,
      channels: fallbackChannels,
      bitsPerSample: null,
      encoding: null,
      format: null,
      peakAmplitude: null,
      rmsLevel: null,
      silentRatio: null,
      suspectedSilent: true,
      audioQualityHint: 'invalid_format',
      targetSampleRate: TARGET_RECORDING_SAMPLE_RATE_HERTZ,
      targetChannels: TARGET_RECORDING_CHANNELS,
      targetEncoding: TARGET_RECORDING_ENCODING,
      targetFormat: TARGET_RECORDING_FORMAT,
      matchesWhisperInputTarget: false,
      whisperInputRisk:
        `Recorded audio is not a parseable ${TARGET_RECORDING_FORMAT.toUpperCase()} file, so Whisper input cannot be verified.`,
    };
  }

  const bytesPerSample = parsed.bitsPerSample / 8;
  const durationMs =
    parsed.sampleRate > 0 && parsed.channels > 0 && bytesPerSample > 0
      ? Math.round(
          (parsed.dataSize / (parsed.sampleRate * parsed.channels * bytesPerSample)) * 1000,
        )
      : null;
  const levels =
    parsed.formatCode === 1 && parsed.bitsPerSample === 16
      ? analyzePcm16AudioLevels(audio.subarray(parsed.dataOffset, parsed.dataOffset + parsed.dataSize))
      : null;
  const audioQualityHint = classifyAudioQuality({
    durationMs,
    format: parsed.format,
    encoding: parsed.encoding,
    rmsLevel: levels?.rmsLevel ?? null,
    peakAmplitude: levels?.peakAmplitude ?? null,
    silentRatio: levels?.silentRatio ?? null,
  });
  const matchesWhisperInputTarget =
    parsed.format === TARGET_RECORDING_FORMAT &&
    parsed.encoding === TARGET_RECORDING_ENCODING &&
    parsed.sampleRate === TARGET_RECORDING_SAMPLE_RATE_HERTZ &&
    parsed.channels === TARGET_RECORDING_CHANNELS;
  const whisperInputRisk = buildWhisperInputRisk({
    sampleRate: parsed.sampleRate,
    channels: parsed.channels,
    encoding: parsed.encoding,
    format: parsed.format,
  });
  const suspectedSilent =
    audioQualityHint === 'mostly_silence' || audioQualityHint === 'too_quiet';

  return {
    durationMs,
    sampleRate: parsed.sampleRate || fallbackSampleRate,
    channels: parsed.channels || fallbackChannels,
    bitsPerSample: parsed.bitsPerSample,
    encoding: parsed.encoding,
    format: parsed.format,
    peakAmplitude: levels?.peakAmplitude ?? null,
    rmsLevel: levels?.rmsLevel ?? null,
    silentRatio: levels?.silentRatio ?? null,
    suspectedSilent,
    audioQualityHint,
    targetSampleRate: TARGET_RECORDING_SAMPLE_RATE_HERTZ,
    targetChannels: TARGET_RECORDING_CHANNELS,
    targetEncoding: TARGET_RECORDING_ENCODING,
    targetFormat: TARGET_RECORDING_FORMAT,
    matchesWhisperInputTarget,
    whisperInputRisk,
  };
}

function parseWaveAudioMetadata(audio: Buffer): {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  formatCode: number;
  format: string;
  encoding: string;
  dataOffset: number;
  dataSize: number;
} | null {
  if (audio.byteLength < 44) {
    return null;
  }

  if (
    audio.toString('ascii', 0, 4) !== 'RIFF' ||
    audio.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return null;
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let formatCode = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= audio.byteLength) {
    const chunkId = audio.toString('ascii', offset, offset + 4);
    const chunkSize = audio.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;
    const chunkDataEnd = Math.min(chunkDataStart + chunkSize, audio.byteLength);

    if (chunkId === 'fmt ' && chunkSize >= 16 && chunkDataEnd <= audio.byteLength) {
      formatCode = audio.readUInt16LE(chunkDataStart);
      channels = audio.readUInt16LE(chunkDataStart + 2);
      sampleRate = audio.readUInt32LE(chunkDataStart + 4);
      bitsPerSample = audio.readUInt16LE(chunkDataStart + 14);
    }

    if (chunkId === 'data') {
      dataOffset = chunkDataStart;
      dataSize = Math.max(chunkDataEnd - chunkDataStart, 0);
      break;
    }

    offset = chunkDataStart + chunkSize + (chunkSize % 2 === 0 ? 0 : 1);
  }

  if (dataOffset < 0 || sampleRate <= 0 || channels <= 0 || bitsPerSample <= 0) {
    return null;
  }

  return {
    sampleRate,
    channels,
    bitsPerSample,
    formatCode,
    format: 'wav',
    encoding: formatCode === 1 && bitsPerSample === 16 ? 'pcm_s16le' : `wav_format_${formatCode}_${bitsPerSample}bit`,
    dataOffset,
    dataSize,
  };
}

function analyzePcm16AudioLevels(audio: Buffer): {
  peakAmplitude: number;
  rmsLevel: number;
  silentRatio: number;
} | null {
  const sampleCount = Math.floor(audio.byteLength / 2);

  if (sampleCount === 0) {
    return null;
  }

  let peak = 0;
  let sumSquares = 0;
  let silentSamples = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = audio.readInt16LE(index * 2);
    const normalized = Math.abs(sample / 32768);

    if (normalized > peak) {
      peak = normalized;
    }

    sumSquares += normalized * normalized;

    if (normalized < 0.01) {
      silentSamples += 1;
    }
  }

  return {
    peakAmplitude: roundMetric(peak),
    rmsLevel: roundMetric(Math.sqrt(sumSquares / sampleCount)),
    silentRatio: roundMetric(silentSamples / sampleCount),
  };
}

function classifyAudioQuality(input: {
  durationMs: number | null;
  format: string | null;
  encoding: string | null;
  rmsLevel: number | null;
  peakAmplitude: number | null;
  silentRatio: number | null;
}): AudioQualityHint {
  if (input.format !== 'wav' || input.encoding !== 'pcm_s16le') {
    return 'invalid_format';
  }

  if (input.durationMs !== null && input.durationMs < MIN_RECORDING_DURATION_MS) {
    return 'too_short';
  }

  if (input.silentRatio !== null && input.silentRatio >= 0.98) {
    return 'mostly_silence';
  }

  if (
    (input.rmsLevel !== null && input.rmsLevel < 0.01) ||
    (input.peakAmplitude !== null && input.peakAmplitude < 0.05)
  ) {
    return 'too_quiet';
  }

  return 'ok';
}

function buildWhisperInputRisk(input: {
  sampleRate: number;
  channels: number;
  encoding: string;
  format: string;
}): string | null {
  const mismatches: string[] = [];

  if (input.format !== TARGET_RECORDING_FORMAT) {
    mismatches.push(`format=${input.format}`);
  }

  if (input.encoding !== TARGET_RECORDING_ENCODING) {
    mismatches.push(`encoding=${input.encoding}`);
  }

  if (input.sampleRate !== TARGET_RECORDING_SAMPLE_RATE_HERTZ) {
    mismatches.push(`sampleRate=${input.sampleRate}`);
  }

  if (input.channels !== TARGET_RECORDING_CHANNELS) {
    mismatches.push(`channels=${input.channels}`);
  }

  if (mismatches.length === 0) {
    return null;
  }

  return (
    `Recorder output differs from Whisper target ` +
    `${TARGET_RECORDING_CHANNELS}ch/${TARGET_RECORDING_SAMPLE_RATE_HERTZ}Hz/` +
    `${TARGET_RECORDING_ENCODING}/${TARGET_RECORDING_FORMAT}: ${mismatches.join(', ')}.`
  );
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/u, '');
}

function normalizeOptionalHealthUrl(value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }

  return `${normalizeBaseUrl(value)}/health`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function classifyRecordingStartError(error: unknown): string {
  if (error instanceof ManualRecorderError) {
    const stderrSuffix =
      error.diagnostics.lastStderr === null
        ? ''
        : ` Stderr: ${error.diagnostics.lastStderr}`;

    switch (error.reason) {
      case 'backend_missing':
        return `Recorder backend "${error.diagnostics.backend}" is missing from PATH.`;
      case 'permission_denied_suspected':
        return `Recorder backend "${error.diagnostics.backend}" appears blocked by microphone permissions or device access.${stderrSuffix}`;
      case 'start_timeout':
        return `Recorder backend "${error.diagnostics.backend}" did not become ready within ${error.diagnostics.startTimeoutMs}ms.${stderrSuffix}`;
      case 'spawn_failed':
        return `Recorder backend "${error.diagnostics.backend}" failed to spawn.${stderrSuffix}`;
      case 'no_audio_data':
        return 'Recording completed but no audio data was captured.';
      default:
        return `${error.message}${stderrSuffix}`;
    }
  }

  const message = toErrorMessage(error);

  if (message.includes('node-record-lpcm16')) {
    return 'Recorder failed to start. Check microphone permissions and local recorder availability.';
  }

  return `Manual recording failed to start: ${message}`;
}

function classifyRecordingStopError(message: string): string {
  if (message.includes('No audio data')) {
    return 'Recording completed but captured no audio.';
  }

  if (message.includes('too short')) {
    return message;
  }

  if (message.includes('too small')) {
    return message;
  }

  return `Recording failed: ${message}`;
}

function classifySttError(message: string): string {
  if (message.startsWith('stt_http_error:')) {
    return message.replace('stt_http_error:', 'STT HTTP error:').trim();
  }

  if (message.startsWith('stt_invalid_json:')) {
    return message.replace('stt_invalid_json:', 'STT invalid JSON:').trim();
  }

  if (message.startsWith('stt_unrecognized_payload_shape:')) {
    return message.replace(
      'stt_unrecognized_payload_shape:',
      'STT unrecognized payload shape:',
    ).trim();
  }

  if (message.startsWith('stt_empty_transcript:')) {
    return message.replace('stt_empty_transcript:', 'STT empty transcript:').trim();
  }

  if (message.includes('timed out')) {
    return `STT request timed out: ${message}`;
  }

  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    return `Whisper STT service is offline or unreachable: ${message}`;
  }

  return `STT failed: ${message}`;
}

function classifyGatewayError(message: string): string {
  if (message.includes('Ollama request failed') || message.includes('fetch failed')) {
    return `Gateway/Ollama request failed: ${message}`;
  }

  if (message.trim().length === 0) {
    return 'Gateway failed with an empty error message.';
  }

  return `Gateway failed: ${message}`;
}

function classifyTtsError(message: string): string {
  if (message.includes('Qwen3-TTS request failed') || message.includes('fetch failed')) {
    return `TTS service request failed: ${message}`;
  }

  if (message.includes('missing audio data') || message.includes('audio data')) {
    return `TTS returned empty audio: ${message}`;
  }

  return `TTS failed: ${message}`;
}

function classifyPlaybackError(message: string): string {
  return `Playback failed: ${message}`;
}
