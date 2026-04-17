const state = {
  snapshot: null,
  logs: [],
  conversation: [],
  voiceSettings: null,
  lastAudio: null,
  pipeline: null,
  recorder: null,
};

const elements = {
  connection: required('connection'),
  pageNotice: required('page-notice'),
  runtimeState: required('runtime-state'),
  micState: required('mic-state'),
  playbackState: required('playback-state'),
  sessionId: required('session-id'),
  updatedAt: required('updated-at'),
  lastError: required('last-error'),
  lastTranscript: required('last-transcript'),
  lastResponse: required('last-response'),
  healthGrid: required('health-grid'),
  listenStart: required('listen-start'),
  listenStop: required('listen-stop'),
  ttsInput: required('tts-input'),
  voiceSelect: required('voice-select'),
  ttsTest: required('tts-test'),
  refreshHealth: required('refresh-health'),
  interruptPlayback: required('interrupt-playback'),
  replayLastTts: required('replay-last-tts'),
  resetIdle: required('reset-idle'),
  clearLogs: required('clear-logs'),
  replayLastRecording: required('replay-last-recording'),
  retranscribeLastAudio: required('retranscribe-last-audio'),
  conversation: required('conversation'),
  logs: required('logs'),
  pipelineFlow: required('pipeline-flow'),
  latencyMetrics: required('latency-metrics'),
  lastAudioDebug: required('last-audio-debug'),
  pipelineDebug: required('pipeline-debug'),
  sttDebug: required('stt-debug'),
  recorderDebug: required('recorder-debug'),
};

void initialize();

async function initialize() {
  bindActions();
  await Promise.all([
    loadSnapshot(),
    loadLogs(),
    loadConversation(),
    loadVoiceSettings(),
    loadDebugState(),
  ]);
  connectEventStream();
}

function bindActions() {
  bindAction(elements.listenStart, '/api/voice/listen/start');
  bindAction(elements.listenStop, '/api/voice/listen/stop');
  bindAction(elements.refreshHealth, '/api/runtime/health/refresh');
  bindAction(elements.interruptPlayback, '/api/voice/playback/interrupt');
  bindAction(elements.replayLastTts, '/api/voice/tts/replay');
  bindAction(elements.resetIdle, '/api/runtime/reset');
  bindAction(elements.clearLogs, '/api/runtime/logs/clear');
  elements.replayLastRecording.addEventListener('click', () => {
    void replayLastRecording();
  });
  elements.retranscribeLastAudio.addEventListener('click', () => {
    void retranscribeLastAudio();
  });

  elements.ttsTest.addEventListener('click', () => {
    void postJson('/api/voice/tts/test', {
      text: elements.ttsInput.value,
      voice: elements.voiceSelect.value,
    });
  });
}

function bindAction(element, path, bodyFactory = undefined) {
  element.addEventListener('click', () => {
    const body = typeof bodyFactory === 'function' ? bodyFactory() : undefined;
    void postJson(path, body);
  });
}

async function loadSnapshot() {
  state.snapshot = await requestJson('/api/runtime/state');
  renderSnapshot();
  renderHealth();
}

async function loadLogs() {
  const payload = await requestJson('/api/runtime/logs');
  state.logs = payload.logs ?? [];
  renderLogs();
}

async function loadConversation() {
  const payload = await requestJson('/api/runtime/conversation');
  state.conversation = payload.conversation ?? [];
  renderConversation();
}

async function loadVoiceSettings() {
  const payload = await requestJson('/api/voice-settings');
  state.voiceSettings = payload;
  const currentVoice = payload.settings.voiceModel;
  const option = document.createElement('option');
  option.value = currentVoice;
  option.textContent = currentVoice;
  elements.voiceSelect.replaceChildren(option);
  elements.voiceSelect.value = currentVoice;
}

async function loadDebugState() {
  const [lastAudio, pipeline, recorder] = await Promise.all([
    requestJson('/api/runtime/debug/last-audio'),
    requestJson('/api/runtime/debug/pipeline'),
    requestJson('/api/runtime/debug/recorder'),
  ]);
  state.lastAudio = lastAudio;
  state.pipeline = pipeline;
  state.recorder = recorder;
  renderSnapshot();
  renderDebug();
}

