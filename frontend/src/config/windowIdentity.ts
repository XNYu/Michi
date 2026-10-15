function resolveWindowId(): string {
  const injected = (window as unknown as { electron?: { michiWindowId?: string } }).electron?.michiWindowId;
  if (typeof injected === 'string' && injected.length > 0) return injected;
  try {
    const key = 'michi:windowId';
    let value = window.sessionStorage.getItem(key);
    if (!value) {
      value = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      window.sessionStorage.setItem(key, value);
    }
    return value;
  } catch {
    return 'default';
  }
}

export const WINDOW_ID = typeof window !== 'undefined' ? resolveWindowId() : 'default';
