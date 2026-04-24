import type { RuntimeConfig } from '../config.js';
import type { LlmProvider } from './llm.js';
import { OlmxForegroundProvider } from './olmx.js';
import { OllamaProvider } from './ollama.js';
import { RoutedLlmProvider } from './routed-llm.js';

export interface LlmRegistryResolution {
  provider: LlmProvider;
  foregroundProviderId: string;
  backgroundProviderId: string;
}

export function createRoutedLlmProvider(
  runtimeConfig: RuntimeConfig,
): LlmRegistryResolution {
  const foregroundProvider = createLaneProvider(
    runtimeConfig.foregroundLlmProvider,
    runtimeConfig,
    runtimeConfig.foregroundModel,
  );
  const backgroundProvider = createLaneProvider(
    runtimeConfig.backgroundLlmProvider,
    runtimeConfig,
    runtimeConfig.backgroundModel,
  );

  return {
    provider: new RoutedLlmProvider({
      foreground: foregroundProvider,
      background: backgroundProvider,
    }),
    foregroundProviderId: foregroundProvider.providerId,
    backgroundProviderId: backgroundProvider.providerId,
  };
}

function createLaneProvider(
  providerId: string,
  runtimeConfig: RuntimeConfig,
  model: string,
): {
  providerId: string;
  provider: LlmProvider;
  model: string;
} {
  switch (providerId) {
    case 'olmx-foreground':
      return {
        providerId,
        provider: new OlmxForegroundProvider({
          baseUrl: runtimeConfig.olmx.baseUrl,
          model,
        }),
        model,
      };
    case 'ollama':
    case 'ollama-foreground':
    case 'ollama-background':
      return {
        providerId,
        provider: new OllamaProvider({
          baseUrl: runtimeConfig.ollama.baseUrl,
          model,
        }),
        model,
      };
    default:
      throw new Error(`Unsupported LLM provider "${providerId}".`);
  }
}
