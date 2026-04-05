import type { MemoryDocumentName, MemoryStore } from './memory-store.js';
import type { RecentMemory, RecentMemoryMessage } from './recent-memory.js';

const DEFAULT_MAX_LONG_TERM_MATCHES = 6;
const DEFAULT_MAX_RECENT_MATCHES = 6;
const DEFAULT_MAX_INJECTED_ENTRIES = 5;

interface MemorySnippet {
  category: MemoryDocumentName;
  content: string;
}

interface ScoredValue<T> {
  item: T;
  score: number;
}

interface ContextMatch<T> extends ScoredValue<T> {
  kind: 'long-term' | 'recent';
  index: number;
}

export interface MemoryInjectorConfig {
  memoryStore: MemoryStore;
  recentMemory: RecentMemory;
  maxLongTermMatches?: number;
  maxRecentMatches?: number;
  maxInjectedEntries?: number;
}

export class MemoryInjector {
  private readonly memoryStore: MemoryStore;
  private readonly recentMemory: RecentMemory;
  private readonly maxLongTermMatches: number;
  private readonly maxRecentMatches: number;
  private readonly maxInjectedEntries: number;

  public constructor(config: MemoryInjectorConfig) {
    this.memoryStore = config.memoryStore;
    this.recentMemory = config.recentMemory;
    this.maxLongTermMatches =
      config.maxLongTermMatches ?? DEFAULT_MAX_LONG_TERM_MATCHES;
    this.maxRecentMatches = config.maxRecentMatches ?? DEFAULT_MAX_RECENT_MATCHES;
    this.maxInjectedEntries =
      config.maxInjectedEntries ?? DEFAULT_MAX_INJECTED_ENTRIES;
  }

  public async composeSystemPrompt(
    baseSystemPrompt: string,
    userMessage: string,
  ): Promise<string> {
    const context = await this.buildContext(userMessage);

    if (context.length === 0) {
      return baseSystemPrompt;
    }

    if (baseSystemPrompt.trim().length === 0) {
      return context;
    }

    return `${baseSystemPrompt}\n\n${context}`;
  }

  public async buildContext(userMessage: string): Promise<string> {
    const longTermMatches = await this.findLongTermMatches(userMessage);
    const recentMatches = this.findRecentMatches(userMessage);
    const selectedMatches = this.selectTopMatches(longTermMatches, recentMatches);
    const selectedLongTermMatches = selectedMatches
      .filter((match): match is ContextMatch<MemorySnippet> => match.kind === 'long-term')
      .map((match) => match.item);
    const selectedRecentMatches = selectedMatches
      .filter(
        (match): match is ContextMatch<RecentMemoryMessage> => match.kind === 'recent',
      )
      .map((match) => match.item);

    if (
      selectedLongTermMatches.length === 0 &&
      selectedRecentMatches.length === 0
    ) {
      return '';
    }

    const sections = ['Relevant memory context:'];

    if (selectedLongTermMatches.length > 0) {
      sections.push('Long-term memory:');

      for (const match of selectedLongTermMatches) {
        sections.push(`- [${match.category}] ${match.content}`);
      }
    }

    if (selectedRecentMatches.length > 0) {
      sections.push('Recent memory from the last 7 days:');

      for (const match of selectedRecentMatches) {
        sections.push(
          `- [${match.role} | ${match.createdAt.toISOString()}] ${match.content}`,
        );
      }
    }

    sections.push(
      'Use memory only when it materially improves the answer. Prefer recent memory if it conflicts with older notes.',
    );

    return sections.join('\n');
  }

  private async findLongTermMatches(
    userMessage: string,
  ): Promise<ScoredValue<MemorySnippet>[]> {
    const documents = await this.memoryStore.readAllDocuments();
    const snippets = documents.flatMap((document) =>
      this.extractSnippets(document.name, document.content),
    );

    return this.rank(snippets, userMessage, this.maxLongTermMatches);
  }

  private findRecentMatches(
    userMessage: string,
  ): ScoredValue<RecentMemoryMessage>[] {
    const messages = this.recentMemory.listMessages({
      limit: this.maxRecentMatches * 4,
    });

    return this.rank(messages, userMessage, this.maxRecentMatches);
  }

