import { BrowserWindow, screen } from 'electron';

export type CapsuleStatus = 'idle' | 'listening' | 'thinking' | 'speaking';

const CAPSULE_WIDTH = 300;
const CAPSULE_HEIGHT = 82;
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
    const statusClass = `status-${status}`;
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
              display: grid;
              place-items: center;
            }

            .capsule {
              --accent: ${color};
              width: ${CAPSULE_WIDTH}px;
              height: ${CAPSULE_HEIGHT}px;
              border-radius: 28px;
              box-sizing: border-box;
              padding: 16px 18px;
              display: grid;
              grid-template-columns: 18px 1fr;
              gap: 16px;
              align-items: center;
              position: relative;
              overflow: hidden;
              color: #f7fafc;
              background:
                linear-gradient(180deg, rgba(15, 20, 31, 0.74), rgba(7, 10, 18, 0.9)),
                radial-gradient(circle at top left, rgba(255, 255, 255, 0.08), transparent 44%);
              border: 1px solid rgba(255,255,255,0.12);
              backdrop-filter: blur(24px) saturate(140%);
              box-shadow:
                inset 0 1px 0 rgba(255,255,255,0.1),
                inset 0 -18px 30px rgba(0,0,0,0.22),
                0 20px 60px rgba(2, 6, 15, 0.48);
            }

            .capsule::before {
              content: "";
              position: absolute;
              inset: 0;
              background:
                radial-gradient(circle at 18% 18%, ${this.withOpacity(color, 0.18)}, transparent 28%),
                radial-gradient(circle at 82% 115%, rgba(255,255,255,0.08), transparent 32%);
              pointer-events: none;
            }

            .capsule::after {
              content: "";
              position: absolute;
              inset: 1px;
              border-radius: 27px;
              border: 1px solid rgba(255,255,255,0.06);
              pointer-events: none;
            }

            .orb {
              position: absolute;
              width: 120px;
              height: 120px;
              right: -32px;
              top: -42px;
              border-radius: 999px;
              background: ${this.withOpacity(color, 0.2)};
              filter: blur(26px);
              opacity: 0.9;
              pointer-events: none;
            }

            .pulse-wrap {
              position: relative;
              width: 18px;
              height: 18px;
              z-index: 1;
            }

            .pulse {
              position: absolute;
              inset: 3px;
              width: 12px;
              height: 12px;
              border-radius: 999px;
              background: var(--accent);
              box-shadow:
                0 0 0 6px ${this.withOpacity(color, 0.14)},
                0 0 18px ${this.withOpacity(color, 0.28)};
            }

            .pulse-ring {
              position: absolute;
              inset: 0;
              border-radius: 999px;
              border: 1px solid ${this.withOpacity(color, 0.28)};
              opacity: 0.7;
            }

            .title {
              position: relative;
              z-index: 1;
              font-size: 15px;
              font-weight: 600;
              line-height: 1.1;
              letter-spacing: 0.01em;
            }

            .subtitle {
              position: relative;
              z-index: 1;
              margin-top: 4px;
              font-size: 12px;
              color: rgba(235, 242, 250, 0.72);
              line-height: 1.2;
            }

            .status-thinking {
              background:
                linear-gradient(180deg, rgba(16, 14, 12, 0.72), rgba(8, 9, 14, 0.92)),
                radial-gradient(circle at top left, rgba(255, 255, 255, 0.08), transparent 44%);
            }

            .status-thinking .pulse-ring {
              animation: ring-breathe 1.8s ease-in-out infinite;
            }

            .status-listening .pulse-ring,
            .status-speaking .pulse-ring {
              animation: ring-breathe 2.2s ease-in-out infinite;
            }

            @keyframes ring-breathe {
              0%, 100% {
                transform: scale(0.94);
                opacity: 0.42;
              }

              50% {
                transform: scale(1.08);
                opacity: 0.88;
              }
            }
          </style>
        </head>
        <body>
          <div class="capsule ${statusClass}">
            <div class="orb"></div>
            <div class="pulse-wrap">
              <div class="pulse-ring"></div>
              <div class="pulse"></div>
            </div>
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
