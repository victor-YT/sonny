import { app, ipcMain } from 'electron';
import { menubar, type Menubar } from 'menubar';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Gateway } from '../core/gateway.js';
import { OllamaProvider } from '../core/providers/ollama.js';
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
const INLINE_PANEL_HTML = `
  <!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>Sonny</title>
      <style>
        body {
          margin: 0;
          font: 14px/1.5 -apple-system, BlinkMacSystemFont, sans-serif;
          background: #10161f;
          color: #f4f7fb;
          display: grid;
          place-items: center;
          min-height: 100vh;
        }
        main {
          width: min(280px, calc(100vw - 48px));
        }
        h1 {
          font-size: 16px;
          margin: 0 0 8px;
        }
        p {
          margin: 0;
          color: #9fb0c4;
        }
      </style>
    </head>
    <body>
      <main>
        <h1>Sonny is running</h1>
        <p>The panel bundle was not found, so this fallback view is being used.</p>
      </main>
    </body>
  </html>
`.trim();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let activeUiMainApp: UiMainApp | undefined;

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
  private readonly gateway: Gateway;
  private readonly trayController: TrayController;
  private readonly capsuleWindow: CapsuleWindow;
  private readonly conversation: UiConversationEntry[] = [];
  private menubarApp: Menubar | undefined;
  private status: UiMainStatusSnapshot;
  private boundVoiceManager: VoiceManager | undefined;
  private voiceManagerListener:
    | ((event: VoiceManagerEvent) => void)
    | undefined;
  private stopping = false;

  public constructor(config: UiMainAppConfig = {}) {
    this.preloadPath = join(__dirname, 'preload.js');
    this.panelUrl = this.resolvePanelUrl();
    this.gateway =
      config.gateway ??
      new Gateway({
        llmProvider: new OllamaProvider(),
        sessionConfig: {
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
        },
      });
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
    console.log('[ui.main] waiting for app ready');
    await app.whenReady();
    console.log('[ui.main] app ready event fired');

    if (this.menubarApp !== undefined) {
      console.log('[ui.main] menubar already created');
      return this.menubarApp;
    }

    this.registerIpc();
    this.seedConversationFromSession();
    this.menubarApp = this.createMenubar();
    console.log('[ui.main] menubar instance created');

    return this.menubarApp;
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
    this.gateway.close();

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

  private createMenubar(): Menubar {
    console.log(
      `[ui.main] creating menubar preloadPath=${this.preloadPath} preloadExists=${existsSync(this.preloadPath)} panelUrl=${this.panelUrl}`,
    );

    const instance = menubar({
      index: this.panelUrl,
      tooltip: TOOLTIP,
      preloadWindow: true,
      tray: this.trayController.create(),
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

      if (this.stopping) {
        app.quit();
      }
    });

    return instance;
  }

  private resolvePanelUrl(): string {
    const candidatePaths = [
      join(__dirname, 'panel', 'index.html'),
      join(process.cwd(), 'dist', 'ui', 'panel', 'index.html'),
      join(process.cwd(), 'src', 'ui', 'panel', 'index.html'),
    ];

    for (const candidatePath of candidatePaths) {
      const exists = existsSync(candidatePath);

      console.log(`[ui.main] checked panel path ${candidatePath} exists=${exists}`);

      if (exists) {
        return pathToFileURL(candidatePath).toString();
      }
    }

    console.warn('[ui.main] no panel file found, using inline fallback HTML');

    return `data:text/html;charset=utf-8,${encodeURIComponent(INLINE_PANEL_HTML)}`;
  }

  private registerIpc(): void {
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
    ipcMain.handle('gateway:list-conversation', async () => [...this.conversation]);
    ipcMain.handle('gateway:send-message', async (_event, message: string) => {
      const trimmedMessage = message.trim();

      if (trimmedMessage.length === 0) {
        return '';
      }

      this.appendConversation('user', trimmedMessage);
      await this.applyStatus('thinking');

      try {
        const response = await this.gateway.chat(trimmedMessage);

        this.appendConversation('assistant', response);

        return response;
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

    for (const message of this.gateway.currentSession.getHistory()) {
      const entry = this.toConversationEntry(message);

      if (entry !== null) {
        this.conversation.push(entry);
      }
    }
  }
}

export async function startUiMainApp(
  config: UiMainAppConfig = {},
): Promise<UiMainApp> {
  const application = new UiMainApp(config);
  await application.start();
  activeUiMainApp = application;
  return application;
}

if (process.argv[1] === __filename) {
  void startUiMainApp().catch((error: unknown) => {
    console.error('[ui.main] failed to start ui main app', error);
    process.exitCode = 1;
  });
}
