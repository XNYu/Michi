import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import type { ChatNodeState, Project } from './chatTypes';

const apiMocks = vi.hoisted(() => ({
  applyWorkspaceCommands: vi.fn(),
}));

vi.mock('../services/api', () => ({
  fetchPersistenceCapabilities: vi.fn().mockRejectedValue(new Error('backend still starting')),
  fetchAllWorkspaces: vi.fn(() => new Promise(() => {})),
  fetchWorkspace: vi.fn(),
  fetchWorkspaces: vi.fn(),
  applyWorkspaceCommands: apiMocks.applyWorkspaceCommands,
}));

import { useWorkspacePersistence } from './workspacePersistence';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const project: Project = {
  id: 'ws-1',
  name: 'Workspace',
  chatIds: ['n-1'],
  edges: [],
  trees: [{ id: 't-1', rootNodeId: 'n-1', createdAt: 1, lastActiveAt: 1 }],
  activeTreeId: 't-1',
  artifacts: [],
  createdAt: 1,
};

const initialNode: ChatNodeState = {
  nodeId: 'n-1', projectId: 'ws-1', kind: 'chat', chatId: null,
  messages: [], followUps: [], status: 'idle',
};

function usePersistenceHarness() {
  const [projects, setProjects] = useState<Project[]>([project]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>('ws-1');
  const [nodes, setNodes] = useState<Record<string, ChatNodeState>>({ 'n-1': initialNode });
  const [hydrated, setHydrated] = useState(true);
  const [structureVersion] = useState(0);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  useWorkspacePersistence({
    projects, activeProjectId, nodes, structureVersion, hydrated, nodesRef,
    setProjects, setActiveProjectId, setNodes, setHydrated,
  });

  return {
    setName(name: string) {
      setProjects((prev) => prev.map((candidate) => candidate.id === 'ws-1'
        ? { ...candidate, name }
        : candidate));
    },
  };
}

describe('useWorkspacePersistence v2 command queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiMocks.applyWorkspaceCommands.mockReset();
    localStorage.clear();
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => vi.useRealTimers());

  it('never revives legacy sync when the capability probe races backend startup', async () => {
    apiMocks.applyWorkspaceCommands.mockResolvedValue(undefined);
    const { result } = renderHook(() => usePersistenceHarness());
    await act(async () => { await Promise.resolve(); });

    act(() => result.current.setName('v2-only'));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(apiMocks.applyWorkspaceCommands).toHaveBeenCalledTimes(1);
    const commands = apiMocks.applyWorkspaceCommands.mock.calls[0][2] as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'workspace.upsert',
        payload: expect.objectContaining({ id: 'ws-1', name: 'v2-only' }),
      }),
    ]));
  });

  it('keeps explicit command writes single-flight and coalesces the pending state', async () => {
    const first = deferred<void>();
    apiMocks.applyWorkspaceCommands
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => usePersistenceHarness());
    await act(async () => { await Promise.resolve(); });

    act(() => result.current.setName('first'));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(apiMocks.applyWorkspaceCommands).toHaveBeenCalledTimes(1);

    act(() => result.current.setName('second'));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    act(() => result.current.setName('latest'));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(apiMocks.applyWorkspaceCommands).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.applyWorkspaceCommands).toHaveBeenCalledTimes(2);
    const commands = apiMocks.applyWorkspaceCommands.mock.calls[1][2] as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'workspace.upsert',
        payload: expect.objectContaining({ id: 'ws-1', name: 'latest' }),
      }),
    ]));
  });
});
