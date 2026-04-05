import { randomUUID } from 'node:crypto';

import type {
  LlmGenerateOptions,
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
  ToolCall,
  ToolDefinition,
} from './llm.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen3:8b';
const DEFAULT_KEEP_ALIVE = -1;
const CHAT_ENDPOINT = '/api/chat';

type OllamaRole = LlmMessage['role'];

interface OllamaToolCallPayload {
  id?: string;
  type?: 'function';
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

interface OllamaChatMessage {
  role: OllamaRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: OllamaToolCallPayload[];
}

interface OllamaToolDefinitionPayload {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaRequestOptionsPayload {
  temperature?: number;
  num_predict?: number;
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: boolean;
  keep_alive?: string | number;
  tools?: OllamaToolDefinitionPayload[];
  options?: OllamaRequestOptionsPayload;
}

interface OllamaChatResponse {
  message?: OllamaChatMessage;
  done?: boolean;
}

export interface OllamaConfig {
  baseUrl?: string;
  model?: string;
  keepAlive?: string | number;
}

export class OllamaProvider implements LlmProvider {
  public readonly name = 'ollama';
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly keepAlive: string | number;

  public constructor(config: OllamaConfig = {}) {
    this.baseUrl = this.normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.model = config.model ?? DEFAULT_MODEL;
    this.keepAlive = this.resolveKeepAlive(config.keepAlive);
  }

  public async generate(
    messages: LlmMessage[],
    options: LlmGenerateOptions = {},
  ): Promise<LlmMessage> {
    const response = await this.request(messages, options, false);
    const payload = await this.parseJsonResponse(response);

    return this.toLlmMessage(payload);
  }

  public async *stream(
    messages: LlmMessage[],
    options: LlmGenerateOptions = {},
  ): AsyncIterable<LlmStreamChunk> {
    const response = await this.request(messages, options, true);

    if (response.body === null) {
      throw new Error('Ollama stream response body is unavailable');
    }

    for await (const payload of this.parseNdjsonStream(response.body)) {
      if (payload.message !== undefined) {
        if (payload.message.content.length > 0) {
          yield {
            type: 'text',
            text: payload.message.content,
          };
        }

        for (const toolCall of this.toToolCalls(payload.message.tool_calls)) {
          yield {
            type: 'tool_call',
            toolCall,
          };
        }
      }

      if (payload.done === true) {
        yield { type: 'done' };
      }
    }
  }

  private normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '');
  }

  private resolveKeepAlive(value: string | number | undefined): string | number {
    if (typeof value === 'number') {
      return value;
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }

    const envValue =
      process.env.OLLAMA_KEEP_ALIVE ??
      process.env.SONNY_OLLAMA_KEEP_ALIVE;

    if (envValue !== undefined && envValue.trim().length > 0) {
      return envValue.trim();
    }

    return DEFAULT_KEEP_ALIVE;
  }

