import { API_BASE_URL } from '../../config/env';

// ── Prefs API (SQLite-backed, survives port changes) ──

export async function fetchPrefs(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/prefs`);
    if (!res.ok) return null;
    const body = await res.json();
    return body.prefs ?? null;
  } catch {
    return null;
  }
}

export async function savePrefs(prefs: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${API_BASE_URL}/prefs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs),
    });
  } catch {
    // Best-effort: localStorage is the fallback.
  }
}
