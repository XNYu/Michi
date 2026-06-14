// Vitest setup hook.

// Node 22+ ships a built-in `localStorage` (--localstorage-file) that shadows
// jsdom's implementation and lacks standard methods like `clear()`.  Provide a
// minimal Storage-compliant shim so tests can call `localStorage.clear()`.
const store: Record<string, string> = {};
const storage: Storage = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => { store[k] = String(v); },
  removeItem: (k: string) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  key: (i: number) => Object.keys(store)[i] ?? null,
  get length() { return Object.keys(store).length; },
};

Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true });

// jsdom does not implement ResizeObserver. Provide a no-op stub so components
// that use it (e.g. ContextMenu's auto-reposition logic) don't throw in tests.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom lacks several layout APIs that ProseMirror/TipTap call during mount and
// coordinate mapping (the MentionEditor composer). Without these, mounting the
// editor throws `elementFromPoint is not a function` (TipTap's Placeholder
// viewport tracking). Stub them so the editor renders in tests.
if (typeof document !== 'undefined' && typeof document.elementFromPoint !== 'function') {
  document.elementFromPoint = () => null;
}
if (typeof Range !== 'undefined') {
  const emptyRect = (): DOMRect => ({
    x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
    toJSON() { return {}; },
  });
  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = emptyRect;
  }
  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = () =>
      ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} } as unknown as DOMRectList);
  }
}