function connectEventStream() {
  const source = new EventSource('/api/runtime/events');

  source.onopen = () => {
    elements.connection.textContent = 'Connected';
  };

  source.onerror = () => {
    elements.connection.textContent = 'Disconnected';
  };

  source.onmessage = (message) => {
    const payload = JSON.parse(message.data);

    if (payload.type === 'snapshot') {
      state.snapshot = payload.snapshot;
      renderSnapshot();
      renderHealth();
      return;
    }

    if (payload.type === 'log') {
      upsertById(state.logs, payload.entry, 300);
      renderLogs();

      if (shouldRefreshDebug(payload.entry.type)) {
        void loadDebugState();
      }

      return;
    }

    if (payload.type === 'conversation') {
      upsertById(state.conversation, payload.turn, 80);
      renderConversation();
    }
  };
}

function renderSnapshot() {
  const snapshot = state.snapshot;

  if (snapshot === null) {
    return;
  }

  elements.runtimeState.textContent = snapshot.currentState;
  elements.micState.textContent = snapshot.micActive ? 'active' : 'idle';
  elements.playbackState.textContent = snapshot.playbackActive ? 'playing' : 'idle';
  elements.sessionId.textContent = snapshot.currentSessionId ?? 'none';
  elements.updatedAt.textContent = formatTime(snapshot.updatedAt);
  elements.lastError.textContent = snapshot.lastError ?? 'No error.';
  elements.lastTranscript.textContent = snapshot.lastTranscript ?? 'No transcript yet.';
  elements.lastResponse.textContent = snapshot.lastResponseText ?? 'No response yet.';
  elements.listenStart.disabled = snapshot.micActive;
  elements.listenStop.disabled = !snapshot.micActive;
  elements.interruptPlayback.disabled = !snapshot.playbackActive;
  elements.replayLastTts.disabled =
    (snapshot.lastResponseText ?? '').trim().length === 0 &&
    !state.lastAudio?.exists;
  elements.replayLastRecording.disabled = state.lastAudio?.exists !== true;
  elements.retranscribeLastAudio.disabled = state.lastAudio?.exists !== true;
  renderNotice(snapshot.lastError ?? 'Ready.', snapshot.lastError === null ? 'info' : 'error');
}

function renderHealth() {
  const snapshot = state.snapshot;

  if (snapshot === null) {
    return;
  }

  elements.healthGrid.replaceChildren(
    ...Object.values(snapshot.services).map((service) => {
      const card = document.createElement('article');
      card.className = 'health-card';
      const title = document.createElement('h3');
      title.textContent = service.label;
      const status = document.createElement('p');
      status.className = service.online ? 'ok' : 'bad';
      status.textContent = service.online ? 'online' : 'offline';
      const checkedAt = document.createElement('p');
      checkedAt.className = 'meta';
      checkedAt.textContent =
        service.checkedAt === null
          ? 'never checked'
          : `checked ${formatTime(service.checkedAt)}`;
      const error = document.createElement('p');
      error.className = 'meta';
      error.textContent = service.error ?? service.url ?? 'No details.';
      card.append(title, status, checkedAt, error);
      return card;
    }),
  );
}

function renderConversation() {
  if (state.conversation.length === 0) {
    elements.conversation.textContent = 'No conversation yet.';
    return;
  }

  elements.conversation.replaceChildren(
    ...state.conversation
      .slice()
      .reverse()
      .map((turn) => {
        const item = document.createElement('article');
        item.className = 'conversation-item';
        const title = document.createElement('h3');
        title.textContent = `${turn.status} · ${formatTime(turn.timestamp)}`;
        const user = document.createElement('p');
        user.innerHTML = `<strong>User:</strong> ${escapeHtml(turn.userTranscript ?? '(none)')}`;
        const assistant = document.createElement('p');
        assistant.innerHTML =
          `<strong>Assistant:</strong> ${escapeHtml(turn.assistantText ?? '(pending)')}`;
        item.append(title, user, assistant);
        return item;
      }),
  );
}

function renderLogs() {
  if (state.logs.length === 0) {
    elements.logs.textContent = 'No events yet.';
    return;
  }

  elements.logs.replaceChildren(
    ...state.logs
      .slice()
      .reverse()
      .map((entry) => {
        const line = document.createElement('div');
        const meta = formatLogMeta(entry.meta);
        line.className = `log-line ${entry.level}`;
        line.textContent =
          `[${formatTime(entry.timestamp)}] ${entry.type}: ${entry.message}${meta}`;
        return line;
      }),
  );
}

