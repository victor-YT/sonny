import { randomUUID } from 'node:crypto';

import {
  ConversationHistory,
  type ConversationHistoryEntry,
} from './conversation-history.js';
import type { LlmMessage } from './providers/llm.js';

const DEFAULT_MAX_HISTORY_LENGTH = 50;

export interface SessionConfig {
  maxHistoryLength?: number;
  systemPrompt?: string;
  conversationHistory?: ConversationHistory;
}

export class Session {
  public readonly id: string;
  private systemPrompt: string;
  private readonly conversationHistory: ConversationHistory;

  public constructor(config: SessionConfig = {}) {
    this.id = randomUUID();
    this.systemPrompt = config.systemPrompt ?? '';
    this.conversationHistory =
      config.conversationHistory ??
      new ConversationHistory({
        maxInMemoryMessages: config.maxHistoryLength ?? DEFAULT_MAX_HISTORY_LENGTH,
      });
  }

  public addMessage(message: LlmMessage): void {
    this.conversationHistory.addMessage(this.id, message);
  }

  public getMessages(): LlmMessage[] {
    const messages = this.getHistory();

    if (this.systemPrompt.length === 0) {
      return messages;
    }

    return [
      {
        role: 'system',
        content: this.systemPrompt,
      },
      ...messages,
    ];
  }

  public getHistory(): LlmMessage[] {
    return this.conversationHistory.getSessionMessages(this.id);
  }

  public getEntries(): ConversationHistoryEntry[] {
    return this.conversationHistory.getSessionEntries(this.id);
  }

  public getLastTurns(turnCount: number): ConversationHistoryEntry[] {
    return this.conversationHistory.getLastTurns(this.id, turnCount);
  }

  public setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  public getSystemPrompt(): string {
    return this.systemPrompt;
  }

  public clear(): void {
    this.conversationHistory.clearSession(this.id);
  }

  public get messageCount(): number {
    return this.conversationHistory.getSessionEntries(this.id).length;
  }
}
