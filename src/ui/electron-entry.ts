import { app } from 'electron';

import { startVoiceControlCenter } from '../app/voice-control-center.js';
import { startUiMainApp } from './main.js';

let shutdownTask: Promise<void> | undefined;

async function main(): Promise<void> {
  const runtime = await startVoiceControlCenter();

  console.log(`[console] ${runtime.consoleServer.address.url}`);

  const uiApp = await startUiMainApp({
    controlCenterUrl: runtime.consoleServer.address.url,
    runtimeState: runtime.runtimeState,
  });

  app.once('before-quit', () => {
    if (shutdownTask !== undefined) {
      return;
    }

    shutdownTask = runtime.stop();
  });

  void uiApp;
}

void main().catch((error: unknown) => {
  console.error(
    `[voice-control-center] failed to start: ${error instanceof Error ? error.message : String(error)}`,
  );
  app.exit(1);
});
