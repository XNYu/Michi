import { useCallback, useEffect } from 'react';
import type { PageSummaryDto } from 'michi-shared';
import { listPages, type PageApiOptions } from '../../services/api/pages';
import { commitResourceRead, failResourceRead, resourceKey, startResourceRead, useResource } from './resourceCache';
import { subscribePageChanges } from './pageEvents';

export interface UseSpaceTreeOptions {
  backendConnectionId: string;
  workspaceId: string;
  enabled?: boolean;
}

export interface UseSpaceTreeResult {
  pages: PageSummaryDto[] | null;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  refresh: () => void;
}

const TREE_POLL_MS = 15_000;

export function spaceTreeResourceKey(connectionId: string, workspaceId: string): string {
  return resourceKey('page-tree', connectionId, workspaceId);
}

export function useSpaceTree({ backendConnectionId, workspaceId, enabled = true }: UseSpaceTreeOptions): UseSpaceTreeResult {
  const key = spaceTreeResourceKey(backendConnectionId, workspaceId);
  const snapshot = useResource<PageSummaryDto[]>(key);
  const refresh = useCallback(() => {
    if (!enabled || !workspaceId) return;
    const generation = startResourceRead(key);
    const options: PageApiOptions = { backendConnectionId, workspaceId };
    void (async () => {
      const items: PageSummaryDto[] = [];
      let cursor: string | undefined;
      do {
        const page = await listPages(workspaceId, { ...options, ...(cursor ? { cursor } : {}) });
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      commitResourceRead(key, generation, items);
    })().catch((error: unknown) => { failResourceRead(key, generation, error); });
  }, [backendConnectionId, enabled, key, workspaceId]);

  useEffect(() => { if (enabled) refresh(); }, [enabled, refresh]);
  useEffect(() => {
    if (!enabled) return undefined;
    return subscribePageChanges({ backendConnectionId, workspaceId }, refresh);
  }, [backendConnectionId, enabled, refresh, workspaceId]);
  useEffect(() => {
    if (!enabled) return undefined;
    const onFocus = () => refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, TREE_POLL_MS);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, refresh]);

  return { pages: snapshot.data, status: snapshot.status, error: snapshot.error, refresh };
}
