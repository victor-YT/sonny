import type { LlmMessage, LlmProvider } from '../core/providers/llm.js';

import {
  MEMORY_DOCUMENT_NAMES,
  type MemoryDocumentName,
  type MemoryEntry,
  type MemoryStore,
} from './memory-store.js';

const DEFAULT_MAX_TRANSCRIPT_MESSAGES = 40;
const DEFAULT_MAX_ITEMS_PER_CATEGORY = 5;

export interface MemoryExtraction {
  facts: string[];
  preferences: string[];
  goals: string[];
  patterns: string[];
}

export interface MemoryExtractorConfig {
  llmProvider: LlmProvider;
  memoryStore: MemoryStore;
  model?: string;
  maxTranscriptMessages?: number;
  maxItemsPerCategory?: number;
}

export class MemoryExtractor {
  private readonly llmProvider: LlmProvider;
  private readonly memoryStore: MemoryStore;
  private readonly model?: string;
  private readonly maxTranscriptMessages: number;
  private readonly maxItemsPerCategory: number;

  public constructor(config: MemoryExtractorConfig) {
    this.llmProvider = config.llmProvider;
    this.memoryStore = config.memoryStore;
    this.model = config.model;
    this.maxTranscriptMessages =
      config.maxTranscriptMessages ?? DEFAULT_MAX_TRANSCRIPT_MESSAGES;
    this.maxItemsPerCategory =
      config.maxItemsPerCategory ?? DEFAULT_MAX_ITEMS_PER_CATEGORY;
  }

  public async summarizeConversation(
    messages: LlmMessage[],
  ): Promise<MemoryExtraction> {
    const transcript = this.toTranscript(messages);

    if (transcript.length === 0) {
      return this.createEmptyExtraction();
    }

    const response = await this.llmProvider.generate(
      [
        {
          role: 'system',
          content: this.getSystemPrompt(),
        },
        {
          role: 'user',
          content: transcript,
        },
      ],
      {
        model: this.model,
        temperature: 0,
      },
    );

    return this.parseExtraction(response.content);
  }

  public async summarizeAndStore(
    messages: LlmMessage[],
  ): Promise<MemoryExtraction> {
    const extraction = await this.summarizeConversation(messages);
    const entries = this.toEntries(extraction);

    if (entries.length > 0) {
      await this.memoryStore.appendMany(entries);
    }

    return extraction;
  }

  private getSystemPrompt(): string {
    return [
      'Extract durable user memory from a completed assistant conversation.',
      'Return strict JSON with keys facts, preferences, goals, patterns.',
      'Each value must be an array of short strings.',
      'Only include user-specific details likely to matter in future conversations.',
      'Ignore one-off tasks, transient logistics, or assistant-only observations.',
      `Limit each array to at most ${this.maxItemsPerCategory} items.`,
      'Do not wrap the JSON in markdown fences.',
    ].join(' ');
  }

  private toTranscript(messages: LlmMessage[]): string {
    return messages
      .filter((message) => message.role !== 'system')
      .slice(-this.maxTranscriptMessages)
      .map((message) => `[${message.role}] ${this.toTranscriptContent(message)}`)
      .filter((line) => line.trim().length > 0)
      .join('\n');
  }

  private toTranscriptContent(message: LlmMessage): string {
    if (message.content.trim().length > 0) {
      return message.content.trim();
    }

    if ((message.toolCalls?.length ?? 0) === 0) {
      return '';
    }

    const toolNames = message.toolCalls
      ?.map((toolCall) => toolCall.name)
      .filter((toolName) => toolName.length > 0);

    if (toolNames === undefined || toolNames.length === 0) {
      return '';
    }

    return `Tool calls: ${toolNames.join(', ')}`;
  }

  private parseExtraction(content: string): MemoryExtraction {
    const parsed = this.parseJsonPayload(content);

    if (!this.isRecord(parsed)) {
      throw new Error('Memory extractor response must be a JSON object');
    }

    return {
      facts: this.normalizeEntries(parsed.facts),
      preferences: this.normalizeEntries(parsed.preferences),
      goals: this.normalizeEntries(parsed.goals),
      patterns: this.normalizeEntries(parsed.patterns),
    };
  }

  private parseJsonPayload(content: string): unknown {
    const trimmed = content.trim();

    if (trimmed.length === 0) {
      return this.createEmptyExtraction();
    }

    const normalized = trimmed.startsWith('```')
      ? trimmed.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')
      : trimmed;

    return JSON.parse(normalized);
  }

  private normalizeEntries(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const unique = new Set<string>();

    for (const item of value) {
      if (typeof item !== 'string') {
        continue;
      }

      const normalized = item.trim();

      if (normalized.length === 0) {
        continue;
      }

      unique.add(normalized);

      if (unique.size >= this.maxItemsPerCategory) {
        break;
      }
    }

    return Array.from(unique);
  }

  private toEntries(extraction: MemoryExtraction): MemoryEntry[] {
    const groups: Array<[MemoryDocumentName, string[]]> = [
      ['facts', extraction.facts],
      ['preferences', extraction.preferences],
      ['goals', extraction.goals],
      ['patterns', extraction.patterns],
    ];

    return groups.flatMap(([name, items]) =>
      items.map((content) => ({
        name,
        content,
      })),
    );
  }

  private createEmptyExtraction(): MemoryExtraction {
    return {
      facts: [],
      preferences: [],
      goals: [],
      patterns: [],
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}

export function isMemoryDocumentName(value: string): value is MemoryDocumentName {
  return MEMORY_DOCUMENT_NAMES.includes(value as MemoryDocumentName);
}
