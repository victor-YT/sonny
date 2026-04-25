import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import {
  SonnyHome,
  SonnyShell,
  buildSonnyControlState,
  useSonnyDocumentBackground,
  useTransientBusy,
  type SonnyTab,
} from '@/components/sonny-home'
import { SonnyModelsPage } from '@/components/sonny-models-page'
import { SonnySettingsPage } from '@/components/sonny-settings-page'
import {
  buildLastAudioDebug,
  buildPipelineDebug,
  buildRecorderDebug,
  buildSttDebug,
  describeNotice,
  formatDateTime,
  formatDuration,
  formatLogMeta,
  formatOffsetFromStop,
  formatState,
  type ConnectionState,
  type ConversationTurn,
  type LastAudioDebugInfo,
  type NoticeState,
  type PipelineDebugInfo,
  type RecorderDebugInfo,
  type RuntimeLogEntry,
  type RuntimeSnapshot,
  type TurnTimelineDebugInfo,
  type TurnTimelineStage,
  type VoiceSettingsPayload,
} from '@/lib/control-center'

type DiagnosticsTab =
  | 'conversation'
  | 'events'
  | 'pipeline'
  | 'stt'
  | 'recorder'
  | 'audio'

type MainPage = SonnyTab

interface ControlState {
  snapshot: RuntimeSnapshot | null
  logs: RuntimeLogEntry[]
  conversation: ConversationTurn[]
  voiceSettings: VoiceSettingsPayload | null
  lastAudio: LastAudioDebugInfo | null
  pipeline: PipelineDebugInfo | null
  recorder: RecorderDebugInfo | null
}

interface StateEventPayload {
  type: 'snapshot' | 'log' | 'conversation'
  snapshot?: RuntimeSnapshot
  entry?: RuntimeLogEntry
  turn?: ConversationTurn
}

const DEBUG_REFRESH_TYPES = new Set([
  'manual_listen_started',
  'manual_listen_stopped',
  'manual_capture_stop_requested',
  'recording_started',
  'silence_detected',
  'recording_backend_detected',
  'recording_backend_missing',
  'recording_spawn_started',
  'recording_spawn_failed',
  'recording_stderr',
  'recording_first_chunk_received',
  'recording_start_timeout',
  'recording_start_failed',
  'recording_stopped',
  'recording_saved',
  'recording_input_silent',
  'recording_format_warning',
  'stt_started',
  'stt_first_chunk',
  'stt_finished',
  'stt_failed',
  'stt_empty_transcript_ignored',
  'gateway_started',
  'gateway_first_token',
  'gateway_response_chunk',
  'gateway_response_before_tts',
  'gateway_first_sentence_ready',
  'gateway_finished',
  'gateway_failed',
  'tts_started',
  'tts_request_started',
  'tts_first_audio_ready',
  'tts_finished',
  'tts_failed',
  'tts_warmup_started',
  'tts_warmup_finished',
  'tts_warmup_failed',
  'playback_started',
  'playback_finished',
  'playback_interrupted',
  'barge_in_detected',
  'playback_interrupted_by_user',
  'barge_in_listening_restarted',
  'voice_pipeline_completed',
  'voice_pipeline_failed',
  'runtime_reset',
  'stt_retranscribe_started',
  'stt_retranscribe_finished',
  'stt_retranscribe_failed',
])

const FLOW_STEPS = [
  { key: 'stopListeningAt', label: 'Stop' },
  { key: 'sttFinishedAt', label: 'STT' },
  { key: 'firstTokenAt', label: '1st Token' },
  { key: 'firstSentenceReadyAt', label: '1st Sentence' },
  { key: 'ttsFirstAudioReadyAt', label: '1st Audio' },
  { key: 'playbackStartedAt', label: '1st Sound' },
  { key: 'playbackFinishedAt', label: 'Done' },
] as const

