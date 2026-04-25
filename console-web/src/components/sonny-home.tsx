import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'

export type SonnyVoiceState = 'idle' | 'listening' | 'processing' | 'responding'

const WAVEFORM_BARS = 52

export interface SonnyHomeProps {
  state: SonnyVoiceState
  connected: boolean
  youText: string
  sonnyText: string
  totalLatencyMs: number | null
  busy?: boolean
  errorMessage?: string | null
  onStartListening: () => void
  onInterrupt: () => void
  onNewSession: () => void
}

const tokens = {
  bg: '#0c0c0e',
  surface: 'rgba(255,255,255,0.04)',
  borderSubtle: 'rgba(255,255,255,0.06)',
  borderActive: {
    you: 'rgba(255,255,255,0.12)',
    sonny: 'rgba(255,255,255,0.14)',
  },
  textPrimary: 'rgba(255,255,255,0.82)',
  textSecondary: 'rgba(255,255,255,0.65)',
  textMuted: 'rgba(255,255,255,0.45)',
  textDim: 'rgba(255,255,255,0.2)',
  textActive: 'rgba(255,255,255,0.7)',
  textIdle: 'rgba(255,255,255,0.3)',
  green: '#4ade80',
  greenBg: 'rgba(74,222,128,0.1)',
  greenBorder: 'rgba(74,222,128,0.2)',
  red: '#f87171',
  redBg: 'rgba(248,113,113,0.1)',
  redBorder: 'rgba(248,113,113,0.22)',
} as const

// ── Live mic amplitudes ─────────────────────────────────
type MicPermission = 'idle' | 'requesting' | 'active' | 'blocked' | 'unavailable'

