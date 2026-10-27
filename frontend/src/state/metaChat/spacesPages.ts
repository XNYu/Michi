import { toast } from 'sonner';
import type { MetaAgentChatPageRef, PageSummaryDto, SpaceSummaryDto } from 'michi-shared';
import { META_AGENT_CHAT_CONTEXT_LIMITS } from 'michi-shared';
import { API_BASE_URL } from '../../config/env';
import { fetchPage, PageApiError } from '../../services/api/pages';
import { readResource, resourceKey, subscribeResource } from '../pages/resourceCache';
import { openNativePageRoute } from '../../components/terminal/spaces/SpacesPage';
import { requestWorkspaceHome } from '../pages/workspaceHomeNav';

// The cache keys useSpaces and useSpaceTree read into (spacesResourceKey, spaceTreeResourceKey);
// built here so modules that mock those hooks still mount the window.
const spacesKey = (connectionId: string) => resourceKey('spaces', connectionId);
const treeKey = (connectionId: string, workspaceId: string) => resourceKey('page-tree', connectionId, workspaceId);

/**
 * The Spaces pages the Meta agent window knows by id: the Spaces Home, each
 * workspace's home and the pages the sidebar has loaded. Only this machine's
 * backend: the Meta agent's conversation lives there.
 */
export interface SpacesHomeIds {
  home: { id: string; title: string } | null;
  workspaces: Record<string, string>;
}

const LOCAL = 'local';
let homeIds: SpacesHomeIds = { home: null, workspaces: {} };
let loading: Promise<SpacesHomeIds> | null = null;
const listeners = new Set<() => void>();

export function getSpacesHomeIds(): SpacesHomeIds { return homeIds; }

