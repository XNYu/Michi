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
import { paneScopeKey, prunePaneMaps, singlePageVisiblePanes, usePaneState } from './paneState';
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
  allocateNodeIdsLocal: (() => { let i = 0; return (count = 1) => Array.from({ length: count }, () => `n-test-${++i}`); })(),
  ensureSession: () => Promise.resolve({ chatId: 'fake', currentModeId: null, resumeStrategy: 'fresh' }),
  streamMessage: () => () => {},
  setChatMode: () => Promise.resolve(''),
  listAgentModes: () => Promise.resolve({ availableModes: [], defaultModeId: null }),
  listModels: () => Promise.resolve({ models: [], defaultModel: null }),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  subscribeChat: () => () => {},
  subscribeChats: () => () => {},
  subscribeBackground: () => () => {},
  cancelChat: () => Promise.resolve(),
  artifactWatchStreamUrl: () => '/api/watch',
  postArtifactWatchPaths: () => Promise.resolve({ watching: [] }),
}));

describe('pane state', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    delete window.electron;
  });

  it('strips source locations and reuses the pane for the underlying file', async () => {
    const harness = renderHook(() => useChatStore());
    await act(async () => { await harness.result.current.createProject('WS'); });
    await act(async () => { await harness.result.current.createThread(); });
    const path = '/workspace/sample-project/src/worker.ts';
    let firstPaneId = '';
    await act(async () => { firstPaneId = await harness.result.current.openArtifactPane(`${path}:414`, { parseSourceLocation: true }); });
    expect(harness.result.current.paneItems[firstPaneId]).toMatchObject({
      kind: 'file',
      filePath: path,
      title: 'worker.ts',
      sourceLocation: { line: 414 },
      sourceReferencePath: `${path}:414`,
    });

    let secondPaneId = '';
    await act(async () => { secondPaneId = await harness.result.current.openArtifactPane(`${path}:275:9`, { parseSourceLocation: true }); });
    expect(secondPaneId).toBe(firstPaneId);
    expect(harness.result.current.paneItems[firstPaneId]).toMatchObject({
      filePath: path,
      sourceLocation: { line: 275, column: 9 },
      sourceReferencePath: `${path}:275:9`,
    });
    harness.unmount();
  });

  it('opens artifacts before the workspace has any conversation tree', async () => {
    const harness = renderHook(() => useChatStore());
    await act(async () => { await harness.result.current.createProject('Empty workspace'); });
    let paneId = '';
    await act(async () => { paneId = await harness.result.current.openArtifactPane('notes.md'); });
    expect(harness.result.current.activeProject?.activeTreeId).toBeNull();
    expect(harness.result.current.activeProject?.chatIds).toEqual([]);
    expect(harness.result.current.openPanes).toEqual([paneId]);
    expect(harness.result.current.focusedPane).toBe(paneId);
    harness.unmount();
  });

  it('opens an Agent Run in another workspace without requiring an active tree', async () => {
    const harness = renderHook(() => useChatStore());
    let targetId = '';
    await act(async () => { targetId = await harness.result.current.createProject('Target'); });
    await act(async () => { await harness.result.current.createProject('Other'); });
    let paneId = '';
    act(() => { paneId = harness.result.current.openAgentRunPane({ backendConnectionId: 'local', id: 'run-1' }, targetId); });
    expect(harness.result.current.activeProject?.id).toBe(targetId);
    expect(harness.result.current.activeProject?.activeTreeId).toBeNull();
    expect(harness.result.current.openPanes).toEqual([paneId]);
    expect(harness.result.current.focusedPane).toBe(paneId);
    harness.unmount();
  });

  it('opens a native Page in the active host slot while retaining owner identity', async () => {
    const harness = renderHook(() => useChatStore());
    await act(async () => { await harness.result.current.createProject('Host workspace'); });
    await act(async () => { await harness.result.current.createThread(); });
    let paneId = '';
    act(() => { paneId = harness.result.current.openPagePane({
      pageId: 'page-1', workspaceId: 'owner-workspace', backendConnectionId: 'remote-a', title: 'Roadmap',
    }); });
    expect(harness.result.current.paneItems[paneId]).toMatchObject({
      kind: 'page', projectId: harness.result.current.activeProject?.id,
      treeId: harness.result.current.activeProject?.activeTreeId,
      backendConnectionId: 'remote-a', workspaceId: 'owner-workspace', pageId: 'page-1', title: 'Roadmap',
    });
    expect(harness.result.current.openPanes).toContain(paneId);
    expect(harness.result.current.focusedPane).toBe(paneId);
    harness.unmount();
  });

  it('destroys a runtime surface only when its pane is explicitly closed', async () => {
    const terminalDestroy = vi.fn();
    window.electron = { terminalDestroy } as unknown as NonNullable<typeof window.electron>;
    const harness = renderHook(() => useChatStore());
    await act(async () => { await harness.result.current.createProject('WS'); });
    await act(async () => { await harness.result.current.createThread(); });
    let paneId = '';
    act(() => { paneId = harness.result.current.openTerminalPane('/tmp'); });
    expect(terminalDestroy).not.toHaveBeenCalled();
    act(() => harness.result.current.closePane(paneId));
    expect(terminalDestroy).toHaveBeenCalledTimes(1);
    expect(harness.result.current.paneItems[paneId]).toBeUndefined();
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

  it('appends a background pane without stealing the existing focus', () => {
    const project = {
      id: 'p1', name: 'WS', chatIds: ['parent', 'child'], edges: [], artifacts: [],
      trees: [{ id: 't1', rootNodeId: 'parent', createdAt: 1, lastActiveAt: 1 }],
      activeTreeId: 't1', createdAt: 1,
    };
    const harness = renderHook(() => usePaneState({ projects: [project], activeProjectId: 'p1' }));
    act(() => harness.result.current.openPane('parent'));
    expect(harness.result.current.focusedPane).toBe('parent');

    act(() => harness.result.current.appendPaneInTree('p1', 't1', 'child'));

    expect(harness.result.current.openPanes).toEqual(['parent', 'child']);
    expect(harness.result.current.focusedPane).toBe('parent');
    harness.unmount();
  });

  it('updates synthetic pane widths independently from node state', () => {
    const project = {
      id: 'p1', name: 'WS', chatIds: ['root'], edges: [], artifacts: [],
      trees: [{ id: 't1', rootNodeId: 'root', createdAt: 1, lastActiveAt: 1 }],
      activeTreeId: 't1', createdAt: 1,
    };
    const harness = renderHook(() => usePaneState({ projects: [project], activeProjectId: 'p1' }));
    act(() => harness.result.current.registerPaneItem({
      id: 'pane:browser:test', kind: 'browser', projectId: 'p1', treeId: 't1', title: 'Browser',
      createdAt: 1, surfaceId: 'test', url: 'https://example.com/',
    }));
    act(() => harness.result.current.setPaneItemWidth('pane:browser:test', 640));
    expect(harness.result.current.paneItems['pane:browser:test'].width).toBe(640);
    harness.unmount();
  });

  it('replaces a launcher descriptor in-place and preserves its width', () => {
    const project = {
      id: 'p1', name: 'WS', chatIds: ['root'], edges: [], artifacts: [],
      trees: [{ id: 't1', rootNodeId: 'root', createdAt: 1, lastActiveAt: 1 }],
      activeTreeId: 't1', createdAt: 1,
    };
    const harness = renderHook(() => usePaneState({ projects: [project], activeProjectId: 'p1' }));
    act(() => harness.result.current.registerPaneItem({
      id: 'pane:launcher:test', kind: 'launcher', projectId: 'p1', treeId: 't1', title: 'New pane',
      createdAt: 1, width: 620, anchorNodeId: 'root',
    }));
    act(() => harness.result.current.replacePaneItem('pane:launcher:test', {
      id: 'pane:launcher:test', kind: 'files', projectId: 'p1', treeId: 't1', title: 'Files', createdAt: 1,
    }));
    expect(harness.result.current.paneItems['pane:launcher:test']).toMatchObject({
      id: 'pane:launcher:test', kind: 'files', title: 'Files', width: 620,
    });
    harness.unmount();
  });
});

