import { PERMISSION_LEVELS, type PermissionLevel } from '../skills/permissions.js';
import type {
  RuntimeConfig,
  SkillPermissionConfig,
} from './config.js';

const PERMISSION_ORDER: Record<PermissionLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export class ConfigValidationError extends Error {
  public readonly issues: string[];

  public constructor(issues: string[]) {
    super(buildMessage(issues));
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

export function validateConfig(value: unknown): RuntimeConfig {
  const issues: string[] = [];
  const root = expectRecord(value, 'config', issues);
  const ollama = expectNestedRecord(root, 'config.ollama', issues, 'ollama');
  const olmx = readOptionalRecord(root, 'config.olmx', issues, 'olmx');
  const voice = expectNestedRecord(root, 'config.voice', issues, 'voice');
  const fasterWhisper = expectNestedRecord(
    voice,
    'config.voice.fasterWhisper',
    issues,
    'fasterWhisper',
  );
  const sherpaOnnx = readOptionalRecord(
    voice,
    'config.voice.sherpaOnnx',
    issues,
    'sherpaOnnx',
  );
  const chatterbox = expectNestedRecord(
    voice,
    'config.voice.chatterbox',
    issues,
    'chatterbox',
  );
  const porcupine = expectNestedRecord(
    voice,
    'config.voice.porcupine',
    issues,
    'porcupine',
  );
  const memory = expectNestedRecord(root, 'config.memory', issues, 'memory');
  const skills = expectNestedRecord(root, 'config.skills', issues, 'skills');

  const config: RuntimeConfig = {
    ollama: {
      baseUrl: readUrl(ollama, 'config.ollama.baseUrl', issues, 'baseUrl'),
      model: readString(ollama, 'config.ollama.model', issues, 'model'),
    },
    olmx: {
      baseUrl:
        readOptionalUrl(olmx, 'config.olmx.baseUrl', issues, 'baseUrl') ??
        'http://127.0.0.1:8000',
      model:
        readOptionalString(olmx, 'config.olmx.model', issues, 'model') ??
        'Qwen2.5-1.5B-Instruct-4bit',
    },
    voice: {
      fasterWhisper: {
        url: readUrl(fasterWhisper, 'config.voice.fasterWhisper.url', issues, 'url'),
      },
      sherpaOnnx: {
        modelDir: readOptionalString(
          sherpaOnnx,
          'config.voice.sherpaOnnx.modelDir',
          issues,
          'modelDir',
        ),
        encoder: readOptionalString(
          sherpaOnnx,
          'config.voice.sherpaOnnx.encoder',
          issues,
          'encoder',
        ),
        decoder: readOptionalString(
          sherpaOnnx,
          'config.voice.sherpaOnnx.decoder',
          issues,
          'decoder',
        ),
        joiner: readOptionalString(
          sherpaOnnx,
          'config.voice.sherpaOnnx.joiner',
          issues,
          'joiner',
        ),
        tokens: readOptionalString(
          sherpaOnnx,
          'config.voice.sherpaOnnx.tokens',
          issues,
          'tokens',
        ),
        language: readOptionalString(
          sherpaOnnx,
          'config.voice.sherpaOnnx.language',
          issues,
          'language',
        ),
        modelType: readOptionalSherpaModelType(sherpaOnnx, issues),
        provider: readOptionalString(
          sherpaOnnx,
          'config.voice.sherpaOnnx.provider',
          issues,
          'provider',
        ),
        numThreads: readOptionalPositiveInteger(
          sherpaOnnx,
          'config.voice.sherpaOnnx.numThreads',
          issues,
          'numThreads',
        ),
        decodingMethod: readOptionalString(
          sherpaOnnx,
          'config.voice.sherpaOnnx.decodingMethod',
          issues,
          'decodingMethod',
        ),
      },
      chatterbox: {
        url: readUrl(chatterbox, 'config.voice.chatterbox.url', issues, 'url'),
      },
      porcupine: readPorcupineConfig(porcupine, issues),
    },
    memory: {
      retentionDays: readPositiveInteger(
        memory,
        'config.memory.retentionDays',
        issues,
        'retentionDays',
      ),
      maxTokens:
        readOptionalPositiveInteger(
          memory,
          'config.memory.maxTokens',
          issues,
          'maxTokens',
        ) ?? 12_000,
    },
    skills: {
      permissions: readSkillPermissions(skills, issues),
    },
    sttProvider:
      readOptionalString(root, 'config.sttProvider', issues, 'sttProvider') ??
      'sherpa-onnx',
    foregroundLlmProvider:
      readOptionalString(
        root,
        'config.foregroundLlmProvider',
        issues,
        'foregroundLlmProvider',
      ) ?? 'olmx-foreground',
    backgroundLlmProvider:
      readOptionalString(
        root,
        'config.backgroundLlmProvider',
        issues,
        'backgroundLlmProvider',
      ) ?? 'ollama-background',
    ttsProvider:
      readOptionalString(root, 'config.ttsProvider', issues, 'ttsProvider') ??
      'qwen3-tts',
    playbackProvider:
      readOptionalString(
        root,
        'config.playbackProvider',
        issues,
        'playbackProvider',
      ) ?? 'system-player',
    foregroundModel:
      readOptionalString(root, 'config.foregroundModel', issues, 'foregroundModel') ??
      readOptionalString(olmx, 'config.olmx.model', issues, 'model') ??
      'Qwen2.5-1.5B-Instruct-4bit',
    backgroundModel:
      readOptionalString(root, 'config.backgroundModel', issues, 'backgroundModel') ??
      readString(ollama, 'config.ollama.model', issues, 'model'),
  };

  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }

  return config;
}

function readSkillPermissions(
  skills: Record<string, unknown> | undefined,
  issues: string[],
): Record<string, SkillPermissionConfig> {
  const permissionsRecord = expectNestedRecord(
    skills,
    'config.skills.permissions',
    issues,
    'permissions',
  );

  if (permissionsRecord === undefined) {
    return {};
  }

  const permissions: Record<string, SkillPermissionConfig> = {};

  for (const [toolName, value] of Object.entries(permissionsRecord)) {
    if (toolName.trim().length === 0) {
      issues.push('config.skills.permissions contains an empty tool name.');
      continue;
    }

    const permission = expectRecord(
      value,
      `config.skills.permissions.${toolName}`,
      issues,
    );

    if (permission === undefined) {
      continue;
    }

    const defaultLevel = readPermissionLevel(
      permission,
      `config.skills.permissions.${toolName}.defaultLevel`,
      issues,
      'defaultLevel',
    );
    const maxLevel = readPermissionLevel(
      permission,
      `config.skills.permissions.${toolName}.maxLevel`,
      issues,
      'maxLevel',
    );

    if (defaultLevel !== undefined && maxLevel !== undefined) {
      if (PERMISSION_ORDER[defaultLevel] > PERMISSION_ORDER[maxLevel]) {
        issues.push(
          `config.skills.permissions.${toolName} defaultLevel must not exceed maxLevel.`,
        );
      }
    }

    const enabled = readBoolean(
      permission,
      `config.skills.permissions.${toolName}.enabled`,
      issues,
      'enabled',
    );

    if (
      enabled !== undefined &&
      defaultLevel !== undefined &&
      maxLevel !== undefined
    ) {
      permissions[toolName] = {
        enabled,
        defaultLevel,
        maxLevel,
      };
    }
  }

  return permissions;
}

function readUrl(
  root: Record<string, unknown> | undefined,
  path: string,
  issues: string[],
  ...segments: string[]
): string {
  const value = readString(root, path, issues, ...segments);

  try {
    const url = new URL(value);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      issues.push(`${path} must use http:// or https://.`);
    }
  } catch {
    issues.push(`${path} must be a valid URL.`);
  }

  return value;
}

