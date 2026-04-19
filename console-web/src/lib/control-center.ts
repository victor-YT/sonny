export interface RuntimeServiceState {
  label: string
  online: boolean
  url: string | null
  checkedAt: string | null
  error: string | null
}

export interface RuntimeSnapshot {
  currentState: string
  userPartialTranscript: string | null
  micActive: boolean
  playbackActive: boolean
  currentSessionId: string | null
  updatedAt: string
  lastError: string | null
  lastTranscript: string | null
  assistantPartialResponse: string | null
  lastResponseText: string | null
  services: Record<string, RuntimeServiceState>
}

export interface RuntimeLogEntry {
  id: number
  level: string
  type: string
  message: string
  timestamp: string
  meta?: Record<string, unknown> | null
}

export interface ConversationTurn {
  id: number
  status: string
  timestamp: string
  userTranscript: string | null
  assistantText: string | null
}

export interface VoiceSettingsPayload {
  settings: {
    wakeWord: string
    voiceModel: string
  }
}

export interface LastAudioDebugInfo {
  exists: boolean
  path: string | null
  size: number | null
  byteLength: number | null
  durationMs: number | null
  sampleRate: number | null
  channels: number | null
  bitsPerSample: number | null
  format: string | null
  encoding: string | null
  peakAmplitude: number | null
  rmsLevel: number | null
  silentRatio: number | null
  suspectedSilent: boolean | null
  audioQualityHint: string | null
  targetChannels: number | null
  targetSampleRate: number | null
  targetEncoding: string | null
  targetFormat: string | null
  matchesWhisperInputTarget: boolean | null
  whisperInputRisk: string | null
  device: string | null
  usingDefaultDevice: boolean | null
  createdAt: string | null
}

export interface StageDebugState {
  status: string
  error: string | null
}

export interface SttDebugInfo {
  requestUrl: string | null
  httpStatus: number | null
  contentType: string | null
  responseKeys: string[]
  transcriptLength: number | null
  transcript: string | null
  failureReason: string | null
  rawBodyPreview: string | null
}

export interface PipelineLatencyTimestamps {
  micStartAt: string | null
  silenceDetectedAt: string | null
  stopListeningAt: string | null
  sttStartedAt: string | null
  sttFirstChunkAt: string | null
  sttFinishedAt: string | null
  gatewayStartedAt: string | null
  firstTokenAt: string | null
  firstSentenceReadyAt: string | null
  ttsRequestStartedAt: string | null
  ttsFirstAudioReadyAt: string | null
  ttsFinishedAt: string | null
  playbackStartedAt: string | null
  playbackFinishedAt: string | null
}

export interface PipelineLatencyDurations {
  sttLatencyMs: number | null
  silenceToFirstTokenMs: number | null
  silenceToPlaybackFinishedMs: number | null
  gatewayToFirstTokenMs: number | null
  gatewayToFirstSentenceMs: number | null
  ttsToFirstAudioMs: number | null
  ttsFullSynthesisMs: number | null
  stopToFirstSoundMs: number | null
  stopToPlaybackFinishedMs: number | null
}

export interface PipelineDebugInfo {
  flow: string | null
  updatedAt: string | null
  recording: StageDebugState
  stt: StageDebugState
  gateway: StageDebugState
  tts: StageDebugState
  playback: StageDebugState
  sttDebug: SttDebugInfo
  playbackMode: 'streaming-stdin' | 'file-fallback' | 'unknown'
  playerCommand: string | null
  verdict: {
    sttPartials: boolean
    transcriptFinal: boolean
    llmStreaming: boolean
    ttsStreamingPath: boolean
    playbackStarted: boolean
    playbackMode: 'streaming-stdin' | 'file-fallback' | 'unknown'
    fullTurnSuccess: boolean
  }
  latency: {
    timestamps: PipelineLatencyTimestamps
    durations: PipelineLatencyDurations
  }
}

export interface RecorderDebugInfo {
  backend: string
  backendPath: string | null
  device: string | null
  usingDefaultDevice: boolean
  backendAvailable: boolean
  spawnStarted: boolean
  firstChunkReceived: boolean
  startTimeoutMs: number
  lastFailureReason: string | null
  lastSpawnError: string | null
  lastStderr: string | null
  micPermissionHint: string | null
}

export type ConnectionState = 'connected' | 'disconnected'
export type NoticeLevel = 'info' | 'error'

export interface NoticeState {
  level: NoticeLevel
  message: string
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return 'Unknown'
  }

  return new Date(value).toLocaleString()
}

