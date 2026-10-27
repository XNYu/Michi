import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribePageChanges } from '../../../../state/pages/pageEvents';
import { mintPageComponentCapability, callPageComponentCapability, revokePageComponentCapability, type ComponentCapability } from '../../../../services/api/pageComponents';
import { useComponentCapability } from './useComponentCapability';

vi.mock('../../../../services/api/pageComponents', () => ({
  mintPageComponentCapability: vi.fn(),
  callPageComponentCapability: vi.fn(),
  revokePageComponentCapability: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

const input = (blockId = 'block-1') => ({
  connectionId: 'backend-1', workspaceId: 'workspace-1', componentId: 'component-1', version: 1,
  host: { kind: 'page_block' as const, pageId: 'page-1', blockId }, props: {}, enabled: true,
});
const mintResult = (capability: string, host: ComponentCapability['host']): ComponentCapability => ({
  capability, expiresAt: Date.now() + 120_000, host, version: 1, props: {},
});
const revokedCapability = () => Object.assign(new Error('Component capability was revoked'), { status: 404, code: 'not_found' });

describe('useComponentCapability', () => {
  it('ignores a mint that resolves after its host changes', async () => {
    let resolveOld!: (value: ComponentCapability) => void;
    vi.mocked(mintPageComponentCapability)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce(mintResult('new-cap', { kind: 'page_block', pageId: 'page-1', blockId: 'block-2' }));
    const { result, rerender } = renderHook(({ blockId }) => useComponentCapability(input(blockId)), { initialProps: { blockId: 'block-1' } });
    rerender({ blockId: 'block-2' });
    await waitFor(() => expect(result.current.state?.capability).toBe('new-cap'));
    resolveOld(mintResult('old-cap', { kind: 'page_block', pageId: 'page-1', blockId: 'block-1' }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.state?.capability).toBe('new-cap');
    expect(revokePageComponentCapability).toHaveBeenCalledWith('old-cap', 'backend-1');
  });

  it('mints a fresh capability after a confirmed revocation without replaying a failed write', async () => {
    const host = input().host;
    vi.mocked(mintPageComponentCapability)
      .mockResolvedValueOnce(mintResult('old-cap', host))
      .mockResolvedValueOnce(mintResult('new-cap', host));
    vi.mocked(callPageComponentCapability)
      .mockRejectedValueOnce(revokedCapability())
      .mockResolvedValueOnce({ applied: [{ id: 'r1' }], proposed: [], rejected: [] });
    const { result } = renderHook(() => useComponentCapability(input()));
    await waitFor(() => expect(result.current.state?.capability).toBe('old-cap'));
    await expect(result.current.call('write.rows', [[{ op: 'row.update', id: 'r1', patch: { title: 'once' } }]])).rejects.toThrow('Component capability was revoked');
    await waitFor(() => expect(result.current.state?.capability).toBe('new-cap'));
    expect(mintPageComponentCapability).toHaveBeenCalledTimes(2);
    expect(callPageComponentCapability).toHaveBeenCalledTimes(1);
    expect(callPageComponentCapability).toHaveBeenCalledWith('', 'old-cap', expect.objectContaining({ method: 'write.rows' }), 'backend-1');

    await act(async () => { await result.current.call('write.rows', [[{ op: 'row.update', id: 'r1', patch: { title: 'explicit retry' } }]]); });
    expect(callPageComponentCapability).toHaveBeenCalledTimes(2);
    expect(callPageComponentCapability).toHaveBeenLastCalledWith('', 'new-cap', expect.objectContaining({ method: 'write.rows' }), 'backend-1');
  });

  it('does not renew a revoked host capability after the missing source synchronously pauses its scope', async () => {
    vi.mocked(mintPageComponentCapability).mockResolvedValue(mintResult('old-cap', input().host));
    let rejectRead!: (error: Error) => void;
    vi.mocked(callPageComponentCapability).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    const { result } = renderHook(() => useComponentCapability(input()));
    await waitFor(() => expect(result.current.state?.capability).toBe('old-cap'));
    const inFlightRead = result.current.call('read.host', []).catch(error => error);

    act(() => result.current.pause());
    rejectRead(revokedCapability());
    await act(async () => { await inFlightRead; });

    expect(mintPageComponentCapability).toHaveBeenCalledTimes(1);
    expect(callPageComponentCapability).toHaveBeenCalledTimes(1);
    expect(revokePageComponentCapability).toHaveBeenCalledWith('old-cap', 'backend-1');
    expect(result.current.state?.capability).toBe('');
  });

  it('locally rejects a retained call closure invoked immediately after pause', async () => {
    vi.mocked(mintPageComponentCapability).mockResolvedValue(mintResult('old-cap', input().host));
    const { result } = renderHook(() => useComponentCapability(input()));
    await waitFor(() => expect(result.current.state?.capability).toBe('old-cap'));
    const oldCall = result.current.call;
    let pausedCall!: Promise<unknown>;

    act(() => {
      result.current.pause();
      pausedCall = oldCall('read.host', []);
    });

    await expect(pausedCall).rejects.toThrow('Component source unavailable');
    expect(mintPageComponentCapability).toHaveBeenCalledTimes(1);
    expect(callPageComponentCapability).not.toHaveBeenCalled();
    expect(revokePageComponentCapability).toHaveBeenCalledWith('old-cap', 'backend-1');
  });

  it('aborts a pending mint when its source scope is synchronously paused', async () => {
    let resolveMint!: (value: ComponentCapability) => void;
    let mintSignal: AbortSignal | undefined;
    vi.mocked(mintPageComponentCapability).mockImplementationOnce((_input, _connection, signal) => {
      mintSignal = signal;
      return new Promise(resolve => { resolveMint = resolve; });
    });
    const { result } = renderHook(() => useComponentCapability(input()));
    await waitFor(() => expect(mintPageComponentCapability).toHaveBeenCalledTimes(1));

    act(() => result.current.pause());
    expect(mintSignal?.aborted).toBe(true);
    resolveMint(mintResult('late-cap', input().host));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.state?.capability).toBe('');
    expect(mintPageComponentCapability).toHaveBeenCalledTimes(1);
    expect(revokePageComponentCapability).toHaveBeenCalledWith('late-cap', 'backend-1');
  });

  it('recovers after disable and re-enable on the same host while ignoring a late old-token 404', async () => {
    vi.mocked(mintPageComponentCapability)
      .mockResolvedValueOnce(mintResult('old-cap', input().host))
      .mockResolvedValueOnce(mintResult('reenabled-cap', input().host));
    vi.mocked(callPageComponentCapability).mockRejectedValueOnce(revokedCapability());
    const { result, rerender } = renderHook(({ enabled }) => useComponentCapability({ ...input(), enabled }), { initialProps: { enabled: true } });
    await waitFor(() => expect(result.current.state?.capability).toBe('old-cap'));
    const oldTokenCall = result.current.call;
    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.state?.capability).toBe('reenabled-cap'));
    await expect(oldTokenCall('read.host', [])).rejects.toThrow('Component capability was revoked');
    expect(result.current.state?.capability).toBe('reenabled-cap');
    expect(mintPageComponentCapability).toHaveBeenCalledTimes(2);
    expect(callPageComponentCapability).toHaveBeenCalledTimes(1);
  });

  it('does not let a late old-token failure clear or remint a newer host capability', async () => {
    let rejectOld!: (error: Error) => void;
    let resolveNewMint!: (value: ComponentCapability) => void;
    vi.mocked(mintPageComponentCapability)
      .mockResolvedValueOnce(mintResult('old-cap', input('block-1').host))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNewMint = resolve; }));
    vi.mocked(callPageComponentCapability).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    const { result, rerender } = renderHook(({ blockId }) => useComponentCapability(input(blockId)), { initialProps: { blockId: 'block-1' } });
    await waitFor(() => expect(result.current.state?.capability).toBe('old-cap'));
    const oldCall = result.current.call('read.host', []).catch(error => error);
    rerender({ blockId: 'block-2' });
    await waitFor(() => expect(mintPageComponentCapability).toHaveBeenCalledTimes(2));
    rejectOld(revokedCapability());
    await act(async () => { await oldCall; });
    resolveNewMint(mintResult('new-host-cap', input('block-2').host));
    await waitFor(() => expect(result.current.state?.capability).toBe('new-host-cap'));
    expect(result.current.state?.capability).toBe('new-host-cap');
    expect(mintPageComponentCapability).toHaveBeenCalledTimes(2);
  });

  it('renews before expiry without clearing the current capability and invalidates after a successful row write', async () => {
    vi.useFakeTimers();
    vi.mocked(mintPageComponentCapability)
      .mockResolvedValueOnce(mintResult('cap-1', { kind: 'database_view', databaseId: 'database-1', viewId: 'view-1' }))
      .mockResolvedValueOnce(mintResult('cap-2', { kind: 'database_view', databaseId: 'database-1', viewId: 'view-1' }));
    vi.mocked(callPageComponentCapability).mockResolvedValue({ applied: [{ id: 'r1' }], proposed: [], rejected: [] });
    let changeCount = 0;
    const unsubscribe = subscribePageChanges({ backendConnectionId: 'backend-1', workspaceId: 'workspace-1', databaseId: 'database-1' }, () => { changeCount++; });
    const databaseInput = { ...input(), host: { kind: 'database_view' as const, databaseId: 'database-1', viewId: 'view-1' } };
    const { result } = renderHook(() => useComponentCapability(databaseInput));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.state?.capability).toBe('cap-1');
    await act(async () => { await result.current.call('write.rows', [[{ op: 'row.update', id: 'r1', patch: { title: 'changed' } }]]); });
    expect(changeCount).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(100_001); });
    expect(result.current.state?.capability).toBe('cap-2');
    expect(mintPageComponentCapability).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('maps only structural database/page references for a remote host', async () => {
    vi.mocked(mintPageComponentCapability).mockResolvedValue(mintResult('remote-cap', {
      kind: 'page_block', pageId: 'remote:remote-1:page-server', blockId: 'block:opaque',
    }));
    vi.mocked(callPageComponentCapability).mockResolvedValue({ pageId: 'page-server' });
    const remoteInput = {
      connectionId: 'remote-1', workspaceId: 'remote:remote-1:workspace-server', componentId: 'remote:remote-1:component-server',
      version: 1, host: { kind: 'page_block' as const, pageId: 'remote:remote-1:page-server', blockId: 'block:opaque' },
      props: {}, enabled: true,
    };
    const { result } = renderHook(() => useComponentCapability(remoteInput));
    await waitFor(() => expect(result.current.state?.capability).toBe('remote-cap'));
    vi.mocked(callPageComponentCapability).mockResolvedValueOnce({ databaseId: 'database-server' });
    await act(async () => { await result.current.call('read.database', ['remote:remote-1:database-server']); });
    expect(callPageComponentCapability).toHaveBeenLastCalledWith('', 'remote-cap', { method: 'read.database', resourceId: 'database-server', args: [] }, 'remote-1');
    const navigation = await result.current.call('navigate.page', ['remote:remote-1:target-page']);
    expect(callPageComponentCapability).toHaveBeenLastCalledWith('', 'remote-cap', { method: 'navigate.page', args: ['target-page'] }, 'remote-1');
    expect(navigation).toEqual({ pageId: 'remote:remote-1:page-server' });
  });

  it('maps an explicit read.database ID for remote database-view hosts too', async () => {
    vi.mocked(mintPageComponentCapability).mockResolvedValue(mintResult('db-cap', {
      kind: 'database_view', databaseId: 'remote:remote-1:database-server', viewId: 'view:opaque',
    }));
    vi.mocked(callPageComponentCapability).mockResolvedValue({ id: 'database-server', rows: [] });
    const remoteInput = {
      connectionId: 'remote-1', workspaceId: 'remote:remote-1:workspace-server', componentId: 'remote:remote-1:component-server',
      version: 1, host: { kind: 'database_view' as const, databaseId: 'remote:remote-1:database-server', viewId: 'view:opaque' },
      props: {}, enabled: true,
    };
    const { result } = renderHook(() => useComponentCapability(remoteInput));
    await waitFor(() => expect(result.current.state?.capability).toBe('db-cap'));
    await act(async () => { await result.current.call('read.database', ['remote:remote-1:database-server']); });
    expect(callPageComponentCapability).toHaveBeenCalledWith('', 'db-cap', { method: 'read.database', resourceId: 'database-server', args: [] }, 'remote-1');
  });
});
