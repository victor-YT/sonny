import type {
  WakeWordConfig,
  WakeWordEvent,
  WakeWordListener,
  WakeWordProvider,
} from './wake-word.js';

const DEFAULT_BASE_URL = 'http://localhost:8002';
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

interface WakeWordServiceMessage {
  type?: string;
  keyword?: string;
  wakeWord?: string;
  wake_word?: string;
  timestamp?: number;
}

class WakeWordUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WakeWordUnavailableError';
  }
}

export interface PorcupineConfig extends WakeWordConfig {
  baseUrl?: string;
  requestTimeoutMs?: number;
}

export class PorcupineProvider implements WakeWordProvider {
  public readonly name = 'openwakeword';

  private readonly baseUrl: string;
  private readonly keywords: string[];
  private readonly requestTimeoutMs: number;
  private readonly listeners = new Set<WakeWordListener>();

  private websocket: WebSocket | undefined;
  private stopping = false;

  public constructor(config: PorcupineConfig) {
    const keywords = config.keywords
      .map((keyword) => keyword.trim().toLowerCase())
      .filter((keyword) => keyword.length > 0);

    if (keywords.length === 0) {
      throw new Error('openWakeWord requires at least one keyword');
    }

    this.baseUrl = this.normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.keywords = keywords;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  public get isListening(): boolean {
    return this.websocket !== undefined && !this.stopping;
  }

  public onDetection(listener: WakeWordListener): void {
    this.listeners.add(listener);
  }

  public removeListener(listener: WakeWordListener): void {
    this.listeners.delete(listener);
  }

  public async start(): Promise<void> {
    if (this.websocket !== undefined) {
      return;
    }

    this.stopping = false;

    try {
      await this.assertServiceReachable();
      await this.connectWebSocket();
      this.emit({
        type: 'ready',
        timestamp: Date.now(),
      });
    } catch (error: unknown) {
      await this.cleanup();

      if (error instanceof WakeWordUnavailableError) {
        console.warn(
          `[voice] Wake-word service unavailable at ${this.baseUrl}; wake word disabled and push-to-talk remains available.`,
        );
        return;
      }

      const providerError = this.toError(error, 'openWakeWord failed to start');

      this.emit({
        type: 'error',
        error: providerError,
        timestamp: Date.now(),
      });

      throw providerError;
    }
  }

  public async stop(): Promise<void> {
    this.stopping = true;

    const websocket = this.websocket;
    this.websocket = undefined;

    if (websocket !== undefined) {
      websocket.close();
    }

    await this.cleanup();
  }

  private async assertServiceReachable(): Promise<void> {
    const endpoints = [
      { path: '/status', method: 'POST' },
      { path: '/status', method: 'GET' },
      { path: '/health', method: 'GET' },
    ] as const;
    let lastError: Error | undefined;

    for (const endpoint of endpoints) {
      try {
        await this.fetchWithTimeout(new URL(endpoint.path, this.baseUrl).toString(), {
          method: endpoint.method,
        });
        return;
      } catch (error: unknown) {
        lastError = this.toError(error, 'Wake-word service probe failed');
      }
    }

    throw new WakeWordUnavailableError(
      lastError?.message ?? `Unable to reach wake-word service at ${this.baseUrl}`,
    );
  }

  private async connectWebSocket(): Promise<void> {
    const websocketUrl = this.toWebSocketUrl();

    await new Promise<void>((resolve, reject) => {
      const websocket = new WebSocket(websocketUrl);
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        websocket.close();
        reject(
          new WakeWordUnavailableError(
            `Timed out connecting to wake-word service websocket at ${websocketUrl}`,
          ),
        );
      }, this.requestTimeoutMs);
      const clearTimer = (): void => {
        clearTimeout(timeoutId);
      };

      websocket.onopen = () => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimer();
        this.websocket = websocket;
        resolve();
      };

      websocket.onmessage = (event) => {
        void this.handleMessage(event.data);
      };

      websocket.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimer();
          reject(
            new WakeWordUnavailableError(
              `Unable to connect to wake-word service websocket at ${websocketUrl}`,
            ),
          );
          return;
        }

        if (!this.stopping) {
          console.warn(
            `[voice] Wake-word service websocket error at ${this.baseUrl}; wake word is disabled until restart.`,
          );
          this.websocket = undefined;
        }
      };

      websocket.onclose = () => {
        this.websocket = undefined;

        if (!settled) {
          settled = true;
          clearTimer();
          reject(
            new WakeWordUnavailableError(
              `Wake-word service websocket closed before it was ready at ${websocketUrl}`,
            ),
          );
          return;
        }

        if (!this.stopping) {
          console.warn(
            `[voice] Wake-word service websocket closed at ${this.baseUrl}; wake word is disabled until restart.`,
          );
        }
      };
    });
  }

  private async handleMessage(payload: unknown): Promise<void> {
    const message = this.parseMessage(payload);

    if (message === undefined) {
      return;
    }

    const isDetectionEvent =
      message.type === 'detected' ||
      message.type === 'wake_word_detected' ||
      message.type === 'wake-word-detected';

    if (!isDetectionEvent) {
      return;
    }

    const keywordValue =
      message.keyword ??
      message.wakeWord ??
      message.wake_word;

    if (keywordValue === undefined) {
      return;
    }

    const keyword = keywordValue.trim().toLowerCase();

    if (!this.keywords.includes(keyword)) {
      return;
    }

    this.emit({
      type: 'detected',
      keyword,
      timestamp: message.timestamp ?? Date.now(),
    });
  }

  private parseMessage(payload: unknown): WakeWordServiceMessage | undefined {
    if (typeof payload !== 'string') {
      return undefined;
    }

    try {
      const parsed = JSON.parse(payload) as unknown;

      if (!this.isRecord(parsed)) {
        return undefined;
      }

      return parsed;
    } catch {
      return undefined;
    }
  }

  private async fetchWithTimeout(
    input: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.requestTimeoutMs);

    try {
      return await fetch(input, {
        ...init,
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.name === 'AbortError'
      ) {
        throw new WakeWordUnavailableError(
          `Wake-word service request timed out after ${this.requestTimeoutMs}ms`,
        );
      }

      throw new WakeWordUnavailableError(
        this.toError(error, 'Wake-word service request failed').message,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private toWebSocketUrl(): string {
    const url = new URL('/ws', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  private normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/u, '');
  }

  private async cleanup(): Promise<void> {
    this.websocket = undefined;
    this.stopping = false;
  }

  private emit(event: WakeWordEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private toError(error: unknown, fallbackMessage: string): Error {
    if (error instanceof Error) {
      return error;
    }

    return new Error(fallbackMessage);
  }

  private isRecord(value: unknown): value is WakeWordServiceMessage {
    return typeof value === 'object' && value !== null;
  }
}
