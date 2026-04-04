import type { LlmMessage } from './providers/llm.js';

const DEFAULT_MAX_TOKENS = 12_000;
const DEFAULT_RECENT_TURNS = 8;
const DEFAULT_SUMMARY_TOKEN_BUDGET = 1_200;
const DEFAULT_SUMMARY_MAX_LINES = 12;

export interface ContextManagerEntry extends LlmMessage {
  timestamp: Date;
  tokenCount: number;
}

export interface ContextWindow {
  systemPrompt: string;
  messages: LlmMessage[];
  totalTokens: number;
  summary: string;
  omittedMessageCount: number;
}

export interface ContextManagerConfig {
  maxTokens?: number;
  recentTurns?: number;
  summaryTokenBudget?: number;
  summaryMaxLines?: number;
}

export interface BuildContextWindowOptions {
  systemPrompt: string;
  entries: ContextManagerEntry[];
}

export class ContextManager {
  private readonly maxTokens: number;
  private readonly recentTurns: number;
  private readonly summaryTokenBudget: number;
  private readonly summaryMaxLines: number;

  public constructor(config: ContextManagerConfig = {}) {
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.recentTurns = config.recentTurns ?? DEFAULT_RECENT_TURNS;
    this.summaryTokenBudget =
      config.summaryTokenBudget ?? DEFAULT_SUMMARY_TOKEN_BUDGET;
    this.summaryMaxLines = config.summaryMaxLines ?? DEFAULT_SUMMARY_MAX_LINES;
  }

  public buildContextWindow(
    options: BuildContextWindowOptions,
  ): ContextWindow {
    const baseSystemPrompt = options.systemPrompt.trim();
    const systemPromptTokens = this.estimateTextTokens(baseSystemPrompt);
    const turns = this.groupTurns(options.entries);
    const recentEntries = this.selectRecentEntries(turns);
    const prunedRecentEntries = this.enforceMessageBudget(
      recentEntries,
      this.maxTokens - systemPromptTokens,
    );
    const omittedMessageCount = Math.max(
      0,
      options.entries.length - prunedRecentEntries.length,
    );
    const olderEntries = options.entries.slice(
      0,
      options.entries.length - prunedRecentEntries.length,
    );
    const summaryBudget = Math.max(
      0,
      Math.min(
        this.summaryTokenBudget,
        this.maxTokens -
          systemPromptTokens -
          this.getEntriesTokenCount(prunedRecentEntries),
      ),
    );
    const summary = this.summarizeEntries(olderEntries, summaryBudget);
    const systemPrompt = this.composeSystemPrompt(baseSystemPrompt, summary);
    const totalTokens =
      this.estimateTextTokens(systemPrompt) +
      this.getEntriesTokenCount(prunedRecentEntries);

    return {
      systemPrompt,
      messages: prunedRecentEntries.map((entry) => this.toMessage(entry)),
      totalTokens,
      summary,
      omittedMessageCount,
    };
  }

  public estimateMessageTokens(message: LlmMessage): number {
    const toolCallPayload =
      message.toolCalls === undefined ? '' : JSON.stringify(message.toolCalls);

    return this.estimateTextTokens(
      `${message.role}\n${message.content}\n${toolCallPayload}`,
    );
  }

  public estimateTextTokens(text: string): number {
    const normalized = text.trim();

    if (normalized.length === 0) {
      return 0;
    }

    const wordCount = normalized.split(/\s+/u).filter(Boolean).length;
    const characterEstimate = Math.ceil(normalized.length / 4);

    return Math.max(1, wordCount, characterEstimate);
  }

  private groupTurns(entries: ContextManagerEntry[]): ContextManagerEntry[][] {
    const turns: ContextManagerEntry[][] = [];
    let currentTurn: ContextManagerEntry[] = [];

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

    return turns;
  }

  private selectRecentEntries(turns: ContextManagerEntry[][]): ContextManagerEntry[] {
    return turns
      .slice(-this.recentTurns)
      .flatMap((turn) => turn);
  }

  private enforceMessageBudget(
    entries: ContextManagerEntry[],
    budget: number,
  ): ContextManagerEntry[] {
    if (budget <= 0 || entries.length === 0) {
      return entries.slice(-1);
    }

    const selected: ContextManagerEntry[] = [];
    let tokenCount = 0;

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];

      if (entry === undefined) {
        continue;
      }

      if (selected.length > 0 && tokenCount + entry.tokenCount > budget) {
        break;
      }

      selected.unshift(entry);
      tokenCount += entry.tokenCount;
    }

    return selected;
  }

  private summarizeEntries(
    entries: ContextManagerEntry[],
    budget: number,
  ): string {
    if (entries.length === 0 || budget <= 0) {
      return '';
    }

    const header = 'Earlier conversation summary:';
    const lines: string[] = [header];
    let usedTokens = this.estimateTextTokens(header);
    let lineCount = 0;

    for (const entry of entries) {
      if (lineCount >= this.summaryMaxLines) {
        break;
      }

      const summaryLine = this.summarizeEntry(entry);
      const summaryTokens = this.estimateTextTokens(summaryLine);

      if (usedTokens + summaryTokens > budget) {
        break;
      }

      lines.push(summaryLine);
      usedTokens += summaryTokens;
      lineCount += 1;
    }

    return lines.length > 1 ? lines.join('\n') : '';
  }

  private summarizeEntry(entry: ContextManagerEntry): string {
    const content = entry.content.replace(/\s+/gu, ' ').trim();
    const compact = content.length <= 160 ? content : `${content.slice(0, 157)}...`;

    switch (entry.role) {
      case 'user':
        return `- User: ${compact}`;
      case 'assistant':
        return `- Assistant: ${compact}`;
      case 'tool':
        return `- Tool result: ${compact}`;
      case 'system':
      default:
        return `- System context: ${compact}`;
    }
  }

  private composeSystemPrompt(baseSystemPrompt: string, summary: string): string {
    if (summary.length === 0) {
      return baseSystemPrompt;
    }

    if (baseSystemPrompt.length === 0) {
      return summary;
    }

    return `${baseSystemPrompt}\n\n${summary}`;
  }

  private getEntriesTokenCount(entries: ContextManagerEntry[]): number {
    return entries.reduce((total, entry) => total + entry.tokenCount, 0);
  }

  private toMessage(entry: ContextManagerEntry): LlmMessage {
    return {
      role: entry.role,
      content: entry.content,
      toolCallId: entry.toolCallId,
      toolCalls: entry.toolCalls,
    };
  }
}

export function getDefaultContextMaxTokens(): number {
  return DEFAULT_MAX_TOKENS;
}
