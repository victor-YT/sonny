import type { LlmProvider } from '../core/providers/llm.js';
import type { LlmMessage } from '../core/providers/llm.js';

import { MemoryStore, type MemoryStoreConfig } from './memory-store.js';
import {
  MemoryExtractor,
  type MemoryExtraction,
  type MemoryExtractorConfig,
} from './memory-extractor.js';
import {
  MemoryInjector,
  type MemoryInjectorConfig,
} from './memory-injector.js';
import { RecentMemory, type RecentMemoryConfig } from './recent-memory.js';

export interface MemoryManagerConfig {
  llmProvider?: LlmProvider;
  memoryStore?: MemoryStore;
  recentMemory?: RecentMemory;
  memoryExtractor?: MemoryExtractor;
  memoryInjector?: MemoryInjector;
  memoryStoreConfig?: MemoryStoreConfig;
  recentMemoryConfig?: RecentMemoryConfig;
  memoryExtractorConfig?: Omit<MemoryExtractorConfig, 'llmProvider' | 'memoryStore'>;
  memoryInjectorConfig?: Omit<MemoryInjectorConfig, 'memoryStore' | 'recentMemory'>;
}

export class MemoryManager {
  private readonly memoryStore: MemoryStore;
  private readonly recentMemory: RecentMemory;
  private readonly memoryExtractor?: MemoryExtractor;
  private readonly memoryInjector: MemoryInjector;

  public constructor(config: MemoryManagerConfig = {}) {
    this.memoryStore =
      config.memoryStore ?? new MemoryStore(config.memoryStoreConfig);
    this.recentMemory =
      config.recentMemory ?? new RecentMemory(config.recentMemoryConfig);
    this.memoryExtractor =
      config.memoryExtractor ??
      (config.llmProvider === undefined
        ? undefined
        : new MemoryExtractor({
            llmProvider: config.llmProvider,
            memoryStore: this.memoryStore,
            ...config.memoryExtractorConfig,
          }));
    this.memoryInjector =
      config.memoryInjector ??
      new MemoryInjector({
        memoryStore: this.memoryStore,
        recentMemory: this.recentMemory,
        ...config.memoryInjectorConfig,
      });
  }

  public get store(): MemoryStore {
    return this.memoryStore;
  }

  public get recent(): RecentMemory {
    return this.recentMemory;
  }

  public async recordMessage(
    sessionId: string,
    message: LlmMessage,
  ): Promise<void> {
    const content = this.toStoredContent(message);

    if (content.length === 0) {
      return;
    }

    this.recentMemory.addMessage({
      sessionId,
      role: message.role,
      content,
    });
  }

  public async finalizeSession(
    messages: LlmMessage[],
  ): Promise<MemoryExtraction | null> {
    if (this.memoryExtractor === undefined) {
      return null;
    }

    return this.memoryExtractor.summarizeAndStore(messages);
  }

  public async buildSystemPrompt(
    baseSystemPrompt: string,
    userMessage: string,
  ): Promise<string> {
    return this.memoryInjector.composeSystemPrompt(baseSystemPrompt, userMessage);
  }

  public close(): void {
    this.recentMemory.close();
  }

  private toStoredContent(message: LlmMessage): string {
    const trimmedContent = message.content.trim();

    if ((message.toolCalls?.length ?? 0) === 0) {
      return trimmedContent;
    }

    const toolNames = message.toolCalls
      ?.map((toolCall) => toolCall.name)
      .filter((toolName) => toolName.length > 0);

    if (toolNames === undefined || toolNames.length === 0) {
      return trimmedContent;
    }

    if (trimmedContent.length === 0) {
      return `Tool calls: ${toolNames.join(', ')}`;
    }

    return `${trimmedContent}\nTool calls: ${toolNames.join(', ')}`;
  }
}
