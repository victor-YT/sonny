import nodeNotifier from 'node-notifier';

import type { VoiceManager } from '../voice/voice-manager.js';

export type NotificationChannel = 'native' | 'voice' | 'tray';

export interface NotificationPayload {
  title: string;
  message: string;
  subtitle?: string;
  badge?: string;
  voiceText?: string;
}

export interface TrayBadgeController {
  setBadge(label?: string): void;
}

export interface NativeNotifier {
  notify(options: {
    title: string;
    message: string;
    subtitle?: string;
    sound?: boolean;
    wait?: boolean;
  }): void;
}

export interface NotifierConfig {
  voiceManager?: Pick<VoiceManager, 'speak'>;
  trayBadgeController?: TrayBadgeController;
  nativeNotifier?: NativeNotifier;
  enableNativeNotifications?: boolean;
  badgeClearDelayMs?: number;
}

const DEFAULT_BADGE_CLEAR_DELAY_MS = 15_000;

export class Notifier {
  private readonly voiceManager: Pick<VoiceManager, 'speak'> | undefined;
  private readonly trayBadgeController: TrayBadgeController | undefined;
  private readonly nativeNotifier: NativeNotifier;
  private readonly enableNativeNotifications: boolean;
  private readonly badgeClearDelayMs: number;
  private badgeClearTimeout: NodeJS.Timeout | undefined;

  public constructor(config: NotifierConfig = {}) {
    this.voiceManager = config.voiceManager;
    this.trayBadgeController = config.trayBadgeController;
    this.nativeNotifier = config.nativeNotifier ?? nodeNotifier;
    this.enableNativeNotifications =
      config.enableNativeNotifications ?? process.platform === 'darwin';
    this.badgeClearDelayMs =
      config.badgeClearDelayMs ?? DEFAULT_BADGE_CLEAR_DELAY_MS;
  }

  public async notify(
    payload: NotificationPayload,
    channels: NotificationChannel[],
  ): Promise<void> {
    for (const channel of channels) {
      if (channel === 'native') {
        this.notifyNative(payload);
        continue;
      }

      if (channel === 'tray') {
        this.notifyTray(payload);
        continue;
      }

      await this.notifyVoice(payload);
    }
  }

  public clearTrayBadge(): void {
    if (this.badgeClearTimeout !== undefined) {
      clearTimeout(this.badgeClearTimeout);
      this.badgeClearTimeout = undefined;
    }

    this.trayBadgeController?.setBadge();
  }

  private notifyNative(payload: NotificationPayload): void {
    if (!this.enableNativeNotifications) {
      return;
    }

    this.nativeNotifier.notify({
      title: payload.title,
      message: payload.message,
      subtitle: payload.subtitle,
      sound: false,
      wait: false,
    });
  }

  private notifyTray(payload: NotificationPayload): void {
    if (this.trayBadgeController === undefined) {
      return;
    }

    this.trayBadgeController.setBadge(payload.badge ?? '•');

    if (this.badgeClearTimeout !== undefined) {
      clearTimeout(this.badgeClearTimeout);
    }

    this.badgeClearTimeout = setTimeout(() => {
      this.trayBadgeController?.setBadge();
      this.badgeClearTimeout = undefined;
    }, this.badgeClearDelayMs);
    this.badgeClearTimeout.unref();
  }

  private async notifyVoice(payload: NotificationPayload): Promise<void> {
    if (this.voiceManager === undefined) {
      return;
    }

    const voiceText =
      payload.voiceText ??
      `${payload.title}. ${payload.message}`.trim();

    if (voiceText.length === 0) {
      return;
    }

    await this.voiceManager.speak(voiceText);
  }
}
