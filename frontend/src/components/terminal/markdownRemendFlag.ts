export const MARKDOWN_REMEND_STORAGE_KEY = 'michi:markdown-remend';

function normalizeEnabled(value: unknown): boolean | null {
  if (value === true || value === 'true' || value === '1' || value === 'on') return true;
  if (value === false || value === 'false' || value === '0' || value === 'off') return false;
  return null;
}

/**
 * Kill switch for fake snapshot closers and styled pending-tail segments.
 * Default on; disabling it restores the legacy plain-tail path.
 */
export function markdownRemendEnabled(): boolean {
  if (typeof window !== 'undefined') {
    try {
      const stored = normalizeEnabled(window.localStorage.getItem(MARKDOWN_REMEND_STORAGE_KEY));
      if (stored !== null) return stored;
    } catch {
      // Fall through to env/default.
    }
  }
  return normalizeEnabled(import.meta.env.VITE_MARKDOWN_REMEND) ?? true;
}
