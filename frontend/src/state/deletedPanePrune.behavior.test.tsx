/**
 * Regression for: a node deleted while it still has an open pane in a
 * DIFFERENT pane key (another tree / another tab) used to linger — the tree
 * and sidebar hid it (they filter `deletedAt`), but the open pane kept
 * rendering it and you could still chat with it.
 *
 * `deleteNode`/`trimNode` only clear the pane key they run in (the active
 * `projectId::treeId` slot). A reactive chatStore effect must additionally
 * prune any pane key whose node became `deletedAt`. This file exercises that
 * effect end-to-end through ChatProvider.
 */
import React from 'react';
import { vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../services/api', () => ({
  __esModule: true,
  allocateNodeIds: (() => { let i = 0; return async (count = 1) => Array.from({ length: count }, () => `n-test-${++i}`); })(),
  listAgentModes: () => Promise.resolve([]),
  fetchAgentStatus: () => Promise.resolve(null),
  listModels: () => Promise.resolve({ models: [], defaultModel: null }),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  deleteWorkspace: () => Promise.resolve({ ok: true }),
  setChatMode: () => Promise.resolve('fake-chat'),
  respondToPermission: () => Promise.resolve({ ok: true }),
  cancelPermission: () => Promise.resolve({ ok: true }),
  warmCwd: () => Promise.resolve({ ok: true }),
  claimPane: () => Promise.resolve({ owner: true }),
  heartbeatPane: () => Promise.resolve(true),
  releasePane: () => Promise.resolve(),
  subscribeChat: vi.fn(() => () => {}),
  cancelChat: () => Promise.resolve(),
  ensureSession: vi.fn(() =>
    Promise.resolve({ chatId: 'fake-chat', currentModeId: null, resumeStrategy: 'fresh' }),
  ),
  streamMessage: vi.fn(() => () => {}),
  syncWorkspace: () => Promise.resolve({ ok: true }),
  fetchAllWorkspaces: () => Promise.resolve([]),
}));

vi.mock('../services/notifications', () => ({ notify: vi.fn() }));

import { ChatProvider, useChatStore, useChatNodesSnapshot } from './chatStore';
import { PrefsProvider } from './prefs';

function useStoreAndNodes() {
  const store = useChatStore();
  const nodes = useChatNodesSnapshot();
  return { store, nodes };
}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <PrefsProvider>
      <ChatProvider>{children}</ChatProvider>
    </PrefsProvider>
  );
}

describe('deleted-node pane prune (Fix B wiring)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('prunes an open pane in the ACTIVE tree when its node is deleted', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

    let rootId = '';
    await act(async () => { rootId = (await result.current.store.createThread()) ?? ''; });
    let childId = '';
    await act(async () => { childId = await result.current.store.createBlankChild(rootId); });

    act(() => { result.current.store.openPane(childId); });
    expect(result.current.store.openPanes).toContain(childId);

    act(() => { result.current.store.deleteNode(childId); });

    expect(result.current.nodes[childId].deletedAt).toBeTruthy();
    // Pane must be gone — both via deleteNode's own cleanup AND the effect.
    expect(result.current.store.openPanes).not.toContain(childId);
  });

  it('prunes a lingering pane in a NON-active tree when its node is deleted', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

    // Tree 1 with a child, opened in tree-1's pane slot.
    let root1 = '';
    await act(async () => { root1 = (await result.current.store.createThread()) ?? ''; });
    let child1 = '';
    await act(async () => { child1 = await result.current.store.createBlankChild(root1); });
    act(() => { result.current.store.openPane(child1); });
    expect(result.current.store.openPanes).toContain(child1);

    // Create a SECOND tree — it becomes active, so the pane key switches and
    // tree-1's pane slot is now inactive (the cross-tab / cross-view case).
    await act(async () => { await result.current.store.createThread(); });
    expect(result.current.store.openPanes).not.toContain(child1); // different slot now

    // Delete child1. deleteNode runs under tree-2's active pane key, so its own
    // setOpenPanes can't reach tree-1's slot — only the reactive effect can.
    act(() => { result.current.store.deleteNode(child1); });
    expect(result.current.nodes[child1].deletedAt).toBeTruthy();

    // Switch back to tree 1: its pane slot must no longer carry the dead id.
    const proj = result.current.store.activeProject!;
    const tree1 = proj.trees.find((t) => t.rootNodeId === root1);
    expect(tree1).toBeTruthy();
    act(() => { result.current.store.activateTree(tree1!.id); });
    expect(result.current.store.openPanes).not.toContain(child1);
  });
});
