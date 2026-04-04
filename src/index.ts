import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { Gateway } from './core/gateway.js';
import { OllamaProvider } from './core/providers/ollama.js';

const SYSTEM_PROMPT =
  'You are Sonny, a local-first assistant with TARS energy: concise, pragmatic, and mildly unimpressed by avoidable mistakes. Give direct answers, make clear recommendations, and keep the jokes dry enough to pass for diagnostics. Prefer useful action over ceremony. If a request is vague, pin it down fast and move.';

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}

async function main(): Promise<void> {
  const provider = new OllamaProvider();
  const gateway = new Gateway({
    llmProvider: provider,
    sessionConfig: {
      systemPrompt: SYSTEM_PROMPT,
    },
  });
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
  });

  let shouldExit = false;

  rl.on('SIGINT', () => {
    shouldExit = true;
    stdout.write('\n');
    rl.close();
  });

  try {
    while (!shouldExit) {
      let input: string;

      try {
        input = await rl.question('> ');
      } catch (error: unknown) {
        if (shouldExit) {
          break;
        }

        throw error;
      }

      const trimmedInput = input.trim();

      if (trimmedInput.length === 0) {
        continue;
      }

      if (trimmedInput === 'exit' || trimmedInput === 'quit') {
        shouldExit = true;
        break;
      }

      try {
        const response = await gateway.chat(trimmedInput);
        stdout.write(`${response}\n`);
      } catch (error: unknown) {
        console.error(`Message failed: ${toErrorMessage(error)}`);
      }
    }
  } finally {
    try {
      await gateway.finalizeSession();
    } catch (error: unknown) {
      console.error(`Memory finalization failed: ${toErrorMessage(error)}`);
    }

    gateway.close();
    rl.close();
  }
}

main().catch((error: unknown) => {
  console.error(`Fatal error: ${toErrorMessage(error)}`);
  process.exit(1);
});
