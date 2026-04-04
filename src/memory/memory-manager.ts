import type { LlmMessage } from '../core/providers/llm.js';

import { MemoryStore, type MemoryStoreConfig } from './memory-store.js';
import { RecentMemory, type RecentMemoryConfig } from './recent-memory.js';

export interface MemoryManagerConfig {
  memoryStore?: MemoryStore;
  recentMemory?: RecentMemory;
  memoryStoreConfig?: MemoryStoreConfig;
  recentMemoryConfig?: RecentMemoryConfig;
}

export class MemoryManager {
  private readonly memoryStore: MemoryStore;
  private readonly recentMemory: RecentMemory;

  public constructor(config: MemoryManagerConfig = {}) {
    this.memoryStore =
      config.memoryStore ?? new MemoryStore(config.memoryStoreConfig);
    this.recentMemory =
      config.recentMemory ?? new RecentMemory(config.recentMemoryConfig);
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
