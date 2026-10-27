import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchState = vi.hoisted(() => ({ fetch: vi.fn(), read: vi.fn() }));
vi.mock('./pages', () => ({ pagesFetch: fetchState.fetch, readPagesJson: fetchState.read }));

import { fetchMetaAgentRound, getPageMaintenance, queuePageMaintenanceCatchUp, runMetaAgentRoundNow, setPageMaintenanceSpaceExcluded } from './pageMaintenance';

describe('page maintenance API', () => {
  beforeEach(() => {
    fetchState.fetch.mockReset();
    fetchState.read.mockReset();
  });

  it('keeps the backend and workspace explicit and maps returned entity identities', async () => {
    const response = { ok: true, status: 200 } as Response;
    fetchState.fetch.mockResolvedValue(response);
    fetchState.read.mockResolvedValue({
      config: { workspaceId: 'workspace', ownerUserId: 'owner', jobId: 'job', enabled: true, paused: false, revision: 1, completionCursor: 3, runtimeId: null, providerId: null, modelId: null, reasoning: null, updatedAt: 1 },
      status: { completionCounter: 3, lastRun: null, pendingSources: 0, attentionSources: 0 },
      backlog: { plans: [], pendingSources: 0, attentionSources: 0 },
      job: { id: 'job', workspaceId: 'workspace', persistentNodeId: null, activeRunId: null },
      scheduler: 'available', excludedSpaceIds: ['space'],
      catchUpSuggestions: [{ periodId: 'period-1', spaceId: 'space', after: 1, through: 4, maxPositions: 1000, availablePositions: 3, excludedAt: 10, reenabledAt: 20, sourceCount: 1, latestSources: [{ turnId: 'turn-1', completionSeq: 3, completedAt: 15, preview: 'A recent source' }] }],
    });

    const result = await getPageMaintenance({ backendConnectionId: 'remote-a', workspaceId: 'remote:remote-a:workspace' });
    expect(fetchState.fetch.mock.calls[0][0]).toContain('/backend-connections/remote-a/proxy/workspaces/workspace/maintenance');
    expect(result.config?.workspaceId).toBe('remote:remote-a:workspace');
    expect(result.job?.id).toBe('remote:remote-a:job');
    expect(result.excludedSpaceIds).toEqual(['remote:remote-a:space']);
    expect(result.catchUpSuggestions?.[0]).toMatchObject({ periodId: 'period-1', spaceId: 'remote:remote-a:space', latestSources: [{ turnId: 'turn-1' }] });
  });

  it('sends revision-checked exclusion changes to the workspace-owned route', async () => {
    const response = { ok: true, status: 200 } as Response;
    fetchState.fetch.mockResolvedValue(response);
    fetchState.read.mockResolvedValue({ config: null, status: null, backlog: { plans: [], pendingSources: 0, attentionSources: 0 }, job: null, scheduler: 'available', excludedSpaceIds: ['space'] });

    await setPageMaintenanceSpaceExcluded('space', true, 0, { backendConnectionId: 'local', workspaceId: 'workspace' });
    expect(fetchState.fetch.mock.calls[0][0]).toContain('/workspaces/workspace/spaces/space/maintenance');
    expect(fetchState.fetch.mock.calls[0][1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ expectedRevision: 0, excluded: true }) });
  });

  it('queues an explicit bounded catch-up for one selected Space', async () => {
    const response = { ok: true, status: 200 } as Response;
    fetchState.fetch.mockResolvedValue(response);
    fetchState.read.mockResolvedValueOnce({
      config: { workspaceId: 'workspace', ownerUserId: 'owner', jobId: 'job', enabled: true, paused: false, revision: 8, completionCursor: 20, runtimeId: 'claude', providerId: null, modelId: null, reasoning: null, updatedAt: 1 },
      status: { completionCounter: 20, lastRun: null, pendingSources: 0, attentionSources: 0 },
      backlog: { plans: [], pendingSources: 0, attentionSources: 0 }, job: null, scheduler: 'available', excludedSpaceIds: [],
      catchUpSuggestions: [{ periodId: 'period-1', spaceId: 'space', after: 10, through: 20, maxPositions: 1000, availablePositions: 10, excludedAt: 1, reenabledAt: 2, sourceCount: 1, latestSources: [{ turnId: 'turn-1', completionSeq: 20, completedAt: 2, preview: 'missed turn' }] }],
    }).mockResolvedValueOnce({ requestId: 'catchup-1', after: 10, through: 20, queued: true });

    const result = await queuePageMaintenanceCatchUp('space', 10, 20, { backendConnectionId: 'local', workspaceId: 'workspace' });
    expect(result).toMatchObject({ requestId: 'catchup-1', after: 10, through: 20, queued: true });
    expect(fetchState.fetch.mock.calls[1][0]).toContain('/workspaces/workspace/maintenance/catch-up');
    expect(fetchState.fetch.mock.calls[1][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ expectedRevision: 8, spaceId: 'space', after: 10, through: 20 }) });
  });

  it('asks the connection’s own backend for a Meta agent round and maps its workspaces and runs', async () => {
    fetchState.fetch.mockResolvedValue({ ok: true, status: 200 } as Response);
    fetchState.read.mockResolvedValueOnce({ workspaces: [
      { workspaceId: 'workspace', workspaceName: 'W', outcome: 'started', runId: 'run-1', cursor: 3, unread: 2 },
      { workspaceId: 'other', workspaceName: 'O', outcome: 'started', runId: null, reason: 'Starts when a run slot frees up', cursor: 1, unread: 1 },
    ] }).mockResolvedValueOnce({ workspaces: [{ workspaceId: 'workspace', cursor: 5, unread: 0, running: false }] });

    const result = await runMetaAgentRoundNow('remote-a');
    expect(fetchState.fetch.mock.calls[0][0]).toContain('/backend-connections/remote-a/proxy/meta-agent/run-now');
    expect(fetchState.fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{}' });
    expect(result.workspaces.map((row) => [row.workspaceId, row.runId])).toEqual([['remote:remote-a:workspace', 'remote:remote-a:run-1'], ['remote:remote-a:other', null]]);
    const status = await fetchMetaAgentRound('remote-a');
    expect(fetchState.fetch.mock.calls[1][0]).toContain('/backend-connections/remote-a/proxy/meta-agent/run-now');
    expect(status.workspaces[0].workspaceId).toBe('remote:remote-a:workspace');
  });
});
