import { resolve } from 'node:path';

const PROJECT_ROOT = process.cwd();

export const DEFAULT_CONFIG_DIRECTORY = resolve(PROJECT_ROOT, 'config');
export const DEFAULT_LOCAL_DIRECTORY = resolve(PROJECT_ROOT, '.local');
export const DEFAULT_MEMORY_DIRECTORY = resolve(DEFAULT_LOCAL_DIRECTORY, 'memory');

export const DEFAULT_CONFIG_PATH = resolve(DEFAULT_CONFIG_DIRECTORY, 'config.json');
export const DEFAULT_PERSONALITY_PATH = resolve(
  DEFAULT_CONFIG_DIRECTORY,
  'personality.json',
);
export const DEFAULT_SCHEDULES_PATH = resolve(DEFAULT_CONFIG_DIRECTORY, 'schedules.json');
export const DEFAULT_MONITOR_REGISTRY_PATH = resolve(
  DEFAULT_LOCAL_DIRECTORY,
  'monitors.json',
);
export const DEFAULT_CONVERSATION_HISTORY_PATH = resolve(
  DEFAULT_MEMORY_DIRECTORY,
  'conversations.json',
);
export const DEFAULT_RECENT_MEMORY_PATH = resolve(
  DEFAULT_MEMORY_DIRECTORY,
  'recent.json',
);
