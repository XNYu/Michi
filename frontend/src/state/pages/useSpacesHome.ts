import { useCallback, useEffect, useRef } from 'react';
import type {
  HomeConversationsDto,
  HomeSectionKey,
  ProgressCardDto,
  SpaceActivityItem,
  SpacesHomeDto,
  SpacesHomeSectionsDto,
  WorkspaceHomeDto,
  WorkspaceHomeSummaryDto,
} from 'michi-shared';
import {
  fetchHomeConversations,
  fetchHomeSections,
  fetchProgressCards,
  fetchSpaceActivity,
  fetchSpacesHome,
  fetchWorkspaceHome,
  fetchWorkspaceHomes,
} from '../../services/api/spacesHome';
import { subscribePageChanges } from './pageEvents';
import { commitResourceRead, failResourceRead, resourceKey, startResourceRead, useResource } from './resourceCache';

export interface HomeResource<T> {
  data: T | null;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  /** The last confirmed data is shown while the backend cannot be read. */
  stale: boolean;
  refresh: () => void;
}

const HOME_POLL_MS = 15_000;

/**
 * Reads one backend-scoped resource into the shared cache and keeps it fresh:
 * on mount, on page events from the same backend, on window focus and on a
 * visible-tab poll. A failed read keeps the last confirmed data (marked
 * stale) instead of replacing it with an empty answer.
 */
function useHomeResource<T>(
  key: string,
  connectionId: string,
  load: (signal: AbortSignal) => Promise<T>,
  enabled = true,
): HomeResource<T> {
  const snapshot = useResource<T>(key);
  const loadRef = useRef(load);
  loadRef.current = load;
  const controllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    if (!enabled) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const generation = startResourceRead(key);
    void loadRef.current(controller.signal).then(
      (data) => { commitResourceRead(key, generation, data); },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        failResourceRead(key, generation, error);
      },
    );
  }, [enabled, key]);

  useEffect(() => {
    refresh();
    return () => controllerRef.current?.abort();
  }, [refresh]);
  useEffect(() => (enabled ? subscribePageChanges({ backendConnectionId: connectionId }, refresh) : undefined), [connectionId, enabled, refresh]);
  useEffect(() => {
    if (!enabled) return undefined;
    const onFocus = () => refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, HOME_POLL_MS);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, refresh]);

  return { data: snapshot.data, status: snapshot.status, error: snapshot.error, stale: snapshot.stale, refresh };
}

export const spacesHomeResourceKey = (connectionId: string) => resourceKey('spaces-home', connectionId);

/** The Spaces Home page of one backend connection, with its layout rules. */
export function useSpacesHome(connectionId: string): HomeResource<SpacesHomeDto> {
  return useHomeResource(spacesHomeResourceKey(connectionId), connectionId, (signal) => fetchSpacesHome(connectionId, signal));
}

/** Every live workspace of the connection with its home page id and first-run progress. */
export function useSpacesHomeWorkspaces(connectionId: string): HomeResource<WorkspaceHomeSummaryDto[]> {
  return useHomeResource(resourceKey('spaces-home-workspaces', connectionId), connectionId, (signal) => fetchWorkspaceHomes(connectionId, signal));
}

/** One workspace's default home page. */
export function useWorkspaceHome(workspaceId: string, connectionId: string): HomeResource<WorkspaceHomeDto> {
  return useHomeResource(
    resourceKey('workspace-home', connectionId, workspaceId),
    connectionId,
    (signal) => fetchWorkspaceHome(workspaceId, connectionId, signal),
    Boolean(workspaceId),
  );
}

/** Waiting, Stalled and Done, counted from Michi's own conversations. */
export function useHomeSections(connectionId: string): HomeResource<SpacesHomeSectionsDto> {
  return useHomeResource(resourceKey('spaces-home-sections', connectionId), connectionId, (signal) => fetchHomeSections(connectionId, { signal }));
}

/** All threads: the connection's Michi conversations, or those in one Home section. */
export function useHomeConversations(connectionId: string, state: HomeSectionKey | null): HomeResource<HomeConversationsDto> {
  return useHomeResource(
    resourceKey('spaces-home-conversations', connectionId, state ?? ''),
    connectionId,
    (signal) => fetchHomeConversations(connectionId, { state, signal }),
  );
}

/** Recent page changes and conversations started from a Space. */
export function useSpaceActivity(connectionId: string, limit?: number): HomeResource<SpaceActivityItem[]> {
  return useHomeResource(
    resourceKey('spaces-home-activity', connectionId, limit === undefined ? '' : String(limit)),
    connectionId,
    (signal) => fetchSpaceActivity(connectionId, { limit, signal }),
  );
}

/** Conversations started from a Space, shown as cards until a day after they are seen. */
export function useProgressCards(connectionId: string): HomeResource<ProgressCardDto[]> {
  return useHomeResource(resourceKey('spaces-home-progress', connectionId), connectionId, (signal) => fetchProgressCards(connectionId, signal));
}