function readOptionalUrl(
  root: Record<string, unknown> | undefined,
  path: string,
  issues: string[],
  ...segments: string[]
): string | undefined {
  const value = readOptionalString(root, path, issues, ...segments);

  if (value === undefined) {
    return undefined;
  }

  try {
    const url = new URL(value);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      issues.push(`${path} must use http:// or https://.`);
    }
  } catch {
    issues.push(`${path} must be a valid URL.`);
  }

  return value;
}

function readOptionalStringArray(
  root: Record<string, unknown> | undefined,
  path: string,
  issues: string[],
  ...segments: string[]
): string[] | undefined {
  const value = readOptionalNestedValue(root, ...segments);

  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array of non-empty strings.`);
    return undefined;
  }

  const normalizedValues = value.flatMap((entry) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      issues.push(`${path} must contain only non-empty strings.`);
      return [];
    }

    return [entry.trim()];
  });

  if (normalizedValues.length === 0) {
    issues.push(`${path} must contain at least one wake word.`);
    return undefined;
  }

  return normalizedValues;
}

function readPositiveInteger(
  root: Record<string, unknown> | undefined,
  path: string,
  issues: string[],
  ...segments: string[]
): number {
  const value = readNestedValue(root, path, issues, ...segments);

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    issues.push(`${path} must be a positive integer.`);
    return 1;
  }

  return value;
}

function readOptionalPositiveInteger(
  root: Record<string, unknown> | undefined,
  path: string,
  issues: string[],
  ...segments: string[]
): number | undefined {
  const value = readOptionalNestedValue(root, ...segments);

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    issues.push(`${path} must be a positive integer when provided.`);
    return undefined;
  }

  return value;
}

function readOptionalSherpaModelType(
  root: Record<string, unknown> | undefined,
  issues: string[],
): RuntimeConfig['voice']['sherpaOnnx']['modelType'] {
  const value = readOptionalString(
    root,
    'config.voice.sherpaOnnx.modelType',
    issues,
    'modelType',
  );

  if (value === undefined) {
    return undefined;
  }

  if (value !== 'auto' && value !== 'transducer' && value !== 'paraformer') {
    issues.push('config.voice.sherpaOnnx.modelType must be auto, transducer, or paraformer.');
    return undefined;
  }

  return value;
}

function readPermissionLevel(
  root: Record<string, unknown> | undefined,
  path: string,
  issues: string[],
  ...segments: string[]
): PermissionLevel | undefined {
  const value = readNestedValue(root, path, issues, ...segments);

  if (typeof value !== 'string') {
    issues.push(`${path} must be one of: ${PERMISSION_LEVELS.join(', ')}.`);
    return undefined;
  }

  if (!PERMISSION_LEVELS.includes(value as PermissionLevel)) {
    issues.push(`${path} must be one of: ${PERMISSION_LEVELS.join(', ')}.`);
    return undefined;
  }

  return value as PermissionLevel;
}

function readBoolean(
  root: Record<string, unknown> | undefined,
  path: string,
  issues: string[],
  ...segments: string[]
): boolean | undefined {
  const value = readNestedValue(root, path, issues, ...segments);

  if (typeof value !== 'boolean') {
    issues.push(`${path} must be a boolean.`);
    return undefined;
  }

  return value;
}

function readString(
  root: Record<string, unknown> | undefined,
  path: string,
  issues: string[],
  ...segments: string[]
): string {
  const value = readNestedValue(root, path, issues, ...segments);

  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${path} must be a non-empty string.`);
    return '';
  }

  return value;
}

