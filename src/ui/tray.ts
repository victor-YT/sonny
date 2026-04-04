import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type NativeImage, Tray, nativeImage } from 'electron';

export type TrayStatus = 'idle' | 'listening' | 'thinking' | 'speaking';

interface StatusStyle {
  background: string;
  foreground: string;
  label: string;
}

const ICON_WIDTH = 20;
const ICON_HEIGHT = 20;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STATUS_STYLES: Record<TrayStatus, StatusStyle> = {
  idle: {
    background: '#202734',
    foreground: '#F4F7FB',
    label: 'Idle',
  },
  listening: {
    background: '#0F766E',
    foreground: '#E6FFFB',
    label: 'Listening',
  },
  thinking: {
    background: '#9A3412',
    foreground: '#FFF4E8',
    label: 'Thinking',
  },
  speaking: {
    background: '#1D4ED8',
    foreground: '#EFF6FF',
    label: 'Speaking',
  },
};

export interface TrayControllerConfig {
  tooltip?: string;
}

export class TrayController {
  private readonly tooltip: string;
  private tray: Tray | undefined;
  private status: TrayStatus = 'idle';
  private badge = '';

  public constructor(config: TrayControllerConfig = {}) {
    this.tooltip = config.tooltip ?? 'Sonny';
  }

  public create(): Tray {
    if (this.tray !== undefined) {
      return this.tray;
    }

    const image = this.createImage(this.status);

    console.log(
      `[tray] creating tray for status=${this.status} imageEmpty=${image.isEmpty()}`,
    );

    this.tray = new Tray(image);
    this.applyStatus(this.status);

    return this.tray;
  }

  public setStatus(status: TrayStatus): void {
    this.status = status;

    if (this.tray === undefined) {
      return;
    }

    this.applyStatus(status);
  }

  public getStatus(): TrayStatus {
    return this.status;
  }

  public setBadge(label?: string): void {
    this.badge = label?.trim() ?? '';

    if (this.tray === undefined) {
      return;
    }

    this.applyBadge();
  }

  private applyStatus(status: TrayStatus): void {
    if (this.tray === undefined) {
      return;
    }

    const style = STATUS_STYLES[status];
    this.tray.setImage(this.createImage(status));
    this.tray.setToolTip(`${this.tooltip} · ${style.label}`);
    this.applyBadge();
  }

  private applyBadge(): void {
    if (this.tray === undefined) {
      return;
    }

    this.tray.setTitle(this.badge);
  }

  private createImage(status: TrayStatus): NativeImage {
    const iconPath = this.resolveIconPath();

    if (iconPath !== undefined) {
      const fileImage = nativeImage.createFromPath(iconPath);

      console.log(
        `[tray] using icon file at ${iconPath} imageEmpty=${fileImage.isEmpty()}`,
      );

      if (!fileImage.isEmpty()) {
        fileImage.setTemplateImage(true);
        return fileImage.resize({
          width: ICON_WIDTH,
          height: ICON_HEIGHT,
        });
      }
    }

    const style = STATUS_STYLES[status];
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${ICON_WIDTH}" height="${ICON_HEIGHT}" viewBox="0 0 ${ICON_WIDTH} ${ICON_HEIGHT}">
        <rect x="1.5" y="4" width="17" height="12" rx="6" fill="#111827" />
        <circle cx="6.5" cy="10" r="2.5" fill="#ffffff" />
        <rect x="10" y="8.5" width="5" height="3" rx="1.5" fill="#ffffff" opacity="0.92" />
      </svg>
    `.trim();
    const image = nativeImage.createFromDataURL(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    );

    image.setTemplateImage(true);

    console.log(
      `[tray] no tray icon file found, using generated fallback for status=${status} expectedPaths=${this.getExpectedIconPaths().join(', ')}`,
    );

    return image;
  }

  private resolveIconPath(): string | undefined {
    for (const iconPath of this.getExpectedIconPaths()) {
      const exists = existsSync(iconPath);

      console.log(`[tray] checked icon path ${iconPath} exists=${exists}`);

      if (exists) {
        return iconPath;
      }
    }

    return undefined;
  }

  private getExpectedIconPaths(): string[] {
    return [
      join(__dirname, 'assets', 'tray-iconTemplate.png'),
      join(__dirname, 'assets', 'tray-icon.png'),
      join(process.cwd(), 'dist', 'ui', 'assets', 'tray-iconTemplate.png'),
      join(process.cwd(), 'dist', 'ui', 'assets', 'tray-icon.png'),
      join(process.cwd(), 'src', 'ui', 'assets', 'tray-iconTemplate.png'),
      join(process.cwd(), 'src', 'ui', 'assets', 'tray-icon.png'),
    ];
  }
}
