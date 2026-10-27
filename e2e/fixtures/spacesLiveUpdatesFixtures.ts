import type { Route } from '@playwright/test';
import type { PageBlock, PageDto } from 'michi-shared';
import { createSpacesHomeMock } from './spacesHomeFixtures';

export const LIVE_WORKSPACE_ID = 'ws-live-release';
export const LIVE_HOME_ID = `home-${LIVE_WORKSPACE_ID}`;
export const LIVE_PAGE_ID = 'live-release-plan';
export const LIVE_ASSISTANT_ID = 'node-live-assistant';

const now = 1_800_000_000_000;
export const liveWorkspace = {
  workspace: { id: LIVE_WORKSPACE_ID, name: 'Release work', created_at: 1 },
  trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [],
};
export const liveAssistant = {
  workspace: { id: 'ws-live-assistant', name: 'Assistant', created_at: 1, settings: JSON.stringify({ system: 'assistant' }), active_tree_id: 'tree-live-assistant' },
  trees: [{ id: 'tree-live-assistant', workspace_id: 'ws-live-assistant', root_node_id: LIVE_ASSISTANT_ID, name: 'Assistant', created_at: 1 }],
  nodes: [{ id: LIVE_ASSISTANT_ID, workspace_id: 'ws-live-assistant', tree_id: 'tree-live-assistant', kind: 'chat', title: 'Assistant', runtime_id: 'mock', status: 'idle', created_at: 1 }],
  edges: [], contexts: [], artifacts: [], messages: [],
};

function blocks(): PageBlock[] {
  return [
    { id: 'live-status', rev: 1, type: 'markdown', text: 'Release status: draft.' },
    { id: 'draft-note', rev: 1, type: 'markdown', text: 'Private review note' },
    { id: 'timeline', rev: 1, type: 'timeline', title: 'Release history', items: Array.from({ length: 10 }, (_, index) => ({ title: `Checkpoint ${index + 1}`, at: now - (10 - index) * 86_400_000, detail: 'Reviewed and recorded.' })) },
    ...Array.from({ length: 6 }, (_, index): PageBlock => ({ id: `background-${index}`, rev: 1, type: 'markdown', text: `### Background ${index + 1}\n\nKeep the review notes in place while Michi updates the release.\n\nThis context is unchanged during the conversation.` })),
  ];
}

function document(id: string, title: string): PageDto {
  return { id, title, workspaceId: LIVE_WORKSPACE_ID, parentId: null, position: 0, color: null, updatedAt: now, updatedBy: 'agent', pendingProposals: 0, helperNodeId: null, revision: 1, viewVersion: 1, blocks: blocks() };
}

