import { randomUUID } from 'node:crypto';

import type { LlmMessage } from './providers/llm.js';

const DEFAULT_MAX_HISTORY_LENGTH = 50;

export interface SessionConfig {
  maxHistoryLength?: number;
  systemPrompt?: string;
}

export class Session {
  public readonly id: string;
  private history: LlmMessage[];
  private systemPrompt: string;
  private readonly maxHistoryLength: number;

  public constructor(config: SessionConfig = {}) {
    this.id = randomUUID();
    this.history = [];
    this.systemPrompt = config.systemPrompt ?? '';
    this.maxHistoryLength = config.maxHistoryLength ?? DEFAULT_MAX_HISTORY_LENGTH;
  }

  public addMessage(message: LlmMessage): void {
    this.history.push(message);

    if (this.history.length > this.maxHistoryLength) {
      this.history = this.history.slice(-this.maxHistoryLength);
    }
  }

  public getMessages(): LlmMessage[] {
    const messages = [...this.history];

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
    return [...this.history];
  }

  public setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  public getSystemPrompt(): string {
    return this.systemPrompt;
  }

  public clear(): void {
    this.history = [];
  }

  public get messageCount(): number {
    return this.history.length;
  }
}
