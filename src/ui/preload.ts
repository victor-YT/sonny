import { contextBridge, ipcRenderer } from 'electron';

export type UiStatus = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface UiStatusSnapshot {
  status: UiStatus;
  lastUpdatedAt: number;
}

export interface UiConversationEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface UiVoiceModeSnapshot {
  enabled: boolean;
  available: boolean;
}

export interface SonnyBridge {
  getStatus(): Promise<UiStatusSnapshot>;
  setStatus(status: UiStatus): Promise<UiStatusSnapshot>;
  getVoiceMode(): Promise<UiVoiceModeSnapshot>;
  toggleVoiceMode(): Promise<UiVoiceModeSnapshot>;
  listConversation(): Promise<UiConversationEntry[]>;
  sendMessage(message: string): Promise<string>;
  showCapsule(): Promise<void>;
  hideCapsule(): Promise<void>;
  togglePanel(): Promise<void>;
  onStatusChanged(listener: (snapshot: UiStatusSnapshot) => void): () => void;
  onVoiceModeChanged(
    listener: (snapshot: UiVoiceModeSnapshot) => void,
  ): () => void;
  onStreamToken(listener: (token: string) => void): () => void;
}

const sonnyBridge: SonnyBridge = {
  getStatus: async () => ipcRenderer.invoke('ui:get-status'),
  setStatus: async (status) => ipcRenderer.invoke('ui:set-status', status),
  getVoiceMode: async () => ipcRenderer.invoke('ui:get-voice-mode'),
  toggleVoiceMode: async () => ipcRenderer.invoke('ui:toggle-voice-mode'),
  listConversation: async () => ipcRenderer.invoke('gateway:list-conversation'),
  sendMessage: async (message) => ipcRenderer.invoke('gateway:send-message', message),
  showCapsule: async () => {
    await ipcRenderer.invoke('ui:show-capsule');
  },
  hideCapsule: async () => {
    await ipcRenderer.invoke('ui:hide-capsule');
  },
  togglePanel: async () => {
    await ipcRenderer.invoke('ui:toggle-panel');
  },
  onStatusChanged: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      snapshot: UiStatusSnapshot,
    ) => {
      listener(snapshot);
    };

    ipcRenderer.on('ui:status-changed', wrappedListener);

    return () => {
      ipcRenderer.removeListener('ui:status-changed', wrappedListener);
    };
  },
  onVoiceModeChanged: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      snapshot: UiVoiceModeSnapshot,
    ) => {
      listener(snapshot);
    };

    ipcRenderer.on('ui:voice-mode-changed', wrappedListener);

    return () => {
      ipcRenderer.removeListener('ui:voice-mode-changed', wrappedListener);
    };
  },
  onStreamToken: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      token: string,
    ) => {
      listener(token);
    };

    ipcRenderer.on('gateway:stream-token', wrappedListener);

    return () => {
      ipcRenderer.removeListener('gateway:stream-token', wrappedListener);
    };
  },
};

contextBridge.exposeInMainWorld('sonny', sonnyBridge);

declare global {
  interface Window {
    sonny: SonnyBridge;
  }
}
