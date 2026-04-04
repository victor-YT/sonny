import type {
  WakeWordConfig,
  WakeWordEvent,
  WakeWordListener,
  WakeWordProvider,
} from './wake-word.js';

const PORCUPINE_MODULE = '@picovoice/porcupine-node';
const PV_RECORDER_MODULE = '@picovoice/pvrecorder-node';

interface PorcupineRuntime {
  frameLength: number;
  process(frame: Int16Array): number | Promise<number>;
  release?(): void | Promise<void>;
  delete?(): void | Promise<void>;
}

interface PvRecorderRuntime {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  read(): Promise<Int16Array | number[]>;
  release?(): void | Promise<void>;
  delete?(): void | Promise<void>;
}

export interface PorcupineConfig extends WakeWordConfig {
  accessKey: string;
  modelPath?: string;
}

export class PorcupineProvider implements WakeWordProvider {
  public readonly name = 'porcupine';

  private readonly config: PorcupineConfig;
  private readonly listeners = new Set<WakeWordListener>();

  private porcupine: PorcupineRuntime | undefined;
  private recorder: PvRecorderRuntime | undefined;
  private listenTask: Promise<void> | undefined;
  private stopping = false;

  public constructor(config: PorcupineConfig) {
    if (config.keywords.length === 0) {
      throw new Error('Porcupine requires at least one keyword');
    }

    this.config = config;
  }

  public get isListening(): boolean {
    return this.listenTask !== undefined && !this.stopping;
  }

  public onDetection(listener: WakeWordListener): void {
    this.listeners.add(listener);
  }

  public removeListener(listener: WakeWordListener): void {
    this.listeners.delete(listener);
  }

  public async start(): Promise<void> {
    if (this.listenTask !== undefined) {
      return;
    }

    this.stopping = false;

    try {
      this.porcupine = await this.createPorcupine();
      this.recorder = await this.createRecorder(this.porcupine.frameLength);

      await this.recorder.start();
      this.emit({
        type: 'ready',
        timestamp: Date.now(),
      });

      this.listenTask = this.listenLoop();
    } catch (error: unknown) {
      await this.cleanup();
      const providerError = this.toError(error, 'Porcupine failed to start');

      this.emit({
        type: 'error',
        error: providerError,
        timestamp: Date.now(),
      });

      throw providerError;
    }
  }

  public async stop(): Promise<void> {
    const currentTask = this.listenTask;

    if (currentTask === undefined) {
      return;
    }

    this.stopping = true;

    if (this.recorder !== undefined) {
      await this.callCleanupMethod(this.recorder, 'stop');
    }

    try {
      await currentTask;
    } finally {
      await this.cleanup();
    }
  }

  private async listenLoop(): Promise<void> {
    try {
      while (!this.stopping && this.porcupine !== undefined && this.recorder !== undefined) {
        const frameData = await this.recorder.read();

        if (this.stopping) {
          break;
        }

        const keywordIndex = await this.porcupine.process(
          this.toFrame(frameData, this.porcupine.frameLength),
        );

        if (keywordIndex >= 0) {
          const keyword = this.config.keywords[keywordIndex] ?? this.config.keywords[0];

          this.emit({
            type: 'detected',
            keyword,
            timestamp: Date.now(),
          });
        }
      }
    } catch (error: unknown) {
      if (!this.stopping) {
        const providerError = this.toError(error, 'Porcupine detection loop failed');

        this.emit({
          type: 'error',
          error: providerError,
          timestamp: Date.now(),
        });

        throw providerError;
      }
    } finally {
      this.listenTask = undefined;
    }
  }

  private async createPorcupine(): Promise<PorcupineRuntime> {
    const module = await this.loadModule(PORCUPINE_MODULE);
    const container = this.resolveExportContainer(module);
    const sensitivities = this.buildSensitivities();
    const keywords = [...this.config.keywords];

    const createCandidates = [
      this.readFunction(container, 'create'),
      this.readNestedFunction(container, 'Porcupine', 'create'),
    ];

    for (const candidate of createCandidates) {
      if (candidate !== undefined) {
        const created = await candidate(
          this.config.accessKey,
          keywords,
          sensitivities,
          this.config.modelPath,
        );

        return this.assertPorcupineRuntime(created);
      }
    }

    const PorcupineConstructor = this.readConstructor(container, 'Porcupine');

    if (PorcupineConstructor !== undefined) {
      const created = new PorcupineConstructor(
        this.config.accessKey,
        keywords,
        sensitivities,
        this.config.modelPath,
      );

      return this.assertPorcupineRuntime(created);
    }

    throw new Error(
      'Unable to initialize Porcupine. Expected create() or Porcupine constructor export.',
    );
  }

