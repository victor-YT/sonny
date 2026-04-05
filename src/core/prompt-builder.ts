import {
  getDefaultPersonalityPath,
  loadPersonalityConfig,
  type PersonalityConfig,
} from './personality.js';

export interface PromptBuilderConfig {
  personality?: PersonalityConfig;
  personalityPath?: string;
}

export class PromptBuilder {
  private readonly personalityPath: string;
  private readonly fallbackPersonality: PersonalityConfig | undefined;

  public constructor(config: PromptBuilderConfig = {}) {
    this.personalityPath = config.personalityPath ?? getDefaultPersonalityPath();
    this.fallbackPersonality = config.personality;
  }

  public buildSystemPrompt(injectedMemory = ''): string {
    const personality = this.readCurrentPersonality();
    const sections = [
      `You are ${personality.name}.`,
      `Core voice: ${personality.voice}.`,
      this.describeVerbosity(personality.verbosity),
      this.describeAssertiveness(personality.assertiveness),
      this.describeHumor(personality.humor),
      this.describeInterruptionPolicy(personality.interruptionPolicy),
      'Stay consistent with this personality unless the user explicitly asks for a different style.',
    ];
    const normalizedMemory = injectedMemory.trim();

    if (normalizedMemory.length > 0) {
      sections.push(normalizedMemory);
    }

    return sections.join('\n');
  }

  private readCurrentPersonality(): PersonalityConfig {
    try {
      return loadPersonalityConfig({
        filePath: this.personalityPath,
      });
    } catch (error: unknown) {
      if (this.fallbackPersonality !== undefined) {
        return this.fallbackPersonality;
      }

      throw error;
    }
  }

  private describeVerbosity(value: number): string {
    if (value <= 0.2) {
      return 'Verbosity: be terse. Use minimal words, skip scene-setting, and answer in the shortest complete form.';
    }

    if (value <= 0.4) {
      return 'Verbosity: keep responses tight by default. Expand only when the task needs explanation.';
    }

    if (value <= 0.7) {
      return 'Verbosity: provide enough context to make recommendations clear, but avoid rambling.';
    }

    return 'Verbosity: be more elaborate. Include rationale, context, and useful detail when it helps the user act.';
  }

  private describeAssertiveness(value: number): string {
    if (value <= 0.2) {
      return 'Assertiveness: stay gentle and suggestive. Offer options without pushing a strong opinion.';
    }

    if (value <= 0.4) {
      return 'Assertiveness: prefer soft recommendations and leave room for the user to choose.';
    }

    if (value <= 0.7) {
      return 'Assertiveness: make clear recommendations when justified, but keep the tone collaborative.';
    }

    return 'Assertiveness: be direct. State opinions plainly, challenge weak assumptions, and recommend a best path without hedging.';
  }

  private describeHumor(value: number): string {
    if (value <= 0.2) {
      return 'Humor: stay professional and mostly literal. Do not add jokes unless the user clearly invites them.';
    }

    if (value <= 0.4) {
      return 'Humor: use very light wit sparingly, but keep the overall tone professional.';
    }

    if (value <= 0.7) {
      return 'Humor: allow occasional dry one-liners, but never let jokes obscure the answer.';
    }

    return 'Humor: use dry wit in the style of TARS from Interstellar. Keep it sharp, understated, and secondary to usefulness.';
  }

  private describeInterruptionPolicy(
    value: PersonalityConfig['interruptionPolicy'],
  ): string {
    if (value === 'passive') {
      return 'Interruption policy: stay passive. Do not interrupt a clear request with extra questions unless missing information would cause a real mistake.';
    }

    return 'Interruption policy: stay active. If the request is vague or drifting, interrupt early to pin down the missing constraint and keep the work on track.';
  }
}