/** A mutable API snapshot per browser test; tool receipts and reads are controlled independently. */
export function createSpacesLiveUpdatesMock() {
  const home = document(LIVE_HOME_ID, 'Release work');
  const plan = document(LIVE_PAGE_ID, 'Live release');
  const pages = new Map([[home.id, home], [plan.id, plan]]);
  const spaces = createSpacesHomeMock({
    homeBlocks: [{ id: 'global-lead', rev: 1, type: 'markdown', text: 'Release work is ready to review.' }],
    workspaceHomes: { [LIVE_WORKSPACE_ID]: { name: 'Release work', blocks: home.blocks } },
  });
  const reads: Array<{ pageId: string; version: number; since: string | null }> = [];
  const queuedReads = new Map<string, PageDto[]>();
  let heldRead: { pageId: string; release: () => Promise<void> } | null = null;
  let holdPageId: string | null = null;
  const answer = async (route: Route, value: unknown) => { await route.fulfill({ json: value }); return true; };
  return {
    pages, reads,
    queueRead(pageId: string, value: PageDto) { queuedReads.set(pageId, [...(queuedReads.get(pageId) ?? []), structuredClone(value)]); },
    holdNextRead(pageId: string) { holdPageId = pageId; },
    hasHeldRead() { return heldRead !== null; },
    async releaseRead() { const held = heldRead; heldRead = null; if (!held) throw new Error('No held page read'); await held.release(); },
    commit(pageId: string, text: string): PageDto {
      const previous = pages.get(pageId)!;
      const next = { ...previous, revision: previous.revision + 1, viewVersion: previous.viewVersion + 1, updatedAt: previous.updatedAt + 1000,
        blocks: previous.blocks.map(block => block.id === 'live-status' ? { ...block, type: 'markdown' as const, text, rev: block.rev + 1 } : block) };
      pages.set(pageId, next);
      return next;
    },
    async handle(route: Route): Promise<boolean> {
      const url = new URL(route.request().url());
      const path = url.pathname.replace(/^.*\/api/, '');
      const method = route.request().method();
      if (method === 'GET' && path === '/assistant') return answer(route, {
        nodeId: LIVE_ASSISTANT_ID, workspaceId: 'ws-live-assistant', treeId: 'tree-live-assistant',
        settings: { runtimeId: 'mock', modelId: null, reasoning: null }, supportedRuntimes: ['mock'],
      });
      if (method === 'GET' && path === '/workspaces/ws-live-assistant') return answer(route, liveAssistant);
      if (method === 'GET' && path === '/workspaces/ws-live-assistant/trees/tree-live-assistant/messages') return answer(route, { messages: [] });
      if (method === 'GET' && path === `/workspaces/${LIVE_WORKSPACE_ID}/home`) return answer(route, {
        role: 'workspace-home', workspaceId: LIVE_WORKSPACE_ID, page: pages.get(LIVE_HOME_ID), layoutRules: [], hiddenAt: null, firstRun: null,
      });
      const pageMatch = path.match(/^\/pages\/([^/]+)$/);
      if (method === 'GET' && pageMatch && pages.has(pageMatch[1])) {
        const pageId = pageMatch[1];
        const pending = queuedReads.get(pageId);
        const value = pending?.shift() ?? pages.get(pageId)!;
        reads.push({ pageId, version: value.viewVersion, since: url.searchParams.get('since') });
        if (holdPageId === pageId) {
          holdPageId = null;
          heldRead = { pageId, release: () => route.fulfill({ json: { page: value } }) };
          return true;
        }
        return answer(route, { page: value });
      }
      if (method === 'GET' && /^\/pages\/[^/]+\/changes$/.test(path)) return answer(route, { changes: [], nextAfter: 0, nextBefore: null, hasMore: false });
      if (method === 'GET' && /^\/pages\/[^/]+\/activity-seen$/.test(path)) return answer(route, { lastSeenChangeSeq: 0 });
      if (method === 'GET' && /^\/pages\/[^/]+\/(layout-rules|progress-cards)$/.test(path)) return answer(route, { items: [] });
      if (method === 'GET' && path === '/spaces') return answer(route, { items: [{
        ...pages.get(LIVE_PAGE_ID), blocks: undefined, workspaceName: 'Release work', childTitles: [], pageCount: 1, databaseCount: 0, contributorNodeIds: [], hasContent: true,
      }], nextCursor: null });
      if (method === 'GET' && path === `/workspaces/${LIVE_WORKSPACE_ID}/pages`) return answer(route, { items: [pages.get(LIVE_PAGE_ID)], nextCursor: null });
      if (method === 'GET' && /\/workspaces\/[^/]+\/components$/.test(path)) return answer(route, { revision: 0, items: [] });
      if (method === 'GET' && /\/workspaces\/[^/]+\/maintenance$/.test(path)) return answer(route, { config: null, job: null, status: null, backlog: { plans: [], pendingSources: 0, attentionSources: 0 }, excludedSpaceIds: [], catchUpSuggestions: [] });
      return spaces.handle(route);
    },
  };
}

export function pageWriteOutput(page: PageDto, commitStatus: 'committed' | 'rejected' = 'committed') {
  return JSON.stringify({ michiPageWrite: {
    kind: 'michiPageWrite', resourceKind: 'page', resourceId: page.id, workspaceId: page.workspaceId, title: page.title,
    revision: page.revision, viewVersion: page.viewVersion, commitStatus,
    created: false, appliedCount: commitStatus === 'committed' ? 1 : 0, proposedCount: 0,
    affectedTargetIds: commitStatus === 'committed' ? ['live-status'] : [], batchId: `batch-${page.viewVersion}`,
  } });
}