export function formatDuration(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Unknown' : `${value}ms`
}

export function formatMetric(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Unknown' : value.toFixed(4)
}

export function formatMaybeNumber(
  value: number | null | undefined,
  suffix: string,
): string {
  return value === null || value === undefined ? 'Unknown' : `${value}${suffix}`
}

export function formatOffsetFromStop(
  stopAt: string | null,
  currentAt: string | null,
): string {
  if (!stopAt || !currentAt) {
    return 'Pending'
  }

  const stopTime = Date.parse(stopAt)
  const currentTime = Date.parse(currentAt)

  if (!Number.isFinite(stopTime) || !Number.isFinite(currentTime)) {
    return 'Unknown'
  }

  return `+${Math.max(0, currentTime - stopTime)}ms`
}

export function formatLogMeta(meta?: Record<string, unknown> | null): string {
  if (!meta) {
    return 'No extra metadata.'
  }

  const entries = Object.entries(meta).filter(([, value]) => value !== null)

  if (entries.length === 0) {
    return 'No extra metadata.'
  }

  return entries.map(([key, value]) => `${key}=${String(value)}`).join('\n')
}

export function formatState(value: string): string {
  return value.replaceAll('_', ' ')
}

export function normalizeStateClass(snapshot: RuntimeSnapshot): string {
  if (snapshot.lastError) {
    return 'error'
  }

  if (
    snapshot.currentState === 'listening' ||
    snapshot.currentState === 'transcribing' ||
    snapshot.currentState === 'thinking' ||
    snapshot.currentState === 'speaking'
  ) {
    return snapshot.currentState === 'transcribing' ? 'thinking' : snapshot.currentState
  }

  return 'idle'
}

export function describeRuntime(snapshot: RuntimeSnapshot): string {
  if (snapshot.lastError) {
    return 'The runtime is in an error state. Inspect diagnostics or reset to idle before the next turn.'
  }

  switch (snapshot.currentState) {
    case 'listening':
      return 'Listening live. Speak naturally and Sonny will advance automatically after a short silence.'
    case 'transcribing':
      return 'Speech ended. Sonny is finalizing the transcript and preparing the response.'
    case 'thinking':
      return 'Transcript locked. Sonny is generating the response and preparing speech output.'
    case 'speaking':
      return 'Playback is active. The latest synthesized response is currently being spoken back.'
    default:
      return 'Sonny is idle and ready for the next manual voice turn.'
  }
}

export function describeNotice(
  snapshot: RuntimeSnapshot | null,
  connection: ConnectionState,
): NoticeState {
  if (connection === 'disconnected') {
    return {
      level: 'error',
      message:
        'Runtime event stream disconnected. The visible state may be stale until the stream reconnects.',
    }
  }

  if (snapshot === null) {
    return {
      level: 'info',
      message: 'Runtime stream connected. Waiting for the latest snapshot.',
    }
  }

  if (snapshot.lastError) {
    return {
      level: 'error',
      message: snapshot.lastError,
    }
  }

  switch (snapshot.currentState) {
    case 'listening':
      return {
        level: 'info',
        message: 'Listening live. Sonny will stop the turn automatically after a short silence.',
      }
    case 'transcribing':
      return {
        level: 'info',
        message: 'Speech detected and capture stopped. STT is finalizing the live transcript.',
      }
    case 'thinking':
      return {
        level: 'info',
        message:
          'Processing the latest turn. Use diagnostics to inspect STT, gateway timing, and TTS latency.',
      }
    case 'speaking':
      return {
        level: 'info',
        message: 'Playback started. Interrupt if you need to cut the current response short.',
      }
    default:
      return {
        level: 'info',
        message:
          'Runtime ready. Start listening to run a manual end-to-end voice turn.',
      }
  }
}

export function compareServicePriority(service: RuntimeServiceState): number {
  const normalized = service.label.toLowerCase()

  if (normalized.includes('whisper') || normalized.includes('stt')) {
    return 0
  }

  if (normalized.includes('tts') || normalized.includes('chatterbox')) {
    return 1
  }

  if (normalized.includes('ollama') || normalized.includes('gateway')) {
    return 2
  }

  if (normalized.includes('recorder')) {
    return 3
  }

  if (normalized.includes('wake')) {
    return 4
  }

  if (normalized.includes('vad')) {
    return 5
  }

  return 6
}

export function shouldDimService(service: RuntimeServiceState): boolean {
  const normalized = service.label.toLowerCase()

  return !service.online && (normalized.includes('wake') || normalized.includes('vad'))
}

