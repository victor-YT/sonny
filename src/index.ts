import { once } from 'node:events';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { loadConfig, type RuntimeConfig } from './core/config.js';
import { Gateway } from './core/gateway.js';
import { MonitorScheduler } from './core/monitor-scheduler.js';
import { NotificationManager } from './core/notification-manager.js';
import { Notifier } from './core/notifier.js';
import {
  loadStartupEnvironment,
  type StartupEnvironment,
} from './core/startup-check.js';
import { MonitorRegistry } from './skills/monitor-registry.js';
import { WebMonitor } from './skills/web-monitor.js';
import {
  createVoiceGatewayFromEnvironment,
  type VoiceGateway,
} from './voice/voice-gateway.js';
import type { VoiceManager } from './voice/voice-manager.js';
import { startConsoleServer } from './ui/console/server.js';

const SYSTEM_PROMPT =
  'You are Sonny, a local-first assistant with TARS energy: concise, pragmatic, and mildly unimpressed by avoidable mistakes. Give direct answers, make clear recommendations, and keep the jokes dry enough to pass for diagnostics. Prefer useful action over ceremony. If a request is vague, pin it down fast and move.';

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}

function createGateway(
  runtimeConfig: RuntimeConfig,
  startupEnvironment: StartupEnvironment,
): Gateway {
  return new Gateway({
    runtimeConfig: {
      ...runtimeConfig,
      ollama: {
        baseUrl: startupEnvironment.ollamaBaseUrl,
        model: startupEnvironment.ollamaModel,
      },
    },
    sessionConfig: {
      systemPrompt: SYSTEM_PROMPT,
    },
  });
}

function createMonitoringRuntime(
  voiceManager?: Pick<VoiceManager, 'currentState' | 'isRunning' | 'speak'>,
): {
  scheduler: MonitorScheduler;
} {
  const monitorRegistry = new MonitorRegistry();
  const notificationManager = new NotificationManager({
    notifier: new Notifier({
      voiceManager,
    }),
    voiceManager,
  });
  const webMonitor = new WebMonitor({
    monitorRegistry,
    notificationManager,
  });
  const scheduler = new MonitorScheduler({
    monitorRegistry,
    webMonitor,
    onError: (error, monitor) => {
      console.error(
        `Monitor check failed for ${monitor.id}: ${toErrorMessage(error)}`,
      );
    },
  });

  return {
    scheduler,
  };
}

async function runVoice(voiceGateway: VoiceGateway): Promise<void> {
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
  const startupEnvironment = loadStartupEnvironment(process.env);
  const runtimeConfig = loadConfig();
  const gateway = createGateway(runtimeConfig, startupEnvironment);
  const voiceGateway = startupEnvironment.voiceMode
    ? createVoiceGatewayFromEnvironment(gateway, process.env)
    : undefined;
  const monitoringRuntime = createMonitoringRuntime(voiceGateway?.manager);
  const consoleServer = await startConsoleServer({
    gateway,
  });

  stdout.write(`[console] ${consoleServer.address.url}\n`);

  monitoringRuntime.scheduler.start();

  if (startupEnvironment.voiceMode) {
    if (voiceGateway === undefined) {
      throw new Error('Voice gateway is required when voice mode is enabled');
    }

    try {
      await runVoice(voiceGateway);
    } finally {
      monitoringRuntime.scheduler.stop();
      await consoleServer.stop();

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
    monitoringRuntime.scheduler.stop();
    await consoleServer.stop();

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
