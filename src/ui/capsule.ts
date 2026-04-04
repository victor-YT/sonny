import { BrowserWindow, screen } from 'electron';

export type CapsuleStatus = 'idle' | 'listening' | 'thinking' | 'speaking';

const CAPSULE_WIDTH = 280;
const CAPSULE_HEIGHT = 72;
const CAPSULE_TOP_OFFSET = 48;

const STATUS_COPY: Record<CapsuleStatus, { title: string; subtitle: string }> = {
  idle: {
    title: 'Sonny standing by',
    subtitle: 'Quiet, local, and ready.',
  },
  listening: {
    title: 'Listening',
    subtitle: 'Wake word received.',
  },
  thinking: {
    title: 'Thinking',
    subtitle: 'Working through the reply.',
  },
  speaking: {
    title: 'Speaking',
    subtitle: 'Delivering the answer.',
  },
};

export class CapsuleWindow {
  private window: BrowserWindow | undefined;
  private status: CapsuleStatus = 'idle';

  public create(): BrowserWindow {
    if (this.window !== undefined) {
      return this.window;
    }

    this.window = new BrowserWindow({
      width: CAPSULE_WIDTH,
      height: CAPSULE_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      roundedCorners: true,
      backgroundColor: '#00000000',
      webPreferences: {
        sandbox: true,
      },
    });

    this.window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
    });
    this.window.setAlwaysOnTop(true, 'screen-saver');
    this.window.setIgnoreMouseEvents(true);
    this.window.on('closed', () => {
      this.window = undefined;
    });

    void this.render(this.status);
    this.positionWindow();

    return this.window;
  }

  public async setStatus(status: CapsuleStatus): Promise<void> {
    this.status = status;
    await this.render(status);
  }

  public show(): void {
    const window = this.create();
    this.positionWindow();
    window.showInactive();
  }

  public hide(): void {
    this.window?.hide();
  }

  public destroy(): void {
    this.window?.destroy();
    this.window = undefined;
  }

  private positionWindow(): void {
    const window = this.window;

    if (window === undefined) {
      return;
    }

    const display = screen.getPrimaryDisplay();
    const x = Math.round(display.workArea.x + (display.workArea.width - CAPSULE_WIDTH) / 2);
    const y = display.workArea.y + CAPSULE_TOP_OFFSET;

    window.setPosition(x, y, false);
  }

  private async render(status: CapsuleStatus): Promise<void> {
    const window = this.create();
    const copy = STATUS_COPY[status];
    const color = this.getAccentColor(status);
    const html = `
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            :root {
              color-scheme: dark;
              font-family: "SF Pro Display", "Segoe UI", sans-serif;
            }

            body {
              margin: 0;
              background: transparent;
              overflow: hidden;
            }

            .capsule {
              width: ${CAPSULE_WIDTH}px;
              height: ${CAPSULE_HEIGHT}px;
              border-radius: 999px;
              box-sizing: border-box;
              padding: 14px 20px;
              display: grid;
              grid-template-columns: 12px 1fr;
              gap: 14px;
              align-items: center;
              color: #f7fafc;
              background:
                radial-gradient(circle at 20% 20%, rgba(255,255,255,0.18), transparent 40%),
                linear-gradient(135deg, rgba(12, 18, 28, 0.88), rgba(19, 29, 42, 0.94));
              border: 1px solid rgba(255,255,255,0.14);
              backdrop-filter: blur(18px);
              box-shadow: 0 18px 40px rgba(3, 8, 18, 0.32);
            }

            .pulse {
              width: 12px;
              height: 12px;
              border-radius: 999px;
              background: ${color};
              box-shadow: 0 0 0 6px ${this.withOpacity(color, 0.18)};
            }

            .title {
              font-size: 15px;
              font-weight: 600;
              line-height: 1.1;
              letter-spacing: 0.01em;
            }

            .subtitle {
              margin-top: 4px;
              font-size: 12px;
              color: rgba(235, 242, 250, 0.72);
              line-height: 1.2;
            }
          </style>
        </head>
        <body>
          <div class="capsule">
            <div class="pulse"></div>
            <div>
              <div class="title">${copy.title}</div>
              <div class="subtitle">${copy.subtitle}</div>
            </div>
          </div>
        </body>
      </html>
    `.trim();

    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }

  private getAccentColor(status: CapsuleStatus): string {
    switch (status) {
      case 'listening':
        return '#2DD4BF';
      case 'thinking':
        return '#FB923C';
      case 'speaking':
        return '#60A5FA';
      case 'idle':
      default:
        return '#E2E8F0';
    }
  }

  private withOpacity(hexColor: string, opacity: number): string {
    const normalized = hexColor.replace('#', '');

    if (normalized.length !== 6) {
      return hexColor;
    }

    const alpha = Math.round(opacity * 255)
      .toString(16)
      .padStart(2, '0');

    return `#${normalized}${alpha}`;
  }
}