  private selectTopMatches(
    longTermMatches: ScoredValue<MemorySnippet>[],
    recentMatches: ScoredValue<RecentMemoryMessage>[],
  ): Array<ContextMatch<MemorySnippet> | ContextMatch<RecentMemoryMessage>> {
    const combinedMatches: Array<
      ContextMatch<MemorySnippet> | ContextMatch<RecentMemoryMessage>
    > = [
      ...longTermMatches.map((entry, index) => ({
        kind: 'long-term' as const,
        item: entry.item,
        score: entry.score,
        index,
      })),
      ...recentMatches.map((entry, index) => ({
        kind: 'recent' as const,
        item: entry.item,
        score: entry.score,
        index,
      })),
    ];

    combinedMatches.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (left.kind !== right.kind) {
        return left.kind === 'recent' ? -1 : 1;
      }

      const leftCreatedAt = getRecentCreatedAt(left);
      const rightCreatedAt = getRecentCreatedAt(right);

      if (leftCreatedAt !== undefined && rightCreatedAt !== undefined) {
        return (
          rightCreatedAt.getTime() -
          leftCreatedAt.getTime()
        );
      }

      return left.index - right.index;
    });

    return combinedMatches.slice(0, this.maxInjectedEntries);
  }

  private extractSnippets(
    category: MemoryDocumentName,
    content: string,
  ): MemorySnippet[] {
    const lines = content.split('\n');
    const snippets: MemorySnippet[] = [];
    let current = '';

    for (const line of lines) {
      if (line.startsWith('- ')) {
        if (current.length > 0) {
          snippets.push({
            category,
            content: this.normalizeSnippet(current),
          });
        }

        current = line.slice(2);
        continue;
      }

      if (line.startsWith('  ') && current.length > 0) {
        current = `${current} ${line.trim()}`;
      }
    }

    if (current.length > 0) {
      snippets.push({
        category,
        content: this.normalizeSnippet(current),
      });
    }

    return snippets.filter((snippet) => snippet.content.length > 0);
  }

  private normalizeSnippet(content: string): string {
    return content
      .replace(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z:\s*/u,
        '',
      )
      .trim();
  }

  private rank<T extends { content: string }>(
    items: T[],
    userMessage: string,
    limit: number,
  ): ScoredValue<T>[] {
    const queryTokens = this.tokenize(userMessage);
    const scored = items
      .map((item) => ({
        item,
        score: this.score(item.content, queryTokens),
      }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score);

    const unique = new Set<string>();
    const results: ScoredValue<T>[] = [];

    for (const entry of scored) {
      const normalized = entry.item.content.trim().toLowerCase();

      if (unique.has(normalized)) {
        continue;
      }

      unique.add(normalized);
      results.push(entry);

      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }

  private score(content: string, queryTokens: Set<string>): number {
    if (queryTokens.size === 0) {
      return 0;
    }

    const contentTokens = this.tokenize(content);
    let score = 0;

    for (const token of queryTokens) {
      if (contentTokens.has(token)) {
        score += 1;
      }
    }

    return score;
  }

  private tokenize(value: string): Set<string> {
    const tokens = value
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .filter((token) => !STOP_WORDS.has(token));

    return new Set(tokens);
  }
}

function isRecentMatch(
  match: ContextMatch<MemorySnippet> | ContextMatch<RecentMemoryMessage>,
): match is ContextMatch<RecentMemoryMessage> {
  return match.kind === 'recent';
}

function getRecentCreatedAt(
  match: ContextMatch<MemorySnippet> | ContextMatch<RecentMemoryMessage>,
): Date | undefined {
  return isRecentMatch(match) ? match.item.createdAt : undefined;
}

const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'because',
  'been',
  'before',
  'being',
  'could',
  'first',
  'from',
  'have',
  'into',
  'just',
  'more',
  'only',
  'other',
  'over',
  'same',
  'some',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'very',
  'want',
  'with',
  'would',
  'your',
]);
