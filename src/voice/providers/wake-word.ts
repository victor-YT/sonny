export type WakeWordEventType = 'detected' | 'error' | 'ready';

export interface WakeWordEvent {
  type: WakeWordEventType;
  keyword?: string;
  timestamp?: number;
  error?: Error;
}

export type WakeWordListener = (event: WakeWordEvent) => void;

export interface WakeWordProvider {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly isListening: boolean;
  onDetection(listener: WakeWordListener): void;
  removeListener(listener: WakeWordListener): void;
}

export interface WakeWordConfig {
  keywords: string[];
  sensitivity?: number;
  audioDeviceIndex?: number;
}
