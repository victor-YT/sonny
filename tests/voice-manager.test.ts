import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import type { Gateway } from '../src/core/gateway.js';
import type { LlmStreamChunk } from '../src/core/providers/llm.js';
import type { PlaybackOptions, PlaybackProvider } from '../src/voice/providers/playback.js';
import type { SttOptions, SttProvider, SttResult } from '../src/voice/providers/stt.js';
import type { TtsOptions, TtsProvider } from '../src/voice/providers/tts.js';
import { VoiceManager } from '../src/voice/voice-manager.js';

class GatewayStreamStub {
  public constructor(private readonly text = 'First sentence. Second sentence.') {}

  public async *streamChat(
    _userMessage: string,
    _options: { signal?: AbortSignal } = {},
  ): AsyncIterable<LlmStreamChunk> {
    yield { type: 'text', text: this.text };
    yield { type: 'done' };
  }
}

class UnusedSttProvider implements SttProvider {
  public readonly name = 'unused-stt';
  public readonly supportsStreaming = false;

  public async transcribe(
    _audio: Buffer,
    _options: SttOptions = {},
  ): Promise<SttResult> {
    throw new Error('STT should not be called by respondToText');
  }
}

class DelayedTtsProvider implements TtsProvider {
  public readonly name = 'delayed-tts';
  public readonly supportsStreaming = false;

  public async synthesize(text: string, _options: TtsOptions = {}): Promise<Buffer> {
    if (text.includes('First')) {
      await delay(30);
    }

    return Buffer.from(text);
  }
}

class RecordingPlaybackProvider implements PlaybackProvider {
  public readonly name = 'recording-playback';
  public readonly playedTexts: string[] = [];

  public async play(audio: Buffer, options: PlaybackOptions = {}): Promise<Buffer> {
    this.playedTexts.push(options.text ?? audio.toString('utf8'));

    return audio;
  }
}

test('VoiceManager preserves spoken sentence order when TTS calls have different latency', async () => {
  const playbackProvider = new RecordingPlaybackProvider();
  const manager = new VoiceManager({
    gateway: new GatewayStreamStub() as unknown as Gateway,
    sttProvider: new UnusedSttProvider(),
    ttsProvider: new DelayedTtsProvider(),
    playbackProvider,
  });

  const response = await manager.respondToText('hello');

  assert.equal(response, 'First sentence. Second sentence.');
  assert.deepStrictEqual(playbackProvider.playedTexts, [
    'First sentence.',
    'Second sentence.',
  ]);
});

test('VoiceManager does not send subprocess diagnostics to TTS', async () => {
  const playbackProvider = new RecordingPlaybackProvider();
  const manager = new VoiceManager({
    gateway: new GatewayStreamStub(
      'bufio.Reader could not be identified to support stdout/stderr, sorry.',
    ) as unknown as Gateway,
    sttProvider: new UnusedSttProvider(),
    ttsProvider: new DelayedTtsProvider(),
    playbackProvider,
  });

  await assert.rejects(
    () => manager.respondToText('hello'),
    /Blocked contaminated assistant output/u,
  );
  assert.deepStrictEqual(playbackProvider.playedTexts, []);
});