function renderDebug() {
  renderPipelineFlow();
  renderLatencyMetrics();
  renderLastAudioDebug();
  renderPipelineDebug();
  renderSttDebug();
  renderRecorderDebug();
}

function renderPipelineFlow() {
  const pipeline = state.pipeline;

  if (pipeline === null) {
    elements.pipelineFlow.textContent = 'No pipeline timeline yet.';
    return;
  }

  const timestamps = pipeline.latency.timestamps;
  const activeStepKey = resolveActiveFlowStepKey(pipeline);
  const hasError = [
    pipeline.recording,
    pipeline.stt,
    pipeline.gateway,
    pipeline.tts,
    pipeline.playback,
  ].some((stage) => stage.status === 'failed');
  const steps = [
    { key: 'stopListeningAt', label: 'Stop' },
    { key: 'sttFinishedAt', label: 'STT' },
    { key: 'firstTokenAt', label: '1st Token' },
    { key: 'firstSentenceReadyAt', label: '1st Sentence' },
    { key: 'ttsFirstAudioReadyAt', label: '1st Audio' },
    { key: 'playbackStartedAt', label: '1st Sound' },
    { key: 'playbackFinishedAt', label: 'Done' },
  ];

  elements.pipelineFlow.replaceChildren(
    ...steps.map((step) => {
      const item = document.createElement('div');
      const hasTimestamp = timestamps[step.key] !== null;
      const status = hasTimestamp
        ? 'done'
        : hasError
          ? 'error'
          : activeStepKey === step.key
            ? 'running'
            : 'pending';
      item.className = `flow-step ${status}`;

      const node = document.createElement('div');
      node.className = 'flow-node';
      const label = document.createElement('div');
      label.className = 'flow-label';
      label.textContent = step.label;
      const time = document.createElement('div');
      time.className = 'flow-time';
      time.textContent = formatOffsetFromStop(timestamps.stopListeningAt, timestamps[step.key]);

      item.append(node, label, time);
      return item;
    }),
  );
}

function renderLatencyMetrics() {
  const pipeline = state.pipeline;

  if (pipeline === null) {
    elements.latencyMetrics.textContent = 'No latency metrics yet.';
    return;
  }

  const metrics = [
    ['STT', pipeline.latency.durations.sttLatencyMs],
    ['Gateway → 1st Token', pipeline.latency.durations.gatewayToFirstTokenMs],
    ['Gateway → 1st Sentence', pipeline.latency.durations.gatewayToFirstSentenceMs],
    ['TTS → 1st Audio', pipeline.latency.durations.ttsToFirstAudioMs],
    ['TTS Full', pipeline.latency.durations.ttsFullSynthesisMs],
    ['Stop → 1st Sound', pipeline.latency.durations.stopToFirstSoundMs],
    ['Stop → Playback Done', pipeline.latency.durations.stopToPlaybackFinishedMs],
  ];

  elements.latencyMetrics.replaceChildren(
    ...metrics.map(([label, value]) => {
      const card = document.createElement('div');
      card.className = 'metric-card';
      const metricLabel = document.createElement('div');
      metricLabel.className = 'metric-label';
      metricLabel.textContent = label;
      const metricValue = document.createElement('div');
      metricValue.className = 'metric-value';
      metricValue.textContent = formatDuration(value);
      card.append(metricLabel, metricValue);
      return card;
    }),
  );
}

