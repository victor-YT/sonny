import { useCallback, useState, type CSSProperties } from 'react'

import {
  Badge,
  Card,
  PageShell,
  PageTitle,
  SectionLabel,
  sonnyFieldLabelStyle,
  sonnyInputStyle,
  sonnyUiTokens,
  useLocalStorageState,
} from './sonny-ui'

const STORAGE_KEY = 'sonny.models.v1'
const ACTIVE_STORAGE_KEY = 'sonny.models.active.v1'

export interface SonnyModel {
  id: string
  name: string
  host: string
  apiKey: string
}

type TestState = 'idle' | 'testing' | 'ok' | 'fail'

export function SonnyModelsPage() {
  const [models, setModels] = useLocalStorageState<SonnyModel[]>(STORAGE_KEY, [])
  const [activeId, setActiveId] = useLocalStorageState<string | null>(
    ACTIVE_STORAGE_KEY,
    null,
  )
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const handleSelect = useCallback(
    async (model: SonnyModel) => {
      if (model.id === activeId) {
        return
      }
      setLoadingId(model.id)
      setError(null)
      try {
        const response = await fetch('/api/runtime/llm-endpoint', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseUrl: model.host,
            model: model.name,
            apiKey: model.apiKey.length > 0 ? model.apiKey : undefined,
          }),
        })
        if (!response.ok) {
          const text = (await response.text()).slice(0, 200)
          throw new Error(text.length > 0 ? text : `HTTP ${response.status}`)
        }
        setActiveId(model.id)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoadingId(null)
      }
    },
    [activeId, setActiveId],
  )

  const handleAdd = useCallback(
    (model: SonnyModel) => {
      setModels((prev) => {
        if (prev.some((entry) => entry.id === model.id)) {
          return prev.map((entry) => (entry.id === model.id ? model : entry))
        }
        return [...prev, model]
      })
      if (activeId === null) {
        void handleSelect(model)
      }
    },
    [activeId, handleSelect, setModels],
  )

  return (
    <PageShell>
      {showAdd ? (
        <AddModelModal onAdd={handleAdd} onClose={() => setShowAdd(false)} />
      ) : null}

      <PageTitle
        label="Models"
        sub="Connect a locally-running language model. All inference happens on your device."
      />

      <SectionLabel>Language Model</SectionLabel>

      {error !== null ? (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 10,
            background: sonnyUiTokens.redBg,
            border: `1px solid ${sonnyUiTokens.redBorder}`,
            color: sonnyUiTokens.red,
            fontSize: 12,
            lineHeight: 1.55,
            marginBottom: 12,
          }}
        >
          {error}
        </div>
      ) : null}

      {models.length === 0 ? (
        <EmptyState onClick={() => setShowAdd(true)} />
      ) : (
        <Card>
          {models.map((model, index) => (
            <ModelRow
              key={model.id}
              model={model}
              isActive={model.id === activeId}
              isLoading={model.id === loadingId}
              isFirst={index === 0}
              isLast={index === models.length - 1}
              onClick={() => void handleSelect(model)}
            />
          ))}
          <AddModelRow onClick={() => setShowAdd(true)} />
        </Card>
      )}
    </PageShell>
  )
}

function EmptyState({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false)

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: '48px 24px',
        background: hover ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)',
        border: `1px dashed ${hover ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.1)'}`,
        borderRadius: 12,
        cursor: 'pointer',
        transition: 'all 0.15s',
        width: '100%',
        fontFamily: 'inherit',
      }}
    >
      <span
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          border: '1.5px solid rgba(255,255,255,0.15)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <PlusIcon size={14} stroke="rgba(255,255,255,0.35)" />
      </span>
      <span style={{ textAlign: 'center', display: 'block' }}>
        <span
          style={{
            display: 'block',
            color: 'rgba(255,255,255,0.5)',
            fontSize: 13,
            letterSpacing: '-0.01em',
            marginBottom: 3,
          }}
        >
          No model connected
        </span>
        <span
          style={{
            display: 'block',
            color: 'rgba(255,255,255,0.25)',
            fontSize: 12,
          }}
        >
          Click to add an OpenAI-compatible endpoint
        </span>
      </span>
    </button>
  )
}

