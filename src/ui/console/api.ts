import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

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

const DEFAULT_SKILLS_DIRECTORY = join(process.cwd(), 'src', 'skills');
const DEFAULT_CONVERSATION_LIMIT = 50;

export interface ConsoleApiConfig {
  gateway?: Gateway;
  memoryStore?: MemoryStore;
  recentMemory?: RecentMemory;
  voiceManager?: Pick<VoiceManager, 'currentState' | 'isRunning'>;
  skillsDirectory?: string;
}

export interface ConsoleApiRuntime {
  router: Router;
  close(): void;
}

interface MemoryUpdateBody {
  name: MemoryDocumentName;
  content: string;
}

interface ConsoleSkillRecord {
  name: string;
  path: string;
  implemented: boolean;
}

export function createConsoleApiRuntime(
  config: ConsoleApiConfig = {},
): ConsoleApiRuntime {
  const memoryStore = config.memoryStore ?? new MemoryStore();
  const recentMemory = config.recentMemory ?? new RecentMemory();
  const skillsDirectory = config.skillsDirectory ?? DEFAULT_SKILLS_DIRECTORY;
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
    '/memory',
    createAsyncHandler(async (request, response) => {
      const payload = parseMemoryUpdateBody(request.body);
      const document = await memoryStore.readDocument(payload.name);
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
      const skills = await listInstalledSkills(skillsDirectory);

      response.json({
        directory: skillsDirectory,
        skills,
      });
    }),
  );

  router.get(
    '/status',
    createAsyncHandler(async (_request, response) => {
      const [skills, memoryDocuments] = await Promise.all([
        listInstalledSkills(skillsDirectory),
        readMemoryDocuments(memoryStore),
      ]);
      const recentMessages = recentMemory.listMessages({ limit: 10 });

      response.json({
        checkedAt: new Date().toISOString(),
        gateway: {
          attached: config.gateway !== undefined,
          sessionId: config.gateway?.currentSession.id ?? null,
          messageCount: config.gateway?.currentSession.messageCount ?? 0,
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
          directory: skillsDirectory,
          count: skills.length,
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

  const { name, content } = body;

  if (!isMemoryDocumentName(name)) {
    throw new Error(
      `Memory name must be one of: ${MEMORY_DOCUMENT_NAMES.join(', ')}`,
    );
  }

  if (typeof content !== 'string') {
    throw new Error('Memory content must be a string');
  }

  return {
    name,
    content,
  };
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

async function listInstalledSkills(
  directoryPath: string,
): Promise<ConsoleSkillRecord[]> {
  const entries = await readdir(directoryPath, {
    withFileTypes: true,
  });
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && extname(entry.name) === '.ts')
      .map(async (entry) => {
        const path = join(directoryPath, entry.name);
        const content = await readFile(path, 'utf8');

        return {
          name: basename(entry.name, '.ts'),
          path,
          implemented: !content.includes('// Implementation - to be defined'),
        };
      }),
  );

  return skills.sort((left, right) => left.name.localeCompare(right.name));
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
