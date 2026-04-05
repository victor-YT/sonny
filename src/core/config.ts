import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { PermissionLevel } from '../skills/permissions.js';
import { ConfigValidationError, validateConfig } from './config-validator.js';

export type RuntimePlatform = NodeJS.Platform;

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
  maxTokens: number;
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
export const DEFAULT_RUNTIME_PLATFORM: RuntimePlatform = process.platform;

export function detectRuntimePlatform(
  platform: RuntimePlatform = DEFAULT_RUNTIME_PLATFORM,
): RuntimePlatform {
  return platform;
}

export function isWindowsPlatform(
  platform: RuntimePlatform = DEFAULT_RUNTIME_PLATFORM,
): boolean {
  return detectRuntimePlatform(platform) === 'win32';
}

export function isMacOSPlatform(
  platform: RuntimePlatform = DEFAULT_RUNTIME_PLATFORM,
): boolean {
  return detectRuntimePlatform(platform) === 'darwin';
}

export function isLinuxPlatform(
  platform: RuntimePlatform = DEFAULT_RUNTIME_PLATFORM,
): boolean {
  return detectRuntimePlatform(platform) === 'linux';
}

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

export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): RuntimeConfig {
  const rawConfig = loadConfigFile(configPath);

  try {
    return validateConfig(rawConfig);
  } catch (error: unknown) {
    if (error instanceof ConfigValidationError) {
      throw new Error(`Runtime config at ${configPath} is invalid.\n${error.message}`);
    }

    throw error;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}