export function subscribeSpacesHomeIds(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${API_BASE_URL}${path}`);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

/** Reads the home page ids once (again with `force`); older backends without the routes leave them empty. */
export function loadSpacesHomeIds(force = false): Promise<SpacesHomeIds> {
  if (loading && !force) return loading;
  loading = (async () => {
    const [home, workspaces] = await Promise.all([
      getJson('/spaces-home').catch(() => null) as Promise<{ page?: { id?: unknown; title?: unknown } } | null>,
      getJson('/spaces-home/workspaces').catch(() => null) as Promise<{ items?: Array<{ workspaceId?: unknown; homePageId?: unknown }> } | null>,
    ]);
    const next: SpacesHomeIds = {
      home: typeof home?.page?.id === 'string' ? { id: home.page.id, title: typeof home.page.title === 'string' ? home.page.title : 'Home' } : null,
      workspaces: {},
    };
    for (const item of workspaces?.items ?? []) {
      if (typeof item.workspaceId === 'string' && typeof item.homePageId === 'string') next.workspaces[item.workspaceId] = item.homePageId;
    }
    homeIds = next;
    for (const listener of listeners) listener();
    return next;
  })();
  return loading;
}

const VALID_ID = /^[^\s\p{Cc}]+$/u;
const sendable = (id: string) => VALID_ID.test(id) && id.length <= META_AGENT_CHAT_CONTEXT_LIMITS.idChars && !id.startsWith('remote:');

/** The pages the sidebar knows, for the turn context: Home, workspace homes, then Spaces and their pages. */
export function knownSpacesPages(workspaces: ReadonlyArray<{ id: string; name: string }>): MetaAgentChatPageRef[] {
  const out = new Map<string, MetaAgentChatPageRef>();
  const add = (id: string, title: string, workspaceId?: string) => {
    if (out.has(id) || !sendable(id) || out.size >= META_AGENT_CHAT_CONTEXT_LIMITS.pages) return;
    out.set(id, { id, title: title.slice(0, META_AGENT_CHAT_CONTEXT_LIMITS.titleChars), ...(workspaceId && sendable(workspaceId) ? { workspaceId } : {}) });
  };
  if (homeIds.home) add(homeIds.home.id, homeIds.home.title);
  for (const ws of workspaces) {
    const homeId = homeIds.workspaces[ws.id];
    if (homeId) add(homeId, ws.name, ws.id);
  }
  for (const space of readResource<SpaceSummaryDto[]>(spacesKey(LOCAL)).data ?? []) add(space.id, space.title || 'Untitled', space.workspaceId);
  for (const ws of workspaces) {
    for (const page of readResource<PageSummaryDto[]>(treeKey(LOCAL, ws.id)).data ?? []) add(page.id, page.title || 'Untitled', page.workspaceId);
  }
  return [...out.values()];
}

/** Re-runs `listener` when the sidebar's page lists change. */
export function subscribeKnownSpacesPages(workspaceIds: readonly string[], listener: () => void): () => void {
  const stops = [
    subscribeSpacesHomeIds(listener),
    subscribeResource(spacesKey(LOCAL), listener),
    ...workspaceIds.map((id) => subscribeResource(treeKey(LOCAL, id), listener)),
  ];
  return () => { for (const stop of stops) stop(); };
}

export interface SpacesPageTarget {
  pageId: string;
  workspaceId?: string;
  backendConnectionId?: string;
  blockId?: string;
  /** The page already on screen: opening it only scrolls to the block. */
  currentPageId?: string | null;
}

const FLASH_MS = 1_200;
const FIND_MS = 4_000;

/** Scrolls the open page to the block and flashes it, waiting a little for the page to render. */
export function flashSpacesBlock(blockId: string, root: ParentNode = document): void {
  const deadline = Date.now() + FIND_MS;
  const attempt = () => {
    const target = Array.from(root.querySelectorAll<HTMLElement>('[data-block-id]'))
      .find((el) => el.dataset.blockId === blockId && !el.closest('.meta-chat-panel'));
    if (!target) {
      if (Date.now() < deadline) window.setTimeout(attempt, 80);
      return;
    }
    const block = target.closest<HTMLElement>('.michi-doc-block') ?? target;
    block.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    block.removeAttribute('data-flash');
    void block.offsetWidth;
    block.setAttribute('data-flash', '');
    window.setTimeout(() => block.removeAttribute('data-flash'), FLASH_MS);
  };
  attempt();
}

export const PAGE_DELETED_MESSAGE = 'This page has been deleted.';

/**
 * Opens a Spaces page (the Spaces Home and a workspace's home as their own views) and flashes `blockId`.
 * A page that is gone shows a toast instead. Resolves to what happened.
 */
export async function openSpacesPage(target: SpacesPageTarget): Promise<'opened' | 'deleted' | 'failed'> {
  const backendConnectionId = target.backendConnectionId ?? LOCAL;
  let workspaceId = target.workspaceId;
  try {
    const page = await fetchPage(target.pageId, { backendConnectionId, workspaceId: workspaceId ?? '' });
    workspaceId = page?.workspaceId ?? workspaceId;
  } catch (error) {
    if (error instanceof PageApiError && (error.status === 404 || error.status === 410)) {
      toast(PAGE_DELETED_MESSAGE);
      return 'deleted';
    }
    if (!workspaceId) {
      toast.error("Couldn't open this page.");
      return 'failed';
    }
  }
  if (!workspaceId) {
    toast(PAGE_DELETED_MESSAGE);
    return 'deleted';
  }
  const workspaceHomeOf = backendConnectionId === LOCAL
    ? Object.entries(homeIds.workspaces).find(([, homePageId]) => homePageId === target.pageId)?.[0]
    : undefined;
  if (target.currentPageId === target.pageId) {
    // Already on screen.
  } else if (backendConnectionId === LOCAL && homeIds.home?.id === target.pageId) {
    window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'spaces' } }));
  } else if (workspaceHomeOf) {
    requestWorkspaceHome({ workspaceId: workspaceHomeOf, backendConnectionId });
  } else {
    openNativePageRoute({ pageId: target.pageId, workspaceId, backendConnectionId });
  }
  if (target.blockId) flashSpacesBlock(target.blockId);
  return 'opened';
}

/** Test seam. */
export function resetSpacesPagesForTests(next: SpacesHomeIds = { home: null, workspaces: {} }): void {
  homeIds = next;
  loading = null;
}
