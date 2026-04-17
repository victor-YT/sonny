import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export type SonnyRuntimeState =
  | 'idle'
  | 'wake_detected'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'error';

export type RuntimeServiceName =
  | 'ollama'
  | 'stt'
  | 'tts'
  | 'wake_word'
  | 'vad';

export type RuntimeLogLevel = 'info' | 'warn' | 'error';

export interface RuntimeServiceHealth {
  name: RuntimeServiceName;
  label: string;
  url: string | null;
  online: boolean;
  checkedAt: string | null;
  error: string | null;
}

export interface RuntimeLogEntry {
  id: string;
  timestamp: string;
  level: RuntimeLogLevel;
  type: string;
  message: string;
  meta: Record<string, string | number | boolean | null>;
}

export interface RuntimeConversationTurn {
  id: string;
  timestamp: string;
  userTranscript: string | null;
  assistantText: string | null;
  status: 'pending' | 'speaking' | 'completed' | 'interrupted' | 'error';
}

export interface RuntimeStateSnapshot {
  currentState: SonnyRuntimeState;
  updatedAt: string;
  lastError: string | null;
  lastTranscript: string | null;
  lastResponseText: string | null;
  currentSessionId: string | null;
  micActive: boolean;
  playbackActive: boolean;
  services: Record<RuntimeServiceName, RuntimeServiceHealth>;
}

export type RuntimeStateEvent =
  | {
      type: 'snapshot';
      snapshot: RuntimeStateSnapshot;
    }
  | {
      type: 'log';
      entry: RuntimeLogEntry;
    }
  | {
      type: 'conversation';
      turn: RuntimeConversationTurn;
    };

export interface RuntimeStateStoreConfig {
  currentSessionId?: string | null;
  services?: Partial<Record<RuntimeServiceName, { label?: string; url?: string | null }>>;
  logLimit?: number;
  conversationLimit?: number;
  clock?: () => Date;
}

const DEFAULT_LOG_LIMIT = 250;
const DEFAULT_CONVERSATION_LIMIT = 50;
const SERVICE_LABELS: Record<RuntimeServiceName, string> = {
  ollama: 'Ollama',
  stt: 'Whisper STT',
  tts: 'Qwen3-TTS',
  wake_word: 'Wake Word',
  vad: 'VAD',
};

export class RuntimeStateStore {
  private readonly emitter = new EventEmitter();
  private readonly logLimit: number;
  private readonly conversationLimit: number;
  private readonly clock: () => Date;
  private readonly logs: RuntimeLogEntry[] = [];
  private readonly conversation: RuntimeConversationTurn[] = [];

  private snapshot: RuntimeStateSnapshot;

  public constructor(config: RuntimeStateStoreConfig = {}) {
    this.logLimit = config.logLimit ?? DEFAULT_LOG_LIMIT;
    this.conversationLimit = config.conversationLimit ?? DEFAULT_CONVERSATION_LIMIT;
    this.clock = config.clock ?? (() => new Date());
    this.snapshot = {
      currentState: 'idle',
      updatedAt: this.nowIso(),
      lastError: null,
      lastTranscript: null,
      lastResponseText: null,
      currentSessionId: config.currentSessionId ?? null,
      micActive: false,
      playbackActive: false,
      services: {
        ollama: this.createService('ollama', config),
        stt: this.createService('stt', config),
        tts: this.createService('tts', config),
        wake_word: this.createService('wake_word', config),
        vad: this.createService('vad', config),
      },
    };
  }

  public getSnapshot(): RuntimeStateSnapshot {
    return {
      ...this.snapshot,
      services: cloneServices(this.snapshot.services),
    };
  }

  public listLogs(limit = this.logLimit): RuntimeLogEntry[] {
    return this.logs.slice(-limit);
  }

  public listConversation(limit = this.conversationLimit): RuntimeConversationTurn[] {
    return this.conversation.slice(-limit);
  }

  public subscribe(listener: (event: RuntimeStateEvent) => void): () => void {
    this.emitter.on('event', listener);

    return () => {
      this.emitter.off('event', listener);
    };
  }

  public setCurrentSessionId(sessionId: string | null): void {
    this.patchSnapshot({
      currentSessionId: sessionId,
    });
  }

  public transition(
    nextState: SonnyRuntimeState,
    details?: {
      message?: string;
      level?: RuntimeLogLevel;
      error?: string | null;
      meta?: Record<string, string | number | boolean | null>;
    },
  ): void {
    const changed = this.snapshot.currentState !== nextState;
    const lastError = details?.error ?? (nextState === 'error' ? this.snapshot.lastError : null);

    this.patchSnapshot({
      currentState: nextState,
      lastError,
    });

    if (changed) {
      this.addLog({
        level: details?.level ?? (nextState === 'error' ? 'error' : 'info'),
        type: 'state_changed',
        message: details?.message ?? `Runtime state changed to ${nextState}.`,
        meta: {
          state: nextState,
          ...details?.meta,
        },
      });
    }
  }

  public setMicActive(active: boolean): void {
    if (this.snapshot.micActive === active) {
      return;
    }

    this.patchSnapshot({
      micActive: active,
    });
  }

  public setPlaybackActive(active: boolean): void {
    if (this.snapshot.playbackActive === active) {
      return;
    }

    this.patchSnapshot({
      playbackActive: active,
    });
  }

