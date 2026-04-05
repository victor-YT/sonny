import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createInterface, type Interface as ReadLineInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

import { loadConfig, type RuntimeConfig } from '../core/config.js';
import type { Gateway } from '../core/gateway.js';
import { StreamingAudioQueue } from './streaming-audio-queue.js';
import { Microphone, type MicrophoneConfig } from './microphone.js';
import { PorcupineProvider } from './providers/porcupine.js';
import type { SttOptions, SttProvider } from './providers/stt.js';
import type { TtsOptions, TtsProvider } from './providers/tts.js';
import type { WakeWordProvider } from './providers/wake-word.js';
import { Speaker, type SpeakerConfig } from './speaker.js';
import { VoiceManager, type VoiceManagerState } from './voice-manager.js';

const DEFAULT_PYTHON_COMMAND = 'python3';
const DEFAULT_SERVICE_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_MIC_SAMPLE_RATE_HERTZ = 16_000;
const DEFAULT_MIC_CHANNELS = 1;
const DEFAULT_MIC_RECORD_PROGRAM = 'sox';
const DEFAULT_VAD_SPEECH_THRESHOLD = 0.14;
const DEFAULT_VAD_MIN_SPEECH_CHUNKS = 4;
const DEFAULT_VAD_SILENCE_SECONDS = 30;
const PROJECT_ROOT = process.cwd();
const WHISPER_SERVER_SCRIPT = resolve(PROJECT_ROOT, 'scripts', 'whisper-server.py');
const TTS_SERVER_SCRIPT = resolve(PROJECT_ROOT, 'scripts', 'qwen3-tts-server.py');

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
  environmentConfig?: VoiceEnvironmentConfig;
}

export interface VoiceEnvironmentConfig {
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  wakeWordUrl?: string;
  porcupineAccessKey?: string;
  porcupineWakeWord?: string;
  wakeWords?: string[];
  porcupineModelPath?: string;
  wakeWordSensitivity?: number;
  audioDeviceIndex?: number;
  sttBaseUrl?: string;
  ttsBaseUrl?: string;
  sttLanguage?: string;
  ttsVoice?: string;
  micSampleRateHertz?: number;
  micChannels?: number;
  micSilenceSeconds?: number;
  micMaxCaptureMs?: number;
  micRecordProgram?: string;
  pythonCommand?: string;
  serviceStartupTimeoutMs?: number;
  vadSpeechThreshold?: number;
  vadMinSpeechChunks?: number;
}

interface ManagedProcessHandle {
  name: string;
  child: ChildProcess;
  stdout: ReadLineInterface;
  stderr: ReadLineInterface;
}

interface RecorderOptions {
  sampleRateHertz: number;
  channels: number;
  threshold: number;
  verbose: boolean;
  recordProgram: string;
  silence: string;
}

interface RecorderRuntime {
  stream(): NodeJS.ReadableStream;
  stop?(): void;
}

export class VoiceGateway {
  public readonly manager: VoiceManager;
  public readonly microphone: Microphone;
  public readonly speaker: Speaker;
  public readonly playbackQueue: StreamingAudioQueue;

  private readonly environmentConfig: VoiceEnvironmentConfig | undefined;
  private readonly managedServiceProcesses: ManagedProcessHandle[] = [];
  private readonly microphoneSettings: Required<Pick<
    VoiceEnvironmentConfig,
    'micSampleRateHertz' | 'micChannels' | 'micRecordProgram'
  >>;
  private readonly pythonCommand: string;
  private readonly serviceStartupTimeoutMs: number;
  private readonly vadSpeechThreshold: number;
  private readonly vadMinSpeechChunks: number;

  private playbackVadMonitor: PlaybackVadMonitor | undefined;
  private playbackRestartTask: Promise<void> | undefined;
  private started = false;

