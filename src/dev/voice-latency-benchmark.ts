import {
  extractAggressiveSpeechSegments,
  extractConservativeSpeechSegments,
} from '../voice/voice-manager.js';

interface BenchmarkScenario {
  question: string;
  responseChunks: string[];
}

interface BenchmarkResult {
  question: string;
  baselineGatewayToFirstSentenceMs: number;
  optimizedGatewayToFirstSentenceMs: number;
  baselineStopToFirstSoundMs: number;
  optimizedStopToFirstSoundMs: number;
}

const STT_LATENCY_MS = 3_000;
const CHUNK_INTERVAL_MS = 220;
const BASELINE_TTS_TO_FIRST_SOUND_MS = 1_200;
const OPTIMIZED_TTS_TO_FIRST_SOUND_MS = 450;

const SCENARIOS: BenchmarkScenario[] = [
  {
    question: '你是谁？',
    responseChunks: [
      'I am ',
      'Sonny, ',
      'your local-first ',
      'voice assistant ',
      'built for fast ',
      'manual voice control.',
    ],
  },
  {
    question: '你好啊你是谁',
    responseChunks: [
      'Hi, ',
      'I am Sonny, ',
      'your local-first ',
      'voice assistant ',
      'ready to help.',
    ],
  },
  {
    question: 'test manual voice mode',
    responseChunks: [
      'Manual voice ',
      'mode is online ',
      'and ready ',
      'for testing.',
    ],
  },
];

function main(): void {
  const results = SCENARIOS.map(runScenario);

  console.log('Latency benchmark (controlled simulation)');
  console.log(`Assumptions: STT=${STT_LATENCY_MS}ms, chunkInterval=${CHUNK_INTERVAL_MS}ms, baselineTTS=${BASELINE_TTS_TO_FIRST_SOUND_MS}ms, optimizedTTS=${OPTIMIZED_TTS_TO_FIRST_SOUND_MS}ms`);

  for (const result of results) {
    console.log(`\nQuestion: ${result.question}`);
    console.log(`A baseline gateway->firstSentence: ${result.baselineGatewayToFirstSentenceMs}ms`);
    console.log(`B optimized gateway->firstSentence: ${result.optimizedGatewayToFirstSentenceMs}ms`);
    console.log(`A baseline stopToFirstSound: ${result.baselineStopToFirstSoundMs}ms`);
    console.log(`B optimized stopToFirstSound: ${result.optimizedStopToFirstSoundMs}ms`);
  }
}

function runScenario(scenario: BenchmarkScenario): BenchmarkResult {
  const baselineGatewayToFirstSentenceMs = measureFirstSentenceReady(
    scenario.responseChunks,
    extractConservativeSpeechSegments,
  );
  const optimizedGatewayToFirstSentenceMs = measureFirstSentenceReady(
    scenario.responseChunks,
    extractAggressiveSpeechSegments,
  );

  return {
    question: scenario.question,
    baselineGatewayToFirstSentenceMs,
    optimizedGatewayToFirstSentenceMs,
    baselineStopToFirstSoundMs:
      STT_LATENCY_MS +
      baselineGatewayToFirstSentenceMs +
      BASELINE_TTS_TO_FIRST_SOUND_MS,
    optimizedStopToFirstSoundMs:
      STT_LATENCY_MS +
      optimizedGatewayToFirstSentenceMs +
      OPTIMIZED_TTS_TO_FIRST_SOUND_MS,
  };
}

function measureFirstSentenceReady(
  chunks: string[],
  extractor: (text: string) => { sentences: string[]; remainder: string },
): number {
  let buffered = '';

  for (const [index, chunk] of chunks.entries()) {
    buffered += chunk;
    const extracted = extractor(buffered);

    if (extracted.sentences.length > 0) {
      return (index + 1) * CHUNK_INTERVAL_MS;
    }

    buffered = extracted.remainder;
  }

  return chunks.length * CHUNK_INTERVAL_MS;
}

main();
