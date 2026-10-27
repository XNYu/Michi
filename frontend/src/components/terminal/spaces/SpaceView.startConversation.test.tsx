import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ archived: false, received: [] as Array<boolean> }));

vi.mock('../../MentionEditor', () => import('../../../test/mentionEditorStub'));
vi.mock('../../../state/chatStore', () => ({
  useChatActions: () => ({ openPagePane: vi.fn(), revealBackendNode: vi.fn() }),
  useChatNodesSnapshot: () => ({}),
  useNodesSelector: (selector: (nodes: Record<string, unknown>) => unknown) => selector({}),
  useChatProjects: () => ({
    projects: [{ id: 'workspace-1', name: 'rabbitholes', archivedAt: mocks.archived ? 1 : undefined }],
    activeProjectId: 'workspace-1',
    agentStatus: { label: 'Kiro', availableRuntimes: [] },
  }),
}));
vi.mock('../../../state/pages/useSpaceTree', () => ({ useSpaceTree: () => ({ pages: [{ id: 'page-1', workspaceId: 'workspace-1', parentId: null, position: 0, title: 'Michi 0.9 发布' }], status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../../state/pages/usePage', () => ({ usePage: () => ({
  page: { id: 'page-1', workspaceId: 'workspace-1', parentId: null, position: 0, title: 'Michi 0.9 发布', color: null, updatedAt: 1, updatedBy: 'user', pendingProposals: 0, helperNodeId: null, revision: 1, viewVersion: 1, blocks: [] },
  changes: [], status: 'ready', error: null, stale: false, refresh: vi.fn(), edit: vi.fn(), accept: vi.fn(), dismiss: vi.fn(), reopen: vi.fn(), revert: vi.fn(), redo: vi.fn(), revertBatch: vi.fn(),
}) }));
vi.mock('../../../state/pages/useSpacesHome', () => ({ useProgressCards: () => ({ data: [], status: 'ready', error: null, stale: false, refresh: vi.fn() }) }));
vi.mock('../../../state/pages/useSpaces', () => ({ useSpaces: () => ({ spaces: [], status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../../state/pages/revealSource', () => ({ revealPageSource: vi.fn() }));
vi.mock('../../../state/pages/pageEvents', () => ({ notifyPageChanged: vi.fn() }));
vi.mock('../../../services/api/pages', () => ({
  createWorkspaceDatabase: vi.fn(), listWorkspaceDatabases: vi.fn(), createPage: vi.fn(), deletePage: vi.fn(), fetchPage: vi.fn(), patchPage: vi.fn(),
}));
vi.mock('./MaintenanceStatus', () => ({ MaintenanceStatus: () => null }));
vi.mock('./NativePageDocument', () => ({
  default: ({ onStartConversation }: { onStartConversation?: (text: string, workspaceId: string) => void }) => {
    mocks.received.push(Boolean(onStartConversation));
    return onStartConversation
      ? <button type="button" onClick={() => onStartConversation('跑完增量读取的事务回滚、跨工作区移动两个用例', 'workspace-1')}>Start a conversation</button>
      : null;
  },
}));

import { SpaceView } from './SpaceView';
import { readSpaceConversations, resetSpaceConversationsForTests } from '../../../state/spaceConversations/store';

const route = { type: 'space' as const, pageId: 'page-1', workspaceId: 'workspace-1', backendConnectionId: 'local' };

beforeEach(() => {
  resetSpaceConversationsForTests();
  mocks.archived = false;
  mocks.received = [];
});

describe('Start a conversation from a next step', () => {
  it('opens the sheet on this page with the step’s text, in the page’s workspace', async () => {
    render(<SpaceView route={route} onBack={vi.fn()} onOpenPage={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start a conversation' }));
    const sheet = await screen.findByRole('region', { name: 'Start a task' });
    expect(within(sheet).getByRole('button', { name: 'Workspace: rabbitholes' })).toBeTruthy();
    const input = await within(sheet).findByRole('textbox') as HTMLTextAreaElement;
    expect(input.value).toBe('跑完增量读取的事务回滚、跨工作区移动两个用例');
    await waitFor(() => expect(document.activeElement).toBe(input));

    fireEvent.click(within(sheet).getByRole('button', { name: 'Start' }));
    expect(readSpaceConversations().pending[0]).toMatchObject({ workspaceId: 'workspace-1', startedFromPageId: 'page-1' });
    act(() => {});
    expect(screen.queryByRole('region', { name: 'Start a task' })).toBeNull();
  });

  it('offers no start on a read-only page', () => {
    mocks.archived = true;
    render(<SpaceView route={route} onBack={vi.fn()} onOpenPage={vi.fn()} />);
    expect(mocks.received.length).toBeGreaterThan(0);
    expect(mocks.received.every((offered) => !offered)).toBe(true);
    expect(screen.queryByRole('button', { name: 'Start a conversation' })).toBeNull();
  });
});
