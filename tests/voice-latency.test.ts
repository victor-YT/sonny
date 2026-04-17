import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  extractAggressiveSpeechSegments,
  extractConservativeSpeechSegments,
} from '../src/voice/voice-manager.js';
import { ResponseProcessor } from '../src/voice/response-processor.js';

test('aggressive speech segmentation can release an early spoken segment before terminal punctuation', () => {
  const text = 'I am Sonny your local first voice assistant ready to help';

  const conservative = extractConservativeSpeechSegments(text);
  const aggressive = extractAggressiveSpeechSegments(text);

  assert.deepStrictEqual(conservative, {
    sentences: [],
    remainder: text,
  });
  assert.deepStrictEqual(aggressive, {
    sentences: [text],
    remainder: '',
  });
});

test('ResponseProcessor replaces Sonny with 桑尼 in Chinese speech context only', () => {
  const processor = new ResponseProcessor();

  const chinese = processor.process('你好，我是 Sonny。');
  const english = processor.process('Hi, I am Sonny.');

  assert.match(chinese.plainText, /桑尼/u);
  assert.match(english.plainText, /Sonny/u);
});