function useMicAmplitudes(enabled: boolean): {
  amplitudes: RefObject<Float32Array>
  hasLive: RefObject<boolean>
  permission: MicPermission
} {
  const amplitudes = useRef<Float32Array>(new Float32Array(WAVEFORM_BARS))
  const hasLive = useRef<boolean>(false)
  const [permission, setPermission] = useState<MicPermission>('idle')

  useEffect(() => {
    if (!enabled) {
      hasLive.current = false
      amplitudes.current.fill(0)
      setPermission('idle')
      return
    }

    if (
      typeof navigator === 'undefined' ||
      typeof navigator.mediaDevices === 'undefined' ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      setPermission('unavailable')
      return
    }

    let cancelled = false
    let stream: MediaStream | null = null
    let audioContext: AudioContext | null = null
    let frame: number | null = null

    setPermission('requesting')

    navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
      .then((mediaStream) => {
        if (cancelled) {
          for (const track of mediaStream.getTracks()) {
            track.stop()
          }
          return
        }

        stream = mediaStream
        const ctx = new (window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext)()
        audioContext = ctx
        const source = ctx.createMediaStreamSource(mediaStream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.7
        source.connect(analyser)

        const buf = new Uint8Array(analyser.frequencyBinCount)
        const startBin = 2
        const endBin = Math.max(startBin + WAVEFORM_BARS, analyser.frequencyBinCount - 8)
        const usableBins = endBin - startBin
        const perBar = usableBins / WAVEFORM_BARS

        setPermission('active')
        hasLive.current = true

        const tick = (): void => {
          if (cancelled) {
            return
          }

          analyser.getByteFrequencyData(buf)

          for (let i = 0; i < WAVEFORM_BARS; i++) {
            const lo = startBin + Math.floor(i * perBar)
            const hi = startBin + Math.floor((i + 1) * perBar)
            let sum = 0
            const span = Math.max(1, hi - lo)
            for (let j = lo; j < hi; j++) {
              sum += buf[j] ?? 0
            }
            const avg = sum / span / 255
            const target = Math.pow(avg, 0.7)
            const prev = amplitudes.current[i] ?? 0
            const blend = target > prev ? 0.8 : 0.15
            amplitudes.current[i] = prev + (target - prev) * blend
          }

          frame = window.requestAnimationFrame(tick)
        }

        frame = window.requestAnimationFrame(tick)
      })
      .catch(() => {
        if (!cancelled) {
          setPermission('blocked')
          hasLive.current = false
        }
      })

    return () => {
      cancelled = true
      hasLive.current = false
      amplitudes.current.fill(0)

      if (frame !== null) {
        window.cancelAnimationFrame(frame)
      }

      if (stream !== null) {
        for (const track of stream.getTracks()) {
          track.stop()
        }
      }

      if (audioContext !== null && audioContext.state !== 'closed') {
        void audioContext.close()
      }
    }
  }, [enabled])

  return { amplitudes, hasLive, permission }
}

// ── Waveform ─────────────────────────────────────────────
function Waveform({
  state,
  liveAmplitudes,
  hasLive,
}: {
  state: SonnyVoiceState
  liveAmplitudes?: RefObject<Float32Array>
  hasLive?: RefObject<boolean>
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const stateRef = useRef<SonnyVoiceState>(state)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) {
      return
    }

    const ctx = canvas.getContext('2d')
    if (ctx === null) {
      return
    }

    const dpr = window.devicePixelRatio || 1
    const cssW = 480
    const cssH = 64

    canvas.width = Math.floor(cssW * dpr)
    canvas.height = Math.floor(cssH * dpr)
    ctx.scale(dpr, dpr)

    const W = cssW
    const H = cssH

    const draw = (ts: number) => {
      const t = ts * 0.001
      ctx.clearRect(0, 0, W, H)

      const bars = WAVEFORM_BARS
      const barW = 2.5
      const totalW = bars * barW + (bars - 1) * 5
      const startX = (W - totalW) / 2
      const current = stateRef.current
      const useLive =
        current === 'listening' &&
        hasLive?.current === true &&
        liveAmplitudes?.current !== undefined

      for (let i = 0; i < bars; i++) {
        const x = startX + i * (barW + 5)
        let amp = 0

        if (current === 'listening') {
          if (useLive && liveAmplitudes !== undefined) {
            const live = liveAmplitudes.current[i] ?? 0
            amp = Math.max(0.06, live)
          } else {
            amp =
              Math.sin(t * 5.1 + i * 0.42) * 0.38 +
              Math.sin(t * 8.3 + i * 0.28) * 0.22 +
              Math.sin(t * 3.1 + i * 0.65) * 0.18 +
              Math.random() * 0.22
            amp = Math.max(0.06, Math.abs(amp))
          }
        } else if (current === 'responding') {
          amp =
            Math.sin(t * 2.8 + i * 0.5) * 0.22 +
            Math.sin(t * 4.2 + i * 0.32) * 0.14 +
            0.12
          amp = Math.max(0.06, amp)
        } else {
          amp = 0.05 + Math.sin(t * 0.6 + i * 0.35) * 0.025
        }

        const h = amp * H * 0.88
        const y = (H - h) / 2

        let r = 255
        let g = 255
        let b = 255
        let a = 0.18

        if (current === 'listening') {
          a = 0.75
        } else if (current === 'responding') {
          r = 180
          g = 200
          b = 255
          a = 0.55
        }

        ctx.fillStyle = `rgba(${r},${g},${b},${a})`
        ctx.beginPath()
        const radius = 1.5
        const x2 = x + barW
        const y2 = y + h
        ctx.moveTo(x + radius, y)
        ctx.lineTo(x2 - radius, y)
        ctx.quadraticCurveTo(x2, y, x2, y + radius)
        ctx.lineTo(x2, y2 - radius)
        ctx.quadraticCurveTo(x2, y2, x2 - radius, y2)
        ctx.lineTo(x + radius, y2)
        ctx.quadraticCurveTo(x, y2, x, y2 - radius)
        ctx.lineTo(x, y + radius)
        ctx.quadraticCurveTo(x, y, x + radius, y)
        ctx.fill()
      }

      frameRef.current = window.requestAnimationFrame(draw)
    }

    frameRef.current = window.requestAnimationFrame(draw)

    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
      }
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: 480, height: 64, maxWidth: '100%' }}
      aria-hidden
    />
  )
}

