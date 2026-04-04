const state = {
  memoryDocuments: [],
  selectedMemoryName: null,
};

const elements = {
  connectionStatus: document.querySelector('#connection-status'),
  refreshButton: document.querySelector('#refresh-button'),
  statusUpdated: document.querySelector('#status-updated'),
  statusGateway: document.querySelector('#status-gateway'),
  statusVoice: document.querySelector('#status-voice'),
  statusMemoryCount: document.querySelector('#status-memory-count'),
  statusConversationCount: document.querySelector('#status-conversation-count'),
  statusSkillCount: document.querySelector('#status-skill-count'),
  statusMemoryDirectory: document.querySelector('#status-memory-directory'),
  memorySelect: document.querySelector('#memory-select'),
  memoryReloadButton: document.querySelector('#memory-reload-button'),
  memorySaveButton: document.querySelector('#memory-save-button'),
  memoryEditor: document.querySelector('#memory-editor'),
  memoryUpdated: document.querySelector('#memory-updated'),
  memoryPath: document.querySelector('#memory-path'),
  skillsDirectory: document.querySelector('#skills-directory'),
  skillsList: document.querySelector('#skills-list'),
  conversationsList: document.querySelector('#conversations-list'),
};

function assertElement(element, name) {
  if (element === null) {
    throw new Error(`Missing element: ${name}`);
  }

  return element;
}

const connectionStatus = assertElement(elements.connectionStatus, 'connection-status');
const refreshButton = assertElement(elements.refreshButton, 'refresh-button');
const statusUpdated = assertElement(elements.statusUpdated, 'status-updated');
const statusGateway = assertElement(elements.statusGateway, 'status-gateway');
const statusVoice = assertElement(elements.statusVoice, 'status-voice');
const statusMemoryCount = assertElement(elements.statusMemoryCount, 'status-memory-count');
const statusConversationCount = assertElement(
  elements.statusConversationCount,
  'status-conversation-count',
);
const statusSkillCount = assertElement(elements.statusSkillCount, 'status-skill-count');
const statusMemoryDirectory = assertElement(
  elements.statusMemoryDirectory,
  'status-memory-directory',
);
const memorySelect = assertElement(elements.memorySelect, 'memory-select');
const memoryReloadButton = assertElement(
  elements.memoryReloadButton,
  'memory-reload-button',
);
const memorySaveButton = assertElement(elements.memorySaveButton, 'memory-save-button');
const memoryEditor = assertElement(elements.memoryEditor, 'memory-editor');
const memoryUpdated = assertElement(elements.memoryUpdated, 'memory-updated');
const memoryPath = assertElement(elements.memoryPath, 'memory-path');
const skillsDirectory = assertElement(elements.skillsDirectory, 'skills-directory');
const skillsList = assertElement(elements.skillsList, 'skills-list');
const conversationsList = assertElement(elements.conversationsList, 'conversations-list');