describe('prunePaneMaps', () => {
  it('empty dead set is a no-op (same refs)', () => {
    const open = { 'p::t1': ['a'] };
    const focused = { 'p::t1': 'a' };
    const result = prunePaneMaps(open, focused, new Set());
    expect(result.openPanesMap).toBe(open);
    expect(result.focusedPaneMap).toBe(focused);
  });
});

describe('single-page mode', () => {
  const items = {
    file: { id: 'file', kind: 'files', projectId: 'p', treeId: null, title: '', createdAt: 0 },
    web: { id: 'web', kind: 'browser', projectId: 'p', treeId: null, title: '', createdAt: 0, surfaceId: 's', url: 'about:blank' },
  } as const;

  it('shows the focused tab as the page and keeps browser items for the dock', () => {
    expect(singlePageVisiblePanes(['a', 'file', 'web', 'b'], items, 'a')).toEqual(['a', 'web']);
    expect(singlePageVisiblePanes(['a', 'file', 'web', 'b'], items, 'file')).toEqual(['file', 'web']);
  });

  it('falls back to the last tab when focus is outside the tabs', () => {
    expect(singlePageVisiblePanes(['a', 'b', 'web'], items, 'web')).toEqual(['b', 'web']);
    expect(singlePageVisiblePanes(['a', 'b'], items, null)).toEqual(['b']);
  });

  it('returns the slot unchanged when it holds one tab', () => {
    const single = ['a', 'web'];
    expect(singlePageVisiblePanes(single, items, 'a')).toBe(single);
  });

  it('scopes pane motion by page so switching tabs swaps without open/close motion', () => {
    const project = { id: 'p', activeTreeId: 't' };
    expect(paneScopeKey(project)).toBe('p::t');
    expect(paneScopeKey(project, 'a')).not.toBe(paneScopeKey(project, 'b'));
  });
});