// ── Pipeline Bar ─────────────────────────────────────────
function PipelineBar({
  state,
  showAllDone,
}: {
  state: SonnyVoiceState
  showAllDone: boolean
}) {
  const activeStep =
    state === 'listening'
      ? 0
      : state === 'processing'
        ? 2
        : state === 'responding'
          ? 3
          : -1
  const steps = ['VAD', 'STT', 'LLM', 'TTS'] as const

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexWrap: 'wrap',
        rowGap: 6,
        transition: 'opacity 0.4s',
      }}
    >
      {steps.map((step, i) => {
        const isActive = i === activeStep
        const isDone = showAllDone || (state !== 'idle' && i < activeStep)
        const color = isActive
          ? 'rgba(255,255,255,0.85)'
          : isDone
            ? 'rgba(255,255,255,0.55)'
            : 'rgba(255,255,255,0.2)'
        const arrowColor =
          isDone || i < activeStep
            ? 'rgba(255,255,255,0.45)'
            : 'rgba(255,255,255,0.12)'

        return (
          <span
            key={step}
            style={{ display: 'inline-flex', alignItems: 'center' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  display: 'inline-block',
                  background: color,
                  boxShadow: isActive ? '0 0 6px rgba(255,255,255,0.5)' : 'none',
                  animation: isActive
                    ? 'sonny-subtle-pulse 1s ease-in-out infinite'
                    : 'none',
                  transition: 'background 0.3s, box-shadow 0.3s',
                }}
              />
              <span
                style={{
                  fontSize: 11,
                  letterSpacing: '0.04em',
                  color,
                  transition: 'color 0.3s',
                  fontWeight: isActive ? 500 : 400,
                }}
              >
                {step}
              </span>
            </span>
            {i < 3 ? (
              <span
                style={{
                  color: arrowColor,
                  margin: '0 8px',
                  fontSize: 11,
                  transition: 'color 0.3s',
                }}
              >
                →
              </span>
            ) : null}
          </span>
        )
      })}
    </div>
  )
}

// ── Nav tab ─────────────────────────────────────────────
function NavTab({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string
  active: boolean
  disabled?: boolean
  onClick?: () => void
}) {
  const [hover, setHover] = useState(false)
  const color = active
    ? 'rgba(255,255,255,0.9)'
    : disabled
      ? 'rgba(255,255,255,0.2)'
      : hover
        ? 'rgba(255,255,255,0.6)'
        : 'rgba(255,255,255,0.35)'

  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={disabled}
      style={{
        padding: '5px 14px',
        borderRadius: 7,
        border: 'none',
        background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
        color,
        fontSize: 13,
        fontFamily: 'inherit',
        fontWeight: active ? 500 : 400,
        cursor: disabled ? 'default' : 'pointer',
        transition: 'all 0.15s',
        letterSpacing: '-0.01em',
      }}
    >
      {label}
    </button>
  )
}

// ── Control button ─────────────────────────────────────
function CtrlBtn({
  label,
  icon,
  primary,
  disabled,
  onClick,
}: {
  label: string
  icon?: ReactNode
  primary?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  const [hov, setHov] = useState(false)
  const baseStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    padding: primary ? '9px 22px' : '9px 16px',
    borderRadius: 10,
    border: primary ? 'none' : '1px solid rgba(255,255,255,0.1)',
    background: primary
      ? disabled
        ? 'rgba(255,255,255,0.08)'
        : hov
          ? 'rgba(255,255,255,0.97)'
          : 'rgba(255,255,255,0.92)'
      : hov && !disabled
        ? 'rgba(255,255,255,0.06)'
        : 'rgba(255,255,255,0.03)',
    color: primary
      ? disabled
        ? 'rgba(255,255,255,0.2)'
        : '#000'
      : disabled
        ? 'rgba(255,255,255,0.15)'
        : 'rgba(255,255,255,0.55)',
    fontSize: 13,
    fontWeight: primary ? 500 : 400,
    fontFamily: 'inherit',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'all 0.15s',
    letterSpacing: '-0.01em',
  }

  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      disabled={disabled}
      style={baseStyle}
    >
      {icon !== undefined && icon !== null ? (
        <span
          style={{
            display: 'inline-flex',
            opacity: primary && !disabled ? 1 : 0.7,
          }}
        >
          {icon}
        </span>
      ) : null}
      {label}
    </button>
  )
}

