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

export interface SonnyBridge {
  getStatus(): Promise<UiStatusSnapshot>;
  setStatus(status: UiStatus): Promise<UiStatusSnapshot>;
  listConversation(): Promise<UiConversationEntry[]>;
  sendMessage(message: string): Promise<string>;
  showCapsule(): Promise<void>;
  hideCapsule(): Promise<void>;
  togglePanel(): Promise<void>;
  onStatusChanged(listener: (snapshot: UiStatusSnapshot) => void): () => void;
}

const sonnyBridge: SonnyBridge = {
  getStatus: async () => ipcRenderer.invoke('ui:get-status'),
  setStatus: async (status) => ipcRenderer.invoke('ui:set-status', status),
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
};

contextBridge.exposeInMainWorld('sonny', sonnyBridge);

declare global {
  interface Window {
    sonny: SonnyBridge;
  }
}
