import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

import type { LlmMessage } from '../core/providers/llm.js';

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_DATABASE_PATH = join(
  process.cwd(),
  'data',
  'memory',
  'recent-memory.sqlite',
);
const DEFAULT_QUERY_LIMIT = 50;

interface RecentMemoryRow {
  id: number;
  sessionId: string;
  role: LlmMessage['role'];
  content: string;
  createdAt: string;
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
  private readonly database: BetterSqlite3.Database;
  private readonly retentionDays: number;
  private readonly clock: () => Date;

  public constructor(config: RecentMemoryConfig = {}) {
    const databasePath = config.databasePath ?? DEFAULT_DATABASE_PATH;

    mkdirSync(dirname(databasePath), { recursive: true });

    this.database = new BetterSqlite3(databasePath);
    this.retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.clock = config.clock ?? (() => new Date());

    this.initialize();
  }

  public addMessage(record: RecentMemoryRecord): void {
    const content = record.content.trim();

    if (content.length === 0) {
      return;
    }

    this.pruneExpired(record.createdAt ?? this.clock());
    this.database
      .prepare(
        `
          INSERT INTO recent_memory (session_id, role, content, created_at)
          VALUES (?, ?, ?, ?)
        `,
      )
      .run(
        record.sessionId,
        record.role,
        content,
        this.toIsoString(record.createdAt ?? this.clock()),
      );
  }

  public listMessages(query: RecentMemoryQuery = {}): RecentMemoryMessage[] {
    const now = query.now ?? this.clock();
    const limit = query.limit ?? DEFAULT_QUERY_LIMIT;

    this.pruneExpired(now);

    if (query.sessionId !== undefined) {
      const rows = this.database
        .prepare(
          `
            SELECT
              id,
              session_id AS sessionId,
              role,
              content,
              created_at AS createdAt
            FROM recent_memory
            WHERE created_at >= ? AND session_id = ?
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(
          this.getCutoffIsoString(now),
          query.sessionId,
          limit,
        );

      return this.toRows(rows).map((row) => this.toMessage(row));
    }

    const rows = this.database
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            role,
            content,
            created_at AS createdAt
          FROM recent_memory
          WHERE created_at >= ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(this.getCutoffIsoString(now), limit);

    return this.toRows(rows).map((row) => this.toMessage(row));
  }

  public pruneExpired(now: Date = this.clock()): number {
    const result = this.database
      .prepare('DELETE FROM recent_memory WHERE created_at < ?')
      .run(this.getCutoffIsoString(now));

    return Number(result.changes);
  }

  public close(): void {
    this.database.close();
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS recent_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS recent_memory_created_at_idx
      ON recent_memory (created_at DESC);

      CREATE INDEX IF NOT EXISTS recent_memory_session_id_idx
      ON recent_memory (session_id, created_at DESC);
    `);

    this.pruneExpired();
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

  private toRows(rows: unknown): RecentMemoryRow[] {
    if (!Array.isArray(rows)) {
      throw new Error('Recent memory query returned an invalid payload');
    }

    return rows.map((row) => this.toRow(row));
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
}

export function getDefaultRecentMemoryDatabasePath(): string {
  return DEFAULT_DATABASE_PATH;
}
