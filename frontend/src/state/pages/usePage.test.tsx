import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePage } from './usePage';
import { notifyPageChanged } from './pageEvents';

const api = vi.hoisted(() => ({
  acknowledgePageActivity: vi.fn(),
  changePageChange: vi.fn(),
  editPage: vi.fn(),
  fetchPage: vi.fn(),
  fetchPageActivitySeen: vi.fn(),
  listPageChanges: vi.fn(),
}));

vi.mock('../../services/api/pages', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/api/pages')>(),
  ...api,
}));

afterEach(() => vi.clearAllMocks());

describe('usePage activity acknowledgement', () => {
  it('keeps committed milestones while refreshing and rejects older reads and 304s below the receipt version', async () => {
    const identity = { backendConnectionId: 'local', workspaceId: 'live-version', pageId: 'live-version-page' };
    const page = { id: identity.pageId, workspaceId: identity.workspaceId, revision: 1, viewVersion: 1, blocks: [] };
    api.fetchPage.mockReset().mockResolvedValue(page);
    api.listPageChanges.mockResolvedValue({ changes: [], nextAfter: 0, nextBefore: null, hasMore: false });
    api.fetchPageActivitySeen.mockResolvedValue({ lastSeenChangeSeq: 0 });
    const { result } = renderHook(() => usePage(identity));
    await waitFor(() => expect(result.current.page?.viewVersion).toBe(1));
    let resolveA!: (value: typeof page) => void;
    api.fetchPage.mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }));
    act(() => notifyPageChanged({ ...identity, viewVersion: 2 }));
    expect(result.current.page?.viewVersion).toBe(1);
    expect(result.current.status).toBe('ready');
    await act(async () => resolveA({ ...page, revision: 2, viewVersion: 2 }));
    expect(result.current.page?.viewVersion).toBe(2);
    api.fetchPage.mockResolvedValueOnce(null).mockResolvedValueOnce(page).mockResolvedValueOnce({ ...page, revision: 3, viewVersion: 3 });
    act(() => notifyPageChanged({ ...identity, viewVersion: 3 }));
    await waitFor(() => expect(result.current.page?.viewVersion).toBe(3));
    expect(api.fetchPage).toHaveBeenLastCalledWith(identity.pageId, { backendConnectionId: 'local', workspaceId: identity.workspaceId });
    api.fetchPage.mockRejectedValueOnce(new Error('offline'));
    act(() => notifyPageChanged({ ...identity, viewVersion: 4 }));
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.page?.viewVersion).toBe(3);
    expect(result.current.status).toBe('ready');
  });

  it('retains an already current cached page without retrying an obsolete response', async () => {
    const identity = { backendConnectionId: 'local', workspaceId: 'current-cache', pageId: 'current-cache-page' };
    const page = { id: identity.pageId, workspaceId: identity.workspaceId, revision: 2, viewVersion: 2, blocks: [] };
    api.fetchPage.mockReset().mockResolvedValue(page);
    api.listPageChanges.mockResolvedValue({ changes: [], nextAfter: 0, nextBefore: null, hasMore: false });
    api.fetchPageActivitySeen.mockResolvedValue({ lastSeenChangeSeq: 0 });
    const { result } = renderHook(() => usePage(identity));
    await waitFor(() => expect(result.current.page?.viewVersion).toBe(2));
    api.fetchPage.mockResolvedValueOnce({ ...page, revision: 1, viewVersion: 1 });
    await act(async () => notifyPageChanged({ ...identity, viewVersion: 2 }));
    expect(result.current.page?.viewVersion).toBe(2);
    expect(result.current.stale).toBe(false);
    expect(result.current.error).toBeNull();
    expect(api.fetchPage).toHaveBeenCalledTimes(2);
  });

  it('ignores a delayed acknowledgement after navigating to another page', async () => {
    let resolveAck!: (result: { lastSeenChangeSeq: number }) => void;
    api.acknowledgePageActivity.mockImplementation(() => new Promise((resolve) => { resolveAck = resolve; }));
    api.fetchPage.mockResolvedValue(null);
    api.listPageChanges.mockResolvedValue({ changes: [], nextAfter: 0, nextBefore: null, hasMore: false });
    api.fetchPageActivitySeen.mockImplementation(async (pageId: string) => ({ lastSeenChangeSeq: pageId === 'page-a' ? 2 : 8 }));

    const { result, rerender } = renderHook(
      ({ pageId }: { pageId: string }) => usePage({ backendConnectionId: 'local', workspaceId: 'workspace', pageId }),
      { initialProps: { pageId: 'page-a' } },
    );
    await waitFor(() => expect(result.current.lastSeenChangeSeq).toBe(2));

    let ack!: Promise<void>;
    act(() => { ack = result.current.acknowledgeThrough(3); });
    rerender({ pageId: 'page-b' });
    await waitFor(() => expect(result.current.lastSeenChangeSeq).toBe(8));

    await act(async () => {
      resolveAck({ lastSeenChangeSeq: 3 });
      await ack;
    });

    expect(result.current.lastSeenChangeSeq).toBe(8);
  });

  it('does not update the activity cursor after the hook unmounts', async () => {
    let resolveAck!: (result: { lastSeenChangeSeq: number }) => void;
    api.acknowledgePageActivity.mockImplementation(() => new Promise((resolve) => { resolveAck = resolve; }));
    api.fetchPage.mockResolvedValue(null);
    api.listPageChanges.mockResolvedValue({ changes: [], nextAfter: 0, nextBefore: null, hasMore: false });
    api.fetchPageActivitySeen.mockResolvedValue({ lastSeenChangeSeq: 2 });

    const { result, unmount } = renderHook(() => usePage({
      backendConnectionId: 'local', workspaceId: 'workspace', pageId: 'page-a',
    }));
    await waitFor(() => expect(result.current.lastSeenChangeSeq).toBe(2));
    let ack!: Promise<void>;
    act(() => { ack = result.current.acknowledgeThrough(3); });
    unmount();

    await act(async () => {
      resolveAck({ lastSeenChangeSeq: 3 });
      await ack;
    });
    expect(result.current.lastSeenChangeSeq).toBe(2);
  });

  it('loads the newest bounded activity first and pages backward to older changes', async () => {
    const newest = { id: 'newest', seq: 90 } as never;
    const older = { id: 'older', seq: 40 } as never;
    api.fetchPage.mockResolvedValue(null);
    api.listPageChanges
      .mockResolvedValueOnce({ changes: [newest], nextAfter: 0, nextBefore: 90, hasMore: true })
      .mockResolvedValueOnce({ changes: [older], nextAfter: 0, nextBefore: 40, hasMore: false });
    api.fetchPageActivitySeen.mockResolvedValue({ lastSeenChangeSeq: 0 });
    const { result } = renderHook(() => usePage({ backendConnectionId: 'local', workspaceId: 'workspace', pageId: 'page-a' }));
    await waitFor(() => expect(result.current.changes.map((change) => change.id)).toEqual(['newest']));
    expect(api.listPageChanges).toHaveBeenNthCalledWith(1, 'page-a', expect.objectContaining({ direction: 'backward', limit: 100 }));
    await act(async () => { await result.current.loadMoreChanges(); });
    expect(result.current.changes.map((change) => change.id)).toEqual(['older', 'newest']);
    expect(api.listPageChanges).toHaveBeenNthCalledWith(2, 'page-a', expect.objectContaining({ direction: 'backward', beforeSeq: 90, limit: 100 }));
  });

  it('keeps the cursor at the newest window floor so a burst over 100 changes remains pageable', async () => {
    const old = { id: 'old', seq: 100 } as never;
    const middle = { id: 'middle', seq: 200 } as never;
    const newest = { id: 'newest', seq: 300 } as never;
    api.fetchPage.mockResolvedValue(null);
    api.listPageChanges
      .mockResolvedValueOnce({ changes: [old], nextAfter: 0, nextBefore: 100, hasMore: false })
      .mockResolvedValueOnce({ changes: [newest], nextAfter: 0, nextBefore: 300, hasMore: true })
      .mockResolvedValueOnce({ changes: [middle], nextAfter: 0, nextBefore: 200, hasMore: true })
      .mockResolvedValueOnce({ changes: [newest], nextAfter: 0, nextBefore: 300, hasMore: true })
      .mockResolvedValueOnce({ changes: [old], nextAfter: 0, nextBefore: 100, hasMore: false });
    api.fetchPageActivitySeen.mockResolvedValue({ lastSeenChangeSeq: 0 });
    const { result } = renderHook(() => usePage({ backendConnectionId: 'local', workspaceId: 'workspace', pageId: 'page-a' }));
    await waitFor(() => expect(result.current.changes.map((change) => change.id)).toEqual(['old']));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.changes.map((change) => change.id)).toEqual(['old', 'newest']);
    await act(async () => { await result.current.loadMoreChanges(); });
    expect(result.current.changes.map((change) => change.id)).toEqual(['old', 'middle', 'newest']);
    expect(api.listPageChanges).toHaveBeenLastCalledWith('page-a', expect.objectContaining({ direction: 'backward', beforeSeq: 300, limit: 100 }));
    await act(async () => { await result.current.refresh(); });
    await act(async () => { await result.current.loadMoreChanges(); });
    expect(api.listPageChanges).toHaveBeenLastCalledWith('page-a', expect.objectContaining({ direction: 'backward', beforeSeq: 200, limit: 100 }));
  });

  it('keeps older history exhausted across a poll even when the latest window has older entries', async () => {
    const oldest = { id: 'oldest', seq: 10 } as never;
    const middle = { id: 'middle', seq: 20 } as never;
    const newest = { id: 'newest', seq: 30 } as never;
    api.fetchPage.mockResolvedValue(null);
    api.listPageChanges
      .mockResolvedValueOnce({ changes: [newest], nextAfter: 0, nextBefore: 30, hasMore: true })
      .mockResolvedValueOnce({ changes: [middle], nextAfter: 0, nextBefore: 20, hasMore: true })
      .mockResolvedValueOnce({ changes: [oldest], nextAfter: 0, nextBefore: null, hasMore: false })
      .mockResolvedValueOnce({ changes: [newest], nextAfter: 0, nextBefore: 30, hasMore: true });
    api.fetchPageActivitySeen.mockResolvedValue({ lastSeenChangeSeq: 0 });
    const { result } = renderHook(() => usePage({ backendConnectionId: 'local', workspaceId: 'workspace', pageId: 'page-a' }));
    await waitFor(() => expect(result.current.changes.map((change) => change.id)).toEqual(['newest']));
    await act(async () => { await result.current.loadMoreChanges(); });
    await act(async () => { await result.current.loadMoreChanges(); });
    expect(result.current.hasMoreChanges).toBe(false);
    await act(async () => { await result.current.refresh(); });
    expect(result.current.hasMoreChanges).toBe(false);
    await act(async () => { await result.current.loadMoreChanges(); });
    expect(api.listPageChanges).toHaveBeenCalledTimes(4);
  });

  it('shows lifecycle conflicts through the page error state without leaking a rejection', async () => {
    const page = { id: 'page-a', workspaceId: 'workspace', revision: 1, viewVersion: 1, blocks: [] };
    api.fetchPage.mockResolvedValue(page);
    api.listPageChanges.mockResolvedValue({ changes: [], nextAfter: 0, nextBefore: null, hasMore: false });
    api.fetchPageActivitySeen.mockResolvedValue({ lastSeenChangeSeq: 0 });
    api.changePageChange.mockRejectedValue(Object.assign(new Error('409 proposal_stale'), { status: 409 }));
    const { result } = renderHook(() => usePage({ backendConnectionId: 'local', workspaceId: 'workspace', pageId: 'page-a' }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.accept('change-1'); });
    expect(result.current.error).toBe('409 proposal_stale');
  });

  it('ignores a delayed lifecycle failure after navigating to another page', async () => {
    let rejectAction!: (error: Error) => void;
    api.fetchPage.mockResolvedValue({ id: 'page-a', workspaceId: 'workspace', revision: 1, viewVersion: 1, blocks: [] });
    api.listPageChanges.mockResolvedValue({ changes: [], nextAfter: 0, nextBefore: null, hasMore: false });
    api.fetchPageActivitySeen.mockResolvedValue({ lastSeenChangeSeq: 0 });
    api.changePageChange.mockImplementation(() => new Promise((_, reject) => { rejectAction = reject; }));
    const { result, rerender } = renderHook(({ pageId }: { pageId: string }) => usePage({
      backendConnectionId: 'local', workspaceId: 'workspace', pageId,
    }), { initialProps: { pageId: 'page-a' } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    let action!: Promise<void>;
    act(() => { action = result.current.accept('change-1'); });
    rerender({ pageId: 'page-b' });
    await act(async () => {
      rejectAction(new Error('old page failed'));
      await action;
    });
    expect(result.current.error).toBeNull();
  });

  it('keeps a confirmed page editable while refresh is pending and marks it stale on failure', async () => {
    const page = {
      id: 'page-cache-state', workspaceId: 'workspace-cache-state', parentId: null, position: 0,
      title: 'Confirmed', color: null, updatedAt: 1, updatedBy: 'user', pendingProposals: 0,
      helperNodeId: null, revision: 1, viewVersion: 1, blocks: [],
    };
    let resolveRefresh!: (value: typeof page) => void;
    api.fetchPage
      .mockResolvedValueOnce(page)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }))
      .mockResolvedValueOnce(page)
      .mockRejectedValueOnce(new Error('offline'));
    api.listPageChanges.mockResolvedValue({ changes: [], nextAfter: 0, nextBefore: null, hasMore: false });
    api.fetchPageActivitySeen.mockResolvedValue({ lastSeenChangeSeq: 0 });
    api.editPage.mockResolvedValue({
      page: { ...page, revision: 2 },
      changes: { resource: { kind: 'page', id: page.id }, revision: 2, applied: [], proposed: [], rejected: [] },
    });

    const { result } = renderHook(() => usePage({
      backendConnectionId: 'local', workspaceId: page.workspaceId, pageId: page.id,
    }));
    await waitFor(() => expect(result.current.page?.revision).toBe(1));

    act(() => result.current.refresh());
    expect(result.current.stale).toBe(false);
    await act(async () => { await result.current.edit([]); });
    expect(api.editPage).toHaveBeenCalledTimes(1);

    resolveRefresh(page);
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.stale).toBe(true));
    await expect(result.current.edit([])).rejects.toThrow('Page is not ready for editing');
  });
});
