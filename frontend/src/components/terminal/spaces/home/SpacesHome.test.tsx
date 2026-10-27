import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FirstRunProgressDto, HomeSectionItem, MetaAgentOverview, PageBlock, PageChangeDto, PageDto, SpacesHomeSectionsDto, WorkspaceHomeSummaryDto } from 'michi-shared';
import type { MetaAgentInfo } from '../../../../services/api/metaAgent';
import type { SpacesFirstRunStatus } from '../../../../services/api/spacesHome';
import type { FirstRunSnapshot } from '../../../../state/metaAgent/spacesFirstRun';
import type { MetaAgentUpdateState } from '../../../../state/metaAgent/metaAgentUpdate';

const mocks = vi.hoisted(() => ({
  page: null as unknown as PageDto,
  fetchHomeConversations: vi.fn(),
  changes: [] as unknown[],
  sections: null as unknown,
  activity: [] as unknown[],
  revealBackendNode: vi.fn(),
  sourceNav: {
    openExactSourcePopover: vi.fn(),
    openSourcePopover: vi.fn(),
    // Stands in for the shell's navigator: a conversation opens where Michi reveals it.
    openConversationFromSpaces: vi.fn((input: { workspaceId?: string | null; nodeId?: string | null }) => mocks.revealBackendNode(input.workspaceId, input.nodeId)),
  },
  openNativePageRoute: vi.fn(),
  acknowledge: vi.fn(),
  refreshes: [] as Array<ReturnType<typeof vi.fn>>,
  lastSeen: 0,
  firstRun: null as unknown as FirstRunSnapshot,
  agent: { status: 'ready', info: null, error: null } as { status: string; info: MetaAgentInfo | null; error: string | null },
  overview: { status: 'ready', overview: null, error: null } as { status: string; overview: MetaAgentOverview | null; error: string | null },
  update: { phase: 'idle', workspaces: 0, error: null } as MetaAgentUpdateState,
  retryFirstRun: vi.fn(),
  retryGuard: vi.fn(),
  resume: vi.fn(),
  runUpdate: vi.fn(),
  retryStopped: vi.fn(),
  openDetail: vi.fn(),
  openSettings: vi.fn(),
  requestWorkspaceHome: vi.fn(),
  markLooked: vi.fn(),
  nodes: {} as Record<string, { viewedAt?: number; lastAssistantAt?: number }>,
  focusedNodeId: null as string | null,
  layoutRules: [] as unknown[],
  spaces: [] as unknown[],
}));

const resource = (data: unknown) => {
  const refresh = vi.fn();
  mocks.refreshes.push(refresh);
  return { data, status: 'ready', error: null, stale: false, refresh };
};

vi.mock('../../../../state/pages/useSpacesHome', () => ({
  useSpacesHome: () => resource({ role: 'spaces-home', page: mocks.page, layoutRules: mocks.layoutRules }),
  useSpacesHomeWorkspaces: () => resource([{ workspaceId: 'ws-1', workspaceName: 'rabbitholes', homePageId: 'wh', hiddenAt: null, firstRun: null }]),
  useHomeSections: () => resource(mocks.sections),
  useSpaceActivity: () => resource(mocks.activity),
  useProgressCards: () => resource([]),
}));
vi.mock('../../../../state/pages/useSpaces', () => ({ useSpaces: () => ({ spaces: mocks.spaces, status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../../../state/pages/usePage', () => ({
  usePage: () => ({
    page: mocks.page, changes: mocks.changes, status: 'ready', error: null, stale: false, lastSeenChangeSeq: 0,
    refresh: vi.fn(), edit: vi.fn(), accept: vi.fn(), dismiss: vi.fn(), reopen: vi.fn(), revert: vi.fn(), redo: vi.fn(), acknowledgeThrough: mocks.acknowledge,
  }),
}));
vi.mock('../../../../services/api/pages', () => ({ fetchPageActivitySeen: () => Promise.resolve({ lastSeenChangeSeq: mocks.lastSeen }) }));
vi.mock('../../../../state/chatStore', () => ({
  useChatActions: () => ({ revealBackendNode: mocks.revealBackendNode }),
  useChatNodesSnapshot: () => ({ 'src-node': { title: '排查公证失败' } }),
  useOptionalChatProjects: () => ({ focusedNodeId: mocks.focusedNodeId }),
  useStructuralSelector: (select: (nodes: unknown) => unknown) => select(mocks.nodes),
}));
vi.mock('../../../../services/api/spacesHome', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/api/spacesHome')>()),
  markSpacesHomeLooked: mocks.markLooked,
  fetchHomeConversations: mocks.fetchHomeConversations,
}));
vi.mock('../SpacesPage', () => ({ openNativePageRoute: mocks.openNativePageRoute }));
vi.mock('../../../../state/metaAgent/spacesFirstRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../state/metaAgent/spacesFirstRun')>()),
  useSpacesFirstRun: () => mocks.firstRun,
  retrySpacesFirstRunNow: mocks.retryFirstRun,
}));
vi.mock('../../../../state/metaAgent/useMetaAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../state/metaAgent/useMetaAgent')>()),
  useMetaAgent: () => mocks.agent,
  retryMetaAgentGuard: mocks.retryGuard,
}));
vi.mock('../../../../state/metaAgent/useMetaAgentOverview', () => ({ useMetaAgentOverview: () => mocks.overview, resumeMetaAgent: mocks.resume }));
vi.mock('../../../../state/metaAgent/metaAgentUpdate', () => ({ useMetaAgentUpdate: () => mocks.update, runMetaAgentUpdate: mocks.runUpdate, retryStoppedMetaAgent: mocks.retryStopped }));
vi.mock('../../scheduled/metaAgent/metaAgentNav', () => ({ openMetaAgentDetail: mocks.openDetail, requestMetaAgentSettings: mocks.openSettings }));
vi.mock('../../../../state/pages/workspaceHomeNav', () => ({ requestWorkspaceHome: mocks.requestWorkspaceHome }));
vi.mock('../NativeDatabase', () => ({ default: () => null }));
vi.mock('../PageChangeTargets', () => ({
  PageChangeTargets: ({ changes, target, onOpenSource, sourceLabel }: { changes: PageChangeDto[]; target: { blockId: string }; onOpenSource(source: unknown): void; sourceLabel?(source: PageChangeDto['source']): string | undefined }) => {
    const mine = changes.filter((change) => (change.target as { blockId?: string }).blockId === target.blockId);
    return mine.length ? <span>
      <span data-testid={`changes-${target.blockId}`}>{mine.map((change) => change.seq).join(',')}</span>
      {mine.map((change) => change.source && <span key={`from-${change.id}`} data-testid={`from-${change.id}`}>{sourceLabel?.(change.source)}</span>)}
      <button type="button" onClick={() => onOpenSource({ kind: 'chat', nodeId: 'src-node', turnId: 'src-turn', assistantId: 'src-msg' })}>Source {target.blockId}</button>
    </span> : null;
  },
}));
vi.mock('./homeLinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./homeLinks')>()),
  useSpacesSourceNav: () => mocks.sourceNav,
  NewChatSheetSlot: ({ scope }: { scope: unknown }) => <div data-testid="sheet-slot" data-scope={JSON.stringify(scope)} />,
  SpaceProgressCardList: ({ scope, cards, everyPage }: { scope: unknown; cards: unknown[]; everyPage?: boolean }) => (
    <div data-testid="progress-cards" data-scope={JSON.stringify(scope)} data-count={cards.length} data-every={String(everyPage === true)} />
  ),
}));
vi.mock('../NativePageDocument', () => ({
  default: ({ page, visibleBlocks = page.blocks, renderDecorations }: { page: PageDto; visibleBlocks?: readonly PageBlock[]; renderDecorations?: (block: PageBlock) => React.ReactNode }) => (
    <div data-testid="segment">
      {visibleBlocks.map((block) => <div key={block.id} id={`page-block-${block.id}`} data-testid="page-block">
        {block.type === 'home-section' ? <NativeHomeSection section={block.section} connectionId="local" pageId={page.id} readOnly={false} /> : block.id.startsWith('tbl') ? <table><tbody><tr><td>rabbitholes</td><td>Release next week</td></tr><tr><td>Unknown</td><td>-</td></tr></tbody></table> : 'text' in block ? block.text : block.id}
        {renderDecorations?.(block)}
      </div>)}
      {!page.blocks.length && <div data-testid="empty-editor" />}
    </div>
  ),
}));

