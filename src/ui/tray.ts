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

export interface TrayIconDebugInfo {
  expectedPaths: string[];
  resolvedPath: string | undefined;
  usingFallback: boolean;
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

  public getIconDebugInfo(): TrayIconDebugInfo {
    const expectedPaths = this.getExpectedIconPaths();
    const resolvedPath = this.resolveIconPathFromPaths(expectedPaths);

    return {
      expectedPaths,
      resolvedPath,
      usingFallback: resolvedPath === undefined,
    };
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

    const image = nativeImage.createEmpty();

    console.log(
      `[tray] no tray icon file found, using nativeImage.createEmpty() fallback for status=${status} expectedPaths=${this.getExpectedIconPaths().join(', ')}`,
    );

    return image;
  }

  private resolveIconPath(): string | undefined {
    return this.resolveIconPathFromPaths(this.getExpectedIconPaths());
  }

  private resolveIconPathFromPaths(paths: string[]): string | undefined {
    for (const iconPath of paths) {
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
