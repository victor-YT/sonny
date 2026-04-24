import { app, shell, type Tray } from 'electron';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { debugLog } from '../core/debug-log.js';
import type { RuntimeStateStore, SonnyRuntimeState } from '../core/runtime-state.js';
import { TrayController } from './tray.js';

const TOOLTIP = 'Sonny';
const UI_DEBUG_FLAG = 'SONNY_UI_DEBUG';
const __filename = fileURLToPath(import.meta.url);
let activeUiMainApp: UiMainApp | undefined;

debugLog(
  UI_DEBUG_FLAG,
  `[ui.main] JS is running modulePath=${__filename} argv1=${process.argv[1] ?? 'undefined'} electron=${process.versions.electron ?? 'undefined'}`,
);

export interface UiMainStatusSnapshot {
  status: 'idle' | 'listening' | 'thinking' | 'speaking';
  lastUpdatedAt: number;
}

export interface UiMainAppConfig {
  controlCenterUrl?: string;
  runtimeState?: Pick<RuntimeStateStore, 'getSnapshot' | 'subscribe'>;
}

export class UiMainApp {
  private readonly trayController: TrayController;
  private readonly controlCenterUrl: string | undefined;
  private readonly runtimeState: UiMainAppConfig['runtimeState'];
  private tray: Tray | undefined;
  private status: UiMainStatusSnapshot;
  private runtimeStateDetach: (() => void) | undefined;
  private stopping = false;

  public constructor(config: UiMainAppConfig = {}) {
    this.controlCenterUrl = config.controlCenterUrl;
    this.runtimeState = config.runtimeState;
    this.trayController = new TrayController({
      tooltip: TOOLTIP,
    });
    this.status = this.toInitialStatus();
  }

  public async start(): Promise<Tray> {
    debugLog(UI_DEBUG_FLAG, '[ui.main] before app.whenReady()');
    await app.whenReady();
    debugLog(UI_DEBUG_FLAG, '[ui.main] app.whenReady() resolved');
    app.setName('Sonny');
    app.dock?.hide();

    if (this.tray !== undefined) {
      debugLog(UI_DEBUG_FLAG, '[ui.main] tray already created');
      return this.tray;
    }

    this.registerAppLifecycle();
    this.tray = this.trayController.create();
    this.attachTrayBehavior(this.tray);
    this.attachRuntimeState();
    this.trayController.setStatus(this.status.status);

    debugLog(
      UI_DEBUG_FLAG,
      `[ui.main] tray ready controlCenterUrl=${this.controlCenterUrl ?? 'unavailable'}`,
    );

    return this.tray;
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    this.runtimeStateDetach?.();
    this.runtimeStateDetach = undefined;
    this.tray?.destroy();
    this.tray = undefined;
    app.quit();
  }

  private registerAppLifecycle(): void {
    app.on('before-quit', () => {
      this.stopping = true;
      debugLog(UI_DEBUG_FLAG, '[ui.main] before-quit fired');
    });

    app.on('window-all-closed', () => {
      debugLog(
        UI_DEBUG_FLAG,
        `[ui.main] window-all-closed fired stopping=${this.stopping}`,
      );
    });

    app.on('activate', () => {
      debugLog(UI_DEBUG_FLAG, '[ui.main] app activate event fired');

      if (this.controlCenterUrl !== undefined) {
        void this.openControlCenter('activate');
      }
    });

    app.on('quit', () => {
      debugLog(UI_DEBUG_FLAG, '[ui.main] app quit event fired');
    });

    process.once('beforeExit', (code) => {
      debugLog(UI_DEBUG_FLAG, `[ui.main] process beforeExit fired code=${code}`);
    });
  }

  private attachTrayBehavior(tray: Tray): void {
    tray.on('click', () => {
      void this.openControlCenter('tray-click');
    });

    tray.on('right-click', () => {
      void this.openControlCenter('tray-right-click');
    });
  }

  private async openControlCenter(source: string): Promise<void> {
    if (this.controlCenterUrl === undefined) {
      debugLog(UI_DEBUG_FLAG, `[ui.main] control center URL unavailable source=${source}`);
      return;
    }

    debugLog(
      UI_DEBUG_FLAG,
      `[ui.main] opening control center source=${source} url=${this.controlCenterUrl}`,
    );
    await shell.openExternal(this.controlCenterUrl);
  }

  private applyStatus(
    nextStatus: UiMainStatusSnapshot['status'],
  ): UiMainStatusSnapshot {
    this.status = {
      status: nextStatus,
      lastUpdatedAt: Date.now(),
    };

    this.trayController.setStatus(nextStatus);

    return this.status;
  }

  private mapRuntimeState(state: SonnyRuntimeState): UiMainStatusSnapshot['status'] {
    switch (state) {
      case 'listening':
      case 'wake_detected':
      case 'transcribing':
        return 'listening';
      case 'thinking':
        return 'thinking';
      case 'speaking':
        return 'speaking';
      case 'idle':
      case 'error':
      default:
        return 'idle';
    }
  }

  private toInitialStatus(): UiMainStatusSnapshot {
    const snapshot = this.runtimeState?.getSnapshot();

    if (snapshot === undefined) {
      return {
        status: 'idle',
        lastUpdatedAt: Date.now(),
      };
    }

    return {
      status: this.mapRuntimeState(snapshot.currentState),
      lastUpdatedAt: Date.parse(snapshot.updatedAt) || Date.now(),
    };
  }

  private attachRuntimeState(): void {
    if (this.runtimeState === undefined || this.runtimeStateDetach !== undefined) {
      return;
    }

    this.runtimeStateDetach = this.runtimeState.subscribe((event) => {
      if (event.type !== 'snapshot') {
        return;
      }

      this.applyStatus(this.mapRuntimeState(event.snapshot.currentState));
    });
  }
}

export async function startUiMainApp(
  config: UiMainAppConfig = {},
): Promise<UiMainApp> {
  if (activeUiMainApp !== undefined) {
    debugLog(UI_DEBUG_FLAG, '[ui.main] reusing active UiMainApp instance');
    return activeUiMainApp;
  }

  const application = new UiMainApp(config);
  activeUiMainApp = application;
  debugLog(UI_DEBUG_FLAG, '[ui.main] activeUiMainApp reference retained');
  await application.start();
  return application;
}

function shouldAutoStartUiMainApp(): boolean {
  const entryArgument = process.argv[1];

  if (entryArgument === undefined) {
    debugLog(UI_DEBUG_FLAG, '[ui.main] auto-start disabled because argv[1] is undefined');
    return false;
  }

  const resolvedEntryPath = resolve(process.cwd(), entryArgument);
  const shouldStart = resolvedEntryPath === __filename;

  debugLog(
    UI_DEBUG_FLAG,
    `[ui.main] auto-start check entryArgument=${entryArgument} resolvedEntryPath=${resolvedEntryPath} modulePath=${__filename} shouldStart=${shouldStart}`,
  );

  return shouldStart;
}

if (shouldAutoStartUiMainApp()) {
  void (async () => {
    try {
      await startUiMainApp();
    } catch (error: unknown) {
      console.error('[ui.main] failed to start ui main app', error);
      process.exitCode = 1;
    }
  })();
}
