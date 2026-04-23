import { loadConfig, type RuntimeConfig } from '../core/config.js';
import { Gateway } from '../core/gateway.js';
import { resolveRuntimeConfigFromEnvironment } from '../core/runtime-config-resolution.js';
import { RuntimeStateStore } from '../core/runtime-state.js';
import {
  loadStartupEnvironment,
  type StartupEnvironment,
} from '../core/startup-check.js';
import {
  createVoiceGatewayFromEnvironment,
  readVoiceEnvironmentConfig,
  type VoiceGateway,
} from '../voice/voice-gateway.js';
import { VoiceSessionOrchestrator } from '../voice/voice-session-orchestrator.js';
import {
  startConsoleServer,
  type ConsoleServer,
} from '../ui/console/server.js';

const SYSTEM_PROMPT =
  'You are Sonny, a local-first assistant with TARS energy: concise, pragmatic, and mildly unimpressed by avoidable mistakes. Give direct answers, make clear recommendations, and keep the jokes dry enough to pass for diagnostics. Prefer useful action over ceremony. If a request is vague, pin it down fast and move. For voice replies, start with one short sentence that answers directly. For greetings, identity questions, and short utility requests, keep the whole reply brief and spoken-first.';

export interface VoiceControlCenterRuntime {
  gateway: Gateway;
  voiceGateway: VoiceGateway;
  runtimeConfig: RuntimeConfig;
  runtimeState: RuntimeStateStore;
  orchestrator: VoiceSessionOrchestrator;
  consoleServer: ConsoleServer;
  startupEnvironment: StartupEnvironment;
  stop(): Promise<void>;
}

export async function startVoiceControlCenter(): Promise<VoiceControlCenterRuntime> {
  const startupEnvironment = loadStartupEnvironment(process.env);
  const runtimeConfig = resolveRuntimeConfigFromEnvironment(loadConfig(), process.env);
  const gateway = new Gateway({
    runtimeConfig,
    sessionConfig: {
      systemPrompt: SYSTEM_PROMPT,
    },
  });
  const voiceGateway = createVoiceGatewayFromEnvironment(gateway, process.env);
  const voiceEnvironmentConfig = readVoiceEnvironmentConfig(process.env);
  const runtimeState = new RuntimeStateStore({
    currentSessionId: gateway.currentSession.id,
    services: {
      ollama: {
        url: `${runtimeConfig.ollama.baseUrl.replace(/\/+$/u, '')}/api/tags`,
      },
      stt: {
        url: `${runtimeConfig.voice.fasterWhisper.url.replace(/\/+$/u, '')}/health`,
      },
      tts: {
        url: `${runtimeConfig.voice.chatterbox.url.replace(/\/+$/u, '')}/health`,
      },
      wake_word: {
        url:
          runtimeConfig.voice.porcupine.url === undefined
            ? null
            : `${runtimeConfig.voice.porcupine.url.replace(/\/+$/u, '')}/health`,
      },
      vad: {
        url: `${(voiceEnvironmentConfig.vadBaseUrl ?? 'http://127.0.0.1:8003').replace(/\/+$/u, '')}/health`,
      },
    },
  });
  const orchestrator = new VoiceSessionOrchestrator({
    gateway,
    voiceGateway,
    runtimeConfig,
    environmentConfig: voiceEnvironmentConfig,
    runtimeState,
  });

  await orchestrator.start();

  const consoleServer = await startConsoleServer({
    gateway,
    runtimeState,
    voiceRuntime: orchestrator,
    voiceManager: voiceGateway.manager,
  });

  runtimeState.addLog({
    level: 'info',
    type: 'console_started',
    message: `Console server started at ${consoleServer.address.url}`,
    meta: {
      url: consoleServer.address.url,
    },
  });

  return {
    gateway,
    voiceGateway,
    runtimeConfig,
    runtimeState,
    orchestrator,
    consoleServer,
    startupEnvironment,
    stop: async () => {
      await consoleServer.stop();
      await orchestrator.stop();
      gateway.close();
    },
  };
}
