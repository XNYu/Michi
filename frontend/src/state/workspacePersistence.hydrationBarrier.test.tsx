/**
 * Cold-start hydration barrier.
 *
 * The dev/desktop norm: the renderer mounts (and this hook runs) BEFORE the
 * backend is listening, so the first `fetchAllWorkspaces()` rejects with
 * ECONNREFUSED. The bug this guards against: that thrown fetch was finalized as
 * an EMPTY database — `setHydrated(true)` with `projects: []` — which made the
 * shell auto-open the New Workspace dialog over a DB that actually holds every
 * workspace. A durable mirror had already been cleared on the prior good boot,
 * so there was nothing local to fall back to either.
 *
 * The contract: hydration MUST NOT be finalized on a connection failure. The
 * `hydrated: false → true` transition happens IFF the backend actually answered
 * (an array, even an empty one). An unreachable backend keeps us in the
 * not-ready state and retries — it is never interpreted as "empty".
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import type { ChatNodeState, Project } from './chatTypes';
import type { BackendConnectionSummary } from '../config/backendConnections';

const apiMocks = vi.hoisted(() => ({
  fetchPersistenceCapabilities: vi.fn(),
  fetchAllWorkspacesMeta: vi.fn(),
  fetchTreeMessages: vi.fn(async () => []),
  fetchWorkspaces: vi.fn(),
  fetchWorkspace: vi.fn(),
  applyWorkspaceCommands: vi.fn(async () => {}),
  listBackendConnections: vi.fn(async (): Promise<BackendConnectionSummary[]> => []),
}));

vi.mock('../services/api', () => ({
  fetchPersistenceCapabilities: apiMocks.fetchPersistenceCapabilities,
  fetchAllWorkspacesMeta: apiMocks.fetchAllWorkspacesMeta,
  fetchTreeMessages: apiMocks.fetchTreeMessages,
  fetchWorkspaces: apiMocks.fetchWorkspaces,
  fetchWorkspace: apiMocks.fetchWorkspace,
  applyWorkspaceCommands: apiMocks.applyWorkspaceCommands,
  listBackendConnections: apiMocks.listBackendConnections,
}));

import { ACTIVE_TREE_EAGER_BUDGET_MS, useWorkspacePersistence } from './workspacePersistence';

const V2_CAPABILITIES = {
  protocolVersion: 2,
  authoritativeTurnPersistence: true,
  durableNodePrerequisite: true,
  explicitCommands: true,
  backgroundWorkspaceSync: false,
  legacySyncAccepted: true,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** Minimal backend `/workspaces/all` row that hydrates into exactly one project. */
const backendWorkspaceRow = {
  workspace: { id: 'ws-1', name: 'Recovered', created_at: 1 },
  nodes: [{ id: 'n1', created_at: 1 }],
  trees: [],
  edges: [],
  messages: [],
  artifacts: [],
};

/**
 * Mirror the real chatStore mount: hydrated STARTS false and only the hook may
 * flip it. The two existing hydration harnesses start hydrated=true, so they
 * never drive this transition — this one does.
 */
function useHarness(initialActiveProjectId: string | null = null) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(initialActiveProjectId);
  const [nodes, setNodes] = useState<Record<string, ChatNodeState>>({});
  const [hydrated, setHydrated] = useState(false);
  const [structureVersion] = useState(0);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  useWorkspacePersistence({
    projects, activeProjectId, nodes, structureVersion, hydrated, nodesRef,
    setProjects, setActiveProjectId, setNodes, setHydrated,
  });
  return { hydrated, projects, projectsCount: projects.length, activeProjectId, nodes };
}

