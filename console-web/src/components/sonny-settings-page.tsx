import { useEffect, useRef, useState } from 'react'

import {
  Card,
  PageShell,
  Row,
  SavedToast,
  SectionLabel,
  Segments,
  Select,
  Toggle,
  sonnyUiTokens,
  useLocalStorageState,
  useSavedToast,
} from './sonny-ui'

const STORAGE_KEY = 'sonny.settings.v1'

interface SonnySettings {
  name: string
  tone: 'Calm' | 'Direct' | 'Friendly' | 'Technical'
  responseLength: 'Short' | 'Balanced' | 'Detailed'
  allowInterruption: boolean
  saveTranscripts: boolean
}

const DEFAULT_SETTINGS: SonnySettings = {
  name: 'Sonny',
  tone: 'Calm',
  responseLength: 'Short',
  allowInterruption: true,
  saveTranscripts: true,
}

const TONE_OPTIONS = ['Calm', 'Direct', 'Friendly', 'Technical'] as const
const RESPONSE_LENGTH_OPTIONS = ['Short', 'Balanced', 'Detailed'] as const

export function SonnySettingsPage() {
  const [settings, setSettings] = useLocalStorageState<SonnySettings>(
    STORAGE_KEY,
    DEFAULT_SETTINGS,
  )
  const { stamp, trigger } = useSavedToast()
  const [deleteConfirming, setDeleteConfirming] = useState<boolean>(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Pull persisted backend personality.name on mount so we don't drift
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/personality')
        if (!response.ok) {
          return
        }
        const payload = (await response.json()) as {
          personality?: { name?: string }
        }
        if (cancelled) {
          return
        }
        const remoteName = payload.personality?.name
        if (typeof remoteName === 'string' && remoteName.length > 0) {
          setSettings((prev) =>
            prev.name === remoteName ? prev : { ...prev, name: remoteName },
          )
        }
      } catch {
        // ignore — we still have localStorage
      }
    })()
    return () => {
      cancelled = true
    }
  }, [setSettings])

  const update = <K extends keyof SonnySettings>(
    key: K,
    value: SonnySettings[K],
  ): void => {
    setSettings((prev) => ({ ...prev, [key]: value }))
    trigger()
  }

  // Debounced backend persistence for assistant name
  const nameDebounceRef = useRef<number | null>(null)
  useEffect(() => {
    if (nameDebounceRef.current !== null) {
      window.clearTimeout(nameDebounceRef.current)
    }
    nameDebounceRef.current = window.setTimeout(() => {
      void fetch('/api/personality', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: settings.name }),
      }).catch(() => undefined)
    }, 600)
    return () => {
      if (nameDebounceRef.current !== null) {
        window.clearTimeout(nameDebounceRef.current)
      }
    }
  }, [settings.name])

  const deleteTimerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (deleteTimerRef.current !== null) {
        window.clearTimeout(deleteTimerRef.current)
      }
    },
    [],
  )

  const handleDelete = async (): Promise<void> => {
    if (!deleteConfirming) {
      setDeleteConfirming(true)
      if (deleteTimerRef.current !== null) {
        window.clearTimeout(deleteTimerRef.current)
      }
      deleteTimerRef.current = window.setTimeout(() => {
        setDeleteConfirming(false)
      }, 3000)
      return
    }
    if (deleteTimerRef.current !== null) {
      window.clearTimeout(deleteTimerRef.current)
      deleteTimerRef.current = null
    }
    setDeleteConfirming(false)
    setStatusMessage(null)
    setErrorMessage(null)
    try {
      const response = await fetch('/api/runtime/reset', { method: 'POST' })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      setStatusMessage('Local conversation state cleared.')
      trigger()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <PageShell>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          marginBottom: 28,
          gap: 12,
        }}
      >
        <div>
          <h1
            style={{
              fontSize: 20,
              fontWeight: 600,
              color: 'rgba(255,255,255,0.9)',
              letterSpacing: '-0.03em',
              marginBottom: 5,
              margin: 0,
            }}
          >
            Settings
          </h1>
          <p
            style={{
              fontSize: 13,
              color: 'rgba(255,255,255,0.32)',
              lineHeight: 1.6,
              marginTop: 5,
              margin: 0,
            }}
          >
            Customize how Sonny sounds, responds, and behaves.
          </p>
        </div>
        <div style={{ marginTop: 4 }}>
          <SavedToast stamp={stamp} />
        </div>
      </div>

      {errorMessage !== null ? (
        <NoticeBanner kind="error" message={errorMessage} />
      ) : null}
      {statusMessage !== null && errorMessage === null ? (
        <NoticeBanner kind="info" message={statusMessage} />
      ) : null}

      <SectionLabel>Persona</SectionLabel>
      <Card>
        <Row
          label="Assistant name"
          sub="What Sonny calls itself in conversations"
        >
          <input
            value={settings.name}
            onChange={(event) => update('name', event.target.value)}
            style={{
              background: sonnyUiTokens.inputBg,
              border: `1px solid ${sonnyUiTokens.inputBorder}`,
              borderRadius: 7,
              color: sonnyUiTokens.inputText,
              fontSize: 13,
              padding: '5px 10px',
              fontFamily: 'inherit',
              width: 120,
              letterSpacing: '-0.01em',
              textAlign: 'right',
              outline: 'none',
            }}
          />
        </Row>
        <Row label="Tone" sub="Controls the voice and style of responses">
          <Select<SonnySettings['tone']>
            value={settings.tone}
            options={TONE_OPTIONS}
            onChange={(next) => update('tone', next)}
          />
        </Row>
        <Row
          label="Response length"
          sub="How long Sonny's answers tend to be"
          last
        >
          <Segments<SonnySettings['responseLength']>
            value={settings.responseLength}
            options={RESPONSE_LENGTH_OPTIONS}
            onChange={(next) => update('responseLength', next)}
          />
        </Row>
      </Card>

      <SectionLabel>Conversation</SectionLabel>
      <Card>
        <Row
          label="Allow interruption"
          sub="You can speak to stop Sonny mid-response"
          last
        >
          <Toggle
            value={settings.allowInterruption}
            onChange={(next) => update('allowInterruption', next)}
          />
        </Row>
      </Card>

      <SectionLabel>Privacy</SectionLabel>
      <Card>
        <Row
          label="Save transcripts locally"
          sub="Conversations are stored on your device only"
        >
          <Toggle
            value={settings.saveTranscripts}
            onChange={(next) => update('saveTranscripts', next)}
          />
        </Row>
        <Row
          label="Delete all local conversations"
          sub="This cannot be undone"
          last
        >
          <button
            type="button"
            onClick={() => void handleDelete()}
            style={{
              padding: '6px 14px',
              borderRadius: 7,
              border: `1px solid ${
                deleteConfirming
                  ? sonnyUiTokens.redBorder
                  : 'rgba(255,255,255,0.1)'
              }`,
              background: deleteConfirming
                ? sonnyUiTokens.redBg
                : 'transparent',
              color: deleteConfirming
                ? sonnyUiTokens.red
                : 'rgba(255,255,255,0.4)',
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'all 0.2s',
              letterSpacing: '-0.01em',
            }}
          >
            {deleteConfirming ? 'Tap again to confirm' : 'Delete history'}
          </button>
        </Row>
      </Card>
    </PageShell>
  )
}

function NoticeBanner({
  kind,
  message,
}: {
  kind: 'info' | 'error'
  message: string
}) {
  const palette =
    kind === 'error'
      ? {
          bg: sonnyUiTokens.redBg,
          border: sonnyUiTokens.redBorder,
          color: sonnyUiTokens.red,
        }
      : {
          bg: 'rgba(255,255,255,0.04)',
          border: 'rgba(255,255,255,0.08)',
          color: 'rgba(255,255,255,0.6)',
        }
  return (
    <div
      style={{
        padding: '10px 14px',
        borderRadius: 10,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        color: palette.color,
        fontSize: 12,
        lineHeight: 1.55,
        marginBottom: 12,
      }}
    >
      {message}
    </div>
  )
}
