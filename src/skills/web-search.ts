import type { ToolDefinition } from '../core/providers/llm.js';
import {
  createPermissionRequirement,
  type PermissionRequirement,
} from './permissions.js';

const DUCKDUCKGO_ENDPOINT = 'https://api.duckduckgo.com/';
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;
const TOOL_NAME = 'web.search';

interface DuckDuckGoTopic {
  FirstURL?: string;
  Result?: string;
  Text?: string;
  Topics?: DuckDuckGoTopic[];
}

interface DuckDuckGoResponse {
  Abstract?: string;
  AbstractSource?: string;
  AbstractText?: string;
  AbstractURL?: string;
  Answer?: string;
  AnswerType?: string;
  Definition?: string;
  DefinitionSource?: string;
  DefinitionURL?: string;
  Heading?: string;
  RelatedTopics?: DuckDuckGoTopic[];
  Results?: DuckDuckGoTopic[];
}

interface SearchResult {
  title: string;
  snippet: string;
  url?: string;
}

export class WebSearchSkill {
  public readonly definition: ToolDefinition = {
    name: TOOL_NAME,
    description:
      'Searches the web with the DuckDuckGo Instant Answer API and returns normalized summaries and related links.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of related results to return. Defaults to 5.',
        },
      },
      required: ['query'],
    },
  };

  public getPermission(): PermissionRequirement {
    return createPermissionRequirement(
      'low',
      'Web search only performs a read-only DuckDuckGo API request.',
    );
  }

  public async execute(args: Record<string, unknown>): Promise<string> {
    const query = this.parseQuery(args.query);
    const maxResults = this.parseMaxResults(args.maxResults);
    const url = new URL(DUCKDUCKGO_ENDPOINT);

    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('no_redirect', '1');
    url.searchParams.set('skip_disambig', '0');

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `DuckDuckGo search failed with status ${response.status} ${response.statusText}`,
      );
    }

    const payload = this.parseResponse(await response.json());
    const results = this.extractResults(payload).slice(0, maxResults);

    return JSON.stringify({
      status: 'ok',
      tool: TOOL_NAME,
      source: 'duckduckgo',
      query,
      heading: payload.Heading ?? null,
      answer:
        payload.Answer && payload.Answer.trim().length > 0 ? payload.Answer : null,
      answerType: payload.AnswerType ?? null,
      abstract:
        payload.AbstractText && payload.AbstractText.trim().length > 0
          ? {
              text: payload.AbstractText,
              source: payload.AbstractSource ?? null,
              url: payload.AbstractURL ?? null,
            }
          : null,
      definition:
        payload.Definition && payload.Definition.trim().length > 0
          ? {
              text: payload.Definition,
              source: payload.DefinitionSource ?? null,
              url: payload.DefinitionURL ?? null,
            }
          : null,
      results,
    });
  }

  private parseQuery(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('Search query must be a non-empty string');
    }

    return value.trim();
  }

  private parseMaxResults(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return DEFAULT_MAX_RESULTS;
    }

    return Math.min(Math.max(Math.trunc(value), 1), MAX_RESULTS);
  }

  private parseResponse(value: unknown): DuckDuckGoResponse {
    if (!this.isRecord(value)) {
      throw new Error('DuckDuckGo response payload must be an object');
    }

    return value;
  }

  private extractResults(payload: DuckDuckGoResponse): SearchResult[] {
    const directResults = (payload.Results ?? [])
      .map((topic) => this.toSearchResult(topic))
      .filter((topic): topic is SearchResult => topic !== null);
    const relatedTopics = this.flattenTopics(payload.RelatedTopics ?? [])
      .map((topic) => this.toSearchResult(topic))
      .filter((topic): topic is SearchResult => topic !== null);
    const mergedResults = [...directResults, ...relatedTopics];
    const seenUrls = new Set<string>();
    const deduplicated: SearchResult[] = [];

    for (const result of mergedResults) {
      const dedupeKey = result.url ?? `${result.title}:${result.snippet}`;

      if (seenUrls.has(dedupeKey)) {
        continue;
      }

      seenUrls.add(dedupeKey);
      deduplicated.push(result);
    }

    return deduplicated;
  }

  private flattenTopics(topics: DuckDuckGoTopic[]): DuckDuckGoTopic[] {
    const flattened: DuckDuckGoTopic[] = [];

    for (const topic of topics) {
      flattened.push(topic);

      if (Array.isArray(topic.Topics) && topic.Topics.length > 0) {
        flattened.push(...this.flattenTopics(topic.Topics));
      }
    }

    return flattened;
  }

  private toSearchResult(topic: DuckDuckGoTopic): SearchResult | null {
    const snippet = typeof topic.Text === 'string' ? topic.Text.trim() : '';

    if (snippet.length === 0) {
      return null;
    }

    return {
      title: this.extractTitle(topic.Result, snippet),
      snippet,
      url: typeof topic.FirstURL === 'string' ? topic.FirstURL : undefined,
    };
  }

  private extractTitle(resultHtml: string | undefined, fallback: string): string {
    if (typeof resultHtml === 'string') {
      const anchorMatch = resultHtml.match(/>([^<]+)</);

      if (anchorMatch?.[1] !== undefined) {
        const title = anchorMatch[1].trim();

        if (title.length > 0) {
          return title;
        }
      }
    }

    const separatorIndex = fallback.indexOf(' - ');

    if (separatorIndex > 0) {
      return fallback.slice(0, separatorIndex).trim();
    }

    return fallback;
  }

  private isRecord(value: unknown): value is Record<string, never> {
    return typeof value === 'object' && value !== null;
  }
}
