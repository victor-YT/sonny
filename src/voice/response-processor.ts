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
    const plainText = this.normalizeVoicePronunciation(
      this.stripMarkdown(text),
    );
    const emotion = this.emotionTagger.analyze(plainText);
    const sentences = this.toProcessedSentences(plainText, emotion);

    return {
      originalText: text,
      plainText,
      taggedText: sentences.map((sentence) => sentence.taggedText).join(' ').trim(),
      emotion,
      sentences,
    };
  }

  public stripMarkdown(text: string): string {
    return this.normalizeWhitespace(
      text
      .replace(/```[\s\S]*?```/gu, ' [pause] ')
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/gu, '$1')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, '$1')
      .replace(/https?:\/\/\S+/gu, ' ')
      .replace(/`([^`]+)`/gu, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
      .replace(/^\s{0,3}>\s?/gmu, '')
      .replace(/^\s*[-*+]\s+/gmu, '')
      .replace(/^\s*\d+\.\s+/gmu, '')
      .replace(/^\s*[-*_]{3,}\s*$/gmu, ' ')
      .replace(/\*\*([^*]+)\*\*/gu, '$1')
      .replace(/__([^_]+)__/gu, '$1')
      .replace(/\*([^*]+)\*/gu, '$1')
      .replace(/_([^_]+)_/gu, '$1')
      .replace(/~~([^~]+)~~/gu, '$1')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\|/gu, ' ')
      .replace(/\s*:\s*\n/gu, ': ')
      .trim(),
    );
  }

  public splitIntoSentences(text: string): string[] {
    const normalized = this.normalizeWhitespace(
      text
      .replace(/\.{3,}/gu, ' [pause] ')
      .replace(/([:;])\s+/gu, '$1 [pause] '),
    );

    if (normalized.length === 0) {
      return [];
    }

    const matches = normalized.match(/[^.!?]+(?:[.!?]+|$)/gu) ?? [normalized];

    return matches
      .flatMap((sentence) => this.splitLongClauses(sentence))
      .map((sentence) => this.normalizeWhitespace(sentence))
      .filter((sentence) => sentence.length > 0);
  }

  public toStreamingTexts(text: string): string[] {
    const processed = this.process(text);

    return processed.sentences.map((sentence) => sentence.taggedText);
  }

  private toProcessedSentences(
    plainText: string,
    emotion: EmotionAnalysis,
  ): ProcessedVoiceSentence[] {
    return this.splitIntoSentences(plainText).map((sentence, index) => ({
      index,
      text: sentence,
      taggedText: this.injectTags(sentence, emotion, index),
      emotion: emotion.primary,
    }));
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
    if (
      emotion === 'hesitant' &&
      (index === 0 || this.containsHesitationCue(sentence))
    ) {
      return '[hesitation] ';
    }

    if (
      emotion === 'humorous' &&
      (index === 0 || this.containsHumorCue(sentence))
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

  private splitLongClauses(sentence: string): string[] {
    const normalized = sentence.trim();

    if (normalized.length <= 140) {
      return [normalized];
    }

    return normalized
      .split(/(?<=,)\s+|\s+-\s+/u)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  private containsHesitationCue(sentence: string): boolean {
    return /\b(?:maybe|perhaps|probably|i think|i guess|might|could)\b/iu.test(sentence);
  }

  private containsHumorCue(sentence: string): boolean {
    return /\b(?:funny|joke|ha|haha|lol|heh|ironically|classic)\b/iu.test(sentence);
  }

  private normalizeWhitespace(text: string): string {
    return text
      .replace(/\s+/gu, ' ')
      .replace(/\s+([,.;!?])/gu, '$1')
      .trim();
  }

  private normalizeVoicePronunciation(text: string): string {
    if (!/[\u3400-\u9fff]/u.test(text)) {
      return text;
    }

    return text.replace(/\bsonny\b/giu, '桑尼');
  }
}
