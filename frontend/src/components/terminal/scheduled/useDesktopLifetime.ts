import React from 'react';
import { getElectron, type DesktopLifetimeStatus } from '../../../lib/electronBridge';

export interface DesktopLifetimeControl {
  status: DesktopLifetimeStatus | null;
  available: boolean;
  busy: boolean;
  error: string | null;
  setKeepInBackground(enabled: boolean): Promise<void>;
  setOpenAtLogin(enabled: boolean): Promise<void>;
}

function cleanInvokeError(reason: unknown): string {
  if (reason instanceof Error) return reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  return String(reason);
}

/** Read and toggle Windows tray lifetime / login startup. */
export function useDesktopLifetime(): DesktopLifetimeControl {
  const electron = getElectron();
  const available = !!electron?.getDesktopLifetimeStatus && !!electron.setKeepInBackground && !!electron.setOpenAtLogin;
  const [status, setStatus] = React.useState<DesktopLifetimeStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!available) return;
    let cancelled = false;
    electron!.getDesktopLifetimeStatus!()
      .then((next) => { if (!cancelled) setStatus(next); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [available, electron]);

  const run = React.useCallback(async (work: () => Promise<DesktopLifetimeStatus>) => {
    if (!available) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await work());
    } catch (reason) {
      setError(cleanInvokeError(reason));
      try { setStatus(await electron!.getDesktopLifetimeStatus!()); } catch { /* keep the last status */ }
    } finally {
      setBusy(false);
    }
  }, [available, electron]);

  const setKeepInBackground = React.useCallback(async (enabled: boolean) => {
    await run(() => electron!.setKeepInBackground!(enabled));
  }, [electron, run]);

  const setOpenAtLogin = React.useCallback(async (enabled: boolean) => {
    await run(() => electron!.setOpenAtLogin!(enabled));
  }, [electron, run]);

  return { status, available, busy, error, setKeepInBackground, setOpenAtLogin };
}
