import {
  RecentMemory,
  type RecentMemoryConfig,
  type RecentMemoryMessage,
  type RecentMemoryQuery,
  type RecentMemoryRecord,
} from './recent-memory.js';

export class ShortTermMemory {
  private readonly recentMemory: RecentMemory;

  public constructor(config: RecentMemoryConfig = {}) {
    this.recentMemory = new RecentMemory(config);
  }

  public remember(record: RecentMemoryRecord): void {
    this.recentMemory.addMessage(record);
  }

  public recall(query: RecentMemoryQuery = {}): RecentMemoryMessage[] {
    return this.recentMemory.listMessages(query);
  }

  public close(): void {
    this.recentMemory.close();
  }
}

export {
  RecentMemory,
  type RecentMemoryConfig,
  type RecentMemoryMessage,
  type RecentMemoryQuery,
  type RecentMemoryRecord,
};
