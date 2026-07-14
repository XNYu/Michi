/**
 * Behavior tests for the single-node archive feature. Archive reuses the trim
 * engine wholesale; the only differences are (a) the deletionGroupId lands in
 * the `arch-` lane and (b) the archived lane is exempt from trash-only flows
 * (⌘Z restoreLastDeletion, emptyTrash). This file pins those differences while
 * trimNode.behavior.test.tsx covers the shared reparent/restore algorithm.
 */

import React from 'react';
import { vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../services/api', () => ({
  __esModule: true,
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
import { isArchiveGroupId } from './trashActions';

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

describe('archiveNode (single-node archive)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('archives a middle node into the arch- lane and reparents children up', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

    let rootId = '';
    act(() => { rootId = result.current.store.createThread() ?? ''; });
    let midId = '';
    act(() => { midId = result.current.store.createBlankChild(rootId); });
    let leafId = '';
    act(() => { leafId = result.current.store.createBlankChild(midId); });

    act(() => { result.current.store.archiveNode(midId); });

    const gid = result.current.nodes[midId].deletionGroupId!;
    expect(isArchiveGroupId(gid)).toBe(true);
    expect(result.current.nodes[midId].deletedAt).toBeTruthy();
    expect(result.current.nodes[midId].trimSnapshot?.childrenIds).toEqual([leafId]);
    // Leaf slides up to root, exactly like trim.
    expect(result.current.nodes[leafId].parentNodeId).toBe(rootId);
  });

  it('restoreDeletion reverses an archive', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

    let rootId = '';
    act(() => { rootId = result.current.store.createThread() ?? ''; });
    let midId = '';
    act(() => { midId = result.current.store.createBlankChild(rootId); });
    let leafId = '';
    act(() => { leafId = result.current.store.createBlankChild(midId); });

    act(() => { result.current.store.archiveNode(midId); });
    const gid = result.current.nodes[midId].deletionGroupId!;

    act(() => { result.current.store.restoreDeletion(gid); });

    expect(result.current.nodes[midId].deletedAt).toBeFalsy();
    expect(result.current.nodes[midId].trimSnapshot).toBeFalsy();
    expect(result.current.nodes[midId].parentNodeId).toBe(rootId);
    expect(result.current.nodes[leafId].parentNodeId).toBe(midId);
  });

  it('⌘Z restoreLastDeletion ignores the archived lane', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

    let rootId = '';
    act(() => { rootId = result.current.store.createThread() ?? ''; });
    let aId = '';
    act(() => { aId = result.current.store.createBlankChild(rootId); });

    act(() => { result.current.store.archiveNode(aId); });
    expect(result.current.nodes[aId].deletedAt).toBeTruthy();

    // ⌘Z should find nothing in the trash lane and leave the archived node alone.
    let restored: string | null = 'sentinel';
    act(() => { restored = result.current.store.restoreLastDeletion(); });
    expect(restored).toBeNull();
    expect(result.current.nodes[aId].deletedAt).toBeTruthy();
  });

  it('emptyTrash does not purge archived nodes', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

    let rootId = '';
    act(() => { rootId = result.current.store.createThread() ?? ''; });
    let trashId = '';
    act(() => { trashId = result.current.store.createBlankChild(rootId); });
    let archId = '';
    act(() => { archId = result.current.store.createBlankChild(rootId); });

    act(() => { result.current.store.trimNode(trashId); });
    act(() => { result.current.store.archiveNode(archId); });

    act(() => { result.current.store.emptyTrash(); });

    // Trashed node is gone; archived node survives.
    expect(result.current.nodes[trashId]).toBeUndefined();
    expect(result.current.nodes[archId]?.deletedAt).toBeTruthy();
  });
});
