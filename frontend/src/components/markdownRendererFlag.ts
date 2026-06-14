export type MarkdownRendererKind = 'react-markdown' | 'streamdown';

export const MARKDOWN_RENDERER_STORAGE_KEY = 'michi:ff:markdownRenderer';
export const MARKDOWN_RENDERER_CHANGE_EVENT = 'michi:markdown-renderer-changed';

const DEFAULT_RENDERER: MarkdownRendererKind = 'react-markdown';

export function normalizeMarkdownRenderer(value: unknown): MarkdownRendererKind | null {
  if (value === 'react-markdown' || value === 'streamdown') return value;
  return null;
}

function envRenderer(): MarkdownRendererKind {
  return normalizeMarkdownRenderer(import.meta.env.VITE_MARKDOWN_RENDERER) ?? DEFAULT_RENDERER;
}

export function readMarkdownRendererFlag(): MarkdownRendererKind {
  if (typeof window === 'undefined') return envRenderer();

  try {
    const stored = normalizeMarkdownRenderer(window.localStorage.getItem(MARKDOWN_RENDERER_STORAGE_KEY));
    return stored ?? envRenderer();
  } catch {
    return envRenderer();
  }
}

export function setMarkdownRendererFlag(renderer: MarkdownRendererKind) {
  if (typeof window === 'undefined') return;

  window.localStorage.setItem(MARKDOWN_RENDERER_STORAGE_KEY, renderer);
  window.dispatchEvent(new Event(MARKDOWN_RENDERER_CHANGE_EVENT));
}

