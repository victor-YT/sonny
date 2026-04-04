import { existsSync, watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type { NotificationManager } from './notification-manager.js';

export interface MonitoredPathDefinition {
  id?: string;
  path: string;
  label?: string;
  recursive?: boolean;
}

export interface MonitoredPath extends MonitoredPathDefinition {
  id: string;
  path: string;
  recursive: boolean;
}

export interface FileChangeEvent {
  type: 'path_changed';
  monitoredPath: MonitoredPath;
  changedPath: string;
  eventType: 'change' | 'rename';
  exists: boolean;
  timestamp: number;
}

export interface EventMonitorErrorEvent {
  type: 'error';
  error: Error;
  monitoredPath?: MonitoredPath;
  timestamp: number;
}

export type EventMonitorEvent = FileChangeEvent | EventMonitorErrorEvent;
export type EventMonitorListener = (event: EventMonitorEvent) => void;

export interface EventMonitorConfig {
  paths?: MonitoredPathDefinition[];
  cwd?: string;
  debounceWindowMs?: number;
  notificationManager?: NotificationManager;
}

interface WatchRegistration {
  readonly path: MonitoredPath;
  readonly watcher: FSWatcher;
  readonly watchTarget: string;
  readonly matchesFilename: boolean;
}

const DEFAULT_DEBOUNCE_WINDOW_MS = 250;

export class EventMonitor {
  private readonly cwd: string;
  private readonly debounceWindowMs: number;
  private readonly notificationManager: NotificationManager | undefined;
  private readonly listeners = new Set<EventMonitorListener>();
  private readonly paths = new Map<string, MonitoredPath>();
  private readonly watchers = new Map<string, WatchRegistration>();
  private readonly lastEventAt = new Map<string, number>();

  private started = false;

  public constructor(config: EventMonitorConfig = {}) {
    this.cwd = config.cwd ?? process.cwd();
    this.debounceWindowMs =
      config.debounceWindowMs ?? DEFAULT_DEBOUNCE_WINDOW_MS;
    this.notificationManager = config.notificationManager;

    if (config.paths !== undefined) {
      for (const definition of config.paths) {
        const monitoredPath = normalizeMonitoredPath(definition, this.cwd);
        this.paths.set(monitoredPath.id, monitoredPath);
      }
    }
  }

  public get isRunning(): boolean {
    return this.started;
  }

  public onEvent(listener: EventMonitorListener): void {
    this.listeners.add(listener);
  }

  public removeListener(listener: EventMonitorListener): void {
    this.listeners.delete(listener);
  }

  public getPaths(): MonitoredPath[] {
    return [...this.paths.values()].map((entry) => ({ ...entry }));
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    try {
      for (const monitoredPath of this.paths.values()) {
        await this.attachWatcher(monitoredPath);
      }
    } catch (error: unknown) {
      await this.stop();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.started = false;

    for (const registration of this.watchers.values()) {
      registration.watcher.close();
    }

    this.watchers.clear();
    this.lastEventAt.clear();
  }

  public async addPath(definition: MonitoredPathDefinition): Promise<MonitoredPath> {
    const monitoredPath = normalizeMonitoredPath(definition, this.cwd);
    this.paths.set(monitoredPath.id, monitoredPath);

    if (this.started) {
      await this.detachWatcher(monitoredPath.id);
      await this.attachWatcher(monitoredPath);
    }

    return monitoredPath;
  }

  public async replacePaths(
    definitions: MonitoredPathDefinition[],
  ): Promise<MonitoredPath[]> {
    const wasStarted = this.started;
    await this.stop();
    this.paths.clear();

    const monitoredPaths = definitions.map((definition) =>
      normalizeMonitoredPath(definition, this.cwd),
    );

    for (const monitoredPath of monitoredPaths) {
      this.paths.set(monitoredPath.id, monitoredPath);
    }

    if (wasStarted) {
      await this.start();
    }

    return monitoredPaths;
  }

  public async removePath(pathId: string): Promise<boolean> {
    await this.detachWatcher(pathId);
    this.lastEventAt.delete(pathId);
    return this.paths.delete(pathId);
  }

  private async attachWatcher(monitoredPath: MonitoredPath): Promise<void> {
    const registration = await this.createWatchRegistration(monitoredPath);
    this.watchers.set(monitoredPath.id, registration);
  }

  private async detachWatcher(pathId: string): Promise<void> {
    const registration = this.watchers.get(pathId);

    if (registration === undefined) {
      return;
    }

    registration.watcher.close();
    this.watchers.delete(pathId);
  }

  private async createWatchRegistration(
    monitoredPath: MonitoredPath,
  ): Promise<WatchRegistration> {
    const watchTarget = await resolveWatchTarget(monitoredPath.path);
    const shouldMatchFilename = watchTarget !== monitoredPath.path;
    const watcher = this.createFsWatcher(
      monitoredPath,
      watchTarget,
      shouldMatchFilename,
    );

    return {
      path: monitoredPath,
      watcher,
      watchTarget,
      matchesFilename: shouldMatchFilename,
    };
  }

  private createFsWatcher(
    monitoredPath: MonitoredPath,
    watchTarget: string,
    matchesFilename: boolean,
  ): FSWatcher {
    try {
      return watch(
        watchTarget,
        { recursive: monitoredPath.recursive },
        (eventType, filename) => {
          this.handleFsEvent(monitoredPath, watchTarget, matchesFilename, eventType, filename);
        },
      );
    } catch (error: unknown) {
      if (
        monitoredPath.recursive &&
        isRecursiveWatchUnsupported(error)
      ) {
        return watch(watchTarget, (eventType, filename) => {
          this.handleFsEvent(monitoredPath, watchTarget, matchesFilename, eventType, filename);
        });
      }

      const resolvedError = toError(error, `Failed to watch "${monitoredPath.path}"`);
      this.emit({
        type: 'error',
        error: resolvedError,
        monitoredPath: { ...monitoredPath },
        timestamp: Date.now(),
      });
      void this.notificationManager?.notify({
        title: monitoredPath.label?.trim() || 'Event Monitor Error',
        message: resolvedError.message,
        badge: '!',
      });
      throw resolvedError;
    }
  }

  private handleFsEvent(
    monitoredPath: MonitoredPath,
    watchTarget: string,
    matchesFilename: boolean,
    eventType: 'change' | 'rename',
    filename: string | Buffer | null,
  ): void {
    const changedPath = resolveChangedPath(
      monitoredPath,
      watchTarget,
      matchesFilename,
      filename,
    );

    if (changedPath === undefined) {
      return;
    }

    const eventKey = `${monitoredPath.id}:${eventType}:${changedPath}`;
    const timestamp = Date.now();
    const previousTimestamp = this.lastEventAt.get(eventKey);

    if (
      previousTimestamp !== undefined &&
      timestamp - previousTimestamp < this.debounceWindowMs
    ) {
      return;
    }

    this.lastEventAt.set(eventKey, timestamp);
    this.emit({
      type: 'path_changed',
      monitoredPath: { ...monitoredPath },
      changedPath,
      eventType,
      exists: existsSync(changedPath),
      timestamp,
    });
  }

  private emit(event: EventMonitorEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function normalizeMonitoredPath(
  definition: MonitoredPathDefinition,
  cwd: string,
): MonitoredPath {
  const rawPath = definition.path.trim();

  if (rawPath.length === 0) {
    throw new Error('Monitored path is required');
  }

  const resolvedPath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  const id = definition.id?.trim() || resolvedPath;

  if (id.length === 0) {
    throw new Error('Monitored path id is required');
  }

  return {
    id,
    path: resolvedPath,
    label: definition.label,
    recursive: definition.recursive ?? true,
  };
}

async function resolveWatchTarget(path: string): Promise<string> {
  try {
    const targetStats = await stat(path);
    return targetStats.isDirectory() ? path : dirname(path);
  } catch (error: unknown) {
    const resolvedError = toError(error, `Failed to resolve watch target for "${path}"`);

    if (getErrorCode(error) === 'ENOENT') {
      return dirname(path);
    }

    throw resolvedError;
  }
}

function resolveChangedPath(
  monitoredPath: MonitoredPath,
  watchTarget: string,
  matchesFilename: boolean,
  filename: string | Buffer | null,
): string | undefined {
  if (!matchesFilename) {
    if (filename === null) {
      return monitoredPath.path;
    }

    const relativeName = filename.toString();
    return relativeName.length === 0 ? monitoredPath.path : join(watchTarget, relativeName);
  }

  if (filename === null) {
    return monitoredPath.path;
  }

  const relativeName = filename.toString();

  if (relativeName.length === 0) {
    return monitoredPath.path;
  }

  if (basename(monitoredPath.path) !== relativeName) {
    return undefined;
  }

  return monitoredPath.path;
}

function isRecursiveWatchUnsupported(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === 'TypeError' || error.message.includes('recursive');
}

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(fallbackMessage);
}

function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }

  return undefined;
}