function renderLastAudioDebug() {
  const info = state.lastAudio;

  if (info === null || info.exists !== true) {
    elements.lastAudioDebug.textContent = 'No recording metadata yet.';
    return;
  }

  elements.lastAudioDebug.innerHTML = [
    `Path: ${escapeHtml(info.path ?? 'unknown')}`,
    `Size: ${escapeHtml(String(info.size ?? 0))} bytes`,
    `Byte Length: ${escapeHtml(String(info.byteLength ?? 'unknown'))} bytes`,
    `Duration: ${escapeHtml(formatMaybeNumber(info.durationMs, 'ms'))}`,
    `Sample Rate: ${escapeHtml(formatMaybeNumber(info.sampleRate, 'Hz'))}`,
    `Channels: ${escapeHtml(String(info.channels ?? 'unknown'))}`,
    `Bits Per Sample: ${escapeHtml(String(info.bitsPerSample ?? 'unknown'))}`,
    `Format: ${escapeHtml(info.format ?? 'unknown')}`,
    `Encoding: ${escapeHtml(info.encoding ?? 'unknown')}`,
    `Peak Amplitude: ${escapeHtml(formatMetric(info.peakAmplitude))}`,
    `RMS Level: ${escapeHtml(formatMetric(info.rmsLevel))}`,
    `Silent Ratio: ${escapeHtml(formatMetric(info.silentRatio))}`,
    `Suspected Silence: ${escapeHtml(String(info.suspectedSilent ?? 'unknown'))}`,
    `Quality Hint: ${escapeHtml(info.audioQualityHint ?? 'unknown')}`,
    `Whisper Target: ${escapeHtml(`${info.targetChannels}ch / ${info.targetSampleRate}Hz / ${info.targetEncoding} / ${info.targetFormat}`)}`,
    `Target Match: ${escapeHtml(String(info.matchesWhisperInputTarget ?? 'unknown'))}`,
    `Target Risk: ${escapeHtml(info.whisperInputRisk ?? 'none')}`,
    `Input Device: ${escapeHtml(info.device ?? 'unknown/default')}`,
    `Default Device: ${escapeHtml(String(info.usingDefaultDevice))}`,
    `Saved: ${escapeHtml(info.createdAt ? formatDateTime(info.createdAt) : 'unknown')}`,
  ].join('<br />');
}

function renderPipelineDebug() {
  const pipeline = state.pipeline;

  if (pipeline === null) {
    elements.pipelineDebug.textContent = 'No pipeline run yet.';
    return;
  }

  const lines = [];
  lines.push(`Flow: ${pipeline.flow ?? 'none'}`);
  lines.push(`Updated: ${pipeline.updatedAt ? formatDateTime(pipeline.updatedAt) : 'never'}`);

  for (const stage of ['recording', 'stt', 'gateway', 'tts', 'playback']) {
    const value = pipeline[stage];
    const error = value.error === null ? '' : ` (${value.error})`;
    lines.push(`${stage}: ${value.status}${error}`);
  }

  lines.push(`stt status: ${pipeline.sttDebug.httpStatus ?? 'unknown'}`);
  lines.push(`stt content-type: ${pipeline.sttDebug.contentType ?? 'unknown'}`);
  lines.push(
    `stt response keys: ${
      pipeline.sttDebug.responseKeys.length === 0
        ? 'none'
        : pipeline.sttDebug.responseKeys.join(',')
    }`,
  );
  lines.push(`stt transcript length: ${pipeline.sttDebug.transcriptLength ?? 'unknown'}`);
  lines.push(`stt failure reason: ${pipeline.sttDebug.failureReason ?? 'none'}`);
  lines.push(`stop listening at: ${pipeline.latency.timestamps.stopListeningAt ?? 'unknown'}`);
  lines.push(`stt started at: ${pipeline.latency.timestamps.sttStartedAt ?? 'unknown'}`);
  lines.push(`stt finished at: ${pipeline.latency.timestamps.sttFinishedAt ?? 'unknown'}`);
  lines.push(`gateway started at: ${pipeline.latency.timestamps.gatewayStartedAt ?? 'unknown'}`);
  lines.push(`first token at: ${pipeline.latency.timestamps.firstTokenAt ?? 'unknown'}`);
  lines.push(`first sentence ready at: ${pipeline.latency.timestamps.firstSentenceReadyAt ?? 'unknown'}`);
  lines.push(`tts request started at: ${pipeline.latency.timestamps.ttsRequestStartedAt ?? 'unknown'}`);
  lines.push(`tts first audio ready at: ${pipeline.latency.timestamps.ttsFirstAudioReadyAt ?? 'unknown'}`);
  lines.push(`tts finished at: ${pipeline.latency.timestamps.ttsFinishedAt ?? 'unknown'}`);
  lines.push(`playback started at: ${pipeline.latency.timestamps.playbackStartedAt ?? 'unknown'}`);
  lines.push(`playback finished at: ${pipeline.latency.timestamps.playbackFinishedAt ?? 'unknown'}`);

  elements.pipelineDebug.innerHTML = lines
    .map((line) => escapeHtml(line))
    .join('<br />');
}

