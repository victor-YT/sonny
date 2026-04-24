import type {
  LlmGenerateOptions,
  LlmMessage,
  LlmProvider,
  LlmProviderDebugInfo,
  LlmRoutingDecision,
  LlmStreamChunk,
} from './llm.js';

interface RoutedLlmLane {
  providerId: string;
  provider: LlmProvider;
  model: string | null;
}

export interface RoutedLlmProviderConfig {
  foreground: RoutedLlmLane;
  background: RoutedLlmLane;
}

export interface LlmRoutingSnapshot {
  foregroundProviderId: string;
  backgroundProviderId: string;
  foregroundModel: string | null;
  backgroundModel: string | null;
  lastDecision: LlmRoutingDecision | null;
}

export class RoutedLlmProvider implements LlmProvider {
  public readonly name = 'llm-router';

  private readonly foreground: RoutedLlmLane;
  private readonly background: RoutedLlmLane;
  private lastDecision: LlmRoutingDecision | null = null;

  public constructor(config: RoutedLlmProviderConfig) {
    this.foreground = config.foreground;
    this.background = config.background;
  }

  public get currentModel(): string | null {
    return this.lastDecision?.model ?? this.foreground.model;
  }

  public getLastRoutingDecision(): LlmRoutingDecision | null {
    return this.lastDecision === null ? null : { ...this.lastDecision };
  }

  public getLastDebugInfo(): LlmProviderDebugInfo | null {
    const lane = this.lastDecision?.lane === 'background'
      ? this.background
      : this.foreground;

    return lane.provider.getLastDebugInfo?.() ?? null;
  }

  public getRoutingSnapshot(): LlmRoutingSnapshot {
    return {
      foregroundProviderId: this.foreground.providerId,
      backgroundProviderId: this.background.providerId,
      foregroundModel: this.foreground.model,
      backgroundModel: this.background.model,
      lastDecision: this.getLastRoutingDecision(),
    };
  }

  public async generate(
    messages: LlmMessage[],
    options: LlmGenerateOptions = {},
  ): Promise<LlmMessage> {
    const lane = this.selectLane(messages);

    return lane.provider.generate(messages, {
      ...options,
      model: options.model ?? lane.model ?? undefined,
    });
  }

  public generateStream(
    messages: LlmMessage[],
    options: LlmGenerateOptions = {},
  ): AsyncIterable<LlmStreamChunk> {
    const lane = this.selectLane(messages);
    const generateStream = lane.provider.generateStream ?? lane.provider.stream;

    if (generateStream === undefined) {
      throw new Error(`LLM provider "${lane.provider.name}" does not support streaming generation.`);
    }

    return generateStream.call(lane.provider, messages, {
      ...options,
      model: options.model ?? lane.model ?? undefined,
    });
  }

  public stream(
    messages: LlmMessage[],
    options: LlmGenerateOptions = {},
  ): AsyncIterable<LlmStreamChunk> {
    return this.generateStream(messages, options);
  }

  private selectLane(messages: LlmMessage[]): RoutedLlmLane {
    const latestUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === 'user')?.content ?? '';
    const normalized = latestUserMessage.trim().toLowerCase();
    const wordCount = normalized.length === 0 ? 0 : normalized.split(/\s+/u).length;
    const explicitComplexityPatterns = [
      /\bthink\b/u,
      /\bplan\b/u,
      /\banaly[sz]e\b/u,
      /\bdebug\b/u,
      /\bcompare\b/u,
      /\bdesign\b/u,
      /\barchitect(?:ure)?\b/u,
      /\bstrategy\b/u,
      /\bstep[- ]by[- ]step\b/u,
      /\bdeep(?:ly)?\b/u,
      /\bthorough(?:ly)?\b/u,
      /\binvestigat(?:e|ion)\b/u,
    ];
    const isExplicitlyComplex = explicitComplexityPatterns.some((pattern) => pattern.test(normalized));
    const isLongRequest = normalized.length >= 180 || wordCount >= 28;
    const lane = isExplicitlyComplex || isLongRequest
      ? this.background
      : this.foreground;
    const reason = isExplicitlyComplex
      ? 'Matched explicit complexity/planning keywords in the user request.'
      : isLongRequest
        ? 'Request length exceeded the simple-turn threshold.'
        : 'Short conversational turn routed to the low-latency foreground model.';

    this.lastDecision = {
      lane: lane === this.background ? 'background' : 'foreground',
      providerId: lane.providerId,
      providerName: lane.provider.name,
      model: lane.model,
      reason,
      timestamp: new Date().toISOString(),
    };

    return lane;
  }
}
