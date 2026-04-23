import { spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export interface ManualRecorderConfig {
  sampleRateHertz: number;
  channels: number;
  recorder: string;
  device?: string | null;
  audioType?: 'wav';
  startTimeoutMs?: number;
  onDiagnosticEvent?: (event: RecorderDiagnosticEvent) => void;
}

interface RecorderOptions {
  sampleRate: number;
  channels: number;
  audioType: string;
  recorder: string;
  threshold: number;
  thresholdStart: number;
  thresholdStop: number;
  silence: string;
  verbose: boolean;
}

interface RecorderRuntime {
  stream(): NodeJS.ReadableStream;
  stop?(): void;
  process?: ChildProcess;
}

export type RecorderFailureReason =
  | 'backend_missing'
  | 'spawn_failed'
  | 'permission_denied_suspected'
  | 'no_audio_data'
  | 'start_timeout'
  | 'unknown';

export interface RecorderDebugInfo {
  backend: string;
  backendPath: string | null;
  backendAvailable: boolean;
  command: string | null;
  args: string[];
  inputSource: string | null;
  requestedSampleRateHertz: number | null;
  requestedChannels: number | null;
  outputFormat: string | null;
  outputTransport: string | null;
  debugMode: string | null;
  device: string | null;
  defaultInputDeviceName?: string | null;
  availableInputDevices?: string[];
  usingDefaultDevice: boolean;
  spawnStarted: boolean;
  firstChunkReceived: boolean;
  startTimeoutMs: number;
  bytesCaptured?: number | null;
  captureEndedBy?: 'silence' | 'max_timeout' | 'manual' | 'abort' | 'unknown';
  endOfTurnReason?: 'silence' | 'max_timeout' | 'manual' | 'interrupted' | 'unknown';
  firstNonEmptyChunkReceived?: boolean | null;
  endedBeforeFirstChunk?: boolean | null;
  vadRequestCount?: number | null;
  vadSpeechChunkCount?: number | null;
  vadSilenceChunkCount?: number | null;
  vadDroppedChunkCount?: number | null;
  vadSpeechMs?: number | null;
  vadSilenceMs?: number | null;
  speechStarted?: boolean | null;
  silenceDetected?: boolean | null;
  speechThresholdMs?: number | null;
  silenceThresholdMs?: number | null;
  minAutoStopCaptureMs?: number | null;
  micGainDb?: number | null;
  lastChunkRmsLevel?: number | null;
  avgChunkRmsLevel?: number | null;
  maxChunkRmsLevel?: number | null;
  peakAmplitude?: number | null;
  rmsLevel?: number | null;
  silentRatio?: number | null;
  inputAppearsSilent?: boolean | null;
  audioQualityHint?: string | null;
  likelyFailureCause?: string | null;
  captureAborted?: boolean;
  lastCaptureError?: string | null;
  lastStderr: string | null;
  lastSpawnError: string | null;
  lastFailureReason: RecorderFailureReason | null;
  micPermissionHint: string | null;
}

export interface RecorderDiagnosticEvent {
  type:
    | 'recording_backend_detected'
    | 'recording_backend_missing'
    | 'recording_spawn_started'
    | 'recording_spawn_failed'
    | 'recording_stderr'
    | 'recording_first_chunk_received'
    | 'recording_start_timeout'
    | 'recording_start_failed';
  level: 'info' | 'warn' | 'error';
  message: string;
  meta: Record<string, string | number | boolean | null>;
  snapshot: RecorderDebugInfo;
}

export class ManualRecorderError extends Error {
  public readonly reason: RecorderFailureReason;
  public readonly diagnostics: RecorderDebugInfo;

  public constructor(
    message: string,
    reason: RecorderFailureReason,
    diagnostics: RecorderDebugInfo,
  ) {
    super(message);
    this.name = 'ManualRecorderError';
    this.reason = reason;
    this.diagnostics = diagnostics;
  }
}

const DEFAULT_START_TIMEOUT_MS = 5_000;
const STOP_WAIT_TIMEOUT_MS = 1_500;
const STDERR_PREVIEW_LIMIT = 400;
const STDERR_HISTORY_LIMIT = 2_000;

export class ManualRecorderSession {
  private readonly recorder: RecorderRuntime;
  private readonly source: NodeJS.ReadableStream;
  private readonly chunks: Buffer[] = [];
  private readonly debugInfo: RecorderDebugInfo;
  private readonly emitDiagnostic: (
    event: RecorderDiagnosticEvent['type'],
    message: string,
    meta?: RecorderDiagnosticEvent['meta'],
    level?: RecorderDiagnosticEvent['level'],
  ) => void;
  private readonly startFailurePromise: Promise<Error>;
  private readonly firstChunkPromise: Promise<void>;

  private resolveFirstChunk!: () => void;
  private rejectStartFailure!: (error: Error) => void;

  private stopped = false;
  private streamError: Error | undefined;
  private startFailureCaptured = false;
  private firstChunkCaptured = false;

  private constructor(
    recorder: RecorderRuntime,
    source: NodeJS.ReadableStream,
    debugInfo: RecorderDebugInfo,
    emitDiagnostic: ManualRecorderSession['emitDiagnostic'],
  ) {
    this.recorder = recorder;
    this.source = source;
    this.debugInfo = debugInfo;
    this.emitDiagnostic = emitDiagnostic;

    this.firstChunkPromise = new Promise<void>((resolve) => {
      this.resolveFirstChunk = resolve;
    });
    this.startFailurePromise = new Promise<Error>((_resolve, reject) => {
      this.rejectStartFailure = reject;
    });

    this.source.on('data', (chunk: unknown) => {
      const audioChunk = toBuffer(chunk);

      if (audioChunk.length === 0) {
        return;
      }

      this.chunks.push(audioChunk);

      if (!this.firstChunkCaptured) {
        this.firstChunkCaptured = true;
        this.debugInfo.firstChunkReceived = true;
        this.resolveFirstChunk();
        this.emitDiagnostic(
          'recording_first_chunk_received',
          `Recorder backend "${this.debugInfo.backend}" emitted the first audio chunk.`,
          {
            backend: this.debugInfo.backend,
            bytes: audioChunk.length,
          },
        );
      }
    });

    this.source.on('error', (error: unknown) => {
      const resolvedError = toError(error, 'Recorder stream emitted an unknown error');

      this.streamError = resolvedError;
      this.debugInfo.lastSpawnError = resolvedError.message;
      this.debugInfo.lastFailureReason = classifyFailureReason(this.debugInfo, resolvedError.message);
      this.rejectStartFailureOnce(resolvedError);
    });

    const childProcess = this.recorder.process;

    if (childProcess !== undefined) {
      if (childProcess.pid !== undefined) {
        this.debugInfo.spawnStarted = true;
        this.emitDiagnostic(
          'recording_spawn_started',
          `Recorder backend "${this.debugInfo.backend}" spawned successfully.`,
          {
            backend: this.debugInfo.backend,
            pid: childProcess.pid,
          },
        );
      }

      childProcess.once('spawn', () => {
        this.debugInfo.spawnStarted = true;
        this.emitDiagnostic(
          'recording_spawn_started',
          `Recorder backend "${this.debugInfo.backend}" spawned successfully.`,
          {
            backend: this.debugInfo.backend,
            pid: childProcess.pid ?? null,
          },
        );
      });

      childProcess.stderr?.on('data', (chunk: Buffer | string) => {
        const message = normalizeDiagnosticText(chunk);

        if (message.length === 0) {
          return;
        }

        this.debugInfo.lastStderr = appendStderr(this.debugInfo.lastStderr, message);
        this.emitDiagnostic(
          'recording_stderr',
          `Recorder backend "${this.debugInfo.backend}" wrote to stderr: ${truncateForMessage(message)}`,
          {
            backend: this.debugInfo.backend,
            stderr: truncateForMeta(message),
          },
          'warn',
        );
      });

      childProcess.once('error', (error: Error) => {
        this.debugInfo.lastSpawnError = error.message;
        this.debugInfo.lastFailureReason = classifyFailureReason(this.debugInfo, error.message);
        this.rejectStartFailureOnce(error);
      });
    }
  }

  public static async start(
    config: ManualRecorderConfig,
  ): Promise<ManualRecorderSession> {
    const debugInfo = createRecorderDebugInfo(config);
    const emitDiagnostic = createDiagnosticEmitter(
      debugInfo,
      config.onDiagnosticEvent,
    );
    const backendPath = findExecutablePath(config.recorder);

    debugInfo.backendPath = backendPath;
    debugInfo.backendAvailable = backendPath !== null;

    if (backendPath === null) {
      debugInfo.lastFailureReason = 'backend_missing';
      emitDiagnostic(
        'recording_backend_missing',
        `Recorder backend "${config.recorder}" is not installed or not available in PATH.`,
        {
          backend: config.recorder,
          backendAvailable: false,
        },
        'error',
      );
      const error = new ManualRecorderError(
        `Recorder backend "${config.recorder}" is missing. Install it or update the mic recorder setting.`,
        'backend_missing',
        cloneRecorderDebugInfo(debugInfo),
      );

      emitDiagnostic(
        'recording_start_failed',
        error.message,
        {
          backend: config.recorder,
          reason: error.reason,
        },
        'error',
      );
      throw error;
    }

    emitDiagnostic(
      'recording_backend_detected',
      `Recorder backend "${config.recorder}" is available at ${backendPath}.`,
      {
        backend: config.recorder,
        backendPath,
        backendAvailable: true,
      },
    );
    emitDiagnostic(
      'recording_spawn_started',
      `Starting recorder backend "${config.recorder}" with a ${debugInfo.startTimeoutMs}ms readiness timeout.`,
      {
        backend: config.recorder,
        backendPath,
        startTimeoutMs: debugInfo.startTimeoutMs,
      },
    );

    let recorder: RecorderRuntime;

    try {
      recorder = await createRecorder(config);
    } catch (error: unknown) {
      const message = toErrorMessage(error);

      debugInfo.lastSpawnError = message;
      debugInfo.lastFailureReason = classifyFailureReason(debugInfo, message);
      emitDiagnostic(
        'recording_spawn_failed',
        `Recorder backend "${config.recorder}" failed to spawn: ${message}`,
        {
          backend: config.recorder,
          backendPath,
          reason: debugInfo.lastFailureReason,
        },
        'error',
      );
      emitDiagnostic(
        'recording_start_failed',
        `Recorder backend "${config.recorder}" could not start: ${message}`,
        {
          backend: config.recorder,
          reason: debugInfo.lastFailureReason,
        },
        'error',
      );
      throw new ManualRecorderError(
        `Recorder backend "${config.recorder}" failed to start: ${message}`,
        debugInfo.lastFailureReason ?? 'spawn_failed',
        cloneRecorderDebugInfo(debugInfo),
      );
    }

    const source = recorder.stream();
    const session = new ManualRecorderSession(
      recorder,
      source,
      debugInfo,
      emitDiagnostic,
    );

    await session.waitUntilReady();

    return session;
  }

  public getDebugInfo(): RecorderDebugInfo {
    return cloneRecorderDebugInfo(this.debugInfo);
  }

  public async stop(): Promise<Buffer> {
    if (this.stopped) {
      return Buffer.concat(this.chunks);
    }

    this.stopped = true;
    const completion = Promise.race([
      onceReadableEnded(this.source),
      delay(STOP_WAIT_TIMEOUT_MS),
    ]);

    try {
      this.recorder.stop?.();
    } finally {
      await completion;
      this.source.removeAllListeners();
      this.recorder.process?.removeAllListeners();
      this.recorder.process?.stderr?.removeAllListeners();
    }

    if (this.streamError !== undefined && this.chunks.length === 0) {
      throw new ManualRecorderError(
        this.streamError.message,
        classifyFailureReason(this.debugInfo, this.streamError.message),
        this.getDebugInfo(),
      );
    }

    const audio = Buffer.concat(this.chunks);

    if (audio.byteLength === 0) {
      this.debugInfo.lastFailureReason = 'no_audio_data';
      throw new ManualRecorderError(
        'Recording completed but no audio data was captured.',
        'no_audio_data',
        this.getDebugInfo(),
      );
    }

    return audio;
  }

  public async cancel(): Promise<void> {
    try {
      await this.stop();
    } catch {
      // Ignore recorder teardown errors during cancellation.
    } finally {
      this.chunks.splice(0);
    }
  }

  private async waitUntilReady(): Promise<void> {
    if (this.recorder.process?.pid !== undefined) {
      this.debugInfo.spawnStarted = true;
      return;
    }

    const result = await Promise.race([
      this.firstChunkPromise.then(() => 'chunk' as const),
      this.startFailurePromise.then((error) => ({ type: 'failure' as const, error })),
      delay(this.debugInfo.startTimeoutMs).then(() => 'timeout' as const),
    ]);

    if (result === 'chunk') {
      return;
    }

    if (result === 'timeout') {
      this.debugInfo.lastFailureReason = 'start_timeout';
      const error = new ManualRecorderError(
        buildStartTimeoutMessage(this.debugInfo),
        'start_timeout',
        this.getDebugInfo(),
      );

      this.emitDiagnostic(
        'recording_start_timeout',
        error.message,
        {
          backend: this.debugInfo.backend,
          backendAvailable: this.debugInfo.backendAvailable,
          firstChunkReceived: this.debugInfo.firstChunkReceived,
          spawnStarted: this.debugInfo.spawnStarted,
          stderr: truncateForMeta(this.debugInfo.lastStderr),
        },
        'error',
      );
      this.emitDiagnostic(
        'recording_start_failed',
        error.message,
        {
          backend: this.debugInfo.backend,
          reason: error.reason,
        },
        'error',
      );
      throw error;
    }

    const reason = classifyFailureReason(this.debugInfo, result.error.message);
    const error = new ManualRecorderError(
      buildStartFailureMessage(this.debugInfo, result.error.message),
      reason,
      this.getDebugInfo(),
    );

    if (!this.debugInfo.spawnStarted) {
      this.emitDiagnostic(
        'recording_spawn_failed',
        `Recorder backend "${this.debugInfo.backend}" failed before audio became available: ${result.error.message}`,
        {
          backend: this.debugInfo.backend,
          reason,
          stderr: truncateForMeta(this.debugInfo.lastStderr),
        },
        'error',
      );
    }

    this.emitDiagnostic(
      'recording_start_failed',
      error.message,
      {
        backend: this.debugInfo.backend,
        reason,
      },
      'error',
    );
    throw error;
  }

  private rejectStartFailureOnce(error: Error): void {
    if (this.startFailureCaptured) {
      return;
    }

    this.startFailureCaptured = true;
    this.rejectStartFailure(error);
  }
}

async function createRecorder(
  config: ManualRecorderConfig,
): Promise<RecorderRuntime> {
  const module = await loadModule('node-record-lpcm16');
  const container = resolveExportContainer(module);
  const options: RecorderOptions = {
    sampleRate: config.sampleRateHertz,
    channels: config.channels,
    audioType: config.audioType ?? 'wav',
    recorder: config.recorder,
    threshold: 0,
    thresholdStart: 0.5,
    thresholdStop: 0.5,
    silence: '60.0',
    verbose: false,
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

  throw new Error('Unable to initialize node-record-lpcm16 for manual recording.');
}

async function onceReadableEnded(stream: NodeJS.ReadableStream): Promise<void> {
  await new Promise<void>((resolve) => {
    let resolved = false;

    const finish = (): void => {
      if (resolved) {
        return;
      }

      resolved = true;
      stream.removeListener('end', finish);
      stream.removeListener('close', finish);
      stream.removeListener('error', finish);
      resolve();
    };

    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', finish);
  });
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
  if (!isRecord(value) || typeof value.stream !== 'function') {
    throw new Error('Recorder runtime is missing stream()');
  }

  return {
    stream: value.stream.bind(value) as () => NodeJS.ReadableStream,
    stop:
      typeof value.stop === 'function'
        ? (value.stop.bind(value) as () => void)
        : undefined,
    process: isChildProcess(value.process) ? value.process : undefined,
  };
}

function createRecorderDebugInfo(
  config: ManualRecorderConfig,
): RecorderDebugInfo {
  return {
    backend: config.recorder,
    backendPath: null,
    backendAvailable: false,
    command: null,
    args: [],
    inputSource: config.device ?? '-d',
    requestedSampleRateHertz: config.sampleRateHertz,
    requestedChannels: config.channels,
    outputFormat: config.audioType ?? 'wav',
    outputTransport: 'stdout_stream',
    debugMode: null,
    device: config.device ?? 'default',
    usingDefaultDevice:
      config.device === undefined ||
      config.device === null ||
      config.device === 'default',
    spawnStarted: false,
    firstChunkReceived: false,
    startTimeoutMs: config.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    lastStderr: null,
    lastSpawnError: null,
    lastFailureReason: null,
    micPermissionHint: getMicPermissionHint(),
  };
}

function createDiagnosticEmitter(
  debugInfo: RecorderDebugInfo,
  listener: ManualRecorderConfig['onDiagnosticEvent'],
): ManualRecorderSession['emitDiagnostic'] {
  return (type, message, meta = {}, level = 'info') => {
    listener?.({
      type,
      level,
      message,
      meta,
      snapshot: cloneRecorderDebugInfo(debugInfo),
    });
  };
}

function findExecutablePath(command: string): string | null {
  const result = spawnSync('which', [command], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    return null;
  }

  const output = result.stdout.trim();

  return output.length > 0 ? output : null;
}

function normalizeDiagnosticText(value: Buffer | string): string {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;

  return text.trim();
}

function appendStderr(current: string | null, message: string): string {
  const next = current === null ? message : `${current}\n${message}`;

  return next.slice(-STDERR_HISTORY_LIMIT);
}

function truncateForMessage(value: string): string {
  return value.length <= STDERR_PREVIEW_LIMIT
    ? value
    : `${value.slice(0, STDERR_PREVIEW_LIMIT)}...`;
}

function truncateForMeta(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  return truncateForMessage(value);
}

function buildStartTimeoutMessage(debugInfo: RecorderDebugInfo): string {
  return [
    `Recorder backend "${debugInfo.backend}" did not become ready within ${debugInfo.startTimeoutMs}ms.`,
    `backendAvailable=${debugInfo.backendAvailable}`,
    `spawnStarted=${debugInfo.spawnStarted}`,
    `firstChunkReceived=${debugInfo.firstChunkReceived}`,
    debugInfo.lastStderr === null
      ? 'stderr=none'
      : `stderr=${truncateForMessage(debugInfo.lastStderr)}`,
  ].join(' ');
}

function buildStartFailureMessage(
  debugInfo: RecorderDebugInfo,
  message: string,
): string {
  const stderrSuffix =
    debugInfo.lastStderr === null
      ? ''
      : ` Stderr: ${truncateForMessage(debugInfo.lastStderr)}`;

  return `Recorder backend "${debugInfo.backend}" failed to start: ${message}.${stderrSuffix}`;
}

function classifyFailureReason(
  debugInfo: RecorderDebugInfo,
  message: string,
): RecorderFailureReason {
  const normalized = `${message}\n${debugInfo.lastStderr ?? ''}`.toLowerCase();

  if (!debugInfo.backendAvailable) {
    return 'backend_missing';
  }

  if (
    normalized.includes('permission denied') ||
    normalized.includes('operation not permitted') ||
    normalized.includes('not authorized') ||
    normalized.includes('microphone') ||
    normalized.includes('cannot open audio device') ||
    normalized.includes('audio open error')
  ) {
    return 'permission_denied_suspected';
  }

  if (normalized.includes('timed out')) {
    return 'start_timeout';
  }

  if (normalized.includes('no audio data')) {
    return 'no_audio_data';
  }

  if (
    normalized.includes('spawn') ||
    normalized.includes('enoent') ||
    normalized.includes('exited with error code') ||
    debugInfo.lastSpawnError !== null
  ) {
    return 'spawn_failed';
  }

  return 'unknown';
}

function getMicPermissionHint(): string | null {
  if (process.platform !== 'darwin') {
    return null;
  }

  return 'Check System Settings > Privacy & Security > Microphone and allow Terminal or Electron.';
}

function cloneRecorderDebugInfo(value: RecorderDebugInfo): RecorderDebugInfo {
  return {
    ...value,
  };
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

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === 'string') {
    return new Error(error);
  }

  return new Error(fallbackMessage);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isChildProcess(value: unknown): value is ChildProcess {
  return (
    isRecord(value) &&
    typeof value.kill === 'function' &&
    'pid' in value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