describe('cold-start hydration barrier', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    apiMocks.fetchPersistenceCapabilities.mockResolvedValue(V2_CAPABILITIES);
    apiMocks.fetchAllWorkspacesMeta.mockReset();
    apiMocks.fetchTreeMessages.mockResolvedValue([]);
    apiMocks.fetchWorkspaces.mockResolvedValue([]);
    apiMocks.listBackendConnections.mockReset().mockResolvedValue([]);
    Object.defineProperty(window, 'requestIdleCallback', { configurable: true, value: undefined });
  });

  afterEach(() => vi.useRealTimers());

  it('never finalizes hydration while the backend is unreachable (no false-empty)', async () => {
    // Backend is down for the whole window: every probe rejects like ECONNREFUSED.
    apiMocks.fetchAllWorkspacesMeta.mockRejectedValue(new Error('ECONNREFUSED'));

    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    // Let several retry ticks elapse — the backend still never answered.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    // Barrier: an unreachable backend must NOT be interpreted as an empty DB.
    expect(result.current.hydrated).toBe(false);
    expect(result.current.projectsCount).toBe(0);
    // It must keep trying, not give up after one shot.
    expect(apiMocks.fetchAllWorkspacesMeta.mock.calls.length).toBeGreaterThan(1);
  });

  it('finalizes with the real workspaces once the backend comes up mid-retry', async () => {
    // Two cold-start refusals, then the backend starts listening and answers.
    apiMocks.fetchAllWorkspacesMeta
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue([backendWorkspaceRow]);

    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    // Recovery: hydration completes with the DB's real contents, not empty.
    expect(result.current.hydrated).toBe(true);
    expect(result.current.projectsCount).toBe(1);
  });

  it('hydrates local and remote workspaces together without changing their backend ownership', async () => {
    const remoteWorkspace = {
      ...backendWorkspaceRow,
      workspace: { id: 'ws-remote', name: 'Remote', created_at: 2 },
      nodes: [{ id: 'n-remote', created_at: 2 }],
    };
    apiMocks.listBackendConnections.mockResolvedValue([{
      id: 'remote-1', name: 'Build', transport: 'direct', apiUrl: 'https://build.example.com/api', hasToken: true, createdAt: 1, updatedAt: 1,
    }]);
    apiMocks.fetchAllWorkspacesMeta.mockImplementation(async (connectionId?: string) => (
      connectionId === 'remote-1' ? [remoteWorkspace] : [backendWorkspaceRow]
    ));

    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.hydrated).toBe(true);
    expect(result.current.projects).toHaveLength(2);
    expect(result.current.projects.find((project) => project.id === 'ws-1')?.backendConnectionId).toBeUndefined();
    expect(result.current.projects.find((project) => project.id === 'ws-remote')?.backendConnectionId).toBe('remote-1');
  });

  it('keeps local workspaces available when a saved remote backend is offline', async () => {
    apiMocks.listBackendConnections.mockResolvedValue([{
      id: 'remote-offline', name: 'Offline', transport: 'direct', apiUrl: 'https://offline.example.com/api', hasToken: true, createdAt: 1, updatedAt: 1,
    }]);
    apiMocks.fetchAllWorkspacesMeta.mockImplementation(async (connectionId?: string) => {
      if (connectionId === 'remote-offline') throw new Error('ECONNREFUSED');
      return [backendWorkspaceRow];
    });

    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.hydrated).toBe(true);
    expect(result.current.projects.map((project) => project.id)).toEqual(['ws-1']);
  });

  it('hydrates an initially-offline remote backend after it reconnects without reloading the app', async () => {
    const remoteWorkspace = {
      ...backendWorkspaceRow,
      workspace: { id: 'ws-remote-late', name: 'Remote recovered', created_at: 3 },
      nodes: [{ id: 'n-remote-late', created_at: 3 }],
    };
    apiMocks.listBackendConnections.mockResolvedValue([{
      id: 'remote-late', name: 'Late remote', transport: 'direct', apiUrl: 'https://late.example.com/api', hasToken: true, createdAt: 1, updatedAt: 1,
    }]);
    let remoteAttempts = 0;
    apiMocks.fetchAllWorkspacesMeta.mockImplementation(async (connectionId?: string) => {
      if (connectionId !== 'remote-late') return [backendWorkspaceRow];
      remoteAttempts += 1;
      if (remoteAttempts === 1) throw new Error('ECONNREFUSED');
      return [remoteWorkspace];
    });

    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.hydrated).toBe(true);
    expect(result.current.projects.map((project) => project.id)).toEqual(['ws-1']);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(remoteAttempts).toBeGreaterThanOrEqual(2);
    expect(result.current.projects.map((project) => project.id)).toEqual(['ws-1', 'ws-remote-late']);
    expect(result.current.projects.find((project) => project.id === 'ws-remote-late')?.backendConnectionId).toBe('remote-late');
  });

  describe('local-first: remote backends never hold the barrier', () => {
    const remoteConnection: BackendConnectionSummary = {
      id: 'remote-slow', name: 'Slow tunnel', transport: 'ssh', apiUrl: '', sshHost: 'build-server', remotePort: 3000, hasToken: true, createdAt: 1, updatedAt: 1,
    } as BackendConnectionSummary;
    const remoteWorkspace = {
      ...backendWorkspaceRow,
      workspace: { id: 'ws-remote-slow', name: 'Remote', created_at: 2 },
      nodes: [{ id: 'n-remote-slow', created_at: 2 }],
    };

    it('finalizes with local workspaces while the remote snapshot is still in flight, then merges it', async () => {
      const remote = deferred<unknown[]>();
      apiMocks.listBackendConnections.mockResolvedValue([remoteConnection]);
      apiMocks.fetchAllWorkspacesMeta.mockImplementation(async (connectionId?: string) => (
        connectionId === 'remote-slow' ? remote.promise : [backendWorkspaceRow]
      ));

      const { result } = renderHook(() => useHarness());
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });

      // The old barrier would sit here for up to REMOTE_HYDRATION_TIMEOUT_MS.
      expect(result.current.hydrated).toBe(true);
      expect(result.current.projects.map((project) => project.id)).toEqual(['ws-1']);

      remote.resolve([remoteWorkspace]);
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });

      expect(result.current.projects.map((project) => project.id)).toEqual(['ws-1', 'ws-remote-slow']);
      expect(result.current.projects.find((project) => project.id === 'ws-remote-slow')?.backendConnectionId).toBe('remote-slow');
    });

    it('auto-selects a local workspace, then restores the window\'s remote preference once it lands', async () => {
      const remote = deferred<unknown[]>();
      apiMocks.listBackendConnections.mockResolvedValue([remoteConnection]);
      apiMocks.fetchAllWorkspacesMeta.mockImplementation(async (connectionId?: string) => (
        connectionId === 'remote-slow' ? remote.promise : [backendWorkspaceRow]
      ));

      // The window was last on the remote workspace.
      const { result } = renderHook(() => useHarness('ws-remote-slow'));
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });

      expect(result.current.hydrated).toBe(true);
      // Not dangling: something real is active while the tunnel comes up.
      expect(result.current.activeProjectId).toBe('ws-1');

      remote.resolve([remoteWorkspace]);
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });

      expect(result.current.activeProjectId).toBe('ws-remote-slow');
    });

    it('does not override a user navigation made before the remote snapshot lands', async () => {
      const remote = deferred<unknown[]>();
      const secondLocal = {
        ...backendWorkspaceRow,
        workspace: { id: 'ws-2', name: 'Second', created_at: 1 },
        nodes: [{ id: 'n2', created_at: 1 }],
      };
      apiMocks.listBackendConnections.mockResolvedValue([remoteConnection]);
      apiMocks.fetchAllWorkspacesMeta.mockImplementation(async (connectionId?: string) => (
        connectionId === 'remote-slow' ? remote.promise : [backendWorkspaceRow, secondLocal]
      ));

      const { result } = renderHook(() => {
        const [projects, setProjects] = useState<Project[]>([]);
        const [activeProjectId, setActiveProjectId] = useState<string | null>('ws-remote-slow');
        const [nodes, setNodes] = useState<Record<string, ChatNodeState>>({});
        const [hydrated, setHydrated] = useState(false);
        const nodesRef = useRef(nodes);
        nodesRef.current = nodes;
        useWorkspacePersistence({
          projects, activeProjectId, nodes, structureVersion: 0, hydrated, nodesRef,
          setProjects, setActiveProjectId, setNodes, setHydrated,
        });
        return { hydrated, activeProjectId, setActiveProjectId };
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(result.current.activeProjectId).toBe('ws-1');

      // User picks another workspace while the tunnel is still connecting.
      act(() => { result.current.setActiveProjectId('ws-2'); });
      remote.resolve([remoteWorkspace]);
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });

      expect(result.current.activeProjectId).toBe('ws-2');
    });

    it('still waits for remote snapshots when the local DB is empty (remote-only setup)', async () => {
      const remote = deferred<unknown[]>();
      apiMocks.listBackendConnections.mockResolvedValue([remoteConnection]);
      apiMocks.fetchAllWorkspacesMeta.mockImplementation(async (connectionId?: string) => (
        connectionId === 'remote-slow' ? remote.promise : []
      ));

      const { result } = renderHook(() => useHarness());
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });

      // Finalizing here would flash the empty-DB "create a workspace" state.
      expect(result.current.hydrated).toBe(false);

      remote.resolve([remoteWorkspace]);
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });

      expect(result.current.hydrated).toBe(true);
      expect(result.current.projects.map((project) => project.id)).toEqual(['ws-remote-slow']);
      expect(result.current.activeProjectId).toBe('ws-remote-slow');
    });
  });

  describe('active tree eager-load budget', () => {
    const rowWithTree = {
      ...backendWorkspaceRow,
      workspace: { ...backendWorkspaceRow.workspace, active_tree_id: 't-1' },
      trees: [{ id: 't-1', workspace_id: 'ws-1', root_node_id: 'n1', created_at: 1 }],
      nodes: [{ id: 'n1', tree_id: 't-1', created_at: 1, message_count: 2 }],
    };

    it('paints with placeholders instead of waiting on a slow active tree', async () => {
      const slowTree = deferred<unknown[]>();
      apiMocks.fetchAllWorkspacesMeta.mockResolvedValue([rowWithTree]);
      apiMocks.fetchTreeMessages.mockReturnValue(slowTree.promise as Promise<never[]>);

      const { result } = renderHook(() => useHarness());
      await act(async () => { await vi.advanceTimersByTimeAsync(ACTIVE_TREE_EAGER_BUDGET_MS - 1); });
      expect(result.current.hydrated).toBe(false);

      await act(async () => { await vi.advanceTimersByTimeAsync(2); });
      expect(result.current.hydrated).toBe(true);
      expect(result.current.projectsCount).toBe(1);
      // The tree is left to the lazy loader — never a hard failure.
      slowTree.resolve([]);
      await act(async () => { await Promise.resolve(); });
    });

    it('waits for a fast active tree so first paint has real messages', async () => {
      apiMocks.fetchAllWorkspacesMeta.mockResolvedValue([rowWithTree]);
      apiMocks.fetchTreeMessages.mockResolvedValue([]);

      const { result } = renderHook(() => useHarness());
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });

      expect(apiMocks.fetchTreeMessages).toHaveBeenCalledWith('ws-1', 't-1', undefined);
      expect(result.current.hydrated).toBe(true);
    });
  });

  it('still finalizes an empty DB when the backend answers with []', async () => {
    // Regression guard: a genuine empty DB (HTTP 200 → []) must finalize so the
    // legitimate first-run "create a workspace" flow still works.
    apiMocks.fetchAllWorkspacesMeta.mockResolvedValue([]);

    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(result.current.hydrated).toBe(true);
    expect(result.current.projectsCount).toBe(0);
  });

  it('starts meta hydration immediately and does not gate readiness on the advisory capability probe', async () => {
    const capability = deferred<typeof V2_CAPABILITIES>();
    apiMocks.fetchPersistenceCapabilities.mockReturnValue(capability.promise);
    apiMocks.fetchAllWorkspacesMeta.mockResolvedValue([]);

    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });

    expect(apiMocks.fetchAllWorkspacesMeta).toHaveBeenCalledTimes(1);
    expect(result.current.hydrated).toBe(true);

    capability.resolve(V2_CAPABILITIES);
    await act(async () => { await Promise.resolve(); });
  });
});
