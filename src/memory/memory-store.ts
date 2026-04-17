import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { DEFAULT_MEMORY_DIRECTORY } from '../core/paths.js';

export const MEMORY_DOCUMENT_NAMES = [
  'facts',
  'preferences',
  'goals',
  'patterns',
] as const;

export type MemoryDocumentName = (typeof MEMORY_DOCUMENT_NAMES)[number];

export interface MemoryDocument {
  name: MemoryDocumentName;
  path: string;
  content: string;
}

export interface MemoryEntry {
  name: MemoryDocumentName;
  content: string;
  createdAt?: Date;
}

export interface MemoryStoreConfig {
  directoryPath?: string;
  clock?: () => Date;
}

export class MemoryStore {
  private readonly directoryPath: string;
  private readonly clock: () => Date;

  public constructor(config: MemoryStoreConfig = {}) {
    this.directoryPath = config.directoryPath ?? DEFAULT_MEMORY_DIRECTORY;
    this.clock = config.clock ?? (() => new Date());

    this.ensureStorage();
  }

  public get directory(): string {
    return this.directoryPath;
  }

  public async readDocument(name: MemoryDocumentName): Promise<MemoryDocument> {
    const path = this.getDocumentPath(name);
    const content = await readFile(path, 'utf8');

    return {
      name,
      path,
      content,
    };
  }

  public async readAllDocuments(): Promise<MemoryDocument[]> {
    return Promise.all(
      MEMORY_DOCUMENT_NAMES.map(async (name) => this.readDocument(name)),
    );
  }

  public async append(entry: MemoryEntry): Promise<void> {
    const document = await this.readDocument(entry.name);
    const block = this.toMarkdownBlock(entry.content, entry.createdAt ?? this.clock());
    const nextContent = this.appendBlock(document.content, block);

    await writeFile(document.path, nextContent, 'utf8');
  }

  public async appendMany(entries: MemoryEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.append(entry);
    }
  }

  private ensureStorage(): void {
    mkdirSync(this.directoryPath, { recursive: true });

    for (const name of MEMORY_DOCUMENT_NAMES) {
      const path = this.getDocumentPath(name);

      if (existsSync(path)) {
        continue;
      }

      writeFileSync(path, this.createInitialDocument(name), 'utf8');
    }
  }

  private getDocumentPath(name: MemoryDocumentName): string {
    return join(this.directoryPath, `${name}.md`);
  }

  private createInitialDocument(name: MemoryDocumentName): string {
    const title = name.charAt(0).toUpperCase() + name.slice(1);

    return `# ${title}\n\n`;
  }

  private appendBlock(documentContent: string, block: string): string {
    const normalized = documentContent.endsWith('\n')
      ? documentContent
      : `${documentContent}\n`;

    return `${normalized}${block}`;
  }

  private toMarkdownBlock(content: string, createdAt: Date): string {
    const normalized = content
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (normalized.length === 0) {
      throw new Error('Memory entries must contain text');
    }

    const [firstLine, ...remainingLines] = normalized;
    const lines = [`- ${createdAt.toISOString()}: ${firstLine}`];

    for (const line of remainingLines) {
      lines.push(`  ${line}`);
    }

    return `${lines.join('\n')}\n`;
  }
}

export function getDefaultMemoryDirectory(): string {
  return DEFAULT_MEMORY_DIRECTORY;
}

export function ensureMemoryParentDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

export function readMemoryFileSync(path: string): string {
  return readFileSync(path, 'utf8');
}
