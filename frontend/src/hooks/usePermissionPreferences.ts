import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ChatPermissionSettings } from 'michi-shared';
import { API_BASE_URL } from '../config/env';
import { usePrefs } from '../state/prefs';
import { useBackendScope } from './useBackendScope';
import { loadPermissionPreferences, permissionSnapshot, saveScopedPermissionPreferences, subscribePermissionPreferences } from '../services/permissionPreferences';

/** Local fallback stays owned by PrefsProvider; remote settings are authoritative. */
export function usePermissionPreferences(apiBase = API_BASE_URL) {
  const { prefs, setPermissionSettings } = usePrefs();
  const scope = useBackendScope(undefined, apiBase);
  const remote = apiBase !== API_BASE_URL;
  const subscribe = useCallback((listener: () => void) => subscribePermissionPreferences(scope.key, listener), [scope.key]);
  const getSnapshot = useCallback(() => permissionSnapshot(scope.key), [scope.key]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const retry = useCallback(() => loadPermissionPreferences(scope.key, apiBase), [scope.key, apiBase]);
  useEffect(() => {
    if (!remote) return;
    void retry();
    const refresh = () => { void retry(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [remote, retry]);
  return {
    global: remote ? snapshot.settings?.global ?? false : prefs.globalPermissions,
    mode: remote ? snapshot.settings?.mode ?? 'ask' : prefs.permissionMode,
    loading: remote && snapshot.loading,
    error: remote ? snapshot.error : null,
    retry,
    save: (settings: ChatPermissionSettings) => remote
      ? saveScopedPermissionPreferences(scope.key, apiBase, settings)
      : setPermissionSettings(settings),
  };
}
