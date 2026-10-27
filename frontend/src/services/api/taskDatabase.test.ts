import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageChangeDto } from 'michi-shared';
import { fetchAllTasks, fetchTaskActivity, fetchTaskDatabaseId, fetchTaskOrigin, openTaskDatabase, saveAllTasksViews } from './taskDatabase';

afterEach(() => { vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('task database API', () => {
  it('reads and opens the task database of a remote workspace with server ids', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ databaseId: null }))
      .mockResolvedValueOnce(json({ database: { id: 'db-1', workspaceId: 'ws-1', title: 'Tasks', role: 'tasks', columns: [], views: [], rows: [], revision: 1, updatedAt: 1 }, created: true }, 201))
      .mockResolvedValueOnce(json({ databaseId: 'db-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const options = { backendConnectionId: 'host', workspaceId: 'remote:host:ws-1' };
    expect(await fetchTaskDatabaseId(options)).toBeNull();
    const opened = await openTaskDatabase(options);
    expect(await fetchTaskDatabaseId(options)).toBe('remote:host:db-1');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/workspaces/ws-1/task-database');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{}' });
    expect(opened).toMatchObject({ created: true, database: { id: 'remote:host:db-1', workspaceId: 'remote:host:ws-1', role: 'tasks' } });
  });

  it('says why when the backend refuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: { code: 'invalid', message: 'Archived workspace is read-only' } }, 409)));
    await expect(openTaskDatabase({ backendConnectionId: 'local', workspaceId: 'ws' })).rejects.toMatchObject({ status: 409, message: 'Archived workspace is read-only' });
  });

  it("reads a task database's activity and a task's origin, with this backend's ids", async () => {
    const suggestion: PageChangeDto = {
      id: 'chg-1', seq: 4, batchId: 'batch-1', target: { kind: 'row', databaseId: 'db-1', rowId: 'r1', columnIds: ['status'] }, op: 'row',
      before: null, after: null,
      forward: { kind: 'row', op: 'patch', id: 'r1', values: { status: 'done' } },
      inverse: { kind: 'row', op: 'patch', id: 'r1', values: { status: 'doing' } },
      baseRev: 2, appliedRev: null, previousHeadId: null,
      source: { kind: 'maintenance', nodeId: 'run', turnId: 'run-turn', assistantId: 'run-a', jobId: 'job', runId: 'run-1', evidence: [{ nodeId: 'n1', turnId: 't1', assistantId: 'a1' }] },
      proposalState: 'pending', applicationState: null, createdAt: 5, resolvedAt: null,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ suggestions: [suggestion], marks: [{ rowId: 'r1', kind: 'new', at: 5 }],
        latestUpkeep: { batchId: 'batch-1', at: 5, added: 1, updated: 0, removed: 0, suggested: 1, source: { nodeId: 'n1', turnId: 't1', assistantId: 'a1', title: 'Release check' } } }))
      .mockResolvedValueOnce(json({ origin: { by: 'meta-agent', conversations: 2, at: 3 } }));
    vi.stubGlobal('fetch', fetchMock);
    const options = { backendConnectionId: 'host', workspaceId: 'remote:host:ws-1', databaseId: 'remote:host:db-1' };
    const activity = await fetchTaskActivity(options);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/databases/db-1/task-activity');
    expect(activity.marks).toEqual([{ rowId: 'r1', kind: 'new', at: 5 }]);
    expect(activity.suggestions[0]!.target).toEqual({ kind: 'row', databaseId: 'remote:host:db-1', rowId: 'r1', columnIds: ['status'] });
    expect(activity.latestUpkeep?.source?.nodeId).toBe('remote:host:n1');
    expect(await fetchTaskOrigin({ ...options, rowId: 'r1' })).toEqual({ by: 'meta-agent', conversations: 2, at: 3 });
    expect(String(fetchMock.mock.calls[1][0])).toContain('/databases/db-1/rows/r1/origin');
  });

  it('reads All tasks and saves its views on this computer', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ sources: [], rows: [], views: [], viewsRevision: 0 }))
      .mockResolvedValueOnce(json({ views: [], viewsRevision: 1 }))
      .mockResolvedValueOnce(json({ error: { code: 'stale_revision', message: 'All tasks views changed' } }, 409));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchAllTasks()).toEqual({ sources: [], rows: [], views: [], viewsRevision: 0 });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/spaces-home/all-tasks');
    const ops = [{ op: 'view.delete' as const, id: 'tasks-table' }];
    expect(await saveAllTasksViews({ revision: 0, ops })).toEqual({ views: [], viewsRevision: 1 });
    expect(String(fetchMock.mock.calls[1][0])).toContain('/spaces-home/all-tasks/views');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ revision: 0, ops }) });
    await expect(saveAllTasksViews({ revision: 0, ops })).rejects.toMatchObject({ status: 409, message: 'All tasks views changed' });
  });
});
