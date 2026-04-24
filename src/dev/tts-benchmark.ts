import { loadConfig } from '../core/config.js';
import { resolveRuntimeConfigFromEnvironment } from '../core/runtime-config-resolution.js';
import { loadEnvFile } from '../core/startup-check.js';

interface StreamBenchmark {
  label: string;
  text: string;
  ok: boolean;
  status: number | null;
  headersMs: number | null;
  firstChunkMs: number | null;
  fullMs: number | null;
  chunkCount: number;
  totalBytes: number;
  error: string | null;
}

interface NonStreamBenchmark {
  label: string;
  text: string;
  ok: boolean;
  status: number | null;
  headersMs: number | null;
  fullMs: number | null;
  totalBytes: number;
  error: string | null;
}

const DEFAULT_CASES: Array<{ label: string; text: string }> = [
  { label: 'short', text: 'Hi.' },
  { label: 'medium', text: 'Hello, I can hear you.' },
  { label: 'long', text: 'Sure, I can help with that.' },
];

async function main(): Promise<void> {
  loadEnvFile(process.env);
  const runtimeConfig = resolveRuntimeConfigFromEnvironment(loadConfig(), process.env);
  const baseUrl = runtimeConfig.voice.chatterbox.url.replace(/\/+$/u, '');
  const cases = buildCases(process.argv.slice(2));

  process.stdout.write(`TTS base URL: ${baseUrl}\n`);
  process.stdout.write(`Cases: ${cases.length}\n\n`);

  for (const testCase of cases) {
    const stream = await benchmarkStream(baseUrl, testCase.label, testCase.text);
    printStream(stream);

    const nonStream = await benchmarkNonStream(baseUrl, testCase.label, testCase.text);
    printNonStream(nonStream);

    process.stdout.write('\n');
  }
}

function buildCases(argv: string[]): Array<{ label: string; text: string }> {
  const flagIndex = argv.indexOf('--text');
  const override = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;

  if (override !== undefined && override.trim().length > 0) {
    return [{ label: 'custom', text: override }];
  }

  return DEFAULT_CASES;
}

async function benchmarkStream(
  baseUrl: string,
  label: string,
  text: string,
): Promise<StreamBenchmark> {
  const started = Date.now();
  const result: StreamBenchmark = {
    label,
    text,
    ok: false,
    status: null,
    headersMs: null,
    firstChunkMs: null,
    fullMs: null,
    chunkCount: 0,
    totalBytes: 0,
    error: null,
  };

  try {
    const response = await fetch(`${baseUrl}/synthesize/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    result.status = response.status;
    result.headersMs = Date.now() - started;

    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      result.error = `HTTP ${response.status}: ${body}`;
      return result;
    }

    if (response.body === null) {
      result.error = 'Response body was null';
      return result;
    }

    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);

        if (buffer.byteLength === 0) {
          continue;
        }

        if (result.firstChunkMs === null) {
          result.firstChunkMs = Date.now() - started;
        }

        result.chunkCount += 1;
        result.totalBytes += buffer.byteLength;
      }
    } catch (error: unknown) {
      // FastAPI can abruptly close the TCP socket after the last chunk
      // without a proper FIN, which causes undici to raise UND_ERR_SOCKET.
      // If we already received data, treat it as a completed response.
      if (result.totalBytes === 0) {
        throw error;
      }
    }

    result.fullMs = Date.now() - started;
    result.ok = true;
  } catch (error: unknown) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
  }

  return result;
}

async function benchmarkNonStream(
  baseUrl: string,
  label: string,
  text: string,
): Promise<NonStreamBenchmark> {
  const started = Date.now();
  const result: NonStreamBenchmark = {
    label,
    text,
    ok: false,
    status: null,
    headersMs: null,
    fullMs: null,
    totalBytes: 0,
    error: null,
  };

  try {
    const response = await fetch(`${baseUrl}/synthesize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    result.status = response.status;
    result.headersMs = Date.now() - started;

    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      result.error = `HTTP ${response.status}: ${body}`;
      return result;
    }

    const audio = Buffer.from(await response.arrayBuffer());
    result.fullMs = Date.now() - started;
    result.totalBytes = audio.byteLength;
    result.ok = true;
  } catch (error: unknown) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
  }

  return result;
}

function printStream(result: StreamBenchmark): void {
  const title = `[${result.label}] /synthesize/stream  text="${truncate(result.text, 60)}"`;
  process.stdout.write(`${title}\n`);

  if (!result.ok) {
    process.stdout.write(`  ERROR: ${result.error ?? 'unknown'}\n`);
    return;
  }

  const streamingHint =
    result.chunkCount > 1 && result.firstChunkMs !== null && result.fullMs !== null
      ? result.fullMs - result.firstChunkMs > 50
        ? 'likely true streaming'
        : 'single burst (fake streaming)'
      : 'single chunk (fake streaming)';

  process.stdout.write(
    `  status=${result.status}  headers=${formatMs(result.headersMs)}  1st chunk=${formatMs(result.firstChunkMs)}  full=${formatMs(result.fullMs)}\n`,
  );
  process.stdout.write(
    `  chunks=${result.chunkCount}  bytes=${result.totalBytes}  verdict=${streamingHint}\n`,
  );
}

function printNonStream(result: NonStreamBenchmark): void {
  const title = `[${result.label}] /synthesize         text="${truncate(result.text, 60)}"`;
  process.stdout.write(`${title}\n`);

  if (!result.ok) {
    process.stdout.write(`  ERROR: ${result.error ?? 'unknown'}\n`);
    return;
  }

  process.stdout.write(
    `  status=${result.status}  headers=${formatMs(result.headersMs)}  full=${formatMs(result.fullMs)}  bytes=${result.totalBytes}\n`,
  );
}

function formatMs(value: number | null): string {
  return value === null ? 'n/a' : `${value}ms`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown TTS benchmark error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
