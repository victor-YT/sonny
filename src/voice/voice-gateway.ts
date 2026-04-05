import { loadConfig, type RuntimeConfig } from '../core/config.js';
import type { Gateway } from '../core/gateway.js';
import { StreamingAudioQueue } from './streaming-audio-queue.js';
import { Microphone, type MicrophoneConfig } from './microphone.js';
import { PorcupineProvider } from './providers/porcupine.js';
import type { SttOptions, SttProvider } from './providers/stt.js';
import type { TtsOptions, TtsProvider } from './providers/tts.js';
import type { WakeWordProvider } from './providers/wake-word.js';
import { Speaker, type SpeakerConfig } from './speaker.js';
import { VoiceManager } from './voice-manager.js';

export interface VoiceGatewayConfig {
  gateway: Gateway;
  runtimeConfig?: RuntimeConfig;
  wakeWordProvider?: WakeWordProvider;
  sttProvider?: SttProvider;
  ttsProvider?: TtsProvider;
  microphone?: Microphone;
  microphoneConfig?: MicrophoneConfig;
  speaker?: Speaker;
  speakerConfig?: Omit<SpeakerConfig, 'audioQueue'>;
  playbackQueue?: StreamingAudioQueue;
  defaultSttOptions?: SttOptions;
  defaultTtsOptions?: TtsOptions;
}

export interface VoiceEnvironmentConfig {
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  wakeWordUrl?: string;
  wakeWord?: string;
  wakeWords?: string[];
  sttBaseUrl?: string;
  ttsBaseUrl?: string;
  sttLanguage?: string;
  ttsVoice?: string;
  micSampleRateHertz?: number;
  micSilenceSeconds?: number;
  micMaxCaptureMs?: number;
  micRecordProgram?: string;
}

export class VoiceGateway {
  public readonly manager: VoiceManager;
  public readonly microphone: Microphone;
  public readonly speaker: Speaker;
  public readonly playbackQueue: StreamingAudioQueue;

  public constructor(config: VoiceGatewayConfig) {
    const runtimeConfig = this.resolveRuntimeConfig(config);

    this.playbackQueue = config.playbackQueue ?? new StreamingAudioQueue();
    this.microphone = config.microphone ?? new Microphone(config.microphoneConfig);
    this.speaker = config.speaker ?? new Speaker({
      audioQueue: this.playbackQueue,
      ...config.speakerConfig,
    });

    this.manager = new VoiceManager({
      gateway: config.gateway,
      runtimeConfig,
      wakeWordProvider:
        config.wakeWordProvider ??
        this.createWakeWordProvider(config, runtimeConfig),
      sttProvider: config.sttProvider,
      ttsProvider: config.ttsProvider,
      captureAudio: async () => this.microphone.capture(),
      defaultSttOptions: config.defaultSttOptions,
      defaultTtsOptions: config.defaultTtsOptions,
      playbackQueue: this.playbackQueue,
      speaker: this.speaker,
    });
  }

  public async start(): Promise<void> {
    await this.manager.start();
  }

  public async stop(): Promise<void> {
    await this.manager.stop();
  }

  private resolveRuntimeConfig(
    config: VoiceGatewayConfig,
  ): RuntimeConfig | undefined {
    if (config.runtimeConfig !== undefined) {
      return config.runtimeConfig;
    }

    if (
      config.sttProvider === undefined ||
      config.ttsProvider === undefined ||
      config.wakeWordProvider === undefined
    ) {
      return loadConfig();
    }

    return undefined;
  }

  private createWakeWordProvider(
    config: VoiceGatewayConfig,
    runtimeConfig: RuntimeConfig | undefined,
  ): WakeWordProvider | undefined {
    if (config.wakeWordProvider !== undefined) {
      return config.wakeWordProvider;
    }

    if (runtimeConfig === undefined) {
      return undefined;
    }

    return new PorcupineProvider({
      baseUrl: runtimeConfig.voice.porcupine.url,
      keywords: runtimeConfig.voice.porcupine.wakeWords,
    });
  }
}

