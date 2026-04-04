import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { LlmMessage } from './providers/llm.js';

const DEFAULT_DATABASE_PATH = join(
  process.cwd(),
  'data',
  'memory',
  'conversation-history.sqlite',
);
const DEFAULT_MAX_IN_MEMORY_MESSAGES = 500;

interface ConversationHistoryRow {
  id: number;
  sessionId: string;
  role: LlmMessage['role'];
  content: string;
  timestamp: string;
  tokenCount: number;
  toolCallId: string | null;
  toolCallsJson: string | null;
}

export interface ConversationHistoryEntry extends LlmMessage {
  id: number;
  sessionId: string;
  timestamp: Date;
  tokenCount: number;
}

export interface ConversationHistoryConfig {
  databasePath?: string;
  maxInMemoryMessages?: number;
  tokenEstimator?: (message: LlmMessage) => number;
  clock?: () => Date;
}

export interface PersistedConversationMessage {
  id: number;
  sessionId: string;
  role: LlmMessage['role'];
  content: string;
  timestamp: Date;
  tokenCount: number;
}

export class ConversationHistory {
  private readonly database: DatabaseSync;
  private readonly maxInMemoryMessages: number;
  private readonly tokenEstimator: (message: LlmMessage) => number;
  private readonly clock: () => Date;
  private readonly entriesBySession = new Map<string, ConversationHistoryEntry[]>();

  public constructor(config: ConversationHistoryConfig = {}) {
    const databasePath = config.databasePath ?? DEFAULT_DATABASE_PATH;

    mkdirSync(dirname(databasePath), { recursive: true });

    this.database = new DatabaseSync(databasePath);
    this.maxInMemoryMessages =
      config.maxInMemoryMessages ?? DEFAULT_MAX_IN_MEMORY_MESSAGES;
    this.tokenEstimator = config.tokenEstimator ?? estimateMessageTokens;
    this.clock = config.clock ?? (() => new Date());

    this.initialize();
  }

