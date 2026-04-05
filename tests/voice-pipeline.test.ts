import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { test } from 'node:test';

import { ChatterboxProvider } from '../src/voice/providers/chatterbox.js';
import { FasterWhisperProvider } from '../src/voice/providers/faster-whisper.js';

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

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  const parsed = JSON.parse(body.toString('utf8')) as unknown;

  if (!isRecord(parsed)) {
    throw new Error('Expected a JSON object body');
  }

  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

test('FasterWhisperProvider sends audio bytes and parses JSON transcripts', async () => {
  const audio = Buffer.from('RIFF-test-audio');
  let receivedBody: Buffer = Buffer.alloc(0);
  let receivedHeaders: IncomingMessage['headers'] = {};

  const server = await startServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/transcribe');
    receivedHeaders = request.headers;
    receivedBody = await readBody(request);

    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        text: 'systems nominal',
        language: 'en',
        confidence: 0.98,
        segments: [
          {
            text: 'systems nominal',
            start: 0,
            end: 1.2,
          },
        ],
      }),
    );
  });

  try {
    const provider = new FasterWhisperProvider({ baseUrl: server.baseUrl });
    const result = await provider.transcribe(audio, {
      language: 'en',
      prompt: 'prefer terminal terms',
    });

    assert.deepStrictEqual(receivedBody, audio);
    assert.equal(receivedHeaders['content-type'], 'audio/wav');
    assert.equal(receivedHeaders['x-audio-filename'], 'audio.wav');
    assert.equal(receivedHeaders['x-language'], 'en');
    assert.equal(receivedHeaders['x-prompt'], 'prefer terminal terms');
    assert.deepStrictEqual(result, {
      text: 'systems nominal',
      language: 'en',
      confidence: 0.98,
      segments: [
        {
          text: 'systems nominal',
          start: 0,
          end: 1.2,
        },
      ],
    });
  } finally {
    await server.close();
  }
});

test('FasterWhisperProvider streams NDJSON transcript updates', async () => {
  const audioChunks = [Buffer.from('first'), Buffer.from('second')];
  let streamedRequestBody: Buffer = Buffer.alloc(0);

  const server = await startServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/transcribe?stream=true');
    streamedRequestBody = await readBody(request);

    response.setHeader('content-type', 'application/x-ndjson');
    response.write(
      `${JSON.stringify({ text: 'sys', language: 'en', confidence: 0.5 })}\n`,
    );
    response.end(
      `${JSON.stringify({ text: 'systems nominal', language: 'en', confidence: 0.98 })}\n`,
    );
  });

  async function* createAudioStream(): AsyncIterable<Buffer> {
    for (const chunk of audioChunks) {
      yield chunk;
    }
  }

  try {
    const provider = new FasterWhisperProvider({ baseUrl: server.baseUrl });
    const results = [];

    for await (const result of provider.streamTranscribe(createAudioStream())) {
      results.push(result);
    }

    assert.deepStrictEqual(streamedRequestBody, Buffer.concat(audioChunks));
    assert.deepStrictEqual(results, [
      {
        text: 'sys',
        language: 'en',
        confidence: 0.5,
        segments: undefined,
      },
      {
        text: 'systems nominal',
        language: 'en',
        confidence: 0.98,
        segments: undefined,
      },
    ]);
  } finally {
    await server.close();
  }
});

test('ChatterboxProvider sends JSON payloads that match the bundled TTS service', async () => {
  const audio = Buffer.from('RIFF-qwen3-tts');
  let receivedPayload: Record<string, unknown> | undefined;

  const server = await startServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/synthesize');
    receivedPayload = await readJsonBody(request);

    response.setHeader('content-type', 'audio/wav');
    response.end(audio);
  });

  try {
    const provider = new ChatterboxProvider({ baseUrl: server.baseUrl });
    const result = await provider.synthesize('Say it plainly.', {
      voice: 'Ryan',
      emotion: 'calm',
      exaggeration: 1.1,
    });

    assert.equal(receivedPayload?.text, 'Say it plainly.');
    assert.equal(receivedPayload?.stream, false);
    assert.equal(receivedPayload?.speaker, 'Ryan');
    assert.equal(receivedPayload?.emotion, 'calm');
    assert.equal(receivedPayload?.exaggeration, 1.1);
    assert.deepStrictEqual(result, audio);
  } finally {
    await server.close();
  }
});

test('ChatterboxProvider yields streamed audio chunks from the TTS service', async () => {
  const audioChunks = [Buffer.from('RIFF'), Buffer.from('-streamed'), Buffer.from('-audio')];

  const server = await startServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/synthesize/stream');

    const payload = await readJsonBody(request);

    assert.equal(payload.text, 'Stream this.');
    assert.equal(payload.stream, true);
    assert.equal(payload.speaker, 'Ryan');
    assert.equal(payload.emotion, 'neutral');

    response.setHeader('content-type', 'audio/wav');

    for (const chunk of audioChunks) {
      response.write(chunk);
    }

    response.end();
  });

  try {
    const provider = new ChatterboxProvider({ baseUrl: server.baseUrl });
    const streamedChunks: Buffer[] = [];

    if (provider.streamSynthesize === undefined) {
      throw new Error('Expected streamSynthesize() to be available');
    }

    for await (const chunk of provider.streamSynthesize('Stream this.', {
      voice: 'Ryan',
      emotion: 'neutral',
    })) {
      streamedChunks.push(chunk);
    }

    assert.deepStrictEqual(Buffer.concat(streamedChunks), Buffer.concat(audioChunks));
  } finally {
    await server.close();
  }
});
