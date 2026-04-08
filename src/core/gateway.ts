import { loadConfig, type RuntimeConfig } from './config.js';
import {
  ContextManager,
  type ContextManagerConfig,
} from './context-manager.js';
import {
  ConversationHistory,
  type PersistedConversationMessage,
  type ConversationHistoryConfig,
} from './conversation-history.js';
import type {
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
  ToolCall,
} from './providers/llm.js';
import { MemoryManager, type MemoryManagerConfig } from '../memory/memory-manager.js';
import { OllamaProvider } from './providers/ollama.js';
import type {
  ProactiveAgent,
  ProactiveNotification,
} from './proactive-agent.js';
import {
  SkillRegistry,
  type SkillRegistryConfig,
} from '../skills/skill-registry.js';
import { PromptBuilder } from './prompt-builder.js';
import { Session, type SessionConfig } from './session.js';
import type { TimingTracker } from './timing.js';
import { ToolRouter } from './tool-router.js';

export interface GatewayConfig {
  llmProvider?: LlmProvider;
  runtimeConfig?: RuntimeConfig;
  sessionConfig?: SessionConfig;
  memoryManager?: MemoryManager;
  memoryManagerConfig?: MemoryManagerConfig;
  contextManager?: ContextManager;
  contextManagerConfig?: ContextManagerConfig;
  conversationHistory?: ConversationHistory;
  conversationHistoryConfig?: ConversationHistoryConfig;
  promptBuilder?: PromptBuilder;
  skillRegistry?: SkillRegistry;
  skillRegistryConfig?: SkillRegistryConfig;
  proactiveAgent?: ProactiveAgent;
}

export class Gateway {
  private readonly llmProvider: LlmProvider;
  private readonly session: Session;
  private readonly toolRouter: ToolRouter;
  private readonly memoryManager: MemoryManager;
  private readonly contextManager: ContextManager;
  private readonly conversationHistory: ConversationHistory;
  private readonly promptBuilder: PromptBuilder;
  private readonly skillRegistry: SkillRegistry;
  private readonly runtimeConfig: RuntimeConfig | undefined;
  private readonly proactiveListeners = new Set<
    (notification: ProactiveNotification) => void | Promise<void>
  >();
  private readonly detachProactiveListener: (() => void) | undefined;

