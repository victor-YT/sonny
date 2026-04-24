import { randomUUID } from 'node:crypto';

import type {
  LlmGenerateOptions,
  LlmMessage,
  LlmProvider,
  LlmProviderDebugInfo,
  LlmStreamChunk,
  ToolCall,
  ToolDefinition,
} from './llm.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000';
const DEFAULT_MODEL = 'Qwen2.5-1.5B-Instruct-4bit';
const CHAT_COMPLETIONS_ENDPOINT = '/v1/chat/completions';

type OpenAiRole = LlmMessage['role'];

interface OpenAiToolCallPayload {
  id?: string;
  type?: 'function';
  function: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAiChatMessage {
  role: OpenAiRole;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCallPayload[];
}

interface OpenAiToolDefinitionPayload {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAiChatRequest {
  model: string;
  messages: OpenAiChatMessage[];
  stream: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: OpenAiToolDefinitionPayload[];
}

interface OpenAiChatChoice {
  message?: OpenAiChatMessage;
  delta?: Partial<OpenAiChatMessage>;
  finish_reason?: string | null;
}

interface OpenAiChatResponse {
  choices: OpenAiChatChoice[];
}

export interface OlmxDebugInfo extends LlmProviderDebugInfo {
  providerName: string;
  baseUrl: string;
  model: string;
  requestStartedAt: string | null;
  firstTokenAt: string | null;
  firstSentenceAt: string | null;
  responseFinishedAt: string | null;
  streamingUsed: boolean;
  firstTokenLatencyMs: number | null;
  firstSentenceLatencyMs: number | null;
  fullResponseLatencyMs: number | null;
  failureReason: string | null;
}

export interface OlmxConfig {
  baseUrl?: string;
  model?: string;
}

export class OlmxForegroundProvider implements LlmProvider {
  public readonly name = 'OLMX Foreground LLM';
  private readonly baseUrl: string;
  private readonly model: string;
  private lastDebugInfo: OlmxDebugInfo | null = null;

  public constructor(config: OlmxConfig = {}) {
    this.baseUrl = this.normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.model = config.model ?? DEFAULT_MODEL;
  }

  public get currentModel(): string {
    return this.model;
  }

  public get currentBaseUrl(): string {
    return this.baseUrl;
  }

  public getLastDebugInfo(): OlmxDebugInfo | null {
    return this.lastDebugInfo === null ? null : { ...this.lastDebugInfo };
  }

  public async generate(
    messages: LlmMessage[],
    options: LlmGenerateOptions = {},
  ): Promise<LlmMessage> {
    const requestStartedAt = new Date();
    const debug = this.createDebugInfo(options.model, false, requestStartedAt);
    this.lastDebugInfo = debug;

    try {
      const response = await this.request(messages, options, false);
      const payload = await this.parseJsonResponse(response);
      const finishedAt = new Date();

      this.lastDebugInfo = {
        ...debug,
        firstTokenAt: finishedAt.toISOString(),
        responseFinishedAt: finishedAt.toISOString(),
        firstTokenLatencyMs: diffMs(requestStartedAt, finishedAt),
        fullResponseLatencyMs: diffMs(requestStartedAt, finishedAt),
      };

      return this.toLlmMessage(payload);
    } catch (error: unknown) {
      this.recordFailure(debug, error);
      throw error;
    }
  }

  public async *generateStream(
    messages: LlmMessage[],
    options: LlmGenerateOptions = {},
  ): AsyncIterable<LlmStreamChunk> {
    const requestStartedAt = new Date();
    const debug = this.createDebugInfo(options.model, true, requestStartedAt);
    this.lastDebugInfo = debug;
    let emittedText = '';
    let firstTokenAt: Date | null = null;
    let firstSentenceAt: Date | null = null;

    try {
      const response = await this.request(messages, options, true);

      if (response.body === null) {
        throw new Error('OLMX stream response body is unavailable');
      }

      for await (const payload of this.parseSseStream(response.body)) {
        for (const choice of payload.choices) {
          const delta = choice.delta;

          if (delta?.content !== undefined && delta.content !== null) {
            const text = delta.content;

            if (text.length > 0) {
              emittedText += text;

              if (firstTokenAt === null) {
                firstTokenAt = new Date();
                this.lastDebugInfo = {
                  ...debug,
                  firstTokenAt: firstTokenAt.toISOString(),
                  firstTokenLatencyMs: diffMs(requestStartedAt, firstTokenAt),
                };
              }

              if (firstSentenceAt === null && containsSentenceBoundary(emittedText)) {
                firstSentenceAt = new Date();
                this.lastDebugInfo = {
                  ...(this.lastDebugInfo ?? debug),
                  firstSentenceAt: firstSentenceAt.toISOString(),
                  firstSentenceLatencyMs: diffMs(requestStartedAt, firstSentenceAt),
                };
              }

              yield {
                type: 'text',
                text,
              };
            }
          }

          for (const toolCall of this.toToolCalls(delta?.tool_calls)) {
            yield {
              type: 'tool_call',
              toolCall,
            };
          }
        }
      }

      const responseFinishedAt = new Date();
      this.lastDebugInfo = {
        ...(this.lastDebugInfo ?? debug),
        responseFinishedAt: responseFinishedAt.toISOString(),
        fullResponseLatencyMs: diffMs(requestStartedAt, responseFinishedAt),
      };

      yield { type: 'done' };
    } catch (error: unknown) {
      this.recordFailure(this.lastDebugInfo ?? debug, error);
      throw error;
    }
  }

