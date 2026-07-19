import React from 'react';
import dagre from '@dagrejs/dagre';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalMap from './Map';

const createMergedChat = vi.hoisted(() => vi.fn(async () => 'merged'));
const clearSelection = vi.hoisted(() => vi.fn());
const storeState = vi.hoisted(() => ({
  project: null as any,
  nodes: {} as Record<string, any>,
  selection: new Set<string>(),
}));

vi.mock('../../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../../state/chatStore');
  return {
    ...actual,
    useChatStore: () => ({
      activeProject: storeState.project,
      edges: storeState.project?.edges ?? [],
      openPane: vi.fn(),
      toggleSelection: vi.fn(),
      clearSelection,
      selection: storeState.selection,
      createBlankChild: vi.fn(),
      deleteNode: vi.fn(),
      trimNode: vi.fn(),
      archiveNode: vi.fn(),
      createMergedChat,
      createDigest: vi.fn(),
      archiveTree: vi.fn(),
      activateTree: vi.fn(),
    }),
    useChatNodesSnapshot: () => storeState.nodes,
    useStructuralSelector: (selector: (nodes: Record<string, any>) => unknown) => selector(storeState.nodes),
    chatLabel: (node: any) => node?.title ?? '',
  };
});

function node(id: string, status: 'idle' | 'streaming' = 'idle') {
  return {
    nodeId: id,
    projectId: 'p1',
    kind: 'chat',
    title: `Node ${id}`,
    status,
    messages: [],
    followUps: [],
    createdAt: 0,
  };
}

function sameTreeProject() {
  return {
    id: 'p1',
    name: 'Workspace',
    chatIds: ['n1', 'n2'],
    edges: [{ source: 'n1', target: 'n2', kind: 'branch' }],
    createdAt: 0,
    trees: [{ id: 't1', rootNodeId: 'n1', createdAt: 0, lastActiveAt: 0 }],
    activeTreeId: 't1',
    contexts: [],
  };
}

beforeEach(() => {
  createMergedChat.mockClear();
  clearSelection.mockClear();
  storeState.project = sameTreeProject();
  storeState.nodes = { n1: node('n1'), n2: node('n2') };
  storeState.selection = new Set(['n1', 'n2']);
});

describe('Map selection actions', () => {
  it('reuses the dagre layout when only labels or project metadata change', () => {
    const layout = vi.spyOn(dagre, 'layout');
    try {
      const view = render(<TerminalMap />);
      const initialCalls = layout.mock.calls.length;
      expect(initialCalls).toBeGreaterThan(0);

      storeState.project = { ...storeState.project, name: 'Renamed workspace' };
      storeState.nodes = {
        ...storeState.nodes,
        n1: { ...storeState.nodes.n1, title: 'Renamed node' },
      };
      view.rerender(<TerminalMap />);

      expect(layout).toHaveBeenCalledTimes(initialCalls);
    } finally {
      layout.mockRestore();
    }
  });

  it('recomputes dagre layout when branch topology changes', () => {
    const layout = vi.spyOn(dagre, 'layout');
    try {
      const view = render(<TerminalMap />);
      const initialCalls = layout.mock.calls.length;

      storeState.project = {
        ...storeState.project,
        chatIds: [...storeState.project.chatIds, 'n3'],
        edges: [...storeState.project.edges, { source: 'n2', target: 'n3', kind: 'branch' }],
      };
      storeState.nodes = { ...storeState.nodes, n3: node('n3') };
      view.rerender(<TerminalMap />);

      expect(layout.mock.calls.length).toBeGreaterThan(initialCalls);
    } finally {
      layout.mockRestore();
    }
  });

  it('exposes Merge, Digest, Export, and Clear and wires their existing flows', async () => {
    const onNav = vi.fn();
    const digestSpy = vi.fn();
    const exportSpy = vi.fn();
    window.addEventListener('michi:digest-prompt', digestSpy as EventListener);
    window.addEventListener('michi:toggle-export-panel', exportSpy as EventListener);
    try {
      render(<TerminalMap onNav={onNav} />);

      expect(screen.getByRole('toolbar', { name: 'Map selection actions' })).not.toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
      expect(createMergedChat).toHaveBeenCalledWith(['n1', 'n2']);
      await waitFor(() => expect(onNav).toHaveBeenCalledWith('dashboard'));

      fireEvent.click(screen.getByRole('button', { name: 'Digest' }));
      expect(digestSpy).toHaveBeenCalledOnce();
      expect((digestSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({
        projectId: 'p1',
        sourceIds: ['n1', 'n2'],
      });

      fireEvent.click(screen.getByRole('button', { name: 'Export' }));
      expect(exportSpy).toHaveBeenCalledOnce();
      expect((exportSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({
        projectId: 'p1',
        nodeIds: ['n1', 'n2'],
      });

      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      expect(clearSelection).toHaveBeenCalledTimes(3);
    } finally {
      window.removeEventListener('michi:digest-prompt', digestSpy as EventListener);
      window.removeEventListener('michi:toggle-export-panel', exportSpy as EventListener);
    }
  });

  it('ignores selected nodes from other threads', () => {
    storeState.project = {
      ...sameTreeProject(),
      edges: [],
      trees: [
        { id: 't1', rootNodeId: 'n1', createdAt: 0, lastActiveAt: 0 },
        { id: 't2', rootNodeId: 'n2', createdAt: 1, lastActiveAt: 1 },
      ],
    };

    const digestSpy = vi.fn();
    window.addEventListener('michi:digest-prompt', digestSpy as EventListener);
    render(<TerminalMap />);

    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Digest' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('Node n2')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Digest' }));
    expect((digestSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({
      projectId: 'p1',
      sourceIds: ['n1'],
    });
    window.removeEventListener('michi:digest-prompt', digestSpy as EventListener);
  });

  it('disables Merge and Digest while any selected node is streaming', () => {
    storeState.nodes.n2 = node('n2', 'streaming');

    render(<TerminalMap />);

    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Digest' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
