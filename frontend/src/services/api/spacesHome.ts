import type {
  HomeReminderAction,
  HomeActionTarget,
  HomeConversationItem,
  HomeConversationsDto,
  HomeSection,
  HomeSectionItem,
  HomeSectionKey,
  HomeWorkspaceCounts,
  LayoutRuleSectionLimit,
  LayoutRuleSourceMessage,
  PageLayoutRule,
  PageLayoutPreferences,
  LayoutPreferencesWriteRequest,
  ProgressCardDto,
  SpaceActivityItem,
  SpacesFirstRunStatus,
  SpacesHomeDto,
  SpacesHomeLookDto,
  SpacesHomeSectionsDto,
  ThreadCardItem,
  ThreadCardsDto,
  WorkspaceHomeDto,
  WorkspaceHomeSummaryDto,
  FirstRunProgressDto,
} from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';
import { backendEntityId, serverEntityId } from '../../config/backendIdentity';
import { mapPageIdentity } from '../../state/pages/identity';
import { PageApiError, pagesFetch, readPagesJson } from './pages';

// Like the Pages API, these responses carry opaque block and change ids, so
// each DTO maps only its entity references instead of backendFetch's generic
// transform.

const toRenderer = (connectionId: string, id: string) => backendEntityId(connectionId, id);
const toRendererOrNull = (connectionId: string, id: string | null) => (id === null ? null : toRenderer(connectionId, id));
const pathId = (id: string, connectionId: string) => encodeURIComponent(serverEntityId(id, connectionId));

