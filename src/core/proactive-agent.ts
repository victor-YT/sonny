import { randomUUID } from 'node:crypto';

import { RecentMemory } from '../memory/recent-memory.js';
import type { MonitorChangeEvent } from '../skills/web-monitor.js';
import type { NotificationManager } from './notification-manager.js';
import {
  EventMonitor,
  type EventMonitorConfig,
  type EventMonitorEvent,
  type FileChangeEvent,
  type MonitoredPath,
  type MonitoredPathDefinition,
} from './event-monitor.js';
import {
  Scheduler,
  type ScheduledTask,
  type ScheduledTaskDefinition,
  type ScheduledTaskEvent,
  type SchedulerConfig,
} from './scheduler.js';

const PROACTIVE_AGENT_SESSION_ID = 'proactive-agent';
const DEFAULT_NOTIFICATION_LIMIT = 100;
const DEFAULT_FILE_CHANGE_COOLDOWN_MS = 5 * 60_000;

export interface ProactiveNotification {
  id: string;
  type: 'monitor-change' | 'scheduled-task' | 'file-change';
  title: string;
  body: string;
  createdAt: Date;
  metadata: Record<string, string>;
  task?: ScheduledTask;
  monitoredPath?: MonitoredPath;
  changedPath?: string;
}

export interface ProactiveAgentConfig {
  recentMemory?: RecentMemory;
  clock?: () => Date;
  notificationLimit?: number;
  scheduler?: Scheduler;
  schedulerConfig?: SchedulerConfig;
  eventMonitor?: EventMonitor;
  eventMonitorConfig?: EventMonitorConfig;
  notificationManager?: NotificationManager;
  fileChangeCooldownMs?: number;
}

type NotificationListener = (
  notification: ProactiveNotification,
) => void | Promise<void>;

type ErrorListener = (error: Error) => void | Promise<void>;

export class ProactiveAgent {
  private readonly recentMemory: RecentMemory;
  private readonly clock: () => Date;
  private readonly notificationLimit: number;
  private readonly scheduler: Scheduler;
  private readonly eventMonitor: EventMonitor;
  private readonly notificationManager: NotificationManager | undefined;
  private readonly fileChangeCooldownMs: number;
  private readonly notificationListeners: Set<NotificationListener>;
  private readonly errorListeners: Set<ErrorListener>;
  private readonly notifications: ProactiveNotification[];
  private readonly lastFileNotificationAt: Map<string, number>;

  private started = false;

  public constructor(config: ProactiveAgentConfig = {}) {
    this.recentMemory = config.recentMemory ?? new RecentMemory();
    this.clock = config.clock ?? (() => new Date());
    this.notificationLimit = config.notificationLimit ?? DEFAULT_NOTIFICATION_LIMIT;
    this.scheduler = config.scheduler ?? new Scheduler(config.schedulerConfig);
    this.notificationManager = config.notificationManager;
    this.eventMonitor =
      config.eventMonitor ??
      new EventMonitor({
        ...config.eventMonitorConfig,
        notificationManager:
          config.eventMonitorConfig?.notificationManager ??
          config.notificationManager,
      });
    this.fileChangeCooldownMs =
      config.fileChangeCooldownMs ?? DEFAULT_FILE_CHANGE_COOLDOWN_MS;
    this.notificationListeners = new Set<NotificationListener>();
    this.errorListeners = new Set<ErrorListener>();
    this.notifications = [];
    this.lastFileNotificationAt = new Map<string, number>();

    this.scheduler.onTask((event) => {
      this.handleScheduledTask(event);
    });
    this.eventMonitor.onEvent((event) => {
      this.handleMonitorEvent(event);
    });
  }

  public get isRunning(): boolean {
    return this.started;
  }

  public get scheduledTasks(): ScheduledTask[] {
    return this.scheduler.getTasks();
  }

  public get monitoredPaths(): MonitoredPath[] {
    return this.eventMonitor.getPaths();
  }

  public listNotifications(): ProactiveNotification[] {
    return [...this.notifications];
  }

