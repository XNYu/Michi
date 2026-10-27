import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageBlock, PageDto, WorkspaceHomeDto } from 'michi-shared';

const mocks = vi.hoisted(() => ({
  home: null as unknown,
  page: null as unknown,
  chatIds: ['n1'] as string[],
  activity: [] as unknown[],
  sections: null as unknown,
  trees: [] as unknown[],
  edges: [] as unknown[],
  nodes: { n9: { title: 'Pages direction' } } as Record<string, unknown>,
  revealBackendNode: vi.fn(),
  selectProject: vi.fn(),
  dialog: vi.fn(),
  live: null as unknown,
  retry: vi.fn(),
  opened: vi.fn(),
  newChat: vi.fn(),
  openConversation: vi.fn(async () => true),
}));

vi.mock('../../../../state/metaAgent/spacesFirstRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../state/metaAgent/spacesFirstRun')>()),
  useSpacesFirstRun: () => ({ load: 'ready', data: mocks.live, error: null, unreachable: false, schedulerOff: false, justFinished: false }),
  retrySpacesFirstRunNow: mocks.retry,
  markWorkspaceHomeOpened: mocks.opened,
}));

vi.mock('../../../../state/pages/useSpacesHome', () => ({
  useWorkspaceHome: () => ({ data: mocks.home, status: 'ready', error: null, stale: false, refresh: vi.fn() }),
  useSpaceActivity: () => ({ data: mocks.activity, status: 'ready', error: null, stale: false, refresh: vi.fn() }),
  useHomeSections: () => ({ data: mocks.sections, status: 'ready', error: null, stale: false, refresh: vi.fn() }),
}));
vi.mock('../../../../state/pages/useSpaces', () => ({
  useSpaces: () => ({ spaces: [
    { id: 'space-1', workspaceId: 'ws-1', title: 'Release notes', pageCount: 3, pendingProposals: 1 },
    { id: 'space-2', workspaceId: 'ws-2', title: 'Elsewhere', pageCount: 1, pendingProposals: 0 },
  ], status: 'ready', error: null, refresh: vi.fn() }),
}));
vi.mock('../../../../state/pages/usePage', () => ({
  usePage: () => ({
    page: mocks.page, changes: [], status: 'ready', error: null, stale: false, lastSeenChangeSeq: 0,
    refresh: vi.fn(), edit: vi.fn(), accept: vi.fn(), dismiss: vi.fn(), reopen: vi.fn(), revert: vi.fn(), redo: vi.fn(), acknowledgeThrough: vi.fn(),
  }),
}));
vi.mock('../../../../services/api/pages', () => ({ fetchPageActivitySeen: () => Promise.resolve({ lastSeenChangeSeq: 0 }) }));
vi.mock('../../../../state/chatStore', () => ({
  useChatActions: () => ({ revealBackendNode: mocks.revealBackendNode, selectProject: mocks.selectProject }),
  useChatNodesSnapshot: () => mocks.nodes,
  useOptionalChatProjects: () => null,
  useStructuralSelector: (select: (nodes: unknown) => unknown) => select(mocks.nodes),
  useChatProjects: () => ({
    projects: [{ id: 'ws-1', name: 'rabbitholes', chatIds: mocks.chatIds, trees: mocks.trees, edges: mocks.edges }],
    agentStatus: { availableRuntimes: [{ id: 'claude', label: 'Claude' }] },
  }),
}));
vi.mock('../SpacesPage', () => ({
  openNativePageRoute: vi.fn(),
  CreateSpaceDialog: (props: { activeWorkspaceId?: string }) => { mocks.dialog(props); return <div role="dialog" aria-label="Create a page" />; },
}));
vi.mock('../NativeDatabase', () => ({ default: () => null }));
vi.mock('../PageChangeTargets', () => ({ PageChangeTargets: () => null }));
vi.mock('../NativePageDocument', () => ({
  default: ({ page, visibleBlocks = page.blocks, onStartConversation }: { page: PageDto; visibleBlocks?: PageDto['blocks']; onStartConversation?(text: string, workspaceId: string): void }) => <div data-testid="segment">
    {visibleBlocks.map((block) => <p key={block.id}>{'text' in block ? block.text : block.id}</p>)}
    {!page.blocks.length && <div data-testid="empty-editor" />}
    {onStartConversation && visibleBlocks.length > 0 && <button type="button" onClick={() => onStartConversation('Run the rollback case', page.workspaceId)}>Start a conversation</button>}
  </div>,
}));
vi.mock('./homeLinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./homeLinks')>()),
  openNewChatSheet: mocks.newChat,
  useSpacesSourceNav: () => ({ openExactSourcePopover: vi.fn(), openSourcePopover: vi.fn(), openConversationFromSpaces: mocks.openConversation }),
  NewChatSheetSlot: ({ scope }: { scope: unknown }) => <div data-testid="sheet-slot" data-scope={JSON.stringify(scope)} />,
  PageProgressCards: ({ scope }: { scope: unknown }) => <div data-testid="progress-cards" data-scope={JSON.stringify(scope)} />,
}));

