const state = {
  memoryDocuments: [],
  memoryDrafts: {},
  personality: null,
  voiceSettings: null,
};

function getElement(id) {
  const element = document.getElementById(id);

  if (element === null) {
    throw new Error(`Missing element: ${id}`);
  }

  return element;
}

const elements = {
  connectionStatus: getElement('connection-status'),
  refreshButton: getElement('refresh-button'),
  statusUpdated: getElement('status-updated'),
  statusGateway: getElement('status-gateway'),
  statusProvider: getElement('status-provider'),
  statusModel: getElement('status-model'),
  statusVoice: getElement('status-voice'),
  statusSessionId: getElement('status-session-id'),
  statusMemoryCount: getElement('status-memory-count'),
  statusConversationCount: getElement('status-conversation-count'),
  statusSkillCount: getElement('status-skill-count'),
  statusMemoryDirectory: getElement('status-memory-directory'),
  memoryDirectoryLabel: getElement('memory-directory-label'),
  configPath: getElement('config-path'),
  personalityPath: getElement('personality-path'),
  systemPromptLength: getElement('system-prompt-length'),
  systemPromptView: getElement('system-prompt-view'),
  memoryCards: getElement('memory-cards'),
  personalityForm: getElement('personality-form'),
  personalityVerbosity: getElement('personality-verbosity'),
  personalityAssertiveness: getElement('personality-assertiveness'),
  personalityHumor: getElement('personality-humor'),
  personalityVerbosityValue: getElement('personality-verbosity-value'),
  personalityAssertivenessValue: getElement('personality-assertiveness-value'),
  personalityHumorValue: getElement('personality-humor-value'),
  personalityVerbosityNote: getElement('personality-verbosity-note'),
  personalityAssertivenessNote: getElement('personality-assertiveness-note'),
  personalityHumorNote: getElement('personality-humor-note'),
  personalityStatus: getElement('personality-status'),
  personalitySaveButton: getElement('personality-save-button'),
  voiceSettingsForm: getElement('voice-settings-form'),
  wakeWordInput: getElement('wake-word-input'),
  voiceModelInput: getElement('voice-model-input'),
  voiceStatus: getElement('voice-status'),
  voiceSaveButton: getElement('voice-save-button'),
  currentSessionList: getElement('current-session-list'),
  recentHistoryList: getElement('recent-history-list'),
  skillsDirectory: getElement('skills-directory'),
  skillsList: getElement('skills-list'),
};

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
    const [
      statusPayload,
      memoryPayload,
      conversationsPayload,
      skillsPayload,
      personalityPayload,
      voiceSettingsPayload,
    ] = await Promise.all([
      requestJson('/api/status'),
      requestJson('/api/memory'),
      requestJson('/api/conversations?limit=50'),
      requestJson('/api/skills'),
      requestJson('/api/personality'),
      requestJson('/api/voice-settings'),
    ]);

    state.personality = personalityPayload.personality;
    state.voiceSettings = voiceSettingsPayload;

    renderStatus(statusPayload);
    renderMemoryDocuments(memoryPayload.documents);
    renderConversations(conversationsPayload);
    renderSkills(skillsPayload.skills);
    renderPersonality(state.personality);
    renderVoiceSettings(state.voiceSettings);
    setConnectionState('Connected', true);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    setConnectionState(`Error: ${message}`, false);
    renderEmptyState(elements.memoryCards, 'Unable to load memory documents.');
    renderEmptyState(elements.currentSessionList, 'Unable to load current session history.');
    renderEmptyState(elements.recentHistoryList, 'Unable to load persisted history.');
    renderEmptyState(elements.skillsList, 'Unable to load skills.');
    elements.personalityStatus.textContent = 'Personality load failed';
    elements.voiceStatus.textContent = 'Voice settings load failed';
  }
}

async function refreshStatusOnly() {
  const payload = await requestJson('/api/status');
  renderStatus(payload);
}

