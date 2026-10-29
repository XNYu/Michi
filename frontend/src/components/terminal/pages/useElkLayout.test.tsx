import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tree } from '../../../state/chatTypes';
import { useElkLayout } from './useElkLayout';

const engine = vi.hoisted(() => ({ load: vi.fn(), layout: vi.fn() }));
vi.mock('elkjs/lib/elk.bundled.js', () => {
  engine.load();
  return { default: class { layout = engine.layout; } };
});
const tree = { id: 't', rootNodeId: 'n', createdAt: 1 } as Tree;
const input = {
  trees: [tree], activeTree: tree, edges: [], liveSet: new Set(['n']),
  mode: 'thread', cardHeights: new Map<string, number>(), graphChildren: new Map<string, string[]>(),
};
const laid = { children: [{ id: 'n', x: 10, y: 20, width: 100, height: 50 }] };

beforeEach(() => engine.layout.mockReset());

describe('lazy Map layout', () => {
  it('does not load the engine for disabled, overview or empty maps', () => {
    const view = renderHook(({ enabled, mode, trees, activeTree }) => useElkLayout({ ...input, enabled, mode, trees, activeTree }),
      { initialProps: { enabled: false, mode: 'thread', trees: [tree], activeTree: tree as Tree | null } });
    view.rerender({ enabled: true, mode: 'overview', trees: [tree], activeTree: tree });
    view.rerender({ enabled: true, mode: 'thread', trees: [], activeTree: null });
    expect(engine.load).not.toHaveBeenCalled();
    expect(engine.layout).not.toHaveBeenCalled();
    expect(view.result.current?.ids).toEqual([]);
  });

  it('discards a pending layout when the graph is disabled and reuses the engine on return', async () => {
    let finish!: (value: typeof laid) => void;
    engine.layout.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue(laid);
    const view = renderHook(({ enabled }) => useElkLayout({ ...input, enabled }), { initialProps: { enabled: true } });
    await waitFor(() => expect(engine.layout).toHaveBeenCalledTimes(1));
    view.rerender({ enabled: false });
    await act(async () => { finish(laid); });
    expect(view.result.current).toBeNull();
    view.rerender({ enabled: true });
    await waitFor(() => expect(view.result.current?.ids).toEqual(['n']));
    expect(engine.load).toHaveBeenCalledTimes(1);
  });

  it('does not let an older failure erase a newer layout', async () => {
    let fail!: (reason: Error) => void;
    engine.layout.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; })).mockResolvedValue(laid);
    const view = renderHook(({ mode }) => useElkLayout({ ...input, enabled: true, mode }), { initialProps: { mode: 'thread' } });
    await waitFor(() => expect(engine.layout).toHaveBeenCalledTimes(1));
    view.rerender({ mode: 'graph' });
    await waitFor(() => expect(view.result.current?.ids).toEqual(['n']));
    await act(async () => { fail(new Error('stale layout')); });
    expect(view.result.current?.ids).toEqual(['n']);
  });
});