import { workspaceConversations, WorkspaceHomeView } from './WorkspaceHome';

const page = (blocks: PageBlock[]): PageDto => ({
  id: 'wh', workspaceId: 'ws-1', parentId: null, position: 0, title: 'rabbitholes', color: null, updatedAt: Date.now() - 12 * 60_000, updatedBy: 'agent',
  pendingProposals: 0, helperNodeId: null, revision: 1, viewVersion: 1, blocks,
});
const block = (id: string, text: string) => ({ id, rev: 1, type: 'markdown', text, sources: [{ nodeId: 'n', turnId: 't', assistantId: 'a' }] }) as PageBlock;
const home = (blocks: PageBlock[], firstRun: WorkspaceHomeDto['firstRun'] = null): WorkspaceHomeDto => ({
  role: 'workspace-home', workspaceId: 'ws-1', page: page(blocks), layoutRules: [], hiddenAt: null, firstRun,
});
const run = (state: NonNullable<WorkspaceHomeDto['firstRun']>['state'], extra = {}) => ({
  workspaceId: 'ws-1', startedAt: 1, startSeq: 1289, readCount: 12, total: 38, state, error: null, updatedAt: 1, ...extra,
});
const view = (onOpenPage = vi.fn()) => render(<WorkspaceHomeView workspaceId="ws-1" backendConnectionId="local" onOpenPage={onOpenPage} />);

beforeEach(() => {
  mocks.home = home([block('l', 'Michi merged into dev.'), block('m', 'Metrics')], run('done', { readCount: 38 }));
  mocks.page = (mocks.home as WorkspaceHomeDto).page;
  mocks.chatIds = ['n1'];
  mocks.activity = [];
  mocks.sections = null;
  mocks.trees = [];
  mocks.edges = [];
  mocks.nodes = { n9: { title: 'Pages direction' } };
  mocks.live = null;
  mocks.retry.mockReset();
  mocks.opened.mockReset();
  mocks.newChat.mockReset();
  mocks.revealBackendNode.mockReset().mockResolvedValue(true);
  mocks.selectProject.mockReset();
  mocks.dialog.mockReset();
});

