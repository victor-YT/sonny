import { loadConfig } from '../core/config.js';
import { OlmxForegroundProvider } from '../core/providers/olmx.js';
import { resolveRuntimeConfigFromEnvironment } from '../core/runtime-config-resolution.js';

async function main(): Promise<void> {
  const runtimeConfig = resolveRuntimeConfigFromEnvironment(loadConfig(), process.env);
  const prompt = readPrompt(process.argv.slice(2));
  const provider = new OlmxForegroundProvider(runtimeConfig.olmx);
  const startedAt = Date.now();
  let firstTokenMs: number | null = null;
  let text = '';

  process.stdout.write(`OLMX Base URL: ${runtimeConfig.olmx.baseUrl}\n`);
  process.stdout.write(`OLMX Model: ${runtimeConfig.foregroundModel}\n`);
  process.stdout.write('Streaming: yes\n\n');

  for await (const chunk of provider.generateStream(
    [
      {
        role: 'user',
        content: prompt,
      },
    ],
    {
      model: runtimeConfig.foregroundModel,
      temperature: 0.2,
      maxTokens: 80,
    },
  )) {
    if (chunk.type !== 'text' || chunk.text === undefined) {
      continue;
    }

    if (firstTokenMs === null) {
      firstTokenMs = Date.now() - startedAt;
    }

    text += chunk.text;
    process.stdout.write(chunk.text);
  }

  process.stdout.write('\n\n');
  process.stdout.write(`First Token: ${formatMs(firstTokenMs)}\n`);
  process.stdout.write(`Total: ${Date.now() - startedAt}ms\n`);
  process.stdout.write(`Characters: ${text.length}\n`);
  process.stdout.write(`Debug: ${JSON.stringify(provider.getLastDebugInfo(), null, 2)}\n`);
}

function readPrompt(argv: string[]): string {
  const promptFlagIndex = argv.indexOf('--prompt');
  const value = promptFlagIndex >= 0 ? argv[promptFlagIndex + 1] : undefined;

  return value ?? 'Say one short sentence confirming OLMX is connected.';
}

function formatMs(value: number | null): string {
  return value === null ? 'unknown' : `${value}ms`;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown OLMX smoke failure';

  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
