import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { LlmMessage } from '../core/providers/llm.js';

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_DATABASE_PATH = join(
  process.cwd(),
  'data',
  'memory',
  'recent.json',
);
const DEFAULT_QUERY_LIMIT = 50;

interface RecentMemoryRow {
  id: number;
  sessionId: string;
  role: LlmMessage['role'];
  content: string;
  createdAt: string;
}

interface RecentMemoryState {
  nextId: number;
  messages: RecentMemoryRow[];
}

export interface RecentMemoryRecord {
  sessionId: string;
  role: LlmMessage['role'];
  content: string;
  createdAt?: Date;
}

export interface RecentMemoryQuery {
  sessionId?: string;
  limit?: number;
  now?: Date;
}

export interface RecentMemoryConfig {
  databasePath?: string;
  retentionDays?: number;
  clock?: () => Date;
}

export interface RecentMemoryMessage {
  id: number;
  sessionId: string;
  role: LlmMessage['role'];
  content: string;
  createdAt: Date;
}

export class RecentMemory {
  private readonly databasePath: string;
  private readonly retentionDays: number;
  private readonly clock: () => Date;
  private state: RecentMemoryState;

  public constructor(config: RecentMemoryConfig = {}) {
    this.databasePath = config.databasePath ?? DEFAULT_DATABASE_PATH;

    mkdirSync(dirname(this.databasePath), { recursive: true });

    this.retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.clock = config.clock ?? (() => new Date());
    this.state = this.loadState();

    this.pruneExpired();
  }

  public addMessage(record: RecentMemoryRecord): void {
    const content = record.content.trim();

    if (content.length === 0) {
      return;
    }

    const createdAt = record.createdAt ?? this.clock();

    this.pruneExpired(createdAt);

    const row: RecentMemoryRow = {
      id: this.state.nextId,
      sessionId: record.sessionId,
      role: record.role,
      content,
      createdAt: this.toIsoString(createdAt),
    };

    this.state.nextId += 1;
    this.state.messages.push(row);
    this.persist();
  }

  public listMessages(query: RecentMemoryQuery = {}): RecentMemoryMessage[] {
    const now = query.now ?? this.clock();
    const limit = query.limit ?? DEFAULT_QUERY_LIMIT;

    this.pruneExpired(now);

    const filteredMessages = this.state.messages.filter((message) => {
      if (message.createdAt < this.getCutoffIsoString(now)) {
        return false;
      }

      if (query.sessionId !== undefined && message.sessionId !== query.sessionId) {
        return false;
      }

      return true;
    });

    return filteredMessages
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((row) => this.toMessage(row));
  }

  public pruneExpired(now: Date = this.clock()): number {
    const cutoff = this.getCutoffIsoString(now);
    const previousCount = this.state.messages.length;

    this.state.messages = this.state.messages.filter((message) => message.createdAt >= cutoff);

    const deletedCount = previousCount - this.state.messages.length;

    if (deletedCount > 0) {
      this.persist();
    }

    return deletedCount;
  }

  public close(): void {
    return;
  }

  private loadState(): RecentMemoryState {
    try {
      const rawValue = readFileSync(this.databasePath, 'utf8');
      const parsed = JSON.parse(rawValue) as unknown;

      return this.parseState(parsed);
    } catch (error: unknown) {
      if (this.isFileMissing(error)) {
        const emptyState = this.createEmptyState();

        this.writeState(emptyState);
        return emptyState;
      }

      throw new Error(
        `Failed to load recent memory from ${this.databasePath}: ${this.toErrorMessage(error)}`,
      );
    }
  }

  private parseState(value: unknown): RecentMemoryState {
    if (!this.isRecord(value)) {
      throw new Error('Recent memory file must contain an object');
    }

    const nextId = value.nextId;
    const messages = value.messages;

    if (typeof nextId !== 'number' || !Number.isInteger(nextId) || nextId < 1) {
      throw new Error('Recent memory file nextId must be a positive integer');
    }

    if (!Array.isArray(messages)) {
      throw new Error('Recent memory file messages must be an array');
    }

    return {
      nextId,
      messages: messages.map((row) => this.toRow(row)),
    };
  }

  private createEmptyState(): RecentMemoryState {
    return {
      nextId: 1,
      messages: [],
    };
  }

  private persist(): void {
    this.writeState(this.state);
  }

  private writeState(state: RecentMemoryState): void {
    writeFileSync(
      this.databasePath,
      `${JSON.stringify(state, null, 2)}\n`,
      'utf8',
    );
  }

  private getCutoffIsoString(now: Date): string {
    const cutoff = new Date(
      now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000,
    );

    return this.toIsoString(cutoff);
  }

  private toIsoString(value: Date): string {
    return value.toISOString();
  }

  private toMessage(row: RecentMemoryRow): RecentMemoryMessage {
    return {
      id: row.id,
      sessionId: row.sessionId,
      role: row.role,
      content: row.content,
      createdAt: new Date(row.createdAt),
    };
  }

  private toRow(value: unknown): RecentMemoryRow {
    if (!this.isRecord(value)) {
      throw new Error('Recent memory row must be an object');
    }

    const { id, sessionId, role, content, createdAt } = value;

    if (typeof id !== 'number') {
      throw new Error('Recent memory row id must be a number');
    }

    if (typeof sessionId !== 'string') {
      throw new Error('Recent memory row sessionId must be a string');
    }

    if (!this.isMessageRole(role)) {
      throw new Error('Recent memory row role is invalid');
    }

    if (typeof content !== 'string') {
      throw new Error('Recent memory row content must be a string');
    }

    if (typeof createdAt !== 'string') {
      throw new Error('Recent memory row createdAt must be a string');
    }

    return {
      id,
      sessionId,
      role,
      content,
      createdAt,
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private isMessageRole(value: unknown): value is LlmMessage['role'] {
    return (
      value === 'system' ||
      value === 'user' ||
      value === 'assistant' ||
      value === 'tool'
    );
  }

  private isFileMissing(error: unknown): boolean {
    return (
      this.isRecord(error) &&
      typeof error.code === 'string' &&
      error.code === 'ENOENT'
    );
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown error';
  }
}

export function getDefaultRecentMemoryDatabasePath(): string {
  return DEFAULT_DATABASE_PATH;
}
