import {
  EmotionTagger,
  type EmotionAnalysis,
  type VoiceEmotionTag,
} from './emotion-tagger.js';

export interface ProcessedVoiceSentence {
  index: number;
  text: string;
  taggedText: string;
  emotion: VoiceEmotionTag;
}

export interface ProcessedVoiceResponse {
  originalText: string;
  plainText: string;
  taggedText: string;
  emotion: EmotionAnalysis;
  sentences: ProcessedVoiceSentence[];
}

export interface ResponseProcessorConfig {
  emotionTagger?: EmotionTagger;
}

export class ResponseProcessor {
  private readonly emotionTagger: EmotionTagger;

  public constructor(config: ResponseProcessorConfig = {}) {
    this.emotionTagger = config.emotionTagger ?? new EmotionTagger();
  }

  public process(text: string): ProcessedVoiceResponse {
    const plainText = this.stripMarkdown(text);
    const emotion = this.emotionTagger.analyze(plainText);
    const sentences = this.splitIntoSentences(plainText).map((sentence, index) => ({
      index,
      text: sentence,
      taggedText: this.injectTags(sentence, emotion, index),
      emotion: emotion.primary,
    }));

    return {
      originalText: text,
      plainText,
      taggedText: sentences.map((sentence) => sentence.taggedText).join(' ').trim(),
      emotion,
      sentences,
    };
  }

  public stripMarkdown(text: string): string {
    return text
      .replace(/```[\s\S]*?```/gu, ' [pause] ')
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/gu, '$1')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, '$1')
      .replace(/`([^`]+)`/gu, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
      .replace(/^\s{0,3}>\s?/gmu, '')
      .replace(/^\s*[-*+]\s+/gmu, '')
      .replace(/^\s*\d+\.\s+/gmu, '')
      .replace(/\*\*([^*]+)\*\*/gu, '$1')
      .replace(/__([^_]+)__/gu, '$1')
      .replace(/\*([^*]+)\*/gu, '$1')
      .replace(/_([^_]+)_/gu, '$1')
      .replace(/~~([^~]+)~~/gu, '$1')
      .replace(/\|/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
  }

  public splitIntoSentences(text: string): string[] {
    const normalized = text
      .replace(/\.{3,}/gu, ' [pause] ')
      .replace(/\s+/gu, ' ')
      .trim();

    if (normalized.length === 0) {
      return [];
    }

    const matches = normalized.match(/[^.!?]+(?:[.!?]+|$)/gu) ?? [];

    return matches
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0);
  }

  private injectTags(
    sentence: string,
    emotion: EmotionAnalysis,
    index: number,
  ): string {
    const prefix = this.buildPrefix(emotion.primary, sentence, index);
    const suffixedSentence = this.withPauseCue(sentence, index);

    return `${prefix}${suffixedSentence}`.trim();
  }

  private buildPrefix(
    emotion: VoiceEmotionTag,
    sentence: string,
    index: number,
  ): string {
    if (emotion === 'hesitant' && index === 0) {
      return '[hesitation] ';
    }

    if (
      emotion === 'humorous' &&
      (index === 0 || /\b(?:funny|joke|ha|haha|ironically)\b/iu.test(sentence))
    ) {
      return '[laugh] ';
    }

    if (
      (emotion === 'confident' || emotion === 'assertive') &&
      index > 0
    ) {
      return '[pause] ';
    }

    return '';
  }

  private withPauseCue(sentence: string, index: number): string {
    const normalized = sentence.replace(/\s*\[pause\]\s*/gu, ' [pause] ').trim();

    if (normalized.includes('[pause]')) {
      return normalized;
    }

    if (index === 0) {
      return normalized;
    }

    return `[pause] ${normalized}`;
  }
}
