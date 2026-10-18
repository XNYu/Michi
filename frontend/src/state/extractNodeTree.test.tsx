import { useRef, useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatNodeState, Project } from './chatTypes';

const mocks = vi.hoisted(() => ({ extract: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('../services/api', () => ({ extractNodeTree: mocks.extract }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: mocks.error, warning: mocks.warning } }));
import { useExtractNodeTree } from './extractNodeTree';

function useHarness(overrides: Partial<ChatNodeState> = {}) {
  const [projects, setProjects] = useState<Project[]>([{ id: 'ws', name: 'Workspace', createdAt: 1,
    chatIds: ['root', 'child', 'leaf'], activeTreeId: 'old',
    trees: [{ id: 'old', rootNodeId: 'root', createdAt: 1, lastActiveAt: 1 }],
    edges: [{ source: 'root', target: 'child', anchorMessageId: 'root-a' }, { source: 'child', target: 'leaf', anchorMessageId: 'own' },
      { source: 'child', target: 'root', kind: 'link' }],
  }]);
  const [nodes, setNodes] = useState<Record<string, ChatNodeState>>(() => Object.fromEntries(['root', 'child', 'leaf'].map((id, i) => [id, {
    nodeId: id, projectId: 'ws', kind: 'chat', chatId: id, status: 'idle', messages: [], messagesLoaded: false, followUps: [],
    parentNodeId: i ? ['root', 'child'][i - 1] : undefined, ...(id === 'child' ? overrides : {}),
  }])));
  const projectsRef = useRef(projects); projectsRef.current = projects;
  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  const activeProjectIdRef = useRef<string | null>('ws');
  const commandsInFlightRef = useRef(new Set<string>());
  const boundSessionsRef = useRef(new Set(['child']));
  const spies = useRef({ prunePaneIds: vi.fn(), setPaneSlot: vi.fn(), setFocusedNodeId: vi.fn(), setSelection: vi.fn(), bumpStructureVersion: vi.fn() }).current;
  const extract = useExtractNodeTree({ projectsRef, nodesRef, activeProjectIdRef, commandsInFlightRef, boundSessionsRef,
    setProjects, setNodes, selectProject: vi.fn(), runWorkspaceMutation: async (_id, run) => run(), ...spies });
  return { extract, projects, nodes, ...spies, commandsInFlightRef, boundSessionsRef };
}

describe('extractNodeTree action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extract.mockImplementation(async (_workspaceId: string, nodeId: string, treeId: string) => ({
      tree: { id: treeId, root_node_id: nodeId, workspace_id: 'ws', name: 'Child', created_at: 2, last_active_at: 2 },
      nodeIds: ['child', 'leaf'], messages: [
        { id: 'inherited', node_id: 'child', role: 'user', content: 'Parent history', seq: 0, created_at: 1 },
        { id: 'own', node_id: 'child', role: 'assistant', content: 'Child answer', seq: 1, created_at: 2 },
      ],
    }));
  });

  it('installs authoritative history even when lazy bodies are unloaded, moves panes, and retains child anchors', async () => {
    const { result } = renderHook(() => useHarness());
    await act(() => result.current.extract('child'));
    expect(result.current.nodes.child.messages.map(m => m.id)).toEqual(['inherited', 'own']);
    expect(result.current.nodes.child.messagesLoaded).toBe(true);
    expect(result.current.nodes.child.parentNodeId).toBeUndefined();
    expect(result.current.nodes.child.chatId).toBeNull();
    expect(result.current.nodes.leaf.parentNodeId).toBe('child');
    expect(result.current.nodes.root.messages).toEqual([]);
    expect(result.current.projects[0].trees).toHaveLength(2);
    expect(result.current.projects[0].edges).toEqual([
      { source: 'child', target: 'leaf', anchorMessageId: 'own' },
    ]);
    expect(result.current.prunePaneIds).toHaveBeenCalledWith(new Set(['child', 'leaf']));
    expect(result.current.setPaneSlot).toHaveBeenCalledWith('ws', result.current.projects[0].activeTreeId, ['child'], 'child');
    expect(result.current.boundSessionsRef.current.has('child')).toBe(false);
    expect(result.current.commandsInFlightRef.current.size).toBe(0);
  });

  it('keeps local graph/history on failure and reuses the operation identity when retried', async () => {
    mocks.extract.mockRejectedValueOnce(new Error('Offline'));
    const { result } = renderHook(() => useHarness());
    const before = result.current.projects;
    await act(() => result.current.extract('child'));
    expect(result.current.projects).toBe(before);
    expect(result.current.nodes.child.parentNodeId).toBe('root');
    expect(result.current.commandsInFlightRef.current.size).toBe(0);
    await act(() => result.current.extract('child'));
    expect(mocks.extract.mock.calls[0][2]).toBe(mocks.extract.mock.calls[1][2]);
    expect(result.current.projects[0].trees).toHaveLength(2);
  });

  it('does not extract a root or a node with an active/draining reply', async () => {
    const { result } = renderHook(() => useHarness({ backgroundTurnAssistantId: 'draining' }));
    await act(() => result.current.extract('root'));
    await act(() => result.current.extract('child'));
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.warning).toHaveBeenCalled();
  });
});
