import { isDebugEnabled } from '../core/debug-log.js';

const TTS_DIAG_ENABLED = isDebugEnabled('SONNY_TTS_DIAG');

export function isTtsDiagEnabled(): boolean {
  return TTS_DIAG_ENABLED;
}

export function logTtsDiag(
  scope: string,
  event: string,
  fields: Record<string, string | number> = {},
): void {
  if (!TTS_DIAG_ENABLED) {
    return;
  }

  const parts = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  console.log(`[${scope}] event=${event}${parts.length > 0 ? ` ${parts}` : ''}`);
}
