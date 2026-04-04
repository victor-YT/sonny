import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PersonalityConfig {
  name: string;
  voice: string;
  verbosity: string;
  assertiveness: string;
  humor: string;
  interruptionPolicy: string;
}

interface PersonalityFile {
  name?: unknown;
  voice?: unknown;
  verbosity?: unknown;
  assertiveness?: unknown;
  humor?: unknown;
  interruption_policy?: unknown;
}

export interface PersonalityLoaderConfig {
  filePath?: string;
}

const DEFAULT_PERSONALITY_PATH = join(process.cwd(), 'data', 'personality.json');

export function loadPersonalityConfig(
  config: PersonalityLoaderConfig = {},
): PersonalityConfig {
  const filePath = config.filePath ?? DEFAULT_PERSONALITY_PATH;
  const rawConfig = readPersonalityFile(filePath);

  return {
    name: readRequiredString(rawConfig.name, 'name'),
    voice: readRequiredString(rawConfig.voice, 'voice'),
    verbosity: readRequiredString(rawConfig.verbosity, 'verbosity'),
    assertiveness: readRequiredString(rawConfig.assertiveness, 'assertiveness'),
    humor: readRequiredString(rawConfig.humor, 'humor'),
    interruptionPolicy: readRequiredString(
      rawConfig.interruption_policy,
      'interruption_policy',
    ),
  };
}

export function getDefaultPersonalityPath(): string {
  return DEFAULT_PERSONALITY_PATH;
}

function readPersonalityFile(path: string): PersonalityFile {
  let content: string;

  try {
    content = readFileSync(path, 'utf8');
  } catch (error: unknown) {
    throw new Error(
      `Failed to read personality config at "${path}": ${toErrorMessage(error)}`,
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error: unknown) {
    throw new Error(
      `Failed to parse personality config at "${path}": ${toErrorMessage(error)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Personality config at "${path}" must be a JSON object`);
  }

  return parsed as PersonalityFile;
}

function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Personality config field "${fieldName}" must be a string`);
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw new Error(`Personality config field "${fieldName}" cannot be empty`);
  }

  return trimmedValue;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}
