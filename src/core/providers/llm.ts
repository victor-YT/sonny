export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmStreamChunk {
  type: 'text' | 'tool_call' | 'done';
  text?: string;
  toolCall?: ToolCall;
}

export interface LlmRoutingDecision {
  lane: 'foreground' | 'background';
  providerId: string;
  providerName: string;
  model: string | null;
  reason: string;
  timestamp: string;
}

export interface LlmProviderDebugInfo {
  providerName: string;
  baseUrl?: string;
  model: string | null;
  requestStartedAt: string | null;
  firstTokenAt: string | null;
  firstSentenceAt: string | null;
  responseFinishedAt: string | null;
  streamingUsed: boolean | null;
  firstTokenLatencyMs: number | null;
  firstSentenceLatencyMs: number | null;
  fullResponseLatencyMs: number | null;
  failureReason: string | null;
}

export interface LlmProvider {
  readonly name: string;
  readonly currentModel?: string | null;
  generate(
    messages: LlmMessage[],
    options?: LlmGenerateOptions,
  ): Promise<LlmMessage>;
  generateStream(
    messages: LlmMessage[],
    options?: LlmGenerateOptions,
  ): AsyncIterable<LlmStreamChunk>;
  stream?(
    messages: LlmMessage[],
    options?: LlmGenerateOptions,
  ): AsyncIterable<LlmStreamChunk>;
  getLastRoutingDecision?(): LlmRoutingDecision | null;
  getLastDebugInfo?(): LlmProviderDebugInfo | null;
}

export interface LlmGenerateOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  signal?: AbortSignal;
}
