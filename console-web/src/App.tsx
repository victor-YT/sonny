import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  AudioLines,
  CircleDot,
  LoaderCircle,
  Mic,
  Square,
} from 'lucide-react'

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import {
  buildLastAudioDebug,
  buildPipelineDebug,
  buildRecorderDebug,
  buildSttDebug,
  compareServicePriority,
  describeNotice,
  formatDateTime,
  formatDuration,
  formatLogMeta,
  formatOffsetFromStop,
  formatState,
  normalizeStateClass,
  shouldDimService,
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
  const [controlState, setControlState] = useState<ControlState>({
    snapshot: null,
    logs: [],
    conversation: [],
    voiceSettings: null,
    lastAudio: null,
    pipeline: null,
    recorder: null,
  })
  const [activeTab, setActiveTab] = useState<DiagnosticsTab>('conversation')
  const [connection, setConnection] = useState<ConnectionState>('connected')
  const [notice, setNotice] = useState<NoticeState>({
    level: 'info',
    message: 'Runtime stream connected. Waiting for the latest snapshot.',
  })
  const [developerToolsOpen, setDeveloperToolsOpen] = useState(false)

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

  const runtimeClass = useMemo(() => {
    return controlState.snapshot ? normalizeStateClass(controlState.snapshot) : 'idle'
  }, [controlState.snapshot])

  const services = useMemo(() => {
    if (controlState.snapshot === null) {
      return []
    }

    return Object.values(controlState.snapshot.services).sort((left, right) => {
      return compareServicePriority(left) - compareServicePriority(right)
    })
  }, [controlState.snapshot])

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

  const transcriptNote = controlState.pipeline?.verdict.sttPartials
    ? 'Streaming partials detected'
    : controlState.snapshot?.lastTranscript
      ? 'Final transcript only'
      : 'Waiting for transcript'

  const responseNote = controlState.pipeline?.verdict.llmStreaming
    ? 'Streaming response detected'
    : controlState.snapshot?.lastResponseText
      ? 'Final response only'
      : 'Waiting for response'
  const micActive = controlState.snapshot?.micActive === true
  const browserMic = useBrowserMicLevel(micActive)

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="border-b">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-6 py-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="text-base font-medium">Sonny</div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={connectionBadgeClassName(connection)}
              >
                <Activity />
                {connection === 'connected' ? 'Connected' : 'Disconnected'}
              </Badge>
              <Badge
                variant={runtimeBadgeVariant(runtimeClass)}
                className={runtimeBadgeClassName(runtimeClass)}
              >
                <CircleDot />
                {formatState(controlState.snapshot?.currentState ?? 'idle')}
              </Badge>
              <Badge variant="outline">{sessionText}</Badge>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {notice.level === 'error' ? (
              <AlertTriangle className="size-4 shrink-0" />
            ) : (
              <LoaderCircle className="size-4 shrink-0" />
            )}
            <span>{notice.message}</span>
          </div>
        </div>
      </div>

      <main className="mx-auto flex max-w-7xl flex-col gap-16 px-6 py-10">
        <section className="grid gap-12 xl:grid-cols-[minmax(0,2.2fr)_320px] xl:items-stretch">
          <div className="flex min-h-[72vh]">
            <Card className="mx-auto flex min-h-full w-full max-w-4xl bg-transparent shadow-none">
              <CardContent className="flex min-h-full flex-col items-center justify-center gap-10 p-8 text-center sm:p-10">
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Manual voice interaction
                  </p>
                  <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
                    Talk to Sonny
                  </h1>
                  <p className="mx-auto max-w-2xl text-base text-muted-foreground">
                    Start listening, speak naturally, and pause. Sonny will stop the
                    turn automatically, transcribe live, and answer back.
                  </p>
                </div>

                <div className="flex w-full flex-col items-center justify-center gap-4 sm:flex-row">
                  <Button
                    size="lg"
                    className="h-14 min-w-72 px-8 text-base"
                    variant={micActive ? 'outline' : 'default'}
                    onClick={() =>
                      void handlePost(
                        micActive
                          ? '/api/voice/listen/stop'
                          : '/api/voice/listen/start',
                      )
                    }
                  >
                    {micActive ? (
                      <>
                        <Square />
                        Stop Listening
                      </>
                    ) : (
                      <>
                        <Mic />
                        Start Listening
                      </>
                    )}
                  </Button>
                  <MicLevelMeter
                    active={micActive}
                    backendLevel={controlState.snapshot?.micLevel ?? null}
                    browserLevel={browserMic.level}
                    browserStatus={browserMic.status}
                  />
                </div>

                <div className="grid w-full gap-6 md:grid-cols-2">
                  <ConversationPreviewCard
                    title="You"
                    note={transcriptNote}
                    value={
                      controlState.snapshot?.userPartialTranscript ??
                      controlState.snapshot?.lastTranscript ??
                      'No transcript yet. Start listening and speak a short phrase.'
                    }
                  />
                  <ConversationPreviewCard
                    title="Sonny"
                    note={responseNote}
                    value={
                      controlState.snapshot?.assistantPartialResponse ??
                      controlState.snapshot?.lastResponseText ??
                      'No response yet. Once the pipeline completes, the latest reply appears here.'
                    }
                  />
                </div>
              </CardContent>
            </Card>
          </div>

          <aside className="h-full">
            <Card className="h-full">
              <CardHeader className="p-5 pb-1">
                <CardTitle>Runtime</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 p-5 pt-0">
                <div className="grid gap-1.5">
                  <StatusRow
                    label="Mic"
                    value={micActive ? 'Active' : 'Idle'}
                  />
                  <StatusRow
                    label="Playback"
                    value={
                      controlState.snapshot?.playbackActive ? 'Playing' : 'Idle'
                    }
                  />
                  <StatusRow
                    label="Connection"
                    value={connection === 'connected' ? 'Live' : 'Offline'}
                  />
                </div>

                <Separator />

                <div className="space-y-2">
                  <p className="text-sm font-medium">Voice Stack</p>
                  <div className="space-y-1">
                    {services.length === 0 ? (
                      <EmptyState message="No service health snapshot yet. Refresh health or wait for the runtime to publish one." />
                    ) : (
                      services.map((service) => (
                        <ServiceHealthRow key={service.name} service={service} />
                      ))
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </aside>
        </section>

        <section className="space-y-4">
          <Card className="bg-muted/20">
            <CardHeader className="flex flex-row items-center justify-between p-4">
              <div className="space-y-1">
                <CardTitle className="text-base">Developer Tools</CardTitle>
                <CardDescription>
                  Debug controls, traces, and raw pipeline output.
                </CardDescription>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDeveloperToolsOpen((previous) => !previous)}
              >
                {developerToolsOpen ? 'Hide' : 'Show'}
              </Button>
            </CardHeader>
          </Card>

          {developerToolsOpen ? (
            <div className="space-y-4">
              <Tabs
                value={activeTab}
                onValueChange={(value) => setActiveTab(value as DiagnosticsTab)}
                className="gap-4"
              >
                <div className="space-y-1">
                  <h2 className="text-base font-medium">Diagnostics</h2>
                  <p className="text-sm text-muted-foreground">
                    Conversation history, event logs, and low-level pipeline output.
                  </p>
                </div>

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

                <Card className="bg-muted/20">
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
                                        <CardTitle className="text-base">
                                          Assistant
                                        </CardTitle>
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
          ) : null}
        </section>
      </main>
    </div>
  )
}

