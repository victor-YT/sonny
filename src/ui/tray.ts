import { type NativeImage, Tray, nativeImage } from 'electron';

export type TrayStatus = 'idle' | 'listening' | 'thinking' | 'speaking';

interface StatusStyle {
  background: string;
  foreground: string;
  label: string;
}

const ICON_WIDTH = 20;
const ICON_HEIGHT = 20;

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

  public constructor(config: TrayControllerConfig = {}) {
    this.tooltip = config.tooltip ?? 'Sonny';
  }

  public create(): Tray {
    if (this.tray !== undefined) {
      return this.tray;
    }

    this.tray = new Tray(this.createImage(this.status));
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

  private applyStatus(status: TrayStatus): void {
    if (this.tray === undefined) {
      return;
    }

    const style = STATUS_STYLES[status];
    this.tray.setImage(this.createImage(status));
    this.tray.setToolTip(`${this.tooltip} · ${style.label}`);
  }

  private createImage(status: TrayStatus): NativeImage {
    const style = STATUS_STYLES[status];
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${ICON_WIDTH}" height="${ICON_HEIGHT}" viewBox="0 0 ${ICON_WIDTH} ${ICON_HEIGHT}">
        <rect x="1.5" y="4" width="17" height="12" rx="6" fill="${style.background}" />
        <circle cx="6.5" cy="10" r="2.5" fill="${style.foreground}" />
        <rect x="10" y="8.5" width="5" height="3" rx="1.5" fill="${style.foreground}" opacity="0.88" />
      </svg>
    `.trim();

    return nativeImage.createFromDataURL(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    );
  }
}
