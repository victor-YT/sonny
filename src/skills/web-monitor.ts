import { createHash } from 'node:crypto';

import {
  MonitorRegistry,
  type MonitorDefinition,
} from './monitor-registry.js';

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONTENT_LENGTH = 200_000;
const DIFF_SAMPLE_LIMIT = 5;

export interface MonitorSnapshot {
  monitorId: string;
  url: string;
  contentHash: string;
  content: string;
  checkedAt: Date;
  statusCode: number;
  contentType: string | null;
}

export interface MonitorDiff {
  addedLines: string[];
  removedLines: string[];
}

export interface MonitorChangeEvent {
  monitor: MonitorDefinition;
  previous: MonitorSnapshot;
  current: MonitorSnapshot;
  diff: MonitorDiff;
  summary: string;
}

export interface MonitorCheckResult {
  monitor: MonitorDefinition;
  snapshot: MonitorSnapshot;
  changed: boolean;
  initialized: boolean;
  change?: MonitorChangeEvent;
}

export interface WebMonitorConfig {
  monitorRegistry?: MonitorRegistry;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
  fetchTimeoutMs?: number;
  maxContentLength?: number;
}

type ChangeListener = (event: MonitorChangeEvent) => void | Promise<void>;

export class WebMonitor {
  private readonly monitorRegistry: MonitorRegistry;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => Date;
  private readonly fetchTimeoutMs: number;
  private readonly maxContentLength: number;
  private readonly snapshots: Map<string, MonitorSnapshot>;
  private readonly changeListeners: Set<ChangeListener>;

  public constructor(config: WebMonitorConfig = {}) {
    this.monitorRegistry = config.monitorRegistry ?? new MonitorRegistry();
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.clock = config.clock ?? (() => new Date());
    this.fetchTimeoutMs = config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.maxContentLength = config.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
    this.snapshots = new Map<string, MonitorSnapshot>();
    this.changeListeners = new Set<ChangeListener>();
  }

  public listSnapshots(): MonitorSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  public onChange(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);

    return () => {
      this.changeListeners.delete(listener);
    };
  }

  public async checkMonitor(monitor: MonitorDefinition): Promise<MonitorCheckResult> {
    const normalizedMonitor = this.monitorRegistry
      .listMonitors()
      .find((entry) => entry.id === monitor.id);

    if (normalizedMonitor === undefined) {
      throw new Error(`Monitor "${monitor.id}" is not registered`);
    }

    const snapshot = await this.fetchSnapshot(normalizedMonitor);
    const previousSnapshot = this.snapshots.get(normalizedMonitor.id);

    this.snapshots.set(normalizedMonitor.id, snapshot);

    if (previousSnapshot === undefined) {
      return {
        monitor: normalizedMonitor,
        snapshot,
        changed: false,
        initialized: true,
      };
    }

    if (previousSnapshot.contentHash === snapshot.contentHash) {
      return {
        monitor: normalizedMonitor,
        snapshot,
        changed: false,
        initialized: false,
      };
    }

    const diff = this.createDiff(previousSnapshot.content, snapshot.content);
    const change: MonitorChangeEvent = {
      monitor: normalizedMonitor,
      previous: previousSnapshot,
      current: snapshot,
      diff,
      summary: this.createChangeSummary(diff),
    };

    await this.emitChange(change);

    return {
      monitor: normalizedMonitor,
      snapshot,
      changed: true,
      initialized: false,
      change,
    };
  }

  public async checkEnabledMonitors(): Promise<MonitorCheckResult[]> {
    const monitors = this.monitorRegistry.listEnabledMonitors();
    const results: MonitorCheckResult[] = [];

    for (const monitor of monitors) {
      results.push(await this.checkMonitor(monitor));
    }

    return results;
  }

  private async fetchSnapshot(monitor: MonitorDefinition): Promise<MonitorSnapshot> {
    const response = await this.fetchImpl(monitor.url, {
      signal: AbortSignal.timeout(this.fetchTimeoutMs),
      headers: {
        'user-agent': 'sonny-web-monitor/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(
        `Monitor request failed for "${monitor.url}" with status ${response.status} ${response.statusText}`,
      );
    }

    const checkedAt = this.clock();
    const rawContent = await response.text();
    const normalizedContent = this.normalizeContent(rawContent);

    return {
      monitorId: monitor.id,
      url: monitor.url,
      contentHash: this.hashContent(normalizedContent),
      content: normalizedContent,
      checkedAt,
      statusCode: response.status,
      contentType: response.headers.get('content-type'),
    };
  }

  private normalizeContent(content: string): string {
    const normalized = content.replace(/\r\n/g, '\n').trim();

    if (normalized.length <= this.maxContentLength) {
      return normalized;
    }

    return normalized.slice(0, this.maxContentLength);
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private createDiff(previousContent: string, currentContent: string): MonitorDiff {
    const previousLines = this.normalizeLines(previousContent);
    const currentLines = this.normalizeLines(currentContent);
    const previousSet = new Set(previousLines);
    const currentSet = new Set(currentLines);
    const addedLines = currentLines.filter((line) => !previousSet.has(line));
    const removedLines = previousLines.filter((line) => !currentSet.has(line));

    return {
      addedLines: addedLines.slice(0, DIFF_SAMPLE_LIMIT),
      removedLines: removedLines.slice(0, DIFF_SAMPLE_LIMIT),
    };
  }

  private normalizeLines(content: string): string[] {
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private createChangeSummary(diff: MonitorDiff): string {
    const summaryParts: string[] = [];

    if (diff.addedLines.length > 0) {
      summaryParts.push(`${diff.addedLines.length} added line(s)`);
    }

    if (diff.removedLines.length > 0) {
      summaryParts.push(`${diff.removedLines.length} removed line(s)`);
    }

    if (summaryParts.length === 0) {
      return 'Content changed, but no line-level diff summary is available';
    }

    return summaryParts.join(', ');
  }

  private async emitChange(event: MonitorChangeEvent): Promise<void> {
    for (const listener of this.changeListeners) {
      await listener(event);
    }
  }
}