function ConversationPreviewCard({
  title,
  note,
  value,
}: {
  title: string
  note: string
  value: string
}) {
  return (
    <div className="rounded-xl bg-muted/40 p-6 text-left">
      <div className="mb-4 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
      <p className="text-sm whitespace-pre-wrap text-muted-foreground">{value}</p>
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

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  )
}

function MicLevelMeter({
  active,
  backendLevel,
  browserLevel,
  browserStatus,
}: {
  active: boolean
  backendLevel: number | null
  browserLevel: number | null
  browserStatus: BrowserMicLevelStatus
}) {
  const levels = [backendLevel, browserLevel].filter(
    (value): value is number => value !== null,
  )
  const normalizedLevel = Math.max(0, Math.min(1, Math.max(0, ...levels)))
  const displayLevel = Math.max(0.03, Math.min(1, normalizedLevel / 0.12))
  const sources = [
    backendLevel !== null ? 'backend' : null,
    browserLevel !== null ? 'browser' : null,
  ].filter((value): value is string => value !== null)
  const levelText = formatMicLevelText(
    active,
    normalizedLevel,
    sources,
    browserStatus,
  )

  return (
    <div
      className={cn(
        'flex h-14 w-full max-w-72 items-center gap-3 rounded-lg border px-4',
        active ? 'border-primary/35 bg-background' : 'border-muted bg-muted/30 opacity-60',
      )}
      aria-label="Microphone level"
    >
      <AudioLines className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-1 text-left">
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              'h-full rounded-full transition-[width,background-color] duration-100',
              active ? 'bg-emerald-500' : 'bg-muted-foreground/40',
            )}
            style={{ width: active ? `${displayLevel * 100}%` : '3%' }}
          />
        </div>
        <p className="text-xs text-muted-foreground">{levelText}</p>
      </div>
    </div>
  )
}

