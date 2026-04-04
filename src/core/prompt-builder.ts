import type { PersonalityConfig } from './personality.js';

export interface PromptBuilderConfig {
  personality: PersonalityConfig;
}

export class PromptBuilder {
  private readonly personality: PersonalityConfig;

  public constructor(config: PromptBuilderConfig) {
    this.personality = config.personality;
  }

  public buildSystemPrompt(injectedMemory = ''): string {
    const sections = [
      `You are ${this.personality.name}.`,
      `Voice: ${this.personality.voice}.`,
      `Verbosity: ${this.personality.verbosity}.`,
      `Assertiveness: ${this.personality.assertiveness}.`,
      `Humor: ${this.personality.humor}.`,
      `Interruption policy: ${this.personality.interruptionPolicy}.`,
      'Stay consistent with this personality unless the user explicitly asks for a different style.',
    ];
    const normalizedMemory = injectedMemory.trim();

    if (normalizedMemory.length > 0) {
      sections.push(normalizedMemory);
    }

    return sections.join('\n');
  }
}
