const conversationElement = queryRequired<HTMLElement>('#conversation');
const statusChipElement = queryRequired<HTMLElement>('#status-chip');
const statusLabelElement = queryRequired<HTMLElement>('#status-label');
const voiceToggleElement = queryRequired<HTMLButtonElement>('#voice-toggle');
const composerFormElement = queryRequired<HTMLFormElement>('#composer-form');
const composerInputElement = queryRequired<HTMLTextAreaElement>('#composer-input');
const composerButtonElement = queryRequired<HTMLButtonElement>('#composer-button');

let pendingAssistantMessageElement: HTMLElement | undefined;
let assistantStreamActive = false;
let typingIndicatorElement: HTMLElement | undefined;
let pendingScrollFrame = 0;

void initializePanel();

async function initializePanel(): Promise<void> {
  renderStatus(await window.sonny.getStatus());
  renderConversation(await window.sonny.listConversation());
  renderVoiceMode(await window.sonny.getVoiceMode());
  syncComposerHeight();

  window.sonny.onStatusChanged((snapshot) => {
    renderStatus(snapshot);
  });
  window.sonny.onVoiceModeChanged((snapshot) => {
    renderVoiceMode(snapshot);
  });
  window.sonny.onToken((token) => {
    appendStreamToken(token);
  });
  window.sonny.onTokenEnd((message) => {
    finalizePendingAssistantMessage(message);
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
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      composerFormElement.requestSubmit();
    }
  });
  composerInputElement.addEventListener('input', () => {
    syncComposerHeight();
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
      syncComposerHeight();
      beginAssistantStream();
      await window.sonny.sendMessage(message);
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
  statusChipElement.dataset.status = snapshot.status;
  statusChipElement.style.color = getStatusColor(snapshot.status);
  statusChipElement.style.setProperty('--status-glow', getStatusGlow(snapshot.status));
  statusLabelElement.textContent = getStatusLabel(snapshot.status);

  if (snapshot.status === 'thinking' && !assistantStreamActive) {
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
  assistantStreamActive = false;
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

  queueConversationScroll(false);
}

function appendMessage(
  role: 'user' | 'assistant',
  content: string,
  timestamp: number,
  animate = true,
): HTMLElement {
  const emptyState = conversationElement.querySelector('.empty');

  if (emptyState !== null) {
    emptyState.remove();
  }

  const messageElement = document.createElement('article');
  messageElement.className = `message message-${role}`;
  setMessageContent(messageElement, content);
  messageElement.dataset.timestamp = formatTimestamp(timestamp);
  messageElement.title = formatTimestamp(timestamp);

  if (animate) {
    messageElement.classList.add('message-enter');
    messageElement.addEventListener(
      'animationend',
      () => {
        messageElement.classList.remove('message-enter');
      },
      { once: true },
    );
  }

  hideTypingIndicator();
  conversationElement.append(messageElement);
  queueConversationScroll(animate);

  return messageElement;
}

function beginAssistantStream(): void {
  assistantStreamActive = true;
  hideTypingIndicator();

  if (pendingAssistantMessageElement !== undefined) {
    setMessageContent(pendingAssistantMessageElement, '');
    showStreamingCursor(pendingAssistantMessageElement);
    queueConversationScroll(true);
    return;
  }

  pendingAssistantMessageElement = appendMessage('assistant', '', Date.now());
  showStreamingCursor(pendingAssistantMessageElement);
}

function appendStreamToken(token: string): void {
  if (pendingAssistantMessageElement === undefined) {
    beginAssistantStream();
  }

  const messageElement = pendingAssistantMessageElement;

  if (messageElement === undefined) {
    return;
  }

  const currentContent = getMessageContent(messageElement);
  setMessageContent(messageElement, currentContent + token);
  showStreamingCursor(messageElement);
  queueConversationScroll(true);
}

function finalizePendingAssistantMessage(content?: string): void {
  if (pendingAssistantMessageElement === undefined) {
    if ((content ?? '').length > 0) {
      appendMessage('assistant', content ?? '', Date.now());
    }

    assistantStreamActive = false;
    hideTypingIndicator();
    queueConversationScroll(true);
    return;
  }

  if (content !== undefined) {
    setMessageContent(pendingAssistantMessageElement, content);
  }

  hideStreamingCursor(pendingAssistantMessageElement);
  pendingAssistantMessageElement = undefined;
  assistantStreamActive = false;
  hideTypingIndicator();
  queueConversationScroll(true);
}

function showTypingIndicator(): void {
  if (typingIndicatorElement !== undefined) {
    queueConversationScroll(true);
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
  queueConversationScroll(true);
}

function hideTypingIndicator(): void {
  typingIndicatorElement?.remove();
  typingIndicatorElement = undefined;
}

function getMessageContent(messageElement: HTMLElement): string {
  return messageElement.querySelector<HTMLElement>('.message-content')?.textContent ?? '';
}

function setMessageContent(messageElement: HTMLElement, content: string): void {
  let contentElement = messageElement.querySelector<HTMLElement>('.message-content');

  if (contentElement === null) {
    contentElement = document.createElement('span');
    contentElement.className = 'message-content';
    messageElement.prepend(contentElement);
  }

  contentElement.textContent = content;
}

function showStreamingCursor(messageElement: HTMLElement): void {
  if (messageElement.querySelector('.stream-cursor') !== null) {
    return;
  }

  const cursorElement = document.createElement('span');
  cursorElement.className = 'stream-cursor';
  cursorElement.setAttribute('aria-hidden', 'true');
  messageElement.append(cursorElement);
}

function hideStreamingCursor(messageElement: HTMLElement): void {
  messageElement.querySelector('.stream-cursor')?.remove();
}

function queueConversationScroll(smooth: boolean): void {
  if (pendingScrollFrame !== 0) {
    cancelAnimationFrame(pendingScrollFrame);
  }

  pendingScrollFrame = requestAnimationFrame(() => {
    pendingScrollFrame = 0;
    scrollConversationToBottom(smooth);
  });
}

function scrollConversationToBottom(smooth: boolean): void {
  conversationElement.scrollTo({
    top: conversationElement.scrollHeight,
    behavior: smooth ? 'smooth' : 'auto',
  });
}

function syncComposerHeight(): void {
  composerInputElement.style.height = '0px';
  composerInputElement.style.height = `${Math.min(composerInputElement.scrollHeight, 132)}px`;
}

function getStatusLabel(status: string): string {
  switch (status) {
    case 'listening':
      return 'Listening...';
    case 'thinking':
      return 'Thinking...';
    case 'speaking':
      return 'Speaking...';
    case 'idle':
    default:
      return 'Ready';
  }
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
      return '#8bf5e7';
    case 'thinking':
      return '#ffc089';
    case 'speaking':
      return '#9bc2ff';
    case 'idle':
    default:
      return '#b6c4d4';
  }
}

function getStatusGlow(status: string): string {
  switch (status) {
    case 'listening':
      return 'rgba(45, 212, 191, 0.18)';
    case 'thinking':
      return 'rgba(251, 146, 60, 0.18)';
    case 'speaking':
      return 'rgba(96, 165, 250, 0.18)';
    case 'idle':
    default:
      return 'rgba(148, 163, 184, 0.12)';
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