type BrowserMicLevelStatus =
  | 'idle'
  | 'requesting'
  | 'active'
  | 'unavailable'
  | 'blocked'

function useBrowserMicLevel(active: boolean): {
  level: number | null
  status: BrowserMicLevelStatus
} {
  const [state, setState] = useState<{
    level: number | null
    status: BrowserMicLevelStatus
  }>({
    level: null,
    status: 'idle',
  })

  useEffect(() => {
    if (!active) {
      setState({ level: null, status: 'idle' })
      return
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setState({ level: null, status: 'unavailable' })
      return
    }

    let cancelled = false
    let animationFrame: number | null = null
    let stream: MediaStream | null = null
    let audioContext: AudioContext | null = null
    let lastPublishedAt = 0

    async function startBrowserMeter() {
      setState({ level: null, status: 'requesting' })

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        })

        if (cancelled) {
          stopMediaStream(stream)
          return
        }

        audioContext = new AudioContext()
        const source = audioContext.createMediaStreamSource(stream)
        const analyser = audioContext.createAnalyser()

        analyser.fftSize = 1024
        const samples = new Float32Array(analyser.fftSize)
        source.connect(analyser)

        const tick = (timestamp: number) => {
          if (cancelled) {
            return
          }

          if (timestamp - lastPublishedAt >= 100) {
            analyser.getFloatTimeDomainData(samples)
            setState({
              level: calculateBrowserRms(samples),
              status: 'active',
            })
            lastPublishedAt = timestamp
          }

          animationFrame = window.requestAnimationFrame(tick)
        }

        animationFrame = window.requestAnimationFrame(tick)
      } catch {
        if (!cancelled) {
          setState({ level: null, status: 'blocked' })
        }
      }
    }

    void startBrowserMeter()

    return () => {
      cancelled = true

      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame)
      }

      if (stream !== null) {
        stopMediaStream(stream)
      }

      void audioContext?.close()
    }
  }, [active])

  return state
}

function stopMediaStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop()
  }
}

function calculateBrowserRms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0
  }

  let sumSquares = 0

  for (const sample of samples) {
    sumSquares += sample * sample
  }

  return Number(Math.sqrt(sumSquares / samples.length).toFixed(4))
}

function formatMicLevelText(
  active: boolean,
  level: number,
  sources: string[],
  browserStatus: BrowserMicLevelStatus,
): string {
  if (!active) {
    return 'RMS --'
  }

  if (sources.length > 0) {
    return `RMS ${level.toFixed(4)} · ${sources.join('+')}`
  }

  if (browserStatus === 'requesting') {
    return 'Requesting mic'
  }

  if (browserStatus === 'blocked') {
    return 'Browser mic blocked'
  }

  if (browserStatus === 'unavailable') {
    return 'Browser mic unavailable'
  }

  return 'RMS --'
}

function ServiceHealthRow({
  service,
}: {
  service: RuntimeSnapshot['services'][string]
}) {
  return (
    <div
      className={cn(
        'py-1.5',
        shouldDimService(service) && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'size-2.5 shrink-0 rounded-full',
            service.online ? 'bg-emerald-500' : 'bg-muted-foreground/40',
          )}
        />
        <div className="min-w-0">
          <p className="text-sm font-medium break-all">
            {formatServiceHealthLabel(service)}
          </p>
        </div>
      </div>
    </div>
  )
}

function formatServiceHealthLabel(
  service: RuntimeSnapshot['services'][string],
): string {
  switch (service.name) {
    case 'ollama':
      return `LLM: ${service.label}`
    case 'stt':
      return `STT: ${service.label}`
    case 'tts':
      return `TTS: ${service.label}`
    case 'wake_word':
      return 'Wakeword: coming soon'
    case 'vad':
      return 'VAD'
    default:
      return service.label
  }
}

function connectionBadgeClassName(connection: ConnectionState): string {
  if (connection === 'connected') {
    return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/15 dark:text-emerald-300'
  }

  return 'border-destructive/25 bg-destructive/10 text-destructive dark:border-destructive/35 dark:bg-destructive/20'
}

function runtimeBadgeClassName(runtimeClass: string): string {
  if (runtimeClass === 'error') {
    return 'border-destructive/25 bg-destructive/10 text-destructive dark:border-destructive/35 dark:bg-destructive/20'
  }

  return ''
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

function runtimeBadgeVariant(
  runtimeClass: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (runtimeClass === 'error') {
    return 'destructive'
  }

  if (runtimeClass === 'idle') {
    return 'outline'
  }

  return 'secondary'
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