  public constructor(config: VoiceGatewayConfig) {
    const runtimeConfig = this.resolveRuntimeConfig(config);
    const environmentConfig = config.environmentConfig;

    this.environmentConfig = environmentConfig;
    this.playbackQueue = config.playbackQueue ?? new StreamingAudioQueue();
    this.microphone = config.microphone ?? new Microphone(config.microphoneConfig);
    this.speaker = config.speaker ?? new Speaker({
      audioQueue: this.playbackQueue,
      ...config.speakerConfig,
    });
    this.pythonCommand = environmentConfig?.pythonCommand ?? DEFAULT_PYTHON_COMMAND;
    this.serviceStartupTimeoutMs =
      environmentConfig?.serviceStartupTimeoutMs ?? DEFAULT_SERVICE_STARTUP_TIMEOUT_MS;
    this.vadSpeechThreshold =
      environmentConfig?.vadSpeechThreshold ?? DEFAULT_VAD_SPEECH_THRESHOLD;
    this.vadMinSpeechChunks =
      environmentConfig?.vadMinSpeechChunks ?? DEFAULT_VAD_MIN_SPEECH_CHUNKS;
    this.microphoneSettings = {
      micSampleRateHertz:
        config.microphoneConfig?.sampleRateHertz ??
        environmentConfig?.micSampleRateHertz ??
        DEFAULT_MIC_SAMPLE_RATE_HERTZ,
      micChannels:
        config.microphoneConfig?.channels ??
        environmentConfig?.micChannels ??
        DEFAULT_MIC_CHANNELS,
      micRecordProgram:
        config.microphoneConfig?.recordProgram ??
        environmentConfig?.micRecordProgram ??
        DEFAULT_MIC_RECORD_PROGRAM,
    };

    this.manager = new VoiceManager({
      gateway: config.gateway,
      runtimeConfig,
      wakeWordProvider:
        config.wakeWordProvider ??
        this.createWakeWordProvider(config, runtimeConfig, environmentConfig),
      sttProvider: config.sttProvider,
      ttsProvider: config.ttsProvider,
      captureAudio: async () => this.microphone.capture(),
      defaultSttOptions: config.defaultSttOptions,
      defaultTtsOptions: config.defaultTtsOptions,
      playbackQueue: this.playbackQueue,
      speaker: this.speaker,
    });

    this.manager.onEvent((event) => {
      if (event.type === 'state_changed' && event.state !== undefined) {
        void this.handleManagerStateChange(event.state);
      }
    });
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    try {
      await this.startManagedServices();
      await this.manager.start();
      this.started = true;
    } catch (error: unknown) {
      await this.stopManagedServices();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      await this.stopManagedServices();
      return;
    }

    this.started = false;
    await this.stopPlaybackVadMonitor();

    try {
      await this.manager.stop();
    } finally {
      await this.stopManagedServices();
    }
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
    environmentConfig: VoiceEnvironmentConfig | undefined,
  ): WakeWordProvider | undefined {
    if (config.wakeWordProvider !== undefined) {
      return config.wakeWordProvider;
    }

    if (runtimeConfig === undefined && environmentConfig === undefined) {
      return undefined;
    }

    const keywords = environmentConfig?.wakeWords?.length
      ? environmentConfig.wakeWords
      : runtimeConfig?.voice.porcupine.wakeWords.length
        ? runtimeConfig.voice.porcupine.wakeWords
        : [
            environmentConfig?.porcupineWakeWord ??
            runtimeConfig?.voice.porcupine.wakeWord ??
            'porcupine',
          ];

    if (keywords.every((keyword) => keyword.trim().length === 0)) {
      return undefined;
    }

    return new PorcupineProvider({
      baseUrl:
        environmentConfig?.wakeWordUrl ??
        runtimeConfig?.voice.porcupine.url,
      keywords,
    });
  }

  private async startManagedServices(): Promise<void> {
    if (this.environmentConfig === undefined) {
      return;
    }

    await this.startHttpService({
      name: 'whisper',
      scriptPath: WHISPER_SERVER_SCRIPT,
      healthUrl: `${normalizeBaseUrl(
        this.environmentConfig.sttBaseUrl ?? 'http://127.0.0.1:8000',
      )}/health`,
      environment: toWhisperEnvironment(
        this.environmentConfig.sttBaseUrl ?? 'http://127.0.0.1:8000',
      ),
    });

    await this.startHttpService({
      name: 'tts',
      scriptPath: TTS_SERVER_SCRIPT,
      healthUrl: `${normalizeBaseUrl(
        this.environmentConfig.ttsBaseUrl ?? 'http://127.0.0.1:8001',
      )}/health`,
      environment: toTtsEnvironment(
        this.environmentConfig.ttsBaseUrl ?? 'http://127.0.0.1:8001',
      ),
    });
  }

