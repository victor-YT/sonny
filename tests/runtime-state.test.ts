import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RuntimeStateStore } from '../src/core/runtime-state.js';

test('RuntimeStateStore tracks state, logs, services, and conversation turns', () => {
  const runtimeState = new RuntimeStateStore({
    currentSessionId: 'session-1',
    services: {
      ollama: {
        url: 'http://127.0.0.1:11434/api/tags',
      },
    },
  });

  runtimeState.transition('listening');
  runtimeState.setMicActive(true);
  runtimeState.setUserPartialTranscript('hello');
  runtimeState.setLastTranscript('hello sonny');
  runtimeState.transition('thinking');
  runtimeState.setAssistantPartialResponse('pipeline');
  runtimeState.setLastResponseText('pipeline nominal');
  runtimeState.setPlaybackActive(true);
  runtimeState.setServiceHealth('ollama', {
    online: true,
  });

  const snapshot = runtimeState.getSnapshot();
  const conversation = runtimeState.listConversation();
  const logs = runtimeState.listLogs();

  assert.equal(snapshot.currentState, 'thinking');
  assert.equal(snapshot.micActive, true);
  assert.equal(snapshot.playbackActive, true);
  assert.equal(snapshot.userPartialTranscript, null);
  assert.equal(snapshot.lastTranscript, 'hello sonny');
  assert.equal(snapshot.assistantPartialResponse, null);
  assert.equal(snapshot.lastResponseText, 'pipeline nominal');
  assert.equal(snapshot.currentSessionId, 'session-1');
  assert.equal(snapshot.services.ollama.online, true);
  assert.equal(conversation.length, 1);
  assert.equal(conversation[0]?.userTranscript, 'hello sonny');
  assert.equal(conversation[0]?.assistantText, 'pipeline nominal');
  assert.ok(logs.some((entry) => entry.type === 'state_changed'));
});