describe('Workspace home', () => {
  it('shows one page update time below the title and keeps the read source after the lead', () => {
    mocks.home = { ...(mocks.home as WorkspaceHomeDto), incremental: { readThrough: 1301, tidiedAt: Date.now() - 5 * 60_000 } };
    view();
    expect(screen.getByText('rabbitholes · workspace home')).toBeTruthy();
    const title = screen.getByRole('heading', { level: 1, name: 'rabbitholes' });
    const updated = screen.getByText('Updated 12m ago');
    expect(title.closest('header')?.contains(updated)).toBe(true);
    expect(title.compareDocumentPosition(updated) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(updated.getAttribute('datetime')).toBe(new Date((mocks.page as PageDto).updatedAt).toISOString());
    // The cursor where incremental reading has got to now, not where the first read started.
    const source = screen.getByText('From 38 conversations · read through #1301');
    expect(screen.queryByText(/organized/)).toBeNull();
    const lead = screen.getByText('Michi merged into dev.');
    const metrics = screen.getByText('Metrics');
    expect(lead.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(source.compareDocumentPosition(metrics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('leaves the cursor out of the source line until maintenance reads the workspace', () => {
    view();
    expect(screen.getByText('From 38 conversations')).toBeTruthy();
    cleanup();
    mocks.home = { ...(mocks.home as WorkspaceHomeDto), firstRun: null, incremental: { readThrough: 7, tidiedAt: null } };
    view();
    expect(screen.getByText('Read through #7')).toBeTruthy();
    cleanup();
    mocks.home = { ...(mocks.home as WorkspaceHomeDto), incremental: { readThrough: 0, tidiedAt: Date.now() - 5 * 60_000 } };
    view();
    expect(document.querySelector('.spaces-home-source')).toBeNull();
    expect(screen.getByText('Updated 12m ago')).toBeTruthy();
    expect(screen.queryByText(/#0/)).toBeNull();
  });

  it('uses the current page revision’s update time, including a person’s edit', () => {
    const updatedAt = Date.now() - 2 * 60_000;
    mocks.page = { ...(mocks.page as PageDto), updatedAt, updatedBy: 'user' };
    view();
    expect(screen.getByText('Updated 2m ago').getAttribute('datetime')).toBe(new Date(updatedAt).toISOString());
    expect(screen.queryByText(/Updated 12m/)).toBeNull();
  });

  it('opens the new-chat sheet at the top of the page and lists this page’s progress cards under the source line', () => {
    view();
    const doc = document.querySelector('.spaces-home__doc')!;
    const sheet = screen.getByTestId('sheet-slot');
    expect(doc.firstElementChild).toBe(sheet);
    const scope = { backendConnectionId: 'local', pageId: 'wh', workspaceId: 'ws-1', workspaceName: 'rabbitholes', pageTitle: 'rabbitholes' };
    expect(JSON.parse(sheet.getAttribute('data-scope')!)).toEqual(scope);
    const cards = screen.getByTestId('progress-cards');
    expect(JSON.parse(cards.getAttribute('data-scope')!)).toEqual(scope);
    const sourceLine = screen.getByText(/From 38 conversations/).closest('.spaces-home-source')!;
    expect(sourceLine.nextElementSibling).toBe(cards);
  });

  it('starts a conversation from a next step in the new-chat sheet, in that step’s workspace', () => {
    view();
    fireEvent.click(screen.getAllByRole('button', { name: 'Start a conversation' })[0]);
    expect(mocks.newChat).toHaveBeenCalledWith({ text: 'Run the rollback case', workspaceId: 'ws-1' });
  });

  it('hides the source line until the first read is done', () => {
    mocks.home = home([block('l', 'Line')], null);
    mocks.page = (mocks.home as WorkspaceHomeDto).page;
    view();
    expect(screen.queryByText(/From \d+ conversations/)).toBeNull();
  });

  it('lists this workspace’s Spaces, each opening its page, and a card that creates one here', () => {
    const onOpenPage = vi.fn();
    view(onOpenPage);
    expect(screen.queryByText('Elsewhere')).toBeNull();
    expect(screen.getByText('1 waiting for you')).toBeTruthy();
    fireEvent.click(screen.getByText('Release notes').closest('button')!);
    expect(onOpenPage).toHaveBeenCalledWith({ pageId: 'space-1', workspaceId: 'ws-1', backendConnectionId: 'local' });
    fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    expect(screen.getByRole('dialog', { name: 'Create a page' })).toBeTruthy();
    expect(mocks.dialog).toHaveBeenCalledWith(expect.objectContaining({ activeWorkspaceId: 'ws-1' }));
  });

  it('lists the workspace’s conversations newest first with their state, and opens one with a way back', async () => {
    const now = Date.now();
    mocks.chatIds = ['r1', 'r1b', 'r2', 'r3', 'r4'];
    mocks.trees = [
      { id: 't1', rootNodeId: 'r1', createdAt: 1, lastActiveAt: now - 50 * 60_000 },
      { id: 't2', rootNodeId: 'r2', name: 'Release notes draft', createdAt: 1, lastActiveAt: now - 2 * 3_600_000 },
      { id: 't3', rootNodeId: 'r3', createdAt: 1, lastActiveAt: now - 3 * 86_400_000 },
      { id: 't4', rootNodeId: 'r4', createdAt: 1, lastActiveAt: now, archivedAt: now },
    ];
    mocks.edges = [{ source: 'r1', target: 'r1b' }];
    mocks.nodes = {
      r1: { kind: 'chat', title: 'Notarize failure', status: 'idle', runtimeId: 'claude' },
      r1b: { kind: 'chat', title: 'Branch', status: 'streaming' },
      r2: { kind: 'chat', title: 'ignored, the tree has a name', status: 'idle' },
      r3: { kind: 'chat', title: 'Incremental edge cases', status: 'idle' },
      r4: { kind: 'chat', title: 'Archived', status: 'idle' },
    };
    const thread = (nodeId: string) => ({ id: `conversation:${nodeId}`, kind: 'conversation', workspaceId: 'ws-1', workspaceName: 'rabbitholes', title: '', at: 1, summary: '', agentClaim: false,
      target: { kind: 'conversation', nodeId, workspaceId: 'ws-1', messageId: null } });
    mocks.sections = { waiting: { items: [thread('r2')], total: 1 }, stalled: { items: [thread('r3'), thread('r1')], total: 2 }, done: { items: [], total: 0 }, conversations: { available: true } };
    view();
    const rows = screen.getAllByRole('button').filter((button) => button.classList.contains('spaces-home-threads__row'));
    expect(rows.map((row) => row.textContent)).toEqual([
      // A running branch outranks the Home's "Stalled" for its conversation.
      'Notarize failureClaudeRunning · 50m ago',
      'Release notes draftWaiting on you · 2h ago',
      'Incremental edge casesStalled · 3d ago',
    ]);
    fireEvent.click(rows[1]!);
    await waitFor(() => expect(mocks.openConversation).toHaveBeenCalledWith(expect.objectContaining({ backendConnectionId: 'local', workspaceId: 'ws-1', nodeId: 'r2', focus: false })));
  });

  it('shows eight conversations and the rest behind View all', () => {
    mocks.chatIds = Array.from({ length: 10 }, (_, i) => `c${i}`);
    mocks.trees = mocks.chatIds.map((id, i) => ({ id: `t${i}`, rootNodeId: id, createdAt: 1, lastActiveAt: 1_000 - i }));
    mocks.nodes = Object.fromEntries(mocks.chatIds.map((id) => [id, { kind: 'chat', title: `Conversation ${id}`, status: 'idle' }]));
    view();
    const count = () => document.querySelectorAll('.spaces-home-threads__row').length;
    expect(count()).toBe(8);
    fireEvent.click(screen.getByRole('button', { name: 'View all 10' }));
    expect(count()).toBe(10);
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(count()).toBe(8);
  });

  it('says Spaces doesn’t support a remote connection’s workspace, and reads or queues nothing for it', () => {
    mocks.retry.mockReset();
    render(<WorkspaceHomeView workspaceId="ws-1" backendConnectionId="remote-box" onOpenPage={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'rabbitholes' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Pages doesn’t support remote connections yet.rabbitholes is on a remote connection. The Meta agent reads only the workspaces on this computer, so it doesn’t write a home for this one. Its conversations are still in Conversations.');
    expect(screen.queryByText('Related conversations')).toBeNull();
    expect(screen.queryByText('Pages in this workspace')).toBeNull();
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  it('leaves the Meta agent’s maintenance runs and page helpers out of Related conversations', () => {
    mocks.chatIds = ['u1', 'm1', 'p1'];
    mocks.trees = [
      { id: 't-u', rootNodeId: 'u1', createdAt: 1, lastActiveAt: 3 },
      { id: 't-m', rootNodeId: 'm1', createdAt: 1, lastActiveAt: 9 },
      { id: 't-p', rootNodeId: 'p1', createdAt: 1, lastActiveAt: 8 },
    ];
    mocks.nodes = {
      u1: { kind: 'chat', title: 'Notarize failure', status: 'idle' },
      m1: { kind: 'chat', title: 'Space maintenance · Oct 23, 16:35', status: 'idle', maintenanceJobId: 'job-m' },
      p1: { kind: 'chat', title: 'Page helper', status: 'idle', pageId: 'pg-1' },
    };
    view();
    const rows = Array.from(document.querySelectorAll('.spaces-home-threads__row')).map((row) => row.querySelector('.spaces-home-threads__title')?.textContent);
    expect(rows).toEqual(['Notarize failure']);
  });

  it('says when a workspace has no conversations to list, and leaves out digests', () => {
    expect(workspaceConversations(undefined, {}, null)).toEqual([]);
    const project = { id: 'ws-1', chatIds: ['d'], trees: [{ id: 't', rootNodeId: 'd', createdAt: 1, lastActiveAt: 1 }], edges: [] } as unknown as Parameters<typeof workspaceConversations>[0];
    expect(workspaceConversations(project, { d: { kind: 'digest' } } as unknown as Parameters<typeof workspaceConversations>[1], null)).toEqual([]);
    view();
    expect(screen.getByText('No conversations in this workspace yet.')).toBeTruthy();
  });

  it('shows an empty workspace as a title, one line and New conversation', () => {
    mocks.home = home([], null);
    mocks.page = (mocks.home as WorkspaceHomeDto).page;
    mocks.chatIds = [];
    const goHome = vi.fn();
    window.addEventListener('michi:goto-home', goHome);
    view();
    expect(screen.getByText('No conversations yet. Start one and this page writes itself.')).toBeTruthy();
    expect(document.querySelector('.spaces-home__updated')).toBeNull();
    expect(screen.queryByText('Pages in this workspace')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    expect(mocks.selectProject).toHaveBeenCalledWith('ws-1');
    expect(goHome).toHaveBeenCalledTimes(1);
    window.removeEventListener('michi:goto-home', goHome);
  });

  it('says the first read is under way while the page is still empty, with only a skeleton below', () => {
    mocks.home = home([], run('reading'));
    mocks.page = (mocks.home as WorkspaceHomeDto).page;
    view();
    expect(screen.getByRole('status').textContent).toContain('The Meta agent is reading rabbitholes’s 38 past conversations and writes them here when it is done.');
    expect(screen.queryByTestId('empty-editor')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Pages in this workspace' })).toBeNull();
    expect(mocks.opened).not.toHaveBeenCalled();
  });

  it('follows the live first-run status when it is newer than the page’s own copy', () => {
    mocks.home = home([], run('queued', { updatedAt: 1 }));
    mocks.page = (mocks.home as WorkspaceHomeDto).page;
    mocks.live = { requestedAt: 1, workspaces: [{ workspaceId: 'ws-1', workspaceName: 'rabbitholes', homePageId: 'wh', hiddenAt: null, firstRun: run('reading', { updatedAt: 5 }) }],
      summary: { state: 'waiting', summarizedAt: null }, haltedReason: null };
    view();
    expect(screen.getByRole('status').textContent).toContain('is reading rabbitholes’s 38 past conversations');
  });

  it('marks the home opened once its first read is written', () => {
    mocks.home = home([block('l', 'Line')], run('done', { updatedAt: 77 }));
    mocks.page = (mocks.home as WorkspaceHomeDto).page;
    view();
    expect(mocks.opened).toHaveBeenCalledWith('local', 'ws-1', 77);
  });

  it('offers the empty-page editor once no first read is under way', () => {
    mocks.home = home([], null);
    mocks.page = (mocks.home as WorkspaceHomeDto).page;
    view();
    expect(screen.getByText('The Meta agent writes this page from the workspace’s conversations.')).toBeTruthy();
    expect(screen.getByTestId('empty-editor')).toBeTruthy();
  });

  it('says a queued or failed first read plainly', () => {
    mocks.home = home([], run('queued'));
    mocks.page = (mocks.home as WorkspaceHomeDto).page;
    const first = view();
    expect(screen.getByText('Queued: rabbitholes has 38 past conversations to read.')).toBeTruthy();
    first.unmount();
    mocks.home = home([], run('failed', { error: 'Quota reached' }));
    mocks.page = (mocks.home as WorkspaceHomeDto).page;
    view();
    expect(screen.getByText('Not written: Quota reached.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Pages in this workspace' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.retry).toHaveBeenCalledWith('local', 'ws-1');
  });
});


it('explains a zero-read history window without hiding older conversations or claiming From 0', () => {
  mocks.home = { ...home([], run('done', { total: 0, readCount: 0 })), firstRunDays: 60 };
  mocks.page = (mocks.home as WorkspaceHomeDto).page;
  mocks.chatIds = ['old'];
  mocks.trees = [{ id: 'old-tree', rootNodeId: 'old', createdAt: 1, lastActiveAt: 1 }];
  mocks.nodes = { old: { kind: 'chat', title: 'Earlier planning', status: 'idle' } };
  view();
  expect(screen.getByText(/no conversations in its 60-day range/)).toBeTruthy();
  expect(screen.getByText(/When background updates are enabled/)).toBeTruthy();
  expect(screen.getByText('Earlier planning')).toBeTruthy();
  expect(screen.queryByText(/From 0 conversations/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});

it('keeps written content when an empty initial range is followed by maintenance', () => {
  mocks.home = home([block('later', 'New progress')], run('done', { total: 0, readCount: 0 }));
  mocks.page = (mocks.home as WorkspaceHomeDto).page;
  view();
  expect(screen.getByText('New progress')).toBeTruthy();
  expect(screen.queryByText(/The first read found no/)).toBeNull();
  expect(screen.queryByText(/From 0 conversations/)).toBeNull();
});