  private async createRecorder(frameLength: number): Promise<PvRecorderRuntime> {
    const module = await this.loadModule(PV_RECORDER_MODULE);
    const container = this.resolveExportContainer(module);
    const deviceIndex = this.config.audioDeviceIndex;
    const createCandidates = [
      this.readFunction(container, 'create'),
      this.readNestedFunction(container, 'PvRecorder', 'create'),
    ];

    for (const candidate of createCandidates) {
      if (candidate !== undefined) {
        const created = await candidate(frameLength, deviceIndex);

        return this.assertRecorderRuntime(created);
      }
    }

    const RecorderConstructor = this.readConstructor(container, 'PvRecorder');

    if (RecorderConstructor !== undefined) {
      const created = new RecorderConstructor(frameLength, deviceIndex);

      return this.assertRecorderRuntime(created);
    }

    throw new Error(
      'Unable to initialize PvRecorder. Expected create() or PvRecorder constructor export.',
    );
  }

  private buildSensitivities(): number[] {
    const sensitivity = this.config.sensitivity ?? 0.5;

    return this.config.keywords.map(() => sensitivity);
  }

  private toFrame(data: Int16Array | number[], expectedLength: number): Int16Array {
    const frame = data instanceof Int16Array ? data : Int16Array.from(data);

    if (frame.length !== expectedLength) {
      throw new Error(
        `Porcupine recorder returned frame length ${frame.length}, expected ${expectedLength}`,
      );
    }

    return frame;
  }

  private emit(event: WakeWordEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async cleanup(): Promise<void> {
    const recorder = this.recorder;
    const porcupine = this.porcupine;

    this.recorder = undefined;
    this.porcupine = undefined;
    this.listenTask = undefined;
    this.stopping = false;

    if (recorder !== undefined) {
      await this.callCleanupMethod(recorder, 'release');
      await this.callCleanupMethod(recorder, 'delete');
    }

    if (porcupine !== undefined) {
      await this.callCleanupMethod(porcupine, 'release');
      await this.callCleanupMethod(porcupine, 'delete');
    }
  }

  private async callCleanupMethod(
    value: unknown,
    methodName: 'stop' | 'release' | 'delete',
  ): Promise<void> {
    if (!this.isRecord(value)) {
      return;
    }

    const method = value[methodName];

    if (typeof method === 'function') {
      await method.call(value);
    }
  }

  private async loadModule(specifier: string): Promise<unknown> {
    const dynamicImport = new Function(
      'moduleSpecifier',
      'return import(moduleSpecifier);',
    ) as (moduleSpecifier: string) => Promise<unknown>;

    try {
      return await dynamicImport(specifier);
    } catch (error: unknown) {
      throw this.toError(
        error,
        `Missing runtime dependency ${specifier}. Install the Picovoice SDK packages before using Porcupine.`,
      );
    }
  }

  private resolveExportContainer(module: unknown): Record<string, unknown> {
    if (!this.isRecord(module)) {
      throw new Error('Dynamic module export must be an object');
    }

    const defaultExport = module.default;

    if (this.isRecord(defaultExport)) {
      return defaultExport;
    }

    return module;
  }

  private readFunction(
    container: Record<string, unknown>,
    property: string,
  ):
    | ((...args: unknown[]) => unknown | Promise<unknown>)
    | undefined {
    const value = container[property];

    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown | Promise<unknown>)
      : undefined;
  }

  private readNestedFunction(
    container: Record<string, unknown>,
    parentProperty: string,
    property: string,
  ):
    | ((...args: unknown[]) => unknown | Promise<unknown>)
    | undefined {
    const parentValue = container[parentProperty];

    if (!this.isRecord(parentValue)) {
      return undefined;
    }

    const value = parentValue[property];

    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown | Promise<unknown>)
      : undefined;
  }

  private readConstructor(
    container: Record<string, unknown>,
    property: string,
  ): (new (...args: unknown[]) => unknown) | undefined {
    const value = container[property];

    return typeof value === 'function'
      ? (value as new (...args: unknown[]) => unknown)
      : undefined;
  }

  private assertPorcupineRuntime(value: unknown): PorcupineRuntime {
    if (!this.isRecord(value)) {
      throw new Error('Porcupine instance must be an object');
    }

    if (typeof value.frameLength !== 'number') {
      throw new Error('Porcupine instance is missing frameLength');
    }

    if (typeof value.process !== 'function') {
      throw new Error('Porcupine instance is missing process(frame)');
    }

    return value as unknown as PorcupineRuntime;
  }

  private assertRecorderRuntime(value: unknown): PvRecorderRuntime {
    if (!this.isRecord(value)) {
      throw new Error('PvRecorder instance must be an object');
    }

    if (typeof value.start !== 'function') {
      throw new Error('PvRecorder instance is missing start()');
    }

    if (typeof value.stop !== 'function') {
      throw new Error('PvRecorder instance is missing stop()');
    }

    if (typeof value.read !== 'function') {
      throw new Error('PvRecorder instance is missing read()');
    }

    return value as unknown as PvRecorderRuntime;
  }

  private toError(error: unknown, fallbackMessage: string): Error {
    if (error instanceof Error) {
      return error;
    }

    return new Error(fallbackMessage);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