import { NativeHomeSection } from './NativeHomeSection';
import { SpacesHomeView } from './SpacesHome';

const source = [{ nodeId: 'n', turnId: 't', assistantId: 'a' }];
const block = (id: string, extra: Partial<PageBlock> = {}) => ({ id, rev: 1, type: 'markdown', text: `Block ${id}`, sources: source, ...extra }) as PageBlock;
const homePage = (blocks: PageBlock[]): PageDto => ({
  id: 'home', workspaceId: 'sys', parentId: null, position: 0, title: 'Home', color: null, updatedAt: 1, updatedBy: 'agent',
  pendingProposals: 0, helperNodeId: null, revision: 2, viewVersion: 2, blocks,
});
const row = (id: string, extra: Partial<HomeSectionItem> = {}): HomeSectionItem => ({
  id, kind: 'conversation', workspaceId: 'ws-1', workspaceName: 'rabbitholes', title: `Thread ${id}`, at: Date.now() - 60_000, summary: `About ${id}`, agentClaim: false,
  target: { kind: 'conversation', nodeId: `node-${id}`, workspaceId: 'ws-1', messageId: null }, ...extra,
});
const INFO: MetaAgentInfo = {
  settings: { runtimeId: null, providerId: null, modelId: null, reasoning: null },
  resolved: { runtimeId: 'claude', providerId: null, modelId: null, reasoning: null, followsGlobal: true },
  availability: { available: true, reason: null },
  guard: { maintenance: null, chat: null },
};
const run = (workspaceId: string, state: FirstRunProgressDto['state'], readCount: number, total: number, extra: Partial<FirstRunProgressDto> = {}): FirstRunProgressDto => ({
  workspaceId, startedAt: 1, startSeq: 100, readCount, total, state, error: null, updatedAt: 2, ...extra,
});
const home = (workspaceId: string, workspaceName: string, firstRun: FirstRunProgressDto | null): WorkspaceHomeSummaryDto => ({
  workspaceId, workspaceName, homePageId: `home-${workspaceId}`, hiddenAt: null, firstRun,
});
/** State 04: two homes written, sample-dashboard read 12 of 21, two more queued. */
const midRun = (over: Partial<SpacesFirstRunStatus> = {}): SpacesFirstRunStatus => ({
  requestedAt: 1,
  workspaces: [
    home('ws-1', 'rabbitholes', run('ws-1', 'done', 38, 38, { startSeq: 1289 })),
    home('ws-2', 'agent-desk', run('ws-2', 'done', 112, 112, { startSeq: 4012 })),
    home('ws-3', 'sample-dashboard', run('ws-3', 'reading', 12, 21)),
    home('ws-4', 'sample-notes', run('ws-4', 'queued', 0, 17)),
    home('ws-5', '个人', run('ws-5', 'queued', 0, 6)),
  ],
  summary: { state: 'waiting', summarizedAt: null },
  haltedReason: null,
  ...over,
});
const snapshot = (data: SpacesFirstRunStatus | null, extra: Partial<FirstRunSnapshot> = {}): FirstRunSnapshot => ({
  load: 'ready', data, error: null, unreachable: false, schedulerOff: false, justFinished: false, ...extra,
});
const sections = (over: Partial<SpacesHomeSectionsDto> = {}): SpacesHomeSectionsDto => ({
  waiting: { items: [row('w1')], total: 1 }, stalled: { items: [], total: 0 }, done: { items: [], total: 0 }, conversations: { available: true }, ...over,
});

