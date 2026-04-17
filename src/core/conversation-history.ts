import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { LlmMessage } from './providers/llm.js';
import { DEFAULT_CONVERSATION_HISTORY_PATH } from './paths.js';

const DEFAULT_DATABASE_PATH = DEFAULT_CONVERSATION_HISTORY_PATH;
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

interface ConversationHistoryState {
  nextId: number;
  entries: ConversationHistoryRow[];
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
  private readonly databasePath: string;
  private readonly maxInMemoryMessages: number;
  private readonly tokenEstimator: (message: LlmMessage) => number;
  private readonly clock: () => Date;
  private readonly entriesBySession = new Map<string, ConversationHistoryEntry[]>();
  private state: ConversationHistoryState;

  public constructor(config: ConversationHistoryConfig = {}) {
    this.databasePath = config.databasePath ?? DEFAULT_DATABASE_PATH;

    mkdirSync(dirname(this.databasePath), { recursive: true });

    this.maxInMemoryMessages =
      config.maxInMemoryMessages ?? DEFAULT_MAX_IN_MEMORY_MESSAGES;
    this.tokenEstimator = config.tokenEstimator ?? estimateMessageTokens;
    this.clock = config.clock ?? (() => new Date());
    this.state = this.loadState();
  }

  public addMessage(
    sessionId: string,
    message: LlmMessage,
    timestamp: Date = this.clock(),
  ): ConversationHistoryEntry {
    const normalizedMessage = this.normalizeMessage(message);
    const tokenCount = this.tokenEstimator(normalizedMessage);
    const row: ConversationHistoryRow = {
      id: this.state.nextId,
      sessionId,
      role: normalizedMessage.role,
      content: normalizedMessage.content,
      timestamp: timestamp.toISOString(),
      tokenCount,
      toolCallId: normalizedMessage.toolCallId ?? null,
      toolCallsJson:
        normalizedMessage.toolCalls === undefined
          ? null
          : JSON.stringify(normalizedMessage.toolCalls),
    };
    const entry: ConversationHistoryEntry = this.toEntry(row);
    const sessionEntries = this.getOrLoadSessionEntries(sessionId);

    this.state.nextId += 1;
    this.state.entries.push(row);
    sessionEntries.push(entry);

    if (sessionEntries.length > this.maxInMemoryMessages) {
      sessionEntries.splice(0, sessionEntries.length - this.maxInMemoryMessages);
    }

    this.persist();

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
    return this.state.entries
      .slice()
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, limit)
      .map((row) => ({
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
    return;
  }

  private loadState(): ConversationHistoryState {
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
        `Failed to load conversation history from ${this.databasePath}: ${this.toErrorMessage(error)}`,
      );
    }
  }

  private parseState(value: unknown): ConversationHistoryState {
    if (!this.isRecord(value)) {
      throw new Error('Conversation history file must contain an object');
    }

    const nextId = value.nextId;
    const entries = value.entries;

    if (typeof nextId !== 'number' || !Number.isInteger(nextId) || nextId < 1) {
      throw new Error('Conversation history file nextId must be a positive integer');
    }

    if (!Array.isArray(entries)) {
      throw new Error('Conversation history file entries must be an array');
    }

    return {
      nextId,
      entries: entries.map((entry) => this.toRow(entry)),
    };
  }

  private createEmptyState(): ConversationHistoryState {
    return {
      nextId: 1,
      entries: [],
    };
  }

  private persist(): void {
    this.writeState(this.state);
  }

  private writeState(state: ConversationHistoryState): void {
    writeFileSync(
      this.databasePath,
      `${JSON.stringify(state, null, 2)}\n`,
      'utf8',
    );
  }

  private getOrLoadSessionEntries(sessionId: string): ConversationHistoryEntry[] {
    const cached = this.entriesBySession.get(sessionId);

    if (cached !== undefined) {
      return cached;
    }

    const entries = this.state.entries
      .filter((row) => row.sessionId === sessionId)
      .sort((left, right) => left.id - right.id)
      .map((row) => this.toEntry(row));

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