  public stream(
    messages: LlmMessage[],
    options: LlmGenerateOptions = {},
  ): AsyncIterable<LlmStreamChunk> {
    return this.generateStream(messages, options);
  }

  private normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/u, '').replace(/\/v1$/u, '');
  }

  private createDebugInfo(
    model: string | undefined,
    streamingUsed: boolean,
    requestStartedAt: Date,
  ): OlmxDebugInfo {
    return {
      providerName: this.name,
      baseUrl: this.baseUrl,
      model: model ?? this.model,
      requestStartedAt: requestStartedAt.toISOString(),
      firstTokenAt: null,
      firstSentenceAt: null,
      responseFinishedAt: null,
      streamingUsed,
      firstTokenLatencyMs: null,
      firstSentenceLatencyMs: null,
      fullResponseLatencyMs: null,
      failureReason: null,
    };
  }

  private recordFailure(debug: OlmxDebugInfo, error: unknown): void {
    this.lastDebugInfo = {
      ...debug,
      responseFinishedAt: new Date().toISOString(),
      failureReason: error instanceof Error ? error.message : 'Unknown OLMX failure',
    };
  }

  private async request(
    messages: LlmMessage[],
    options: LlmGenerateOptions,
    stream: boolean,
  ): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${CHAT_COMPLETIONS_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(this.buildRequest(messages, options, stream)),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorBody = (await response.text()).trim();
      const errorDetail = errorBody.length > 0 ? `: ${errorBody}` : '';

      throw new Error(
        `OLMX request failed with status ${response.status} ${response.statusText}${errorDetail}`,
      );
    }