beforeEach(() => {
  mocks.page = homePage([block('a'), { id: 'waiting', rev: 1, type: 'home-section', section: 'waiting' }, ...['b', 'c', 'd', 'e'].map((id) => block(id))]);
  mocks.changes = [];
  mocks.sections = sections();
  mocks.activity = [];
  mocks.lastSeen = 0;
  mocks.refreshes = [];
  mocks.revealBackendNode.mockReset().mockResolvedValue(true);
  for (const fn of Object.values(mocks.sourceNav)) fn.mockClear();
  mocks.openNativePageRoute.mockReset();
  mocks.acknowledge.mockReset().mockResolvedValue(undefined);
  mocks.firstRun = snapshot(null);
  mocks.agent = { status: 'ready', info: INFO, error: null };
  mocks.overview = { status: 'ready', overview: null, error: null };
  mocks.update = { phase: 'idle', workspaces: 0, error: null };
  for (const fn of [mocks.retryFirstRun, mocks.retryGuard, mocks.resume, mocks.runUpdate, mocks.retryStopped, mocks.openDetail, mocks.openSettings, mocks.requestWorkspaceHome]) fn.mockReset();
  mocks.markLooked.mockReset().mockResolvedValue({ lookedAt: 1 });
  mocks.nodes = {};
  mocks.focusedNodeId = null;
  mocks.spaces = [];
  mocks.retryGuard.mockResolvedValue(undefined);
  mocks.retryFirstRun.mockResolvedValue(undefined);
});
afterEach(() => { document.body.innerHTML = ''; });