function renderSttDebug() {
  const pipeline = state.pipeline;

  if (pipeline === null) {
    elements.sttDebug.textContent = 'No STT debug yet.';
    return;
  }

  const lines = [
    `Request URL: ${pipeline.sttDebug.requestUrl ?? 'unknown'}`,
    `HTTP Status: ${pipeline.sttDebug.httpStatus ?? 'unknown'}`,
    `Content Type: ${pipeline.sttDebug.contentType ?? 'unknown'}`,
    `Response Keys: ${
      pipeline.sttDebug.responseKeys.length === 0
        ? 'none'
        : pipeline.sttDebug.responseKeys.join(', ')
    }`,
    `Transcript Length: ${pipeline.sttDebug.transcriptLength ?? 'unknown'}`,
    `Transcript: ${pipeline.sttDebug.transcript ?? 'none'}`,
    `Failure Reason: ${pipeline.sttDebug.failureReason ?? 'none'}`,
    `Raw Body: ${pipeline.sttDebug.rawBodyPreview ?? 'none'}`,
  ];

  elements.sttDebug.innerHTML = lines
    .map((line) => escapeHtml(line))
    .join('<br />');
}

function renderRecorderDebug() {
  const recorder = state.recorder;

  if (recorder === null) {
    elements.recorderDebug.textContent = 'No recorder diagnostics yet.';
    return;
  }

  const lines = [
    `Backend: ${recorder.backend}`,
    `Backend Path: ${recorder.backendPath ?? 'not found'}`,
    `Input Device: ${recorder.device ?? 'unknown/default'}`,
    `Default Device: ${String(recorder.usingDefaultDevice)}`,
    `Available: ${String(recorder.backendAvailable)}`,
    `Spawn Started: ${String(recorder.spawnStarted)}`,
    `First Chunk Received: ${String(recorder.firstChunkReceived)}`,
    `Start Timeout: ${recorder.startTimeoutMs}ms`,
    `Last Failure Reason: ${recorder.lastFailureReason ?? 'none'}`,
    `Last Spawn Error: ${recorder.lastSpawnError ?? 'none'}`,
    `Last Stderr: ${recorder.lastStderr ?? 'none'}`,
    `Mic Permission Hint: ${recorder.micPermissionHint ?? 'none'}`,
  ];

  elements.recorderDebug.innerHTML = lines
    .map((line) => escapeHtml(line))
    .join('<br />');
}

async function requestJson(path) {
  const response = await fetch(path);

  if (!response.ok) {
    throw await toRequestError(response);
  }

  return response.json();
}

async function postJson(path, body = undefined) {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers:
        body === undefined
          ? undefined
          : {
              'content-type': 'application/json',
            },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      throw await toRequestError(response);
    }

    if (response.headers.get('content-type')?.includes('application/json')) {
      const payload = await response.json();

      if (payload.state !== undefined) {
        state.snapshot = payload.state;
        renderSnapshot();
        renderHealth();
      }

      if (payload.logs !== undefined) {
        state.logs = payload.logs;
        renderLogs();
      }
    }

    await Promise.all([
      loadSnapshot(),
      loadLogs(),
      loadConversation(),
      loadDebugState(),
    ]);
  } catch (error) {
    await Promise.allSettled([
      loadSnapshot(),
      loadLogs(),
      loadConversation(),
      loadDebugState(),
    ]);
    const message = error instanceof Error ? error.message : String(error);
    renderNotice(message, 'error');
  }
}

function renderNotice(message, level = 'info') {
  elements.pageNotice.textContent = message;
  elements.pageNotice.className = level === 'error' ? 'notice error' : 'notice';
}

async function toRequestError(response) {
  try {
    const payload = await response.json();
    return new Error(payload.error ?? `Request failed: ${response.status}`);
  } catch {
    return new Error(`Request failed: ${response.status}`);
  }
}

