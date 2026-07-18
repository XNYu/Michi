export const MARKDOWN_REINTERPRET_HZ_STORAGE_KEY = 'michi:ff:markdownReinterpretHz';

const DEFAULT_MARKDOWN_REINTERPRET_HZ = 3;
const MAX_MARKDOWN_REINTERPRET_HZ = 60;

function normalizeHz(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_MARKDOWN_REINTERPRET_HZ) return null;
  return parsed;
}

/**
 * Maximum streaming Markdown reinterpretation frequency.
 *
 * `0` preserves the legacy behavior and reparses on every displayed-text
 * update. Positive values throttle semantic Markdown work while Smooth keeps
 * advancing the visible text independently.
 */
export function markdownReinterpretationHz(): number {
  if (typeof window !== 'undefined') {
    try {
      const stored = normalizeHz(window.localStorage.getItem(MARKDOWN_REINTERPRET_HZ_STORAGE_KEY));
      if (stored !== null) return stored;
    } catch {
      // Fall through to env/default.
    }
  }
  return normalizeHz(import.meta.env.VITE_MARKDOWN_REINTERPRET_HZ)
    ?? DEFAULT_MARKDOWN_REINTERPRET_HZ;
}
