import { contextBridge, ipcRenderer } from 'electron';

console.log('[ui.preload] preload script loaded');

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
  getStatus: async () => {
    console.log('[ui.preload] invoking ui:get-status');
    const snapshot = await ipcRenderer.invoke('ui:get-status');
    console.log(`[ui.preload] ui:get-status resolved status=${snapshot.status}`);
    return snapshot;
  },
  setStatus: async (status) => {
    console.log(`[ui.preload] invoking ui:set-status status=${status}`);
    const snapshot = await ipcRenderer.invoke('ui:set-status', status);
    console.log(`[ui.preload] ui:set-status resolved status=${snapshot.status}`);
    return snapshot;
  },
  listConversation: async () => {
    console.log('[ui.preload] invoking gateway:list-conversation');
    const conversation = await ipcRenderer.invoke('gateway:list-conversation');
    console.log(
      `[ui.preload] gateway:list-conversation resolved entries=${conversation.length}`,
    );
    return conversation;
  },
  sendMessage: async (message) => {
    console.log(
      `[ui.preload] invoking gateway:send-message messageLength=${message.length}`,
    );
    const response = await ipcRenderer.invoke('gateway:send-message', message);
    console.log(
      `[ui.preload] gateway:send-message resolved responseLength=${response.length}`,
    );
    return response;
  },
  showCapsule: async () => {
    console.log('[ui.preload] invoking ui:show-capsule');
    await ipcRenderer.invoke('ui:show-capsule');
  },
  hideCapsule: async () => {
    console.log('[ui.preload] invoking ui:hide-capsule');
    await ipcRenderer.invoke('ui:hide-capsule');
  },
  togglePanel: async () => {
    console.log('[ui.preload] invoking ui:toggle-panel');
    await ipcRenderer.invoke('ui:toggle-panel');
  },
  onStatusChanged: (listener) => {
    console.log('[ui.preload] registering ui:status-changed listener');
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      snapshot: UiStatusSnapshot,
    ) => {
      console.log(
        `[ui.preload] ui:status-changed received status=${snapshot.status}`,
      );
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
