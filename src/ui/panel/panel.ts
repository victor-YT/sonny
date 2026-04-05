const conversationElement = queryRequired<HTMLElement>('#conversation');
const statusLabelElement = queryRequired<HTMLElement>('#status-label');
const statusDotElement = queryRequired<HTMLElement>('#status-dot');
const voiceToggleElement = queryRequired<HTMLButtonElement>('#voice-toggle');
const composerFormElement = queryRequired<HTMLFormElement>('#composer-form');
const composerInputElement = queryRequired<HTMLInputElement>('#composer-input');
const composerButtonElement = queryRequired<HTMLButtonElement>('#composer-button');

let pendingAssistantMessageElement: HTMLElement | undefined;
let typingIndicatorElement: HTMLElement | undefined;

void initializePanel();

async function initializePanel(): Promise<void> {
  renderStatus(await window.sonny.getStatus());
  renderConversation(await window.sonny.listConversation());
  renderVoiceMode(await window.sonny.getVoiceMode());

  window.sonny.onStatusChanged((snapshot) => {
    renderStatus(snapshot);
  });
  window.sonny.onVoiceModeChanged((snapshot) => {
    renderVoiceMode(snapshot);
  });
  window.sonny.onStreamToken((token) => {
    appendStreamToken(token);
  });

  voiceToggleElement.addEventListener('click', async () => {
    voiceToggleElement.disabled = true;

    try {
      renderVoiceMode(await window.sonny.toggleVoiceMode());
    } finally {
      voiceToggleElement.disabled = false;
    }
  });

  composerInputElement.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.metaKey) {
      event.preventDefault();
      composerFormElement.requestSubmit();
    }
  });

  composerFormElement.addEventListener('submit', async (event) => {
    event.preventDefault();

    const message = composerInputElement.value.trim();

    if (message.length === 0) {
      return;
    }

    composerButtonElement.disabled = true;
    composerInputElement.disabled = true;

    try {
      appendMessage('user', message, Date.now());
      composerInputElement.value = '';
      showTypingIndicator();
      pendingAssistantMessageElement = undefined;
      const response = await window.sonny.sendMessage(message);
      finalizePendingAssistantMessage(response);
    } catch (error: unknown) {
      finalizePendingAssistantMessage(`Message failed: ${toErrorMessage(error)}`);
    } finally {
      composerButtonElement.disabled = false;
      composerInputElement.disabled = false;
      composerInputElement.focus();
    }
  });
}

function renderStatus(snapshot: { status: string }): void {
  const label = snapshot.status.charAt(0).toUpperCase() + snapshot.status.slice(1);

  statusLabelElement.textContent = label;
  statusDotElement.style.background = getStatusColor(snapshot.status);
  statusDotElement.style.boxShadow = `0 0 0 6px ${getStatusGlow(snapshot.status)}`;

  if (snapshot.status === 'thinking') {
    showTypingIndicator();
    return;
  }

  hideTypingIndicator();
}

function renderVoiceMode(snapshot: {
  enabled: boolean;
  available: boolean;
}): void {
  voiceToggleElement.classList.toggle('voice-toggle-enabled', snapshot.enabled);
  voiceToggleElement.disabled = !snapshot.available;

  if (!snapshot.available) {
    voiceToggleElement.textContent = 'Voice N/A';
    voiceToggleElement.title = 'Voice mode is unavailable in this session.';
    return;
  }

  voiceToggleElement.textContent = snapshot.enabled ? 'Voice On' : 'Voice Off';
  voiceToggleElement.title = snapshot.enabled
    ? 'Disable voice mode'
    : 'Enable voice mode';
}

function renderConversation(
  conversation: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>,
): void {
  conversationElement.replaceChildren();
  pendingAssistantMessageElement = undefined;
  typingIndicatorElement = undefined;

  if (conversation.length === 0) {
    const emptyState = document.createElement('div');
    emptyState.className = 'empty';
    emptyState.textContent =
      'Recent conversation will appear here once Sonny has something worth remembering.';
    conversationElement.append(emptyState);
    return;
  }

  for (const entry of conversation) {
    appendMessage(entry.role, entry.content, entry.timestamp, false);
  }

  scrollConversationToBottom(false);
}

function appendMessage(
  role: 'user' | 'assistant',
  content: string,
  timestamp: number,
  smooth = true,
): HTMLElement {
  const emptyState = conversationElement.querySelector('.empty');

  if (emptyState !== null) {
    emptyState.remove();
  }

  const messageElement = document.createElement('article');
  messageElement.className = `message message-${role}`;
  messageElement.textContent = content;
  messageElement.dataset.timestamp = formatTimestamp(timestamp);
  messageElement.title = formatTimestamp(timestamp);

  hideTypingIndicator();
  conversationElement.append(messageElement);
  scrollConversationToBottom(smooth);

  return messageElement;
}

function appendStreamToken(token: string): void {
  if (pendingAssistantMessageElement === undefined) {
    pendingAssistantMessageElement = appendMessage('assistant', token, Date.now());
    return;
  }

  pendingAssistantMessageElement.textContent =
    (pendingAssistantMessageElement.textContent ?? '') + token;
  scrollConversationToBottom(true);
}

function finalizePendingAssistantMessage(content: string): void {
  if (pendingAssistantMessageElement === undefined) {
    pendingAssistantMessageElement = appendMessage('assistant', content, Date.now());
  } else {
    pendingAssistantMessageElement.textContent = content;
  }

  pendingAssistantMessageElement = undefined;
  hideTypingIndicator();
  scrollConversationToBottom(true);
}

function showTypingIndicator(): void {
  if (typingIndicatorElement !== undefined) {
    scrollConversationToBottom(true);
    return;
  }

  const emptyState = conversationElement.querySelector('.empty');

  if (emptyState !== null) {
    emptyState.remove();
  }

  const indicator = document.createElement('div');
  indicator.className = 'typing-indicator';
  indicator.setAttribute('aria-label', 'Sonny is thinking');

  for (let index = 0; index < 3; index += 1) {
    const dot = document.createElement('span');
    dot.className = 'typing-dot';
    indicator.append(dot);
  }

  typingIndicatorElement = indicator;
  conversationElement.append(indicator);
  scrollConversationToBottom(true);
}

function hideTypingIndicator(): void {
  typingIndicatorElement?.remove();
  typingIndicatorElement = undefined;
}

function scrollConversationToBottom(smooth: boolean): void {
  conversationElement.scrollTo({
    top: conversationElement.scrollHeight,
    behavior: smooth ? 'smooth' : 'auto',
  });
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'listening':
      return '#2dd4bf';
    case 'thinking':
      return '#fb923c';
    case 'speaking':
      return '#60a5fa';
    case 'idle':
    default:
      return '#94a3b8';
  }
}

function getStatusGlow(status: string): string {
  switch (status) {
    case 'listening':
      return 'rgba(45, 212, 191, 0.14)';
    case 'thinking':
      return 'rgba(251, 146, 60, 0.16)';
    case 'speaking':
      return 'rgba(96, 165, 250, 0.16)';
    case 'idle':
    default:
      return 'rgba(148, 163, 184, 0.14)';
  }
}

function queryRequired<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (element === null) {
    throw new Error(`Required panel element is missing: ${selector}`);
  }

  return element;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}
