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

export interface LlmProvider {
  readonly name: string;
  generate(
    messages: LlmMessage[],
    options?: LlmGenerateOptions,
  ): Promise<LlmMessage>;
  stream(
    messages: LlmMessage[],
    options?: LlmGenerateOptions,
  ): AsyncIterable<LlmStreamChunk>;
}

export interface LlmGenerateOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  signal?: AbortSignal;
}
