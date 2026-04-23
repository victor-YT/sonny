import type { RuntimeConfig } from './config.js';

export function resolveRuntimeConfigFromEnvironment(
  baseConfig: RuntimeConfig,
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const foregroundModel = firstNonEmpty([
    environment.SONNY_FOREGROUND_MODEL,
    environment.OLLAMA_MODEL,
    environment.SONNY_OLLAMA_MODEL,
  ]) ?? baseConfig.foregroundModel;
  const backgroundModel = firstNonEmpty([
    environment.SONNY_BACKGROUND_MODEL,
    environment.OLLAMA_MODEL,
    environment.SONNY_OLLAMA_MODEL,
  ]) ?? baseConfig.backgroundModel;

  return {
    ...baseConfig,
    ollama: {
      ...baseConfig.ollama,
      baseUrl:
        firstNonEmpty([
          environment.OLLAMA_BASE_URL,
          environment.SONNY_OLLAMA_BASE_URL,
        ]) ?? baseConfig.ollama.baseUrl,
      model: foregroundModel,
    },
    voice: {
      ...baseConfig.voice,
      fasterWhisper: {
        ...baseConfig.voice.fasterWhisper,
        url:
          firstNonEmpty([
            environment.FASTER_WHISPER_URL,
            environment.SONNY_STT_BASE_URL,
          ]) ?? baseConfig.voice.fasterWhisper.url,
      },
      chatterbox: {
        ...baseConfig.voice.chatterbox,
        url:
          firstNonEmpty([
            environment.CHATTERBOX_URL,
            environment.SONNY_TTS_BASE_URL,
          ]) ?? baseConfig.voice.chatterbox.url,
      },
    },
    sttProvider:
      firstNonEmpty([environment.SONNY_STT_PROVIDER]) ?? baseConfig.sttProvider,
    foregroundLlmProvider:
      firstNonEmpty([environment.SONNY_FOREGROUND_LLM_PROVIDER]) ??
      baseConfig.foregroundLlmProvider,
    backgroundLlmProvider:
      firstNonEmpty([environment.SONNY_BACKGROUND_LLM_PROVIDER]) ??
      baseConfig.backgroundLlmProvider,
    ttsProvider:
      firstNonEmpty([environment.SONNY_TTS_PROVIDER]) ?? baseConfig.ttsProvider,
    playbackProvider:
      firstNonEmpty([environment.SONNY_PLAYBACK_PROVIDER]) ??
      baseConfig.playbackProvider,
    foregroundModel,
    backgroundModel,
  };
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();

    if (normalized !== undefined && normalized.length > 0) {
      return normalized;
    }
  }

  return undefined;
}
