import { stat, writeFile } from 'node:fs/promises';

import {
  Router,
  type ErrorRequestHandler,
  type RequestHandler,
} from 'express';

import { type Gateway } from '../../core/gateway.js';
import {
  getDefaultConfigPath,
  loadConfig,
  updateConfig,
} from '../../core/config.js';
import type { ConversationHistoryEntry } from '../../core/conversation-history.js';
import type { LlmMessage, ToolCall } from '../../core/providers/llm.js';
import {
  getDefaultPersonalityPath,
  loadPersonalityConfig,
  savePersonalityConfig,
  type PersonalityConfig,
} from '../../core/personality.js';
import {
  MEMORY_DOCUMENT_NAMES,
  MemoryStore,
  type MemoryDocument,
  type MemoryDocumentName,
} from '../../memory/memory-store.js';
import { RecentMemory } from '../../memory/recent-memory.js';
import type { VoiceManager } from '../../voice/voice-manager.js';

const DEFAULT_CONVERSATION_LIMIT = 50;

export interface ConsoleApiConfig {
  gateway?: Gateway;
  memoryStore?: MemoryStore;
  recentMemory?: RecentMemory;
  voiceManager?: Pick<VoiceManager, 'currentState' | 'isRunning'>;
  llmProviderName?: string;
  currentModel?: string;
}

export interface ConsoleApiRuntime {
  router: Router;
  close(): void;
}

interface MemoryUpdateBody {
  content: string;
}

interface VoiceSettingsUpdateBody {
  wakeWord: string;
  voiceModel: string;
}

type PersonalityUpdateBody = Partial<PersonalityConfig>;

interface ConversationMessagePayload {
  id: number;
  sessionId: string;
  role: LlmMessage['role'];
  content: string;
  timestamp: string;
  tokenCount: number | null;
  toolCallId: string | null;
  toolCalls: ToolCall[];
  source: 'current-session' | 'history' | 'recent-memory';
}