function readOptionalString(
  root: Record<string, unknown> | undefined,
  path: string,
  issues: string[],
  ...segments: string[]
): string | undefined {
  const value = readOptionalNestedValue(root, ...segments);

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${path} must be a non-empty string.`);
    return undefined;
  }

  return value.trim();
}

function readNestedValue(
  root: Record<string, unknown> | undefined,
  path: string,
  issues: string[],
  ...segments: string[]
): unknown {
  let current: unknown = root;

  for (const segment of segments) {
    if (!isRecord(current)) {
      issues.push(`${path} is required.`);
      return undefined;
    }

    current = current[segment];
  }

  if (current === undefined) {
    issues.push(`${path} is required.`);
  }

  return current;
}

function readOptionalNestedValue(
  root: Record<string, unknown> | undefined,
  ...segments: string[]
): unknown {
  let current: unknown = root;

  for (const segment of segments) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function readPorcupineConfig(
  porcupine: Record<string, unknown> | undefined,
  issues: string[],
): RuntimeConfig['voice']['porcupine'] {
  const wakeWords =
    readOptionalStringArray(
      porcupine,
      'config.voice.porcupine.wakeWords',
      issues,
      'wakeWords',
    ) ??
    (() => {
      const wakeWord = readOptionalString(
        porcupine,
        'config.voice.porcupine.wakeWord',
        issues,
        'wakeWord',
      );

      return wakeWord === undefined ? undefined : [wakeWord];
    })();

  if (wakeWords === undefined || wakeWords.length === 0) {
    issues.push(
      'config.voice.porcupine must provide wakeWord or wakeWords.',
    );
  }

  const wakeWord =
    readOptionalString(
      porcupine,
      'config.voice.porcupine.wakeWord',
      issues,
      'wakeWord',
    ) ??
    wakeWords?.[0] ??
    '';

  return {
    url: readOptionalUrl(
      porcupine,
      'config.voice.porcupine.url',
      issues,
      'url',
    ),
    accessKey: readOptionalString(
      porcupine,
      'config.voice.porcupine.accessKey',
      issues,
      'accessKey',
    ),
    wakeWord,
    wakeWords: wakeWords ?? [],
  };
}

function expectNestedRecord(
  root: Record<string, unknown> | undefined,
  path: string,
  issues: string[],
  ...segments: string[]
): Record<string, unknown> | undefined {
  const value = readNestedValue(root, path, issues, ...segments);

  return expectRecord(value, path, issues);
}

function readOptionalRecord(
  root: Record<string, unknown> | undefined,
  path: string,
  issues: string[],
  ...segments: string[]
): Record<string, unknown> | undefined {
  const value = readOptionalNestedValue(root, ...segments);

  if (value === undefined) {
    return undefined;
  }

  return expectRecord(value, path, issues);
}

function expectRecord(
  value: unknown,
  path: string,
  issues: string[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object.`);
    return undefined;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildMessage(issues: string[]): string {
  return `Runtime config validation failed:\n- ${issues.join('\n- ')}`;
}
