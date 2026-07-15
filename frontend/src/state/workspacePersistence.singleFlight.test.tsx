import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import type { ChatNodeState, Project } from './chatTypes';

const apiMocks = vi.hoisted(() => ({
  syncWorkspace: vi.fn(),
}));

vi.mock('../services/api', () => ({
  fetchAllWorkspaces: vi.fn(() => new Promise(() => {})),
  fetchWorkspace: vi.fn(),
  fetchWorkspaces: vi.fn(),
  migrateLocalStorage: vi.fn(),
  syncWorkspace: apiMocks.syncWorkspace,
}));

import { useWorkspacePersistence } from './workspacePersistence';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const project: Project = {
  id: 'ws-1',
  name: 'Workspace',
  chatIds: ['n-1'],
  edges: [],
  trees: [{ id: 't-1', rootNodeId: 'n-1', createdAt: 1, lastActiveAt: 1 }],
  activeTreeId: 't-1',
  contexts: [],
  createdAt: 1,
};

const initialNode: ChatNodeState = {
  nodeId: 'n-1',
  projectId: 'ws-1',
  kind: 'chat',
  chatId: null,
  messages: [],
  followUps: [],
  status: 'idle',
};

function usePersistenceHarness() {
  const [projects, setProjects] = useState<Project[]>([project]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>('ws-1');
  const [nodes, setNodes] = useState<Record<string, ChatNodeState>>({ 'n-1': initialNode });
  const [hydrated, setHydrated] = useState(true);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  useWorkspacePersistence({
    projects,
    activeProjectId,
    nodes,
    hydrated,
    nodesRef,
    setProjects,
    setActiveProjectId,
    setNodes,
    setHydrated,
  });

  return {
    title: nodes['n-1'].title,
    setTitle(title: string) {
      setNodes((prev) => ({
        ...prev,
        'n-1': { ...prev['n-1'], title },
      }));
    },
  };
}

describe('useWorkspacePersistence single-flight sync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiMocks.syncWorkspace.mockReset();
    localStorage.clear();
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not overlap requests and coalesces queued changes into the latest full snapshot', async () => {
    const first = deferred<{ ok: true; newRev: number }>();
    apiMocks.syncWorkspace
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ ok: true, newRev: 2 });

    const { result } = renderHook(() => usePersistenceHarness());

    act(() => result.current.setTitle('first'));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(apiMocks.syncWorkspace).toHaveBeenCalledTimes(1);

    act(() => result.current.setTitle('second'));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    act(() => result.current.setTitle('latest'));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    // The first request is unresolved, so neither queued update may overlap it.
    expect(apiMocks.syncWorkspace).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ ok: true, newRev: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.syncWorkspace).toHaveBeenCalledTimes(2);
    const queuedPayload = apiMocks.syncWorkspace.mock.calls[1][1] as {
      mode?: string;
      nodes?: Array<{ id: string; title: string | null }>;
    };
    expect(queuedPayload.mode).not.toBe('delta');
    expect(queuedPayload.nodes?.find((node) => node.id === 'n-1')?.title).toBe('latest');
  });

  it('does not bypass single-flight with a beforeunload sync', async () => {
    const first = deferred<{ ok: true; newRev: number }>();
    apiMocks.syncWorkspace.mockImplementationOnce(() => first.promise);
    const { result } = renderHook(() => usePersistenceHarness());

    act(() => result.current.setTitle('first'));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(apiMocks.syncWorkspace).toHaveBeenCalledTimes(1);

    act(() => result.current.setTitle('newer-local-change'));
    act(() => window.dispatchEvent(new Event('beforeunload')));

    expect(apiMocks.syncWorkspace).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve({ ok: true, newRev: 1 }));
  });

  it('preserves newer local state across a conflict and retries it with the server rev', async () => {
    const first = deferred<{
      ok: true;
      newRev: number;
      conflicts: Array<{ id: string; table: string; serverRow: Record<string, unknown> }>;
    }>();
    apiMocks.syncWorkspace
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ ok: true, newRev: 11, conflicts: [] });
    const { result } = renderHook(() => usePersistenceHarness());

    act(() => result.current.setTitle('first'));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    act(() => result.current.setTitle('latest'));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    await act(async () => {
      first.resolve({
        ok: true,
        newRev: 10,
        conflicts: [{
          id: 'n-1',
          table: 'nodes',
          serverRow: {
            id: 'n-1',
            workspace_id: 'ws-1',
            kind: 'chat',
            title: 'stale-server-title',
            rev: 10,
          },
        }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.title).toBe('latest');
    expect(apiMocks.syncWorkspace).toHaveBeenCalledTimes(2);
    const retryPayload = apiMocks.syncWorkspace.mock.calls[1][1] as {
      baseRevs: Record<string, number | null>;
      nodes: Array<{ id: string; title: string | null }>;
    };
    expect(retryPayload.baseRevs['n-1']).toBe(10);
    expect(retryPayload.nodes.find((node) => node.id === 'n-1')?.title).toBe('latest');
  });
});