async function request<T>(url: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await pagesFetch(url, {
    ...(options.method ? { method: options.method } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    const payload: unknown = await readPagesJson(response).catch(() => null);
    const envelope = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined;
    const error = envelope && typeof envelope === 'object' ? envelope as { code?: unknown; message?: unknown } : {};
    throw new PageApiError(
      response.status,
      typeof error.code === 'string' ? error.code : 'spaces_home_request_failed',
      typeof error.message === 'string' ? error.message : `Pages Home request failed (${response.status})`,
    );
  }
  return await readPagesJson(response) as T;
}

const base = (connectionId: string) => backendApiBase(connectionId);

function mapSourceMessage(message: LayoutRuleSourceMessage | null, connectionId: string, direction: 'renderer' | 'server'): LayoutRuleSourceMessage | null {
  if (!message) return null;
  return { ...message, nodeId: direction === 'renderer' ? toRenderer(connectionId, message.nodeId) : serverEntityId(message.nodeId, connectionId) };
}

function mapRule(rule: PageLayoutRule, connectionId: string): PageLayoutRule {
  return { ...rule, sourceMessage: mapSourceMessage(rule.sourceMessage, connectionId, 'renderer') };
}

function mapFirstRun(run: FirstRunProgressDto | null, connectionId: string): FirstRunProgressDto | null {
  return run ? { ...run, workspaceId: toRenderer(connectionId, run.workspaceId) } : null;
}

function mapTarget(target: HomeActionTarget, connectionId: string): HomeActionTarget {
  if (target.kind === 'page') return { ...target, pageId: toRenderer(connectionId, target.pageId) };
  return { ...target, nodeId: toRenderer(connectionId, target.nodeId), workspaceId: toRenderer(connectionId, target.workspaceId) };
}

function mapSectionItem<T extends HomeSectionItem>(item: T, connectionId: string): T {
  return { ...item, workspaceId: toRendererOrNull(connectionId, item.workspaceId), target: mapTarget(item.target, connectionId) };
}

/** Only native page and conversation targets can be opened from Home. */
const knownTarget = (item: HomeSectionItem): boolean => item.target.kind === 'page' || item.target.kind === 'conversation';

function mapSection(section: HomeSection | undefined, connectionId: string): HomeSection {
  return { items: (section?.items ?? []).filter(knownTarget).map((item) => mapSectionItem(item, connectionId)), total: section?.total ?? 0,
    ...(Array.isArray(section?.ruleIds) ? { ruleIds: section.ruleIds } : {}) };
}

function mapActivity(item: SpaceActivityItem, connectionId: string): SpaceActivityItem {
  if (item.kind === 'page-change') {
    return {
      ...item,
      pageId: toRenderer(connectionId, item.pageId),
      workspaceId: toRenderer(connectionId, item.workspaceId),
      sourceNodeId: toRendererOrNull(connectionId, item.sourceNodeId),
    };
  }
  return {
    ...item,
    threadNodeId: toRenderer(connectionId, item.threadNodeId),
    workspaceId: toRenderer(connectionId, item.workspaceId),
    startedFromPageId: toRenderer(connectionId, item.startedFromPageId),
  };
}

function mapProgressCard(card: ProgressCardDto, connectionId: string): ProgressCardDto {
  return {
    ...card,
    threadNodeId: toRenderer(connectionId, card.threadNodeId),
    startedFromPageId: toRenderer(connectionId, card.startedFromPageId),
    workspaceId: toRenderer(connectionId, card.workspaceId),
    treeId: toRendererOrNull(connectionId, card.treeId),
  };
}

function mapWorkspaceHome(home: WorkspaceHomeDto, connectionId: string): WorkspaceHomeDto {
  return {
    ...home,
    workspaceId: toRenderer(connectionId, home.workspaceId),
    page: mapPageIdentity(home.page, connectionId, 'renderer'),
    layoutRules: (home.layoutRules ?? []).map((rule) => mapRule(rule, connectionId)),
    firstRun: mapFirstRun(home.firstRun, connectionId),
  };
}

export async function fetchSpacesHome(connectionId: string, signal?: AbortSignal): Promise<SpacesHomeDto> {
  const home = await request<SpacesHomeDto>(`${base(connectionId)}/spaces-home`, { signal });
  return { ...home, page: mapPageIdentity(home.page, connectionId, 'renderer'), layoutRules: (home.layoutRules ?? []).map((rule) => mapRule(rule, connectionId)) };
}

export async function fetchWorkspaceHomes(connectionId: string, signal?: AbortSignal): Promise<WorkspaceHomeSummaryDto[]> {
  const answer = await request<{ items?: WorkspaceHomeSummaryDto[] }>(`${base(connectionId)}/spaces-home/workspaces`, { signal });
  return (answer.items ?? []).map((item) => ({
    ...item,
    workspaceId: toRenderer(connectionId, item.workspaceId),
    homePageId: toRendererOrNull(connectionId, item.homePageId),
    firstRun: mapFirstRun(item.firstRun, connectionId),
  }));
}

function mapWorkspaceCounts(counts: Record<string, HomeWorkspaceCounts> | undefined, connectionId: string): Record<string, HomeWorkspaceCounts> {
  return Object.fromEntries(Object.entries(counts ?? {}).map(([workspaceId, value]) => [toRenderer(connectionId, workspaceId), value]));
}

export async function fetchHomeSections(connectionId: string, options: { signal?: AbortSignal } = {}): Promise<SpacesHomeSectionsDto> {
  const answer = await request<SpacesHomeSectionsDto>(`${base(connectionId)}/spaces-home/sections`, { signal: options.signal });
  return {
    waiting: mapSection(answer.waiting, connectionId),
    stalled: mapSection(answer.stalled, connectionId),
    done: mapSection(answer.done, connectionId),
    conversations: { available: true },
    byWorkspace: mapWorkspaceCounts(answer.byWorkspace, connectionId),
    ...(typeof answer.conversationTotal === 'number' ? { conversationTotal: answer.conversationTotal } : {}),
    ...(typeof answer.doneSince === 'number' ? { doneSince: answer.doneSince } : {}),
  };
}

/** All threads: every Michi conversation of the connection, or those in one Home section or workspace. */
export async function fetchHomeConversations(connectionId: string, options: { state?: HomeSectionKey | null; limit?: number; workspaceId?: string; signal?: AbortSignal } = {}): Promise<HomeConversationsDto> {
  const params = new URLSearchParams();
  if (options.state) params.set('state', options.state);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.workspaceId) params.set('workspaceId', serverEntityId(options.workspaceId, connectionId));
  const query = params.toString() ? `?${params.toString()}` : '';
  const answer = await request<HomeConversationsDto>(`${base(connectionId)}/spaces-home/conversations${query}`, { signal: options.signal });
  return {
    items: (answer.items ?? []).filter(knownTarget).map((item: HomeConversationItem) => mapSectionItem(item, connectionId)),
    total: answer.total ?? 0,
  };
}

/** The conversations a page's thread cards name, as each stands now; ones no longer in the page's workspace are not among them. */
export async function fetchThreadCards(connectionId: string, options: { workspaceId: string; nodeIds: readonly string[]; signal?: AbortSignal }): Promise<ThreadCardItem[]> {
  if (!options.nodeIds.length) return [];
  const params = new URLSearchParams({
    workspaceId: serverEntityId(options.workspaceId, connectionId),
    nodeIds: options.nodeIds.map((id) => serverEntityId(id, connectionId)).join(','),
  });
  const answer = await request<ThreadCardsDto>(`${base(connectionId)}/spaces-home/thread-cards?${params.toString()}`, { signal: options.signal });
  return (answer.items ?? []).map((card) => ({
    ...card,
    nodeId: backendEntityId(connectionId, card.nodeId),
    workspaceId: backendEntityId(connectionId, card.workspaceId),
  }));
}

/** Where each named conversation stands now, wherever it is; ones deleted or not the person's are not among them. */
export async function fetchThreadStates(connectionId: string, options: { nodeIds: readonly string[]; signal?: AbortSignal }): Promise<ThreadCardItem[]> {
  if (!options.nodeIds.length) return [];
  const answer = await request<ThreadCardsDto>(`${base(connectionId)}/spaces-home/thread-states`, {
    method: 'POST',
    body: { nodeIds: options.nodeIds.map((id) => serverEntityId(id, connectionId)) },
    signal: options.signal,
  });
  return (answer.items ?? []).map((card) => ({
    ...card,
    nodeId: backendEntityId(connectionId, card.nodeId),
    workspaceId: backendEntityId(connectionId, card.workspaceId),
  }));
}

/** Records that the user just left the Spaces Home: Just done starts again from now. */
export async function markSpacesHomeLooked(connectionId: string): Promise<SpacesHomeLookDto> {
  return request<SpacesHomeLookDto>(`${base(connectionId)}/spaces-home/look`, { method: 'POST' });
}

export async function fetchSpaceActivity(connectionId: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<SpaceActivityItem[]> {
  const query = options.limit === undefined ? '' : `?limit=${encodeURIComponent(String(options.limit))}`;
  const answer = await request<{ items?: SpaceActivityItem[] }>(`${base(connectionId)}/spaces-home/activity${query}`, { signal: options.signal });
  return (answer.items ?? []).map((item) => mapActivity(item, connectionId));
}

export async function fetchProgressCards(connectionId: string, signal?: AbortSignal): Promise<ProgressCardDto[]> {
  const answer = await request<{ items?: ProgressCardDto[] }>(`${base(connectionId)}/spaces-home/progress-cards`, { signal });
  return (answer.items ?? []).map((card) => mapProgressCard(card, connectionId));
}

export async function fetchPageProgressCards(pageId: string, connectionId: string, signal?: AbortSignal): Promise<ProgressCardDto[]> {
  const answer = await request<{ items?: ProgressCardDto[] }>(`${base(connectionId)}/pages/${pathId(pageId, connectionId)}/progress-cards`, { signal });
  return (answer.items ?? []).map((card) => mapProgressCard(card, connectionId));
}

export async function createProgressCard(threadNodeId: string, startedFromPageId: string, connectionId: string): Promise<ProgressCardDto> {
  const card = await request<ProgressCardDto>(`${base(connectionId)}/progress-cards`, {
    method: 'POST',
    body: { threadNodeId: serverEntityId(threadNodeId, connectionId), startedFromPageId: serverEntityId(startedFromPageId, connectionId) },
  });
  return mapProgressCard(card, connectionId);
}

export async function markProgressCardSeen(threadNodeId: string, connectionId: string): Promise<ProgressCardDto> {
  const card = await request<ProgressCardDto>(`${base(connectionId)}/progress-cards/${pathId(threadNodeId, connectionId)}/seen`, { method: 'POST' });
  return mapProgressCard(card, connectionId);
}

export async function dismissProgressCard(threadNodeId: string, connectionId: string): Promise<ProgressCardDto> {
  const card = await request<ProgressCardDto>(`${base(connectionId)}/progress-cards/${pathId(threadNodeId, connectionId)}/dismiss`, { method: 'POST' });
  return mapProgressCard(card, connectionId);
}

export async function fetchWorkspaceHome(workspaceId: string, connectionId: string, signal?: AbortSignal): Promise<WorkspaceHomeDto> {
  const home = await request<WorkspaceHomeDto>(`${base(connectionId)}/workspaces/${pathId(workspaceId, connectionId)}/home`, { signal });
  return mapWorkspaceHome(home, connectionId);
}

export async function setWorkspaceHomeHidden(workspaceId: string, hidden: boolean, connectionId: string): Promise<WorkspaceHomeDto> {
  const home = await request<WorkspaceHomeDto>(`${base(connectionId)}/workspaces/${pathId(workspaceId, connectionId)}/home`, { method: 'PATCH', body: { hidden } });
  return mapWorkspaceHome(home, connectionId);
}

export async function fetchLayoutPreferences(pageId: string, connectionId: string, signal?: AbortSignal): Promise<PageLayoutPreferences> {
  return request<PageLayoutPreferences>(`${base(connectionId)}/pages/${pathId(pageId, connectionId)}/layout-preferences`, { signal });
}

export async function saveLayoutPreferences(pageId: string, input: LayoutPreferencesWriteRequest, connectionId: string): Promise<PageLayoutPreferences> {
  return request<PageLayoutPreferences>(`${base(connectionId)}/pages/${pathId(pageId, connectionId)}/layout-preferences`, { method: 'PUT', body: input });
}

export async function fetchLayoutRules(pageId: string, connectionId: string, signal?: AbortSignal): Promise<PageLayoutRule[]> {
  const answer = await request<{ items?: PageLayoutRule[] }>(`${base(connectionId)}/pages/${pathId(pageId, connectionId)}/layout-rules`, { signal });
  return (answer.items ?? []).map((rule) => mapRule(rule, connectionId));
}

export async function addLayoutRule(pageId: string, body: { text: string; sourceMessage?: LayoutRuleSourceMessage | null; sectionLimit?: LayoutRuleSectionLimit | null }, connectionId: string): Promise<PageLayoutRule> {
  const rule = await request<PageLayoutRule>(`${base(connectionId)}/pages/${pathId(pageId, connectionId)}/layout-rules`, {
    method: 'POST',
    body: {
      text: body.text,
      ...(body.sourceMessage === undefined ? {} : { sourceMessage: mapSourceMessage(body.sourceMessage, connectionId, 'server') }),
      ...(body.sectionLimit ? { sectionLimit: body.sectionLimit } : {}),
    },
  });
  return mapRule(rule, connectionId);
}

export async function deleteLayoutRule(pageId: string, ruleId: string, connectionId: string): Promise<PageLayoutRule[]> {
  const answer = await request<{ items?: PageLayoutRule[] }>(
    `${base(connectionId)}/pages/${pathId(pageId, connectionId)}/layout-rules/${encodeURIComponent(ruleId)}`,
    { method: 'DELETE' },
  );
  return (answer.items ?? []).map((rule) => mapRule(rule, connectionId));
}

export type { SpacesFirstRunStatus, SpacesHomeSummaryState } from 'michi-shared';

function mapFirstRunStatus(status: SpacesFirstRunStatus, connectionId: string): SpacesFirstRunStatus {
  return {
    requestedAt: status.requestedAt ?? null,
    workspaces: (status.workspaces ?? []).map((item) => ({
      ...item,
      workspaceId: toRenderer(connectionId, item.workspaceId),
      homePageId: toRendererOrNull(connectionId, item.homePageId),
      firstRun: mapFirstRun(item.firstRun, connectionId),
    })),
    summary: status.summary ?? { state: 'waiting', summarizedAt: null },
    haltedReason: status.haltedReason ?? null,
    ...(typeof status.closed === 'boolean' ? { closed: status.closed } : {}),
  };
}

/** Idempotent: queues every workspace's first read the first time, and wakes pending ones after that. */
export async function startSpacesFirstRun(connectionId: string, signal?: AbortSignal): Promise<SpacesFirstRunStatus> {
  return mapFirstRunStatus(await request<SpacesFirstRunStatus>(`${base(connectionId)}/spaces-home/first-run`, { method: 'POST', body: {}, signal }), connectionId);
}

export async function fetchSpacesFirstRun(connectionId: string, signal?: AbortSignal): Promise<SpacesFirstRunStatus> {
  return mapFirstRunStatus(await request<SpacesFirstRunStatus>(`${base(connectionId)}/spaces-home/first-run`, { signal }), connectionId);
}

/** Queues failed first reads again (one workspace, or all) and lifts a restriction-check stop. */
export async function retrySpacesFirstRun(connectionId: string, workspaceId?: string): Promise<SpacesFirstRunStatus> {
  const body = workspaceId ? { workspaceId: serverEntityId(workspaceId, connectionId) } : {};
  return mapFirstRunStatus(await request<SpacesFirstRunStatus>(`${base(connectionId)}/spaces-home/first-run/retry`, { method: 'POST', body }), connectionId);
}

export async function actOnHomeReminder(connectionId: string, item: HomeSectionItem, action: HomeReminderAction): Promise<void> {
  await request(`${base(connectionId)}/spaces-home/reminders`, {
    method: 'POST', body: { itemId: item.id, version: item.reminderVersion, action },
  });
}