async function requestJson(path, options) {
  const response = await fetch(path, options);

  if (!response.ok) {
    const payload = await safeReadJson(response);
    const message =
      payload !== null && typeof payload.error === 'string'
        ? payload.error
        : `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return response.json();
}

async function safeReadJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function refreshDashboard() {
  setConnectionState('Loading', false);

  try {
    const [statusPayload, memoryPayload, conversationsPayload, skillsPayload] =
      await Promise.all([
        requestJson('/api/status'),
        requestJson('/api/memory'),
        requestJson('/api/conversations?limit=20'),
        requestJson('/api/skills'),
      ]);

    renderStatus(statusPayload);
    renderMemoryDocuments(memoryPayload.documents);
    renderConversations(conversationsPayload.messages);
    renderSkills(skillsPayload.directory, skillsPayload.skills);
    setConnectionState('Connected', true);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    setConnectionState(`Error: ${message}`, false);
    renderEmptyState(skillsList, 'Unable to load skills.');
    renderEmptyState(conversationsList, 'Unable to load recent conversations.');
    memoryUpdated.textContent = 'Memory load failed';
  }
}

function renderStatus(payload) {
  statusUpdated.textContent = formatTimestamp(payload.checkedAt);
  statusGateway.textContent = payload.gateway.attached
    ? `Attached (${payload.gateway.messageCount} messages)`
    : 'Detached';
  statusVoice.textContent = payload.voice.attached
    ? `${payload.voice.state} (${payload.voice.running ? 'running' : 'stopped'})`
    : 'Detached';
  statusMemoryCount.textContent = String(payload.memory.documentCount);
  statusConversationCount.textContent = String(payload.conversations.recentCount);
  statusSkillCount.textContent = String(payload.skills.count);
  statusMemoryDirectory.textContent = payload.memory.directory;
  skillsDirectory.textContent = payload.skills.directory;
}

function renderMemoryDocuments(documents) {
  state.memoryDocuments = documents;

  if (documents.length === 0) {
    state.selectedMemoryName = null;
    memorySelect.replaceChildren();
    memoryEditor.value = '';
    memoryUpdated.textContent = 'No memory documents found';
    memoryPath.textContent = 'No editable memory file is available.';
    return;
  }

  const selectionStillExists = documents.some(
    (document) => document.name === state.selectedMemoryName,
  );

  if (!selectionStillExists) {
    state.selectedMemoryName = documents[0].name;
  }

  memorySelect.replaceChildren(
    ...documents.map((memoryDocument) => {
      const option = document.createElement('option');
      option.value = memoryDocument.name;
      option.textContent = memoryDocument.name;
      return option;
    }),
  );
  memorySelect.value = state.selectedMemoryName;

  renderSelectedMemory();
}

function renderSelectedMemory() {
  const selected = state.memoryDocuments.find(
    (document) => document.name === state.selectedMemoryName,
  );

  if (selected === undefined) {
    memoryEditor.value = '';
    memoryUpdated.textContent = 'No document selected';
    memoryPath.textContent = 'Choose a memory document to inspect.';
    return;
  }

  memoryEditor.value = selected.content;
  memoryUpdated.textContent = `Updated ${formatTimestamp(selected.updatedAt)}`;
  memoryPath.textContent = selected.path;
}

function renderConversations(messages) {
  if (messages.length === 0) {
    renderEmptyState(conversationsList, 'No recent conversation entries found.');
    return;
  }

  conversationsList.replaceChildren(
    ...messages.map((message) => {
      const item = document.createElement('article');
      item.className = 'list-item';

      const title = document.createElement('strong');
      title.textContent = `${message.role} · ${formatTimestamp(message.createdAt)}`;

      const body = document.createElement('p');
      body.textContent = message.content;

      const meta = document.createElement('p');
      meta.className = 'meta';
      meta.textContent = `Session ${truncateSessionId(message.sessionId)}`;

      item.append(title, body, meta);
      return item;
    }),
  );
}

function renderSkills(directory, skills) {
  skillsDirectory.textContent = directory;

  if (skills.length === 0) {
    renderEmptyState(skillsList, 'No installed skill modules were discovered.');
    return;
  }

  skillsList.replaceChildren(
    ...skills.map((skill) => {
      const item = document.createElement('article');
      item.className = 'list-item';

      const title = document.createElement('strong');
      title.textContent = skill.name;

      const meta = document.createElement('p');
      meta.className = 'meta';
      meta.textContent = `${skill.implemented ? 'Implemented' : 'Stub'} · ${skill.path}`;

      item.append(title, meta);
      return item;
    }),
  );
}

function renderEmptyState(container, message) {
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = message;
  container.replaceChildren(empty);
}

async function reloadMemoryDocuments() {
  const payload = await requestJson('/api/memory');
  renderMemoryDocuments(payload.documents);
}

async function saveMemoryDocument() {
  const name = memorySelect.value;

  if (name.length === 0) {
    return;
  }

  memorySaveButton.disabled = true;
  memorySaveButton.textContent = 'Saving';

  try {
    const payload = await requestJson('/api/memory', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        content: memoryEditor.value,
      }),
    });
    const nextDocument = payload.document;
    state.memoryDocuments = state.memoryDocuments.map((document) =>
      document.name === nextDocument.name ? nextDocument : document,
    );
    state.selectedMemoryName = nextDocument.name;
    renderSelectedMemory();
    await refreshStatusOnly();
  } finally {
    memorySaveButton.disabled = false;
    memorySaveButton.textContent = 'Save Memory';
  }
}

async function refreshStatusOnly() {
  const payload = await requestJson('/api/status');
  renderStatus(payload);
}

function truncateSessionId(value) {
  if (typeof value !== 'string' || value.length <= 12) {
    return value;
  }

  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function formatTimestamp(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function setConnectionState(label, connected) {
  connectionStatus.textContent = label;
  connectionStatus.style.background = connected
    ? 'rgba(47, 107, 79, 0.12)'
    : 'rgba(184, 92, 56, 0.14)';
  connectionStatus.style.color = connected ? '#2f6b4f' : '#8f4022';
}

function handleActionError(error) {
  const message = error instanceof Error ? error.message : 'Unknown error';
  setConnectionState(`Error: ${message}`, false);
}

refreshButton.addEventListener('click', () => {
  void refreshDashboard();
});

memoryReloadButton.addEventListener('click', () => {
  void reloadMemoryDocuments().catch(handleActionError);
});

memorySaveButton.addEventListener('click', () => {
  void saveMemoryDocument().catch(handleActionError);
});

memorySelect.addEventListener('change', () => {
  state.selectedMemoryName = memorySelect.value;
  renderSelectedMemory();
});

void refreshDashboard();
