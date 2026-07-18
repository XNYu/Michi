import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import type { ChatNodeState, Project } from './chatTypes';

const apiMocks = vi.hoisted(() => ({
  applyWorkspaceCommands: vi.fn(async () => {}),
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
  activeTreeId: 't1', contexts: [],
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
  nodesRef.current = nodes;
  useWorkspacePersistence({
    projects, activeProjectId, nodes, structureVersion, hydrated, nodesRef,
    setProjects, setActiveProjectId, setNodes, setHydrated,
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
