import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'

export const sonnyUiTokens = {
  bg: '#0c0c0e',
  cardBg: 'rgba(255,255,255,0.03)',
  cardBorder: 'rgba(255,255,255,0.07)',
  rowDivider: 'rgba(255,255,255,0.05)',
  rowLabel: 'rgba(255,255,255,0.82)',
  rowSub: 'rgba(255,255,255,0.3)',
  sectionLabel: 'rgba(255,255,255,0.28)',
  pageTitle: 'rgba(255,255,255,0.9)',
  pageSubtitle: 'rgba(255,255,255,0.32)',
  inputBg: 'rgba(255,255,255,0.06)',
  inputBorder: 'rgba(255,255,255,0.1)',
  inputBorderFocus: 'rgba(255,255,255,0.25)',
  inputText: 'rgba(255,255,255,0.8)',
  inputLabel: 'rgba(255,255,255,0.38)',
  green: '#4ade80',
  greenBg: 'rgba(74,222,128,0.1)',
  greenBorder: 'rgba(74,222,128,0.2)',
  red: '#f87171',
  redBg: 'rgba(239,68,68,0.1)',
  redBorder: 'rgba(239,68,68,0.5)',
} as const

const FONT_FAMILY = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif"

// ── Page shell ─────────────────────────────────────────
export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '40px 0 60px',
        animation: 'sonny-fade-in 0.18s ease',
        fontFamily: FONT_FAMILY,
      }}
    >
      <div style={{ maxWidth: 620, margin: '0 auto', padding: '0 24px' }}>
        {children}
      </div>
    </div>
  )
}

// ── Page title ─────────────────────────────────────────
export function PageTitle({ label, sub }: { label: string; sub?: string }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <h1
        style={{
          fontSize: 20,
          fontWeight: 600,
          color: sonnyUiTokens.pageTitle,
          letterSpacing: '-0.03em',
          marginBottom: 5,
          margin: 0,
        }}
      >
        {label}
      </h1>
      {sub !== undefined ? (
        <p
          style={{
            fontSize: 13,
            color: sonnyUiTokens.pageSubtitle,
            lineHeight: 1.6,
            marginTop: 5,
            margin: 0,
          }}
        >
          {sub}
        </p>
      ) : null}
    </div>
  )
}

// ── Section label ──────────────────────────────────────
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: '0.07em',
        textTransform: 'uppercase',
        color: sonnyUiTokens.sectionLabel,
        marginBottom: 8,
        marginTop: 32,
        paddingLeft: 2,
      }}
    >
      {children}
    </div>
  )
}

// ── Card + Row ─────────────────────────────────────────
export function Card({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: sonnyUiTokens.cardBg,
        border: `1px solid ${sonnyUiTokens.cardBorder}`,
        borderRadius: 12,
      }}
    >
      {children}
    </div>
  )
}

export function Row({
  label,
  sub,
  children,
  last,
}: {
  label: string
  sub?: string
  children: ReactNode
  last?: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '15px 18px',
        borderBottom: last === true ? 'none' : `1px solid ${sonnyUiTokens.rowDivider}`,
        gap: 20,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            color: sonnyUiTokens.rowLabel,
            fontSize: 13,
            letterSpacing: '-0.01em',
          }}
        >
          {label}
        </div>
        {sub !== undefined ? (
          <div
            style={{
              color: sonnyUiTokens.rowSub,
              fontSize: 12,
              marginTop: 3,
              lineHeight: 1.5,
            }}
          >
            {sub}
          </div>
        ) : null}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  )
}

// ── Toggle ─────────────────────────────────────────────
export function Toggle({
  value,
  onChange,
}: {
  value: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      aria-pressed={value}
      style={{
        appearance: 'none',
        border: 'none',
        padding: 0,
        width: 36,
        height: 20,
        borderRadius: 10,
        cursor: 'pointer',
        background: value
          ? 'rgba(255,255,255,0.85)'
          : 'rgba(255,255,255,0.12)',
        transition: 'background 0.2s',
        position: 'relative',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: value ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: value ? sonnyUiTokens.bg : 'rgba(255,255,255,0.5)',
          transition: 'left 0.2s, background 0.2s',
          boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
        }}
      />
    </button>
  )
}

