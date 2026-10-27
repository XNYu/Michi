import type { Route } from '@playwright/test';
import type {
  HomeCardsDto,
  HomeConversationItem,
  HomeSection,
  MetaAgentInfo,
  MetaAgentOverview,
  PageBlock,
  PageDto,
  ScheduledJobsListResponse,
  SpacesFirstRunStatus,
  SpacesHomeDto,
  SpacesHomeSectionsDto,
  WorkspaceHomeDto,
  WorkspaceHomeSummaryDto,
} from 'michi-shared';

/**
 * Browser-only answers for the Spaces Home, the Meta agent, Home cards and
 * Scheduled jobs. installMockApi uses an empty instance by default; a spec
 * that needs data seeds its own instance and passes `handle` as `custom`.
 * No backend, SQLite or agent runtime is involved.
 */
export interface SpacesHomeMockOptions {
  /** Waiting / Stalled / Done rows on the Spaces Home, with the per-workspace counts and the All threads total. */
  sections?: Partial<Pick<SpacesHomeSectionsDto, 'waiting' | 'stalled' | 'done' | 'byWorkspace' | 'conversationTotal'>>;
  /** Michi conversations All threads lists from Spaces, newest first, each with its section. */
  conversations?: HomeConversationItem[];
  /** Blocks of the Spaces Home page. */
  homeBlocks?: PageBlock[];
  /** Blocks of each workspace's home page, by workspace id as the backend sees it. */
  workspaceHomes?: Record<string, { name: string; blocks: PageBlock[] }>;
}

export interface SpacesHomeMockController {
  handle(route: Route): Promise<boolean>;
  /** Every request this controller answered, as `METHOD /path` (with the query for All threads). */
  readonly requests: string[];
}

const now = 1_800_000_000_000;
const json = (route: Route, value: unknown, status = 200) => route.fulfill({
  status, contentType: 'application/json', body: JSON.stringify(value),
});
const emptySection: HomeSection = { items: [], total: 0 };

function page(id: string, workspaceId: string, title: string, blocks: PageBlock[]): PageDto {
  return {
    id, workspaceId, parentId: null, position: 0, title, color: null, updatedAt: now, updatedBy: 'agent',
    pendingProposals: 0, helperNodeId: null, revision: 1, viewVersion: 1, blocks,
  };
}

