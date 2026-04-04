import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_ENV_PATH = resolve(process.cwd(), '.env');

export interface StartupEnvironment {
  ollamaModel: string;
  ollamaBaseUrl: string;
  voiceMode: boolean;
  porcupineAccessKey?: string;
  fasterWhisperUrl?: string;
  chatterboxUrl?: string;
}

export class StartupCheckError extends Error {
  public readonly issues: string[];

  public constructor(issues: string[]) {
    super(buildMessage(issues));
    this.name = 'StartupCheckError';
    this.issues = issues;
  }
}

export function loadStartupEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  envPath: string = DEFAULT_ENV_PATH,
): StartupEnvironment {
  loadEnvFile(environment, envPath);

  const issues: string[] = [];
  const ollamaModel = readRequiredEnv(
    environment,
    ['OLLAMA_MODEL', 'SONNY_OLLAMA_MODEL'],
    'OLLAMA_MODEL',
    issues,
  );
  const ollamaBaseUrl = readRequiredUrl(
    environment,
    ['OLLAMA_BASE_URL', 'SONNY_OLLAMA_BASE_URL'],
    'OLLAMA_BASE_URL',
    issues,
  );
  const voiceMode = readRequiredBoolean(environment, 'SONNY_VOICE_MODE', issues);

  let porcupineAccessKey: string | undefined;
  let fasterWhisperUrl: string | undefined;
  let chatterboxUrl: string | undefined;

  if (voiceMode) {
    porcupineAccessKey = readRequiredEnv(
      environment,
      ['PORCUPINE_ACCESS_KEY', 'SONNY_PORCUPINE_ACCESS_KEY'],
      'PORCUPINE_ACCESS_KEY',
      issues,
    );
    fasterWhisperUrl = readRequiredUrl(
      environment,
      ['FASTER_WHISPER_URL', 'SONNY_STT_BASE_URL'],
      'FASTER_WHISPER_URL',
      issues,
    );
    chatterboxUrl = readRequiredUrl(
      environment,
      ['CHATTERBOX_URL', 'SONNY_TTS_BASE_URL'],
      'CHATTERBOX_URL',
      issues,
    );
  }

  if (issues.length > 0) {
    throw new StartupCheckError(issues);
  }

  return {
    ollamaModel,
    ollamaBaseUrl,
    voiceMode,
    porcupineAccessKey,
    fasterWhisperUrl,
    chatterboxUrl,
  };
}

function loadEnvFile(
  environment: NodeJS.ProcessEnv,
  envPath: string,
): void {
  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, 'utf8');

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }

    const normalizedLine = line.startsWith('export ')
      ? line.slice('export '.length).trim()
      : line;
    const separatorIndex = normalizedLine.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    const rawValue = normalizedLine.slice(separatorIndex + 1).trim();

    if (key.length === 0 || environment[key] !== undefined) {
      continue;
    }

    environment[key] = stripWrappingQuotes(rawValue);
  }
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith('\'') && value.endsWith('\''))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function readRequiredEnv(
  environment: NodeJS.ProcessEnv,
  keys: string[],
  label: string,
  issues: string[],
): string {
  for (const key of keys) {
    const value = environment[key]?.trim();

    if (value !== undefined && value.length > 0) {
      return value;
    }
  }

  issues.push(`${label} is required.`);

  return '';
}

function readRequiredUrl(
  environment: NodeJS.ProcessEnv,
  keys: string[],
  label: string,
  issues: string[],
): string {
  const value = readRequiredEnv(environment, keys, label, issues);

  if (value.length === 0) {
    return value;
  }

  try {
    const parsed = new URL(value);

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      issues.push(`${label} must use http:// or https://.`);
    }
  } catch {
    issues.push(`${label} must be a valid URL.`);
  }

  return value;
}

function readRequiredBoolean(
  environment: NodeJS.ProcessEnv,
  key: string,
  issues: string[],
): boolean {
  const rawValue = environment[key]?.trim().toLowerCase();

  if (rawValue === undefined || rawValue.length === 0) {
    issues.push(`${key} is required and must be set to 0, 1, false, or true.`);
    return false;
  }

  if (['1', 'true', 'yes', 'on'].includes(rawValue)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(rawValue)) {
    return false;
  }

  issues.push(`${key} must be set to 0, 1, false, or true.`);

  return false;
}

function buildMessage(issues: string[]): string {
  return [
    'Startup environment validation failed.',
    'Copy .env.example to .env and update the missing values:',
    ...issues.map((issue) => `- ${issue}`),
  ].join('\n');
}
