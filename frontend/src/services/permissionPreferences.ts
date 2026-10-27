import { isChatPermissionSettings, type ChatPermissionSettings } from 'michi-shared';
import { backendFetch } from './api/backendRequest';
import { savePermissionSettings } from './api/prefs';

interface Snapshot { settings?: ChatPermissionSettings; loading: boolean; error: string | null }
interface Entry { snapshot: Snapshot; revision: number; listeners: Set<() => void>; pending?: Promise<void> }
const entries = new Map<string, Entry>();
function entry(key: string): Entry {
  let current = entries.get(key);
  if (!current) { current = { snapshot: { loading: true, error: null }, revision: 0, listeners: new Set() }; entries.set(key, current); }
  return current;
}
function publish(current: Entry, snapshot: Snapshot) {
  current.snapshot = snapshot;
  current.listeners.forEach((listener) => listener());
}
export const permissionSnapshot = (key: string) => entry(key).snapshot;
export function subscribePermissionPreferences(key: string, listener: () => void) {
  const current = entry(key);
  current.listeners.add(listener);
  return () => { current.listeners.delete(listener); if (!current.listeners.size) entries.delete(key); };
}
export function loadPermissionPreferences(key: string, base: string): Promise<void> {
  const current = entry(key);
  if (current.pending) return current.pending;
  const revision = current.revision;
  publish(current, { ...current.snapshot, loading: true, error: null });
  const pending = (async () => {
    try {
      const response = await backendFetch(`${base}/permissions/settings`);
      const settings: unknown = await response.json();
      if (!response.ok || !isChatPermissionSettings(settings)) throw new Error('Permission settings are unavailable on this Backend');
      if (revision === current.revision) publish(current, { settings, loading: false, error: null });
    } catch (error) {
      if (revision === current.revision) publish(current, { ...current.snapshot, loading: false, error: error instanceof Error ? error.message : 'Permission settings unavailable' });
    }
  })().finally(() => { if (current.pending === pending) current.pending = undefined; });
  current.pending = pending;
  return pending;
}
export async function saveScopedPermissionPreferences(key: string, base: string, settings: ChatPermissionSettings) {
  const current = entry(key);
  const revision = ++current.revision;
  try {
    const saved = await savePermissionSettings(settings, base);
    if (revision === current.revision) publish(current, { settings: saved, loading: false, error: null });
  } catch (error) {
    if (revision === current.revision) publish(current, { ...current.snapshot, loading: false, error: error instanceof Error ? error.message : 'Failed to save permission settings' });
    throw error;
  } finally { if (revision === current.revision) current.revision += 1; }
}
