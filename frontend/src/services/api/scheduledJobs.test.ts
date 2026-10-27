import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendApiBase, setActiveBackendConnectionId } from '../../config/backendConnections';
import { confirmScheduledExecutionStopped } from './scheduledJobs';

afterEach(() => { vi.unstubAllGlobals(); setActiveBackendConnectionId(undefined); });

describe('scheduled execution recovery API', () => {
  it('confirms a stopped execution on the local backend while a remote workspace is active', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ released: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    setActiveBackendConnectionId('remote-active');
    await expect(confirmScheduledExecutionStopped('run/old')).resolves.toEqual({ released: true });
    expect(fetch).toHaveBeenCalledWith(`${backendApiBase()}/scheduled-jobs/executions/run%2Fold/confirm-stopped`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ executionStopped: true }),
    });
  });

  it('retains the server conflict explanation for an execution whose old process is still running', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Stop the previous Michi process and its agent before confirming.' }), { status: 409 })));
    await expect(confirmScheduledExecutionStopped('run')).rejects.toThrow('Stop the previous Michi process and its agent before confirming.');
  });
});
