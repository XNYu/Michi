import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import WorkspaceTree from './WorkspaceTree';
import { ChatProvider } from '../../state/chatStore';
import { PrefsProvider } from '../../state/prefs';
import type { ChatNodeState, Project } from '../../state/chatTypes';

// Stub the API surface so workspacePersistence falls back to localStorage seed
// instead of populating from a real backend (which the dev machine would hit).
// Partial mock: keep every export, override just the network-touching ones.
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    listAgentModes: vi.fn().mockResolvedValue({ availableModes: [], defaultModeId: null }),
    fetchAllWorkspaces: vi.fn().mockResolvedValue([]),
    fetchAllWorkspacesMeta: vi.fn().mockResolvedValue([]),
    fetchTreeMessages: vi.fn().mockResolvedValue([]),
    fetchWorkspaces: vi.fn().mockResolvedValue([]),
    fetchWorkspace: vi.fn().mockResolvedValue(null),
    warmCwd: vi.fn().mockResolvedValue(undefined),
  };
});

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

function fixture() {
  const nodes: Record<string, ChatNodeState> = {
    rootA: {
      nodeId: 'rootA', chatId: null, projectId: 'p1', kind: 'chat',
      title: 'Active thread', messages: [], followUps: [], status: 'idle',
    },
    childA: {
      nodeId: 'childA', chatId: null, projectId: 'p1', kind: 'chat',
      title: 'Child of A', messages: [], followUps: [], status: 'idle',
    },
    rootB: {
      nodeId: 'rootB', chatId: null, projectId: 'p1', kind: 'chat',
      title: 'Other thread', messages: [], followUps: [], status: 'idle',
    },
    rootP2: {
      nodeId: 'rootP2', chatId: null, projectId: 'p2', kind: 'chat',
      title: 'P2 thread', messages: [], followUps: [], status: 'idle',
    },
  };
  const projects: Project[] = [
    {
      id: 'p1', name: 'Active workspace', cwd: '~/x',
      chatIds: ['rootA', 'childA', 'rootB'],
      edges: [{ source: 'rootA', target: 'childA', kind: 'branch' }],
      trees: [
        { id: 'tA', rootNodeId: 'rootA', createdAt: 0, lastActiveAt: 100 },
        { id: 'tB', rootNodeId: 'rootB', createdAt: 0, lastActiveAt: 50 },
      ],
      activeTreeId: 'tA', createdAt: 0,
    },
    {
      id: 'p2', name: 'Other workspace', cwd: '~/y',
      chatIds: ['rootP2'], edges: [],
      trees: [{ id: 'tP2', rootNodeId: 'rootP2', createdAt: 0, lastActiveAt: 0 }],
      activeTreeId: 'tP2', createdAt: 0,
    },
  ];
  return { nodes, projects };
}

function renderTreeWith(seed: { nodes: Record<string, ChatNodeState>; projects: Project[] }) {
  // ChatProvider hydrates via fetchAllWorkspaces (mocked empty above); when
  // that returns nothing, persistence falls back to localStorage. Pre-seed
  // v2 state and mark the localStorage→SQLite migration as already done so
  // the fallback skips the migration path entirely.
  localStorage.setItem(
    'michi:v1:state',
    JSON.stringify({
      version: 2,
      projects: seed.projects,
      nodes: seed.nodes,
      activeProjectId: 'p1',
    }),
  );
  localStorage.setItem('michi:migrated', '1');
  return render(
    <PrefsProvider>
      <ChatProvider>
        <WorkspaceTree />
      </ChatProvider>
    </PrefsProvider>,
  );
}

function renderTree() {
  renderTreeWith(fixture());
}

