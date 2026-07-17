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

const apiMocks = vi.hoisted(() => ({
  fetchPersistenceCapabilities: vi.fn(),
  fetchAllWorkspacesMeta: vi.fn(),
  fetchTreeMessages: vi.fn(async () => []),
  fetchWorkspaces: vi.fn(),
  fetchWorkspace: vi.fn(),
  applyWorkspaceCommands: vi.fn(async () => {}),
}));

vi.mock('../services/api', () => ({
  fetchPersistenceCapabilities: apiMocks.fetchPersistenceCapabilities,
  fetchAllWorkspacesMeta: apiMocks.fetchAllWorkspacesMeta,
  fetchTreeMessages: apiMocks.fetchTreeMessages,
  fetchWorkspaces: apiMocks.fetchWorkspaces,
  fetchWorkspace: apiMocks.fetchWorkspace,
  applyWorkspaceCommands: apiMocks.applyWorkspaceCommands,
}));

import { useWorkspacePersistence } from './workspacePersistence';

const V2_CAPABILITIES = {
  protocolVersion: 2,
  authoritativeTurnPersistence: true,
  durableNodePrerequisite: true,
  explicitCommands: true,
  backgroundWorkspaceSync: false,
  legacySyncAccepted: true,
};

/** Minimal backend `/workspaces/all` row that hydrates into exactly one project. */
const backendWorkspaceRow = {
  workspace: { id: 'ws-1', name: 'Recovered', created_at: 1 },
  nodes: [{ id: 'n1', created_at: 1 }],
  trees: [],
  edges: [],
  messages: [],
  contexts: [],
};

/**
 * Mirror the real chatStore mount: hydrated STARTS false and only the hook may
 * flip it. The two existing hydration harnesses start hydrated=true, so they
 * never drive this transition — this one does.
 */
function useHarness() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<Record<string, ChatNodeState>>({});
  const [hydrated, setHydrated] = useState(false);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  useWorkspacePersistence({
    projects, activeProjectId, nodes, hydrated, nodesRef,
    setProjects, setActiveProjectId, setNodes, setHydrated,
  });
  return { hydrated, projectsCount: projects.length };
}

describe('cold-start hydration barrier', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    apiMocks.fetchPersistenceCapabilities.mockResolvedValue(V2_CAPABILITIES);
    apiMocks.fetchAllWorkspacesMeta.mockReset();
    apiMocks.fetchTreeMessages.mockResolvedValue([]);
    apiMocks.fetchWorkspaces.mockResolvedValue([]);
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
});
