import { loadConfig } from '../core/config.js';
import { resolveRuntimeConfigFromEnvironment } from '../core/runtime-config-resolution.js';

function main(): void {
  const runtimeConfig = resolveRuntimeConfigFromEnvironment(loadConfig(), process.env);

  const lines = [
    `STT Provider: ${runtimeConfig.sttProvider}`,
    `Sherpa ONNX Model Dir: ${runtimeConfig.voice.sherpaOnnx.modelDir ?? 'not configured'}`,
    `Sherpa ONNX Model Type: ${runtimeConfig.voice.sherpaOnnx.modelType ?? 'auto'}`,
    `Sherpa ONNX Provider: ${runtimeConfig.voice.sherpaOnnx.provider ?? 'cpu'}`,
    `Sherpa ONNX Threads: ${String(runtimeConfig.voice.sherpaOnnx.numThreads ?? 2)}`,
    `Faster Whisper URL: ${runtimeConfig.voice.fasterWhisper.url}`,
    `Foreground LLM Provider: ${runtimeConfig.foregroundLlmProvider}`,
    `Background LLM Provider: ${runtimeConfig.backgroundLlmProvider}`,
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

main();