  public constructor(config: GatewayConfig) {
    this.runtimeConfig = this.resolveRuntimeConfig(config);
    this.llmProvider = this.createLlmProvider(config, this.runtimeConfig);
    this.contextManager =
      config.contextManager ??
      new ContextManager(this.createContextManagerConfig(config, this.runtimeConfig));
    this.conversationHistory =
      config.conversationHistory ??
      new ConversationHistory({
        ...config.conversationHistoryConfig,
        maxInMemoryMessages:
          config.conversationHistoryConfig?.maxInMemoryMessages ??
          config.sessionConfig?.maxHistoryLength,
        tokenEstimator: (message) => this.contextManager.estimateMessageTokens(message),
      });
    this.session = new Session({
      ...config.sessionConfig,
      conversationHistory: this.conversationHistory,
    });
    this.toolRouter = new ToolRouter();
    this.memoryManager =
      config.memoryManager ??
      new MemoryManager({
        ...this.createMemoryManagerConfig(config, this.runtimeConfig),
        llmProvider: this.llmProvider,
      });
    this.promptBuilder =
      config.promptBuilder ??
      new PromptBuilder();
    this.skillRegistry =
      config.skillRegistry ??
      new SkillRegistry(this.createSkillRegistryConfig(config, this.runtimeConfig));
    this.skillRegistry.attachToRouter(this.toolRouter);
    this.detachProactiveListener = config.proactiveAgent?.onNotification(
      async (notification) => {
        await this.handleProactiveNotification(notification);
      },
    );
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

  public get providerName(): string {
    return this.llmProvider.name;
  }

  public get currentModel(): string | null {
    return this.runtimeConfig?.ollama.model ?? readStringProperty(this.llmProvider, 'model');
  }

  public get currentRuntimeConfig(): RuntimeConfig | undefined {
    return this.runtimeConfig;
  }

  public listRecentConversationMessages(
    limit = 50,
  ): PersistedConversationMessage[] {
    return this.conversationHistory.listRecentMessages(limit);
  }

  public onProactiveNotification(
    listener: (notification: ProactiveNotification) => void | Promise<void>,
  ): () => void {
    this.proactiveListeners.add(listener);

    return () => {
      this.proactiveListeners.delete(listener);
    };
  }

  public async chat(userMessage: string): Promise<string> {
    const baseSystemPrompt = await this.buildSystemPrompt(userMessage);
    const userEntry: LlmMessage = {
      role: 'user',
      content: userMessage,
    };

    this.session.addMessage(userEntry);
    await this.memoryManager.recordMessage(this.session.id, userEntry);
    let contextWindow = this.contextManager.buildContextWindow({
      systemPrompt: baseSystemPrompt,
      entries: this.session.getEntries(),
    });

    let response = await this.llmProvider.generate(contextWindow.messages, {
      tools: this.toolRouter.getDefinitions(),
      systemPrompt: contextWindow.systemPrompt,
    });

    while (this.hasToolCalls(response)) {
      this.session.addMessage(response);
      await this.memoryManager.recordMessage(this.session.id, response);
      await this.executeToolCalls(response.toolCalls);
      contextWindow = this.contextManager.buildContextWindow({
        systemPrompt: baseSystemPrompt,
        entries: this.session.getEntries(),
      });

      response = await this.llmProvider.generate(contextWindow.messages, {
        tools: this.toolRouter.getDefinitions(),
        systemPrompt: contextWindow.systemPrompt,
      });
    }

    this.session.addMessage(response);
    await this.memoryManager.recordMessage(this.session.id, response);

    return response.content;
  }

  public async *streamChat(
    userMessage: string,
    options: {
      signal?: AbortSignal;
      timingTracker?: TimingTracker;
    } = {},
  ): AsyncIterable<LlmStreamChunk> {
    const baseSystemPrompt = await this.buildSystemPrompt(userMessage);
    const userEntry: LlmMessage = {
      role: 'user',
      content: userMessage,
    };

    this.session.addMessage(userEntry);
    await this.memoryManager.recordMessage(this.session.id, userEntry);
    const contextWindow = this.contextManager.buildContextWindow({
      systemPrompt: baseSystemPrompt,
      entries: this.session.getEntries(),
    });

    let assistantContent = '';
    let firstTokenRecorded = false;

    options.timingTracker?.start('llm_first_token');
    options.timingTracker?.start('llm_full_response');

    for await (const chunk of this.llmProvider.stream(contextWindow.messages, {
      tools: this.toolRouter.getDefinitions(),
      systemPrompt: contextWindow.systemPrompt,
      signal: options.signal,
    })) {
      if (chunk.type === 'text' && chunk.text !== undefined) {
        if (!firstTokenRecorded) {
          firstTokenRecorded = true;
          options.timingTracker?.end('llm_first_token');
        }

        assistantContent += chunk.text;
      }

      yield chunk;
    }

    if (!firstTokenRecorded) {
      options.timingTracker?.end('llm_first_token');
    }

    options.timingTracker?.end('llm_full_response');

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
    this.detachProactiveListener?.();
    this.memoryManager.close();
    this.conversationHistory.close();
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

  private createContextManagerConfig(
    config: GatewayConfig,
    runtimeConfig: RuntimeConfig | undefined,
  ): ContextManagerConfig {
    const contextManagerConfig = config.contextManagerConfig ?? {};

    if (runtimeConfig === undefined) {
      return contextManagerConfig;
    }

    return {
      ...contextManagerConfig,
      maxTokens:
        contextManagerConfig.maxTokens ?? runtimeConfig.memory.maxTokens,
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

  private async handleProactiveNotification(
    notification: ProactiveNotification,
  ): Promise<void> {
    const assistantEntry: LlmMessage = {
      role: 'assistant',
      content: formatProactiveNotification(notification),
    };

    this.session.addMessage(assistantEntry);
    await this.memoryManager.recordMessage(this.session.id, assistantEntry);

    for (const listener of this.proactiveListeners) {
      await listener(notification);
    }
  }
}

function readStringProperty(
  value: unknown,
  propertyName: string,
): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const property = Reflect.get(value, propertyName);

  return typeof property === 'string' && property.length > 0 ? property : null;
}

function formatProactiveNotification(
  notification: ProactiveNotification,
): string {
  const title = notification.title.trim();
  const body = notification.body.trim();

  if (title.length === 0) {
    return body;
  }

  if (body.length === 0) {
    return `[Proactive] ${title}`;
  }

  return `[Proactive] ${title}\n${body}`;
}