    return response;
  }

  private buildRequest(
    messages: LlmMessage[],
    options: LlmGenerateOptions,
    stream: boolean,
  ): OpenAiChatRequest {
    const request: OpenAiChatRequest = {
      model: options.model ?? this.model,
      messages: this.toOpenAiMessages(
        this.withSystemPrompt(messages, options.systemPrompt),
      ),
      stream,
    };

    if (options.temperature !== undefined) {
      request.temperature = options.temperature;
    }

    if (options.maxTokens !== undefined) {
      request.max_tokens = options.maxTokens;
    }

    const tools = this.toOpenAiTools(options.tools);

    if (tools !== undefined) {
      request.tools = tools;
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

  private toOpenAiMessages(messages: LlmMessage[]): OpenAiChatMessage[] {
    return messages.map((message) => {
      const openAiMessage: OpenAiChatMessage = {
        role: message.role,
        content: message.content,
      };

      if (message.toolCallId !== undefined) {
        openAiMessage.tool_call_id = message.toolCallId;
      }

      if ((message.toolCalls?.length ?? 0) > 0) {
        openAiMessage.tool_calls = message.toolCalls?.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          },
        }));
      }

      return openAiMessage;
    });
  }

  private toOpenAiTools(
    tools?: ToolDefinition[],
  ): OpenAiToolDefinitionPayload[] | undefined {
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

  private async parseJsonResponse(response: Response): Promise<OpenAiChatResponse> {
    const data: unknown = await response.json();

    return this.parseResponsePayload(data);
  }

  private parseResponsePayload(data: unknown): OpenAiChatResponse {
    if (!isRecord(data)) {
      throw new Error('OLMX response payload must be an object');
    }

    const choices = data.choices;

    if (!Array.isArray(choices)) {
      throw new Error('OLMX response choices must be an array');
    }

    return {
      choices: choices.map((choice) => this.parseChoice(choice)),
    };
  }

  private parseChoice(data: unknown): OpenAiChatChoice {
    if (!isRecord(data)) {
      throw new Error('OLMX response choice must be an object');
    }

    const choice: OpenAiChatChoice = {};

    if (data.message !== undefined) {
      choice.message = this.parseMessage(data.message);
    }

    if (data.delta !== undefined) {
      choice.delta = this.parseMessageDelta(data.delta);
    }

    if (data.finish_reason === null || typeof data.finish_reason === 'string') {
      choice.finish_reason = data.finish_reason;
    }

    return choice;
  }

  private parseMessage(data: unknown): OpenAiChatMessage {
    if (!isRecord(data)) {
      throw new Error('OLMX chat message must be an object');
    }

    const role = data.role;
    const content = data.content;

    if (!this.isOpenAiRole(role)) {
      throw new Error('OLMX chat message role is invalid');
    }

    if (typeof content !== 'string' && content !== null) {
      throw new Error('OLMX chat message content must be a string or null');
    }

    const message: OpenAiChatMessage = {
      role,
      content,
    };

    if (data.tool_call_id !== undefined) {
      if (typeof data.tool_call_id !== 'string') {
        throw new Error('OLMX tool_call_id must be a string');
      }

      message.tool_call_id = data.tool_call_id;
    }

    if (data.tool_calls !== undefined) {
      if (!Array.isArray(data.tool_calls)) {
        throw new Error('OLMX tool_calls must be an array');
      }

      message.tool_calls = data.tool_calls.map((toolCall) =>
        this.parseToolCall(toolCall),
      );
    }

    return message;
  }

  private parseMessageDelta(data: unknown): Partial<OpenAiChatMessage> {
    if (!isRecord(data)) {
      throw new Error('OLMX chat delta must be an object');
    }

    const delta: Partial<OpenAiChatMessage> = {};

    if (data.role !== undefined) {
      if (!this.isOpenAiRole(data.role)) {
        throw new Error('OLMX chat delta role is invalid');
      }

      delta.role = data.role;
    }

    if (data.content !== undefined) {
      if (typeof data.content !== 'string' && data.content !== null) {
        throw new Error('OLMX chat delta content must be a string or null');
      }

      delta.content = data.content;
    }

    if (data.tool_calls !== undefined) {
      if (!Array.isArray(data.tool_calls)) {
        throw new Error('OLMX delta tool_calls must be an array');
      }

      delta.tool_calls = data.tool_calls.map((toolCall) =>
        this.parseToolCall(toolCall),
      );
    }

    return delta;
  }

  private parseToolCall(data: unknown): OpenAiToolCallPayload {
    if (!isRecord(data)) {
      throw new Error('OLMX tool call must be an object');
    }

    const functionValue = data.function;

    if (!isRecord(functionValue)) {
      throw new Error('OLMX tool call function must be an object');
    }

    const toolCall: OpenAiToolCallPayload = {
      function: {},
    };

    if (typeof data.id === 'string') {
      toolCall.id = data.id;
    }

    if (data.type === 'function') {
      toolCall.type = data.type;
    }

    if (typeof functionValue.name === 'string') {
      toolCall.function.name = functionValue.name;
    }

    if (typeof functionValue.arguments === 'string') {
      toolCall.function.arguments = functionValue.arguments;
    }

    return toolCall;
  }

  private toLlmMessage(payload: OpenAiChatResponse): LlmMessage {
    const message = payload.choices[0]?.message;

    if (message === undefined) {
      throw new Error('OLMX response did not include a message');
    }

    const toolCalls = this.toToolCalls(message.tool_calls);

    return {
      role: message.role,
      content: message.content ?? '',
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  private toToolCalls(toolCalls?: OpenAiToolCallPayload[]): ToolCall[] {
    if (toolCalls === undefined || toolCalls.length === 0) {
      return [];
    }

    return toolCalls
      .filter((toolCall) => toolCall.function.name !== undefined)
      .map((toolCall) => ({
        id: toolCall.id ?? randomUUID(),
        name: toolCall.function.name ?? '',
        arguments: this.parseToolCallArguments(toolCall.function.arguments),
      }));
  }

  private parseToolCallArguments(value: string | undefined): Record<string, unknown> {
    if (value === undefined || value.trim().length === 0) {
      return {};
    }

    try {
      const parsed: unknown = JSON.parse(value);

      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private async *parseSseStream(
    stream: ReadableStream<Uint8Array>,
  ): AsyncIterable<OpenAiChatResponse> {
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
        const events = buffer.split(/\r?\n\r?\n/u);
        buffer = events.pop() ?? '';

        for (const event of events) {
          const payload = this.parseSseEvent(event);

          if (payload !== null) {
            yield payload;
          }
        }
      }

      buffer += decoder.decode();

      if (buffer.trim().length > 0) {
        const payload = this.parseSseEvent(buffer);

        if (payload !== null) {
          yield payload;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private parseSseEvent(event: string): OpenAiChatResponse | null {
    const dataLines = event
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim());

    if (dataLines.length === 0) {
      return null;
    }

    const data = dataLines.join('\n');

    if (data === '[DONE]') {
      return null;
    }

    try {
      return this.parseResponsePayload(JSON.parse(data) as unknown);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Unknown JSON parse error';

      throw new Error(`Failed to parse OLMX SSE event: ${message}`);
    }
  }

  private isOpenAiRole(value: unknown): value is OpenAiRole {
    return (
      value === 'system' ||
      value === 'user' ||
      value === 'assistant' ||
      value === 'tool'
    );
  }
}

function containsSentenceBoundary(text: string): boolean {
  return /[.!?。！？]\s*$/u.test(text.trim());
}

function diffMs(start: Date, end: Date): number {
  return Math.max(0, end.getTime() - start.getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
