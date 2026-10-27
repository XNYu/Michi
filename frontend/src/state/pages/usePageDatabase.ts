import { useCallback, useEffect } from 'react';
import type { PageDatabase, PageDatabaseEditOp, PageWriteResult } from 'michi-shared';
import { editPageDatabase, fetchPageDatabase, type PageApiIdentity } from '../../services/api/pages';
import { notifyPageChanged, subscribePageChanges } from './pageEvents';
import {
  commitResourceRead,
  failResourceRead,
  readResource,
  resourceKey,
  retainResource,
  startResourceRead,
  useResource,
  writeResource,
} from './resourceCache';

export interface UsePageDatabaseOptions extends PageApiIdentity {
  databaseId: string;
  enabled?: boolean;
}

export interface UsePageDatabaseResult {
  database: PageDatabase | null;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  stale: boolean;
  refresh: () => void;
  edit: (ops: PageDatabaseEditOp[]) => Promise<{ database: PageDatabase; changes: PageWriteResult }>;
}

const DATABASE_POLL_MS = 10_000;

export function pageDatabaseResourceKey(connectionId: string, workspaceId: string, databaseId: string): string {
  return resourceKey('page-database', connectionId, workspaceId, databaseId);
}

export function usePageDatabase({ backendConnectionId, workspaceId, databaseId, enabled = true }: UsePageDatabaseOptions): UsePageDatabaseResult {
  const identity: PageApiIdentity = { backendConnectionId, workspaceId };
  const key = pageDatabaseResourceKey(backendConnectionId, workspaceId, databaseId);
  const snapshot = useResource<PageDatabase>(key);

  const refresh = useCallback(() => {
    if (!enabled || !workspaceId || !databaseId) return;
    const generation = startResourceRead(key);
    const current = readResource<PageDatabase>(key).data;
    void fetchPageDatabase(databaseId, {
      ...identity,
      ...(current ? { since: current.revision } : {}),
    }).then((database) => {
      if (database) commitResourceRead(key, generation, database);
      else if (current) retainResource(key, generation);
      else failResourceRead(key, generation, new Error('Database returned unchanged before an initial snapshot'));
    }).catch((error: unknown) => { failResourceRead(key, generation, error); });
  }, [backendConnectionId, databaseId, enabled, key, workspaceId]);

  useEffect(() => { if (enabled) refresh(); }, [enabled, refresh]);
  useEffect(() => {
    if (!enabled) return undefined;
    return subscribePageChanges({ backendConnectionId, workspaceId, databaseId }, refresh);
  }, [backendConnectionId, databaseId, enabled, refresh, workspaceId]);
  useEffect(() => {
    if (!enabled) return undefined;
    const onFocus = () => refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, DATABASE_POLL_MS);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, refresh]);

  const edit = useCallback(async (ops: PageDatabaseEditOp[]) => {
    const current = readResource<PageDatabase>(key);
    if (!enabled || !databaseId || !current.data || current.stale || current.status !== 'ready') {
      throw new Error('Database is not ready for editing');
    }
    try {
      const answer = await editPageDatabase(databaseId, { revision: current.data.revision, ops }, identity);
      writeResource(key, answer.database);
      notifyPageChanged({ backendConnectionId, workspaceId, databaseId });
      return answer;
    } catch (error) {
      if ((error as { status?: number })?.status === 409) refresh();
      throw error;
    }
  }, [backendConnectionId, databaseId, enabled, key, refresh, workspaceId]);

  return {
    database: snapshot.data,
    status: snapshot.status,
    error: snapshot.error,
    stale: snapshot.stale,
    refresh,
    edit,
  };
}
