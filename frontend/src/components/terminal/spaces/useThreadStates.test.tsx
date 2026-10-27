import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ThreadCardItem } from 'michi-shared';
import { fetchThreadStates } from '../../../services/api/spacesHome';
import { useThreadStates } from './useThreadStates';

vi.mock('../../../services/api/spacesHome', () => ({ fetchThreadStates: vi.fn() }));

const card = (nodeId: string, state: ThreadCardItem['state']): ThreadCardItem =>
  ({ nodeId, workspaceId: 'ws', title: nodeId, state, summary: '', at: 1, messageId: null });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

afterEach(() => { vi.useRealTimers(); vi.mocked(fetchThreadStates).mockReset(); });

describe('useThreadStates', () => {
  it('reads each id once in one request, again every minute and on focus, and keeps the last answer when a read fails', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchThreadStates)
      .mockResolvedValueOnce([card('n1', 'waiting')])
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([card('n1', 'done')]);
    const { result } = renderHook(({ ids }) => useThreadStates('local', ids), { initialProps: { ids: ['n1', 'n1'] } });
    await flush();
    expect(fetchThreadStates).toHaveBeenCalledWith('local', { nodeIds: ['n1'], signal: expect.any(AbortSignal) });
    expect(result.current.byNode.get('n1')?.state).toBe('waiting');
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await flush();
    expect(result.current).toMatchObject({ loaded: true, failed: true });
    expect(result.current.byNode.get('n1')?.state).toBe('waiting');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await flush();
    expect(result.current.byNode.get('n1')?.state).toBe('done');
    expect(result.current.failed).toBe(false);
  });

  it('keys the answers by the ids the cells hold, also for a remote backend', async () => {
    vi.mocked(fetchThreadStates).mockResolvedValue([{ ...card('remote:host:n1', 'running'), workspaceId: 'remote:host:ws' }]);
    const { result } = renderHook(() => useThreadStates('host', ['n1']));
    await flush();
    expect(result.current.byNode.get('n1')?.state).toBe('running');
  });

  it('reads nothing without ids or while turned off', async () => {
    const { result, rerender } = renderHook(({ ids, on }) => useThreadStates('local', ids, on), { initialProps: { ids: [] as string[], on: true } });
    await flush();
    expect(result.current.loaded).toBe(true);
    rerender({ ids: ['n1'], on: false });
    await flush();
    expect(fetchThreadStates).not.toHaveBeenCalled();
  });

  it('does not call an id gone before a read has covered it, while still showing the earlier answer', async () => {
    let finishSecond: (items: ThreadCardItem[]) => void = () => {};
    vi.mocked(fetchThreadStates)
      .mockResolvedValueOnce([card('n1', 'waiting')])
      .mockReturnValueOnce(new Promise((resolve) => { finishSecond = resolve; }));
    const { result, rerender } = renderHook(({ ids }) => useThreadStates('local', ids), { initialProps: { ids: ['n1'] } });
    await flush();
    expect(result.current.loaded).toBe(true);
    rerender({ ids: ['n1', 'n2'] });
    await flush();
    expect(result.current.loaded).toBe(false);
    expect(result.current.byNode.get('n1')?.state).toBe('waiting');
    expect(result.current.byNode.has('n2')).toBe(false);
    await act(async () => { finishSecond([card('n1', 'waiting'), card('n2', 'done')]); });
    await flush();
    expect(result.current.loaded).toBe(true);
    expect(result.current.byNode.get('n2')?.state).toBe('done');
  });

  it('stays unloaded for a new id set whose read fails', async () => {
    vi.mocked(fetchThreadStates).mockResolvedValueOnce([card('n1', 'waiting')]).mockRejectedValueOnce(new Error('offline'));
    const { result, rerender } = renderHook(({ ids }) => useThreadStates('local', ids), { initialProps: { ids: ['n1'] } });
    await flush();
    rerender({ ids: ['n1', 'n2'] });
    await flush();
    expect(result.current).toMatchObject({ loaded: false, failed: true });
  });

  it('reads more than 500 ids in several requests and merges the answers', async () => {
    const ids = Array.from({ length: 1001 }, (_, index) => `n${String(index).padStart(4, '0')}`);
    vi.mocked(fetchThreadStates).mockImplementation(async (_connection, { nodeIds }) => nodeIds.map((id) => card(id, 'done')));
    const { result } = renderHook(() => useThreadStates('local', ids));
    await flush();
    const sizes = vi.mocked(fetchThreadStates).mock.calls.map(([, options]) => options.nodeIds.length);
    expect(sizes).toEqual([500, 500, 1]);
    expect(result.current.loaded).toBe(true);
    expect(result.current.byNode.size).toBe(1001);
    expect(result.current.byNode.has('n1000')).toBe(true);
  });

  it('ignores a read that resolves after a newer one', async () => {
    vi.useFakeTimers();
    let finishFirst: (items: ThreadCardItem[]) => void = () => {};
    vi.mocked(fetchThreadStates)
      .mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce([card('n1', 'done')]);
    const { result } = renderHook(() => useThreadStates('local', ['n1']));
    await flush();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await flush();
    expect(result.current.byNode.get('n1')?.state).toBe('done');
    await act(async () => { finishFirst([card('n1', 'waiting')]); });
    await flush();
    expect(result.current.byNode.get('n1')?.state).toBe('done');
  });

  it('returns the same object across re-renders while nothing new was read', async () => {
    vi.mocked(fetchThreadStates).mockResolvedValue([card('n1', 'waiting')]);
    const { result, rerender } = renderHook(({ ids }) => useThreadStates('local', ids), { initialProps: { ids: ['n1'] } });
    await flush();
    const first = result.current;
    rerender({ ids: ['n1'] });
    expect(result.current).toBe(first);
  });
});