// ── Logo SVG ───────────────────────────────────────────
function LogoMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="2" y="7" width="3.5" height="10" rx="1.75" fill="white" opacity="1" />
      <rect x="7" y="3" width="3.5" height="18" rx="1.75" fill="white" opacity="0.65" />
      <rect x="12" y="6" width="3.5" height="12" rx="1.75" fill="white" opacity="0.4" />
      <rect x="17" y="9" width="3.5" height="6" rx="1.75" fill="white" opacity="0.22" />
    </svg>
  )
}

const MIC_ICON = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
)

// ── Main view ───────────────────────────────────────────
export type SonnyTab = 'home' | 'models' | 'settings' | 'developer'

export function SonnyShell({
  activeTab,
  onTabChange,
  connected,
  children,
}: {
  activeTab: SonnyTab
  onTabChange: (tab: SonnyTab) => void
  connected: boolean
  children: ReactNode
}) {
  return (
    <div
      className="sonny-shell"
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        background: tokens.bg,
      }}
    >
      <SonnyNav
        activeTab={activeTab}
        connected={connected}
        onTabChange={onTabChange}
      />
      {children}
    </div>
  )
}

function SonnyNav({
  activeTab,
  connected,
  onTabChange,
}: {
  activeTab: SonnyTab
  connected: boolean
  onTabChange: (tab: SonnyTab) => void
}) {
  return (
    <nav
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '8px 16px',
        minHeight: 48,
        borderBottom: `1px solid ${tokens.borderSubtle}`,
        flexShrink: 0,
        rowGap: 8,
        columnGap: 12,
        background: tokens.bg,
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginRight: 12,
        }}
      >
        <LogoMark />
        <span
          style={{
            color: 'rgba(255,255,255,0.88)',
            fontWeight: 500,
            fontSize: 14,
            letterSpacing: '-0.02em',
          }}
        >
          Sonny
        </span>
      </div>

      <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <NavTab
          label="Home"
          active={activeTab === 'home'}
          onClick={() => onTabChange('home')}
        />
        <NavTab
          label="Models"
          active={activeTab === 'models'}
          onClick={() => onTabChange('models')}
        />
        <NavTab
          label="Settings"
          active={activeTab === 'settings'}
          onClick={() => onTabChange('settings')}
        />
        <NavTab
          label="Developer"
          active={activeTab === 'developer'}
          onClick={() => onTabChange('developer')}
        />
      </div>

      <div
        style={{
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <ConnectionPill connected={connected} />
      </div>
    </nav>
  )
}

function ConnectionPill({ connected }: { connected: boolean }) {
  const style: CSSProperties = connected
    ? {
        background: tokens.greenBg,
        border: `1px solid ${tokens.greenBorder}`,
        color: tokens.green,
      }
    : {
        background: tokens.redBg,
        border: `1px solid ${tokens.redBorder}`,
        color: tokens.red,
      }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 11px',
        borderRadius: 20,
        ...style,
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: connected ? tokens.green : tokens.red,
          display: 'inline-block',
          animation: 'sonny-subtle-pulse 2.5s ease-in-out infinite',
        }}
      />
      <span style={{ fontSize: 12, letterSpacing: '-0.01em' }}>
        {connected ? 'Connected' : 'Disconnected'}
      </span>
    </div>
  )
}

