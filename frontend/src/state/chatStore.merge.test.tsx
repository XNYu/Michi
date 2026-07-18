/**
 * Task 1: Cross-tree merge — merge nodes have no branch parent.
 *
 * API notes (adapted from plan placeholders):
 *  - createProject  → async, returns projectId, sets activeProjectId
 *  - createThread   → sync, creates a root chat in the ACTIVE project, returns nodeId
 *  - nodes          → via useChatNodesSnapshot() (NOT on useChatStore)
 */
import React from 'react';
import { vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ChatProvider, useChatStore, useChatNodesSnapshot } from './chatStore';
import { PrefsProvider } from './prefs';

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
  subscribeChats: vi.fn(() => () => {}),
  subscribeBackground: vi.fn(() => () => {}),
  cancelChat: () => Promise.resolve(),
  ensureSession: vi.fn(),
  streamMessage: vi.fn(),
  moveTreeToWorkspace: () => Promise.resolve({ ok: true }),
}));

vi.mock('../services/notifications', () => ({ notify: vi.fn() }));

// jsdom lacks matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <PrefsProvider>
      <ChatProvider>{children}</ChatProvider>
    </PrefsProvider>
  );
}

function useStoreAndNodes() {
  const store = useChatStore();
  const nodes = useChatNodesSnapshot();
  return { store, nodes };
}

beforeEach(() => {
  localStorage.clear();
});

describe('createMergedChat — cross-tree, no branch parent', () => {
  it('merges sources from two different trees and writes only merge edges', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    // Create workspace then two root threads (each gets its own tree).
    let aId = '';
    let bId = '';
    await act(async () => {
      await result.current.store.createProject('ws');
    });
    await act(async () => {
      aId = (await result.current.store.createThread())!;
    });
    await act(async () => {
      bId = (await result.current.store.createThread())!;
    });

    // Both ids must be populated.
    expect(aId).toBeTruthy();
    expect(bId).toBeTruthy();
    expect(aId).not.toBe(bId);

    let mergedId = '';
    await act(async () => {
      mergedId = await result.current.store.createMergedChat([aId, bId]);
    });

    expect(mergedId).toBeTruthy();

    const nodes = result.current.nodes;
    const node = nodes[mergedId];
    expect(node).toBeDefined();

    // All sources in mergeSources; no branch parent.
    expect(node.mergeSources).toEqual([aId, bId]);
    expect(node.parentNodeId).toBeUndefined();

    // Project edges: exactly 2, both kind='merge', pointing to mergedId.
    const projects = result.current.store.projects;
    const p = projects.find((x) => x.chatIds.includes(mergedId))!;
    expect(p).toBeDefined();

    const edgesToMerged = p.edges.filter((e) => e.target === mergedId);
    expect(edgesToMerged).toHaveLength(2);
    expect(edgesToMerged.every((e) => e.kind === 'merge')).toBe(true);
    expect(edgesToMerged.map((e) => e.source).sort()).toEqual([aId, bId].sort());

    // No branch edge targeting mergedId.
    const branchEdgesToMerged = p.edges.filter((e) => e.target === mergedId && e.kind === 'branch');
    expect(branchEdgesToMerged).toHaveLength(0);
  });

  it('throws on fewer than 2 sources', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    let aId = '';
    await act(async () => {
      await result.current.store.createProject('ws');
    });
    await act(async () => {
      aId = (await result.current.store.createThread())!;
    });

    await expect(result.current.store.createMergedChat([aId])).rejects.toThrow(/at least 2/);
  });

  it('rejects self-merge (duplicate source ids)', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    let aId = '';
    await act(async () => {
      await result.current.store.createProject('ws');
    });
    await act(async () => {
      aId = (await result.current.store.createThread())!;
    });

    await expect(result.current.store.createMergedChat([aId, aId])).rejects.toThrow(/duplicate|self-merge/i);
  });
});
