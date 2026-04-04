import {
  MemoryStore,
  type MemoryDocument,
  type MemoryDocumentName,
  type MemoryEntry,
  type MemoryStoreConfig,
} from './memory-store.js';

export interface LongTermMemoryRecord {
  category: MemoryDocumentName;
  content: string;
  createdAt?: Date;
}

export class LongTermMemory {
  private readonly store: MemoryStore;

  public constructor(config: MemoryStoreConfig = {}) {
    this.store = new MemoryStore(config);
  }

  public async remember(record: LongTermMemoryRecord): Promise<void> {
    await this.store.append({
      name: record.category,
      content: record.content,
      createdAt: record.createdAt,
    });
  }

  public async rememberMany(records: LongTermMemoryRecord[]): Promise<void> {
    const entries: MemoryEntry[] = records.map((record) => ({
      name: record.category,
      content: record.content,
      createdAt: record.createdAt,
    }));

    await this.store.appendMany(entries);
  }

  public async read(category: MemoryDocumentName): Promise<MemoryDocument> {
    return this.store.readDocument(category);
  }

  public async readAll(): Promise<MemoryDocument[]> {
    return this.store.readAllDocuments();
  }
}

export {
  MemoryStore,
  type MemoryDocument,
  type MemoryDocumentName,
  type MemoryStoreConfig,
};
