import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { loadConfig } from '../core/config.js';
import { resolveRuntimeConfigFromEnvironment } from '../core/runtime-config-resolution.js';
import { SherpaOnnxProvider } from '../voice/providers/sherpa-onnx.js';

const DEFAULT_SAMPLE_AUDIO_CANDIDATES = [
  process.env.SONNY_SAMPLE_AUDIO_PATH,
  join(process.cwd(), 'test-sonny.wav'),
  join(process.cwd(), 'test-mic.wav'),
  join(process.cwd(), '.local', 'debug-audio', 'sample.wav'),
].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

async function main(): Promise<void> {
  const filePath = parseFileArgument(process.argv.slice(2)) ?? await resolveSampleAudioPath();
  await assertFileExists(filePath);
  const runtimeConfig = resolveRuntimeConfigFromEnvironment(loadConfig(), process.env);
  const provider = new SherpaOnnxProvider(runtimeConfig.voice.sherpaOnnx);
  const audio = await readFile(filePath);
  const startedAt = Date.now();
  const result = await provider.transcribe(audio, {
    encoding: 'wav',
    language: runtimeConfig.voice.sherpaOnnx.language,
  });
  const elapsedMs = Date.now() - startedAt;
  const debug = provider.getLastDebugInfo();

  process.stdout.write('Sherpa ONNX STT Smoke Test\n');
  process.stdout.write(`Input File: ${filePath}\n`);
  process.stdout.write(`Transcript: ${result.text}\n`);
  process.stdout.write(`Transcript Length: ${result.text.length}\n`);
  process.stdout.write(`Elapsed: ${elapsedMs}ms\n`);
  process.stdout.write(`First Partial Latency: ${String(debug?.firstPartialLatencyMs ?? 'unknown')}ms\n`);
  process.stdout.write(`Final Transcript Latency: ${String(debug?.finalTranscriptLatencyMs ?? 'unknown')}ms\n`);
  process.stdout.write(`Partials Emitted: ${String(debug?.partialsEmitted ?? 'unknown')}\n`);
}

async function assertFileExists(filePath: string): Promise<void> {
  try {
    await stat(filePath);
  } catch {
    throw new Error(`Smoke test input file does not exist: ${filePath}`);
  }
}

async function resolveSampleAudioPath(): Promise<string> {
  for (const candidate of DEFAULT_SAMPLE_AUDIO_CANDIDATES) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(
    'No sample WAV file was found. Pass --file <path> or set SONNY_SAMPLE_AUDIO_PATH.',
  );
}

function parseFileArgument(argv: string[]): string | undefined {
  const envValue = process.env.npm_config_file;

  if (typeof envValue === 'string' && envValue.trim().length > 0) {
    return envValue.trim();
  }

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--file') {
      return argv[index + 1];
    }
  }

  return undefined;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
