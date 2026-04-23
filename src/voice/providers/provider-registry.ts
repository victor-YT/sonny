import type { RuntimeConfig } from '../../core/config.js';
import { FasterWhisperProvider } from './faster-whisper.js';
import type { PlaybackProvider } from './playback.js';
import type { SttProvider } from './stt.js';
import { SystemPlaybackProvider } from './system-playback.js';
import { ChatterboxProvider } from './chatterbox.js';
import type { TtsProvider } from './tts.js';
import type { StreamingAudioQueue } from '../streaming-audio-queue.js';

export function createConfiguredSttProvider(runtimeConfig: RuntimeConfig): SttProvider {
  switch (runtimeConfig.sttProvider) {
    case 'faster-whisper':
      return new FasterWhisperProvider({
        baseUrl: runtimeConfig.voice.fasterWhisper.url,
      });
    default:
      throw new Error(`Unsupported STT provider "${runtimeConfig.sttProvider}".`);
  }
}

export function createConfiguredTtsProvider(runtimeConfig: RuntimeConfig): TtsProvider {
  switch (runtimeConfig.ttsProvider) {
    case 'qwen3-tts':
    case 'chatterbox':
      return new ChatterboxProvider({
        baseUrl: runtimeConfig.voice.chatterbox.url,
      });
    default:
      throw new Error(`Unsupported TTS provider "${runtimeConfig.ttsProvider}".`);
  }
}

export function createConfiguredPlaybackProvider(
  runtimeConfig: RuntimeConfig,
  playbackQueue: StreamingAudioQueue,
): PlaybackProvider {
  switch (runtimeConfig.playbackProvider) {
    case 'system-player':
      return new SystemPlaybackProvider({
        playbackQueue,
      });
    default:
      throw new Error(`Unsupported playback provider "${runtimeConfig.playbackProvider}".`);
  }
}