function ModelRow({
  model,
  isActive,
  isLoading,
  isFirst,
  isLast,
  onClick,
}: {
  model: SonnyModel
  isActive: boolean
  isLoading: boolean
  isFirst: boolean
  isLast: boolean
  onClick: () => void
}) {
  const [hover, setHover] = useState(false)
  const background = isActive
    ? 'rgba(255,255,255,0.04)'
    : hover
      ? 'rgba(255,255,255,0.02)'
      : 'transparent'

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick()
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '13px 18px',
        cursor: 'pointer',
        borderBottom: isLast ? 'none' : `1px solid ${sonnyUiTokens.rowDivider}`,
        background,
        transition: 'background 0.15s',
        borderRadius: isFirst ? '12px 12px 0 0' : 0,
      }}
    >
      <RadioDot active={isActive} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              color: isActive
                ? 'rgba(255,255,255,0.9)'
                : 'rgba(255,255,255,0.6)',
              fontSize: 13,
              fontWeight: isActive ? 500 : 400,
              letterSpacing: '-0.01em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {model.name}
          </span>
          {isActive ? <Badge label="Active" color="green" /> : null}
        </div>
        <div
          style={{
            color: 'rgba(255,255,255,0.25)',
            fontSize: 11,
            marginTop: 3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {model.host}
        </div>
      </div>
      {isLoading ? <SpinnerIcon size={14} color="rgba(255,255,255,0.4)" /> : null}
    </div>
  )
}

function AddModelRow({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick()
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '12px 18px',
        cursor: 'pointer',
        borderTop: `1px solid ${sonnyUiTokens.rowDivider}`,
        transition: 'background 0.15s',
        borderRadius: '0 0 12px 12px',
        background: hover ? 'rgba(255,255,255,0.02)' : 'transparent',
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: '50%',
          flexShrink: 0,
          border: '1.5px solid rgba(255,255,255,0.12)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <PlusIcon size={8} stroke="rgba(255,255,255,0.3)" strokeWidth={2.5} />
      </span>
      <span
        style={{
          color: 'rgba(255,255,255,0.28)',
          fontSize: 13,
          letterSpacing: '-0.01em',
        }}
      >
        Add model…
      </span>
    </div>
  )
}

