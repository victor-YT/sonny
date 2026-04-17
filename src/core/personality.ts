import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { DEFAULT_PERSONALITY_PATH } from './paths.js';

export type InterruptionPolicy = 'passive' | 'active';

export interface PersonalityConfig {
  name: string;
  voice: string;
  verbosity: number;
  assertiveness: number;
  humor: number;
  interruptionPolicy: InterruptionPolicy;
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

export interface PersonalityUpdate {
  name?: string;
  voice?: string;
  verbosity?: number;
  assertiveness?: number;
  humor?: number;
  interruptionPolicy?: InterruptionPolicy;
}

export function loadPersonalityConfig(
  config: PersonalityLoaderConfig = {},
): PersonalityConfig {
  const filePath = config.filePath ?? DEFAULT_PERSONALITY_PATH;
  const rawConfig = readPersonalityFile(filePath);

  return parsePersonalityConfig(rawConfig);
}

export async function savePersonalityConfig(
  update: PersonalityUpdate | PersonalityConfig,
  config: PersonalityLoaderConfig = {},
): Promise<PersonalityConfig> {
  const filePath = config.filePath ?? DEFAULT_PERSONALITY_PATH;
  const current = loadPersonalityConfig({ filePath });
  const next = parsePersonalityUpdate(update, current);

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(toPersonalityFile(next), null, 2)}\n`, 'utf8');

  return next;
}

export function getDefaultPersonalityPath(): string {
  return DEFAULT_PERSONALITY_PATH;
}

export function parsePersonalityUpdate(
  value: unknown,
  current?: PersonalityConfig,
): PersonalityConfig {
  if (!isRecord(value)) {
    throw new Error('Personality update must be an object');
  }

  return {
    name: readRequiredString(
      value.name,
      'name',
      current?.name,
    ),
    voice: readRequiredString(
      value.voice,
      'voice',
      current?.voice,
    ),
    verbosity: readUnitInterval(
      value.verbosity,
      'verbosity',
      current?.verbosity,
    ),
    assertiveness: readUnitInterval(
      value.assertiveness,
      'assertiveness',
      current?.assertiveness,
    ),
    humor: readUnitInterval(
      value.humor,
      'humor',
      current?.humor,
    ),
    interruptionPolicy: readInterruptionPolicy(
      value.interruptionPolicy ?? value.interruption_policy,
      current?.interruptionPolicy,
    ),
  };
}

function parsePersonalityConfig(value: unknown): PersonalityConfig {
  if (!isRecord(value)) {
    throw new Error('Personality config must be a JSON object');
  }

  return parsePersonalityUpdate(value);
}

function toPersonalityFile(config: PersonalityConfig): Record<string, unknown> {
  return {
    name: config.name,
    voice: config.voice,
    verbosity: config.verbosity,
    assertiveness: config.assertiveness,
    humor: config.humor,
    interruption_policy: config.interruptionPolicy,
  };
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

  return parsed as PersonalityFile;
}

function readRequiredString(
  value: unknown,
  fieldName: string,
  fallback?: string,
): string {
  const candidate = value ?? fallback;

  if (typeof candidate !== 'string') {
    throw new Error(`Personality config field "${fieldName}" must be a string`);
  }

  const trimmedValue = candidate.trim();

  if (trimmedValue.length === 0) {
    throw new Error(`Personality config field "${fieldName}" cannot be empty`);
  }

  return trimmedValue;
}

function readUnitInterval(
  value: unknown,
  fieldName: string,
  fallback?: number,
): number {
  const candidate = value ?? fallback;

  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new Error(
      `Personality config field "${fieldName}" must be a number between 0 and 1`,
    );
  }

  if (candidate < 0 || candidate > 1) {
    throw new Error(
      `Personality config field "${fieldName}" must be between 0 and 1`,
    );
  }

  return candidate;
}

function readInterruptionPolicy(
  value: unknown,
  fallback?: InterruptionPolicy,
): InterruptionPolicy {
  const candidate = value ?? fallback;

  if (candidate === 'passive' || candidate === 'active') {
    return candidate;
  }

  throw new Error(
    'Personality config field "interruption_policy" must be "passive" or "active"',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}