export function SonnyHome({
  state,
  connected,
  youText,
  sonnyText,
  totalLatencyMs,
  busy,
  errorMessage,
  onStartListening,
  onInterrupt,
  onNewSession,
}: SonnyHomeProps) {
  const statusLabel = useMemo(() => {
    switch (state) {
      case 'idle':
        return 'Ready'
      case 'listening':
        return 'Listening…'
      case 'processing':
        return 'Processing…'
      case 'responding':
        return 'Responding…'
    }
  }, [state])

  const showLatency = state === 'idle' && totalLatencyMs !== null
  const showAllDone = state === 'idle' && totalLatencyMs !== null
  const interruptDisabled = state === 'idle' || busy === true
  const startDisabled = state !== 'idle' || busy === true || !connected

  const {
    amplitudes: micAmplitudes,
    hasLive: micHasLive,
    permission: micPermission,
  } = useMicAmplitudes(state === 'listening')

  return (
    <main
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 24px',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 680,
          display: 'flex',
          flexDirection: 'column',
          gap: 40,
        }}
      >
        {/* Hero */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 20,
          }}
        >
          <div
            style={{
              position: 'relative',
              width: 480,
              maxWidth: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {state === 'listening' ? (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background:
                    'radial-gradient(ellipse 60% 80% at 50% 50%, rgba(255,255,255,0.04) 0%, transparent 70%)',
                  pointerEvents: 'none',
                }}
              />
            ) : null}
            <Waveform
              state={state}
              liveAmplitudes={micAmplitudes}
              hasLive={micHasLive}
            />
          </div>

          <StatusLabel
            state={state}
            statusLabel={statusLabel}
            showLatency={showLatency}
            totalLatencyMs={totalLatencyMs}
            micPermission={micPermission}
          />
        </div>

        {/* Controls */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <CtrlBtn
            label="Start Listening"
            icon={MIC_ICON}
            primary
            disabled={startDisabled}
            onClick={onStartListening}
          />
          <CtrlBtn
            label="Interrupt"
            disabled={interruptDisabled}
            onClick={onInterrupt}
          />
          <CtrlBtn label="New Session" onClick={onNewSession} />
        </div>

        {/* Transcript */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            animation: 'sonny-fade-up 0.4s ease',
          }}
        >
          <TranscriptPanel
            label="You"
            statusText={state === 'listening' ? 'listening…' : null}
            value={youText}
            placeholder="Waiting for speech…"
            borderColor={
              state === 'listening'
                ? tokens.borderActive.you
                : tokens.borderSubtle
            }
            cursor={false}
          />
          <TranscriptPanel
            label="Sonny"
            statusText={state === 'responding' ? 'responding…' : null}
            value={sonnyText}
            placeholder="Waiting for response…"
            borderColor={
              state === 'responding'
                ? tokens.borderActive.sonny
                : tokens.borderSubtle
            }
            cursor={state === 'responding' && sonnyText.length > 0}
          />
        </div>

        {/* Pipeline status */}
        <PipelineBar state={state} showAllDone={showAllDone} />

        {/* Error notice */}
        {errorMessage !== null && errorMessage !== undefined && errorMessage.length > 0 ? (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 10,
              background: tokens.redBg,
              border: `1px solid ${tokens.redBorder}`,
              color: tokens.red,
              fontSize: 12,
              lineHeight: 1.55,
            }}
          >
            {errorMessage}
          </div>
        ) : null}
      </div>
    </main>
  )
}

function StatusLabel({
  state,
  statusLabel,
  showLatency,
  totalLatencyMs,
  micPermission,
}: {
  state: SonnyVoiceState
  statusLabel: string
  showLatency: boolean
  totalLatencyMs: number | null
  micPermission: MicPermission
}) {
  const permissionHint =
    state === 'listening' && micPermission === 'requesting'
      ? 'mic prompt…'
      : state === 'listening' && micPermission === 'blocked'
        ? 'browser mic blocked'
        : null
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        color:
          state === 'idle' ? tokens.textIdle : tokens.textActive,
        fontSize: 13,
        letterSpacing: '-0.01em',
        transition: 'color 0.4s',
      }}
    >
      {state === 'processing' ? (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          style={{ animation: 'sonny-spin 1s linear infinite' }}
          aria-hidden
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      ) : null}
      {state === 'listening' ? (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'white',
            display: 'inline-block',
            animation: 'sonny-subtle-pulse 1s ease-in-out infinite',
          }}
        />
      ) : null}
      <span>{statusLabel}</span>
      {permissionHint !== null ? (
        <span style={{ color: tokens.textDim, fontSize: 12 }}>
          · {permissionHint}
        </span>
      ) : null}
      {showLatency && totalLatencyMs !== null ? (
        <span style={{ color: tokens.textDim, fontSize: 12 }}>
          · {totalLatencyMs}ms
        </span>
      ) : null}
    </div>
  )
}

