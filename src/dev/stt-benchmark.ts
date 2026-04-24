import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  loadConfig,
  type RuntimeConfig,
} from '../core/config.js';
import { resolveRuntimeConfigFromEnvironment } from '../core/runtime-config-resolution.js';
import { createConfiguredSttProvider } from '../voice/providers/provider-registry.js';
import type { SttResult } from '../voice/providers/stt.js';

const DEFAULT_SAMPLE_AUDIO_CANDIDATES = [
  process.env.SONNY_SAMPLE_AUDIO_PATH,
  join(process.cwd(), 'test-sonny.wav'),
  join(process.cwd(), 'test-mic.wav'),
  join(process.cwd(), '.local', 'debug-audio', 'sample.wav'),
].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

interface BenchmarkResult {
  providerId: string;
  ok: boolean;
  transcript: string | null;
  firstPartialMs: number | null;
  finalTranscriptMs: number | null;
  totalMs: number | null;
  partialCount: number;
  error: string | null;
}

async function main(): Promise<void> {
  const filePath = parseFileArgument(process.argv.slice(2)) ?? await resolveSampleAudioPath();
  await assertFileExists(filePath);
  const audio = await readFile(filePath);
  const wave = parsePcm16Wave(audio);
  const runtimeConfig = resolveRuntimeConfigFromEnvironment(loadConfig(), process.env);
  const providerIds = parseProviderIds(process.argv.slice(2));

  process.stdout.write('Sonny STT Benchmark\n');
  process.stdout.write(`Input File: ${filePath}\n`);
  process.stdout.write(`Audio: ${wave.sampleRate}Hz ${wave.channels}ch ${wave.pcm.byteLength} bytes PCM16\n`);

  for (const providerId of providerIds) {
    const result = await benchmarkProvider(providerId, runtimeConfig, wave);
    process.stdout.write(`\nProvider: ${result.providerId}\n`);
    process.stdout.write(`OK: ${String(result.ok)}\n`);
    process.stdout.write(`First Partial: ${formatMs(result.firstPartialMs)}\n`);
    process.stdout.write(`Final Transcript: ${formatMs(result.finalTranscriptMs)}\n`);
    process.stdout.write(`Total STT: ${formatMs(result.totalMs)}\n`);
    process.stdout.write(`Partial Count: ${result.partialCount}\n`);
    process.stdout.write(`Transcript: ${result.transcript ?? 'none'}\n`);

    if (result.error !== null) {
      process.stdout.write(`Error: ${result.error}\n`);
    }
  }
}

async function assertFileExists(filePath: string): Promise<void> {
  try {
    await stat(filePath);
  } catch {
    throw new Error(`Benchmark input file does not exist: ${filePath}`);
  }
}

async function benchmarkProvider(
  providerId: string,
  runtimeConfig: RuntimeConfig,
  wave: { pcm: Buffer; sampleRate: number; channels: number },
): Promise<BenchmarkResult> {
  const startedAt = Date.now();
  let firstPartialAt: number | null = null;
  let finalAt: number | null = null;
  let latest: SttResult | null = null;
  let partialCount = 0;

  try {
    const provider = createConfiguredSttProvider({
      ...runtimeConfig,
      sttProvider: providerId,
    });
    const streamTranscribe = provider.transcribeStream ?? provider.streamTranscribe;

    if (provider.supportsStreaming && streamTranscribe !== undefined) {
      for await (const result of streamTranscribe.call(
        provider,
        createPcmChunkStream(wave.pcm),
        {
          sampleRateHertz: wave.sampleRate,
          channels: wave.channels,
          encoding: 'pcm_s16le',
        },
      )) {
        latest = result;
        partialCount += 1;

        if (firstPartialAt === null) {
          firstPartialAt = Date.now();
        }
      }
    } else {
      latest = await provider.transcribe(wave.pcm, {
        sampleRateHertz: wave.sampleRate,
        channels: wave.channels,
        encoding: 'pcm_s16le',
      });
    }

    finalAt = Date.now();
    const debug = provider.getLastDebugInfo?.() ?? null;

    return {
      providerId,
      ok: true,
      transcript: latest?.text ?? null,
      firstPartialMs:
        debug?.firstPartialLatencyMs ??
        (firstPartialAt === null ? null : firstPartialAt - startedAt),
      finalTranscriptMs:
        debug?.finalTranscriptLatencyMs ??
        (finalAt === null ? null : finalAt - startedAt),
      totalMs: debug?.totalLatencyMs ?? (finalAt === null ? null : finalAt - startedAt),
      partialCount: debug?.partialCount ?? partialCount,
      error: null,
    };
  } catch (error: unknown) {
    const now = Date.now();

    return {
      providerId,
      ok: false,
      transcript: latest?.text ?? null,
      firstPartialMs: firstPartialAt === null ? null : firstPartialAt - startedAt,
      finalTranscriptMs: finalAt === null ? null : finalAt - startedAt,
      totalMs: now - startedAt,
      partialCount,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function* createPcmChunkStream(pcm: Buffer): AsyncIterable<Buffer> {
  const chunkBytes = 3_200;

  for (let offset = 0; offset < pcm.byteLength; offset += chunkBytes) {
    yield pcm.subarray(offset, Math.min(pcm.byteLength, offset + chunkBytes));
  }
}

function parsePcm16Wave(audio: Buffer): {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
} {
  if (
    audio.byteLength < 44 ||
    audio.toString('ascii', 0, 4) !== 'RIFF' ||
    audio.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('Benchmark input must be a PCM WAV file.');
  }

  let offset = 12;
  let sampleRate = 16_000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= audio.byteLength) {
    const chunkId = audio.toString('ascii', offset, offset + 4);
    const chunkSize = audio.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ') {
      channels = audio.readUInt16LE(chunkStart + 2);
      sampleRate = audio.readUInt32LE(chunkStart + 4);
      bitsPerSample = audio.readUInt16LE(chunkStart + 14);
    } else if (chunkId === 'data') {
      dataOffset = chunkStart;
      dataSize = chunkSize;
      break;
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || bitsPerSample !== 16) {
    throw new Error('Benchmark input must be a PCM16 WAV file.');
  }

  return {
    pcm: audio.subarray(dataOffset, Math.min(audio.byteLength, dataOffset + dataSize)),
    sampleRate,
    channels,
  };
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

function parseProviderIds(argv: string[]): string[] {
  const providerFlagIndex = argv.indexOf('--providers');
  const providerValue = providerFlagIndex >= 0 ? argv[providerFlagIndex + 1] : undefined;

  return (providerValue ?? 'sherpa-onnx,faster-whisper')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function formatMs(value: number | null): string {
  return value === null ? 'unknown' : `${value}ms`;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
