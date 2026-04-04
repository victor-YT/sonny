import type {
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
  ToolCall,
} from './providers/llm.js';
import { Session, type SessionConfig } from './session.js';
import { ToolRouter } from './tool-router.js';

export interface GatewayConfig {
  llmProvider: LlmProvider;
  sessionConfig?: SessionConfig;
}

export class Gateway {
  private readonly llmProvider: LlmProvider;
  private readonly session: Session;
  private readonly toolRouter: ToolRouter;

  public constructor(config: GatewayConfig) {
    this.llmProvider = config.llmProvider;
    this.session = new Session(config.sessionConfig);
    this.toolRouter = new ToolRouter();
  }

  public get tools(): ToolRouter {
    return this.toolRouter;
  }

  public get currentSession(): Session {
    return this.session;
  }

  public async chat(userMessage: string): Promise<string> {
    this.session.addMessage({
      role: 'user',
      content: userMessage,
    });

    let response = await this.llmProvider.generate(this.session.getMessages(), {
      tools: this.toolRouter.getDefinitions(),
    });

    while (this.hasToolCalls(response)) {
      this.session.addMessage(response);
      await this.executeToolCalls(response.toolCalls);

      response = await this.llmProvider.generate(this.session.getMessages(), {
        tools: this.toolRouter.getDefinitions(),
      });
    }

    this.session.addMessage(response);

    return response.content;
  }

  public async *streamChat(
    userMessage: string,
  ): AsyncIterable<LlmStreamChunk> {
    this.session.addMessage({
      role: 'user',
      content: userMessage,
    });

    let assistantContent = '';

    for await (const chunk of this.llmProvider.stream(this.session.getMessages(), {
      tools: this.toolRouter.getDefinitions(),
    })) {
      if (chunk.type === 'text' && chunk.text !== undefined) {
        assistantContent += chunk.text;
      }

      yield chunk;
    }

    this.session.addMessage({
      role: 'assistant',
      content: assistantContent,
    });
  }

  public resetSession(): void {
    this.session.clear();
  }

  private hasToolCalls(
    message: LlmMessage,
  ): message is LlmMessage & { toolCalls: ToolCall[] } {
    return (message.toolCalls?.length ?? 0) > 0;
  }

  private async executeToolCalls(toolCalls: ToolCall[]): Promise<void> {
    for (const toolCall of toolCalls) {
      const result = await this.toolRouter.execute(toolCall);

      this.session.addMessage({
        role: 'tool',
        content: result,
        toolCallId: toolCall.id,
      });
    }
  }
}