function shouldRefreshDebug(type) {
  return [
    'manual_listen_started',
    'manual_listen_stopped',
    'recording_started',
    'recording_backend_detected',
    'recording_backend_missing',
    'recording_spawn_started',
    'recording_spawn_failed',
    'recording_stderr',
    'recording_first_chunk_received',
    'recording_start_timeout',
    'recording_start_failed',
    'recording_stopped',
    'recording_saved',
    'recording_format_warning',
    'stt_started',
    'stt_finished',
    'stt_failed',
    'gateway_started',
    'gateway_first_token',
    'gateway_first_sentence_ready',
    'gateway_finished',
    'gateway_failed',
    'tts_started',
    'tts_request_started',
    'tts_first_audio_ready',
    'tts_finished',
    'tts_failed',
    'tts_warmup_started',
    'tts_warmup_finished',
    'tts_warmup_failed',
    'playback_started',
    'playback_finished',
    'playback_interrupted',
    'voice_pipeline_completed',
    'voice_pipeline_failed',
    'runtime_reset',
    'stt_retranscribe_started',
    'stt_retranscribe_finished',
    'stt_retranscribe_failed',
  ].includes(type);
}

async function replayLastRecording() {
  if (state.lastAudio?.exists !== true) {
    renderNotice('No saved manual recording is available to replay.', 'error');
    return;
  }

  try {
    const audio = new Audio(`/api/runtime/debug/last-audio/file?ts=${Date.now()}`);
    await audio.play();
    renderNotice('Playing latest saved recording.', 'info');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderNotice(message, 'error');
  }
}

async function retranscribeLastAudio() {
  try {
    const response = await fetch('/api/runtime/debug/retranscribe-last-audio', {
      method: 'POST',
    });

    if (!response.ok) {
      throw await toRequestError(response);
    }

    const payload = await response.json();

    await Promise.all([
      loadSnapshot(),
      loadLogs(),
      loadConversation(),
      loadDebugState(),
    ]);
    const transcriptPreview = payload.result?.transcript
      ? ` Transcript: ${payload.result.transcript.slice(0, 120)}`
      : '';
    renderNotice(
      `Re-transcribed last audio. Transcript length: ${payload.result?.transcriptLength ?? 'unknown'}.${transcriptPreview}`,
      'info',
    );
  } catch (error) {
    await Promise.allSettled([
      loadSnapshot(),
      loadLogs(),
      loadConversation(),
      loadDebugState(),
    ]);
    const message = error instanceof Error ? error.message : String(error);
    renderNotice(message, 'error');
  }
}

function formatLogMeta(meta) {
  if (meta === undefined || meta === null) {
    return '';
  }

  const entries = Object.entries(meta).filter(([, value]) => value !== null);

  if (entries.length === 0) {
    return '';
  }

  return ` | ${entries.map(([key, value]) => `${key}=${value}`).join(' ')}`;
}

function formatMaybeNumber(value, suffix) {
  if (value === null || value === undefined) {
    return 'unknown';
  }

  return `${value}${suffix}`;
}

function formatMetric(value) {
  if (value === null || value === undefined) {
    return 'unknown';
  }

  return Number(value).toFixed(4);
}

function formatDuration(value) {
  if (value === null || value === undefined) {
    return 'unknown';
  }

  return `${value}ms`;
}

function formatOffsetFromStop(stopAt, currentAt) {
  if (!stopAt || !currentAt) {
    return 'pending';
  }

  const stopTime = Date.parse(stopAt);
  const currentTime = Date.parse(currentAt);

  if (!Number.isFinite(stopTime) || !Number.isFinite(currentTime)) {
    return 'unknown';
  }

  return `+${Math.max(0, currentTime - stopTime)}ms`;
}

function resolveActiveFlowStepKey(pipeline) {
  if (pipeline.playback.status === 'running') {
    return 'playbackFinishedAt';
  }

  if (pipeline.tts.status === 'running') {
    return pipeline.latency.timestamps.ttsFirstAudioReadyAt === null
      ? 'ttsFirstAudioReadyAt'
      : 'playbackStartedAt';
  }

  if (pipeline.gateway.status === 'running') {
    if (pipeline.latency.timestamps.firstTokenAt === null) {
      return 'firstTokenAt';
    }

    return 'firstSentenceReadyAt';
  }

  if (pipeline.stt.status === 'running') {
    return 'sttFinishedAt';
  }

  return null;
}

function required(id) {
  const element = document.getElementById(id);

  if (element === null) {
    throw new Error(`Missing element: ${id}`);
  }

  return element;
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString();
}

function formatDateTime(value) {
  return new Date(value).toLocaleString();
}

function upsertById(items, value, limit) {
  const index = items.findIndex((entry) => entry.id === value.id);

  if (index >= 0) {
    items[index] = value;
  } else {
    items.push(value);
  }

  if (items.length > limit) {
    items.splice(0, items.length - limit);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