  public onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);

    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  public onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);

    return () => {
      this.errorListeners.delete(listener);
    };
  }

  public async notifyMonitorChange(
    event: MonitorChangeEvent,
  ): Promise<ProactiveNotification> {
    const createdAt = this.clock();
    const notification: ProactiveNotification = {
      id: randomUUID(),
      type: 'monitor-change',
      title: `Change detected for ${event.monitor.id}`,
      body: this.buildMonitorChangeBody(event),
      createdAt,
      metadata: {
        monitorId: event.monitor.id,
        url: event.monitor.url,
      },
    };

    return this.recordNotification(notification);
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    try {
      this.scheduler.start();
      await this.eventMonitor.start();
    } catch (error: unknown) {
      this.started = false;
      await this.emitError(toError(error, 'Failed to start proactive agent'));
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;
    this.scheduler.stop();
    await this.eventMonitor.stop();
  }

  public setScheduledTasks(
    definitions: ScheduledTaskDefinition[],
  ): ScheduledTask[] {
    return this.scheduler.replaceTasks(definitions);
  }

  public async addMonitoredPath(
    definition: MonitoredPathDefinition,
  ): Promise<MonitoredPath> {
    return this.eventMonitor.addPath(definition);
  }

  public async setMonitoredPaths(
    definitions: MonitoredPathDefinition[],
  ): Promise<MonitoredPath[]> {
    return this.eventMonitor.replacePaths(definitions);
  }

  public close(): void {
    this.scheduler.stop();
    void this.eventMonitor.stop();
    this.recentMemory.close();
  }

  private handleScheduledTask(event: ScheduledTaskEvent): void {
    const createdAt = new Date(event.timestamp);
    const title = event.task.title?.trim() || humanizeIdentifier(event.task.id);
    const notification: ProactiveNotification = {
      id: randomUUID(),
      type: 'scheduled-task',
      title,
      body: event.task.prompt,
      createdAt,
      metadata: {
        taskId: event.task.id,
        scheduledFor: event.scheduledFor.toISOString(),
      },
      task: event.task,
    };

    void this.recordNotification(notification).catch((error: unknown) => {
      void this.emitError(toError(error, 'Failed to record scheduled task notification'));
    });
  }

  private handleMonitorEvent(event: EventMonitorEvent): void {
    if (event.type === 'error') {
      void this.emitError(event.error);
      return;
    }

    const notification = this.buildFileChangeNotification(event);

    if (notification === null) {
      return;
    }

    void this.recordNotification(notification).catch((error: unknown) => {
      void this.emitError(toError(error, 'Failed to record file change notification'));
    });
  }

  private buildFileChangeNotification(
    event: FileChangeEvent,
  ): ProactiveNotification | null {
    const createdAt = this.clock();
    const eventKey = `${event.monitoredPath.id}:${event.changedPath}`;
    const now = createdAt.getTime();
    const lastNotificationAt = this.lastFileNotificationAt.get(eventKey);

    if (
      lastNotificationAt !== undefined &&
      now - lastNotificationAt < this.fileChangeCooldownMs
    ) {
      return null;
    }

    this.lastFileNotificationAt.set(eventKey, now);

    return {
      id: randomUUID(),
      type: 'file-change',
      title: `File change detected for ${resolveNotificationLabel(event.monitoredPath)}`,
      body: formatFileChangeBody(event),
      createdAt,
      metadata: {
        monitoredPathId: event.monitoredPath.id,
        watchedPath: event.monitoredPath.path,
        changedPath: event.changedPath,
        eventType: event.eventType,
        exists: String(event.exists),
      },
      monitoredPath: event.monitoredPath,
      changedPath: event.changedPath,
    };
  }

  private async recordNotification(
    notification: ProactiveNotification,
  ): Promise<ProactiveNotification> {
    this.notifications.unshift(notification);
    this.notifications.splice(this.notificationLimit);
    this.recentMemory.addMessage({
      sessionId: PROACTIVE_AGENT_SESSION_ID,
      role: 'assistant',
      content: `${notification.title}\n${notification.body}`.trim(),
      createdAt: notification.createdAt,
    });

    for (const listener of this.notificationListeners) {
      await listener(notification);
    }

    if (this.notificationManager !== undefined) {
      await this.notificationManager.notify({
        title: notification.title,
        message: notification.body,
        badge: resolveNotificationBadge(notification),
      });
    }

    return notification;
  }

  private buildMonitorChangeBody(event: MonitorChangeEvent): string {
    const lines = [
      `URL: ${event.monitor.url}`,
      `Summary: ${event.summary}`,
    ];

    if (event.diff.addedLines.length > 0) {
      lines.push(`Added: ${event.diff.addedLines.join(' | ')}`);
    }

    if (event.diff.removedLines.length > 0) {
      lines.push(`Removed: ${event.diff.removedLines.join(' | ')}`);
    }

    return lines.join('\n');
  }

  private async emitError(error: Error): Promise<void> {
    for (const listener of this.errorListeners) {
      await listener(error);
    }
  }
}

export function getProactiveAgentSessionId(): string {
  return PROACTIVE_AGENT_SESSION_ID;
}

function formatFileChangeBody(event: FileChangeEvent): string {
  const action = describeFileChange(event);

  return [
    `Watch: ${event.monitoredPath.path}`,
    `Path: ${event.changedPath}`,
    `Action: ${action}`,
  ].join('\n');
}

function describeFileChange(event: FileChangeEvent): string {
  if (event.eventType === 'change') {
    return 'updated';
  }

  return event.exists ? 'created or renamed' : 'removed or renamed away';
}

function resolveNotificationLabel(monitoredPath: MonitoredPath): string {
  const label = monitoredPath.label?.trim();

  if (label !== undefined && label.length > 0) {
    return label;
  }

  return humanizeIdentifier(monitoredPath.id);
}

function resolveNotificationBadge(notification: ProactiveNotification): string {
  switch (notification.type) {
    case 'monitor-change':
      return 'W';
    case 'scheduled-task':
      return 'S';
    case 'file-change':
      return 'F';
    default:
      return '•';
  }
}

function humanizeIdentifier(value: string): string {
  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    return 'Proactive Update';
  }

  const collapsed = trimmedValue
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return collapsed
    .split(' ')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(fallbackMessage);
}
