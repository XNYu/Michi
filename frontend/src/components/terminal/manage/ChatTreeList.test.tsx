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
    artifacts: [],
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

  it('keeps ⋯ visible on a screen that cannot hover, where a tap opens the thread', () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      ...original(query),
      matches: query === '(hover: none)',
    })) as typeof window.matchMedia;
    try {
      const onOpen = vi.fn();
      render(
        <ChatTreeList
          workspace={mkProject()}
          nodes={NODES}
          filter=""
          onOpen={onOpen}
          menuActions={{
            activateTree: vi.fn(), archiveTree: vi.fn(), unarchiveTree: vi.fn(), pinTree: vi.fn(),
            unpinTree: vi.fn(), renameTree: vi.fn(), deleteTree: vi.fn(), exportTree: vi.fn(),
          }}
        />,
      );
      fireEvent.click(screen.getByLabelText(/more actions/i));
      expect(screen.queryByText('Pin')).not.toBeNull();
      expect(onOpen).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = original;
    }
  });
});
