/**
 * Behavior tests for the single-node trim feature (Phase 2). Renders
 * ChatProvider end-to-end and exercises trimNode → restoreDeletion through
 * useChatStore so the test catches integration issues (snapshot capture,
 * tree-root promotion, walk-up restore) that pure-function tests miss.
 *
 * The backend repo functions are covered separately in
 * backend/test/trimNodeRepository.test.ts. This file focuses on the
 * frontend mirror — local state mutations the chatStore makes before
 * the next sync flushes them.
 */

import React from 'react';
import { vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../services/api', () => ({
  __esModule: true,
  listAgentModes: () => Promise.resolve([]),
  fetchAgentStatus: () => Promise.resolve(null),
  listModels: () => Promise.resolve({ models: [], defaultModel: null }),
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

describe('trimNode (single-node trim)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('trim of a leaf is a no-op on parent topology but sends the leaf to trash', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

    let rootId = '';
    act(() => { rootId = result.current.store.createThread() ?? ''; });
    let leafId = '';
    act(() => { leafId = result.current.store.createBlankChild(rootId); });

    expect(result.current.nodes[leafId].parentNodeId).toBe(rootId);

    act(() => { result.current.store.trimNode(leafId); });

    expect(result.current.nodes[leafId].deletedAt).toBeTruthy();
    expect(result.current.nodes[leafId].trimSnapshot).toBeTruthy();
    expect(result.current.nodes[leafId].trimSnapshot?.parentId).toBe(rootId);
    expect(result.current.nodes[leafId].trimSnapshot?.childrenIds).toEqual([]);
    expect(result.current.nodes[leafId].trimSnapshot?.wasTreeRoot).toBeNull();
    // Root is unaffected.
    expect(result.current.nodes[rootId].deletedAt).toBeFalsy();
  });

  it('trim of a middle node reparents the descendant up to the grandparent', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

    let rootId = '';
    act(() => { rootId = result.current.store.createThread() ?? ''; });
    let midId = '';
    act(() => { midId = result.current.store.createBlankChild(rootId); });
    let leafId = '';
    act(() => { leafId = result.current.store.createBlankChild(midId); });

    expect(result.current.nodes[leafId].parentNodeId).toBe(midId);

    act(() => { result.current.store.trimNode(midId); });

    // Mid is trashed with snapshot recording leaf as a child.
    expect(result.current.nodes[midId].deletedAt).toBeTruthy();
    expect(result.current.nodes[midId].trimSnapshot?.parentId).toBe(rootId);
    expect(result.current.nodes[midId].trimSnapshot?.childrenIds).toEqual([leafId]);
    // Leaf has slid up to root.
    expect(result.current.nodes[leafId].parentNodeId).toBe(rootId);
  });

  it('trim of a fork node reparents every child up', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

    let rootId = '';
    act(() => { rootId = result.current.store.createThread() ?? ''; });
    let forkId = '';
    act(() => { forkId = result.current.store.createBlankChild(rootId); });
    let aId = '';
    let bId = '';
    let cId = '';
    act(() => { aId = result.current.store.createBlankChild(forkId); });
    act(() => { bId = result.current.store.createBlankChild(forkId); });
    act(() => { cId = result.current.store.createBlankChild(forkId); });

    act(() => { result.current.store.trimNode(forkId); });

    // All three children now under root.
    expect(result.current.nodes[aId].parentNodeId).toBe(rootId);
    expect(result.current.nodes[bId].parentNodeId).toBe(rootId);
    expect(result.current.nodes[cId].parentNodeId).toBe(rootId);
    expect(result.current.nodes[forkId].deletedAt).toBeTruthy();
    expect(result.current.nodes[forkId].trimSnapshot?.childrenIds.sort()).toEqual(
      [aId, bId, cId].sort(),
    );
  });

  it('trim of a tree root promotes the oldest live child (Option A)', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

    let rootId = '';
    act(() => { rootId = result.current.store.createThread() ?? ''; });
    // Three children of root in chronological order: A (oldest), B, C.
    let aId = '';
    let bId = '';
    let cId = '';
    act(() => { aId = result.current.store.createBlankChild(rootId); });
    act(() => { bId = result.current.store.createBlankChild(rootId); });
    act(() => { cId = result.current.store.createBlankChild(rootId); });

    const projectBefore = result.current.store.activeProject!;
    const treeId = projectBefore.trees.find((t) => t.rootNodeId === rootId)!.id;

    act(() => { result.current.store.trimNode(rootId); });

    expect(result.current.nodes[rootId].deletedAt).toBeTruthy();
    expect(result.current.nodes[rootId].trimSnapshot?.wasTreeRoot?.treeId).toBe(treeId);

    // A is the new root: parentNodeId cleared, B and C parented under A.
    expect(result.current.nodes[aId].parentNodeId).toBeUndefined();
    expect(result.current.nodes[bId].parentNodeId).toBe(aId);
    expect(result.current.nodes[cId].parentNodeId).toBe(aId);

    const projectAfter = result.current.store.activeProject!;
    const trimmedTree = projectAfter.trees.find((t) => t.id === treeId);
    expect(trimmedTree?.rootNodeId).toBe(aId);
  });

  it('restoreDeletion reverses a leaf trim back to the original parent', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

    let rootId = '';
    act(() => { rootId = result.current.store.createThread() ?? ''; });
    let midId = '';
    act(() => { midId = result.current.store.createBlankChild(rootId); });
    let leafId = '';
    act(() => { leafId = result.current.store.createBlankChild(midId); });

    act(() => { result.current.store.trimNode(midId); });
    const groupId = result.current.nodes[midId].deletionGroupId!;

    act(() => { result.current.store.restoreDeletion(groupId); });

    expect(result.current.nodes[midId].deletedAt).toBeFalsy();
    expect(result.current.nodes[midId].trimSnapshot).toBeFalsy();
    expect(result.current.nodes[midId].parentNodeId).toBe(rootId);
    // Leaf comes back home.
    expect(result.current.nodes[leafId].parentNodeId).toBe(midId);
  });

  it('restore after grandparent is also trimmed walks up to nearest live ancestor', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

    // G - P - X - C
    let gId = '';
    act(() => { gId = result.current.store.createThread() ?? ''; });
    let pId = '';
    act(() => { pId = result.current.store.createBlankChild(gId); });
    let xId = '';
    act(() => { xId = result.current.store.createBlankChild(pId); });
    let cId = '';
    act(() => { cId = result.current.store.createBlankChild(xId); });

    act(() => { result.current.store.trimNode(xId); });
    act(() => { result.current.store.trimNode(pId); });

    // After both trims, C's live parent is G.
    expect(result.current.nodes[cId].parentNodeId).toBe(gId);

    const xGroup = result.current.nodes[xId].deletionGroupId!;
    act(() => { result.current.store.restoreDeletion(xGroup); });

    // X's snapshot says parent=P; P is trashed with snapshot.parentId=G; G is
    // live → X is restored under G. C was live and parented to G (the
    // resolved target), so it gets re-stolen back under X.
    expect(result.current.nodes[xId].parentNodeId).toBe(gId);
    expect(result.current.nodes[cId].parentNodeId).toBe(xId);
  });
});
