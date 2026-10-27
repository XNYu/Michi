/**
 * The assistant's system workspace stays out of every list of workspaces and
 * threads, and Home never starts a thread inside it.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatNodeState, Project } from '../../../state/chatTypes';
import TerminalWorkspaces from '../pages/Workspaces';
import TerminalHome from '../pages/Home';

const state = vi.hoisted(() => ({
  activeProjectId: 'w1',
  selectProject: vi.fn(),
  chip: vi.fn((_props: unknown) => null),
}));

const projects = vi.hoisted(() => [
  {
    id: 'w1', name: 'Work', createdAt: 1, activeTreeId: 't1', chatIds: ['u1'], edges: [], artifacts: [],
    trees: [{ id: 't1', rootNodeId: 'u1', createdAt: 0, lastActiveAt: 100 }],
  },
  {
    id: 'sys', name: 'Assistant', system: 'assistant', createdAt: 2, activeTreeId: 'ts', chatIds: ['a1'], edges: [], artifacts: [],
    trees: [{ id: 'ts', rootNodeId: 'a1', createdAt: 0, lastActiveAt: 900 }],
  },
] as Project[]);

const nodes = vi.hoisted(() => ({
  u1: { nodeId: 'u1', projectId: 'w1', kind: 'chat', title: 'Ship the release', messages: [], followUps: [], status: 'idle' },
  a1: { nodeId: 'a1', projectId: 'sys', kind: 'chat', title: 'Assistant conversation', messages: [], followUps: [], status: 'idle' },
}) as unknown as Record<string, ChatNodeState>);

vi.mock('../../../state/chatStore', async () => {
  const actual = await vi.importActual<typeof import('../../../state/chatStore')>('../../../state/chatStore');
  return {
    ...actual,
    useChatStore: () => ({
      projects,
      activeProjectId: state.activeProjectId,
      activeProject: projects.find((p) => p.id === state.activeProjectId) ?? null,
      focusedNodeId: null,
      selectProject: state.selectProject,
      activateTree: vi.fn(), openPane: vi.fn(), openPaneInTree: vi.fn(), setFocusedNodeId: vi.fn(),
      deleteProject: vi.fn(), archiveProject: vi.fn(), unarchiveProject: vi.fn(), pinProject: vi.fn(),
      unpinProject: vi.fn(), renameProject: vi.fn(), setProjectCwd: vi.fn(),
    }),
    useChatNodesSnapshot: () => nodes,
    useNodesSelector: () => new Set<string>(),
    useStructuralSelector: (selector: (n: Record<string, ChatNodeState>) => unknown) => selector(nodes),
  };
});
vi.mock('../manage/ManageComposer', () => ({
  default: React.forwardRef(({ toolbarLeftPrefix }: { toolbarLeftPrefix?: React.ReactNode }, _ref) => <>{toolbarLeftPrefix}</>),
}));
vi.mock('../HomeWorkspaceChip', () => ({ HomeWorkspaceChip: (props: unknown) => state.chip(props) }));

beforeEach(() => {
  state.activeProjectId = 'w1';
  state.selectProject.mockReset();
  state.chip.mockClear();
});

describe('the assistant workspace stays hidden', () => {
  it('is not on the Workspaces page', () => {
    render(<TerminalWorkspaces onNav={vi.fn()} />);
    expect(screen.getByTestId('workspace-table-row-w1')).toBeTruthy();
    expect(screen.queryByTestId('workspace-table-row-sys')).toBeNull();
  });

  it('is not in Home’s workspace chip', () => {
    render(<TerminalHome onSubmitted={vi.fn()} />);
    const props = state.chip.mock.calls.at(-1)![0] as { active: { id: string } | null; liveProjects: Array<{ id: string }> };
    expect(props.liveProjects.map((p) => p.id)).toEqual(['w1']);
    expect(props.active?.id).toBe('w1');
    expect(state.selectProject).not.toHaveBeenCalled();
  });

  it('moves Home back to a user workspace after the assistant was open as a pane', () => {
    state.activeProjectId = 'sys';
    render(<TerminalHome onSubmitted={vi.fn()} />);
    expect(state.selectProject).toHaveBeenCalledWith('w1');
    const props = state.chip.mock.calls.at(-1)![0] as { active: unknown };
    expect(props.active).toBeNull();
  });
});
