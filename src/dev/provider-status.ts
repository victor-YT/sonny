import { loadConfig } from '../core/config.js';
import { resolveRuntimeConfigFromEnvironment } from '../core/runtime-config-resolution.js';

async function main(): Promise<void> {
  const runtimeConfig = resolveRuntimeConfigFromEnvironment(loadConfig(), process.env);
  const olmxStatus = await checkHttpStatus(
    `${runtimeConfig.olmx.baseUrl.replace(/\/+$/u, '')}/v1/models`,
  );

  const lines = [
    `STT Provider: ${runtimeConfig.sttProvider}`,
    `Sherpa ONNX Model Dir: ${runtimeConfig.voice.sherpaOnnx.modelDir ?? 'not configured'}`,
    `Sherpa ONNX Model Type: ${runtimeConfig.voice.sherpaOnnx.modelType ?? 'auto'}`,
    `Sherpa ONNX Provider: ${runtimeConfig.voice.sherpaOnnx.provider ?? 'cpu'}`,
    `Sherpa ONNX Threads: ${String(runtimeConfig.voice.sherpaOnnx.numThreads ?? 2)}`,
    `Faster Whisper URL: ${runtimeConfig.voice.fasterWhisper.url}`,
    `Foreground LLM Provider: ${runtimeConfig.foregroundLlmProvider}`,
    `Background LLM Provider: ${runtimeConfig.backgroundLlmProvider}`,
    `OLMX Base URL: ${runtimeConfig.olmx.baseUrl}`,
    `OLMX Configured: ${runtimeConfig.olmx.baseUrl.trim().length > 0 ? 'yes' : 'missing URL'}`,
    `OLMX Reachable: ${olmxStatus.reachable ? 'yes' : `no (${olmxStatus.reason})`}`,
    `OLMX Selected Foreground Model: ${runtimeConfig.foregroundModel}`,
    `TTS Provider: ${runtimeConfig.ttsProvider}`,
    `Playback Provider: ${runtimeConfig.playbackProvider}`,
    `Foreground Model: ${runtimeConfig.foregroundModel}`,
    `Background Model: ${runtimeConfig.backgroundModel}`,
    `Ollama Base URL: ${runtimeConfig.ollama.baseUrl}`,
  ];

  process.stdout.write('Sonny Provider Resolution\n');

  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

async function checkHttpStatus(
  url: string,
): Promise<{ reachable: boolean; reason: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });

    return {
      reachable: response.ok,
      reason: `${response.status} ${response.statusText}`,
    };
  } catch (error: unknown) {
    return {
      reachable: false,
      reason: error instanceof Error ? error.message : 'Unknown error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown provider status failure';

  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