  private async startHttpService(config: {
    name: string;
    scriptPath: string;
    healthUrl: string;
    environment: Record<string, string>;
  }): Promise<void> {
    if (this.managedServiceProcesses.some((process) => process.name === config.name)) {
      return;
    }

    if (await isServiceHealthy(config.healthUrl)) {
      return;
    }

    const processHandle = spawnManagedProcess({
      name: config.name,
      pythonCommand: this.pythonCommand,
      scriptPath: config.scriptPath,
      environment: config.environment,
    });

    try {
      await waitForHttpReady(config.healthUrl, this.serviceStartupTimeoutMs);
      this.managedServiceProcesses.push(processHandle);
    } catch (error: unknown) {
      await stopManagedProcess(processHandle);
      throw error;
    }
  }

  private async stopManagedServices(): Promise<void> {
    const processes = this.managedServiceProcesses.splice(0).reverse();

    for (const processHandle of processes) {
      await stopManagedProcess(processHandle);
    }
  }

  private async handleManagerStateChange(state: VoiceManagerState): Promise<void> {
    if (!this.started) {
      return;
    }

    if (state === 'playing') {
      await this.startPlaybackVadMonitor();
      return;
    }

    await this.stopPlaybackVadMonitor();
  }

  private async startPlaybackVadMonitor(): Promise<void> {
    if (this.playbackVadMonitor !== undefined || this.playbackRestartTask !== undefined) {
      return;
    }

    const monitor = new PlaybackVadMonitor({
      sampleRateHertz: this.microphoneSettings.micSampleRateHertz,
      channels: this.microphoneSettings.micChannels,
      recordProgram: this.microphoneSettings.micRecordProgram,
      speechThreshold: this.vadSpeechThreshold,
      minSpeechChunks: this.vadMinSpeechChunks,
    });

    this.playbackVadMonitor = monitor;

    try {
      await monitor.start(async () => {
        await this.handlePlaybackInterruption();
      });
    } catch (error: unknown) {
      this.playbackVadMonitor = undefined;
      throw error;
    }
  }

  private async stopPlaybackVadMonitor(): Promise<void> {
    const monitor = this.playbackVadMonitor;

    this.playbackVadMonitor = undefined;

    if (monitor !== undefined) {
      await monitor.stop();
    }
  }

  private async handlePlaybackInterruption(): Promise<void> {
    if (
      this.playbackRestartTask !== undefined ||
      this.manager.currentState !== 'playing'
    ) {
      return;
    }

    const task = this.restartVoiceInteraction();
    this.playbackRestartTask = task;

    try {
      await task;
    } finally {
      this.playbackRestartTask = undefined;
    }
  }

