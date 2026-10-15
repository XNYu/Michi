import { useEffect, useState } from 'react';
import { isChatPermissionSettings, type ChatPermissionSettings } from 'michi-shared';
import { API_BASE_URL } from '../config/env';
import { usePrefs } from '../state/prefs';
import { savePermissionSettings } from '../services/api/prefs';

const revisions = new Map<string, number>();
const snapshots = new Map<string, ChatPermissionSettings>();
const listeners = new Map<string, Set<() => void>>();

/** Permission authority follows the workspace's gateway and authenticated user.
 * Local settings use PrefsProvider; remote controls use that gateway's API. */
export function usePermissionPreferences(apiBase = API_BASE_URL) {
  const { prefs, setPermissionSettings } = usePrefs();
  const remote = apiBase !== API_BASE_URL;
  const [, render] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const remoteSettings = snapshots.get(apiBase);
  useEffect(() => {
    if (!remote) return;
    let disposed = false;
    const refresh = async () => {
      const revision = revisions.get(apiBase) ?? 0;
      try {
        const res = await fetch(`${apiBase}/permissions/settings`);
        const body: unknown = await res.json();
        if (!res.ok || !isChatPermissionSettings(body)) throw new Error('Permission settings are unavailable on this Backend');
        if (disposed || revision !== (revisions.get(apiBase) ?? 0)) return;
        snapshots.set(apiBase, body);
        setError(null);
        for (const listener of listeners.get(apiBase) ?? []) listener();
      } catch (err) { if (!disposed) setError(err instanceof Error ? err.message : 'Permission settings unavailable'); }
    };
    const update = () => render((revision) => revision + 1);
    const subscribers = listeners.get(apiBase) ?? new Set();
    subscribers.add(update); listeners.set(apiBase, subscribers);
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => {
      disposed = true; subscribers.delete(update); window.removeEventListener('focus', onFocus);
      if (subscribers.size === 0) { snapshots.delete(apiBase); listeners.delete(apiBase); }
    };
  }, [apiBase, remote]);
  return {
    global: remote ? remoteSettings?.global ?? false : prefs.globalPermissions,
    mode: remote ? remoteSettings?.mode ?? 'ask' : prefs.permissionMode,
    loading: remote && !remoteSettings,
    error: remote ? error : null,
    save: async (settings: ChatPermissionSettings) => {
      if (!remote) return setPermissionSettings(settings);
      revisions.set(apiBase, (revisions.get(apiBase) ?? 0) + 1);
      const saved = await savePermissionSettings(settings, apiBase).finally(() => {
        revisions.set(apiBase, (revisions.get(apiBase) ?? 0) + 1);
      });
      snapshots.set(apiBase, saved);
      setError(null);
      for (const listener of listeners.get(apiBase) ?? []) listener();
    },
  };
}
