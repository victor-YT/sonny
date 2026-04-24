const SUBPROCESS_DIAGNOSTIC_PATTERNS = [
  /bufio\.Reader could not be identified to support stdout\/stderr/i,
  /\bstdout\/stderr\b/i,
  /\bstderr\b.*\bstdout\b/i,
  /\bstdout\b.*\bstderr\b/i,
  /\bspawn\b.*\bENOENT\b/i,
  /\bexited with code\b/i,
];

export class AssistantOutputContaminationError extends Error {
  public readonly source: string;
  public readonly preview: string;

  public constructor(source: string, text: string) {
    const preview = previewText(text);

    super(`Blocked contaminated assistant output from ${source}: ${preview}`);
    this.name = 'AssistantOutputContaminationError';
    this.source = source;
    this.preview = preview;
  }
}

export function assertAssistantOutputIsSpeakable(
  text: string,
  source: string,
): void {
  if (isAssistantOutputContaminated(text)) {
    throw new AssistantOutputContaminationError(source, text);
  }
}

export function isAssistantOutputContaminated(text: string): boolean {
  const normalized = text.trim();

  if (normalized.length === 0) {
    return false;
  }

  return SUBPROCESS_DIAGNOSTIC_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

export function previewText(text: string, maxLength = 240): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
}
