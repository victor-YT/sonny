import { randomUUID } from 'node:crypto';

import type { MonitorChangeEvent } from '../skills/web-monitor.js';
import { RecentMemory } from '../memory/recent-memory.js';

const PROACTIVE_AGENT_SESSION_ID = 'proactive-agent';
const DEFAULT_NOTIFICATION_LIMIT = 100;

export interface ProactiveNotification {
  id: string;
  type: 'monitor-change';
  title: string;
  body: string;
  createdAt: Date;
  metadata: {
    monitorId: string;
    url: string;
  };
}

export interface ProactiveAgentConfig {
  recentMemory?: RecentMemory;
  clock?: () => Date;
  notificationLimit?: number;
}

type NotificationListener = (
  notification: ProactiveNotification,
) => void | Promise<void>;

export class ProactiveAgent {
  private readonly recentMemory: RecentMemory;
  private readonly clock: () => Date;
  private readonly notificationLimit: number;
  private readonly listeners: Set<NotificationListener>;
  private readonly notifications: ProactiveNotification[];

  public constructor(config: ProactiveAgentConfig = {}) {
    this.recentMemory = config.recentMemory ?? new RecentMemory();
    this.clock = config.clock ?? (() => new Date());
    this.notificationLimit = config.notificationLimit ?? DEFAULT_NOTIFICATION_LIMIT;
    this.listeners = new Set<NotificationListener>();
    this.notifications = [];
  }

  public listNotifications(): ProactiveNotification[] {
    return [...this.notifications];
  }

  public onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
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
      body: this.buildNotificationBody(event),
      createdAt,
      metadata: {
        monitorId: event.monitor.id,
        url: event.monitor.url,
      },
    };

    this.notifications.unshift(notification);
    this.notifications.splice(this.notificationLimit);
    this.recentMemory.addMessage({
      sessionId: PROACTIVE_AGENT_SESSION_ID,
      role: 'assistant',
      content: `${notification.title}\n${notification.body}`,
      createdAt,
    });

    for (const listener of this.listeners) {
      await listener(notification);
    }

    return notification;
  }

  public close(): void {
    this.recentMemory.close();
  }

  private buildNotificationBody(event: MonitorChangeEvent): string {
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
}

export function getProactiveAgentSessionId(): string {
  return PROACTIVE_AGENT_SESSION_ID;
}
