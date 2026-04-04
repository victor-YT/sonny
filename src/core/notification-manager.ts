import type { VoiceManager } from '../voice/voice-manager.js';
import {
  Notifier,
  type NotificationChannel,
  type NotificationPayload,
} from './notifier.js';

export type NotificationPreference = 'voice' | 'visual' | 'both';
export type NotificationState = 'voice_active' | 'idle';

export interface NotificationManagerConfig {
  notifier: Notifier;
  preference?: NotificationPreference;
  getState?: () => NotificationState;
  voiceManager?: Pick<VoiceManager, 'currentState' | 'isRunning'>;
}

export class NotificationManager {
  private readonly notifier: Notifier;
  private readonly stateResolver: () => NotificationState;
  private preference: NotificationPreference;

  public constructor(config: NotificationManagerConfig) {
    this.notifier = config.notifier;
    this.preference = config.preference ?? 'both';
    this.stateResolver =
      config.getState ??
      (() => this.resolveStateFromVoiceManager(config.voiceManager));
  }

  public getPreference(): NotificationPreference {
    return this.preference;
  }

  public setPreference(preference: NotificationPreference): void {
    this.preference = preference;
  }

  public getState(): NotificationState {
    return this.stateResolver();
  }

  public async notify(payload: NotificationPayload): Promise<void> {
    await this.notifier.notify(payload, this.getChannels());
  }

  public getChannels(): NotificationChannel[] {
    if (this.preference === 'voice') {
      return ['voice'];
    }

    if (this.preference === 'visual') {
      return ['native', 'tray'];
    }

    return this.getState() === 'voice_active'
      ? ['voice']
      : ['native', 'tray'];
  }

  private resolveStateFromVoiceManager(
    voiceManager: Pick<VoiceManager, 'currentState' | 'isRunning'> | undefined,
  ): NotificationState {
    if (voiceManager === undefined || !voiceManager.isRunning) {
      return 'idle';
    }

    switch (voiceManager.currentState) {
      case 'idle':
      case 'error':
        return 'idle';
      default:
        return 'voice_active';
    }
  }
}
