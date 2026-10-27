import { useEffect } from 'react';
import { warmCwd, type AgentStatus } from '../services/api';
import { requestRetryDelay, shouldRetryRequest } from '../services/api/httpError';
import { startupMark } from '../services/startupTrace';

const MAX_ATTEMPTS = 8;
const WARM_TIMEOUT_MS = 60_000;

/** Prewarming is optional. Retry cold-start failures, but never spin on an
 * invalid Workspace folder or restart because unrelated project state changed. */
export function useWorkspacePrewarm(
  enabled: boolean,
  workspace: { id: string; cwd?: string; backendConnectionId?: string } | undefined,
  status: AgentStatus | null,
) {
  const cwd = workspace?.cwd;
  const projectId = workspace?.id;
  const connectionId = workspace?.backendConnectionId;
  const runtime = status?.runtime;
  const model = status?.model ?? '';

  useEffect(() => {
    if (!enabled || !cwd || !runtime) return;
    const controller = new AbortController();
    const startedAt = Date.now();
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const metadata = { cwd, projectId, runtime, model };
    const deadline = setTimeout(() => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      startupMark('workspace_warm_gave_up', { ...metadata, attempts, durMs: Date.now() - startedAt });
    }, WARM_TIMEOUT_MS);
    startupMark('workspace_warm_start', metadata);

    const run = async () => {
      attempts += 1;
      try {
        await warmCwd(cwd, connectionId, controller.signal);
        if (controller.signal.aborted) return;
        clearTimeout(deadline);
        startupMark('workspace_warm_done', { ...metadata, attempts, durMs: Date.now() - startedAt });
      } catch (error) {
        if (controller.signal.aborted) return;
        startupMark('workspace_warm_attempt_failed', { ...metadata, attempts,
          error: error instanceof Error ? error.message : String(error) });
        if (!shouldRetryRequest(error) || attempts >= MAX_ATTEMPTS) {
          clearTimeout(deadline);
          startupMark('workspace_warm_gave_up', { ...metadata, attempts, durMs: Date.now() - startedAt });
          return;
        }
        retryTimer = setTimeout(() => void run(), requestRetryDelay(attempts));
      }
    };
    void run();
    return () => {
      controller.abort();
      clearTimeout(deadline);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [enabled, cwd, projectId, connectionId, runtime, model]);
}
