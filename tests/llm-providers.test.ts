import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { test } from 'node:test';

import { OlmxForegroundProvider } from '../src/core/providers/olmx.js';

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
): Promise<{ server: Server; baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : 'Unknown error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
    server.once('error', reject);
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP address');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;

  if (!isRecord(parsed)) {
    throw new Error('Expected request body to be a JSON object');
  }

  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

test('OlmxForegroundProvider sends OpenAI-compatible chat completion requests', async () => {
  let requestBody: Record<string, unknown> = {};

  const server = await startServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    requestBody = await readJsonBody(request);

    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'OLMX connected.',
          },
        },
      ],
    }));
  });

  try {
    const provider = new OlmxForegroundProvider({
      baseUrl: server.baseUrl,
      model: 'Qwen2.5-1.5B-Instruct-4bit',
    });
    const response = await provider.generate(
      [
        {
          role: 'user',
          content: 'ping',
        },
      ],
      {
        systemPrompt: 'You are brief.',
        maxTokens: 24,
        temperature: 0.1,
      },
    );

    assert.equal(requestBody.model, 'Qwen2.5-1.5B-Instruct-4bit');
    assert.equal(requestBody.stream, false);
    assert.equal(requestBody.max_tokens, 24);
    assert.equal(requestBody.temperature, 0.1);
    assert.deepStrictEqual(requestBody.messages, [
      {
        role: 'system',
        content: 'You are brief.',
      },
      {
        role: 'user',
        content: 'ping',
      },
    ]);
    assert.deepStrictEqual(response, {
      role: 'assistant',
      content: 'OLMX connected.',
    });
    assert.equal(provider.getLastDebugInfo()?.streamingUsed, false);
  } finally {
    await server.close();
  }
});

test('OlmxForegroundProvider streams OpenAI-compatible SSE deltas', async () => {
  const server = await startServer(async (request, response) => {
    const requestBody = await readJsonBody(request);

    assert.equal(requestBody.stream, true);
    response.setHeader('content-type', 'text/event-stream');
    response.write('data: {"choices":[{"delta":{"role":"assistant","content":"Hello "}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"there."}}]}\n\n');
    response.end('data: [DONE]\n\n');
  });

  try {
    const provider = new OlmxForegroundProvider({
      baseUrl: server.baseUrl,
      model: 'Qwen2.5-1.5B-Instruct-4bit',
    });
    const chunks: string[] = [];

    for await (const chunk of provider.generateStream([
      {
        role: 'user',
        content: 'hello',
      },
    ])) {
      if (chunk.type === 'text' && chunk.text !== undefined) {
        chunks.push(chunk.text);
      }
    }

    const debug = provider.getLastDebugInfo();

    assert.equal(chunks.join(''), 'Hello there.');
    assert.equal(debug?.streamingUsed, true);
    assert.equal(debug?.failureReason, null);
    assert.notEqual(debug?.firstTokenAt, null);
    assert.notEqual(debug?.firstSentenceAt, null);
    assert.notEqual(debug?.responseFinishedAt, null);
  } finally {
    await server.close();
  }
});
