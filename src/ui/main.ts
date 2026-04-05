import { app, ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Menubar } from 'menubar';

import type { Gateway } from '../core/gateway.js';
import type { LlmMessage } from '../core/providers/llm.js';
import type { VoiceManager, VoiceManagerEvent, VoiceManagerState } from '../voice/voice-manager.js';
import { CapsuleWindow } from './capsule.js';
import { TrayController } from './tray.js';

const PANEL_WINDOW_WIDTH = 360;
const PANEL_WINDOW_HEIGHT = 520;
const TOOLTIP = 'Sonny';
const MAX_CONVERSATION_ENTRIES = 24;
const DEFAULT_SYSTEM_PROMPT =
  'You are Sonny, a local-first assistant with TARS energy: concise, pragmatic, and mildly unimpressed by avoidable mistakes. Give direct answers, make clear recommendations, and keep the jokes dry enough to pass for diagnostics. Prefer useful action over ceremony. If a request is vague, pin it down fast and move.';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let activeUiMainApp: UiMainApp | undefined;

console.log(
  `[ui.main] JS is running modulePath=${__filename} argv1=${process.argv[1] ?? 'undefined'} electron=${process.versions.electron ?? 'undefined'}`,
);

export interface UiMainStatusSnapshot {
  status: 'idle' | 'listening' | 'thinking' | 'speaking';
  lastUpdatedAt: number;
}

export interface UiConversationEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface UiMainAppConfig {
  gateway?: Gateway;
}

export class UiMainApp {
  private readonly preloadPath: string;
  private readonly panelUrl: string;
  private readonly trayController: TrayController;
  private readonly capsuleWindow: CapsuleWindow;
  private readonly conversation: UiConversationEntry[] = [];
  private menubarApp: Menubar | undefined;
  private status: UiMainStatusSnapshot;
  private gateway: Gateway | undefined;
  private gatewayPromise: Promise<Gateway> | undefined;
  private boundVoiceManager: VoiceManager | undefined;
  private voiceManagerListener:
    | ((event: VoiceManagerEvent) => void)
    | undefined;
  private stopping = false;
  private ipcRegistered = false;

  public constructor(config: UiMainAppConfig = {}) {
    this.preloadPath = join(__dirname, 'preload.js');
    this.panelUrl = this.resolvePanelUrl();
    this.gateway = config.gateway;
    this.trayController = new TrayController({
      tooltip: TOOLTIP,
    });
    this.capsuleWindow = new CapsuleWindow();
    this.status = {
      status: 'idle',
      lastUpdatedAt: Date.now(),
    };
  }

  public async start(): Promise<Menubar> {
    try {
      console.log('[ui.main] before app.whenReady()');
      app.once('ready', () => {
        console.log('[ui.main] inside app ready callback');
      });

      await app.whenReady();
      console.log('[ui.main] app.whenReady() resolved');
      app.dock?.hide();
      console.log('[ui.main] app.dock.hide() called after ready');

      if (this.menubarApp !== undefined) {
        console.log('[ui.main] menubar already created');
        return this.menubarApp;
      }

      this.registerIpc();
      this.menubarApp = await this.createMenubar();
      console.log('[ui.main] menubar instance created');
      void this.initializeGateway();

      return this.menubarApp;
    } catch (error: unknown) {
      console.error('[ui.main] startup failed', error);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.menubarApp === undefined) {
      return;
    }

    this.stopping = true;
    ipcMain.removeHandler('ui:get-status');
    ipcMain.removeHandler('ui:set-status');
    ipcMain.removeHandler('ui:toggle-panel');
    ipcMain.removeHandler('ui:show-capsule');
    ipcMain.removeHandler('ui:hide-capsule');
    ipcMain.removeHandler('gateway:list-conversation');
    ipcMain.removeHandler('gateway:send-message');
    this.capsuleWindow.destroy();
    this.gateway?.close();

    app.quit();
  }

  public bindVoiceManager(voiceManager: VoiceManager): void {
    if (
      this.boundVoiceManager !== undefined &&
      this.voiceManagerListener !== undefined
    ) {
      this.boundVoiceManager.removeListener(this.voiceManagerListener);
    }

    this.voiceManagerListener = (event) => {
      void this.handleVoiceManagerEvent(event);
    };

    this.boundVoiceManager = voiceManager;
    voiceManager.onEvent(this.voiceManagerListener);
    void this.applyStatus(this.mapVoiceState(voiceManager.currentState));
  }

