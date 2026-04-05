const GREETING_PATTERNS = [
  /\bhello\b/iu,
  /\bhi\b/iu,
  /\bhey\b/iu,
  /\bgood morning\b/iu,
  /\bgood afternoon\b/iu,
  /\bgood evening\b/iu,
];

const QUESTION_PATTERNS = [
  /[?]\s*$/u,
  /^(?:what|why|how|when|where|who|which)\b/iu,
  /^(?:can|could|would|will|do|does|did|is|are|am|should)\b/iu,
];

const COMPLEX_REQUEST_PATTERNS = [
  /\b(?:compare|analyze|debug|investigate|explain|summarize|design|plan|build|implement|review|refactor)\b/iu,
  /\b(?:step by step|in detail|walk me through|trade-?offs|pros and cons)\b/iu,
];

const GREETING_REPLIES = [
  'Hey.',
  'Hello.',
  'Morning.',
  'Hi there.',
];

const QUESTION_FILLERS = [
  'Hmm...',
  'Mm...',
  'Let me see...',
  'One second...',
];

const COMPLEX_FILLERS = [
  'Let me think about that...',
  'Okay, let me work through that...',
  'All right, give me a second...',
  'Let me sort that out...',
];

const DEFAULT_FILLERS = [
  'Okay...',
  'Right...',
  'Just a moment...',
  'Let me check...',
];

let lastThinkingSound: string | undefined;

export function getThinkingSound(input: string): string {
  const normalizedInput = normalizeInput(input);

  if (normalizedInput.length === 0) {
    return pickVariant(DEFAULT_FILLERS);
  }

  if (isShortGreeting(normalizedInput)) {
    return pickVariant(GREETING_REPLIES);
  }

  if (isComplexRequest(normalizedInput)) {
    return pickVariant(COMPLEX_FILLERS);
  }

  if (isQuestion(normalizedInput)) {
    return pickVariant(QUESTION_FILLERS);
  }

  return pickVariant(DEFAULT_FILLERS);
}

function normalizeInput(input: string): string {
  return input
    .replace(/\s+/gu, ' ')
    .trim();
}

function isShortGreeting(input: string): boolean {
  if (input.length > 40) {
    return false;
  }

  return GREETING_PATTERNS.some((pattern) => pattern.test(input));
}

function isQuestion(input: string): boolean {
  return QUESTION_PATTERNS.some((pattern) => pattern.test(input));
}

function isComplexRequest(input: string): boolean {
  const wordCount = input.split(/\s+/u).filter((part) => part.length > 0).length;

  if (wordCount >= 14) {
    return true;
  }

  if (input.includes(',') || input.includes(':')) {
    return true;
  }

  return COMPLEX_REQUEST_PATTERNS.some((pattern) => pattern.test(input));
}

function pickVariant(candidates: readonly string[]): string {
  const fallbackCandidate = candidates[0];

  if (fallbackCandidate === undefined) {
    throw new Error('Thinking sound candidates must not be empty');
  }

  const availableCandidates =
    candidates.length > 1 && lastThinkingSound !== undefined
      ? candidates.filter((candidate) => candidate !== lastThinkingSound)
      : [...candidates];
  const selected =
    availableCandidates[
      Math.floor(Math.random() * availableCandidates.length)
    ] ?? fallbackCandidate;

  lastThinkingSound = selected;

  return selected;
}
