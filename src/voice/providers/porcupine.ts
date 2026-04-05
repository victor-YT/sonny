import type {
  WakeWordConfig,
  WakeWordEvent,
  WakeWordListener,
  WakeWordProvider,
} from './wake-word.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
interface DetectionMessage {
  type?: string;
  keyword?: string;
  timestamp?: number;
}

export interface PorcupineConfig extends WakeWordConfig {
  baseUrl: string;
  requestTimeoutMs?: number;
}

export class PorcupineProvider implements WakeWordProvider {
  public readonly name = 'openwakeword';

  private readonly config: PorcupineConfig;
  private readonly listeners = new Set<WakeWordListener>();

  private websocket: WebSocket | undefined;
  private stopping = false;

  public constructor(config: PorcupineConfig) {
    if (config.keywords.length === 0) {
      throw new Error('openWakeWord requires at least one keyword');
    }

    this.config = {
      ...config,
      keywords: config.keywords.map((keyword) => keyword.trim().toLowerCase()),
    };
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

  private async connectWebSocket(): Promise<void> {
    const websocketUrl = this.toWebSocketUrl();

    await new Promise<void>((resolve, reject) => {
      const websocket = new WebSocket(websocketUrl);
      let settled = false;

      websocket.onopen = () => {
        settled = true;
        this.websocket = websocket;
        resolve();
      };

      websocket.onmessage = (event) => {
        void this.handleMessage(event.data);
      };

      websocket.onerror = () => {
        if (!settled) {
          reject(new Error(`Unable to connect to wake-word service at ${websocketUrl}`));
          return;
        }

        if (!this.stopping) {
          this.emit({
            type: 'error',
            error: new Error('Wake-word service websocket reported an error'),
            timestamp: Date.now(),
          });
        }
      };

      websocket.onclose = () => {
        this.websocket = undefined;

        if (!settled) {
          reject(new Error(`Wake-word service closed the connection at ${websocketUrl}`));
          return;
        }

        if (!this.stopping) {
          this.emit({
            type: 'error',
            error: new Error('Wake-word service websocket connection closed unexpectedly'),
            timestamp: Date.now(),
          });
        }
      };
    });
  }

  private async handleMessage(payload: unknown): Promise<void> {
    const message = this.parseMessage(payload);

    if (message?.type !== 'detected' || message.keyword === undefined) {
      return;
    }

    const keyword = message.keyword.trim().toLowerCase();

    if (!this.config.keywords.includes(keyword)) {
      return;
    }

    this.emit({
      type: 'detected',
      keyword,
      timestamp: message.timestamp ?? Date.now(),
    });
  }

  private parseMessage(payload: unknown): DetectionMessage | undefined {
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

  private async assertServiceReachable(): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetch(this.toStatusUrl(), {
        method: 'POST',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Wake-word service returned HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private toStatusUrl(): string {
    return new URL('/status', this.config.baseUrl).toString();
  }

  private toWebSocketUrl(): string {
    const url = new URL('/ws', this.config.baseUrl);

    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

    return url.toString();
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

  private isRecord(value: unknown): value is DetectionMessage {
    return typeof value === 'object' && value !== null;
  }
}
