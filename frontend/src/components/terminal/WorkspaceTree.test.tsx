import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
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
    listModels: vi.fn().mockResolvedValue({ models: [], defaultModel: null }),
    listAgentModes: vi.fn().mockResolvedValue([]),
    fetchAllWorkspaces: vi.fn().mockResolvedValue([]),
    fetchAllWorkspacesMeta: vi.fn().mockResolvedValue([]),
    fetchTreeMessages: vi.fn().mockResolvedValue([]),
    fetchWorkspaces: vi.fn().mockResolvedValue([]),
    fetchWorkspace: vi.fn().mockResolvedValue(null),
    warmCwd: vi.fn().mockResolvedValue(undefined),
  };
});

beforeEach(() => {
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
  it('renders the active workspace expanded and others collapsed by default', async () => {
    renderTree();
    // ChatProvider hydrates asynchronously (workspacePersistence awaits a
    // backend fetch); use findBy* to wait for first paint after hydration.
    expect(await screen.findByText('Active thread')).toBeTruthy();
    expect(screen.getByText('Other thread')).toBeTruthy();
    // Other workspace's thread NOT visible (collapsed):
    expect(screen.queryByText('P2 thread')).toBeNull();
  });

  it('renders the active thread\'s direct branches but not its grandchildren', async () => {
    renderTree();
    expect(await screen.findByText('Child of A')).toBeTruthy();
  });

  it('clicking a collapsed workspace expands it (and the previous active workspace stays expanded)', async () => {
    renderTree();
    fireEvent.click(await screen.findByText('Other workspace'));
    expect(await screen.findByText('P2 thread')).toBeTruthy();
    // Previously-active workspace must remain expanded across the switch.
    expect(screen.getByText('Active thread')).toBeTruthy();
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

  it('collapses the Merged section together with its workspace', async () => {
    const nodes: Record<string, ChatNodeState> = {
      regular1: {
        nodeId: 'regular1', chatId: null, projectId: 'p1', kind: 'chat',
        title: 'Thread 1', messages: [], followUps: [], status: 'idle',
      },
      merge1: {
        nodeId: 'merge1', chatId: null, projectId: 'p1', kind: 'chat',
        title: 'Merged 1', mergeSources: [], messages: [], followUps: [], status: 'idle',
      },
    };
    const projects: Project[] = [
      {
        id: 'p1', name: 'Active workspace', cwd: '~/x',
        chatIds: Object.keys(nodes), edges: [],
        trees: [
          { id: 't1', rootNodeId: 'regular1', createdAt: 0, lastActiveAt: 100 },
          { id: 'm1', rootNodeId: 'merge1', createdAt: 0, lastActiveAt: 50, kind: 'merge' as const },
        ],
        activeTreeId: 't1', createdAt: 0,
      },
    ];

    renderTreeWith({ nodes, projects });

    // Active workspace is expanded by default → Merged section visible.
    expect(await screen.findByText('Merged 1')).toBeTruthy();
    expect(screen.getByTestId('merged-section')).toBeTruthy();

    // Collapse the workspace → both threads and the Merged section hide.
    fireEvent.click(screen.getByText('Active workspace'));
    expect(screen.queryByText('Thread 1')).toBeNull();
    expect(screen.queryByText('Merged 1')).toBeNull();
    expect(screen.queryByTestId('merged-section')).toBeNull();
  });
});