  private async restartVoiceInteraction(): Promise<void> {
    await this.stopPlaybackVadMonitor();
    await this.manager.interruptCurrentInteraction();
    const capture = await this.microphone.capture();
    await this.manager.processCapture(capture);
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
    : [
        config.porcupineWakeWord ??
        runtimeConfig.voice.porcupine.wakeWord ??
        'porcupine',
      ];
  const resolvedWakeWordUrl =
    config.wakeWordUrl ?? runtimeConfig.voice.porcupine.url;
  const resolvedAccessKey =
    config.porcupineAccessKey ?? runtimeConfig.voice.porcupine.accessKey;
  const resolvedMicSampleRate =
    config.micSampleRateHertz ?? DEFAULT_MIC_SAMPLE_RATE_HERTZ;
  const resolvedMicChannels = config.micChannels ?? DEFAULT_MIC_CHANNELS;

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
          accessKey: resolvedAccessKey,
          wakeWord: resolvedWakeWords[0] ?? runtimeConfig.voice.porcupine.wakeWord,
          wakeWords: resolvedWakeWords,
        },
      },
    },
    environmentConfig: {
      ...config,
      wakeWordUrl: resolvedWakeWordUrl,
      porcupineAccessKey: resolvedAccessKey,
      wakeWords: resolvedWakeWords,
      micSampleRateHertz: resolvedMicSampleRate,
      micChannels: resolvedMicChannels,
    },
    microphoneConfig: {
      sampleRateHertz: resolvedMicSampleRate,
      channels: resolvedMicChannels,
      silenceSeconds: config.micSilenceSeconds,
      maxCaptureMs: config.micMaxCaptureMs,
      recordProgram: config.micRecordProgram,
    },
    defaultSttOptions: {
      language: config.sttLanguage,
      sampleRateHertz: resolvedMicSampleRate,
      channels: resolvedMicChannels,
      encoding: 'pcm_s16le',
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
    porcupineAccessKey:
      environment.PORCUPINE_ACCESS_KEY ??
      environment.SONNY_PORCUPINE_ACCESS_KEY,
    porcupineWakeWord:
      environment.PORCUPINE_WAKE_WORD ??
      environment.SONNY_PORCUPINE_WAKE_WORD,
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
    micChannels: parseOptionalInteger(environment.SONNY_MIC_CHANNELS),
    micSilenceSeconds: parseOptionalNumber(environment.SONNY_MIC_SILENCE_SECONDS),
    micMaxCaptureMs: parseOptionalInteger(environment.SONNY_MIC_MAX_CAPTURE_MS),
    micRecordProgram: environment.SONNY_MIC_RECORD_PROGRAM,
    pythonCommand: environment.SONNY_PYTHON_COMMAND,
    serviceStartupTimeoutMs: parseOptionalInteger(environment.SONNY_SERVICE_STARTUP_TIMEOUT_MS),
    vadSpeechThreshold: parseOptionalNumber(environment.SONNY_VAD_SPEECH_THRESHOLD),
    vadMinSpeechChunks: parseOptionalInteger(environment.SONNY_VAD_MIN_SPEECH_CHUNKS),
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

class PlaybackVadMonitor {
  private readonly sampleRateHertz: number;
  private readonly channels: number;
  private readonly recordProgram: string;
  private readonly speechThreshold: number;
  private readonly minSpeechChunks: number;

  private recorder: RecorderRuntime | undefined;
  private source: NodeJS.ReadableStream | undefined;
  private speechChunks = 0;
  private started = false;
  private onSpeech: (() => Promise<void>) | undefined;

  public constructor(config: {
    sampleRateHertz: number;
    channels: number;
    recordProgram: string;
    speechThreshold: number;
    minSpeechChunks: number;
  }) {
    this.sampleRateHertz = config.sampleRateHertz;
    this.channels = config.channels;
    this.recordProgram = config.recordProgram;
    this.speechThreshold = config.speechThreshold;
    this.minSpeechChunks = config.minSpeechChunks;
  }

  public async start(onSpeech: () => Promise<void>): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    this.onSpeech = onSpeech;
    this.recorder = await this.createRecorder();
    this.source = this.recorder.stream();

    this.source.on('data', (chunk: unknown) => {
      void this.handleChunk(chunk);
    });
  }

  public async stop(): Promise<void> {
    this.started = false;
    this.speechChunks = 0;
    this.source?.removeAllListeners('data');
    this.source = undefined;

    try {
      this.recorder?.stop?.();
    } finally {
      this.recorder = undefined;
      this.onSpeech = undefined;
    }
  }

  private async handleChunk(chunk: unknown): Promise<void> {
    if (!this.started) {
      return;
    }

    const audioChunk = toBuffer(chunk);

    if (audioChunk.length < 2) {
      return;
    }

    const rms = calculateNormalizedRms(audioChunk);

    if (rms >= this.speechThreshold) {
      this.speechChunks += 1;
    } else {
      this.speechChunks = 0;
    }

    if (this.speechChunks < this.minSpeechChunks) {
      return;
    }

    this.speechChunks = 0;
    const callback = this.onSpeech;

    if (callback === undefined) {
      return;
    }

    await this.stop();
    await callback();
  }

  private async createRecorder(): Promise<RecorderRuntime> {
    const module = await loadModule('node-record-lpcm16');
    const container = resolveExportContainer(module);
    const options: RecorderOptions = {
      sampleRateHertz: this.sampleRateHertz,
      channels: this.channels,
      threshold: 0,
      verbose: false,
      recordProgram: this.recordProgram,
      silence: DEFAULT_VAD_SILENCE_SECONDS.toFixed(1),
    };
    const candidates = [
      readFactory(container, 'record'),
      readFactory(container, 'start'),
    ];

    for (const candidate of candidates) {
      if (candidate === undefined) {
        continue;
      }

      const created = await candidate(options);

      return assertRecorderRuntime(created);
    }

    if (typeof module === 'function') {
      const created = await module(options);

      return assertRecorderRuntime(created);
    }

    throw new Error(
      'Unable to initialize node-record-lpcm16 for playback interruption monitoring.',
    );
  }
}

