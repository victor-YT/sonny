export type VoiceEmotionTag =
  | 'neutral'
  | 'hesitant'
  | 'confident'
  | 'humorous'
  | 'assertive';

export interface EmotionAnalysis {
  primary: VoiceEmotionTag;
  scores: Record<VoiceEmotionTag, number>;
  exaggeration: number;
}

const MIN_EXAGGERATION = 0.25;
const MAX_EXAGGERATION = 2;

const HESITANT_PATTERNS = [
  /\bmaybe\b/giu,
  /\bperhaps\b/giu,
  /\bprobably\b/giu,
  /\blikely\b/giu,
  /\bi think\b/giu,
  /\bi guess\b/giu,
  /\bmight\b/giu,
  /\bcould\b/giu,
  /\bnot sure\b/giu,
  /\bseems\b/giu,
];

const CONFIDENT_PATTERNS = [
  /\bdefinitely\b/giu,
  /\bclearly\b/giu,
  /\bcertainly\b/giu,
  /\bexactly\b/giu,
  /\bwill\b/giu,
  /\bcan\b/giu,
  /\bthe answer is\b/giu,
  /\bhere is\b/giu,
  /\bthe fix is\b/giu,
];

const HUMOROUS_PATTERNS = [
  /\bfunny\b/giu,
  /\bjoke\b/giu,
  /\bjoking\b/giu,
  /\bironically\b/giu,
  /\bof course\b/giu,
  /\bneat trick\b/giu,
  /\bha(ha)+\b/giu,
  /\blol\b/giu,
];

const ASSERTIVE_PATTERNS = [
  /\bmust\b/giu,
  /\bneed to\b/giu,
  /\bdo this\b/giu,
  /\buse\b/giu,
  /\bavoid\b/giu,
  /\bstop\b/giu,
  /\bdon't\b/giu,
  /\bnever\b/giu,
  /\balways\b/giu,
];

export class EmotionTagger {
  public analyze(text: string): EmotionAnalysis {
    const normalized = text.trim();
    const scores = this.createBaseScores();

    if (normalized.length === 0) {
      return {
        primary: 'neutral',
        scores,
        exaggeration: 0.85,
      };
    }

    scores.hesitant += this.countPatternMatches(normalized, HESITANT_PATTERNS) * 1.15;
    scores.confident += this.countPatternMatches(normalized, CONFIDENT_PATTERNS) * 1.1;
    scores.humorous += this.countPatternMatches(normalized, HUMOROUS_PATTERNS) * 1.35;
    scores.assertive += this.countPatternMatches(normalized, ASSERTIVE_PATTERNS) * 1.2;
    scores.confident += this.countExclamationMarks(normalized) * 0.12;
    scores.hesitant += this.countEllipses(normalized) * 0.35;
    scores.humorous += this.countLaughter(normalized) * 1.4;

    const primary = this.selectPrimaryEmotion(scores);

    return {
      primary,
      scores,
      exaggeration: this.toExaggeration(primary, scores[primary]),
    };
  }

  private createBaseScores(): Record<VoiceEmotionTag, number> {
    return {
      neutral: 0.6,
      hesitant: 0,
      confident: 0,
      humorous: 0,
      assertive: 0,
    };
  }

  private countPatternMatches(text: string, patterns: RegExp[]): number {
    let count = 0;

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      const matches = text.match(pattern);

      if (matches !== null) {
        count += matches.length;
      }
    }

    return count;
  }

  private countExclamationMarks(text: string): number {
    return (text.match(/!/gu) ?? []).length;
  }

  private countEllipses(text: string): number {
    return (text.match(/\.{3,}/gu) ?? []).length;
  }

  private countLaughter(text: string): number {
    return (text.match(/\b(?:ha){2,}\b/giu) ?? []).length;
  }

  private selectPrimaryEmotion(
    scores: Record<VoiceEmotionTag, number>,
  ): VoiceEmotionTag {
    const ranked = (Object.entries(scores) as Array<[VoiceEmotionTag, number]>).sort(
      ([leftEmotion, leftScore], [rightEmotion, rightScore]) => {
        if (rightScore !== leftScore) {
          return rightScore - leftScore;
        }

        return this.getEmotionPriority(leftEmotion) - this.getEmotionPriority(rightEmotion);
      },
    );

    const topMatch = ranked[0];

    if (topMatch === undefined) {
      return 'neutral';
    }

    const [primaryEmotion, primaryScore] = topMatch;

    if (primaryScore <= scores.neutral) {
      return 'neutral';
    }

    return primaryEmotion;
  }

  private getEmotionPriority(emotion: VoiceEmotionTag): number {
    switch (emotion) {
      case 'humorous':
        return 0;
      case 'assertive':
        return 1;
      case 'confident':
        return 2;
      case 'hesitant':
        return 3;
      case 'neutral':
      default:
        return 4;
    }
  }

  private toExaggeration(
    emotion: VoiceEmotionTag,
    score: number,
  ): number {
    const base = this.getBaseExaggeration(emotion);
    const scaled = base + Math.min(score, 3) * 0.12;

    return Number(
      Math.min(MAX_EXAGGERATION, Math.max(MIN_EXAGGERATION, scaled)).toFixed(2),
    );
  }

  private getBaseExaggeration(emotion: VoiceEmotionTag): number {
    switch (emotion) {
      case 'hesitant':
        return 0.55;
      case 'confident':
        return 1.15;
      case 'humorous':
        return 1.5;
      case 'assertive':
        return 1.3;
      case 'neutral':
      default:
        return 0.85;
    }
  }
}
