import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { PermissionLevel } from '../skills/permissions.js';

export interface OllamaRuntimeConfig {
  baseUrl: string;
  model: string;
}

export interface FasterWhisperRuntimeConfig {
  url: string;
}

export interface ChatterboxRuntimeConfig {
  url: string;
}

export interface PorcupineRuntimeConfig {
  accessKey: string;
  wakeWord: string;
}

export interface VoiceRuntimeConfig {
  fasterWhisper: FasterWhisperRuntimeConfig;
  chatterbox: ChatterboxRuntimeConfig;
  porcupine: PorcupineRuntimeConfig;
}

export interface MemoryRuntimeConfig {
  retentionDays: number;
}

export interface SkillPermissionConfig {
  enabled: boolean;
  defaultLevel: PermissionLevel;
  maxLevel: PermissionLevel;
}

export interface SkillsRuntimeConfig {
  permissions: Record<string, SkillPermissionConfig>;
}

export interface RuntimeConfig {
  ollama: OllamaRuntimeConfig;
  voice: VoiceRuntimeConfig;
  memory: MemoryRuntimeConfig;
  skills: SkillsRuntimeConfig;
}

export const DEFAULT_CONFIG_PATH = resolve(process.cwd(), 'data', 'config.json');

export function loadConfigFile(configPath: string = DEFAULT_CONFIG_PATH): unknown {
  let fileContents: string;

  try {
    fileContents = readFileSync(configPath, 'utf8');
  } catch (error: unknown) {
    throw new Error(
      `Unable to read runtime config at ${configPath}: ${toErrorMessage(error)}`,
    );
  }

  try {
    return JSON.parse(fileContents) as unknown;
  } catch (error: unknown) {
    throw new Error(
      `Runtime config at ${configPath} is not valid JSON: ${toErrorMessage(error)}`,
    );
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}