const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('Spaces Home', () => {
  it('reads top to bottom: lead, Waiting, longer blocks, activity, workspaces, Stalled and Done, the rest; no agenda', () => {
    render(<SpacesHomeView now={new Date(2026, 9, 23)} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    expect(screen.queryByText('Across all workspaces · kept up to date by the Meta agent')).toBeNull();
    expect(document.querySelector('.spaces-home-status')).toBeNull();
    expect(screen.queryByRole('group', { name: "Today's agenda" })).toBeNull();
    const text = (value: string) => screen.getByText(value);
    const order = [text('Block a'), screen.getByRole('heading', { name: 'Waiting on you' }),
      text('Block b'), text('Block c'), screen.getByRole('heading', { name: 'Page activity' }), text('Block d'),
      screen.getByRole('heading', { name: 'Stalled' }), screen.getByRole('heading', { name: 'Just done' }), text('Block e')];
    for (let index = 1; index < order.length; index += 1) expect(before(order[index - 1], order[index])).toBe(true);
    expect(screen.getAllByText('Counted from your chats')).toHaveLength(3);
  });

  it('keeps agent and person blocks free of repeated maintenance labels', () => {
    mocks.page = homePage([block('a'), block('b'), block('c', { edit: { at: 1 } })]);
    render(<SpacesHomeView />);
    expect(screen.queryByText('Agent maintained')).toBeNull();
    expect(screen.getByText('Block b')).toBeTruthy();
    expect(screen.getByText('Block c')).toBeTruthy();
  });

  it('shows this page’s update time below the title without a different workspace’s write time', () => {
    const updatedAt = Date.now() - 5 * 60_000;
    mocks.page = { ...homePage([block('a')]), updatedAt };
    render(<SpacesHomeView meta={{ lastWrite: { workspaceName: 'rabbitholes', at: Date.now() - 12 * 60_000 } }} />);
    const title = screen.getByRole('heading', { level: 1, name: 'Home' });
    const updated = screen.getByText('Updated 5m ago');
    expect(title.closest('header')?.contains(updated)).toBe(true);
    expect(before(title, updated)).toBe(true);
    expect(updated.getAttribute('datetime')).toBe(new Date(updatedAt).toISOString());
    expect(screen.queryByText(/wrote rabbitholes/)).toBeNull();
  });

  it('does not give an unwritten Home an update time', () => {
    mocks.page = homePage([]);
    render(<SpacesHomeView />);
    expect(document.querySelector('.spaces-home__updated')).toBeNull();
  });

  it('marks only changes made since the last visit and suggestions still waiting', async () => {
    mocks.lastSeen = 5;
    mocks.changes = [
      { id: 'c1', seq: 3, proposalState: null, target: { kind: 'block', pageId: 'home', blockId: 'a' } },
      { id: 'c2', seq: 4, proposalState: 'pending', target: { kind: 'block', pageId: 'home', blockId: 'b' } },
      { id: 'c3', seq: 7, proposalState: null, target: { kind: 'block', pageId: 'home', blockId: 'c' } },
    ];
    render(<SpacesHomeView />);
    await waitFor(() => expect(screen.getByTestId('changes-c').textContent).toBe('7'));
    expect(screen.getByTestId('changes-b').textContent).toBe('4');
    expect(screen.queryByTestId('changes-a')).toBeNull();
  });

  it('records what was seen when the person leaves', async () => {
    mocks.lastSeen = 2;
    mocks.changes = [{ id: 'c3', seq: 9, proposalState: null, target: { kind: 'block', pageId: 'home', blockId: 'c' } }];
    const view = render(<SpacesHomeView />);
    await waitFor(() => expect(screen.getByTestId('changes-c')).toBeTruthy());
    view.unmount();
    expect(mocks.acknowledge).toHaveBeenCalledWith(9);
  });

  it('shows placeholders without recreating a deleted Waiting block', () => {
    mocks.page = homePage([]);
    render(<SpacesHomeView />);
    expect(screen.getAllByText('The Meta agent writes this after it has written each workspace home.')).toHaveLength(4);
    expect(screen.getByRole('region', { name: 'This week’s focus' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Workspaces' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Cross-workspace decisions' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Waiting on you' })).toBeNull();
    expect(screen.queryByText('About w1')).toBeNull();
    expect(screen.getByTestId('empty-editor')).toBeTruthy();
  });

  it('marks a section a layout rule shaped, under its rows', () => {
    mocks.layoutRules = [{
      id: 'rule-1', text: 'Stalled: only the last 3 days', createdBy: 'agent', createdAt: Date.now(),
      sourceMessage: null, sectionLimit: { section: 'stalled', maxAgeDays: 3 },
    }];
    mocks.sections = sections({ stalled: { items: [row('s1')], total: 4, ruleIds: ['rule-1'] } });
    render(<SpacesHomeView />);
    const stalled = screen.getByRole('region', { name: 'Stalled' });
    expect(within(stalled).getByTestId('layout-rule-mark').getAttribute('title')).toBe('Layout rule: Stalled: only the last 3 days');
    expect(within(screen.getByRole('region', { name: 'Waiting on you' })).queryByTestId('layout-rule-mark')).toBeNull();
    mocks.layoutRules = [];
  });

  it('expands additional rows in place without opening All threads', async () => {
    const items = Array.from({ length: 10 }, (_, index) => row(`s${index}`));
    mocks.sections = sections({ stalled: { items: items.slice(0, 8), total: 10 } });
    mocks.fetchHomeConversations.mockResolvedValue({ items, total: 10 });
    const nav = vi.fn();
    window.addEventListener('michi:nav-page', nav);
    render(<SpacesHomeView />);
    const stalled = screen.getByRole('region', { name: 'Stalled' });
    expect(within(stalled).getAllByTestId('spaces-home-row')).toHaveLength(8);
    fireEvent.click(within(stalled).getByRole('button', { name: /View all/ }));
    await waitFor(() => expect(within(stalled).getAllByTestId('spaces-home-row')).toHaveLength(10));
    expect(mocks.fetchHomeConversations).toHaveBeenCalledWith('local', expect.objectContaining({ state: 'stalled', limit: 500 }));
    expect(nav).not.toHaveBeenCalled();
    fireEvent.click(within(stalled).getByRole('button', { name: /Show less/ }));
    expect(within(stalled).getAllByTestId('spaces-home-row')).toHaveLength(8);
    window.removeEventListener('michi:nav-page', nav);
  });

  it('keeps the section available when expansion fails and retries in place', async () => {
    const items = Array.from({ length: 9 }, (_, index) => row(`retry${index}`));
    mocks.sections = sections({ stalled: { items: items.slice(0, 8), total: 9 } });
    mocks.fetchHomeConversations.mockRejectedValueOnce(new Error('Connection unavailable')).mockResolvedValueOnce({ items, total: 9 });
    render(<SpacesHomeView />);
    const stalled = screen.getByRole('region', { name: 'Stalled' });
    fireEvent.click(within(stalled).getByRole('button', { name: /View all/ }));
    expect((await within(stalled).findByRole('alert')).textContent).toContain('Connection unavailable');
    expect(within(stalled).getAllByTestId('spaces-home-row')).toHaveLength(8);
    fireEvent.click(within(stalled).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(within(stalled).getAllByTestId('spaces-home-row')).toHaveLength(9));
    expect(within(stalled).queryByRole('alert')).toBeNull();
  });

  it('keeps already read Just done conversations out of expanded rows', async () => {
    const items = Array.from({ length: 10 }, (_, index) => row(`done${index}`));
    mocks.sections = sections({ done: { items: items.slice(0, 8), total: 10 } });
    const read = items[8]!;
    if (read.target.kind !== 'conversation') throw new Error('Expected conversation fixture');
    mocks.nodes = { [read.target.nodeId]: { viewedAt: Date.now() + 1_000_000 } };
    mocks.fetchHomeConversations.mockResolvedValue({ items, total: 10 });
    render(<SpacesHomeView />);
    const done = screen.getByRole('region', { name: 'Just done' });
    fireEvent.click(within(done).getByRole('button', { name: /View all/ }));
    await waitFor(() => expect(within(done).getAllByTestId('spaces-home-row')).toHaveLength(9));
    expect(within(done).queryByText(read.title)).toBeNull();
  });

  it('counts leaving the Home as having looked, once it showed the sections', async () => {
    const { unmount } = render(<SpacesHomeView />);
    expect(mocks.markLooked).not.toHaveBeenCalled();
    unmount();
    await Promise.resolve();
    expect(mocks.markLooked).toHaveBeenCalledTimes(1);
    expect(mocks.markLooked).toHaveBeenCalledWith('local');

    mocks.sections = null;
    const unread = render(<SpacesHomeView />);
    unread.unmount();
    await Promise.resolve();
    expect(mocks.markLooked).toHaveBeenCalledTimes(1);
  });

  it('says when a section is empty', () => {
    mocks.sections = sections({ waiting: { items: [], total: 0 } });
    render(<SpacesHomeView />);
    expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy();
    expect(screen.getByText('Nothing has stalled.')).toBeTruthy();
    expect(screen.getByText('Nothing finished since you last looked.')).toBeTruthy();
  });

  it('drops a Just done row once you opened its conversation after it finished, as the sidebar dot clears', () => {
    const at = Date.now() - 60_000;
    mocks.sections = sections({ done: { items: [row('d1', { at }), row('d2', { at }), row('d3', { at }), row('d4', { at })], total: 6 } });
    mocks.nodes = { 'node-d1': { viewedAt: at + 1 }, 'node-d2': { viewedAt: at - 1 }, 'node-d4': { viewedAt: at + 5, lastAssistantAt: at + 10 } };
    mocks.focusedNodeId = 'node-d3';
    render(<SpacesHomeView />);
    const done = screen.getByRole('region', { name: 'Just done' });
    expect(within(done).getAllByTestId('spaces-home-row').map((el) => el.textContent?.match(/Thread d\d/)?.[0])).toEqual(['Thread d2', 'Thread d4']);
    expect(done.querySelector('.spaces-home-count')?.textContent).toBe('4');
  });

  it('opens the new-chat sheet above the title and lists every page’s progress cards alongside the saved blocks', () => {
    render(<SpacesHomeView />);
    const doc = document.querySelector('.spaces-home__doc')!;
    const sheet = screen.getByTestId('sheet-slot');
    expect(doc.firstElementChild).toBe(sheet);
    const scope = { backendConnectionId: 'local', pageId: 'home', workspaceId: null, workspaceName: null, pageTitle: 'Home' };
    expect(JSON.parse(sheet.getAttribute('data-scope')!)).toEqual(scope);
    const cards = screen.getByTestId('progress-cards');
    expect(JSON.parse(cards.getAttribute('data-scope')!)).toEqual(scope);
    expect(cards.getAttribute('data-every')).toBe('true');
    expect(before(screen.getByText('Block a'), cards)).toBe(true);
    expect(before(screen.getByRole('heading', { name: 'Waiting on you' }), cards)).toBe(true);
  });

  it('opens a row’s conversation at its message with a way back, the cursor in the composer only for Continue', async () => {
    const target = { kind: 'conversation' as const, nodeId: 'node-s1', workspaceId: 'ws-1', messageId: 'msg-1' };
    mocks.sections = sections({ stalled: { items: [row('s1', { target })], total: 1 } });
    render(<SpacesHomeView />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat: Thread w1' }));
    expect(mocks.sourceNav.openConversationFromSpaces).toHaveBeenLastCalledWith({
      backendConnectionId: 'local', workspaceId: 'ws-1', nodeId: 'node-w1', messageId: null, focus: false,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue: Thread s1' }));
    expect(mocks.sourceNav.openConversationFromSpaces).toHaveBeenLastCalledWith({
      backendConnectionId: 'local', workspaceId: 'ws-1', nodeId: 'node-s1', messageId: 'msg-1', focus: true,
    });
  });

  it('opens a block change’s source in the source popover, naming the Home as the page that cites it', () => {
    mocks.changes = [{ id: 'c1', seq: 3, proposalState: 'pending', target: { kind: 'block', pageId: 'home', blockId: 'b' } }];
    render(<SpacesHomeView />);
    fireEvent.click(screen.getByRole('button', { name: 'Source b' }));
    expect(mocks.sourceNav.openExactSourcePopover).toHaveBeenCalledWith(
      { backendConnectionId: 'local', workspaceId: 'sys' },
      { kind: 'chat', nodeId: 'src-node', turnId: 'src-turn', assistantId: 'src-msg' },
      { page: { backendConnectionId: 'local', workspaceId: 'sys', pageId: 'home', title: 'Home' } },
    );
  });

  it('names a change\'s source only by a conversation title: what a Home summary read is on its change record', async () => {
    mocks.firstRun = snapshot({ requestedAt: 1, workspaces: [], summary: { state: 'done', summarizedAt: 100 }, haltedReason: null } as SpacesFirstRunStatus);
    const summary = { kind: 'maintenance', nodeId: 'n', turnId: 't', assistantId: 'm', jobId: 'job', runId: 'run-1', evidence: [], read: { kind: 'workspace-homes', count: 2 } };
    mocks.changes = [
      { id: 'c1', seq: 3, proposalState: null, createdAt: 100, target: { kind: 'block', pageId: 'home', blockId: 'b' }, source: summary },
      { id: 'c2', seq: 4, proposalState: null, createdAt: 100, target: { kind: 'block', pageId: 'home', blockId: 'a' },
        source: { kind: 'chat', nodeId: 'src-node', turnId: 'src-turn', assistantId: 'src-msg' } },
    ];
    mocks.lastSeen = 0;
    mocks.page = homePage([block('a'), block('b')]);
    render(<SpacesHomeView />);
    // ChangeCard says "from 2 workspace homes" from the record; no label is made up for it here.
    expect((await screen.findByTestId('from-c1')).textContent).toBe('');
    expect(screen.getByTestId('from-c2').textContent).toBe('排查公证失败');
  });

  it('tags a done the agent claims and opens rows where they live', async () => {
    mocks.sections = sections({
      waiting: { items: [row('w1')], total: 1 },
      done: { items: [row('d1', { agentClaim: true })], total: 1 },
    });
    render(<SpacesHomeView />);
    const done = screen.getByRole('region', { name: 'Just done' });
    expect(within(done).getByText('Agent says')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back to chat: Thread w1' }));
    await waitFor(() => expect(mocks.revealBackendNode).toHaveBeenCalledWith('ws-1', 'node-w1'));
  });

  it('opens a waiting suggestion on its page and flashes the block once it renders', async () => {
    vi.useFakeTimers();
    try {
      mocks.sections = sections({ waiting: { items: [row('p1', {
        kind: 'proposal', title: 'Release', target: { kind: 'page', pageId: 'release', blockId: 'risk', changeId: 'chg' },
      })], total: 1 } });
      const view = render(<SpacesHomeView />);
      fireEvent.click(screen.getByRole('button', { name: 'Review: Release' }));
      expect(mocks.openNativePageRoute).toHaveBeenCalledWith({ pageId: 'release', workspaceId: 'ws-1', backendConnectionId: 'local' });
      // Opening the page replaces the Home; the block shows up once that page has loaded.
      view.unmount();
      act(() => { vi.advanceTimersByTime(1000); });
      const target = document.createElement('div');
      target.id = 'page-block-risk';
      document.body.appendChild(target);
      act(() => { vi.advanceTimersByTime(150); });
      expect(target.hasAttribute('data-home-flash')).toBe(true);
      act(() => { vi.advanceTimersByTime(1700); });
      expect(target.hasAttribute('data-home-flash')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flashes a suggestion on the Home itself without reopening it', () => {
    mocks.sections = sections({ waiting: { items: [row('p2', {
      kind: 'proposal', title: 'Home', target: { kind: 'page', pageId: 'home', blockId: 'b', changeId: 'chg' },
    })], total: 1 } });
    render(<SpacesHomeView />);
    fireEvent.click(screen.getByRole('button', { name: 'Review: Home' }));
    expect(mocks.openNativePageRoute).not.toHaveBeenCalled();
    expect(document.getElementById('page-block-b')?.hasAttribute('data-home-flash')).toBe(true);
  });

  it('opens Space activity rows', async () => {
    mocks.activity = [
      { kind: 'page-change', batchId: 'b1', pageId: 'release', pageTitle: 'Release', workspaceId: 'ws-1', workspaceName: 'rabbitholes', at: Date.now(), count: 2, pending: 1, ops: ['update'], summary: '**Risk** rewritten\\ today', actor: 'agent', sourceKind: 'chat', sourceNodeId: 'n1' },
      { kind: 'conversation', threadNodeId: 'n2', title: 'Perf', workspaceId: 'ws-1', workspaceName: 'rabbitholes', startedFromPageId: 'release', startedFromPageTitle: 'Release', at: Date.now() },
    ];
    render(<SpacesHomeView />);
    expect(screen.getByText(/Agent changed 2 places, 1 waiting for you: Risk rewritten today/)).toBeTruthy();
    fireEvent.click(screen.getByText(/Agent changed 2 places/).closest('button')!);
    expect(mocks.openNativePageRoute).toHaveBeenCalledWith({ pageId: 'release', workspaceId: 'ws-1', backendConnectionId: 'local' });
    fireEvent.click(screen.getByText(/New conversation “Perf”/).closest('button')!);
    await waitFor(() => expect(mocks.revealBackendNode).toHaveBeenCalledWith('ws-1', 'n2'));
  });

  it('runs Update through its callback, or runs a Meta agent round and re-reads the Home without one', () => {
    const onUpdate = vi.fn();
    const first = render(<SpacesHomeView onUpdate={onUpdate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.runUpdate).not.toHaveBeenCalled();
    first.unmount();

    mocks.refreshes = [];
    render(<SpacesHomeView />);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(mocks.runUpdate).toHaveBeenCalledWith('local');
    expect(mocks.refreshes.some((refresh) => refresh.mock.calls.length > 0)).toBe(true);
  });

  it('shows Update progress on its button without the routine status strip', () => {
    mocks.update = { phase: 'running', workspaces: 2, error: null };
    const view = render(<SpacesHomeView />);
    expect(document.querySelector('.spaces-home-status')).toBeNull();
    expect((screen.getByRole('button', { name: 'Update' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Update' }).getAttribute('aria-busy')).toBe('true');
    view.unmount();
    mocks.update = { phase: 'no-new', workspaces: 0, error: null };
    render(<SpacesHomeView />);
    expect(document.querySelector('.spaces-home-status')).toBeNull();
    expect((screen.getByRole('button', { name: 'Update' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps routine runtime details and Scheduled out of the Home', () => {
    mocks.agent = { status: 'ready', info: { ...INFO, resolved: { ...INFO.resolved, runtimeId: 'kiro', followsGlobal: false } }, error: null };
    render(<SpacesHomeView />);
    expect(document.querySelector('.spaces-home-status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Scheduled' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
  });

  it('shows the first read in progress: the line, a bar and every workspace’s row, with Agent blocks held as placeholders', () => {
    mocks.page = homePage([]);
    mocks.firstRun = snapshot(midRun());
    render(<SpacesHomeView />);
    expect(document.querySelector('.spaces-home-status__text')?.textContent)
      .toContain('First time opening Pages · Meta agent (Claude) is reading the last 30 days · 162 / 194 · writing sample-dashboard’s home');
    expect(screen.getByText('sample-dashboard', { selector: 'b' })).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'First read' });
    expect(bar.getAttribute('aria-valuenow')).toBe('162');
    expect(bar.getAttribute('aria-valuemax')).toBe('194');
    const list = screen.getByRole('list', { name: 'Meta agent per workspace' });
    expect(within(list).getByText('History 38 · home written · continues from #1289')).toBeTruthy();
    expect(within(list).getByText('Reading history 12/21')).toBeTruthy();
    expect(within(list).getByText('Queued · history 17')).toBeTruthy();
    expect(within(list).getByText('Waits for every workspace home')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByText('The Meta agent writes this after it has written each workspace home.')).toHaveLength(4);
    expect(screen.queryByTestId('empty-editor')).toBeNull();
    fireEvent.click(within(list).getByRole('button', { name: 'Open agent-desk' }));
    expect(mocks.requestWorkspaceHome).toHaveBeenCalledWith({ workspaceId: 'ws-2', backendConnectionId: 'local' });
  });

  it('says why a workspace home was not written and retries just that one', () => {
    const status = midRun();
    status.workspaces[3] = home('ws-4', 'sample-notes', run('ws-4', 'failed', 3, 17, { error: 'Claude usage limit reached' }));
    mocks.firstRun = snapshot(status);
    render(<SpacesHomeView />);
    const list = screen.getByRole('list', { name: 'Meta agent per workspace' });
    expect(within(list).getByText('Not written: Claude usage limit reached')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Retry sample-notes' }));
    expect(mocks.retryFirstRun).toHaveBeenCalledWith('local', 'ws-4');
  });

  it('says the history was just read once the first run ends, with the list still open', () => {
    const done = midRun({ summary: { state: 'done', summarizedAt: 5 } });
    done.workspaces = done.workspaces.map((item) => ({ ...item, firstRun: run(item.workspaceId, 'done', item.firstRun!.total, item.firstRun!.total) }));
    mocks.firstRun = snapshot(done, { justFinished: true });
    render(<SpacesHomeView />);
    expect(screen.getByText(/Meta agent just read the history; from now on it checks new conversations every 60 s · wrote 5 workspace homes and this page · Claude \(follows global\)/)).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Meta agent per workspace' })).getByText('Written · read 5 workspace homes, not conversations')).toBeTruthy();
  });

  it('after the first run, a workspace home change updates the Home in the background, not as a first run', () => {
    const later = (state: 'due' | 'running') => {
      const status = midRun({ summary: { state, summarizedAt: 5 }, closed: true });
      status.workspaces = status.workspaces.map((item) => ({ ...item, firstRun: run(item.workspaceId, 'done', item.firstRun!.total, item.firstRun!.total) }));
      return status;
    };
    mocks.firstRun = snapshot(later('due'));
    const view = render(<SpacesHomeView />);
    expect(screen.queryByText(/First time opening Pages/)).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Meta agent per workspace' })).toBeNull();
    expect(document.querySelector('.spaces-home-status')).toBeNull();
    expect(screen.queryByText('updating the Pages Home…')).toBeNull();
    view.unmount();

    mocks.firstRun = snapshot(later('running'));
    render(<SpacesHomeView />);
    expect(screen.queryByText(/First time opening Pages/)).toBeNull();
    expect(screen.queryByText('updating the Pages Home…')).toBeNull();
    expect(document.querySelector('.spaces-home-status')).toBeNull();
  });

  it('turns the status line into the red box when a restriction check failed, and retries it', async () => {
    mocks.agent = { status: 'ready', info: { ...INFO, resolved: { ...INFO.resolved, runtimeId: 'kiro' }, guard: {
      maintenance: { state: 'failed', runtimeId: 'kiro', toolset: 'maintenance', unexpectedTools: ['fs_write', 'execute_bash'], checkedAt: 1 }, chat: null,
    } }, error: null };
    mocks.firstRun = snapshot(midRun({ haltedReason: 'kiro: fs_write, execute_bash' }));
    render(<SpacesHomeView />);
    const box = screen.getByRole('alert');
    expect(within(box).getByText('Meta agent stopped: Kiro started with extra tools')).toBeTruthy();
    expect(within(box).getByText('fs_write')).toBeTruthy();
    expect(within(box).getByText('execute_bash')).toBeTruthy();
    expect(screen.queryByText(/Meta agent checks new conversations/)).toBeNull();
    fireEvent.click(within(box).getByRole('button', { name: 'Change runtime' }));
    expect(mocks.openSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(within(box).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mocks.retryFirstRun).toHaveBeenCalledWith('local'));
    expect(mocks.retryGuard).toHaveBeenCalledTimes(1);
  });

  it('says the Meta agent is paused and resumes it', () => {
    mocks.overview = { status: 'ready', overview: { state: 'paused' } as MetaAgentOverview, error: null };
    render(<SpacesHomeView />);
    expect(screen.getByText('Meta agent is paused')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(mocks.resume).toHaveBeenCalledTimes(1);
  });

  it('says the Meta agent stopped and why, retries it and offers another runtime', async () => {
    mocks.retryStopped.mockResolvedValue(undefined);
    mocks.agent = { status: 'ready', info: { ...INFO, resolved: { ...INFO.resolved, runtimeId: 'codex', followsGlobal: false } }, error: null };
    mocks.overview = { status: 'ready', error: null, overview: { state: 'error', error: 'Codex is not installed on this computer',
      stopped: { reason: 'runtime-missing', message: 'Codex is not installed on this computer', workspaceIds: ['ws-1'], detail: 'codex binary not found' },
      cursors: [{ workspaceId: 'ws-1', workspaceName: 'rabbitholes', cursor: 3, unread: 2, lastRunAt: null, state: 'error', error: 'codex binary not found',
        problem: { reason: 'runtime-missing', message: 'Codex is not installed on this computer', stopped: true } }],
      recentRuns: [] } as unknown as MetaAgentOverview };
    render(<SpacesHomeView />);
    const line = document.querySelector('.spaces-home-status[data-mode="stopped"]')!;
    expect(line.textContent).toBe('Meta agent stopped: Codex is not installed on this computer·Retry·Change runtime·Details·Scheduled');
    expect(screen.queryByText(/checks new conversations/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(within(screen.getByRole('list', { name: 'Meta agent per workspace' })).getByText('Stopped: Codex is not installed on this computer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change runtime' }));
    expect(mocks.openSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mocks.retryStopped).toHaveBeenCalledWith('local'));
  });

  it('reads the first-run range Settings chose, or the one the running first read was queued with', () => {
    mocks.page = homePage([]);
    mocks.firstRun = snapshot(midRun());
    mocks.agent = { status: 'ready', info: { ...INFO, settings: { ...INFO.settings, firstRunDays: 7 } }, error: null };
    const view = render(<SpacesHomeView />);
    expect(document.querySelector('.spaces-home-status__text')?.textContent).toContain('is reading the last 7 days');
    view.unmount();
    mocks.overview = { status: 'ready', error: null, overview: { state: 'running', cursors: [], recentRuns: [{ kind: 'first-run', firstRunDays: 90 }] } as unknown as MetaAgentOverview };
    render(<SpacesHomeView />);
    expect(document.querySelector('.spaces-home-status__text')?.textContent).toContain('is reading the last 90 days');
  });

  it('gives the reason when the Meta agent cannot run on its runtime and leads to its settings', () => {
    mocks.agent = { status: 'ready', info: { ...INFO, resolved: { ...INFO.resolved, runtimeId: 'crew' }, availability: { available: false, reason: 'The Meta agent does not run on Kiro Crew yet.' } }, error: null };
    render(<SpacesHomeView />);
    expect(screen.getByText('Meta agent is not running · The Meta agent does not run on Kiro Crew yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Settings › Meta agent' }));
    expect(mocks.openSettings).toHaveBeenCalledTimes(1);
  });

  it('says the Meta agent cannot run where scheduled jobs are off', () => {
    mocks.firstRun = snapshot(midRun({ requestedAt: null }), { schedulerOff: true });
    render(<SpacesHomeView />);
    expect(screen.getByText('Meta agent is not running · Scheduled jobs are off on this backend')).toBeTruthy();
    // Settings cannot turn scheduled jobs on.
    expect(screen.queryByRole('button', { name: 'Settings › Meta agent' })).toBeNull();
  });

  it('says not running when the overview reports scheduled jobs off, though the first-run start never answered 409', () => {
    mocks.overview = { status: 'ready', error: null, overview: { state: 'running', stopped: null, cursors: [], recentRuns: [],
      notRunning: { reason: 'scheduler-off', message: 'Scheduled jobs are off on this backend' } } as unknown as MetaAgentOverview };
    render(<SpacesHomeView />);
    expect(screen.getByText('Meta agent is not running · Scheduled jobs are off on this backend')).toBeTruthy();
    expect(screen.queryByText(/checks new conversations/)).toBeNull();
  });

  it('says the backend is not connected and keeps Update off', () => {
    mocks.firstRun = snapshot(null, { unreachable: true });
    render(<SpacesHomeView />);
    expect(screen.getByText(/Backend not connected/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Update' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens a workspace’s home from its name on a row and from a table row naming it', () => {
    mocks.page = homePage([block('a'), { id: 'waiting', rev: 1, type: 'home-section', section: 'waiting' }, block('tbl-ws')]);
    render(<SpacesHomeView />);
    fireEvent.click(screen.getByRole('button', { name: 'rabbitholes' }));
    expect(mocks.requestWorkspaceHome).toHaveBeenLastCalledWith({ workspaceId: 'ws-1', backendConnectionId: 'local' });
    mocks.requestWorkspaceHome.mockReset();
    fireEvent.click(screen.getByText('Unknown'));
    expect(mocks.requestWorkspaceHome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Release next week'));
    expect(mocks.requestWorkspaceHome).toHaveBeenCalledWith({ workspaceId: 'ws-1', backendConnectionId: 'local' });
    // A linked row is a control: clicking it does not also target its block in the chat window.
    expect(screen.getByText('Release next week').closest('tr')!.hasAttribute('data-michi-interactive')).toBe(true);
    expect(screen.getByText('Unknown').closest('tr')!.hasAttribute('data-michi-interactive')).toBe(false);
  });

  it('starts a table row naming a workspace with that workspace’s sidebar dot', () => {
    mocks.page = homePage([block('a'), block('tbl-ws', { text: '#### 各 workspace\n\n| Workspace | 现在 |\n|---|---|\n| rabbitholes | Release next week |' })]);
    mocks.sections = sections({ byWorkspace: { 'ws-1': { waiting: 0, stalled: 2 } } });
    const view = render(<SpacesHomeView />);
    const linked = () => screen.getByText('Release next week').closest('tr')!;
    expect(linked().getAttribute('data-home-tone')).toBe('stalled');
    expect(screen.getByText('Unknown').closest('tr')!.hasAttribute('data-home-tone')).toBe(false);
    // A suggestion waiting in one of its Spaces makes it a workspace waiting on you, as in the sidebar.
    mocks.spaces = [{ id: 'sp', workspaceId: 'ws-1', pendingProposals: 1 }];
    view.rerender(<SpacesHomeView />);
    expect(linked().getAttribute('data-home-tone')).toBe('waiting');
  });

  it('keeps the normal Home free of maintenance status overrides', () => {
    render(<SpacesHomeView meta={{ intervalSeconds: 60, lastWrite: { workspaceName: 'rabbitholes', at: Date.now() - 12 * 60_000 }, runtimeLabel: 'Claude', followsGlobal: true }} />);
    expect(screen.queryByText(/Meta agent checks new conversations/)).toBeNull();
    expect(screen.queryByText(/wrote rabbitholes/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Meta agent per workspace' })).toBeNull();
  });
});
