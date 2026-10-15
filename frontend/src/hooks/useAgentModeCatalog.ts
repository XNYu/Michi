import { useCallback, useEffect, useRef, useState } from 'react';
import { listAgentModes, type AgentModesResult, type AgentStatus } from '../services/api';

// A cold Kiro session can take over 30 seconds with workspace/MCP discovery.
const LOAD_TIMEOUT_MS = 60_000;
const RETRY_INTERVAL_MS = 500;

/** Workspace defaults and catalogs must never cross Backend/runtime boundaries. */
export function useAgentModeCatalog(
  workspaceId: string | null,
  backendConnectionId: string,
  status: AgentStatus | null,
) {
  const cache = useRef(new Map<string, AgentModesResult>());
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    key: string; catalog?: AgentModesResult; loading: boolean; error: string | null;
  } | null>(null);
  const key = JSON.stringify([backendConnectionId, workspaceId, status?.runtime, status?.capabilities.modes]);
  const supported = status?.capabilities.modes;
  // KiroRuntime exposes one global catalog, but the fresh-session default is
  // workspace-specific. Reuse only the list while discovering a new default.
  const globalKey = status?.runtime === 'kiro' && supported
    ? JSON.stringify([backendConnectionId, 'kiro']) : null;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    window.addEventListener('michi:reload-agent-status', retry);
    return () => window.removeEventListener('michi:reload-agent-status', retry);
  }, [retry]);

  useEffect(() => {
    if (supported === undefined) return;
    if (!supported) {
      setResult({ key, catalog: { availableModes: [], defaultModeId: null }, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    const cached = cache.current.get(key) ?? (globalKey ? cache.current.get(globalKey) : undefined);
    setResult({ key, catalog: cached, loading: true, error: null });
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const deadline = setTimeout(() => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      setResult({ key, catalog: cached, loading: false, error: 'Agents took too long to load. Please retry.' });
    }, LOAD_TIMEOUT_MS);

    const load = async () => {
      try {
        const catalog = await listAgentModes(workspaceId ?? undefined, controller.signal);
        if (cancelled || controller.signal.aborted) return;
        clearTimeout(deadline);
        cache.current.delete(key);
        cache.current.set(key, catalog);
        if (globalKey) cache.current.set(globalKey, { availableModes: catalog.availableModes, defaultModeId: null });
        if (cache.current.size > 32) cache.current.delete(cache.current.keys().next().value!);
        setResult({ key, catalog, loading: false, error: null });
      } catch {
        if (cancelled || controller.signal.aborted) return;
        // The renderer may mount before the Backend is listening. Retry within
        // one bounded loading window; after it expires, leave a visible action.
        retryTimer = setTimeout(() => void load(), RETRY_INTERVAL_MS);
      }
    };
    void load();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(deadline);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [key, globalKey, workspaceId, supported, attempt]);

  const current = result?.key === key ? result : null;
  const catalog = current?.catalog ?? cache.current.get(key) ?? (globalKey ? cache.current.get(globalKey) : undefined);
  return {
    availableModes: catalog?.availableModes ?? [],
    defaultModeId: catalog?.defaultModeId ?? null,
    agentModesLoading: current?.loading ?? supported !== false,
    agentModesError: current?.error ?? null,
    retryAgentModes: retry,
  };
}
