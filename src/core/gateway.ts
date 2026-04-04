import type {
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
  ToolCall,
} from './providers/llm.js';
import { MemoryManager, type MemoryManagerConfig } from '../memory/memory-manager.js';
import { Session, type SessionConfig } from './session.js';
import { ToolRouter } from './tool-router.js';

export interface GatewayConfig {
  llmProvider: LlmProvider;
  sessionConfig?: SessionConfig;
  memoryManager?: MemoryManager;
  memoryManagerConfig?: MemoryManagerConfig;
}

export class Gateway {
  private readonly llmProvider: LlmProvider;
  private readonly session: Session;
  private readonly toolRouter: ToolRouter;
  private readonly memoryManager: MemoryManager;

  public constructor(config: GatewayConfig) {
    this.llmProvider = config.llmProvider;
    this.session = new Session(config.sessionConfig);
    this.toolRouter = new ToolRouter();
    this.memoryManager =
      config.memoryManager ??
      new MemoryManager({
        ...config.memoryManagerConfig,
        llmProvider: this.llmProvider,
      });
  }

  public get tools(): ToolRouter {
    return this.toolRouter;
  }

  public get currentSession(): Session {
    return this.session;
  }

  public async chat(userMessage: string): Promise<string> {
    const userEntry: LlmMessage = {
      role: 'user',
      content: userMessage,
    };

    this.session.addMessage(userEntry);
    await this.memoryManager.recordMessage(this.session.id, userEntry);

    let response = await this.llmProvider.generate(this.session.getMessages(), {
      tools: this.toolRouter.getDefinitions(),
    });

    while (this.hasToolCalls(response)) {
      this.session.addMessage(response);
      await this.memoryManager.recordMessage(this.session.id, response);
      await this.executeToolCalls(response.toolCalls);

      response = await this.llmProvider.generate(this.session.getMessages(), {
        tools: this.toolRouter.getDefinitions(),
      });
    }

    this.session.addMessage(response);
    await this.memoryManager.recordMessage(this.session.id, response);

    return response.content;
  }

  public async *streamChat(
    userMessage: string,
  ): AsyncIterable<LlmStreamChunk> {
    const userEntry: LlmMessage = {
      role: 'user',
      content: userMessage,
    };

    this.session.addMessage(userEntry);
    await this.memoryManager.recordMessage(this.session.id, userEntry);

    let assistantContent = '';

    for await (const chunk of this.llmProvider.stream(this.session.getMessages(), {
      tools: this.toolRouter.getDefinitions(),
    })) {
      if (chunk.type === 'text' && chunk.text !== undefined) {
        assistantContent += chunk.text;
      }

      yield chunk;
    }

    const assistantEntry: LlmMessage = {
      role: 'assistant',
      content: assistantContent,
    };

    this.session.addMessage(assistantEntry);
    await this.memoryManager.recordMessage(this.session.id, assistantEntry);
  }

  public async resetSession(): Promise<void> {
    await this.finalizeSession();
  }

  public close(): void {
    this.memoryManager.close();
  }

  public async finalizeSession(): Promise<void> {
    const history = this.session.getHistory();

    if (history.length === 0) {
      return;
    }

    try {
      await this.memoryManager.finalizeSession(history);
    } finally {
      this.session.clear();
    }
  }

  private hasToolCalls(
    message: LlmMessage,
  ): message is LlmMessage & { toolCalls: ToolCall[] } {
    return (message.toolCalls?.length ?? 0) > 0;
  }

  private async executeToolCalls(toolCalls: ToolCall[]): Promise<void> {
    for (const toolCall of toolCalls) {
      const result = await this.toolRouter.execute(toolCall);

      const toolEntry: LlmMessage = {
        role: 'tool',
        content: result,
        toolCallId: toolCall.id,
      };

      this.session.addMessage(toolEntry);
      await this.memoryManager.recordMessage(this.session.id, toolEntry);
    }
  }
}
