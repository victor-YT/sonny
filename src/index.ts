import { once } from 'node:events';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { Gateway } from './core/gateway.js';
import { OllamaProvider } from './core/providers/ollama.js';
import {
  createVoiceGatewayFromEnvironment,
  readVoiceEnvironmentConfig,
} from './voice/voice-gateway.js';

const SYSTEM_PROMPT =
  'You are Sonny, a local-first assistant with TARS energy: concise, pragmatic, and mildly unimpressed by avoidable mistakes. Give direct answers, make clear recommendations, and keep the jokes dry enough to pass for diagnostics. Prefer useful action over ceremony. If a request is vague, pin it down fast and move.';

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}

function isVoiceModeEnabled(): boolean {
  const flag = process.env.SONNY_VOICE_MODE;

  return flag === '1' || flag === 'true';
}

function createGateway(): Gateway {
  const voiceEnvironment = isVoiceModeEnabled()
    ? readVoiceEnvironmentConfig(process.env)
    : undefined;
  const provider = new OllamaProvider({
    baseUrl: voiceEnvironment?.ollamaBaseUrl,
    model: voiceEnvironment?.ollamaModel,
  });

  return new Gateway({
    llmProvider: provider,
    sessionConfig: {
      systemPrompt: SYSTEM_PROMPT,
    },
  });
}

async function runVoice(gateway: Gateway): Promise<void> {
  const voiceGateway = createVoiceGatewayFromEnvironment(gateway, process.env);

  voiceGateway.manager.onEvent((event) => {
    if (event.type === 'state_changed' && event.state !== undefined) {
      stdout.write(`[voice] state=${event.state}\n`);
      return;
    }

    if (event.type === 'wake_word_detected' && event.wakeWord !== undefined) {
      stdout.write(`[voice] wake word=${event.wakeWord}\n`);
      return;
    }

    if (event.type === 'transcription' && event.text !== undefined) {
      stdout.write(`[heard] ${event.text}\n`);
      return;
    }

    if (event.type === 'response' && event.text !== undefined) {
      stdout.write(`[sonny] ${event.text}\n`);
      return;
    }

    if (event.type === 'error' && event.error !== undefined) {
      console.error(`[voice] ${toErrorMessage(event.error)}`);
    }
  });

  await voiceGateway.start();
  stdout.write('Voice mode is listening. Press Ctrl+C to stop.\n');

  try {
    await once(process, 'SIGINT');
  } finally {
    await voiceGateway.stop();
  }
}

async function main(): Promise<void> {
  const gateway = createGateway();

  if (isVoiceModeEnabled()) {
    try {
      await runVoice(gateway);
    } finally {
      try {
        await gateway.finalizeSession();
      } catch (error: unknown) {
        console.error(`Memory finalization failed: ${toErrorMessage(error)}`);
      }

      gateway.close();
    }

    return;
  }

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
