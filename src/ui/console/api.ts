import { stat, writeFile } from 'node:fs/promises';

import {
  Router,
  type ErrorRequestHandler,
  type RequestHandler,
} from 'express';

import type { Gateway } from '../../core/gateway.js';
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

export function createConsoleApiRuntime(
  config: ConsoleApiConfig = {},
): ConsoleApiRuntime {
  const memoryStore = config.memoryStore ?? new MemoryStore();
  const recentMemory = config.recentMemory ?? new RecentMemory();
  const ownsRecentMemory = config.recentMemory === undefined;
  const router = Router();

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

  router.get('/conversations', (request, response) => {
    const limit = parseConversationLimit(request.query.limit);
    const sessionId =
      typeof request.query.sessionId === 'string'
        ? request.query.sessionId
        : undefined;
    const messages = recentMemory.listMessages({
      limit,
      sessionId,
    });

    response.json({
      messages: messages.map((message) => ({
        ...message,
        createdAt: message.createdAt.toISOString(),
      })),
    });
  });

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
      const [memoryDocuments] = await Promise.all([
        readMemoryDocuments(memoryStore),
      ]);
      const recentMessages = recentMemory.listMessages({ limit: 10 });
      const skills = config.gateway?.skills.list() ?? [];

      response.json({
        checkedAt: new Date().toISOString(),
        gateway: {
          healthy: config.gateway !== undefined,
          sessionId: config.gateway?.currentSession.id ?? null,
          messageCount: config.gateway?.currentSession.messageCount ?? 0,
          provider: config.llmProviderName ?? null,
          model: config.currentModel ?? null,
        },
        voice: {
          attached: config.voiceManager !== undefined,
          running: config.voiceManager?.isRunning ?? false,
          state: config.voiceManager?.currentState ?? 'idle',
        },
        memory: {
          directory: memoryStore.directory,
          documentCount: memoryDocuments.length,
        },
        conversations: {
          recentCount: recentMessages.length,
        },
        skills: {
          attached: config.gateway !== undefined,
          count: skills.length,
          skills,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMemoryDocumentName(value: unknown): value is MemoryDocumentName {
  return (
    typeof value === 'string' &&
    MEMORY_DOCUMENT_NAMES.includes(value as MemoryDocumentName)
  );
}
