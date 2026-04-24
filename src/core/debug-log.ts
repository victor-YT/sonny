export function isDebugEnabled(flag: string): boolean {
  const value = process.env[flag]?.trim().toLowerCase();

  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function debugLog(flag: string, message: string): void {
  if (isDebugEnabled(flag)) {
    console.log(message);
  }
}

export function debugWarn(flag: string, message: string): void {
  if (isDebugEnabled(flag)) {
    console.warn(message);
  }
}
