import { app, ipcMain } from 'electron';
import { menubar, type Menubar } from 'menubar';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PANEL_WINDOW_WIDTH = 360;
const PANEL_WINDOW_HEIGHT = 520;
const TOOLTIP = 'Sonny';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface UiMainStatusSnapshot {
  status: 'idle' | 'listening' | 'thinking' | 'speaking';
  lastUpdatedAt: number;
}

export class UiMainApp {
  private readonly preloadPath: string;
  private menubarApp: Menubar | undefined;
  private status: UiMainStatusSnapshot;
  private stopping = false;

  public constructor() {
    this.preloadPath = join(__dirname, 'preload.js');
    this.status = {
      status: 'idle',
      lastUpdatedAt: Date.now(),
    };
  }

  public async start(): Promise<Menubar> {
    await app.whenReady();

    if (this.menubarApp !== undefined) {
      return this.menubarApp;
    }

    this.registerIpc();
    this.menubarApp = this.createMenubar();

    return this.menubarApp;
  }

  public async stop(): Promise<void> {
    if (this.menubarApp === undefined) {
      return;
    }

    this.stopping = true;
    ipcMain.removeHandler('ui:get-status');
    ipcMain.removeHandler('ui:set-status');

    app.quit();
  }

  private createMenubar(): Menubar {
    const instance = menubar({
      index: false,
      tooltip: TOOLTIP,
      preloadWindow: true,
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
      app.setName('Sonny');
      app.dock?.hide();
    });

    instance.on('after-create-window', () => {
      instance.window?.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
      });
    });

    app.on('window-all-closed', () => {
      if (this.stopping) {
        app.quit();
      }
    });

    return instance;
  }

  private registerIpc(): void {
    ipcMain.handle('ui:get-status', async () => this.status);
    ipcMain.handle(
      'ui:set-status',
      async (_event, nextStatus: UiMainStatusSnapshot['status']) => {
        this.status = {
          status: nextStatus,
          lastUpdatedAt: Date.now(),
        };

        return this.status;
      },
    );
  }
}

export async function startUiMainApp(): Promise<UiMainApp> {
  const application = new UiMainApp();
  await application.start();
  return application;
}

if (process.argv[1] === __filename) {
  void startUiMainApp();
}