  private async createMenubar(): Promise<Menubar> {
    const trayIconDebugInfo = this.trayController.getIconDebugInfo();

    console.log(
      `[ui.main] creating menubar preloadPath=${this.preloadPath} preloadExists=${existsSync(this.preloadPath)} panelUrl=${this.panelUrl}`,
    );
    console.log(
      `[ui.main] tray icon lookup resolvedPath=${trayIconDebugInfo.resolvedPath ?? 'missing'} usingFallback=${trayIconDebugInfo.usingFallback} expectedPaths=${trayIconDebugInfo.expectedPaths.join(', ')}`,
    );

    const tray = this.trayController.create();

    console.log('[ui.main] tray icon is set');

    console.log('[ui.main] importing menubar package');
    const { menubar } = await import('menubar');
    console.log('[ui.main] menubar package import resolved');

    const instance = menubar({
      index: this.panelUrl,
      tooltip: TOOLTIP,
      preloadWindow: true,
      tray,
      showDockIcon: false,
      browserWindow: {
        width: PANEL_WINDOW_WIDTH,
        height: PANEL_WINDOW_HEIGHT,
        show: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        titleBarStyle: 'hiddenInset',
        backgroundColor: '#10161f',
        webPreferences: {
          preload: this.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
        },
      },
    });

    instance.on('ready', () => {
      console.log('[ui.main] menubar ready event fired');
      app.setName('Sonny');
      app.dock?.hide();
      console.log('[ui.main] app.dock.hide() called from menubar ready');
      this.trayController.setStatus(this.status.status);
    });

    instance.on('after-create-window', () => {
      console.log('[ui.main] menubar window created');
      instance.window?.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
      });
    });

    instance.on('show', () => {
      console.log('[ui.main] menubar window shown');
    });

    instance.on('after-show', () => {
      console.log('[ui.main] menubar after-show fired');
    });

    instance.on('hide', () => {
      console.log('[ui.main] menubar window hidden');
    });

    instance.on('create-window', () => {
      console.log('[ui.main] menubar create-window fired');
    });

    instance.on('error', (error) => {
      console.error('[ui.main] menubar error', error);
    });

    app.on('activate', () => {
      console.log('[ui.main] app activate event fired');
    });

    app.on('before-quit', () => {
      this.stopping = true;
      console.log('[ui.main] before-quit fired');
    });

    app.on('window-all-closed', () => {
      console.log(
        `[ui.main] window-all-closed fired stopping=${this.stopping}`,
      );

      if (!this.stopping) {
        console.log(
          '[ui.main] ignoring window-all-closed because the menubar app should remain running',
        );
        return;
      }

      app.quit();
    });

    app.on('quit', () => {
      console.log('[ui.main] app quit event fired');
    });

    process.once('beforeExit', (code) => {
      console.log(`[ui.main] process beforeExit fired code=${code}`);
    });

    return instance;
  }

  private resolvePanelUrl(): string {
    const distPanelHtmlPath = join(__dirname, 'panel', 'index.html');

    console.log(
      `[ui.main] checked panel path ${distPanelHtmlPath} exists=${existsSync(distPanelHtmlPath)}`,
    );

    if (existsSync(distPanelHtmlPath)) {
      return pathToFileURL(distPanelHtmlPath).toString();
    }

    throw new Error(
      `Panel HTML is missing at ${distPanelHtmlPath}. Run pnpm build to generate dist/ui/panel/index.html.`,
    );
  }

  private registerIpc(): void {
    if (this.ipcRegistered) {
      console.log('[ui.main] IPC handlers already registered');
      return;
    }

    console.log('[ui.main] registering IPC handlers');
    this.ipcRegistered = true;

    ipcMain.handle('ui:get-status', async () => this.status);
    ipcMain.handle(
      'ui:set-status',
      async (_event, nextStatus: UiMainStatusSnapshot['status']) => {
        return this.applyStatus(nextStatus);
      },
    );
    ipcMain.handle('ui:toggle-panel', async () => {
      const menubarApp = await this.start();

      if (menubarApp.window?.isVisible() === true) {
        menubarApp.hideWindow();
        return;
      }

      await menubarApp.showWindow();
    });
    ipcMain.handle('ui:show-capsule', async () => {
      this.capsuleWindow.show();
    });
    ipcMain.handle('ui:hide-capsule', async () => {
      this.capsuleWindow.hide();
    });
    ipcMain.handle('gateway:list-conversation', async () => {
      console.log(
        `[ui.main] IPC gateway:list-conversation entries=${this.conversation.length}`,
      );
      return [...this.conversation];
    });
    ipcMain.handle('gateway:send-message', async (_event, message: string) => {
      const trimmedMessage = message.trim();

      console.log(
        `[ui.main] IPC gateway:send-message received messageLength=${trimmedMessage.length}`,
      );

      if (trimmedMessage.length === 0) {
        console.log('[ui.main] ignoring empty gateway:send-message payload');
        return '';
      }

      this.appendConversation('user', trimmedMessage);
      await this.applyStatus('thinking');

      try {
        const gateway = await this.ensureGateway();
        console.log('[ui.main] gateway resolved for IPC send-message');
        const response = await gateway.chat(trimmedMessage);

        console.log(
          `[ui.main] gateway chat resolved responseLength=${response.length}`,
        );

        this.appendConversation('assistant', response);

        return response;
      } catch (error: unknown) {
        console.error('[ui.main] gateway send-message failed', error);
        throw error;
      } finally {
        await this.applyStatus('idle');
      }
    });
  }

  private async applyStatus(
    nextStatus: UiMainStatusSnapshot['status'],
  ): Promise<UiMainStatusSnapshot> {
    this.status = {
      status: nextStatus,
      lastUpdatedAt: Date.now(),
    };

    this.trayController.setStatus(nextStatus);
    await this.capsuleWindow.setStatus(nextStatus);

    if (nextStatus === 'idle') {
      this.capsuleWindow.hide();
    } else {
      this.capsuleWindow.show();
    }

    this.broadcastStatus();

    return this.status;
  }

  private broadcastStatus(): void {
    this.menubarApp?.window?.webContents.send('ui:status-changed', this.status);
  }

  private appendConversation(
    role: UiConversationEntry['role'],
    content: string,
  ): void {
    this.conversation.push({
      role,
      content,
      timestamp: Date.now(),
    });

    if (this.conversation.length > MAX_CONVERSATION_ENTRIES) {
      this.conversation.splice(0, this.conversation.length - MAX_CONVERSATION_ENTRIES);
    }
  }

  private async handleVoiceManagerEvent(event: VoiceManagerEvent): Promise<void> {
    if (event.type === 'state_changed' && event.state !== undefined) {
      await this.applyStatus(this.mapVoiceState(event.state));
      return;
    }

    if (event.type === 'transcription' && event.text !== undefined) {
      this.appendConversation('user', event.text);
      return;
    }

    if (event.type === 'response' && event.text !== undefined) {
      this.appendConversation('assistant', event.text);
    }
  }

  private mapVoiceState(state: VoiceManagerState): UiMainStatusSnapshot['status'] {
    switch (state) {
      case 'listening':
      case 'capturing':
      case 'transcribing':
        return 'listening';
      case 'thinking':
        return 'thinking';
      case 'synthesizing':
      case 'playing':
        return 'speaking';
      case 'idle':
      case 'error':
      default:
        return 'idle';
    }
  }

  private toConversationEntry(
    message: LlmMessage,
  ): UiConversationEntry | null {
    if (message.role !== 'user' && message.role !== 'assistant') {
      return null;
    }

    return {
      role: message.role,
      content: message.content,
      timestamp: Date.now(),
    };
  }

  private seedConversationFromSession(): void {
    if (this.conversation.length > 0) {
      return;
    }

    const gateway = this.gateway;

    if (gateway === undefined) {
      return;
    }

    for (const message of gateway.currentSession.getHistory()) {
      const entry = this.toConversationEntry(message);

      if (entry !== null) {
        this.conversation.push(entry);
      }
    }
  }

  private async initializeGateway(): Promise<void> {
    try {
      console.log('[ui.main] initializeGateway start');
      await this.ensureGateway();
      console.log('[ui.main] initializeGateway resolved');
      this.seedConversationFromSession();
    } catch (error: unknown) {
      console.error('[ui.main] gateway initialization failed', error);
    }
  }

  private async ensureGateway(): Promise<Gateway> {
    if (this.gateway !== undefined) {
      console.log('[ui.main] reusing initialized gateway');
      return this.gateway;
    }

    if (this.gatewayPromise === undefined) {
      console.log('[ui.main] creating gateway promise');
      this.gatewayPromise = this.createDefaultGateway();
    } else {
      console.log('[ui.main] awaiting in-flight gateway promise');
    }

    try {
      this.gateway = await this.gatewayPromise;
      console.log('[ui.main] gateway instance ready');
      return this.gateway;
    } finally {
      this.gatewayPromise = undefined;
    }
  }

  private async createDefaultGateway(): Promise<Gateway> {
    try {
      console.log('[ui.main] createDefaultGateway start');
      const [{ Gateway }, { OllamaProvider }] = await Promise.all([
        import('../core/gateway.js'),
        import('../core/providers/ollama.js'),
      ]);

      const gateway = new Gateway({
        llmProvider: new OllamaProvider(),
        sessionConfig: {
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
        },
      });

      console.log('[ui.main] createDefaultGateway complete');

      return gateway;
    } catch (error: unknown) {
      console.error('[ui.main] failed to create default gateway', error);
      throw error;
    }
  }
}

export async function startUiMainApp(
  config: UiMainAppConfig = {},
): Promise<UiMainApp> {
  if (activeUiMainApp !== undefined) {
    console.log('[ui.main] reusing active UiMainApp instance');
    return activeUiMainApp;
  }

  const application = new UiMainApp(config);
  activeUiMainApp = application;
  console.log('[ui.main] activeUiMainApp reference retained');
  await application.start();
  return application;
}

function shouldAutoStartUiMainApp(): boolean {
  const entryArgument = process.argv[1];

  if (entryArgument === undefined) {
    console.log('[ui.main] auto-start disabled because argv[1] is undefined');
    return false;
  }

  const resolvedEntryPath = resolve(process.cwd(), entryArgument);
  const shouldStart = resolvedEntryPath === __filename;

  console.log(
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