function TranscriptPanel({
  label,
  statusText,
  value,
  placeholder,
  borderColor,
  cursor,
}: {
  label: string
  statusText: string | null
  value: string
  placeholder: string
  borderColor: string
  cursor: boolean
}) {
  const hasText = value.length > 0

  return (
    <div
      style={{
        padding: '16px 20px',
        borderRadius: 12,
        background: tokens.surface,
        border: '1px solid',
        borderColor,
        transition: 'border-color 0.4s',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <span
          style={{
            color: tokens.textSecondary,
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}
        >
          {label}
        </span>
        {statusText !== null ? (
          <span style={{ color: tokens.textMuted, fontSize: 11 }}>
            {statusText}
          </span>
        ) : null}
      </div>
      <p
        style={{
          color: hasText ? tokens.textPrimary : tokens.textDim,
          fontSize: 14,
          lineHeight: 1.65,
          letterSpacing: '-0.01em',
          margin: 0,
          animation: hasText ? 'sonny-fade-up 0.3s ease' : 'none',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {hasText ? value : placeholder}
        {cursor ? (
          <span
            style={{
              display: 'inline-block',
              width: 2,
              height: 14,
              background: 'rgba(255,255,255,0.6)',
              marginLeft: 2,
              animation: 'sonny-blink 1s step-end infinite',
              verticalAlign: 'text-bottom',
            }}
          />
        ) : null}
      </p>
    </div>
  )
}

// ── State mapping helper ───────────────────────────────
export function mapBackendStateToSonny(
  backendState: string,
  micActive: boolean,
  playbackActive: boolean,
): SonnyVoiceState {
  if (backendState === 'speaking' || playbackActive) {
    return 'responding'
  }
  if (backendState === 'thinking' || backendState === 'transcribing') {
    return 'processing'
  }
  if (backendState === 'listening' || micActive) {
    return 'listening'
  }
  return 'idle'
}

// re-export for users
export const sonnyTokens = tokens

// helper hook so the home page can lock document.documentElement.style.background while mounted
export function useSonnyDocumentBackground(): void {
  useEffect(() => {
    const previousBody = document.body.style.background
    const previousHtml = document.documentElement.style.background
    document.body.style.background = tokens.bg
    document.documentElement.style.background = tokens.bg

    return () => {
      document.body.style.background = previousBody
      document.documentElement.style.background = previousHtml
    }
  }, [])
}

// Convenience: construct the full controlled props from snapshot + helpers
export function buildSonnyControlState(input: {
  backendState: string
  micActive: boolean
  playbackActive: boolean
  userPartial: string | null
  lastTranscript: string | null
  assistantPartial: string | null
  lastResponse: string | null
  totalLatencyMs: number | null
}): {
  state: SonnyVoiceState
  youText: string
  sonnyText: string
  totalLatencyMs: number | null
} {
  const state = mapBackendStateToSonny(
    input.backendState,
    input.micActive,
    input.playbackActive,
  )

  return {
    state,
    youText: input.userPartial ?? input.lastTranscript ?? '',
    sonnyText: input.assistantPartial ?? input.lastResponse ?? '',
    totalLatencyMs: state === 'idle' ? input.totalLatencyMs : null,
  }
}

export type { SonnyVoiceState as SonnyHomeState }

// Keep callback typing tidy when caller passes inline handlers
export function asAction(handler: () => void | Promise<void>): () => void {
  return () => {
    void handler()
  }
}

// Lightweight hook for staggered post-action busy lock so buttons feel snappy
export function useTransientBusy(activeMs: number = 250): {
  busy: boolean
  run: (handler: () => void | Promise<void>) => void
} {
  const [busy, setBusy] = useState(false)
  const timerRef = useRef<number | null>(null)

  const run = useCallback(
    (handler: () => void | Promise<void>) => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
      }
      setBusy(true)
      const finish = (): void => {
        timerRef.current = window.setTimeout(() => setBusy(false), activeMs)
      }
      try {
        const result = handler()
        if (result !== undefined && typeof result.then === 'function') {
          result.then(finish, finish)
        } else {
          finish()
        }
      } catch {
        finish()
      }
    },
    [activeMs],
  )

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
      }
    },
    [],
  )

  return { busy, run }
}
