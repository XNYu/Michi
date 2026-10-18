import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import type { ChatNodeState, Project } from './chatTypes';
import type { WorkspaceCommand } from '../services/api';

const apiMocks = vi.hoisted(() => ({
  applyWorkspaceCommands: vi.fn(async (_workspaceId: string, _operationId: string, _commands: readonly WorkspaceCommand[]) => {}),
}));

vi.mock('../services/api', () => ({
  fetchPersistenceCapabilities: vi.fn(async () => ({
    protocolVersion: 2,
    authoritativeTurnPersistence: true,
    durableNodePrerequisite: true,
    explicitCommands: true,
    backgroundWorkspaceSync: false,
    legacySyncAccepted: true,
  })),
  fetchAllWorkspaces: vi.fn(() => new Promise(() => {})),
  fetchWorkspace: vi.fn(),
  fetchWorkspaces: vi.fn(),
  applyWorkspaceCommands: apiMocks.applyWorkspaceCommands,
}));

import { stateProjectKey, stateIndexKey, useWorkspacePersistence } from './workspacePersistence';

const project: Project = {
  id: 'ws-1', name: 'Workspace', chatIds: ['n1'], edges: [], createdAt: 1,
  trees: [{ id: 't1', rootNodeId: 'n1', createdAt: 1, lastActiveAt: 1 }],
  activeTreeId: 't1', artifacts: [],
};
const node: ChatNodeState = {
  nodeId: 'n1', projectId: 'ws-1', kind: 'chat', chatId: null,
  messages: [], followUps: [], status: 'idle',
};

function useHarness() {
  const [projects, setProjects] = useState([project]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>('ws-1');
  const [nodes, setNodes] = useState<Record<string, ChatNodeState>>({ n1: node });
  const [hydrated, setHydrated] = useState(true);
  const [structureVersion, setStructureVersion] = useState(0);
  const nodeReads = useRef(0);
  const nodesRef = useRef(nodes);
  const dirtyDraftNodeIdsRef = useRef(new Set<string>());
  const syncPausedRef = useRef(false);
  nodesRef.current = nodes;
  const { runWorkspaceMutation } = useWorkspacePersistence({
    projects, activeProjectId, nodes, structureVersion, hydrated, nodesRef,
    setProjects, setActiveProjectId, setNodes, setHydrated,
    dirtyDraftNodeIdsRef, syncPausedRef, windowId: 'window-a',
  });
  const trackedNodes = (nextNode: ChatNodeState): Record<string, ChatNodeState> => new Proxy({
    n1: nextNode,
  }, {
    get(target, property, receiver) {
      if (property === 'n1') nodeReads.current += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    runWorkspaceMutation,
    rename(name: string) { setProjects(prev => prev.map(p => ({ ...p, name }))); },
    editDraft(value: string) {
      setNodes({ n1: { ...node, composerDraft: value ? { value, mentions: [] } : undefined } });
      dirtyDraftNodeIdsRef.current.add('n1');
    },
    streamChunk() {
      setNodes(trackedNodes({
        ...node,
        status: 'streaming',
        messages: [{ id: 'a1', role: 'assistant', text: '', toolCalls: [], blocks: [{ id: 'a1-b-0', kind: 'answer', rawText: 'chunk', streaming: true }], streaming: true }],
      }));
    },
    finishStream() {
      setNodes(trackedNodes({
        ...node,
        title: 'Finished',
        status: 'idle',
      }));
      setStructureVersion((version) => version + 1);
    },
    renameWorkspace(name: string) {
      setProjects((prev) => prev.map((candidate) => candidate.id === 'ws-1'
        ? { ...candidate, name }
        : candidate));
    },
    nodeReads: () => nodeReads.current,
    resetNodeReads: () => { nodeReads.current = 0; },
  };
}

describe('v2 authoritative workspace persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    apiMocks.applyWorkspaceCommands.mockClear();
    Object.defineProperty(window, 'requestIdleCallback', { configurable: true, value: undefined });
  });

  afterEach(() => vi.useRealTimers());

  it('flushes structural prerequisites before a mutation and pauses periodic writes until it finishes', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.rename('Before extraction'));
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const mutate = vi.fn(() => waiting);
    let pending!: Promise<void>;
    await act(async () => { pending = result.current.runWorkspaceMutation('ws-1', mutate); await Promise.resolve(); });
    expect(apiMocks.applyWorkspaceCommands.mock.calls[0][2][0].payload.name).toBe('Before extraction');
    expect(mutate).toHaveBeenCalledOnce();
    act(() => result.current.rename('During extraction'));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(apiMocks.applyWorkspaceCommands).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); await pending; });
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(apiMocks.applyWorkspaceCommands.mock.calls[1][2][0].payload.name).toBe('During extraction');
  });

  it('does not run a mutation when prerequisite persistence fails, and releases the pause for retry', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.rename('Unsaved'));
    apiMocks.applyWorkspaceCommands.mockRejectedValueOnce(new Error('Offline'));
    const mutate = vi.fn(async () => {});
    await act(async () => { await expect(result.current.runWorkspaceMutation('ws-1', mutate)).rejects.toThrow('Offline'); });
    expect(mutate).not.toHaveBeenCalled();
    await act(async () => { await result.current.runWorkspaceMutation('ws-1', mutate); });
    expect(mutate).toHaveBeenCalledOnce();
  });

  it('uses explicit commands and never writes /sync or the durable localStorage mirror', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.streamChunk());
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(apiMocks.applyWorkspaceCommands).not.toHaveBeenCalled();
    expect(localStorage.getItem(stateIndexKey('michi:v1:state'))).toBeNull();
    expect(localStorage.getItem(stateProjectKey('michi:v1:state', 'ws-1'))).toBeNull();

    act(() => window.dispatchEvent(new Event('beforeunload')));
  });

  it('saves and clears draft edits even when the structural version stays fixed', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.editDraft('unsent draft'));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(apiMocks.applyWorkspaceCommands).toHaveBeenCalledTimes(1);
    const commands = apiMocks.applyWorkspaceCommands.mock.calls[0][2];
    expect(commands).toEqual([{ type: 'node.patch', payload: {
      id: 'n1', composer_draft_window_id: 'window-a', composer_draft: JSON.stringify({ value: 'unsent draft', mentions: [] }),
    } }]);
    act(() => result.current.editDraft(''));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(apiMocks.applyWorkspaceCommands).toHaveBeenCalledTimes(2);
    expect(apiMocks.applyWorkspaceCommands.mock.calls[1][2][0].payload.composer_draft).toBeNull();
  });

  it('does not scan the node graph for high-frequency stream-only renders', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });

    result.current.resetNodeReads();
    act(() => result.current.streamChunk());
    expect(result.current.nodeReads()).toBe(0);

    // Advancing only the structural channel must cross the persistence
    // boundary and read the latest node snapshot.
    result.current.resetNodeReads();
    act(() => result.current.finishStream());
    expect(result.current.nodeReads()).toBeGreaterThan(0);
  });

  it('flushes an immediate-close domain mutation with an explicit command beacon, never /sync', async () => {
    const sendBeacon = vi.fn<(url: string | URL, data?: BodyInit | null) => boolean>(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: sendBeacon });
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.renameWorkspace('Renamed'));
    act(() => window.dispatchEvent(new Event('beforeunload')));

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, body] = sendBeacon.mock.calls[0];
    expect(String(url)).toContain('/workspaces/ws-1/commands');
    expect(String(url)).not.toContain('/sync');
    expect(body).toBeInstanceOf(Blob);
  });
});