function renderStatus(payload) {
  elements.statusUpdated.textContent = formatTimestamp(payload.checkedAt);
  elements.statusGateway.textContent = payload.gateway.healthy
    ? `Healthy (${payload.gateway.messageCount} messages)`
    : 'Unavailable';
  elements.statusProvider.textContent = payload.gateway.provider ?? 'Unknown';
  elements.statusModel.textContent = payload.gateway.model ?? 'Unknown';
  elements.statusVoice.textContent = payload.voice.attached
    ? `${payload.voice.state} · ${payload.voice.running ? 'running' : 'stopped'}`
    : `Detached · wake "${payload.voice.wakeWord}"`;
  elements.statusSessionId.textContent = payload.gateway.sessionId === null
    ? 'No active session'
    : truncateSessionId(payload.gateway.sessionId);
  elements.statusMemoryCount.textContent = String(payload.memory.documentCount);
  elements.statusConversationCount.textContent = String(
    payload.conversations.currentSessionCount,
  );
  elements.statusSkillCount.textContent = String(payload.skills.count);
  elements.statusMemoryDirectory.textContent = payload.memory.directory;
  elements.memoryDirectoryLabel.textContent =
    `${payload.memory.documentCount} editable files`;
  elements.configPath.textContent = payload.paths.config;
  elements.personalityPath.textContent = payload.paths.personality;
  elements.systemPromptLength.textContent =
    `${payload.gateway.systemPromptLength} chars`;
  elements.systemPromptView.textContent = payload.gateway.systemPrompt.length > 0
    ? payload.gateway.systemPrompt
    : 'No system prompt recorded for the active session.';
  elements.skillsDirectory.textContent = payload.skills.attached
    ? `${payload.skills.count} registered`
    : 'Gateway not attached';
}

function renderMemoryDocuments(documents) {
  state.memoryDocuments = documents;

  if (documents.length === 0) {
    renderEmptyState(elements.memoryCards, 'No memory documents found.');
    return;
  }

  elements.memoryCards.replaceChildren(
    ...documents.map((documentPayload) => createMemoryCard(documentPayload)),
  );
}

function createMemoryCard(documentPayload) {
  const article = document.createElement('article');
  article.className = 'memory-card';

  const header = document.createElement('header');
  const headingBlock = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = titleCase(documentPayload.name);
  const path = document.createElement('p');
  path.className = 'meta';
  path.textContent = documentPayload.path;
  headingBlock.append(title, path);

  const info = document.createElement('p');
  info.className = 'meta';

  header.append(headingBlock, info);

  const textarea = document.createElement('textarea');
  textarea.spellcheck = false;
  textarea.value = getMemoryDraft(documentPayload);
  textarea.setAttribute(
    'aria-label',
    `${documentPayload.name} memory editor`,
  );

  const actions = document.createElement('div');
  actions.className = 'memory-actions';

  const resetButton = document.createElement('button');
  resetButton.type = 'button';
  resetButton.className = 'secondary';
  resetButton.textContent = 'Reset';

  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.textContent = 'Save';

  const syncCardState = () => {
    state.memoryDrafts[documentPayload.name] = textarea.value;
    const dirty = textarea.value !== documentPayload.content;
    info.textContent = buildMemoryStatus(documentPayload, textarea.value, dirty);
    resetButton.disabled = !dirty;
    saveButton.disabled = !dirty;
  };

  textarea.addEventListener('input', () => {
    syncCardState();
  });

  resetButton.addEventListener('click', () => {
    textarea.value = documentPayload.content;
    syncCardState();
  });

  saveButton.addEventListener('click', () => {
    void saveMemoryDocument(documentPayload.name, textarea, saveButton);
  });

  actions.append(resetButton, saveButton);
  article.append(header, textarea, actions);
  syncCardState();

  return article;
}

function renderPersonality(personality) {
  if (personality === null) {
    elements.personalityStatus.textContent = 'No personality loaded';
    return;
  }

  elements.personalityVerbosity.value = toSliderValue(personality.verbosity);
  elements.personalityAssertiveness.value = toSliderValue(
    personality.assertiveness,
  );
  elements.personalityHumor.value = toSliderValue(personality.humor);
  updatePersonalityDisplay();
  elements.personalityStatus.textContent =
    `${personality.name} · ${personality.interruptionPolicy} interruptions`;
}

function renderVoiceSettings(payload) {
  if (payload === null) {
    elements.voiceStatus.textContent = 'No voice settings loaded';
    return;
  }

  elements.wakeWordInput.value = payload.settings.wakeWord;
  elements.voiceModelInput.value = payload.settings.voiceModel;
  elements.voiceStatus.textContent =
    `Wake "${payload.settings.wakeWord}" · ${truncateText(payload.settings.voiceModel, 48)}`;
}