export function buildLastAudioDebug(info: LastAudioDebugInfo | null): string {
  if (info === null || info.exists !== true) {
    return [
      'No recording metadata yet.',
      '',
      'Run a manual capture to inspect sample rate, RMS, silence ratio, and Whisper input compatibility.',
    ].join('\n')
  }

  return [
    `Path: ${info.path ?? 'Unknown'}`,
    `Size: ${String(info.size ?? 0)} bytes`,
    `Byte Length: ${String(info.byteLength ?? 'Unknown')} bytes`,
    `Duration: ${formatMaybeNumber(info.durationMs, 'ms')}`,
    `Sample Rate: ${formatMaybeNumber(info.sampleRate, 'Hz')}`,
    `Channels: ${String(info.channels ?? 'Unknown')}`,
    `Bits Per Sample: ${String(info.bitsPerSample ?? 'Unknown')}`,
    `Format: ${info.format ?? 'Unknown'}`,
    `Encoding: ${info.encoding ?? 'Unknown'}`,
    `Peak Amplitude: ${formatMetric(info.peakAmplitude)}`,
    `RMS Level: ${formatMetric(info.rmsLevel)}`,
    `Silent Ratio: ${formatMetric(info.silentRatio)}`,
    `Suspected Silence: ${String(info.suspectedSilent ?? 'Unknown')}`,
    `Quality Hint: ${info.audioQualityHint ?? 'Unknown'}`,
    `Whisper Target: ${info.targetChannels ?? 'Unknown'}ch / ${info.targetSampleRate ?? 'Unknown'}Hz / ${info.targetEncoding ?? 'Unknown'} / ${info.targetFormat ?? 'Unknown'}`,
    `Target Match: ${String(info.matchesWhisperInputTarget ?? 'Unknown')}`,
    `Target Risk: ${info.whisperInputRisk ?? 'None'}`,
    `Input Device: ${info.device ?? 'Unknown/default'}`,
    `Default Device: ${String(info.usingDefaultDevice ?? 'Unknown')}`,
    `Saved: ${formatDateTime(info.createdAt)}`,
  ].join('\n')
}

export function buildPipelineDebug(pipeline: PipelineDebugInfo | null): string {
  if (pipeline === null) {
    return 'No pipeline run yet.'
  }

  return [
    `Flow: ${pipeline.flow ?? 'None'}`,
    `Updated: ${formatDateTime(pipeline.updatedAt)}`,
    '',
    `recording: ${pipeline.recording.status}${pipeline.recording.error ? ` (${pipeline.recording.error})` : ''}`,
    `stt: ${pipeline.stt.status}${pipeline.stt.error ? ` (${pipeline.stt.error})` : ''}`,
    `gateway: ${pipeline.gateway.status}${pipeline.gateway.error ? ` (${pipeline.gateway.error})` : ''}`,
    `tts: ${pipeline.tts.status}${pipeline.tts.error ? ` (${pipeline.tts.error})` : ''}`,
    `playback: ${pipeline.playback.status}${pipeline.playback.error ? ` (${pipeline.playback.error})` : ''}`,
    `playbackMode: ${pipeline.playbackMode}`,
    `playerCommand: ${pipeline.playerCommand ?? 'Unknown'}`,
    '',
    `micStartAt: ${pipeline.latency.timestamps.micStartAt ?? 'Unknown'}`,
    `silenceDetectedAt: ${pipeline.latency.timestamps.silenceDetectedAt ?? 'Unknown'}`,
    `stopListeningAt: ${pipeline.latency.timestamps.stopListeningAt ?? 'Unknown'}`,
    `sttStartedAt: ${pipeline.latency.timestamps.sttStartedAt ?? 'Unknown'}`,
    `sttFirstChunkAt: ${pipeline.latency.timestamps.sttFirstChunkAt ?? 'Unknown'}`,
    `sttFinishedAt: ${pipeline.latency.timestamps.sttFinishedAt ?? 'Unknown'}`,
    `gatewayStartedAt: ${pipeline.latency.timestamps.gatewayStartedAt ?? 'Unknown'}`,
    `firstTokenAt: ${pipeline.latency.timestamps.firstTokenAt ?? 'Unknown'}`,
    `firstSentenceReadyAt: ${pipeline.latency.timestamps.firstSentenceReadyAt ?? 'Unknown'}`,
    `ttsRequestStartedAt: ${pipeline.latency.timestamps.ttsRequestStartedAt ?? 'Unknown'}`,
    `ttsFirstAudioReadyAt: ${pipeline.latency.timestamps.ttsFirstAudioReadyAt ?? 'Unknown'}`,
    `ttsFinishedAt: ${pipeline.latency.timestamps.ttsFinishedAt ?? 'Unknown'}`,
    `playbackStartedAt: ${pipeline.latency.timestamps.playbackStartedAt ?? 'Unknown'}`,
    `playbackFinishedAt: ${pipeline.latency.timestamps.playbackFinishedAt ?? 'Unknown'}`,
    '',
    `sttLatencyMs: ${formatDuration(pipeline.latency.durations.sttLatencyMs)}`,
    `silenceToFirstTokenMs: ${formatDuration(pipeline.latency.durations.silenceToFirstTokenMs)}`,
    `silenceToPlaybackFinishedMs: ${formatDuration(pipeline.latency.durations.silenceToPlaybackFinishedMs)}`,
    `gatewayToFirstTokenMs: ${formatDuration(pipeline.latency.durations.gatewayToFirstTokenMs)}`,
    `gatewayToFirstSentenceMs: ${formatDuration(pipeline.latency.durations.gatewayToFirstSentenceMs)}`,
    `ttsToFirstAudioMs: ${formatDuration(pipeline.latency.durations.ttsToFirstAudioMs)}`,
    `ttsFullSynthesisMs: ${formatDuration(pipeline.latency.durations.ttsFullSynthesisMs)}`,
    `stopToFirstSoundMs: ${formatDuration(pipeline.latency.durations.stopToFirstSoundMs)}`,
    `stopToPlaybackFinishedMs: ${formatDuration(pipeline.latency.durations.stopToPlaybackFinishedMs)}`,
    '',
    `Verdict STT Partials: ${pipeline.verdict.sttPartials ? 'yes' : 'no'}`,
    `Verdict Transcript Final: ${pipeline.verdict.transcriptFinal ? 'yes' : 'no'}`,
    `Verdict LLM Streaming: ${pipeline.verdict.llmStreaming ? 'yes' : 'no'}`,
    `Verdict TTS Streaming Path: ${pipeline.verdict.ttsStreamingPath ? 'yes' : 'no'}`,
    `Verdict Playback Started: ${pipeline.verdict.playbackStarted ? 'yes' : 'no'}`,
    `Verdict Playback Mode: ${pipeline.verdict.playbackMode}`,
    `Verdict Full Turn Success: ${pipeline.verdict.fullTurnSuccess ? 'yes' : 'no'}`,
  ].join('\n')
}

