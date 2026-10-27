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
  const { runWorkspaceMutation, noteBackendInstalled, pendingBackendDeletes } = useWorkspacePersistence({
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
    pendingBackendDeletes,
    projects,
    noteBackendInstalled,
    dropTree(treeId: string) {
      setProjects((prev) => prev.map((p) => (p.id === 'ws-1' ? { ...p, trees: p.trees.filter((t) => t.id !== treeId) } : p)));
    },
    /** The install's state change alone (as a later render would bring it). */
    land(fresh: { project: Project; nodes: Record<string, ChatNodeState> }) {
      setProjects((prev) => [...prev, fresh.project]);
      setNodes((prev) => ({ ...prev, ...fresh.nodes }));
      setStructureVersion((version) => version + 1);
    },
    /** Any other change to one workspace (and its nodes). */
    change(projectId: string, update: (p: Project) => Project, freshNodes: Record<string, ChatNodeState> = {}) {
      setProjects((prev) => prev.map((p) => (p.id === projectId ? update(p) : p)));
      setNodes((prev) => ({ ...prev, ...freshNodes }));
      setStructureVersion((version) => version + 1);
    },
    rename(name: string) { setProjects(prev => prev.map(p => ({ ...p, name }))); },
    /** What installWorkspaceSnapshot does with a backend workspace: tell, then set. */
    installFromBackend(fresh: { project: Project; nodes: Record<string, ChatNodeState> }, intoExisting = false) {
      if (intoExisting) {
        noteBackendInstalled({
          projectId: 'ws-1', newProject: false,
          nodeIds: Object.keys(fresh.nodes), treeIds: fresh.project.trees.map((t) => t.id), edgeIds: [],
        });
        setProjects((prev) => prev.map((p) => (p.id === 'ws-1'
          ? { ...p, chatIds: [...p.chatIds, ...fresh.project.chatIds], trees: [...p.trees, ...fresh.project.trees] }
          : p)));
      } else {
        noteBackendInstalled({
          projectId: fresh.project.id, newProject: true,
          nodeIds: Object.keys(fresh.nodes), treeIds: fresh.project.trees.map((t) => t.id), edgeIds: [],
        });
        setProjects((prev) => [...prev, fresh.project]);
      }
      setNodes((prev) => ({ ...prev, ...fresh.nodes }));
      setStructureVersion((version) => version + 1);
    },
    /** A reply finished on n1. */
    reply(lastAssistantAt: number) {
      setNodes((prev) => ({ ...prev, n1: { ...prev.n1, lastAssistantAt } }));
      setStructureVersion((version) => version + 1);
    },
    /** What the focus effect's node-viewed does. */
    view(viewedAt: number) {
      setNodes((prev) => ({ ...prev, n1: { ...prev.n1, viewedAt } }));
      setStructureVersion((version) => version + 1);
    },
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

  it('never writes back what a backend snapshot brought in, only what changes after', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    const other: Project = {
      id: 'ws-2', name: 'Other window', chatIds: ['n2'], edges: [], createdAt: 2,
      trees: [{ id: 't2', rootNodeId: 'n2', createdAt: 2, lastActiveAt: 2 }], activeTreeId: 't2', artifacts: [],
    };
    const n2: ChatNodeState = { ...node, nodeId: 'n2', projectId: 'ws-2' };
    act(() => result.current.installFromBackend({ project: other, nodes: { n2 } }));
    // A thread made elsewhere, merged into a workspace this window has.
    const n3: ChatNodeState = { ...node, nodeId: 'n3' };
    act(() => result.current.installFromBackend({
      project: { ...project, chatIds: ['n3'], trees: [{ id: 't3', rootNodeId: 'n3', createdAt: 3, lastActiveAt: 3 }] },
      nodes: { n3 },
    }, true));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(apiMocks.applyWorkspaceCommands).not.toHaveBeenCalled();

    // A local edit afterwards still goes out.
    act(() => result.current.renameWorkspace('Edited here'));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(apiMocks.applyWorkspaceCommands).toHaveBeenCalledTimes(1);
    expect(apiMocks.applyWorkspaceCommands.mock.calls[0][0]).toBe('ws-1');
    const commands = apiMocks.applyWorkspaceCommands.mock.calls[0][2];
    expect(commands.map((c) => c.type)).toEqual(['workspace.upsert']);
  });

  it('keeps a noted install for the scan that sees it land, not one that runs before', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    const other: Project = {
      id: 'ws-2', name: 'Other window', chatIds: ['n2'], edges: [], createdAt: 2,
      trees: [{ id: 't2', rootNodeId: 'n2', createdAt: 2, lastActiveAt: 2 }], activeTreeId: 't2', artifacts: [],
    };
    const n2: ChatNodeState = { ...node, nodeId: 'n2', projectId: 'ws-2' };
    act(() => result.current.noteBackendInstalled({ projectId: 'ws-2', newProject: true, nodeIds: ['n2'], treeIds: ['t2'], edgeIds: [] }));
    // Another change's scan runs first (a commit's delayed effects).
    act(() => result.current.renameWorkspace('Edited here'));
    act(() => result.current.land({ project: other, nodes: { n2 } }));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(apiMocks.applyWorkspaceCommands.mock.calls.map((call) => call[0])).toEqual(['ws-1']);
  });

  it('keeps local edits to a workspace a scan already held when a noted new install lands there', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    const other: Project = {
      id: 'ws-2', name: 'Other window', chatIds: ['n2'], edges: [], createdAt: 2,
      trees: [{ id: 't2', rootNodeId: 'n2', createdAt: 2, lastActiveAt: 2 }], activeTreeId: 't2', artifacts: [],
    };
    const n2: ChatNodeState = { ...node, nodeId: 'n2', projectId: 'ws-2' };
    const n5: ChatNodeState = { ...node, nodeId: 'n5', projectId: 'ws-2' };
    // Two installs noted together (new workspace, then more of it) that land in two renders.
    act(() => result.current.noteBackendInstalled({ projectId: 'ws-2', newProject: true, nodeIds: ['n2', 'n5'], treeIds: ['t2', 't5'], edgeIds: [] }));
    act(() => result.current.land({ project: other, nodes: { n2 } }));
    // Edited here before the rest arrives.
    act(() => result.current.change('ws-2', (p) => ({ ...p, name: 'Renamed here' })));
    act(() => result.current.change('ws-2', (p) => ({
      ...p, chatIds: [...p.chatIds, 'n5'], trees: [...p.trees, { id: 't5', rootNodeId: 'n5', createdAt: 5, lastActiveAt: 5 }],
    }), { n5 }));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    const calls = apiMocks.applyWorkspaceCommands.mock.calls.filter((call) => call[0] === 'ws-2');
    expect(calls).toHaveLength(1);
    const commands = calls[0][2];
    // The rename goes out; nothing the installs brought in does.
    expect(commands.map((c) => c.type)).toEqual(['workspace.upsert']);
    expect(JSON.stringify(commands[0])).toContain('Renamed here');
  });

  it('counts a confirmed tree delete only for snapshot reads begun before the backend confirmed it', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.dropTree('t1'));
    const pending = (readStartedAt?: number) => [
      ...result.current.pendingBackendDeletes(result.current.projects.find((p) => p.id === 'ws-1')!, readStartedAt).treeIds,
    ];
    const readBefore = Date.now();
    // Not sent yet: every read may hold it.
    expect(pending(readBefore)).toEqual(['t1']);
    expect(pending(readBefore + 60_000)).toEqual(['t1']);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(apiMocks.applyWorkspaceCommands.mock.calls[0][2].map((c) => c.type)).toContain('tree.delete');
    const confirmedBy = Date.now();
    // A read begun before the confirmation may still hold it, however long ago it began.
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(pending(readBefore)).toEqual(['t1']);
    expect(pending(confirmedBy)).toEqual(['t1']);
    // One begun after already saw it gone: what it holds is back for real.
    expect(pending(confirmedBy + 1)).toEqual([]);
    expect(pending(Date.now())).toEqual([]);
    // When the read began is unknown, it counts.
    expect(pending()).toEqual(['t1']);
  });

  it('writes view marks on the persistence cadence: one patch with the latest mark, retried until it lands', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.reply(500));
    act(() => result.current.view(1_000));
    act(() => result.current.view(2_000));
    act(() => result.current.view(3_000));
    expect(apiMocks.applyWorkspaceCommands).not.toHaveBeenCalled();
    apiMocks.applyWorkspaceCommands.mockRejectedValueOnce(new Error('Offline'));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    const viewMark = [{ type: 'node.patch', payload: { id: 'n1', viewed_at: 3_000 } }];
    expect(apiMocks.applyWorkspaceCommands.mock.calls.map((call) => call[2])).toEqual([viewMark, viewMark]);
    act(() => result.current.view(3_000));
    act(() => result.current.view(2_500));
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(apiMocks.applyWorkspaceCommands).toHaveBeenCalledTimes(2);
  });

  it('writes no view mark for a conversation without a reply', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.view(1_000));
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(apiMocks.applyWorkspaceCommands).not.toHaveBeenCalled();
    act(() => result.current.reply(1_500));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(apiMocks.applyWorkspaceCommands.mock.calls.map((call) => call[2])).toEqual([[{ type: 'node.patch', payload: { id: 'n1', viewed_at: 1_000 } }]]);
  });

  it('sends an unsent view mark with the unload beacon', async () => {
    const sendBeacon = vi.fn<(url: string | URL, data?: BodyInit | null) => boolean>(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: sendBeacon });
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.reply(3_000));
    act(() => result.current.view(4_000));
    const parts: BlobPart[] = [];
    vi.stubGlobal('Blob', class extends Blob {
      constructor(blobParts?: BlobPart[], options?: BlobPropertyBag) { super(blobParts, options); parts.push(...(blobParts ?? [])); }
    });
    try {
      act(() => window.dispatchEvent(new Event('beforeunload')));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(parts[0])) as { commands: WorkspaceCommand[] };
    expect(body.commands).toEqual([{ type: 'node.patch', payload: { id: 'n1', viewed_at: 4_000 } }]);
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
