export const STREAMING_MARKDOWN_BLOCKS_STORAGE_KEY = 'michi:ff:streamingMarkdownBlocks';

function normalizeEnabled(value: unknown): boolean | null {
  if (value === true || value === 'true' || value === '1' || value === 'on') return true;
  if (value === false || value === 'false' || value === '0' || value === 'off') return false;
  return null;
}

export function streamingMarkdownBlocksEnabled(): boolean {
  if (typeof window !== 'undefined') {
    try {
      const stored = normalizeEnabled(window.localStorage.getItem(STREAMING_MARKDOWN_BLOCKS_STORAGE_KEY));
      if (stored !== null) return stored;
    } catch {
      // Fall through to env/default.
    }
  }
  return normalizeEnabled(import.meta.env.VITE_STREAMING_MARKDOWN_BLOCKS) ?? true;
}