function renderConversations(payload) {
  renderTimeline(
    elements.currentSessionList,
    payload.currentSessionMessages,
    'No current session messages recorded yet.',
    {
      showSource: false,
      showSession: false,
    },
  );
  renderTimeline(
    elements.recentHistoryList,
    payload.recentMessages,
    'No persisted history entries found.',
    {
      showSource: true,
      showSession: true,
    },
  );
}

function renderTimeline(container, messages, emptyMessage, options) {
  if (!Array.isArray(messages) || messages.length === 0) {
    renderEmptyState(container, emptyMessage);
    return;
  }

  container.replaceChildren(
    ...messages.map((message) => createTimelineEntry(message, options)),
  );
}

function createTimelineEntry(message, options) {
  const item = document.createElement('article');
  item.className = 'list-item timeline-entry';

  const head = document.createElement('div');
  head.className = 'timeline-head';

  const title = document.createElement('div');
  title.className = 'timeline-title';

  const role = document.createElement('span');
  role.className = `pill ${message.role}`;
  role.textContent = message.role;
  title.append(role);

  if (options.showSource) {
    const source = document.createElement('span');
    source.className = 'pill';
    source.textContent = message.source;
    title.append(source);
  }

  const meta = document.createElement('div');
  meta.className = 'timeline-meta';
  meta.textContent = buildTimelineMeta(message, options.showSession);

  head.append(title, meta);

  const body = document.createElement('p');
  body.className = 'timeline-body';
  body.textContent = message.content;

  item.append(head, body);

  if ((message.toolCalls?.length ?? 0) > 0) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `Tool calls (${message.toolCalls.length})`;
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(message.toolCalls, null, 2);
    details.append(summary, pre);
    item.append(details);
  }

  return item;
}

