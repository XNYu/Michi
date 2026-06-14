import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import WorkspaceManage from './WorkspaceManage';

const baseStoreShape: any = {
  projects: [],
  createThread: vi.fn(),
  sendMessage: vi.fn(),
  selectProject: vi.fn(),
  updateContext: vi.fn(),
  deleteContext: vi.fn(),
  toggleAutoInject: vi.fn(),
  openPane: vi.fn(),
  agentStatus: null,
  refreshAgentStatus: vi.fn(),
};

let mockNodes: Record<string, any> = {};

vi.mock('../../../state/chatStore', async () => {
  const actual: any = await vi.importActual('../../../state/chatStore');
  return {
    ...actual,
    useChatStore: () => baseStoreShape,
    useChatNodesSnapshot: () => mockNodes,
  };
});

describe('WorkspaceManage', () => {
  it('shows empty state when workspace not found', () => {
    baseStoreShape.projects = [];
    render(<WorkspaceManage workspaceId="missing" onNav={() => {}} />);
    expect(screen.queryByText(/workspace not found/i)).not.toBeNull();
  });

  it('renders header counts derived from store data', () => {
    // Seed a live chat node so deriveHeaderCounts counts it
    mockNodes = {
      a: {
        nodeId: 'a',
        kind: 'chat',
        deletedAt: undefined,
        title: 'Test chat',
        messages: [],
        createdAt: Date.now(),
      },
    };
    baseStoreShape.projects = [{
      id: 'ws1',
      name: 'web-platform',
      cwd: '~/projects/web',
      chatIds: ['a'],
      edges: [{ source: 'a', target: 'b', kind: 'branch' }],
      createdAt: 0,
      trees: [{ id: 't1', rootNodeId: 'a', createdAt: 0, lastActiveAt: Date.now() }],
      activeTreeId: 't1',
      contexts: [
        { id: 'ctx', name: 'a.md', filePath: 'a.md', source: 'user', createdAt: 0, updatedAt: 0 },
      ],
    }];
    render(<WorkspaceManage workspaceId="ws1" onNav={() => {}} />);
    // The header title-cases the stored workspace name for display
    // (web-platform -> "Web Platform"), so assert the prettified form.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Web Platform');
    // The header surfaces two derived stats — "{chats} chats · {contexts} sources"
    // (contexts are labeled "sources" in the UI). Counts are split across DOM
    // nodes, so use a predicate search on textContent.
    const chatsEls = screen.getAllByText((_t, el) => (el?.textContent ?? '').includes('1 chats'));
    expect(chatsEls.length).toBeGreaterThan(0);
    const sourcesEls = screen.getAllByText((_t, el) => (el?.textContent ?? '').includes('1 sources'));
    expect(sourcesEls.length).toBeGreaterThan(0);
  });
});