function App() {
  useSonnyDocumentBackground()

  const [controlState, setControlState] = useState<ControlState>({
    snapshot: null,
    logs: [],
    conversation: [],
    voiceSettings: null,
    lastAudio: null,
    pipeline: null,
    recorder: null,
  })
  const [activePage, setActivePage] = useState<MainPage>('home')
  const [activeTab, setActiveTab] = useState<DiagnosticsTab>('conversation')
  const [connection, setConnection] = useState<ConnectionState>('connected')
  const [notice, setNotice] = useState<NoticeState>({
    level: 'info',
    message: 'Runtime stream connected. Waiting for the latest snapshot.',
  })

  useEffect(() => {
    let cancelled = false

    async function initialize() {
      try {
        const [snapshot, logs, conversation, voiceSettings, debugState] =
          await Promise.all([
            requestJson<RuntimeSnapshot>('/api/runtime/state'),
            requestJson<{ logs: RuntimeLogEntry[] }>('/api/runtime/logs'),
            requestJson<{ conversation: ConversationTurn[] }>(
              '/api/runtime/conversation',
            ),
            requestJson<VoiceSettingsPayload>('/api/voice-settings'),
            loadDebugState(),
          ])

        if (cancelled) {
          return
        }

        setControlState({
          snapshot,
          logs: logs.logs ?? [],
          conversation: conversation.conversation ?? [],
          voiceSettings,
          lastAudio: debugState.lastAudio,
          pipeline: debugState.pipeline,
          recorder: debugState.recorder,
        })
        setConnection('connected')
      } catch (error) {
        if (cancelled) {
          return
        }

        setNotice({
          level: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    void initialize()

    const source = new EventSource('/api/runtime/events')

    source.onopen = () => {
      if (!cancelled) {
        setConnection('connected')
      }
    }

    source.onerror = () => {
      if (!cancelled) {
        setConnection('disconnected')
      }
    }

    source.onmessage = (message) => {
      if (cancelled) {
        return
      }

      const payload = JSON.parse(message.data) as StateEventPayload

      if (payload.type === 'snapshot' && payload.snapshot) {
        setControlState((previous) => ({
          ...previous,
          snapshot: payload.snapshot ?? previous.snapshot,
        }))
        return
      }

      if (payload.type === 'log' && payload.entry) {
        setControlState((previous) => ({
          ...previous,
          logs: upsertById(previous.logs, payload.entry!, 300),
        }))

        if (DEBUG_REFRESH_TYPES.has(payload.entry.type)) {
          void refreshDebugState()
        }

        return
      }

      if (payload.type === 'conversation' && payload.turn) {
        setControlState((previous) => ({
          ...previous,
          conversation: upsertById(previous.conversation, payload.turn!, 80),
        }))
      }
    }

    async function refreshDebugState() {
      try {
        const debugState = await loadDebugState()

        if (cancelled) {
          return
        }

        setControlState((previous) => ({
          ...previous,
          lastAudio: debugState.lastAudio,
          pipeline: debugState.pipeline,
          recorder: debugState.recorder,
        }))
      } catch (error) {
        if (cancelled) {
          return
        }

        setNotice({
          level: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return () => {
      cancelled = true
      source.close()
    }
  }, [])

  useEffect(() => {
    setNotice(
      describeNotice(
        controlState.snapshot,
        connection,
        controlState.recorder,
        controlState.lastAudio,
      ),
    )
  }, [controlState.snapshot, connection, controlState.recorder, controlState.lastAudio])

  const pipelineDebugText = useMemo(() => {
    return buildPipelineDebug(controlState.pipeline)
  }, [controlState.pipeline])

  const sttDebugText = useMemo(() => {
    return buildSttDebug(controlState.pipeline)
  }, [controlState.pipeline])

  const recorderDebugText = useMemo(() => {
    return buildRecorderDebug(controlState.recorder)
  }, [controlState.recorder])

  const lastAudioText = useMemo(() => {
    return buildLastAudioDebug(controlState.lastAudio)
  }, [controlState.lastAudio])

  const sessionText = controlState.snapshot?.currentSessionId
    ? `Session ${controlState.snapshot.currentSessionId}`
    : 'Session none'
  async function refreshAll() {
    const [snapshot, logs, conversation, debugState] = await Promise.all([
      requestJson<RuntimeSnapshot>('/api/runtime/state'),
      requestJson<{ logs: RuntimeLogEntry[] }>('/api/runtime/logs'),
      requestJson<{ conversation: ConversationTurn[] }>('/api/runtime/conversation'),
      loadDebugState(),
    ])

    setControlState((previous) => ({
      ...previous,
      snapshot,
      logs: logs.logs ?? [],
      conversation: conversation.conversation ?? [],
      lastAudio: debugState.lastAudio,
      pipeline: debugState.pipeline,
      recorder: debugState.recorder,
    }))
  }

  async function handlePost(path: string, body?: unknown) {
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers:
          body === undefined
            ? undefined
            : {
                'content-type': 'application/json',
              },
        body: body === undefined ? undefined : JSON.stringify(body),
      })

      if (!response.ok) {
        throw await toRequestError(response)
      }

      await refreshAll()
    } catch (error) {
      await Promise.allSettled([refreshAll()])
      setNotice({
        level: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const micActive = controlState.snapshot?.micActive === true
  const playbackActive = controlState.snapshot?.playbackActive === true
  const backendState = controlState.snapshot?.currentState ?? 'idle'

  const sonnyControl = useMemo(
    () =>
      buildSonnyControlState({
        backendState,
        micActive,
        playbackActive,
        userPartial: controlState.snapshot?.userPartialTranscript ?? null,
        lastTranscript: controlState.snapshot?.lastTranscript ?? null,
        assistantPartial: controlState.snapshot?.assistantPartialResponse ?? null,
        lastResponse: controlState.snapshot?.lastResponseText ?? null,
        totalLatencyMs:
          controlState.pipeline?.latency.durations.stopToPlaybackFinishedMs ??
          controlState.pipeline?.latency.durations.silenceToPlaybackFinishedMs ??
          null,
      }),
    [
      backendState,
      controlState.pipeline?.latency.durations.silenceToPlaybackFinishedMs,
      controlState.pipeline?.latency.durations.stopToPlaybackFinishedMs,
      controlState.snapshot?.assistantPartialResponse,
      controlState.snapshot?.lastResponseText,
      controlState.snapshot?.lastTranscript,
      controlState.snapshot?.userPartialTranscript,
      micActive,
      playbackActive,
    ],
  )

  const { busy, run: runAction } = useTransientBusy(300)

  const errorMessage =
    notice.level === 'error'
      ? (controlState.snapshot?.lastError ?? notice.message)
      : null

  return (
    <SonnyShell
      activeTab={activePage}
      connected={connection === 'connected'}
      onTabChange={setActivePage}
    >
      {activePage === 'home' ? (
        <SonnyHome
          state={sonnyControl.state}
          connected={connection === 'connected'}
          youText={sonnyControl.youText}
          sonnyText={sonnyControl.sonnyText}
          totalLatencyMs={sonnyControl.totalLatencyMs}
          busy={busy}
          errorMessage={errorMessage}
          onStartListening={() =>
            runAction(() => handlePost('/api/voice/listen/start'))
          }
          onInterrupt={() => {
            const path = playbackActive
              ? '/api/voice/playback/interrupt'
              : '/api/voice/listen/stop'
            runAction(() => handlePost(path))
          }}
          onNewSession={() =>
            runAction(() => handlePost('/api/runtime/reset'))
          }
        />
      ) : activePage === 'models' ? (
        <SonnyModelsPage />
      ) : activePage === 'settings' ? (
        <SonnySettingsPage />
      ) : (
        <main
          className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8"
          style={{ flex: 1, color: 'rgba(255,255,255,0.82)' }}
        >
          <DeveloperPage
            activeTab={activeTab}
            controlState={controlState}
            lastAudioText={lastAudioText}
            pipelineDebugText={pipelineDebugText}
            recorderDebugText={recorderDebugText}
            sessionText={sessionText}
            sttDebugText={sttDebugText}
            onActiveTabChange={setActiveTab}
          />
        </main>
      )}
    </SonnyShell>
  )
}


function DeveloperPage({
  activeTab,
  controlState,
  lastAudioText,
  pipelineDebugText,
  recorderDebugText,
  sessionText,
  sttDebugText,
  onActiveTabChange,
}: {
  activeTab: DiagnosticsTab
  controlState: ControlState
  lastAudioText: string
  pipelineDebugText: string
  recorderDebugText: string
  sessionText: string
  sttDebugText: string
  onActiveTabChange: (tab: DiagnosticsTab) => void
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Control Center</h1>
          <p className="text-sm text-muted-foreground">
            Runtime controls, diagnostics, and raw voice pipeline output.
          </p>
        </div>
        <Badge variant="outline" className="w-fit">{sessionText}</Badge>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => onActiveTabChange(value as DiagnosticsTab)}
        className="gap-4"
      >

        <TabsList
          variant="line"
          className="flex h-auto w-full flex-wrap justify-start"
        >
          <TabsTrigger value="conversation">Conversation</TabsTrigger>
          <TabsTrigger value="events">Event Log</TabsTrigger>
          <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
          <TabsTrigger value="stt">STT Debug</TabsTrigger>
          <TabsTrigger value="recorder">Recorder Debug</TabsTrigger>
          <TabsTrigger value="audio">Last Audio</TabsTrigger>
        </TabsList>

        <Card>
          <CardContent className="p-4">
            <TabsContent value="conversation" className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-medium">Conversation Preview</h3>
                <p className="text-sm text-muted-foreground">
                  Latest voice turns from the runtime.
                </p>
              </div>
              <ScrollArea className="h-[440px]">
                <div className="space-y-3 pr-4">
                  {controlState.conversation.length === 0 ? (
                    <EmptyState message="No voice turns yet. Start listening, speak naturally, and pause to inspect the latest exchange." />
                  ) : (
                    controlState.conversation
                      .slice()
                      .reverse()
                      .map((turn) => (
                        <Card key={turn.id}>
                          <CardContent className="space-y-4 pt-6">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <Badge variant="outline">{turn.status}</Badge>
                              <span className="text-sm text-muted-foreground">
                                {formatDateTime(turn.timestamp)}
                              </span>
                            </div>
                            <Card size="sm">
                              <CardHeader>
                                <CardTitle className="text-base">User</CardTitle>
                              </CardHeader>
                              <CardContent>
                                <p className="text-sm whitespace-pre-wrap">
                                  {turn.userTranscript ?? '(none)'}
                                </p>
                              </CardContent>
                            </Card>
                            <Card size="sm">
                              <CardHeader>
                                <CardTitle className="text-base">Assistant</CardTitle>
                              </CardHeader>
                              <CardContent>
                                <p className="text-sm whitespace-pre-wrap">
                                  {turn.assistantText ?? '(pending)'}
                                </p>
                              </CardContent>
                            </Card>
                          </CardContent>
                        </Card>
                      ))
                  )}
                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent value="events" className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-medium">Event Log</h3>
                <p className="text-sm text-muted-foreground">
                  Runtime events streamed from the orchestrator.
                </p>
              </div>
              <ScrollArea className="h-[440px]">
                <div className="space-y-3 pr-4">
                  {controlState.logs.length === 0 ? (
                    <EmptyState message="No events yet. The live runtime stream will place orchestration events here as they happen." />
                  ) : (
                    controlState.logs
                      .slice()
                      .reverse()
                      .map((entry) => (
                        <Card key={entry.id}>
                          <CardContent className="space-y-3 pt-6">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <Badge
                                variant={
                                  entry.level === 'error'
                                    ? 'destructive'
                                    : 'outline'
                                }
                              >
                                {entry.type}
                              </Badge>
                              <span className="text-sm text-muted-foreground">
                                {formatDateTime(entry.timestamp)}
                              </span>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {entry.message}
                            </p>
                            <DebugOutput
                              value={formatLogMeta(entry.meta)}
                              heightClassName="h-24"
                            />
                          </CardContent>
                        </Card>
                      ))
                  )}
                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent value="pipeline" className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-medium">Pipeline</h3>
                <p className="text-sm text-muted-foreground">
                  End-to-end timing from stop listening to playback completion.
                </p>
              </div>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Voice Turn Timeline</CardTitle>
                </CardHeader>
                <CardContent>
                  <VoiceTurnTimeline pipeline={controlState.pipeline} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Flow</CardTitle>
                </CardHeader>
                <CardContent>
                  <PipelineFlow pipeline={controlState.pipeline} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Latency Metrics</CardTitle>
                </CardHeader>
                <CardContent>
                  <LatencyGrid pipeline={controlState.pipeline} />
                </CardContent>
              </Card>
              <PipelineVerdict pipeline={controlState.pipeline} />
              <DebugSection
                title="Pipeline Debug"
                value={pipelineDebugText}
                heightClassName="h-[340px]"
              />
            </TabsContent>

            <TabsContent value="stt" className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-medium">STT Debug</h3>
                <p className="text-sm text-muted-foreground">
                  Transcript length, failure reason, and raw body preview.
                </p>
              </div>
              <DebugSection
                title="Latest STT Run"
                value={sttDebugText}
                heightClassName="h-[480px]"
              />
            </TabsContent>

            <TabsContent value="recorder" className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-medium">Recorder Debug</h3>
                <p className="text-sm text-muted-foreground">
                  Backend selection, spawn state, and recorder diagnostics.
                </p>
              </div>
              <DebugSection
                title="Latest Recorder Run"
                value={recorderDebugText}
                heightClassName="h-[480px]"
              />
            </TabsContent>

            <TabsContent value="audio" className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-medium">Last Audio</h3>
                <p className="text-sm text-muted-foreground">
                  Metadata and quality hints for the latest saved recording.
                </p>
              </div>
              <DebugSection
                title="Latest Recording"
                value={lastAudioText}
                heightClassName="h-[480px]"
              />
            </TabsContent>
          </CardContent>
        </Card>
      </Tabs>
    </div>
  )
}

function PipelineVerdict({ pipeline }: { pipeline: PipelineDebugInfo | null }) {
  if (pipeline === null) {
    return <EmptyState message="No pipeline verdict yet." />
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pipeline Verdict</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <VerdictItem label="STT partials" value={pipeline.verdict.sttPartials} />
          <VerdictItem label="Transcript final" value={pipeline.verdict.transcriptFinal} />
          <VerdictItem label="LLM streaming" value={pipeline.verdict.llmStreaming} />
          <VerdictItem label="TTS streaming" value={pipeline.verdict.ttsStreamingPath} />
          <VerdictItem label="Playback started" value={pipeline.verdict.playbackStarted} />
          <VerdictTextItem label="Playback mode" value={pipeline.verdict.playbackMode} />
          <VerdictTextItem label="Player command" value={pipeline.playerCommand ?? 'unknown'} />
          <VerdictItem label="Full turn success" value={pipeline.verdict.fullTurnSuccess} />
        </div>
      </CardContent>
    </Card>
  )
}

function VerdictItem({ label, value }: { label: string; value: boolean }) {
  return (
    <div className="rounded-lg bg-background/60 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value ? 'yes' : 'no'}</p>
    </div>
  )
}

function VerdictTextItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-background/60 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium break-all">{value}</p>
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <Alert>
      <AlertTriangle />
      <AlertTitle>No data yet</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

function DebugSection({
  title,
  value,
  heightClassName,
}: {
  title: string
  value: string
  heightClassName: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <DebugOutput value={value} heightClassName={heightClassName} />
      </CardContent>
    </Card>
  )
}

function DebugOutput({
  value,
  heightClassName,
}: {
  value: string
  heightClassName: string
}) {
  return (
    <ScrollArea className={cn('rounded-md border', heightClassName)}>
      <pre className="p-4 text-sm whitespace-pre-wrap">{value}</pre>
    </ScrollArea>
  )
}

function PipelineFlow({ pipeline }: { pipeline: PipelineDebugInfo | null }) {
  if (pipeline === null) {
    return (
      <EmptyState message="No pipeline timeline yet. Run a manual voice turn to populate the flow." />
    )
  }

  const hasError = [
    pipeline.recording,
    pipeline.stt,
    pipeline.gateway,
    pipeline.tts,
    pipeline.playback,
  ].some((stage) => stage.status === 'failed')
  const activeStep = resolveActiveFlowStepKey(pipeline)

  return (
    <div className="grid gap-4 md:grid-cols-7">
      {FLOW_STEPS.map((step, index) => {
        const hasTimestamp = pipeline.latency.timestamps[step.key] !== null
        const isRunning = activeStep === step.key && !hasTimestamp && !hasError
        const isError = !hasTimestamp && hasError

        return (
          <div key={step.key} className="space-y-3">
            <div className="flex items-center gap-3">
              {index > 0 ? <Separator className="flex-1" /> : <div className="flex-1" />}
              <div
                className={cn(
                  'size-3 rounded-full border bg-background',
                  hasTimestamp && 'bg-primary border-primary',
                  isRunning && 'ring-4 ring-ring/30',
                  isError && 'border-destructive bg-destructive',
                )}
              />
              {index < FLOW_STEPS.length - 1 ? (
                <Separator className="flex-1" />
              ) : (
                <div className="flex-1" />
              )}
            </div>
            <div className="flex min-h-14 flex-col items-center justify-start space-y-1 text-center">
              <p className="text-sm font-medium">{step.label}</p>
              <p className="text-sm text-muted-foreground">
                {formatOffsetFromStop(
                  pipeline.latency.timestamps.stopListeningAt,
                  pipeline.latency.timestamps[step.key],
                )}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LatencyGrid({ pipeline }: { pipeline: PipelineDebugInfo | null }) {
  if (pipeline === null) {
    return (
      <EmptyState message="No latency metrics yet. They appear after a full voice turn starts moving through the pipeline." />
    )
  }

  const metrics = [
    ['STT Finalize', pipeline.latency.durations.sttLatencyMs],
    ['Gateway to 1st Token', pipeline.latency.durations.gatewayToFirstTokenMs],
    [
      'Gateway to 1st Sentence',
      pipeline.latency.durations.gatewayToFirstSentenceMs,
    ],
    ['TTS to 1st Audio', pipeline.latency.durations.ttsToFirstAudioMs],
    ['TTS Full', pipeline.latency.durations.ttsFullSynthesisMs],
    ['Stop to 1st Sound', pipeline.latency.durations.stopToFirstSoundMs],
    [
      'Stop to Playback Done',
      pipeline.latency.durations.stopToPlaybackFinishedMs,
    ],
  ] as const

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map(([label, value]) => (
        <Card key={label}>
          <CardHeader>
            <CardTitle className="text-base">{label}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{formatDuration(value)}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function VoiceTurnTimeline({ pipeline }: { pipeline: PipelineDebugInfo | null }) {
  if (pipeline === null) {
    return (
      <EmptyState message="No voice turn timeline yet. Start a live voice turn to watch the runtime progress through listening, STT, LLM, TTS, playback, and idle." />
    )
  }

  const timeline = pipeline.turnTimeline
  const stageCount = timeline.stages.length

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <TimelineMetricCard label="Current State" value={formatState(timeline.currentState)} />
        <TimelineMetricCard
          label="Active Stage"
          value={timeline.activeStageLabel ?? 'Waiting'}
        />
        <TimelineMetricCard
          label="Total Turn"
          value={formatDuration(timeline.durations.totalTurnDurationMs)}
        />
        <TimelineMetricCard
          label="Barge-In"
          value={timeline.timestamps.bargeInDetectedAt ? 'Detected' : 'None'}
        />
      </div>

      <ScrollArea className="w-full rounded-xl border bg-background/50">
        <div className="flex min-w-max items-stretch gap-0 p-4">
          {timeline.stages.map((stage, index) => (
            <div key={stage.key} className="flex items-stretch">
              <TimelineStageCard
                stage={stage}
                isActive={timeline.activeStage === stage.key}
              />
              {index < stageCount - 1 ? (
                <div className="flex h-[168px] items-center px-2">
                  <div className="h-px w-8 bg-border" />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </ScrollArea>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <TimelineMetricCard
          label="Listening"
          value={formatDuration(timeline.durations.listeningDurationMs)}
        />
        <TimelineMetricCard
          label="Silence to STT"
          value={formatDuration(timeline.durations.silenceToSttMs)}
        />
        <TimelineMetricCard
          label="STT"
          value={formatDuration(timeline.durations.sttDurationMs)}
        />
        <TimelineMetricCard
          label="LLM"
          value={formatDuration(timeline.durations.llmDurationMs)}
        />
        <TimelineMetricCard
          label="TTS"
          value={formatDuration(timeline.durations.ttsDurationMs)}
        />
        <TimelineMetricCard
          label="Playback"
          value={formatDuration(timeline.durations.playbackDurationMs)}
        />
        <TimelineMetricCard
          label="Listening Started"
          value={formatTimelineTime(timeline.timestamps.listeningStartedAt)}
        />
        <TimelineMetricCard
          label="Last Completed"
          value={formatTimelineStageKey(timeline.lastCompletedStage)}
        />
      </div>
    </div>
  )
}

function TimelineMetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-background/60 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  )
}

function TimelineStageCard({
  stage,
  isActive,
}: {
  stage: TurnTimelineStage
  isActive: boolean
}) {
  return (
    <div
      className={cn(
        'flex h-[168px] w-[190px] shrink-0 flex-col justify-between rounded-xl border bg-background/80 p-3 text-left transition-colors',
        stage.status === 'pending' && 'border-border/70 opacity-65',
        stage.status === 'completed' && 'border-border bg-muted/20',
        stage.status === 'active' && 'border-foreground/50 bg-background shadow-sm ring-2 ring-ring/20',
        stage.status === 'interrupted' && 'border-amber-500/50 bg-amber-500/5',
        stage.status === 'failed' && 'border-destructive/50 bg-destructive/5',
        isActive && 'ring-2 ring-ring/25',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-h-10 space-y-1">
          <p className="text-sm font-medium leading-snug">{stage.label}</p>
          <p className="text-xs text-muted-foreground">
            {formatTimelineTime(stage.startAt)}
          </p>
        </div>
        <Badge className={timelineBadgeClassName(stage.status)} variant={timelineBadgeVariant(stage.status)}>
          {formatTimelineStatus(stage.status)}
        </Badge>
      </div>

      <div className="mt-4 space-y-2">
        <p className="text-2xl font-semibold">{formatTimelineDuration(stage)}</p>
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>Start: {formatTimelineTime(stage.startAt)}</p>
          <p>End: {formatTimelineTime(stage.endAt)}</p>
        </div>
      </div>
    </div>
  )
}

function timelineBadgeVariant(
  status: TurnTimelineStage['status'],
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'failed') {
    return 'destructive'
  }

  if (status === 'active') {
    return 'secondary'
  }

  return 'outline'
}

function timelineBadgeClassName(status: TurnTimelineStage['status']): string {
  if (status === 'interrupted') {
    return 'border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-300'
  }

  if (status === 'pending') {
    return 'text-muted-foreground'
  }

  return ''
}

function formatTimelineStatus(status: TurnTimelineStage['status']): string {
  switch (status) {
    case 'active':
      return 'Active'
    case 'completed':
      return 'Completed'
    case 'interrupted':
      return 'Interrupted'
    case 'failed':
      return 'Failed'
    case 'pending':
    default:
      return 'Pending'
  }
}

function formatTimelineTime(value: string | null): string {
  if (value === null) {
    return 'Pending'
  }

  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatTimelineDuration(stage: TurnTimelineStage): string {
  if (stage.durationMs === null) {
    return stage.startAt === null && stage.endAt === null ? 'Pending' : 'Event'
  }

  return formatDuration(stage.durationMs)
}

function formatTimelineStageKey(
  value: TurnTimelineDebugInfo['lastCompletedStage'],
): string {
  if (value === null) {
    return 'None'
  }

  return value
    .split('_')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

function resolveActiveFlowStepKey(
  pipeline: PipelineDebugInfo,
): (typeof FLOW_STEPS)[number]['key'] | null {
  if (pipeline.playback.status === 'running') {
    return 'playbackFinishedAt'
  }

  if (pipeline.tts.status === 'running') {
    return pipeline.latency.timestamps.ttsFirstAudioReadyAt === null
      ? 'ttsFirstAudioReadyAt'
      : 'playbackStartedAt'
  }

  if (pipeline.gateway.status === 'running') {
    if (pipeline.latency.timestamps.firstTokenAt === null) {
      return 'firstTokenAt'
    }

    return 'firstSentenceReadyAt'
  }

  if (pipeline.stt.status === 'running') {
    return 'sttFinishedAt'
  }

  return null
}

async function loadDebugState(): Promise<{
  lastAudio: LastAudioDebugInfo
  pipeline: PipelineDebugInfo
  recorder: RecorderDebugInfo
}> {
  const [lastAudio, pipeline, recorder] = await Promise.all([
    requestJson<LastAudioDebugInfo>('/api/runtime/debug/last-audio'),
    requestJson<PipelineDebugInfo>('/api/runtime/debug/pipeline'),
    requestJson<RecorderDebugInfo>('/api/runtime/debug/recorder'),
  ])

  return {
    lastAudio,
    pipeline,
    recorder,
  }
}

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(path)

  if (!response.ok) {
    throw await toRequestError(response)
  }

  return (await response.json()) as T
}

async function toRequestError(response: Response): Promise<Error> {
  try {
    const payload = (await response.json()) as { error?: string }
    return new Error(payload.error ?? `Request failed: ${response.status}`)
  } catch {
    return new Error(`Request failed: ${response.status}`)
  }
}

function upsertById<T extends { id: number }>(
  items: T[],
  value: T,
  limit: number,
): T[] {
  const next = items.slice()
  const index = next.findIndex((entry) => entry.id === value.id)

  if (index >= 0) {
    next[index] = value
  } else {
    next.push(value)
  }

  if (next.length > limit) {
    next.splice(0, next.length - limit)
  }

  return next
}

export default App
