import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_MONITOR_REGISTRY_PATH = join(
  process.cwd(),
  'data',
  'monitors.json',
);

export interface MonitorDefinition {
  id: string;
  url: string;
  intervalMinutes: number;
  enabled: boolean;
}

interface MonitorRegistryFile {
  monitors?: unknown;
}

export interface MonitorRegistryConfig {
  filePath?: string;
}

export class MonitorRegistry {
  private readonly filePath: string;

  public constructor(config: MonitorRegistryConfig = {}) {
    this.filePath = config.filePath ?? DEFAULT_MONITOR_REGISTRY_PATH;

    this.ensureRegistryFile();
  }

  public get path(): string {
    return this.filePath;
  }

  public listMonitors(): MonitorDefinition[] {
    return this.readRegistry().monitors;
  }

  public listEnabledMonitors(): MonitorDefinition[] {
    return this.listMonitors().filter((monitor) => monitor.enabled);
  }

  public upsertMonitor(monitor: MonitorDefinition): MonitorDefinition[] {
    const normalizedMonitor = this.normalizeMonitor(monitor);
    const monitors = this.listMonitors();
    const existingIndex = monitors.findIndex(
      (entry) => entry.id === normalizedMonitor.id,
    );

    if (existingIndex >= 0) {
      monitors.splice(existingIndex, 1, normalizedMonitor);
    } else {
      monitors.push(normalizedMonitor);
    }

    this.writeRegistry(monitors);

    return monitors;
  }

  public removeMonitor(id: string): boolean {
    const normalizedId = this.parseId(id);
    const monitors = this.listMonitors();
    const nextMonitors = monitors.filter((monitor) => monitor.id !== normalizedId);

    if (nextMonitors.length === monitors.length) {
      return false;
    }

    this.writeRegistry(nextMonitors);

    return true;
  }

  private ensureRegistryFile(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });

    if (existsSync(this.filePath)) {
      return;
    }

    this.writeRegistry([]);
  }

  private readRegistry(): { monitors: MonitorDefinition[] } {
    let content: string;

    try {
      content = readFileSync(this.filePath, 'utf8');
    } catch (error: unknown) {
      throw new Error(
        `Failed to read monitor registry at "${this.filePath}": ${this.toErrorMessage(error)}`,
      );
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(content);
    } catch (error: unknown) {
      throw new Error(
        `Failed to parse monitor registry at "${this.filePath}": ${this.toErrorMessage(error)}`,
      );
    }

    if (!this.isRecord(parsed)) {
      throw new Error(`Monitor registry at "${this.filePath}" must be a JSON object`);
    }

    return {
      monitors: this.parseMonitorList((parsed as MonitorRegistryFile).monitors),
    };
  }

  private writeRegistry(monitors: MonitorDefinition[]): void {
    writeFileSync(
      this.filePath,
      `${JSON.stringify({ monitors }, null, 2)}\n`,
      'utf8',
    );
  }

  private parseMonitorList(value: unknown): MonitorDefinition[] {
    if (value === undefined) {
      return [];
    }

    if (!Array.isArray(value)) {
      throw new Error('Monitor registry field "monitors" must be an array');
    }

    return value.map((monitor, index) => this.parseMonitor(monitor, index));
  }

  private parseMonitor(value: unknown, index: number): MonitorDefinition {
    if (!this.isRecord(value)) {
      throw new Error(`Monitor at index ${index} must be an object`);
    }

    return this.normalizeMonitor({
      id: value.id,
      url: value.url,
      intervalMinutes: value.intervalMinutes,
      enabled: value.enabled,
    });
  }

  private normalizeMonitor(value: {
    id: unknown;
    url: unknown;
    intervalMinutes: unknown;
    enabled: unknown;
  }): MonitorDefinition {
    return {
      id: this.parseId(value.id),
      url: this.parseUrl(value.url),
      intervalMinutes: this.parseIntervalMinutes(value.intervalMinutes),
      enabled: this.parseEnabled(value.enabled),
    };
  }

  private parseId(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('Monitor id must be a non-empty string');
    }

    return value.trim();
  }

  private parseUrl(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('Monitor url must be a non-empty string');
    }

    let parsedUrl: URL;

    try {
      parsedUrl = new URL(value.trim());
    } catch (error: unknown) {
      throw new Error(`Monitor url is invalid: ${this.toErrorMessage(error)}`);
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('Monitor url must use http or https');
    }

    return parsedUrl.toString();
  }

  private parseIntervalMinutes(value: unknown): number {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value <= 0
    ) {
      throw new Error('Monitor intervalMinutes must be a positive number');
    }

    return value;
  }

  private parseEnabled(value: unknown): boolean {
    if (typeof value !== 'boolean') {
      throw new Error('Monitor enabled must be a boolean');
    }

    return value;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown error';
  }
}

export function getDefaultMonitorRegistryPath(): string {
  return DEFAULT_MONITOR_REGISTRY_PATH;
}