export function createConsoleApiRuntime(
  config: ConsoleApiConfig = {},
): ConsoleApiRuntime {
  const memoryStore = config.memoryStore ?? new MemoryStore();
  const recentMemory = config.recentMemory ?? new RecentMemory();
  const ownsRecentMemory = config.recentMemory === undefined;
  const router = Router();

  router.get(
    '/personality',
    createAsyncHandler(async (_request, response) => {
      response.json({
        personality: loadPersonalityConfig(),
        path: getDefaultPersonalityPath(),
      });
    }),
  );

  router.post(
    '/personality',
    createAsyncHandler(async (request, response) => {
      const payload = parsePersonalityUpdateBody(request.body);
      const personality = await savePersonalityConfig(payload);

      response.json({
        personality,
        path: getDefaultPersonalityPath(),
      });
    }),
  );

  router.get(
    '/voice-settings',
    createAsyncHandler(async (_request, response) => {
      response.json(await readVoiceSettingsPayload());
    }),
  );

  router.post(
    '/voice-settings',
    createAsyncHandler(async (request, response) => {
      const payload = parseVoiceSettingsUpdateBody(request.body);

      await Promise.all([
        updateConfig({
          voice: {
            porcupine: {
              wakeWord: payload.wakeWord,
              wakeWords: [payload.wakeWord],
            },
          },
        }),
        savePersonalityConfig({
          voice: payload.voiceModel,
        }),
      ]);

      response.json(await readVoiceSettingsPayload());
    }),
  );

  router.get(
    '/memory',
    createAsyncHandler(async (_request, response) => {
      const documents = await readMemoryDocuments(memoryStore);

      response.json({
        documents,
      });
    }),
  );

  router.post(
    '/memory/:file',
    createAsyncHandler(async (request, response) => {
      const name = parseMemoryFileParam(request.params.file);
      const payload = parseMemoryUpdateBody(request.body);
      const document = await memoryStore.readDocument(name);
      await writeFile(document.path, payload.content, 'utf8');

      response.json({
        document: await toMemoryDocumentPayload({
          ...document,
          content: payload.content,
        }),
      });
    }),
  );

  router.get(
    '/conversations',
    createAsyncHandler(async (request, response) => {
      const limit = parseConversationLimit(request.query.limit);
      const sessionId =
        typeof request.query.sessionId === 'string'
          ? request.query.sessionId
          : undefined;
      const currentSessionId = config.gateway?.currentSession.id ?? null;
      const currentSessionMessages = readCurrentSessionMessages(
        config.gateway,
        limit,
        sessionId,
      );
      const recentMessages = readRecentConversationMessages(
        recentMemory,
        limit,
        sessionId,
      );

      response.json({
        currentSessionId,
        systemPrompt: config.gateway?.currentSession.getSystemPrompt() ?? null,
        currentSessionMessages,
        recentMessages,
      });
    }),
  );

  router.get(
    '/skills',
    createAsyncHandler(async (_request, response) => {
      const skills = config.gateway?.skills.list() ?? [];

      response.json({
        attached: config.gateway !== undefined,
        skills,
      });
    }),
  );

  router.get(
    '/status',
    createAsyncHandler(async (_request, response) => {
      const [memoryDocuments, voiceSettings] = await Promise.all([
        readMemoryDocuments(memoryStore),
        readVoiceSettingsPayload(),
      ]);
      const recentMessages = readRecentConversationMessages(
        recentMemory,
        10,
      );
      const skills = config.gateway?.skills.list() ?? [];
      const currentSessionEntries = config.gateway?.currentSession.getEntries() ?? [];
      const provider = getGatewayProvider(config.gateway);
      const providerName =
        config.llmProviderName ?? readStringProperty(provider, 'name');
      const currentModel =
        config.currentModel ??
        readStringProperty(provider, 'currentModel') ??
        readStringProperty(provider, 'model');
      const systemPrompt = config.gateway?.currentSession.getSystemPrompt() ?? '';

      response.json({
        checkedAt: new Date().toISOString(),
        gateway: {
          healthy: config.gateway !== undefined,
          sessionId: config.gateway?.currentSession.id ?? null,
          messageCount: config.gateway?.currentSession.messageCount ?? 0,
          provider: providerName,
          model: currentModel,
          systemPrompt,
          systemPromptLength: systemPrompt.length,
        },
        voice: {
          attached: config.voiceManager !== undefined,
          running: config.voiceManager?.isRunning ?? false,
          state: config.voiceManager?.currentState ?? 'idle',
          wakeWord: voiceSettings.settings.wakeWord,
          voiceModel: voiceSettings.settings.voiceModel,
        },
        memory: {
          directory: memoryStore.directory,
          documentCount: memoryDocuments.length,
        },
        conversations: {
          currentSessionCount: currentSessionEntries.length,
          recentCount: recentMessages.length,
        },
        skills: {
          attached: config.gateway !== undefined,
          count: skills.length,
          skills,
        },
        paths: {
          config: voiceSettings.paths.config,
          personality: voiceSettings.paths.personality,
        },
      });
    }),
  );

  const errorHandler: ErrorRequestHandler = (
    error,
    _request,
    response,
    _next,
  ) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    response.status(400).json({
      error: message,
    });
  };

  router.use(errorHandler);

  return {
    router,
    close() {
      if (ownsRecentMemory) {
        recentMemory.close();
      }
    },
  };
}

function createAsyncHandler(
  handler: RequestHandler,
): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

async function readMemoryDocuments(
  memoryStore: MemoryStore,
): Promise<Array<MemoryDocument & { updatedAt: string }>> {
  const documents = await memoryStore.readAllDocuments();

  return Promise.all(
    documents.map(async (document) => toMemoryDocumentPayload(document)),
  );
}

async function toMemoryDocumentPayload(
  document: MemoryDocument,
): Promise<MemoryDocument & { updatedAt: string }> {
  const metadata = await stat(document.path);

  return {
    ...document,
    updatedAt: metadata.mtime.toISOString(),
  };
}

