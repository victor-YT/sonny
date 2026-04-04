import type { MonitorDefinition } from '../skills/monitor-registry.js';
import { MonitorRegistry } from '../skills/monitor-registry.js';
import { WebMonitor } from '../skills/web-monitor.js';

const MINIMUM_INTERVAL_MS = 1_000;

export interface MonitorSchedulerConfig {
  monitorRegistry?: MonitorRegistry;
  webMonitor?: WebMonitor;
  runImmediately?: boolean;
  onError?: (error: unknown, monitor: MonitorDefinition) => void;
}

export class MonitorScheduler {
  private readonly monitorRegistry: MonitorRegistry;
  private readonly webMonitor: WebMonitor;
  private readonly runImmediately: boolean;
  private readonly onError?: (error: unknown, monitor: MonitorDefinition) => void;
  private readonly intervalHandles: Map<string, NodeJS.Timeout>;
  private readonly activeChecks: Set<string>;

  public constructor(config: MonitorSchedulerConfig = {}) {
    this.monitorRegistry = config.monitorRegistry ?? new MonitorRegistry();
    this.webMonitor = config.webMonitor ?? new WebMonitor();
    this.runImmediately = config.runImmediately ?? true;
    this.onError = config.onError;
    this.intervalHandles = new Map<string, NodeJS.Timeout>();
    this.activeChecks = new Set<string>();
  }

  public start(): void {
    this.refresh();
  }

  public refresh(): void {
    this.stop();

    for (const monitor of this.monitorRegistry.listEnabledMonitors()) {
      this.scheduleMonitor(monitor);
    }
  }

  public stop(): void {
    for (const handle of this.intervalHandles.values()) {
      clearInterval(handle);
    }

    this.intervalHandles.clear();
  }

  private scheduleMonitor(monitor: MonitorDefinition): void {
    const intervalMs = Math.max(
      Math.trunc(monitor.intervalMinutes * 60_000),
      MINIMUM_INTERVAL_MS,
    );
    const runCheck = async (): Promise<void> => {
      if (this.activeChecks.has(monitor.id)) {
        return;
      }

      this.activeChecks.add(monitor.id);

      try {
        await this.webMonitor.checkMonitor(monitor);
      } catch (error: unknown) {
        this.onError?.(error, monitor);
      } finally {
        this.activeChecks.delete(monitor.id);
      }
    };
    const handle = setInterval(() => {
      void runCheck();
    }, intervalMs);

    handle.unref();
    this.intervalHandles.set(monitor.id, handle);

    if (this.runImmediately) {
      void runCheck();
    }
  }
}
