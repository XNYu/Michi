/**
 * Exercises openPane/closePane/focusPane/setViewMode through the real
 * ChatProvider so we don't re-implement the reducer.
 *
 * NOTE: @testing-library/react isn't installed in this workspace, so we
 * implement a minimal renderHook shim on top of react-dom/test-utils.act
 * + ReactDOM.createRoot. Behaviour parity with the testing-library version
 * is sufficient for this small slice.
 */
import { vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { ChatProvider, useChatStore } from './chatStore';
import { prunePaneMaps } from './paneState';
import { PrefsProvider } from './prefs';

// Opt into React's concurrent-act environment so state updates dispatched
// inside act(...) callbacks don't trigger the "not configured to support
// act(...)" warning that otherwise spams stderr during this test.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <PrefsProvider>
      <ChatProvider>{children}</ChatProvider>
    </PrefsProvider>
  );
}

interface HookHarness<T> {
  result: { current: T };
  unmount: () => void;
}

function renderHook<T>(cb: () => T): HookHarness<T> {
  const result: { current: T } = { current: undefined as unknown as T };
  function Probe() {
    result.current = cb();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  act(() => {
    root = createRoot(container);
    root.render(
      wrapper({ children: <Probe /> }),
    );
  });
  return {
    result,
    unmount: () => {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

vi.mock('../services/api', () => ({
  allocateNodeIds: (() => { let i = 0; return async (count = 1) => Array.from({ length: count }, () => `n-test-${++i}`); })(),
  ensureSession: () => Promise.resolve({ chatId: 'fake', currentModeId: null, resumeStrategy: 'fresh' }),
  streamMessage: () => () => {},
  setChatMode: () => Promise.resolve(''),
  listAgentModes: () => Promise.resolve([]),
  listModels: () => Promise.resolve({ models: [], defaultModel: null }),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  claimPane: () => Promise.resolve({ owner: true }),
  heartbeatPane: () => Promise.resolve(true),
  releasePane: () => Promise.resolve(),
  subscribeChat: () => () => {},
  cancelChat: () => Promise.resolve(),
}));

describe('pane state', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('opens a pane and focuses it', async () => {
    const harness = renderHook(() => useChatStore());
    // openPanes is keyed by `projectId::activeTreeId`; fresh workspaces have
    // no tree yet. Create one via createThread so paneKey becomes non-null.
    await act(async () => {
      await harness.result.current.createProject('WS');
    });
    await act(async () => {
      await harness.result.current.createThread();
    });
    act(() => {
      harness.result.current.openPane('n1');
    });
    expect(harness.result.current.openPanes).toContain('n1');
    expect(harness.result.current.focusedPane).toBe('n1');
    harness.unmount();
  });

  it('closes a focused pane and shifts focus to the last remaining', async () => {
    const harness = renderHook(() => useChatStore());
    await act(async () => {
      await harness.result.current.createProject('WS');
    });
    await act(async () => {
      await harness.result.current.createThread();
    });
    // Replace panes with just 'a' and 'b' by focusing known ids.
    act(() => {
      harness.result.current.openPane('a');
    });
    act(() => {
      harness.result.current.openPane('b');
    });
    expect(harness.result.current.focusedPane).toBe('b');
    act(() => {
      harness.result.current.closePane('b');
    });
    expect(harness.result.current.openPanes).toContain('a');
    expect(harness.result.current.openPanes).not.toContain('b');
    expect(harness.result.current.focusedPane).toBe('a');
    harness.unmount();
  });

  it('setViewMode updates the mode', () => {
    const harness = renderHook(() => useChatStore());
    act(() => {
      harness.result.current.setViewMode('three');
    });
    expect(harness.result.current.viewMode).toBe('three');
    harness.unmount();
  });
});

describe('prunePaneMaps', () => {
  it('removes dead ids from open panes across ALL pane keys', () => {
    const open = { 'p::t1': ['a', 'dead', 'b'], 'p::t2': ['dead', 'c'] };
    const focused = { 'p::t1': 'a', 'p::t2': 'dead' };
    const { openPanesMap, focusedPaneMap } = prunePaneMaps(open, focused, new Set(['dead']));
    expect(openPanesMap).toEqual({ 'p::t1': ['a', 'b'], 'p::t2': ['c'] });
    // Focused pane that pointed at a dead id falls back (to last remaining, else null).
    expect(focusedPaneMap['p::t1']).toBe('a');
    expect(focusedPaneMap['p::t2']).toBe('c');
  });

  it('drops focus to null when the only pane in a key was dead', () => {
    const open = { 'p::t1': ['dead'] };
    const focused = { 'p::t1': 'dead' };
    const { openPanesMap, focusedPaneMap } = prunePaneMaps(open, focused, new Set(['dead']));
    expect(openPanesMap['p::t1']).toEqual([]);
    expect(focusedPaneMap['p::t1']).toBeNull();
  });

  it('returns the SAME map references when nothing was dead (no spurious render)', () => {
    const open = { 'p::t1': ['a', 'b'] };
    const focused = { 'p::t1': 'a' };
    const result = prunePaneMaps(open, focused, new Set(['nonexistent']));
    expect(result.openPanesMap).toBe(open);
    expect(result.focusedPaneMap).toBe(focused);
  });

  it('preserves untouched pane-key arrays by reference', () => {
    const untouched = ['x', 'y'];
    const open = { 'p::t1': ['dead', 'a'], 'p::t2': untouched };
    const focused = { 'p::t1': 'a', 'p::t2': 'x' };
    const result = prunePaneMaps(open, focused, new Set(['dead']));
    expect(result.openPanesMap['p::t2']).toBe(untouched); // key with no dead id unchanged
    expect(result.openPanesMap['p::t1']).toEqual(['a']);
  });

  it('empty dead set is a no-op (same refs)', () => {
    const open = { 'p::t1': ['a'] };
    const focused = { 'p::t1': 'a' };
    const result = prunePaneMaps(open, focused, new Set());
    expect(result.openPanesMap).toBe(open);
    expect(result.focusedPaneMap).toBe(focused);
  });
});