function RadioDot({ active }: { active: boolean }) {
  return (
    <span
      style={{
        width: 16,
        height: 16,
        borderRadius: '50%',
        flexShrink: 0,
        border: `1.5px solid ${active ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.15)'}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'border-color 0.2s',
      }}
    >
      {active ? (
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.9)',
          }}
        />
      ) : null}
    </span>
  )
}

// ── Modal ─────────────────────────────────────────────
function AddModelModal({
  onAdd,
  onClose,
}: {
  onAdd: (model: SonnyModel) => void
  onClose: () => void
}) {
  const [host, setHost] = useState('http://127.0.0.1:8000')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [modelId, setModelId] = useState('')
  const [testState, setTestState] = useState<TestState>('idle')
  const [testDetail, setTestDetail] = useState<string | null>(null)

  const trimmedHost = host.trim().replace(/\/+$/u, '')
  const trimmedModel = modelId.trim()
  const canAdd =
    trimmedHost.length > 0 && trimmedModel.length > 0 && testState === 'ok'

  const resetTest = (): void => {
    setTestState('idle')
    setTestDetail(null)
  }

  const handleTest = async (): Promise<void> => {
    if (trimmedHost.length === 0) {
      return
    }
    setTestState('testing')
    setTestDetail(null)
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 6000)
    try {
      const headers: Record<string, string> = {}
      if (apiKey.length > 0) {
        headers.authorization = `Bearer ${apiKey}`
      }
      const target = `${trimmedHost.replace(/\/v1$/u, '')}/v1/models`
      const response = await fetch(target, {
        method: 'GET',
        headers,
        signal: controller.signal,
      })
      if (response.ok) {
        setTestState('ok')
      } else {
        setTestState('fail')
        setTestDetail(`HTTP ${response.status}`)
      }
    } catch (err) {
      setTestState('fail')
      setTestDetail(err instanceof Error ? err.message : String(err))
    } finally {
      window.clearTimeout(timeout)
    }
  }

  const submit = (): void => {
    if (!canAdd) {
      return
    }
    onAdd({
      id: `${trimmedHost}::${trimmedModel}`,
      name: trimmedModel,
      host: trimmedHost,
      apiKey,
    })
    onClose()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        animation: 'sonny-fade-in 0.15s ease',
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <div
        style={{
          background: '#161618',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 14,
          padding: 24,
          width: 380,
          maxWidth: 'calc(100vw - 32px)',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 15,
              fontWeight: 500,
              color: 'rgba(255,255,255,0.88)',
              letterSpacing: '-0.02em',
              marginBottom: 3,
            }}
          >
            Add model
          </div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)' }}>
            Connect a locally-running OpenAI-compatible API.
          </div>
        </div>

        <ProviderField />

        <Field label="API Host">
          <input
            value={host}
            onChange={(event) => {
              setHost(event.target.value)
              resetTest()
            }}
            placeholder="http://127.0.0.1:8000"
            style={sonnyInputStyle}
          />
        </Field>

        <Field
          label={
            <>
              API Key{' '}
              <span style={{ color: 'rgba(255,255,255,0.2)', fontWeight: 400 }}>
                — optional
              </span>
            </>
          }
        >
          <div style={{ position: 'relative' }}>
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value)
                resetTest()
              }}
              placeholder="sk-..."
              style={{ ...sonnyInputStyle, paddingRight: 36 }}
            />
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              style={eyeButtonStyle}
              aria-label={showKey ? 'Hide API key' : 'Show API key'}
            >
              {showKey ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </Field>

        <Field label="Model ID">
          <input
            value={modelId}
            onChange={(event) => {
              setModelId(event.target.value)
              resetTest()
            }}
            placeholder="e.g. Qwen2.5-1.5B-Instruct-4bit"
            style={sonnyInputStyle}
          />
        </Field>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={trimmedHost.length === 0 || testState === 'testing'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '7px 14px',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.1)',
              background: 'rgba(255,255,255,0.04)',
              color:
                testState === 'testing'
                  ? 'rgba(255,255,255,0.35)'
                  : 'rgba(255,255,255,0.6)',
              fontSize: 12,
              cursor:
                trimmedHost.length === 0 || testState === 'testing'
                  ? 'not-allowed'
                  : 'pointer',
              fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}
          >
            {testState === 'testing' ? (
              <SpinnerIcon size={12} color="currentColor" />
            ) : (
              <ArrowIcon />
            )}
            {testState === 'testing' ? 'Testing…' : 'Test connection'}
          </button>
          {testState === 'ok' ? (
            <span
              style={{
                fontSize: 12,
                color: sonnyUiTokens.green,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <CheckIcon /> Connected
            </span>
          ) : null}
          {testState === 'fail' ? (
            <span
              style={{
                fontSize: 12,
                color: sonnyUiTokens.red,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
              title={testDetail ?? undefined}
            >
              <XIcon /> Unreachable
            </span>
          ) : null}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            paddingTop: 4,
            borderTop: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '7px 16px',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.1)',
              background: 'transparent',
              color: 'rgba(255,255,255,0.4)',
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canAdd}
            style={{
              padding: '7px 16px',
              borderRadius: 8,
              border: 'none',
              background: canAdd
                ? 'rgba(255,255,255,0.88)'
                : 'rgba(255,255,255,0.12)',
              color: canAdd ? '#000' : 'rgba(255,255,255,0.2)',
              fontSize: 12,
              fontWeight: 500,
              cursor: canAdd ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit',
              transition: 'all 0.2s',
            }}
          >
            Add model
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <span style={sonnyFieldLabelStyle}>{label}</span>
      {children}
    </div>
  )
}

function ProviderField() {
  return (
    <div>
      <span style={sonnyFieldLabelStyle}>Provider</span>
      <div
        style={{
          ...sonnyInputStyle,
          color: 'rgba(255,255,255,0.45)',
          cursor: 'default',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span>OpenAI-compatible API</span>
        <ChevronDownIcon />
      </div>
    </div>
  )
}

const eyeButtonStyle: CSSProperties = {
  position: 'absolute',
  right: 10,
  top: '50%',
  transform: 'translateY(-50%)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  color: 'rgba(255,255,255,0.3)',
  display: 'flex',
  alignItems: 'center',
}

// ── Inline icons ──────────────────────────────────────
function PlusIcon({
  size,
  stroke,
  strokeWidth = 2,
}: {
  size: number
  stroke: string
  strokeWidth?: number
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      aria-hidden
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function SpinnerIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      style={{ animation: 'sonny-spin 1s linear infinite', flexShrink: 0 }}
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

function ChevronDownIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="rgba(255,255,255,0.2)"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      aria-hidden
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
}
