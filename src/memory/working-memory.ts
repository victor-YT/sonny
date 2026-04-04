import {
  MemoryInjector,
  type MemoryInjectorConfig,
} from './memory-injector.js';

export class WorkingMemory {
  private readonly memoryInjector: MemoryInjector;

  public constructor(config: MemoryInjectorConfig) {
    this.memoryInjector = new MemoryInjector(config);
  }

  public async buildPrompt(
    baseSystemPrompt: string,
    userMessage: string,
  ): Promise<string> {
    return this.memoryInjector.composeSystemPrompt(baseSystemPrompt, userMessage);
  }
}

export { MemoryInjector, type MemoryInjectorConfig };