export function createVoiceGatewayFromEnvironment(
  gateway: Gateway,
  environment: NodeJS.ProcessEnv = process.env,
): VoiceGateway {
  const runtimeConfig = loadConfig();
  const config = readVoiceEnvironmentConfig(environment);
  const resolvedWakeWords = config.wakeWords?.length
    ? config.wakeWords
    : config.wakeWord !== undefined
      ? [config.wakeWord]
      : runtimeConfig.voice.porcupine.wakeWords;
  const resolvedWakeWordUrl =
    config.wakeWordUrl ?? runtimeConfig.voice.porcupine.url;

  return new VoiceGateway({
    gateway,
    runtimeConfig: {
      ...runtimeConfig,
      ollama: {
        baseUrl: config.ollamaBaseUrl ?? runtimeConfig.ollama.baseUrl,
        model: config.ollamaModel ?? runtimeConfig.ollama.model,
      },
      voice: {
        fasterWhisper: {
          url: config.sttBaseUrl ?? runtimeConfig.voice.fasterWhisper.url,
        },
        chatterbox: {
          url: config.ttsBaseUrl ?? runtimeConfig.voice.chatterbox.url,
        },
        porcupine: {
          url: resolvedWakeWordUrl,
          wakeWords: resolvedWakeWords,
        },
      },
    },
    wakeWordProvider: new PorcupineProvider({
      baseUrl: resolvedWakeWordUrl,
      keywords: resolvedWakeWords,
    }),
    microphoneConfig: {
      sampleRateHertz: config.micSampleRateHertz,
      silenceSeconds: config.micSilenceSeconds,
      maxCaptureMs: config.micMaxCaptureMs,
      recordProgram: config.micRecordProgram,
    },
    defaultSttOptions: {
      language: config.sttLanguage,
    },
    defaultTtsOptions: {
      voice: config.ttsVoice,
    },
  });
}

export function readVoiceEnvironmentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): VoiceEnvironmentConfig {
  return {
    ollamaBaseUrl:
      environment.OLLAMA_BASE_URL ??
      environment.SONNY_OLLAMA_BASE_URL,
    ollamaModel:
      environment.OLLAMA_MODEL ??
      environment.SONNY_OLLAMA_MODEL,
    wakeWordUrl:
      environment.WAKE_WORD_URL ??
      environment.SONNY_WAKE_WORD_URL,
    wakeWord:
      environment.PORCUPINE_WAKE_WORD ??
      environment.SONNY_PORCUPINE_WAKE_WORD,
    wakeWords: parseWakeWords(environment.SONNY_WAKE_WORDS),
    sttBaseUrl:
      environment.FASTER_WHISPER_URL ??
      environment.SONNY_STT_BASE_URL,
    ttsBaseUrl:
      environment.CHATTERBOX_URL ??
      environment.SONNY_TTS_BASE_URL,
    sttLanguage: environment.SONNY_STT_LANGUAGE,
    ttsVoice: environment.SONNY_TTS_VOICE,
    micSampleRateHertz: parseOptionalInteger(environment.SONNY_MIC_SAMPLE_RATE_HERTZ),
    micSilenceSeconds: parseOptionalNumber(environment.SONNY_MIC_SILENCE_SECONDS),
    micMaxCaptureMs: parseOptionalInteger(environment.SONNY_MIC_MAX_CAPTURE_MS),
    micRecordProgram: environment.SONNY_MIC_RECORD_PROGRAM,
  };
}

function parseWakeWords(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const wakeWords = value
    .split(',')
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);

  return wakeWords.length > 0 ? wakeWords : undefined;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    throw new Error(`Expected an integer value but received "${value}"`);
  }

  return parsed;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  const parsed = Number.parseFloat(value);

  if (Number.isNaN(parsed)) {
    throw new Error(`Expected a numeric value but received "${value}"`);
  }

  return parsed;
}
