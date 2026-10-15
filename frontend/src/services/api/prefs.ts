import { API_BASE_URL } from '../../config/env';
import { isChatPermissionSettings, type ChatPermissionSettings } from 'michi-shared';

export async function savePermissionSettings(settings: ChatPermissionSettings, apiBase = API_BASE_URL): Promise<ChatPermissionSettings> {
  const res = await fetch(`${apiBase}/permissions/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error('Failed to save permission settings');
  const saved: unknown = await res.json();
  if (!isChatPermissionSettings(saved)) throw new Error('Backend does not support permission settings');
  return saved;
}

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
