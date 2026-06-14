import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ChatTreeList from './ChatTreeList';
import type { ChatNodeState, Project } from '../../../state/chatTypes';

function mkProject(): Project {
  return {
    id: 'p1',
    name: 'p1',
    chatIds: ['r', 'b1'],
    edges: [{ source: 'r', target: 'b1', kind: 'branch' }],
    createdAt: 0,
    trees: [{ id: 't1', rootNodeId: 'r', createdAt: 0, lastActiveAt: 100 }],
    activeTreeId: 't1',
    contexts: [],
  };
}

const NODES: Record<string, ChatNodeState> = {
  r: {
    nodeId: 'r',
    projectId: 'p1',
    chatId: null,
    kind: 'chat',
    title: 'root chat',
    status: 'idle',
    messages: [],
    followUps: [],
    currentModeId: null,
  } as any,
  b1: {
    nodeId: 'b1',
    projectId: 'p1',
    chatId: null,
    kind: 'chat',
    title: 'failure modes regression',
    status: 'idle',
    messages: [],
    followUps: [],
    currentModeId: null,
  } as any,
};

describe('ChatTreeList', () => {
  it('renders root and branch rows', () => {
    render(
      <ChatTreeList
        workspace={mkProject()}
        nodes={NODES}
        filter=""
        onOpen={() => {}}
      />,
    );
    expect(screen.getAllByText('root chat').length).toBeGreaterThan(0);
    expect(screen.getAllByText('failure modes regression').length).toBeGreaterThan(0);
  });

  it('filter hides non-matching tree', () => {
    render(
      <ChatTreeList
        workspace={mkProject()}
        nodes={NODES}
        filter="zzz-no-match"
        onOpen={() => {}}
      />,
    );
    expect(screen.queryByText('root chat')).toBeNull();
  });

  it('clicking a row calls onOpen with the chat id', () => {
    const onOpen = vi.fn();
    render(
      <ChatTreeList
        workspace={mkProject()}
        nodes={NODES}
        filter=""
        onOpen={onOpen}
      />,
    );
    const listitems = screen.getAllByRole('listitem');
    const rootItem = listitems.find((el) => el.textContent?.includes('root chat'))!;
    fireEvent.click(rootItem);
    expect(onOpen).toHaveBeenCalledWith('r');
  });

  it('sorts pinned trees before unpinned trees', () => {
    const project: Project = {
      id: 'p1',
      name: 'p1',
      chatIds: ['r1', 'r2'],
      edges: [],
      createdAt: 0,
      trees: [
        { id: 't1', rootNodeId: 'r1', createdAt: 0, lastActiveAt: 100 },
        { id: 't2', rootNodeId: 'r2', createdAt: 1, lastActiveAt: 200, pinnedAt: 500 },
      ],
      activeTreeId: 't1',
      contexts: [],
    };
    const nodes: Record<string, ChatNodeState> = {
      r1: { ...NODES.r, nodeId: 'r1', title: 'unpinned chat' } as any,
      r2: { ...NODES.r, nodeId: 'r2', title: 'pinned chat' } as any,
    };
    const { container } = render(
      <ChatTreeList workspace={project} nodes={nodes} filter="" onOpen={() => {}} />,
    );
    const items = Array.from(container.querySelectorAll('[role="listitem"]'));
    const titles = items.map((el) => el.textContent || '');
    const pinnedIdx = titles.findIndex((t) => t.includes('pinned chat'));
    const unpinnedIdx = titles.findIndex((t) => t.includes('unpinned chat'));
    expect(pinnedIdx).toBeGreaterThanOrEqual(0);
    expect(unpinnedIdx).toBeGreaterThanOrEqual(0);
    expect(pinnedIdx).toBeLessThan(unpinnedIdx);
    // The pinned root carries data-pinned="true".
    const pinnedRow = items[pinnedIdx] as HTMLElement;
    expect(pinnedRow.getAttribute('data-pinned')).toBe('true');
  });

  it('menu shows Pin when tree is unpinned, Unpin when pinned', () => {
    const baseActions = {
      activateTree: vi.fn(),
      archiveTree: vi.fn(),
      unarchiveTree: vi.fn(),
      pinTree: vi.fn(),
      unpinTree: vi.fn(),
      renameTree: vi.fn(),
      deleteTree: vi.fn(),
      exportTree: vi.fn(),
    };
    const { unmount } = render(
      <ChatTreeList
        workspace={mkProject()}
        nodes={NODES}
        filter=""
        onOpen={() => {}}
        menuActions={baseActions}
      />,
    );
    let listitems = screen.getAllByRole('listitem');
    let rootItem = listitems.find((el) => el.textContent?.includes('root chat'))!;
    fireEvent.mouseEnter(rootItem);
    fireEvent.click(screen.getByLabelText(/more actions/i));
    expect(screen.queryByText('Pin')).not.toBeNull();
    expect(screen.queryByText('Unpin')).toBeNull();
    unmount();

    const pinnedProject = mkProject();
    pinnedProject.trees[0].pinnedAt = 999;
    render(
      <ChatTreeList
        workspace={pinnedProject}
        nodes={NODES}
        filter=""
        onOpen={() => {}}
        menuActions={baseActions}
      />,
    );
    listitems = screen.getAllByRole('listitem');
    rootItem = listitems.find((el) => el.textContent?.includes('root chat'))!;
    fireEvent.mouseEnter(rootItem);
    fireEvent.click(screen.getByLabelText(/more actions/i));
    expect(screen.queryByText('Unpin')).not.toBeNull();
  });

  it('shows ⋯ button on hovered root row when menuActions provided, and clicking opens a menu', () => {
    const menuActions = {
      activateTree: vi.fn(),
      archiveTree: vi.fn(),
      unarchiveTree: vi.fn(),
      renameTree: vi.fn(),
      deleteTree: vi.fn(),
      exportTree: vi.fn(),
    };
    render(
      <ChatTreeList
        workspace={mkProject()}
        nodes={NODES}
        filter=""
        onOpen={() => {}}
        menuActions={menuActions}
      />,
    );
    const listitems = screen.getAllByRole('listitem');
    const rootItem = listitems.find((el) => el.textContent?.includes('root chat'))!;
    fireEvent.mouseEnter(rootItem);
    const moreBtn = screen.getByLabelText(/more actions/i);
    fireEvent.click(moreBtn);
    // Menu open: at least one of the menu items should be findable by label
    expect(screen.queryByText(/Rename/i)).not.toBeNull();
    expect(screen.queryByText(/Delete thread/i) ?? screen.queryByText(/Delete/i)).not.toBeNull();
  });
});
