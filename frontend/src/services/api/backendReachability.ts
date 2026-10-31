import { backendApiBase } from '../../config/backendConnections';
import { backendConnectionGeneration, backendConnectionUnavailable, markBackendConnectionUnavailable } from '../../config/backendConnectionState';

const checks = new Map<string, { generation: number; result: Promise<boolean> }>();

/** A failed request/stream must not evict every loaded chat on a healthy remote. */
export async function confirmBackendConnectionUnavailable(connectionId: string, signal?: AbortSignal | null,
  generation = backendConnectionGeneration(connectionId)): Promise<void> {
  if (connectionId === 'local' || signal?.aborted || backendConnectionUnavailable(connectionId)
    || generation !== backendConnectionGeneration(connectionId)) return;
  let check = checks.get(connectionId);
  if (!check || check.generation !== generation) {
    const result = (async () => {
      try {
        // A regular, bounded read avoids both the failed stream's socket and
        // recursive failure handling in backendFetch. Never replay the request.
        const response = await fetch(`${backendApiBase(connectionId)}/health`, {
          signal: AbortSignal.timeout(5_000), cache: 'no-store',
        });
        if (!response.ok) { await response.body?.cancel(); return false; }
        const body = await response.json();
        return body?.service === 'michi-backend' && body?.status === 'healthy';
      } catch { return false; }
    })();
    check = { generation, result };
    checks.set(connectionId, check);
    const current = check;
    void result.finally(() => { if (checks.get(connectionId) === current) checks.delete(connectionId); });
  }
  if (!await check.result && !signal?.aborted && generation === backendConnectionGeneration(connectionId)) {
    markBackendConnectionUnavailable(connectionId);
  }
}