function renderSkills(skills) {
  if (!Array.isArray(skills) || skills.length === 0) {
    renderEmptyState(
      elements.skillsList,
      'No registered skills were reported by the gateway.',
    );
    return;
  }

  elements.skillsList.replaceChildren(
    ...skills.map((skill) => {
      const item = document.createElement('article');
      item.className = 'list-item';

      const title = document.createElement('strong');
      title.textContent = skill.name;

      const body = document.createElement('p');
      body.className = 'meta';
      body.textContent = skill.description;

      item.append(title, body);
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

async function saveMemoryDocument(name, textarea, button) {
  button.disabled = true;
  button.textContent = 'Saving';

  try {
    const payload = await requestJson(`/api/memory/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: textarea.value,
      }),
    });
    const nextDocument = payload.document;
    state.memoryDrafts[name] = nextDocument.content;
    state.memoryDocuments = state.memoryDocuments.map((documentPayload) =>
      documentPayload.name === nextDocument.name ? nextDocument : documentPayload,
    );
    renderMemoryDocuments(state.memoryDocuments);
    await refreshStatusOnly();
    setConnectionState('Connected', true);
  } finally {
    button.disabled = false;
    button.textContent = 'Save';
  }
}

async function savePersonality(event) {
  event.preventDefault();
  elements.personalitySaveButton.disabled = true;
  elements.personalitySaveButton.textContent = 'Saving';

  try {
    const payload = await requestJson('/api/personality', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        verbosity: fromSliderValue(elements.personalityVerbosity.value),
        assertiveness: fromSliderValue(elements.personalityAssertiveness.value),
        humor: fromSliderValue(elements.personalityHumor.value),
      }),
    });

    state.personality = payload.personality;
    renderPersonality(state.personality);
    await refreshStatusOnly();
    setConnectionState('Connected', true);
  } finally {
    elements.personalitySaveButton.disabled = false;
    elements.personalitySaveButton.textContent = 'Save Personality';
  }
}

async function saveVoiceSettings(event) {
  event.preventDefault();
  elements.voiceSaveButton.disabled = true;
  elements.voiceSaveButton.textContent = 'Saving';

  try {
    const payload = await requestJson('/api/voice-settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        wakeWord: elements.wakeWordInput.value,
        voiceModel: elements.voiceModelInput.value,
      }),
    });

    state.voiceSettings = payload;
    renderVoiceSettings(state.voiceSettings);
    await refreshStatusOnly();
    setConnectionState('Connected', true);
  } finally {
    elements.voiceSaveButton.disabled = false;
    elements.voiceSaveButton.textContent = 'Save Voice Settings';
  }
}

function updatePersonalityDisplay() {
  const verbosity = Number(elements.personalityVerbosity.value);
  const assertiveness = Number(elements.personalityAssertiveness.value);
  const humor = Number(elements.personalityHumor.value);

  elements.personalityVerbosityValue.textContent = formatPercent(verbosity);
  elements.personalityAssertivenessValue.textContent = formatPercent(assertiveness);
  elements.personalityHumorValue.textContent = formatPercent(humor);

  elements.personalityVerbosityNote.textContent = describeVerbosity(verbosity);
  elements.personalityAssertivenessNote.textContent =
    describeAssertiveness(assertiveness);
  elements.personalityHumorNote.textContent = describeHumor(humor);
}

function buildMemoryStatus(documentPayload, draftValue, dirty) {
  const statusParts = [
    `Updated ${formatTimestamp(documentPayload.updatedAt)}`,
    `${draftValue.length} chars`,
  ];

  if (dirty) {
    statusParts.unshift('Unsaved changes');
  }

  return statusParts.join(' · ');
}

function buildTimelineMeta(message, showSession) {
  const parts = [formatTimestamp(message.timestamp)];

  if (typeof message.tokenCount === 'number') {
    parts.push(`${message.tokenCount} tokens`);
  }

  if (showSession) {
    parts.push(`Session ${truncateSessionId(message.sessionId)}`);
  }

  return parts.join(' · ');
}

function getMemoryDraft(documentPayload) {
  const draft = state.memoryDrafts[documentPayload.name];
  return typeof draft === 'string' ? draft : documentPayload.content;
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function toSliderValue(value) {
  return String(Math.round(value * 100));
}

function fromSliderValue(value) {
  return Number(value) / 100;
}

function formatPercent(value) {
  return `${Math.round(value)}%`;
}

function truncateSessionId(value) {
  if (typeof value !== 'string' || value.length <= 12) {
    return value;
  }

  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function truncateText(value, limit) {
  if (typeof value !== 'string' || value.length <= limit) {
    return value;
  }

  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function formatTimestamp(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
}

function describeVerbosity(value) {
  if (value <= 20) {
    return 'Very terse. Sonny should answer in the shortest complete form.';
  }

  if (value <= 45) {
    return 'Concise by default. Expand only when explanation matters.';
  }

  if (value <= 70) {
    return 'Balanced. Enough context to explain reasoning without dragging.';
  }

  return 'Detailed. Expect rationale, context, and longer explanations.';
}

function describeAssertiveness(value) {
  if (value <= 20) {
    return 'Soft suggestions. Minimal push toward a single recommendation.';
  }

  if (value <= 45) {
    return 'Measured. Gives options and nudges when warranted.';
  }

  if (value <= 70) {
    return 'Direct. Clear recommendations with collaborative tone.';
  }

  return 'Strong opinions. Calls out weak assumptions and recommends a path plainly.';
}

function describeHumor(value) {
  if (value <= 20) {
    return 'Dry humor disabled. Mostly literal and professional.';
  }

  if (value <= 45) {
    return 'Light wit only. Useful first, jokes rare.';
  }

  if (value <= 70) {
    return 'Occasional dry one-liners. Still secondary to the answer.';
  }

  return 'TARS mode. Sharper dry humor, but still not the main event.';
}

function setConnectionState(label, connected) {
  elements.connectionStatus.textContent = label;
  elements.connectionStatus.style.background = connected
    ? 'rgba(77, 224, 168, 0.12)'
    : 'rgba(255, 106, 106, 0.14)';
  elements.connectionStatus.style.color = connected ? '#4de0a8' : '#ff8d8d';
}

function handleActionError(error) {
  const message = error instanceof Error ? error.message : 'Unknown error';
  setConnectionState(`Error: ${message}`, false);
}

elements.refreshButton.addEventListener('click', () => {
  void refreshDashboard();
});

elements.personalityForm.addEventListener('submit', (event) => {
  void savePersonality(event).catch(handleActionError);
});

elements.voiceSettingsForm.addEventListener('submit', (event) => {
  void saveVoiceSettings(event).catch(handleActionError);
});

elements.personalityVerbosity.addEventListener('input', updatePersonalityDisplay);
elements.personalityAssertiveness.addEventListener('input', updatePersonalityDisplay);
elements.personalityHumor.addEventListener('input', updatePersonalityDisplay);

void refreshDashboard();
