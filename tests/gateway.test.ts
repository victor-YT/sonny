import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ContextManager } from '../src/core/context-manager.js';
import { ConversationHistory } from '../src/core/conversation-history.js';
import { type PersonalityConfig } from '../src/core/personality.js';
import { PromptBuilder } from '../src/core/prompt-builder.js';
import { Gateway } from '../src/core/gateway.js';
import type {
  LlmGenerateOptions,
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
} from '../src/core/providers/llm.js';
import { MemoryManager } from '../src/memory/memory-manager.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import { RecentMemory } from '../src/memory/recent-memory.js';
import { SkillRegistry } from '../src/skills/skill-registry.js';

const TEST_PERSONALITY: PersonalityConfig = {
  name: 'Test Sonny',
  voice: 'Concise, pragmatic, and terminal-first.',
  verbosity: 0.2,
  assertiveness: 0.8,
  humor: 0.1,
  interruptionPolicy: 'active',
};

class StreamingLlmStub implements LlmProvider {
  public readonly name = 'streaming-llm-stub';
  public chunks: LlmStreamChunk[] = [
    {
      type: 'text',
      text: 'Pipeline ',
    },
    {
      type: 'text',
      text: 'nominal.',
    },
    {
      type: 'done',
    },
  ];
  public readonly calls: Array<{
    messages: LlmMessage[];
    options: LlmGenerateOptions | undefined;
  }> = [];

  public async generate(): Promise<LlmMessage> {
    throw new Error('generate() should not be used in this streaming gateway test');
  }

  public async *generateStream(
    messages: LlmMessage[],
    options?: LlmGenerateOptions,
  ): AsyncIterable<LlmStreamChunk> {
    this.calls.push({
      messages: messages.map((message) => ({ ...message })),
      options,
    });

    for (const chunk of this.chunks) {
      yield chunk;
    }
  }

  public stream(
    messages: LlmMessage[],
    options?: LlmGenerateOptions,
  ): AsyncIterable<LlmStreamChunk> {
    return this.generateStream(messages, options);
  }
}

async function createGatewayFixture(): Promise<{
  gateway: Gateway;
  llmProvider: StreamingLlmStub;
  recentMemory: RecentMemory;
  conversationHistory: ConversationHistory;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'sonny-gateway-test-'));
  const llmProvider = new StreamingLlmStub();
  const memoryStore = new MemoryStore({
    directoryPath: join(directory, 'memory'),
  });

  await memoryStore.append({
    name: 'preferences',
    content: 'User prefers terminal-first workflows and concise diagnostics.',
  });

  const recentMemory = new RecentMemory({
    databasePath: join(directory, 'memory', 'recent.json'),
  });
  const conversationHistory = new ConversationHistory({
    databasePath: join(directory, 'memory', 'conversations.json'),
  });
  const memoryManager = new MemoryManager({
    memoryStore,
    recentMemory,
  });
  const skillRegistry = new SkillRegistry({
    loadCommunitySkills: false,
    baseDirectory: directory,
    allowedPaths: [directory],
  });
  const promptBuilder = new PromptBuilder({
    personality: TEST_PERSONALITY,
    personalityPath: join(directory, 'personality.json'),
  });
  const gateway = new Gateway({
    llmProvider,
    memoryManager,
    conversationHistory,
    contextManager: new ContextManager(),
    promptBuilder,
    skillRegistry,
  });

  return {
    gateway,
    llmProvider,
    recentMemory,
    conversationHistory,
    cleanup: async () => {
      gateway.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('Gateway.streamChat sends a message through prompt-building, streaming, and persistence', async () => {
  const fixture = await createGatewayFixture();

  try {
    const chunks: string[] = [];

    for await (const chunk of fixture.gateway.streamChat(
      'Use the workflow you remember and keep it terse.',
    )) {
      if (chunk.type === 'text' && chunk.text !== undefined) {
        chunks.push(chunk.text);
      }
    }

    assert.equal(chunks.join(''), 'Pipeline nominal.');
    assert.equal(fixture.llmProvider.calls.length, 1);
    assert.deepStrictEqual(
      fixture.llmProvider.calls[0]?.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      [
        {
          role: 'user',
          content: 'Use the workflow you remember and keep it terse.',
        },
      ],
    );

    const systemPrompt = fixture.llmProvider.calls[0]?.options?.systemPrompt ?? '';

    assert.match(systemPrompt, /You are Test Sonny\./u);
    assert.match(systemPrompt, /Relevant memory context:/u);
    assert.match(
      systemPrompt,
      /\[preferences\] User prefers terminal-first workflows and concise diagnostics\./u,
    );

    assert.deepStrictEqual(
      fixture.gateway.currentSession.getHistory().map((message) => ({
        role: message.role,
        content: message.content,
      })),
      [
        {
          role: 'user',
          content: 'Use the workflow you remember and keep it terse.',
        },
        {
          role: 'assistant',
          content: 'Pipeline nominal.',
        },
      ],
    );

    const recentMessages = fixture.recentMemory
      .listMessages({
        sessionId: fixture.gateway.currentSession.id,
        limit: 10,
      })
      .map((message) => `${message.role}:${message.content}`)
      .sort();

    assert.deepStrictEqual(recentMessages, [
      'assistant:Pipeline nominal.',
      'user:Use the workflow you remember and keep it terse.',
    ]);

    assert.equal(
      fixture.conversationHistory.getSessionEntries(
        fixture.gateway.currentSession.id,
      ).length,
      2,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('Gateway.streamChat blocks subprocess diagnostics from assistant content', async () => {
  const fixture = await createGatewayFixture();

  fixture.llmProvider.chunks = [
    {
      type: 'text',
      text: 'bufio.Reader could not be identified to support stdout/stderr, sorry.',
    },
  ];

  try {
    await assert.rejects(
      async () => {
        for await (const _chunk of fixture.gateway.streamChat('hello')) {
          // Drain the stream.
        }
      },
      /Blocked contaminated assistant output/u,
    );

    assert.deepStrictEqual(
      fixture.gateway.currentSession.getHistory().map((message) => message.role),
      ['user'],
    );
  } finally {
    await fixture.cleanup();
  }
});
