import React from 'react';
import { getElectron, type BackgroundServiceStatus } from '../../../lib/electronBridge';

export interface BackgroundServiceControl {
  /** null while loading, or when not running inside the desktop app. */
  status: BackgroundServiceStatus | null;
  /** True inside a desktop build that exposes the service bridge. */
  available: boolean;
  busy: boolean;
  error: string | null;
  setEnabled(enabled: boolean): Promise<void>;
}

/** Read and toggle the desktop app's always-on backend. */
export function useBackgroundService(): BackgroundServiceControl {
  const electron = getElectron();
  const available = !!electron?.getBackgroundServiceStatus && !!electron.setBackgroundServiceEnabled;
  const [status, setStatus] = React.useState<BackgroundServiceStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!available) return;
    let cancelled = false;
    electron!.getBackgroundServiceStatus!()
      .then((next) => { if (!cancelled) setStatus(next); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [available, electron]);

  const setEnabled = React.useCallback(async (enabled: boolean) => {
    if (!available) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await electron!.setBackgroundServiceEnabled!(enabled));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(reason));
      try { setStatus(await electron!.getBackgroundServiceStatus!()); } catch { /* keep the last status */ }
    } finally {
      setBusy(false);
    }
  }, [available, electron]);

  return { status, available, busy, error, setEnabled };
}
