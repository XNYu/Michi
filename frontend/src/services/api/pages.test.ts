import { afterEach, describe, expect, it, vi } from 'vitest';
import { acknowledgePageActivity, changePageChange, createPage, fetchPageBatchState, fetchSpaces, listPageChanges, redoPageBatch, revertPageBatch } from './pages';

afterEach(() => { vi.unstubAllGlobals(); });

const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('Pages API', () => {
  it('follows every Spaces cursor', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ items: [{ id: 'space-1', workspaceId: 'workspace-1', parentId: null, contributorNodeIds: [] }], nextCursor: 'next page' }))
      .mockResolvedValueOnce(response({ items: [{ id: 'space-2', workspaceId: 'workspace-2', parentId: null, contributorNodeIds: [] }], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);

    const spaces = await fetchSpaces('remote');

    expect(spaces.map(({ id }) => id)).toEqual(['remote:remote:space-1', 'remote:remote:space-2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('cursor=next+page');
  });

  it('sends the closed create-page body and maps a remote parent reference', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ page: {
      id: 'page-1', workspaceId: 'workspace-1', parentId: null, position: 0, title: 'New', color: null,
      updatedAt: 1, updatedBy: 'user', pendingProposals: 0, helperNodeId: null,
    } }));
    vi.stubGlobal('fetch', fetchMock);

    await createPage({ workspaceId: 'remote:host:workspace-1', title: 'New', parentId: 'remote:host:parent-1', template: 'blank' }, {
      backendConnectionId: 'host', workspaceId: 'remote:host:workspace-1',
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ title: 'New', template: 'blank', parentId: 'parent-1' });
    expect(JSON.parse(init.body as string)).not.toHaveProperty('workspaceId');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/workspaces/workspace-1/pages');
  });

  it('acknowledges activity with the seq field the route expects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ lastSeenChangeSeq: 7 }));
    vi.stubGlobal('fetch', fetchMock);
    await acknowledgePageActivity('host:page-1', 7, { backendConnectionId: 'host', workspaceId: 'host:workspace-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/activity-seen');
    expect(JSON.parse(init.body as string)).toEqual({ lastSeenChangeSeq: 7 });
  });

  it('sends backward cursors and preserves the older-page cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ changes: [], nextAfter: null, nextBefore: 42, hasMore: true }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await listPageChanges('host:page-1', {
      backendConnectionId: 'host', workspaceId: 'host:workspace-1', direction: 'backward', beforeSeq: 90, limit: 100,
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain('direction=backward');
    expect(String(fetchMock.mock.calls[0][0])).toContain('beforeSeq=90');
    expect(result.nextBefore).toBe(42);
    expect(result.hasMore).toBe(true);
  });

  it('reads a batch revert answer as change ids and conflicts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ reverted: ['chg-1', 'chg-2'], conflicts: [{ changeId: 'chg-3', message: 'edited since' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await revertPageBatch('batch-1', { backendConnectionId: 'local', workspaceId: 'workspace-1' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/page-batches/batch-1/revert');
    expect(result).toEqual({ reverted: ['chg-1', 'chg-2'], conflicts: [{ changeId: 'chg-3', message: 'edited since' }] });
  });

  it('reads a batch redo answer as change ids and conflicts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ redone: ['chg-1'], conflicts: [{ changeId: 'chg-2', message: 'edited since' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await redoPageBatch('batch-1', { backendConnectionId: 'local', workspaceId: 'workspace-1' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/page-batches/batch-1/redo');
    expect(result).toEqual({ redone: ['chg-1'], conflicts: [{ changeId: 'chg-2', message: 'edited since' }] });
  });

  it('reads how much of a batch is applied or reverted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ batchId: 'batch-1', applied: 0, reverted: 3 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchPageBatchState('batch-1', { backendConnectionId: 'local', workspaceId: 'workspace-1' });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/page-batches\/batch-1$/);
    expect(result).toEqual({ applied: 0, reverted: 3 });
  });

  it('sends an edited block back with the backend\'s own ids for what it names', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ change: { id: 'chg-1', seq: 1, target: { kind: 'block', pageId: 'page-1', blockId: 'b1' }, source: { kind: 'user' } } }));
    vi.stubGlobal('fetch', fetchMock);
    await changePageChange('chg-1', 'accept', { backendConnectionId: 'host', workspaceId: 'remote:host:workspace-1' }, {
      editedContent: { kind: 'block', block: { type: 'threads', title: 'Sessions', nodeIds: ['remote:host:node-1'] } },
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ editedContent: { kind: 'block', block: { type: 'threads', title: 'Sessions', nodeIds: ['node-1'] } } });
  });
});
