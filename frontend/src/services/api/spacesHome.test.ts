import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addLayoutRule,
  fetchLayoutPreferences,
  saveLayoutPreferences,
  fetchHomeConversations,
  fetchThreadStates,
  fetchHomeSections,
  markSpacesHomeLooked,
  fetchProgressCards,
  fetchSpaceActivity,
  fetchSpacesHome,
  fetchWorkspaceHome,
  fetchWorkspaceHomes,
  fetchSpacesFirstRun,
  retrySpacesFirstRun,
  setWorkspaceHomeHidden,
  startSpacesFirstRun,
} from './spacesHome';

afterEach(() => { vi.unstubAllGlobals(); });

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const page = (id: string, workspaceId: string) => ({
  id, workspaceId, parentId: null, position: 0, title: 'Home', color: null, updatedAt: 1, updatedBy: 'agent',
  pendingProposals: 0, helperNodeId: null, revision: 3, viewVersion: 3,
  blocks: [{ id: 'block-1', rev: 1, type: 'markdown', text: 'Summary', sources: [{ nodeId: 'node-1', turnId: 't', assistantId: 'a' }] }],
});

describe('Spaces Home API', () => {
  it('keeps preference revisions exact and maps only the page id for remote reads and writes', async () => {
    const document = { text: 'Put risks first', revision: 7, updatedBy: 'user', updatedAt: 99 };
    const fetchMock = vi.fn().mockImplementation(async () => ok(document));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchLayoutPreferences('remote:host:page-1', 'host')).toEqual(document);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/pages\/page-1\/layout-preferences$/);
    await saveLayoutPreferences('remote:host:page-1', { text: 'New preferences', expectedRevision: 7 }, 'host');
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/pages\/page-1\/layout-preferences$/);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ text: 'New preferences', expectedRevision: 7 });
  });
  it('maps a remote Spaces Home page and keeps block ids opaque', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ role: 'spaces-home', page: page('home-1', 'spaces-ws'), layoutRules: [
      { id: 'rule-1', text: 'Only 3 days', sourceMessage: { nodeId: 'node-2', turnId: 't', messageId: 'm' }, createdBy: 'user', createdAt: 1 },
    ] }));
    vi.stubGlobal('fetch', fetchMock);

    const home = await fetchSpacesHome('host');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/spaces-home');
    expect(home.page.id).toBe('remote:host:home-1');
    expect(home.page.workspaceId).toBe('remote:host:spaces-ws');
    expect(home.page.blocks[0].id).toBe('block-1');
    expect(home.page.blocks[0].sources?.[0].nodeId).toBe('remote:host:node-1');
    expect(home.layoutRules[0].sourceMessage?.nodeId).toBe('remote:host:node-2');
  });

  it('maps section targets for Michi chats and page proposals, and the per-workspace counts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({
      waiting: { total: 9, items: [
        { id: 'change:c1', kind: 'proposal', workspaceId: 'ws-1', workspaceName: 'rabbitholes', title: 'Release', at: 5, summary: 'Rewrite', agentClaim: false,
          target: { kind: 'page', pageId: 'page-1', blockId: 'block-9', changeId: 'c1' } },
        { id: 'conversation:node-1', kind: 'conversation', workspaceId: 'ws-2', workspaceName: 'agent-desk', title: 'Crew', at: 4, summary: 'Asked: Pick a path?', agentClaim: false,
          target: { kind: 'conversation', nodeId: 'node-1', workspaceId: 'ws-2', messageId: 'm' } },
        { id: 'thread:old', kind: 'conversation', workspaceId: null, workspaceName: 'x', title: 'From an older backend', at: 3, summary: '', agentClaim: false,
          target: { kind: 'thread', michiThreadId: 'd1', nodeId: null, workspaceId: null, sessionId: 's', messageId: 'm' } },
      ] },
      stalled: { total: 0, items: [] },
      done: { total: 0, items: [] },
      conversations: { available: true },
      byWorkspace: { 'ws-2': { waiting: 1, stalled: 3 } },
      conversationTotal: 42,
      doneSince: 77,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const sections = await fetchHomeSections('host');

    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/spaces-home\/sections$/);
    expect(sections.waiting.total).toBe(9);
    expect(sections.waiting.items).toHaveLength(2);
    const [proposal, chat] = sections.waiting.items;
    expect(proposal.workspaceId).toBe('remote:host:ws-1');
    expect(proposal.target).toEqual({ kind: 'page', pageId: 'remote:host:page-1', blockId: 'block-9', changeId: 'c1' });
    expect(chat.workspaceId).toBe('remote:host:ws-2');
    expect(chat.target).toEqual({ kind: 'conversation', nodeId: 'remote:host:node-1', workspaceId: 'remote:host:ws-2', messageId: 'm' });
    expect(sections.byWorkspace).toEqual({ 'remote:host:ws-2': { waiting: 1, stalled: 3 } });
    expect([sections.conversationTotal, sections.doneSince]).toEqual([42, 77]);
  });

  it('treats a missing section as empty rather than failing the whole Home', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ waiting: { total: 1, items: [] } })));
    const sections = await fetchHomeSections('local');
    expect(sections.stalled).toEqual({ items: [], total: 0 });
    expect(sections.conversations).toEqual({ available: true });
    expect(sections.byWorkspace).toEqual({});
    expect('conversationTotal' in sections).toBe(false);
  });

  it('lists All threads for one state, and records the Spaces Home look', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ total: 3, items: [{ id: 'conversation:n1', kind: 'conversation', workspaceId: 'ws', workspaceName: 'w', title: 't', at: 1,
        summary: '', agentClaim: false, state: 'stalled', target: { kind: 'conversation', nodeId: 'n1', workspaceId: 'ws', messageId: null } }] }))
      .mockResolvedValueOnce(ok({ total: 0, items: [] }))
      .mockResolvedValueOnce(ok({ lookedAt: 9 }));
    vi.stubGlobal('fetch', fetchMock);
    const list = await fetchHomeConversations('host', { state: 'stalled', limit: 5 });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/spaces-home\/conversations\?state=stalled&limit=5$/);
    expect(list.total).toBe(3);
    expect(list.items[0]).toMatchObject({ state: 'stalled', target: { kind: 'conversation', nodeId: 'remote:host:n1', workspaceId: 'remote:host:ws' } });
    await fetchHomeConversations('local');
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/spaces-home\/conversations$/);
    expect(await markSpacesHomeLooked('local')).toEqual({ lookedAt: 9 });
    expect(String(fetchMock.mock.calls[2][0])).toMatch(/\/spaces-home\/look$/);
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe('POST');
  });

  it('keeps the layout rules that shaped a section', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ stalled: { total: 161, items: [], ruleIds: ['rule-1'] } })));
    const sections = await fetchHomeSections('local');
    expect(sections.stalled.ruleIds).toEqual(['rule-1']);
    expect('ruleIds' in sections.done).toBe(false);
  });

  it('maps activity, progress cards and the workspace list', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ items: [
        { kind: 'page-change', batchId: 'b1', pageId: 'p1', pageTitle: 'Release', workspaceId: 'ws-1', workspaceName: 'rabbitholes', at: 1, count: 2, pending: 1, ops: ['update'], summary: 'Risk', actor: 'agent', sourceKind: 'chat', sourceNodeId: 'n1' },
        { kind: 'conversation', threadNodeId: 'n2', title: 'Perf', workspaceId: 'ws-1', workspaceName: 'rabbitholes', startedFromPageId: 'p1', startedFromPageTitle: 'Release', at: 2 },
      ] }))
      .mockResolvedValueOnce(ok({ items: [
        { threadNodeId: 'n2', startedFromPageId: 'p1', workspaceId: 'ws-1', workspaceName: 'rabbitholes', treeId: null, title: 'Perf', runtimeId: 'claude', status: 'done', summary: 'Done', createdAt: 1, seenAt: null, dismissedAt: null, expiresAt: null },
      ] }))
      .mockResolvedValueOnce(ok({ items: [
        { workspaceId: 'ws-1', workspaceName: 'rabbitholes', homePageId: null, hiddenAt: null, firstRun: { workspaceId: 'ws-1', startedAt: 1, startSeq: 4, readCount: 2, total: 3, state: 'reading', error: null, updatedAt: 1 } },
      ] }));
    vi.stubGlobal('fetch', fetchMock);

    const activity = await fetchSpaceActivity('host', { limit: 5 });
    const cards = await fetchProgressCards('host');
    const workspaces = await fetchWorkspaceHomes('host');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/spaces-home/activity?limit=5');
    expect(activity[0]).toMatchObject({ pageId: 'remote:host:p1', workspaceId: 'remote:host:ws-1', sourceNodeId: 'remote:host:n1', batchId: 'b1' });
    expect(activity[1]).toMatchObject({ threadNodeId: 'remote:host:n2', startedFromPageId: 'remote:host:p1' });
    expect(cards[0]).toMatchObject({ threadNodeId: 'remote:host:n2', treeId: null, workspaceId: 'remote:host:ws-1' });
    expect(workspaces[0]).toMatchObject({ workspaceId: 'remote:host:ws-1', homePageId: null });
    expect(workspaces[0].firstRun?.workspaceId).toBe('remote:host:ws-1');
  });

  it('sends server ids for workspace home reads, hiding and layout rules', async () => {
    const home = { role: 'workspace-home', workspaceId: 'ws-1', page: page('wh-1', 'ws-1'), layoutRules: [], hiddenAt: null, firstRun: null };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(home))
      .mockResolvedValueOnce(ok({ ...home, hiddenAt: 9 }))
      .mockResolvedValueOnce(ok({ id: 'rule-1', text: 'Short', sourceMessage: { nodeId: 'n1', turnId: 't', messageId: 'm' }, createdBy: 'user', createdAt: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    const read = await fetchWorkspaceHome('remote:host:ws-1', 'host');
    const hidden = await setWorkspaceHomeHidden('remote:host:ws-1', true, 'host');
    const rule = await addLayoutRule('remote:host:wh-1', { text: 'Short', sourceMessage: { nodeId: 'remote:host:n1', turnId: 't', messageId: 'm' } }, 'host');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/workspaces/ws-1/home');
    expect(read.workspaceId).toBe('remote:host:ws-1');
    expect(read.page.id).toBe('remote:host:wh-1');
    const [, patch] = fetchMock.mock.calls[1];
    expect(patch.method).toBe('PATCH');
    expect(JSON.parse(patch.body as string)).toEqual({ hidden: true });
    expect(hidden.hiddenAt).toBe(9);
    expect(String(fetchMock.mock.calls[2][0])).toContain('/pages/wh-1/layout-rules');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body as string)).toEqual({ text: 'Short', sourceMessage: { nodeId: 'n1', turnId: 't', messageId: 'm' } });
    expect(rule.sourceMessage?.nodeId).toBe('remote:host:n1');
  });

  it('reports the backend error code and message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'not_found', message: 'No such workspace' } }), { status: 404 })));
    await expect(fetchWorkspaceHome('ws-x', 'local')).rejects.toMatchObject({ status: 404, code: 'not_found', message: 'No such workspace' });
  });

  it('starts, reads and retries the first run with server ids out and renderer ids back', async () => {
    const status = {
      requestedAt: 5,
      workspaces: [{ workspaceId: 'ws-1', workspaceName: 'rabbitholes', homePageId: 'wh-1', hiddenAt: null,
        firstRun: { workspaceId: 'ws-1', startedAt: 1, startSeq: 4, readCount: 2, total: 9, state: 'reading', error: null, updatedAt: 3 } }],
      summary: { state: 'waiting', summarizedAt: null },
      haltedReason: null,
    };
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(ok(status)));
    vi.stubGlobal('fetch', fetchMock);

    const started = await startSpacesFirstRun('host');
    await fetchSpacesFirstRun('host');
    await retrySpacesFirstRun('host', 'remote:host:ws-1');
    await retrySpacesFirstRun('host');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/spaces-home/first-run');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[1][1].method).toBeUndefined();
    expect(String(fetchMock.mock.calls[2][0])).toContain('/spaces-home/first-run/retry');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body as string)).toEqual({ workspaceId: 'ws-1' });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body as string)).toEqual({});
    expect(started.workspaces[0]).toMatchObject({ workspaceId: 'remote:host:ws-1', homePageId: 'remote:host:wh-1' });
    expect(started.workspaces[0].firstRun?.workspaceId).toBe('remote:host:ws-1');
    expect(started.summary.state).toBe('waiting');
  });

  it('posts the server ids of the named conversations and maps the answers back', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ items: [{ nodeId: 'n1', workspaceId: 'ws-1', title: 'Schema', state: 'waiting', summary: 'Asked: x', at: 5, messageId: 'm1' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const items = await fetchThreadStates('host', { nodeIds: ['n1', 'remote:host:n2'] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/spaces-home/thread-states');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(init.body as string)).toEqual({ nodeIds: ['n1', 'n2'] });
    expect(items[0]).toMatchObject({ nodeId: 'remote:host:n1', workspaceId: 'remote:host:ws-1', state: 'waiting' });
    expect(await fetchThreadStates('host', { nodeIds: [] })).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lists one workspace's conversations for linking", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ items: [], total: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchHomeConversations('host', { workspaceId: 'remote:host:ws-1', limit: 500 });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('workspaceId=ws-1');
    expect(url).toContain('limit=500');
  });
});