// ── Segmented control ─────────────────────────────────
export function Segments<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: readonly T[]
  onChange: (next: T) => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        background: 'rgba(255,255,255,0.05)',
        borderRadius: 8,
        padding: 3,
        gap: 2,
      }}
    >
      {options.map((opt) => {
        const active = value === opt
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            style={{
              padding: '5px 14px',
              borderRadius: 6,
              border: 'none',
              cursor: 'pointer',
              background: active ? 'rgba(255,255,255,0.1)' : 'transparent',
              color: active
                ? 'rgba(255,255,255,0.88)'
                : 'rgba(255,255,255,0.35)',
              fontSize: 12,
              fontFamily: 'inherit',
              fontWeight: active ? 500 : 400,
              transition: 'all 0.15s',
              letterSpacing: '-0.01em',
              boxShadow: active ? '0 1px 3px rgba(0,0,0,0.3)' : 'none',
            }}
          >
            {opt}
          </button>
        )
      })}
    </div>
  )
}

// ── Select ─────────────────────────────────────────────
export function Select<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: readonly T[]
  onChange: (next: T) => void
}) {
  const chevron =
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='rgba(255,255,255,0.35)' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")"

  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      style={{
        background: sonnyUiTokens.inputBg,
        border: `1px solid ${sonnyUiTokens.inputBorder}`,
        borderRadius: 7,
        color: 'rgba(255,255,255,0.75)',
        fontSize: 12,
        padding: '5px 26px 5px 10px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        outline: 'none',
        appearance: 'none',
        backgroundImage: chevron,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 8px center',
      }}
    >
      {options.map((opt) => (
        <option key={opt} value={opt} style={{ background: '#1a1a1c' }}>
          {opt}
        </option>
      ))}
    </select>
  )
}

// ── Badge ─────────────────────────────────────────────
export function Badge({
  label,
  color = 'muted',
}: {
  label: string
  color?: 'green' | 'muted'
}) {
  const palette =
    color === 'green'
      ? {
          bg: sonnyUiTokens.greenBg,
          border: sonnyUiTokens.greenBorder,
          text: sonnyUiTokens.green,
        }
      : {
          bg: 'rgba(255,255,255,0.05)',
          border: 'rgba(255,255,255,0.1)',
          text: 'rgba(255,255,255,0.35)',
        }

  return (
    <span
      style={{
        padding: '2px 8px',
        borderRadius: 5,
        fontSize: 11,
        fontWeight: 500,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        color: palette.text,
        letterSpacing: '0.02em',
      }}
    >
      {label}
    </span>
  )
}

// ── SavedToast ────────────────────────────────────────
export function SavedToast({ stamp }: { stamp: number }) {
  if (stamp <= 0) {
    return null
  }

  return (
    <span
      key={stamp}
      style={{
        fontSize: 12,
        color: 'rgba(255,255,255,0.3)',
        letterSpacing: '-0.01em',
        animation: 'sonny-saved-fade 2.2s ease forwards',
        display: 'inline-block',
      }}
    >
      Applied instantly
    </span>
  )
}

// ── Form input + label ────────────────────────────────
export const sonnyInputStyle: CSSProperties = {
  background: sonnyUiTokens.inputBg,
  border: `1px solid ${sonnyUiTokens.inputBorder}`,
  borderRadius: 7,
  color: sonnyUiTokens.inputText,
  fontSize: 13,
  padding: '8px 11px',
  fontFamily: 'inherit',
  width: '100%',
  letterSpacing: '-0.01em',
  outline: 'none',
}

export const sonnyFieldLabelStyle: CSSProperties = {
  fontSize: 11,
  color: sonnyUiTokens.inputLabel,
  marginBottom: 5,
  letterSpacing: '0.03em',
  display: 'block',
}

// ── Hooks ─────────────────────────────────────────────
export function useLocalStorageState<T>(
  key: string,
  initial: T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') {
      return initial
    }
    try {
      const raw = window.localStorage.getItem(key)
      if (raw === null) {
        return initial
      }
      return JSON.parse(raw) as T
    } catch {
      return initial
    }
  })

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // ignore quota / serialization errors
    }
  }, [key, value])

  return [value, setValue]
}

export function useSavedToast(): {
  stamp: number
  trigger: () => void
} {
  const [stamp, setStamp] = useState<number>(0)
  const trigger = useCallback(() => {
    setStamp(Date.now())
  }, [])
  return { stamp, trigger }
}