  public setLastTranscript(transcript: string): RuntimeConversationTurn {
    const normalized = transcript.trim();
    const turn: RuntimeConversationTurn = {
      id: randomUUID(),
      timestamp: this.nowIso(),
      userTranscript: normalized,
      assistantText: null,
      status: 'pending',
    };

    this.conversation.push(turn);
    this.trimConversation();
    this.patchSnapshot({
      lastTranscript: normalized,
      lastError: null,
    });
    this.emit({
      type: 'conversation',
      turn: { ...turn },
    });

    return turn;
  }

  public setLastResponseText(text: string): RuntimeConversationTurn {
    const normalized = text.trim();
    const current = this.findLastPendingTurn();
    const turn = current ?? {
      id: randomUUID(),
      timestamp: this.nowIso(),
      userTranscript: null,
      assistantText: null,
      status: 'pending' as const,
    };

    turn.assistantText = normalized;
    turn.status = this.snapshot.playbackActive ? 'speaking' : 'completed';

    if (current === undefined) {
      this.conversation.push(turn);
      this.trimConversation();
    }

    this.patchSnapshot({
      lastResponseText: normalized,
      lastError: null,
    });
    this.emit({
      type: 'conversation',
      turn: { ...turn },
    });

    return turn;
  }

  public markConversationSpeaking(): void {
    const turn = this.findLastAssistantTurn();

    if (turn === undefined) {
      return;
    }

    turn.status = 'speaking';
    this.emit({
      type: 'conversation',
      turn: { ...turn },
    });
  }

  public markConversationCompleted(): void {
    const turn = this.findLastAssistantTurn();

    if (turn === undefined) {
      return;
    }

    turn.status = 'completed';
    this.emit({
      type: 'conversation',
      turn: { ...turn },
    });
  }

  public markConversationInterrupted(): void {
    const turn = this.findLastAssistantTurn() ?? this.findLastPendingTurn();

    if (turn === undefined) {
      return;
    }

    turn.status = 'interrupted';
    this.emit({
      type: 'conversation',
      turn: { ...turn },
    });
  }

  public markConversationErrored(): void {
    const turn = this.findLastAssistantTurn() ?? this.findLastPendingTurn();

    if (turn === undefined) {
      return;
    }

    turn.status = 'error';
    this.emit({
      type: 'conversation',
      turn: { ...turn },
    });
  }

  public setServiceHealth(
    name: RuntimeServiceName,
    update: {
      url?: string | null;
      online: boolean;
      checkedAt?: string;
      error?: string | null;
    },
  ): void {
    const current = this.snapshot.services[name];

    this.snapshot = {
      ...this.snapshot,
      updatedAt: this.nowIso(),
      services: {
        ...this.snapshot.services,
        [name]: {
          ...current,
          url: update.url ?? current.url,
          online: update.online,
          checkedAt: update.checkedAt ?? this.nowIso(),
          error: update.error ?? null,
        },
      },
    };

    this.emit({
      type: 'snapshot',
      snapshot: this.getSnapshot(),
    });
  }

  public addLog(input: {
    level: RuntimeLogLevel;
    type: string;
    message: string;
    meta?: Record<string, string | number | boolean | null>;
  }): RuntimeLogEntry {
    const entry: RuntimeLogEntry = {
      id: randomUUID(),
      timestamp: this.nowIso(),
      level: input.level,
      type: input.type,
      message: input.message,
      meta: input.meta ?? {},
    };

    this.logs.push(entry);

    if (this.logs.length > this.logLimit) {
      this.logs.splice(0, this.logs.length - this.logLimit);
    }

    this.emit({
      type: 'log',
      entry,
    });

    return entry;
  }

  public setError(message: string): void {
    const normalized = message.trim();

    this.patchSnapshot({
      lastError: normalized,
    });
    this.markConversationErrored();
    this.addLog({
      level: 'error',
      type: 'runtime_error',
      message: normalized,
      meta: {},
    });
  }

  public clearLogs(): void {
    this.logs.splice(0);
  }

  public resetToIdle(): void {
    this.patchSnapshot({
      currentState: 'idle',
      lastError: null,
      micActive: false,
      playbackActive: false,
    });
  }

  private patchSnapshot(update: Partial<RuntimeStateSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...update,
      updatedAt: this.nowIso(),
      services:
        update.services === undefined
          ? this.snapshot.services
          : cloneServices(update.services),
    };

    this.emit({
      type: 'snapshot',
      snapshot: this.getSnapshot(),
    });
  }

  private createService(
    name: RuntimeServiceName,
    config: RuntimeStateStoreConfig,
  ): RuntimeServiceHealth {
    return {
      name,
      label: config.services?.[name]?.label ?? SERVICE_LABELS[name],
      url: config.services?.[name]?.url ?? null,
      online: false,
      checkedAt: null,
      error: null,
    };
  }

  private findLastPendingTurn(): RuntimeConversationTurn | undefined {
    return [...this.conversation].reverse().find((turn) => turn.assistantText === null);
  }

  private findLastAssistantTurn(): RuntimeConversationTurn | undefined {
    return [...this.conversation].reverse().find((turn) => turn.assistantText !== null);
  }

  private trimConversation(): void {
    if (this.conversation.length > this.conversationLimit) {
      this.conversation.splice(0, this.conversation.length - this.conversationLimit);
    }
  }

  private emit(event: RuntimeStateEvent): void {
    this.emitter.emit('event', event);
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }
}

function cloneServices(
  value: Record<RuntimeServiceName, RuntimeServiceHealth>,
): Record<RuntimeServiceName, RuntimeServiceHealth> {
  return {
    ollama: { ...value.ollama },
    stt: { ...value.stt },
    tts: { ...value.tts },
    wake_word: { ...value.wake_word },
    vad: { ...value.vad },
  };
}
