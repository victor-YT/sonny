const conversationElement = queryRequired<HTMLElement>('#conversation');
const statusLabelElement = queryRequired<HTMLElement>('#status-label');
const statusDotElement = queryRequired<HTMLElement>('#status-dot');
const composerFormElement = queryRequired<HTMLFormElement>('#composer-form');
const composerInputElement = queryRequired<HTMLInputElement>('#composer-input');
const composerButtonElement = queryRequired<HTMLButtonElement>('#composer-button');

void initializePanel();

async function initializePanel(): Promise<void> {
  renderStatus(await window.sonny.getStatus());
  renderConversation(await window.sonny.listConversation());

  window.sonny.onStatusChanged((snapshot) => {
    renderStatus(snapshot);
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
      const response = await window.sonny.sendMessage(message);
      composerInputElement.value = '';
      appendMessage('user', message);
      appendMessage('assistant', response);
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
}

function renderConversation(
  conversation: Array<{ role: 'user' | 'assistant'; content: string }>,
): void {
  conversationElement.replaceChildren();

  if (conversation.length === 0) {
    const emptyState = document.createElement('div');
    emptyState.className = 'empty';
    emptyState.textContent = 'Recent conversation will appear here once Sonny has something worth remembering.';
    conversationElement.append(emptyState);
    return;
  }

  for (const entry of conversation) {
    appendMessage(entry.role, entry.content);
  }
}

function appendMessage(role: 'user' | 'assistant', content: string): void {
  const emptyState = conversationElement.querySelector('.empty');

  if (emptyState !== null) {
    emptyState.remove();
  }

  const messageElement = document.createElement('article');
  messageElement.className = `message message-${role}`;
  messageElement.textContent = content;

  conversationElement.append(messageElement);
  conversationElement.scrollTop = conversationElement.scrollHeight;
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
