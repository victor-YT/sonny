import { StreamingAudioQueue } from './streaming-audio-queue.js';
import { Microphone, type MicrophoneConfig } from './microphone.js';
import { ChatterboxProvider } from './providers/chatterbox.js';
import { FasterWhisperProvider } from './providers/faster-whisper.js';
import { PorcupineProvider } from './providers/porcupine.js';
import type { SttOptions, SttProvider } from './providers/stt.js';
import type { TtsOptions, TtsProvider } from './providers/tts.js';
import type { WakeWordProvider } from './providers/wake-word.js';
import { Speaker, type SpeakerConfig } from './speaker.js';
import { VoiceManager } from './voice-manager.js';
import type { Gateway } from '../core/gateway.js';

export interface VoiceGatewayConfig {
  gateway: Gateway;
  wakeWordProvider: WakeWordProvider;
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
  porcupineAccessKey: string;
  wakeWords?: string[];
  porcupineModelPath?: string;
  wakeWordSensitivity?: number;
  audioDeviceIndex?: number;
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
    this.playbackQueue = config.playbackQueue ?? new StreamingAudioQueue();
    this.microphone = config.microphone ?? new Microphone(config.microphoneConfig);
    this.speaker = config.speaker ?? new Speaker({
      audioQueue: this.playbackQueue,
      ...config.speakerConfig,
    });
    const sttProvider = config.sttProvider ?? new FasterWhisperProvider();
    const ttsProvider = config.ttsProvider ?? new ChatterboxProvider();

    this.manager = new VoiceManager({
      gateway: config.gateway,
      wakeWordProvider: config.wakeWordProvider,
      sttProvider,
      ttsProvider,
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
}

export function createVoiceGatewayFromEnvironment(
  gateway: Gateway,
  environment: NodeJS.ProcessEnv = process.env,
): VoiceGateway {
  const config = readVoiceEnvironmentConfig(environment);
  const wakeWordProvider = new PorcupineProvider({
    accessKey: config.porcupineAccessKey,
    keywords: config.wakeWords ?? ['sonny'],
    modelPath: config.porcupineModelPath,
    sensitivity: config.wakeWordSensitivity,
    audioDeviceIndex: config.audioDeviceIndex,
  });

  return new VoiceGateway({
    gateway,
    wakeWordProvider,
    sttProvider: new FasterWhisperProvider({
      baseUrl: config.sttBaseUrl,
    }),
    ttsProvider: new ChatterboxProvider({
      baseUrl: config.ttsBaseUrl,
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
  const porcupineAccessKey =
    environment.PORCUPINE_ACCESS_KEY ??
    environment.SONNY_PORCUPINE_ACCESS_KEY;

  if (porcupineAccessKey === undefined || porcupineAccessKey.length === 0) {
    throw new Error(
      'Voice mode requires PORCUPINE_ACCESS_KEY or SONNY_PORCUPINE_ACCESS_KEY.',
    );
  }

  return {
    ollamaBaseUrl:
      environment.OLLAMA_BASE_URL ??
      environment.SONNY_OLLAMA_BASE_URL,
    ollamaModel:
      environment.OLLAMA_MODEL ??
      environment.SONNY_OLLAMA_MODEL,
    porcupineAccessKey,
    wakeWords: parseWakeWords(environment.SONNY_WAKE_WORDS),
    porcupineModelPath: environment.SONNY_PORCUPINE_MODEL_PATH,
    wakeWordSensitivity: parseOptionalNumber(environment.SONNY_WAKE_WORD_SENSITIVITY),
    audioDeviceIndex: parseOptionalInteger(environment.SONNY_AUDIO_DEVICE_INDEX),
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