export function buildSttDebug(pipeline: PipelineDebugInfo | null): string {
  if (pipeline === null) {
    return 'No STT debug yet.'
  }

  return [
    `Request URL: ${pipeline.sttDebug.requestUrl ?? 'Unknown'}`,
    `HTTP Status: ${String(pipeline.sttDebug.httpStatus ?? 'Unknown')}`,
    `Content Type: ${pipeline.sttDebug.contentType ?? 'Unknown'}`,
    `Response Keys: ${
      pipeline.sttDebug.responseKeys.length === 0
        ? 'None'
        : pipeline.sttDebug.responseKeys.join(', ')
    }`,
    `Transcript Length: ${String(pipeline.sttDebug.transcriptLength ?? 'Unknown')}`,
    `Transcript: ${pipeline.sttDebug.transcript ?? 'None'}`,
    `Failure Reason: ${pipeline.sttDebug.failureReason ?? 'None'}`,
    '',
    'Raw Body:',
    pipeline.sttDebug.rawBodyPreview ?? 'None',
  ].join('\n')
}

export function buildRecorderDebug(recorder: RecorderDebugInfo | null): string {
  if (recorder === null) {
    return 'No recorder diagnostics yet.'
  }

  return [
    `Backend: ${recorder.backend}`,
    `Backend Path: ${recorder.backendPath ?? 'Not found'}`,
    `Input Device: ${recorder.device ?? 'Unknown/default'}`,
    `Default Device: ${String(recorder.usingDefaultDevice)}`,
    `Available: ${String(recorder.backendAvailable)}`,
    `Spawn Started: ${String(recorder.spawnStarted)}`,
    `First Chunk Received: ${String(recorder.firstChunkReceived)}`,
    `Start Timeout: ${recorder.startTimeoutMs}ms`,
    `Last Failure Reason: ${recorder.lastFailureReason ?? 'None'}`,
    `Last Spawn Error: ${recorder.lastSpawnError ?? 'None'}`,
    `Last Stderr: ${recorder.lastStderr ?? 'None'}`,
    `Mic Permission Hint: ${recorder.micPermissionHint ?? 'None'}`,
  ].join('\n')
}