export function createSpacesHomeMock(options: SpacesHomeMockOptions = {}): SpacesHomeMockController {
  const requests: string[] = [];
  const runtime = { runtimeId: 'mock', providerId: null, modelId: null, reasoning: null, followsGlobal: true };
  const info: MetaAgentInfo = {
    settings: { runtimeId: null, providerId: null, modelId: null, reasoning: null, writeWorkspaceHomes: null, maintainSpacesHome: null, firstRunDays: null },
    resolved: runtime,
    availability: { available: true, reason: null },
    guard: { maintenance: null, chat: null },
    usageToday: { checks: 0, modelCalls: 0, tokens: null },
  };
  const homes = Object.entries(options.workspaceHomes ?? {});
  const summaries: WorkspaceHomeSummaryDto[] = homes.map(([workspaceId, home]) => ({
    workspaceId, workspaceName: home.name, homePageId: `home-${workspaceId}`, hiddenAt: null, firstRun: null,
    hasContent: home.blocks.length > 0,
  }));
  const overview: MetaAgentOverview = {
    state: 'running', runtime,
    today: { checks: 0, checksTruncated: false, modelCalls: 0, writes: 0, pendingProposals: 0 },
    cursors: summaries.map((home) => ({ workspaceId: home.workspaceId, workspaceName: home.workspaceName, cursor: 0, unread: 0, lastRunAt: null, state: 'synced' })),
    recentRuns: [], managedJobIds: [],
  };
  // Every workspace home is already written: no first run is in progress.
  const firstRun: SpacesFirstRunStatus = {
    requestedAt: now, workspaces: summaries, summary: { state: 'done', summarizedAt: now }, haltedReason: null,
  };
  const sections: SpacesHomeSectionsDto = {
    waiting: options.sections?.waiting ?? emptySection,
    stalled: options.sections?.stalled ?? emptySection,
    done: options.sections?.done ?? emptySection,
    conversations: { available: true },
    byWorkspace: options.sections?.byWorkspace ?? {},
    conversationTotal: options.sections?.conversationTotal ?? (options.conversations ?? []).length,
  };
  const originalWaiting = sections.waiting;
  let lookedAt: number | null = null;
  const spacesHome: SpacesHomeDto = { role: 'spaces-home', page: page('spaces-home', 'spaces-system', 'Home', options.homeBlocks ?? [{ id: 'waiting', rev: 1, type: 'home-section', section: 'waiting' }]), layoutRules: [] };
  const cards: HomeCardsDto = { greeting: null, sets: [], generatedAt: null, inputFingerprint: null };
  const jobs: ScheduledJobsListResponse = { jobs: [], scheduler: { active: true, serviceMode: false, timezone: 'UTC' } };
  const homePages = new Map<string, PageDto>(homes.map(([workspaceId, home]) => [`home-${workspaceId}`, page(`home-${workspaceId}`, workspaceId, home.name, home.blocks)] as const));

  return {
    requests,
    async handle(route) {
      const request = route.request();
      const method = request.method();
      const path = new URL(request.url()).pathname.replace(/^.*\/api/, '');
      const answer = async (value: unknown) => { requests.push(`${method} ${path}`); await json(route, value); return true; };

      if (method === 'GET' && path === '/meta-agent') return answer(info);
      if (method === 'GET' && path === '/meta-agent/overview') return answer(overview);
      if (method === 'GET' && path === '/scheduled-jobs') return answer(jobs);
      if (method === 'GET' && path === '/home/cards') return answer(cards);
      if (path === '/spaces-home/first-run' && (method === 'GET' || method === 'POST')) return answer(firstRun);
      if (method === 'POST' && path === '/spaces-home/reminders') {
        const { itemId, action } = request.postDataJSON();
        sections.waiting = action === 'restore' ? originalWaiting : { items: sections.waiting.items.filter(item => item.id !== itemId), total: sections.waiting.total - 1 };
        const workspaceId = originalWaiting.items.find(item => item.id === itemId)?.workspaceId;
        if (workspaceId && sections.byWorkspace?.[workspaceId]) sections.byWorkspace[workspaceId].waiting = sections.waiting.total;
        return answer({ ok: true });
      }
      if (method === 'GET' && path === '/spaces-home') return answer(spacesHome);
      if (method === 'GET' && path === '/spaces-home/workspaces') return answer({ items: summaries });
      if (method === 'GET' && path === '/spaces-home/sections') return answer(sections);
      if (method === 'GET' && path === '/spaces-home/conversations') {
        const search = new URL(request.url()).search;
        const state = new URLSearchParams(search).get('state');
        const items = (options.conversations ?? []).filter((item) => !state || item.state === state);
        requests.push(`${method} ${path}${search}`);
        await json(route, { items, total: items.length });
        return true;
      }
      if (path === '/spaces-home/look' && (method === 'GET' || method === 'POST')) {
        if (method === 'POST') lookedAt = now;
        return answer({ lookedAt });
      }
      if (method === 'GET' && (path === '/spaces-home/activity' || path === '/spaces-home/progress-cards')) return answer({ items: [] });
      const workspaceHome = path.match(/^\/workspaces\/([^/]+)\/home$/);
      if (method === 'GET' && workspaceHome) {
        const workspaceId = decodeURIComponent(workspaceHome[1]);
        const home = options.workspaceHomes?.[workspaceId];
        const dto: WorkspaceHomeDto = {
          role: 'workspace-home', workspaceId,
          page: homePages.get(`home-${workspaceId}`) ?? page(`home-${workspaceId}`, workspaceId, home?.name ?? 'Workspace', []),
          layoutRules: [], hiddenAt: null, firstRun: null,
        };
        return answer(dto);
      }
      if (method === 'GET' && /^\/workspaces\/[^/]+\/databases$/.test(path)) return answer({ items: [] });
      const pagePath = path.match(/^\/pages\/([^/]+)(\/.*)?$/);
      if (method === 'POST' && path === '/pages/spaces-home/edits') {
        const { ops } = request.postDataJSON();
        for (const op of ops) {
          if (op.op === 'move') {
            const index = spacesHome.page.blocks.findIndex(block => block.id === op.id);
            const [block] = spacesHome.page.blocks.splice(index, 1);
            const after = op.after === null ? -1 : spacesHome.page.blocks.findIndex(block => block.id === op.after);
            spacesHome.page.blocks.splice(after + 1, 0, { ...block, rev: block.rev + 1 });
          }
          if (op.op === 'delete') spacesHome.page.blocks = spacesHome.page.blocks.filter(block => block.id !== op.id);
        }
        spacesHome.page.revision += 1;
        return answer({ page: spacesHome.page, changes: { resource: { kind: 'page', id: spacesHome.page.id }, revision: spacesHome.page.revision, applied: [], proposed: [], conflicts: [] } });
      }
      if (method === 'GET' && pagePath && (pagePath[1] === 'spaces-home' || homePages.has(pagePath[1]))) {
        const id = decodeURIComponent(pagePath[1]);
        const rest = pagePath[2] ?? '';
        if (rest === '') return answer({ page: id === 'spaces-home' ? spacesHome.page : homePages.get(id) });
        if (rest === '/changes') return answer({ changes: [], nextAfter: 0, nextBefore: null, hasMore: false });
        if (rest === '/layout-preferences') return answer({ text: '', revision: 0, updatedAt: null, updatedBy: null });
        if (rest === '/activity-seen') return answer({ lastSeenChangeSeq: 0 });
        if (rest === '/progress-cards' || rest === '/layout-rules') return answer({ items: [] });
      }
      if (method === 'GET' && /^\/pages\/[^/]+\/progress-cards$/.test(path)) return answer({ items: [] });
      return false;
    },
  };
}
