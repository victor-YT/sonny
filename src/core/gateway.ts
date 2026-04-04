import { loadConfig, type RuntimeConfig } from './config.js';
import type {
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
  ToolCall,
} from './providers/llm.js';
import { MemoryManager, type MemoryManagerConfig } from '../memory/memory-manager.js';
import { OllamaProvider } from './providers/ollama.js';
import {
  SkillRegistry,
  type SkillRegistryConfig,
} from '../skills/skill-registry.js';
import { loadPersonalityConfig } from './personality.js';
import { PromptBuilder } from './prompt-builder.js';
import { Session, type SessionConfig } from './session.js';
import { ToolRouter } from './tool-router.js';

export interface GatewayConfig {
  llmProvider?: LlmProvider;
  runtimeConfig?: RuntimeConfig;
  sessionConfig?: SessionConfig;
  memoryManager?: MemoryManager;
  memoryManagerConfig?: MemoryManagerConfig;
  promptBuilder?: PromptBuilder;
  skillRegistry?: SkillRegistry;
  skillRegistryConfig?: SkillRegistryConfig;
}

export class Gateway {
  private readonly llmProvider: LlmProvider;
  private readonly session: Session;
  private readonly toolRouter: ToolRouter;
  private readonly memoryManager: MemoryManager;
  private readonly promptBuilder: PromptBuilder;
  private readonly skillRegistry: SkillRegistry;
  private readonly runtimeConfig: RuntimeConfig | undefined;

  public constructor(config: GatewayConfig) {
    this.runtimeConfig = this.resolveRuntimeConfig(config);
    this.llmProvider = this.createLlmProvider(config, this.runtimeConfig);
    this.session = new Session(config.sessionConfig);
    this.toolRouter = new ToolRouter();
    this.memoryManager =
      config.memoryManager ??
      new MemoryManager({
        ...this.createMemoryManagerConfig(config, this.runtimeConfig),
        llmProvider: this.llmProvider,
      });
    this.promptBuilder =
      config.promptBuilder ??
      new PromptBuilder({
        personality: loadPersonalityConfig(),
      });
    this.skillRegistry =
      config.skillRegistry ??
      new SkillRegistry(this.createSkillRegistryConfig(config, this.runtimeConfig));
    this.skillRegistry.attachToRouter(this.toolRouter);
  }

  public get tools(): ToolRouter {
    return this.toolRouter;
  }

  public get currentSession(): Session {
    return this.session;
  }

  public get skills(): SkillRegistry {
    return this.skillRegistry;
  }

  public async chat(userMessage: string): Promise<string> {
    const systemPrompt = await this.buildSystemPrompt(userMessage);
    const userEntry: LlmMessage = {
      role: 'user',
      content: userMessage,
    };

    this.session.addMessage(userEntry);
    await this.memoryManager.recordMessage(this.session.id, userEntry);

    let response = await this.llmProvider.generate(this.session.getHistory(), {
      tools: this.toolRouter.getDefinitions(),
      systemPrompt,
    });

    while (this.hasToolCalls(response)) {
      this.session.addMessage(response);
      await this.memoryManager.recordMessage(this.session.id, response);
      await this.executeToolCalls(response.toolCalls);

      response = await this.llmProvider.generate(this.session.getHistory(), {
        tools: this.toolRouter.getDefinitions(),
        systemPrompt,
      });
    }

    this.session.addMessage(response);
    await this.memoryManager.recordMessage(this.session.id, response);

    return response.content;
  }

  public async *streamChat(
    userMessage: string,
  ): AsyncIterable<LlmStreamChunk> {
    const systemPrompt = await this.buildSystemPrompt(userMessage);
    const userEntry: LlmMessage = {
      role: 'user',
      content: userMessage,
    };

    this.session.addMessage(userEntry);
    await this.memoryManager.recordMessage(this.session.id, userEntry);

    let assistantContent = '';

    for await (const chunk of this.llmProvider.stream(this.session.getHistory(), {
      tools: this.toolRouter.getDefinitions(),
      systemPrompt,
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

  private resolveRuntimeConfig(config: GatewayConfig): RuntimeConfig | undefined {
    if (config.runtimeConfig !== undefined) {
      return config.runtimeConfig;
    }

    if (
      config.llmProvider === undefined ||
      config.memoryManager === undefined ||
      config.skillRegistry === undefined
    ) {
      return loadConfig();
    }

    return undefined;
  }

  private createLlmProvider(
    config: GatewayConfig,
    runtimeConfig: RuntimeConfig | undefined,
  ): LlmProvider {
    if (config.llmProvider !== undefined) {
      return config.llmProvider;
    }

    if (runtimeConfig !== undefined) {
      return new OllamaProvider({
        baseUrl: runtimeConfig.ollama.baseUrl,
        model: runtimeConfig.ollama.model,
      });
    }

    throw new Error(
      'Gateway requires either llmProvider or runtimeConfig to initialize.',
    );
  }

  private createMemoryManagerConfig(
    config: GatewayConfig,
    runtimeConfig: RuntimeConfig | undefined,
  ): MemoryManagerConfig {
    const memoryManagerConfig = config.memoryManagerConfig ?? {};

    if (runtimeConfig === undefined) {
      return memoryManagerConfig;
    }

    return {
      ...memoryManagerConfig,
      recentMemoryConfig: {
        retentionDays:
          memoryManagerConfig.recentMemoryConfig?.retentionDays ??
          runtimeConfig.memory.retentionDays,
        ...memoryManagerConfig.recentMemoryConfig,
      },
    };
  }

  private createSkillRegistryConfig(
    config: GatewayConfig,
    runtimeConfig: RuntimeConfig | undefined,
  ): SkillRegistryConfig {
    return {
      ...config.skillRegistryConfig,
      runtimeConfig:
        config.skillRegistryConfig?.runtimeConfig ?? runtimeConfig,
    };
  }

  private hasToolCalls(
    message: LlmMessage,
  ): message is LlmMessage & { toolCalls: ToolCall[] } {
    return (message.toolCalls?.length ?? 0) > 0;
  }

  private async buildSystemPrompt(userMessage: string): Promise<string> {
    const injectedMemory = await this.memoryManager.buildSystemPrompt(
      '',
      userMessage,
    );

    return this.promptBuilder.buildSystemPrompt(injectedMemory);
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
