/**
 * Unread in the workspace tree: the collapsed workspace header's unread ring,
 * and filter mode (only unread threads, "Read all").
 *
 * Mounts WorkspaceRow directly with a seeded ChatProvider so we control
 * focusedNodeId precisely, avoiding the auto-focus side-effect from
 * WorkspaceTree's activateTree on the active tree root.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { useEffect } from 'react';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import WorkspaceRow from './WorkspaceRow';
import WorkspaceTree from './WorkspaceTree';
import { ChatProvider, useChatStore } from '../../state/chatStore';
import { PrefsProvider } from '../../state/prefs';
import type { ChatNodeState, Project } from '../../state/chatTypes';

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
  localStorage.clear();
});

const NOW = 1_000_000;
const BEFORE = NOW - 10_000;

const NOOP_ACTIONS = {
  toggleWorkspace: vi.fn(),
  toggleThread: vi.fn(),
  setThreadExpanded: vi.fn(),
  toggleBranch: vi.fn(),
  toggleWorkspaceExpand: vi.fn(),
  activateTree: vi.fn(),
  selectProject: vi.fn(),
  createThread: vi.fn(),
  archiveTree: vi.fn(),
  unarchiveTree: vi.fn(),
  pinTree: vi.fn(),
  unpinTree: vi.fn(),
  renameTree: vi.fn(),
  deleteTree: vi.fn(),
  moveTreeToWorkspace: vi.fn(),
  renameProject: vi.fn(),
  archiveProject: vi.fn(),
  unarchiveProject: vi.fn(),
  pinProject: vi.fn(),
  unpinProject: vi.fn(),
  deleteProject: vi.fn(),
  selectBranch: vi.fn(),
  branchContextMenu: vi.fn(),
  selectThreadRoot: vi.fn(),
  selectThread: vi.fn(),
};

// ---------------------------------------------------------------------------
// Helper: a wrapper that enables unreadFilterOn after mount
// ---------------------------------------------------------------------------
function FilterActivator({ children }: { children: React.ReactNode }) {
  const { setUnreadFilterOn } = useChatStore();
  useEffect(() => { setUnreadFilterOn(true); }, [setUnreadFilterOn]);
  return <>{children}</>;
}

function seedAndRenderTree(
  projects: Project[],
  nodes: Record<string, ChatNodeState>,
  activeProjectId = projects[0]?.id ?? 'p1',
) {
  localStorage.setItem(
    'michi:v1:state',
    JSON.stringify({ version: 2, projects, nodes, activeProjectId }),
  );
  localStorage.setItem('michi:migrated', '1');
  return render(
    <PrefsProvider>
      <ChatProvider>
        <FilterActivator>
          <WorkspaceTree />
        </FilterActivator>
      </ChatProvider>
    </PrefsProvider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('WorkspaceRow unread ring', () => {
  const project: Project = {
    id: 'p1', name: 'Ring Workspace', cwd: '~/x',
    chatIds: ['r1'],
    edges: [],
    trees: [{ id: 't1', rootNodeId: 'r1', createdAt: 0, lastActiveAt: NOW }],
    activeTreeId: 't1', createdAt: 0,
  };
  const nodes: Record<string, ChatNodeState> = {
    r1: {
      nodeId: 'r1', chatId: null, projectId: 'p1', kind: 'chat',
      title: 'Unread thread', messages: [], followUps: [], status: 'idle',
      lastAssistantAt: NOW, viewedAt: BEFORE,
    },
  };

  function renderHeader(workspaceExpanded: boolean) {
    localStorage.setItem(
      'michi:v1:state',
      JSON.stringify({ version: 2, projects: [project], nodes, activeProjectId: 'p1' }),
    );
    localStorage.setItem('michi:migrated', '1');
    return render(
      <PrefsProvider>
        <ChatProvider>
          <WorkspaceRow
            project={project}
            workspaceExpanded={workspaceExpanded}
            activeProjectId={project.id}
            activeTreeId={project.activeTreeId}
            focusedNodeId={null}
            isThreadExpanded={() => false}
            isBranchExpanded={() => false}
            isBranchSelected={() => false}
            isNodeAlive={() => true}
            sortedTrees={project.trees}
            edges={project.edges}
            actions={NOOP_ACTIONS}
          />
        </ChatProvider>
      </PrefsProvider>,
    );
  }

  const headerDot = () =>
    screen.getByText('Ring Workspace').closest('.t-row-hover')!.querySelector('.sb-unread-dot') as HTMLElement | null;

  it('rings a collapsed workspace that holds an unread thread', async () => {
    renderHeader(false);
    await waitFor(() => expect(headerDot()?.dataset.unread).toBe('within'));
  });

  it('drops the ring once the workspace is open and its threads show their own dots', async () => {
    renderHeader(true);
    const title = await screen.findByText('Unread thread');
    const threadDot = title.closest('[data-sidebar-row]')!.querySelector('.sb-unread-dot') as HTMLElement;
    await waitFor(() => expect(threadDot.dataset.unread).toBe('self'));
    expect(headerDot()?.dataset.unread).toBe('none');
  });
});

describe('WorkspaceTree filter mode', () => {
  it('inside an unread workspace, only unread thread rows appear', async () => {
    const project: Project = {
      id: 'p1', name: 'My Workspace', cwd: '~/x',
      chatIds: ['r1', 'r2'],
      edges: [],
      trees: [
        { id: 't1', rootNodeId: 'r1', createdAt: 0, lastActiveAt: NOW },
        { id: 't2', rootNodeId: 'r2', createdAt: 0, lastActiveAt: BEFORE },
      ],
      activeTreeId: 't1', createdAt: 0,
    };
    const nodes: Record<string, ChatNodeState> = {
      r1: {
        nodeId: 'r1', chatId: null, projectId: 'p1', kind: 'chat',
        title: 'Unread thread', messages: [], followUps: [], status: 'idle',
        lastAssistantAt: NOW, viewedAt: BEFORE,
      },
      r2: {
        nodeId: 'r2', chatId: null, projectId: 'p1', kind: 'chat',
        title: 'Read thread', messages: [], followUps: [], status: 'idle',
        lastAssistantAt: BEFORE, viewedAt: NOW,
      },
    };

    // Mount WorkspaceRow directly with forceExpand — this is what filter mode wires up.
    localStorage.setItem(
      'michi:v1:state',
      JSON.stringify({ version: 2, projects: [project], nodes, activeProjectId: 'p1' }),
    );
    localStorage.setItem('michi:migrated', '1');
    render(
      <PrefsProvider>
        <ChatProvider>
          <WorkspaceRow
            project={project}
            workspaceExpanded={false}
            forceExpand={true}
            activeProjectId={project.id}
            activeTreeId={project.activeTreeId}
            focusedNodeId={null}
            isThreadExpanded={() => false}
            isBranchExpanded={() => false}
            isBranchSelected={() => false}
            isNodeAlive={() => true}
            sortedTrees={project.trees}
            edges={project.edges}
            actions={NOOP_ACTIONS}
          />
        </ChatProvider>
      </PrefsProvider>,
    );

    await act(async () => {});
    expect(await screen.findByText('Unread thread')).toBeTruthy();
    expect(screen.queryByText('Read thread')).toBeNull();
  });

  it('clicking "Read all" marks every thread read and shows the empty state', async () => {
    const project: Project = {
      id: 'p1', name: 'Unread Workspace', cwd: '~/x',
      chatIds: ['n1', 'n2'],
      edges: [],
      trees: [
        { id: 't1', rootNodeId: 'n1', createdAt: 0, lastActiveAt: NOW },
        { id: 't2', rootNodeId: 'n2', createdAt: 0, lastActiveAt: NOW },
      ],
      activeTreeId: 't1', createdAt: 0,
    };
    const nodes: Record<string, ChatNodeState> = {
      n1: {
        nodeId: 'n1', chatId: null, projectId: 'p1', kind: 'chat',
        title: 'Unread one', messages: [], followUps: [], status: 'idle',
        lastAssistantAt: NOW, viewedAt: BEFORE,
      },
      n2: {
        nodeId: 'n2', chatId: null, projectId: 'p1', kind: 'chat',
        title: 'Unread two', messages: [], followUps: [], status: 'idle',
        lastAssistantAt: NOW, viewedAt: BEFORE,
      },
    };

    seedAndRenderTree([project], nodes);

    await act(async () => {});
    const btn = await screen.findByRole('button', { name: /mark all threads as read/i });
    await act(async () => { fireEvent.click(btn); });

    // Everything is now read → the filter list empties to the caught-up state
    // and the Read-all affordance disappears with it.
    expect(await screen.findByText(/all caught up/i)).toBeTruthy();
    expect(screen.queryByText('Read all')).toBeNull();
    expect(screen.queryByText('Unread one')).toBeNull();
  });
});
