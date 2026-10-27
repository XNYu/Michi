import { useCallback, useEffect } from 'react';
import type { SpaceSummaryDto } from 'michi-shared';
import { fetchSpaces } from '../../services/api/pages';
import { commitResourceRead, failResourceRead, resourceKey, startResourceRead, useResource } from './resourceCache';
import { subscribePageChanges } from './pageEvents';

export interface UseSpacesResult {
  spaces: SpaceSummaryDto[] | null;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  refresh: () => void;
}

const SPACES_POLL_MS = 15_000;

export function spacesResourceKey(connectionId: string): string {
  return resourceKey('spaces', connectionId);
}

export function useSpaces(connectionId: string): UseSpacesResult {
  const key = spacesResourceKey(connectionId);
  const snapshot = useResource<SpaceSummaryDto[]>(key);

  const refresh = useCallback(() => {
    const generation = startResourceRead(key);
    void fetchSpaces(connectionId).then(
      (spaces) => { commitResourceRead(key, generation, spaces); },
      (error: unknown) => { failResourceRead(key, generation, error); },
    );
  }, [connectionId, key]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => subscribePageChanges({ backendConnectionId: connectionId }, refresh), [connectionId, refresh]);
  useEffect(() => {
    const onFocus = () => refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, SPACES_POLL_MS);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  return {
    spaces: snapshot.data,
    status: snapshot.status,
    error: snapshot.error,
    refresh,
  };
}