function spawnManagedProcess(config: {
  name: string;
  pythonCommand: string;
  scriptPath: string;
  environment: Record<string, string>;
}): ManagedProcessHandle {
  const child = spawn(config.pythonCommand, [config.scriptPath], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ...config.environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });
  const stderr = createInterface({
    input: child.stderr,
    crlfDelay: Infinity,
  });

  stderr.on('line', (line) => {
    process.stderr.write(`[voice:${config.name}] ${line}\n`);
  });

  return {
    name: config.name,
    child,
    stdout,
    stderr,
  };
}

async function stopManagedProcess(processHandle: ManagedProcessHandle): Promise<void> {
  processHandle.stdout.close();
  processHandle.stderr.close();

  if (processHandle.child.exitCode !== null || processHandle.child.killed) {
    return;
  }

  processHandle.child.kill('SIGTERM');
  const settled = await Promise.race([
    once(processHandle.child, 'exit').then(() => true),
    delay(5_000).then(() => false),
  ]);

  if (!settled) {
    processHandle.child.kill('SIGKILL');
    await once(processHandle.child, 'exit').catch(() => undefined);
  }
}

async function isServiceHealthy(healthUrl: string): Promise<boolean> {
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(2_000),
    });

    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHttpReady(
  healthUrl: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(1_000),
      });

      if (response.ok || response.status >= 400) {
        return;
      }
    } catch {
      await delay(250);
      continue;
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for HTTP service readiness at ${healthUrl}`);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, '');
}

function toWhisperEnvironment(baseUrl: string): Record<string, string> {
  const parsed = new URL(baseUrl);

  return {
    FASTER_WHISPER_HOST: parsed.hostname,
    FASTER_WHISPER_PORT: parsed.port.length > 0 ? parsed.port : '8000',
  };
}

function toTtsEnvironment(baseUrl: string): Record<string, string> {
  const parsed = new URL(baseUrl);

  return {
    QWEN3_TTS_HOST: parsed.hostname,
    QWEN3_TTS_PORT: parsed.port.length > 0 ? parsed.port : '8001',
  };
}

async function loadModule(specifier: string): Promise<unknown> {
  const dynamicImport = new Function(
    'moduleSpecifier',
    'return import(moduleSpecifier);',
  ) as (moduleSpecifier: string) => Promise<unknown>;

  return dynamicImport(specifier);
}

function resolveExportContainer(module: unknown): Record<string, unknown> {
  if (!isRecord(module)) {
    throw new Error('Dynamic module export must be an object');
  }

  const defaultExport = module.default;

  if (isRecord(defaultExport)) {
    return defaultExport;
  }

  return module;
}

function readFactory(
  container: Record<string, unknown>,
  property: string,
): ((options: RecorderOptions) => unknown | Promise<unknown>) | undefined {
  const value = container[property];

  return typeof value === 'function'
    ? (value as (options: RecorderOptions) => unknown | Promise<unknown>)
    : undefined;
}

function assertRecorderRuntime(value: unknown): RecorderRuntime {
  if (isReadableStream(value)) {
    return {
      stream: () => value,
    };
  }

  if (!isRecord(value) || typeof value.stream !== 'function') {
    throw new Error('Recorder runtime is missing stream()');
  }

  return {
    stream: value.stream as () => NodeJS.ReadableStream,
    stop:
      typeof value.stop === 'function'
        ? (value.stop.bind(value) as () => void)
        : undefined,
  };
}

function isReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return (
    isRecord(value) &&
    typeof value.on === 'function' &&
    typeof value.once === 'function'
  );
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }

  if (typeof chunk === 'string') {
    return Buffer.from(chunk);
  }

  throw new Error('Recorder emitted an unsupported chunk type');
}

function calculateNormalizedRms(chunk: Buffer): number {
  const samples = Math.floor(chunk.length / 2);

  if (samples === 0) {
    return 0;
  }

  let sumSquares = 0;

  for (let index = 0; index < samples; index += 1) {
    const sample = chunk.readInt16LE(index * 2) / 32768;

    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / samples);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