  private async request(
    messages: LlmMessage[],
    options: LlmGenerateOptions,
    stream: boolean,
  ): Promise<Response> {
    const requestBody = this.buildRequest(messages, options, stream);
    const response = await fetch(`${this.baseUrl}${CHAT_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorBody = (await response.text()).trim();
      const errorDetail = errorBody.length > 0 ? `: ${errorBody}` : '';

      throw new Error(
        `Ollama request failed with status ${response.status} ${response.statusText}${errorDetail}`,
      );
    }

    return response;
  }

  private buildRequest(
    messages: LlmMessage[],
    options: LlmGenerateOptions,
    stream: boolean,
  ): OllamaChatRequest {
    const request: OllamaChatRequest = {
      model: options.model ?? this.model,
      messages: this.toOllamaMessages(
        this.withSystemPrompt(messages, options.systemPrompt),
      ),
      stream,
      keep_alive: this.keepAlive,
    };

    const tools = this.toOllamaTools(options.tools);

    if (tools !== undefined) {
      request.tools = tools;
    }

    const requestOptions = this.toRequestOptions(options);

    if (requestOptions !== undefined) {
      request.options = requestOptions;
    }

    return request;
  }

  private withSystemPrompt(
    messages: LlmMessage[],
    systemPrompt?: string,
  ): LlmMessage[] {
    if (systemPrompt === undefined || systemPrompt.length === 0) {
      return messages;
    }

    return [
      {
        role: 'system',
        content: systemPrompt,
      },
      ...messages,
    ];
  }

  private toOllamaMessages(messages: LlmMessage[]): OllamaChatMessage[] {
    return messages.map((message) => {
      const ollamaMessage: OllamaChatMessage = {
        role: message.role,
        content: message.content,
      };

      if (message.toolCallId !== undefined) {
        ollamaMessage.tool_call_id = message.toolCallId;
      }

      if ((message.toolCalls?.length ?? 0) > 0) {
        ollamaMessage.tool_calls = message.toolCalls?.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.name,
            arguments: toolCall.arguments,
          },
        }));
      }

      return ollamaMessage;
    });
  }

  private toOllamaTools(
    tools?: ToolDefinition[],
  ): OllamaToolDefinitionPayload[] | undefined {
    if (tools === undefined || tools.length === 0) {
      return undefined;
    }

    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  private toRequestOptions(
    options: LlmGenerateOptions,
  ): OllamaRequestOptionsPayload | undefined {
    const requestOptions: OllamaRequestOptionsPayload = {};

    if (options.temperature !== undefined) {
      requestOptions.temperature = options.temperature;
    }

    if (options.maxTokens !== undefined) {
      requestOptions.num_predict = options.maxTokens;
    }

    return Object.keys(requestOptions).length > 0 ? requestOptions : undefined;
  }

  private async parseJsonResponse(response: Response): Promise<OllamaChatResponse> {
    const data: unknown = await response.json();

    return this.parseResponsePayload(data);
  }

  private parseResponsePayload(data: unknown): OllamaChatResponse {
    if (!this.isRecord(data)) {
      throw new Error('Ollama response payload must be an object');
    }

    const payload: OllamaChatResponse = {};

    if (data.message !== undefined) {
      payload.message = this.parseOllamaMessage(data.message);
    }

    if (data.done !== undefined) {
      if (typeof data.done !== 'boolean') {
        throw new Error('Ollama response done flag must be a boolean');
      }

      payload.done = data.done;
    }

    return payload;
  }

  private parseOllamaMessage(data: unknown): OllamaChatMessage {
    if (!this.isRecord(data)) {
      throw new Error('Ollama message must be an object');
    }

    const role = data.role;
    const content = data.content;

    if (!this.isOllamaRole(role)) {
      throw new Error('Ollama message role is invalid');
    }

    if (typeof content !== 'string') {
      throw new Error('Ollama message content must be a string');
    }

    const message: OllamaChatMessage = {
      role,
      content,
    };

    if (data.tool_call_id !== undefined) {
      if (typeof data.tool_call_id !== 'string') {
        throw new Error('Ollama tool_call_id must be a string');
      }

      message.tool_call_id = data.tool_call_id;
    }

    if (data.tool_calls !== undefined) {
      if (!Array.isArray(data.tool_calls)) {
        throw new Error('Ollama tool_calls must be an array');
      }

      message.tool_calls = data.tool_calls.map((toolCall) =>
        this.parseOllamaToolCall(toolCall),
      );
    }

    return message;
  }

  private parseOllamaToolCall(data: unknown): OllamaToolCallPayload {
    if (!this.isRecord(data)) {
      throw new Error('Ollama tool call must be an object');
    }

    const functionValue = data.function;

    if (!this.isRecord(functionValue)) {
      throw new Error('Ollama tool call function must be an object');
    }

    if (typeof functionValue.name !== 'string') {
      throw new Error('Ollama tool function name must be a string');
    }

    const toolCall: OllamaToolCallPayload = {
      function: {
        name: functionValue.name,
        arguments: this.normalizeToolArguments(functionValue.arguments),
      },
    };

    if (typeof data.id === 'string') {
      toolCall.id = data.id;
    }

    if (data.type === 'function') {
      toolCall.type = 'function';
    }

    return toolCall;
  }

  private normalizeToolArguments(
    value: unknown,
  ): Record<string, unknown> | string {
    if (typeof value === 'string') {
      return value;
    }

    if (this.isRecord(value)) {
      return value;
    }

    return {};
  }

  private toLlmMessage(payload: OllamaChatResponse): LlmMessage {
    if (payload.message === undefined) {
      throw new Error('Ollama response did not include a message');
    }

    const toolCalls = this.toToolCalls(payload.message.tool_calls);

    return {
      role: payload.message.role,
      content: payload.message.content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  private toToolCalls(toolCalls?: OllamaToolCallPayload[]): ToolCall[] {
    if (toolCalls === undefined || toolCalls.length === 0) {
      return [];
    }

    return toolCalls.map((toolCall) => ({
      id: toolCall.id ?? randomUUID(),
      name: toolCall.function.name,
      arguments: this.parseToolCallArguments(toolCall.function.arguments),
    }));
  }

  private parseToolCallArguments(
    value: Record<string, unknown> | string,
  ): Record<string, unknown> {
    if (typeof value !== 'string') {
      return value;
    }

    if (value.trim().length === 0) {
      return {};
    }

    try {
      const parsed: unknown = JSON.parse(value);

      return this.isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private async *parseNdjsonStream(
    stream: ReadableStream<Uint8Array>,
  ): AsyncIterable<OllamaChatResponse> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf('\n');

        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (line.length > 0) {
            yield this.parseNdjsonLine(line);
          }

          newlineIndex = buffer.indexOf('\n');
        }
      }

      buffer += decoder.decode();

      const finalLine = buffer.trim();

      if (finalLine.length > 0) {
        yield this.parseNdjsonLine(finalLine);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private parseNdjsonLine(line: string): OllamaChatResponse {
    let data: unknown;

    try {
      data = JSON.parse(line);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Unknown JSON parse error';

      throw new Error(`Failed to parse Ollama NDJSON line: ${message}`);
    }

    return this.parseResponsePayload(data);
  }

  private isOllamaRole(value: unknown): value is OllamaRole {
    return (
      value === 'system' ||
      value === 'user' ||
      value === 'assistant' ||
      value === 'tool'
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
