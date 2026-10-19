import { useEffect } from 'react';
import { fetchRemoteServiceRecoveries } from '../services/api/remoteRecovery';
import { getKnownBackendConnections } from '../config/backendConnections';
import { clearRemoteRecoveryIssue, reportRemoteRecoveryProgress, reportRemoteRecoveryFailure, retryRemoteWorkspace } from '../state/remoteRecovery';
import { fetchAllWorkspacesMeta } from '../services/api/persistence';
import { completeRemoteAuthentication, requestRemoteAuthentication } from '../state/remoteAuthentication';

/** Gateway-owned recovery also covers failures after initial hydration. */
export function RemoteServiceRecoveryMonitor() {
  useEffect(() => {
    const controller = new AbortController();
    const seen = new Map<string, string>();
    let timer: ReturnType<typeof setTimeout>;
    let unavailable = false;
    const poll = async () => {
      try {
        const statuses = await fetchRemoteServiceRecoveries(AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]));
        if (controller.signal.aborted) return;
        unavailable = false;
        for (const status of statuses) {
          const connection = getKnownBackendConnections().find(item => item.id === status.connectionId);
          if (!connection) continue;
          const signature = JSON.stringify([status.phase, status.message, status.diagnostic?.id, status.diagnostic?.stage,
            status.diagnostic?.log?.length, status.diagnostic?.log?.slice(-128), status.diagnostic?.storageError]);
          if (seen.get(status.connectionId) === signature) continue;
          seen.set(status.connectionId, signature);
          if (status.phase === 'ready') {
            completeRemoteAuthentication(`service:${connection.id}`);
            // A failure after startup has no hydration retry loop left. Confirm
            // readability here without reinstalling metadata over live drafts.
            try {
              await fetchAllWorkspacesMeta(connection.id, AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]));
              if (controller.signal.aborted) return;
              clearRemoteRecoveryIssue(connection.id);
            } catch (error) {
              if (controller.signal.aborted) return;
              reportRemoteRecoveryFailure(connection, error);
              seen.delete(connection.id);
            }
            retryRemoteWorkspace(status.connectionId);
          } else {
            if (status.phase === 'starting') reportRemoteRecoveryProgress(connection, status.message, status.diagnostic);
            else reportRemoteRecoveryFailure(connection, new Error(status.message), status.diagnostic);
            if (status.authentication) requestRemoteAuthentication({ key: `service:${connection.id}`, connectionId: connection.id, target: status.authentication });
          }
        }
      } catch { unavailable = true; /* Older gateways may not support recovery. */ }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, unavailable ? 15_000 : 2500); }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  return null;
}