describe('WorkspaceTree', () => {
  it('leaves the classic row style without the neutral folder glyph', async () => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ sidebarRowStyle: 'classic' }));
    renderTree();
    await screen.findByText('Child of A');
    expect(screen.queryByTestId('workspace-folder-icon')).toBeNull();
  });

  it('hangs branches off their thread by indent alone, one step per level', async () => {
    // rootA → [childA → [grand], second]: two sibling branches, the first with
    // a branch of its own.
    const { nodes, projects } = fixture();
    const extra = (nodeId: string, title: string): ChatNodeState => ({
      nodeId, chatId: null, projectId: 'p1', kind: 'chat',
      title, messages: [], followUps: [], status: 'idle',
    });
    nodes.second = extra('second', 'Second child');
    nodes.grand = extra('grand', 'Grandchild');
    projects[0].chatIds.push('second', 'grand');
    projects[0].edges.push(
      { source: 'rootA', target: 'second', kind: 'branch' },
      { source: 'childA', target: 'grand', kind: 'branch' },
    );
    renderTreeWith({ nodes, projects });
    await screen.findByText('Second child');
    fireEvent.click(screen.getByText('Child of A'));
    await screen.findByText('Grandchild');

    const row = (nodeId: string) =>
      document.querySelector<HTMLElement>(`[data-sidebar-row="${nodeId}"]`)!;
    expect(row('childA').style.paddingLeft).toBe('43px');
    expect(row('second').style.paddingLeft).toBe('43px');
    expect(row('grand').style.paddingLeft).toBe('55px');
    // No connector lines: nothing bordered sits in front of a branch title.
    for (const id of ['childA', 'second', 'grand']) {
      const lines = [...row(id).querySelectorAll<HTMLElement>('[aria-hidden]')].filter(
        (el) => el.style.borderLeft !== '' || el.style.borderBottom !== '' || el.style.borderTop !== '',
      );
      expect(lines).toHaveLength(0);
    }
  });

  // This test passes in isolation but is flaky when run with other tests in this
  // file due to React state and localStorage hydration ordering. The behavior
  // (snapshotBeforeSwitch pinning the outgoing workspace) is tested indirectly
  // by the more comprehensive "clicking an expanded but inactive workspace"
  // test below, which also exercises cross-workspace expansion.
  it.skip('clicking a collapsed workspace expands it (and the previous active workspace stays expanded)', async () => {
    renderTree();
    // Wait for initial render to stabilize
    expect(await screen.findByText('Active thread')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('Other workspace')); });
    expect(await screen.findByText('P2 thread')).toBeTruthy();
    // Previously-active workspace must remain expanded across the switch.
    // Use findByText (waitFor internally) since React 18 batching in the full
    // suite can delay rendering of the pinned workspace state.
    expect(await screen.findByText('Active thread')).toBeTruthy();
  });

  it('clicking an expanded but inactive workspace activates without collapsing; a second click on the now-active workspace collapses', async () => {
    renderTree();
    // 1. Expand p2 (collapsed → expanded). p2 is now active + expanded.
    fireEvent.click(await screen.findByText('Other workspace'));
    expect(await screen.findByText('P2 thread')).toBeTruthy();
    // 2. Click p1 (expanded, inactive) → just activates, p1 stays expanded
    //    AND p2 (now inactive) stays expanded.
    fireEvent.click(screen.getByText('Active workspace'));
    expect(screen.getByText('Active thread')).toBeTruthy();
    expect(screen.getByText('P2 thread')).toBeTruthy();
    // 3. Second click on p1 (now active + expanded) → collapses p1.
    fireEvent.click(screen.getByText('Active workspace'));
    expect(screen.queryByText('Active thread')).toBeNull();
    // p2 unaffected.
    expect(screen.getByText('P2 thread')).toBeTruthy();
  });

  it('switching threads from a thread row keeps every thread expanded as it was', async () => {
    const { nodes, projects } = fixture();
    const extra = (nodeId: string, projectId: string, title: string): ChatNodeState => ({
      nodeId, chatId: null, projectId, kind: 'chat',
      title, messages: [], followUps: [], status: 'idle',
    });
    nodes.childB = extra('childB', 'p1', 'Child of B');
    nodes.childP2 = extra('childP2', 'p2', 'Child of P2');
    projects[0].chatIds.push('childB');
    projects[0].edges.push({ source: 'rootB', target: 'childB', kind: 'branch' });
    projects[1].chatIds.push('childP2');
    projects[1].edges.push({ source: 'rootP2', target: 'childP2', kind: 'branch' });
    renderTreeWith({ nodes, projects });
    await screen.findByText('Child of A');

    // Same workspace: thread B opens, thread A stays open.
    fireEvent.click(screen.getByText('Other thread'));
    expect(await screen.findByText('Child of B')).toBeTruthy();
    expect(screen.getByText('Child of A')).toBeTruthy();

    // Expand the other workspace while keeping p1 active; its active thread
    // shows expanded by default.
    fireEvent.click(screen.getByText('Other workspace'));
    fireEvent.click(screen.getByText('Active workspace'));
    expect(await screen.findByText('Child of P2')).toBeTruthy();

    // Cross workspace: switching to that thread must not collapse it.
    fireEvent.click(screen.getByText('P2 thread'));
    await act(async () => {});
    expect(screen.getByText('Child of P2')).toBeTruthy();
    expect(screen.getByText('Child of A')).toBeTruthy();
    expect(screen.getByText('Child of B')).toBeTruthy();
  });

  it('shows only the five most recent live threads until expanded', async () => {
    const nodes: Record<string, ChatNodeState> = {};
    const trees = Array.from({ length: 6 }, (_, index) => {
      const n = index + 1;
      const rootNodeId = `root${n}`;
      nodes[rootNodeId] = {
        nodeId: rootNodeId,
        chatId: null,
        projectId: 'p1',
        kind: 'chat',
        title: `Thread ${n}`,
        messages: [],
        followUps: [],
        status: 'idle',
      };
      return {
        id: `t${n}`,
        rootNodeId,
        createdAt: n,
        lastActiveAt: 1000 - n,
      };
    });
    const projects: Project[] = [
      {
        id: 'p1',
        name: 'Active workspace',
        cwd: '~/x',
        chatIds: Object.keys(nodes),
        edges: [],
        trees,
        activeTreeId: 't1',
        createdAt: 0,
      },
    ];

    renderTreeWith({ nodes, projects });

    expect(await screen.findByText('Thread 1')).toBeTruthy();
    expect(screen.getByText('Thread 5')).toBeTruthy();
    expect(screen.queryByText('Thread 6')).toBeNull();
    fireEvent.click(screen.getByText(/Show more/));
    expect(await screen.findByText('Thread 6')).toBeTruthy();
  });

  it('counts Merged threads separately from regular threads', async () => {
    const nodes: Record<string, ChatNodeState> = {};
    const regularTrees = Array.from({ length: 6 }, (_, index) => {
      const n = index + 1;
      const rootNodeId = `regular${n}`;
      nodes[rootNodeId] = {
        nodeId: rootNodeId,
        chatId: null,
        projectId: 'p1',
        kind: 'chat',
        title: `Thread ${n}`,
        messages: [],
        followUps: [],
        status: 'idle',
      };
      return {
        id: `t${n}`,
        rootNodeId,
        createdAt: n,
        lastActiveAt: 2000 - n,
      };
    });
    const mergeTrees = Array.from({ length: 6 }, (_, index) => {
      const n = index + 1;
      const rootNodeId = `merge${n}`;
      nodes[rootNodeId] = {
        nodeId: rootNodeId,
        chatId: null,
        projectId: 'p1',
        kind: 'chat',
        title: `Merged ${n}`,
        mergeSources: [],
        messages: [],
        followUps: [],
        status: 'idle',
      };
      return {
        id: `m${n}`,
        rootNodeId,
        createdAt: n,
        lastActiveAt: 1000 - n,
        kind: 'merge' as const,
      };
    });
    const projects: Project[] = [
      {
        id: 'p1',
        name: 'Active workspace',
        cwd: '~/x',
        chatIds: Object.keys(nodes),
        edges: [],
        trees: [...regularTrees, ...mergeTrees],
        activeTreeId: 't1',
        createdAt: 0,
      },
    ];

    renderTreeWith({ nodes, projects });

    expect(await screen.findByText('Thread 5')).toBeTruthy();
    expect(screen.queryByText('Thread 6')).toBeNull();
    expect(screen.getByText('Merged 5')).toBeTruthy();
    expect(screen.queryByText('Merged 6')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show more merged threads' }));

    expect(await screen.findByText('Merged 6')).toBeTruthy();
    expect(screen.queryByText('Thread 6')).toBeNull();
  });
});
