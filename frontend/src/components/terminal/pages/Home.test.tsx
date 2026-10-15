import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import TerminalHome from './Home';
import type { ChatNodeState, Project } from '../../../state/chatTypes';

// The composer pulls in the editor and the model stack; the list under it is
// what this file is about.
vi.mock('../manage/ManageComposer', () => ({ default: () => null }));
vi.mock('../HomeWorkspaceChip', () => ({ HomeWorkspaceChip: () => null }));

function node(nodeId: string, extra: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId, chatId: null, projectId: 'p1', kind: 'chat',
    title: nodeId, messages: [], followUps: [], status: 'idle',
    ...extra,
  } as ChatNodeState;
}

const nodes: Record<string, ChatNodeState> = {
  a: node('a', { title: 'Alpha' }),
  a1: node('a1', { lastAssistantAt: 10, viewedAt: 0 }),
  b: node('b', { title: 'Beta' }),
  c: node('c', { title: 'Gamma', projectId: 'p2', status: 'streaming' }),
};

// Newest first: Beta (p1, not the active thread) › Gamma (p2) › Alpha (p1, active).
const projects = [
  {
    id: 'p1', name: 'One', createdAt: 0, activeTreeId: 'tA',
    chatIds: ['a', 'a1', 'b'],
    edges: [{ source: 'a', target: 'a1', kind: 'branch' }],
    trees: [
      { id: 'tA', rootNodeId: 'a', createdAt: 0, lastActiveAt: 100 },
      { id: 'tB', rootNodeId: 'b', createdAt: 0, lastActiveAt: 300 },
    ],
  },
  {
    id: 'p2', name: 'Two', createdAt: 0, activeTreeId: 'tC',
    chatIds: ['c'], edges: [],
    trees: [{ id: 'tC', rootNodeId: 'c', createdAt: 0, lastActiveAt: 200 }],
  },
] as Project[];

const actions = {
  selectProject: vi.fn(),
  activateTree: vi.fn(),
  openPane: vi.fn(),
  openPaneInTree: vi.fn(),
  setFocusedNodeId: vi.fn(),
};

vi.mock('../../../state/chatStore', async () => {
  const actual: any = await vi.importActual('../../../state/chatStore');
  return {
    ...actual,
    useChatStore: () => ({
      projects,
      activeProject: projects[0],
      activeProjectId: 'p1',
      focusedNodeId: null,
      ...actions,
    }),
    useStructuralSelector: (selector: (n: Record<string, ChatNodeState>) => unknown) => selector(nodes),
  };
});

const rows = () => screen.getAllByTestId('home-continue-row');

describe('TerminalHome — continue list', () => {
  beforeEach(() => {
    for (const fn of Object.values(actions)) fn.mockClear();
  });

  it('lists recent threads from every workspace under a "continue" caption', () => {
    render(<TerminalHome onSubmitted={vi.fn()} />);
    expect(screen.getByText('continue')).toBeTruthy();
    expect(screen.queryByText(/recent threads/i)).toBeNull();
    expect(rows().map((r) => within(r).getByText(/Alpha|Named|Beta|Gamma/).textContent)).toEqual(['Beta', 'Gamma', 'Alpha']);
    expect(within(rows()[0]).getByText('One')).toBeTruthy();
    expect(within(rows()[1]).getByText('Two')).toBeTruthy();
  });

  it('shows what each thread is doing and how far it has branched', () => {
    render(<TerminalHome onSubmitted={vi.fn()} />);
    const [beta, gamma, alpha] = rows();
    expect(within(gamma).getByRole('img', { name: 'streaming' })).toBeTruthy();
    expect(within(alpha).getByRole('img', { name: 'unread' })).toBeTruthy();
    expect(within(alpha).getByRole('img', { name: '1 branch' })).toBeTruthy();
    // An idle thread with no branches shows neither mark.
    expect(within(beta).queryByRole('img')).toBeNull();
  });

  it('opens a thread in another workspace by seeding its pane before switching', () => {
    const onSubmitted = vi.fn();
    render(<TerminalHome onSubmitted={onSubmitted} />);
    fireEvent.click(rows()[1]);
    expect(actions.selectProject).toHaveBeenCalledWith('p2');
    expect(actions.openPaneInTree).toHaveBeenCalledWith('p2', 'tC', 'c');
    expect(actions.activateTree).toHaveBeenCalledWith('tC', 'p2');
    expect(actions.setFocusedNodeId).toHaveBeenCalledWith('c');
    expect(actions.openPane).not.toHaveBeenCalled();
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('switches thread inside the active workspace without reselecting the workspace', () => {
    render(<TerminalHome onSubmitted={vi.fn()} />);
    fireEvent.click(rows()[0]);
    expect(actions.selectProject).not.toHaveBeenCalled();
    expect(actions.openPaneInTree).toHaveBeenCalledWith('p1', 'tB', 'b');
    expect(actions.activateTree).toHaveBeenCalledTimes(1);
    expect(actions.activateTree).toHaveBeenCalledWith('tB', 'p1');
  });

  it('still activates the already-active thread, so its unread branches are marked read', () => {
    render(<TerminalHome onSubmitted={vi.fn()} />);
    fireEvent.click(rows()[2]);
    expect(actions.openPane).toHaveBeenCalledWith('a');
    expect(actions.openPaneInTree).not.toHaveBeenCalled();
    expect(actions.activateTree).toHaveBeenCalledTimes(1);
    expect(actions.activateTree).toHaveBeenCalledWith('tA', 'p1');
  });
});