async function readVoiceSettingsPayload(): Promise<{
  settings: VoiceSettingsUpdateBody;
  paths: {
    config: string;
    personality: string;
  };
}> {
  const runtimeConfig = loadConfig();
  const personality = loadPersonalityConfig();

  return {
    settings: {
      wakeWord: runtimeConfig.voice.porcupine.wakeWord,
      voiceModel: personality.voice,
    },
    paths: {
      config: getDefaultConfigPath(),
      personality: getDefaultPersonalityPath(),
    },
  };
}

function readCurrentSessionMessages(
  gateway: Gateway | undefined,
  limit: number,
  sessionId?: string,
): ConversationMessagePayload[] {
  if (gateway === undefined) {
    return [];
  }

  const currentSessionId = gateway.currentSession.id;

  if (sessionId !== undefined && sessionId !== currentSessionId) {
    return [];
  }

  return gateway.currentSession
    .getEntries()
    .slice(-limit)
    .map((entry) => toCurrentSessionMessagePayload(entry));
}

function readRecentConversationMessages(
  recentMemory: RecentMemory,
  limit: number,
  sessionId?: string,
): ConversationMessagePayload[] {
  return recentMemory.listMessages({
    limit,
    sessionId,
  }).map((message) => ({
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    timestamp: message.createdAt.toISOString(),
    tokenCount: null,
    toolCallId: null,
    toolCalls: [],
    source: 'recent-memory',
  }));
}

function toCurrentSessionMessagePayload(
  entry: ConversationHistoryEntry,
): ConversationMessagePayload {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    role: entry.role,
    content: entry.content,
    timestamp: entry.timestamp.toISOString(),
    tokenCount: entry.tokenCount,
    toolCallId: entry.toolCallId ?? null,
    toolCalls: entry.toolCalls ?? [],
    source: 'current-session',
  };
}

function parseMemoryUpdateBody(body: unknown): MemoryUpdateBody {
  if (!isRecord(body)) {
    throw new Error('Memory update body must be an object');
  }

  const { content } = body;

  if (typeof content !== 'string') {
    throw new Error('Memory content must be a string');
  }

  return {
    content,
  };
}

function parsePersonalityUpdateBody(body: unknown): PersonalityUpdateBody {
  if (!isRecord(body)) {
    throw new Error('Personality update body must be an object');
  }

  return body as PersonalityUpdateBody;
}

function parseVoiceSettingsUpdateBody(body: unknown): VoiceSettingsUpdateBody {
  if (!isRecord(body)) {
    throw new Error('Voice settings body must be an object');
  }

  const wakeWord = readTrimmedString(body.wakeWord, 'wakeWord');
  const voiceModel = readTrimmedString(body.voiceModel, 'voiceModel');

  return {
    wakeWord,
    voiceModel,
  };
}

function parseMemoryFileParam(value: unknown): MemoryDocumentName {
  if (typeof value !== 'string') {
    throw new Error('Memory file parameter must be a string');
  }

  const normalized = value.trim().replace(/\.md$/u, '');

  if (!isMemoryDocumentName(normalized)) {
    throw new Error(
      `Memory file must be one of: ${MEMORY_DOCUMENT_NAMES.join(', ')}`,
    );
  }

  return normalized;
}

function parseConversationLimit(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_CONVERSATION_LIMIT;
  }

  if (typeof value !== 'string') {
    throw new Error('Conversation limit must be a string');
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Conversation limit must be a positive integer');
  }

  return parsed;
}

function getGatewayProvider(gateway: Gateway | undefined): unknown {
  if (gateway === undefined) {
    return undefined;
  }

  return Reflect.get(gateway as object, 'llmProvider');
}

function readStringProperty(
  value: unknown,
  propertyName: string,
): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const property = value[propertyName];

  if (typeof property !== 'string' || property.length === 0) {
    return null;
  }

  return property;
}

function readTrimmedString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error(`${fieldName} cannot be empty`);
  }

  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMemoryDocumentName(value: unknown): value is MemoryDocumentName {
  return (
    typeof value === 'string' &&
    MEMORY_DOCUMENT_NAMES.includes(value as MemoryDocumentName)
  );
}
