import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { PermissionLevel } from '../skills/permissions.js';
import { ConfigValidationError, validateConfig } from './config-validator.js';
import { DEFAULT_CONFIG_PATH } from './paths.js';

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
  url?: string;
  accessKey?: string;
  wakeWord: string;
  wakeWords: string[];
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
  sttProvider: string;
  foregroundLlmProvider: string;
  backgroundLlmProvider: string;
  ttsProvider: string;
  playbackProvider: string;
  foregroundModel: string;
  backgroundModel: string;
}

export interface RuntimeConfigUpdate {
  ollama?: Partial<OllamaRuntimeConfig>;
  voice?: {
    fasterWhisper?: Partial<FasterWhisperRuntimeConfig>;
    chatterbox?: Partial<ChatterboxRuntimeConfig>;
    porcupine?: Partial<PorcupineRuntimeConfig>;
  };
  memory?: Partial<MemoryRuntimeConfig>;
  sttProvider?: string;
  foregroundLlmProvider?: string;
  backgroundLlmProvider?: string;
  ttsProvider?: string;
  playbackProvider?: string;
  foregroundModel?: string;
  backgroundModel?: string;
}

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

export async function updateConfig(
  update: RuntimeConfigUpdate,
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<RuntimeConfig> {
  const current = loadConfigFile(configPath);

  if (!isRecord(current)) {
    throw new Error(`Runtime config at ${configPath} must be a JSON object.`);
  }

  const next = applyRuntimeConfigUpdate(current, update);
  const validated = validateConfig(next);

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

  return validated;
}

export function getDefaultConfigPath(): string {
  return DEFAULT_CONFIG_PATH;
}

function applyRuntimeConfigUpdate(
  current: Record<string, unknown>,
  update: RuntimeConfigUpdate,
): Record<string, unknown> {
  const voice = isRecord(current.voice) ? current.voice : {};
  const fasterWhisper = isRecord(voice.fasterWhisper) ? voice.fasterWhisper : {};
  const chatterbox = isRecord(voice.chatterbox) ? voice.chatterbox : {};
  const porcupine = isRecord(voice.porcupine) ? voice.porcupine : {};
  const ollama = isRecord(current.ollama) ? current.ollama : {};
  const memory = isRecord(current.memory) ? current.memory : {};

  return {
    ...current,
    ollama: {
      ...ollama,
      ...update.ollama,
    },
    voice: {
      ...voice,
      fasterWhisper: {
        ...fasterWhisper,
        ...update.voice?.fasterWhisper,
      },
      chatterbox: {
        ...chatterbox,
        ...update.voice?.chatterbox,
      },
      porcupine: {
        ...porcupine,
        ...update.voice?.porcupine,
      },
    },
    memory: {
      ...memory,
      ...update.memory,
    },
    sttProvider: update.sttProvider ?? current.sttProvider,
    foregroundLlmProvider:
      update.foregroundLlmProvider ?? current.foregroundLlmProvider,
    backgroundLlmProvider:
      update.backgroundLlmProvider ?? current.backgroundLlmProvider,
    ttsProvider: update.ttsProvider ?? current.ttsProvider,
    playbackProvider: update.playbackProvider ?? current.playbackProvider,
    foregroundModel: update.foregroundModel ?? current.foregroundModel,
    backgroundModel: update.backgroundModel ?? current.backgroundModel,
  };
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