  public addMessage(
    sessionId: string,
    message: LlmMessage,
    timestamp: Date = this.clock(),
  ): ConversationHistoryEntry {
    const normalizedMessage = this.normalizeMessage(message);
    const tokenCount = this.tokenEstimator(normalizedMessage);
    const result = this.database
      .prepare(
        `
          INSERT INTO conversation_history (
            session_id,
            role,
            content,
            timestamp,
            token_count,
            tool_call_id,
            tool_calls_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        sessionId,
        normalizedMessage.role,
        normalizedMessage.content,
        timestamp.toISOString(),
        tokenCount,
        normalizedMessage.toolCallId ?? null,
        normalizedMessage.toolCalls === undefined
          ? null
          : JSON.stringify(normalizedMessage.toolCalls),
      );
    const entry: ConversationHistoryEntry = {
      id: Number(result.lastInsertRowid),
      sessionId,
      role: normalizedMessage.role,
      content: normalizedMessage.content,
      timestamp,
      tokenCount,
      toolCallId: normalizedMessage.toolCallId,
      toolCalls: normalizedMessage.toolCalls,
    };
    const sessionEntries = this.getOrLoadSessionEntries(sessionId);

    sessionEntries.push(entry);

    if (sessionEntries.length > this.maxInMemoryMessages) {
      sessionEntries.splice(0, sessionEntries.length - this.maxInMemoryMessages);
    }

    return entry;
  }

  public getSessionEntries(sessionId: string): ConversationHistoryEntry[] {
    return [...this.getOrLoadSessionEntries(sessionId)];
  }

  public getSessionMessages(sessionId: string): LlmMessage[] {
    return this.getSessionEntries(sessionId).map((entry) => this.toMessage(entry));
  }

  public getLastTurns(
    sessionId: string,
    turnCount: number,
  ): ConversationHistoryEntry[] {
    const entries = this.getOrLoadSessionEntries(sessionId);
    const turns: ConversationHistoryEntry[][] = [];
    let currentTurn: ConversationHistoryEntry[] = [];

    for (const entry of entries) {
      if (entry.role === 'user' && currentTurn.length > 0) {
        turns.push(currentTurn);
        currentTurn = [];
      }

      currentTurn.push(entry);
    }

    if (currentTurn.length > 0) {
      turns.push(currentTurn);
    }

    return turns
      .slice(-turnCount)
      .flatMap((turn) => turn)
      .map((entry) => ({ ...entry }));
  }

  public listRecentMessages(limit = 50): PersistedConversationMessage[] {
    const rows = this.database
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            role,
            content,
            timestamp,
            token_count AS tokenCount,
            tool_call_id AS toolCallId,
            tool_calls_json AS toolCallsJson
          FROM conversation_history
          ORDER BY timestamp DESC
          LIMIT ?
        `,
      )
      .all(limit);

    return this.toRows(rows).map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      role: row.role,
      content: row.content,
      timestamp: new Date(row.timestamp),
      tokenCount: row.tokenCount,
    }));
  }

  public clearSession(sessionId: string): void {
    this.entriesBySession.delete(sessionId);
  }

  public close(): void {
    this.database.close();
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        tool_call_id TEXT,
        tool_calls_json TEXT
      );

      CREATE INDEX IF NOT EXISTS conversation_history_session_timestamp_idx
      ON conversation_history (session_id, timestamp DESC);

      CREATE INDEX IF NOT EXISTS conversation_history_timestamp_idx
      ON conversation_history (timestamp DESC);
    `);
  }

  private getOrLoadSessionEntries(sessionId: string): ConversationHistoryEntry[] {
    const cached = this.entriesBySession.get(sessionId);

    if (cached !== undefined) {
      return cached;
    }

    const rows = this.database
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            role,
            content,
            timestamp,
            token_count AS tokenCount,
            tool_call_id AS toolCallId,
            tool_calls_json AS toolCallsJson
          FROM conversation_history
          WHERE session_id = ?
          ORDER BY id ASC
        `,
      )
      .all(sessionId);
    const entries = this.toRows(rows).map((row) => this.toEntry(row));

    this.entriesBySession.set(sessionId, entries);

    return entries;
  }

  private normalizeMessage(message: LlmMessage): LlmMessage {
    return {
      role: message.role,
      content: message.content.trim(),
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls,
    };
  }

  private toEntry(row: ConversationHistoryRow): ConversationHistoryEntry {
    return {
      id: row.id,
      sessionId: row.sessionId,
      role: row.role,
      content: row.content,
      timestamp: new Date(row.timestamp),
      tokenCount: row.tokenCount,
      toolCallId: row.toolCallId ?? undefined,
      toolCalls: this.parseToolCalls(row.toolCallsJson),
    };
  }

  private toMessage(entry: ConversationHistoryEntry): LlmMessage {
    return {
      role: entry.role,
      content: entry.content,
      toolCallId: entry.toolCallId,
      toolCalls: entry.toolCalls,
    };
  }

  private parseToolCalls(value: string | null): LlmMessage['toolCalls'] {
    if (value === null) {
      return undefined;
    }

    const parsed: unknown = JSON.parse(value);

    return Array.isArray(parsed) ? parsed as LlmMessage['toolCalls'] : undefined;
  }

  private toRows(rows: unknown): ConversationHistoryRow[] {
    if (!Array.isArray(rows)) {
      throw new Error('Conversation history query returned an invalid payload');
    }

    return rows.map((row) => this.toRow(row));
  }

  private toRow(value: unknown): ConversationHistoryRow {
    if (!this.isRecord(value)) {
      throw new Error('Conversation history row must be an object');
    }

    const {
      id,
      sessionId,
      role,
      content,
      timestamp,
      tokenCount,
      toolCallId,
      toolCallsJson,
    } = value;

    if (typeof id !== 'number') {
      throw new Error('Conversation history row id must be a number');
    }

    if (typeof sessionId !== 'string') {
      throw new Error('Conversation history row sessionId must be a string');
    }

    if (!isMessageRole(role)) {
      throw new Error('Conversation history row role is invalid');
    }

    if (typeof content !== 'string') {
      throw new Error('Conversation history row content must be a string');
    }

    if (typeof timestamp !== 'string') {
      throw new Error('Conversation history row timestamp must be a string');
    }

    if (typeof tokenCount !== 'number') {
      throw new Error('Conversation history row tokenCount must be a number');
    }

    if (toolCallId !== null && toolCallId !== undefined && typeof toolCallId !== 'string') {
      throw new Error('Conversation history row toolCallId must be a string');
    }

    if (
      toolCallsJson !== null &&
      toolCallsJson !== undefined &&
      typeof toolCallsJson !== 'string'
    ) {
      throw new Error('Conversation history row toolCallsJson must be a string');
    }

    return {
      id,
      sessionId,
      role,
      content,
      timestamp,
      tokenCount,
      toolCallId: toolCallId ?? null,
      toolCallsJson: toolCallsJson ?? null,
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}

function isMessageRole(value: unknown): value is LlmMessage['role'] {
  return (
    value === 'system' ||
    value === 'user' ||
    value === 'assistant' ||
    value === 'tool'
  );
}

function estimateMessageTokens(message: LlmMessage): number {
  const toolCallPayload =
    message.toolCalls === undefined ? '' : JSON.stringify(message.toolCalls);
  const text = `${message.role}\n${message.content}\n${toolCallPayload}`.trim();

  if (text.length === 0) {
    return 0;
  }

  const wordCount = text.split(/\s+/u).filter(Boolean).length;
  const characterEstimate = Math.ceil(text.length / 4);

  return Math.max(1, wordCount, characterEstimate);
}

export function getDefaultConversationHistoryDatabasePath(): string {
  return DEFAULT_DATABASE_PATH;
}
