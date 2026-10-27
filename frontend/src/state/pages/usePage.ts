import { useCallback, useEffect, useRef, useState } from 'react';
import type { PageChangeDto, PageDto, PageEditOp } from 'michi-shared';
import {
  acknowledgePageActivity,
  changePageChange,
  editPage,
  fetchPage,
  fetchPageActivitySeen,
  listPageChanges,
  patchPage,
  revertPageBatch,
  type PageApiIdentity,
  type PageChangeAction,
} from '../../services/api/pages';
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

export interface UsePageOptions extends PageApiIdentity {
  pageId: string;
  enabled?: boolean;
}

export interface UsePageResult {
  page: PageDto | null;
  changes: PageChangeDto[];
  changesCursor: number | null;
  hasMoreChanges: boolean;
  lastSeenChangeSeq: number;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  stale: boolean;
  refresh: () => void;
  loadMoreChanges: () => Promise<void>;
  edit: (ops: PageEditOp[]) => Promise<void>;
  patch: (body: { title?: string; color?: string | null; parentId?: string | null; position?: number }) => Promise<void>;
  revert: (changeId: string) => Promise<void>;
  redo: (changeId: string) => Promise<void>;
  accept: (changeId: string, editedContent?: unknown) => Promise<void>;
  dismiss: (changeId: string) => Promise<void>;
  reopen: (changeId: string) => Promise<void>;
  revertBatch: (batchId: string) => Promise<void>;
  acknowledgeThrough: (seq: number) => Promise<void>;
}

const PAGE_POLL_MS = 10_000;
const CHANGE_PAGE_SIZE = 100;

export function pageResourceKey(connectionId: string, workspaceId: string, pageId: string): string {
  return resourceKey('page', connectionId, workspaceId, pageId);
}

export function usePage({ backendConnectionId, workspaceId, pageId, enabled = true }: UsePageOptions): UsePageResult {
  const identity: PageApiIdentity = { backendConnectionId, workspaceId };
  const key = pageResourceKey(backendConnectionId, workspaceId, pageId);
  const snapshot = useResource<PageDto>(key);
  const [changes, setChanges] = useState<PageChangeDto[]>([]);
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const [changesCursor, setChangesCursor] = useState<number | null>(null);
  const changesCursorRef = useRef<number | null>(null);
  const [hasMoreChanges, setHasMoreChanges] = useState(false);
  const [lastSeenChangeSeq, setLastSeenChangeSeq] = useState(0);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const changesReadRef = useRef(0);
  const changesInitializedRef = useRef(false);
  const loadedPageIdRef = useRef<string | null>(null);
  const activeIdentityRef = useRef(key);
  activeIdentityRef.current = key;
  const identityGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const expectedView = useRef({ key, version: 0 });
  if (expectedView.current.key !== key) expectedView.current = { key, version: 0 };

  useEffect(() => {
    const generation = ++identityGenerationRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (identityGenerationRef.current === generation) identityGenerationRef.current += 1;
    };
  }, [key]);

  const refreshChanges = useCallback(async (): Promise<void> => {
    if (!enabled || !pageId) return;
    const readId = ++changesReadRef.current;
    setChangesError(null);
    try {
      const answer = await listPageChanges(pageId, { ...identity, direction: 'backward', limit: CHANGE_PAGE_SIZE });
      if (readId !== changesReadRef.current || loadedPageIdRef.current !== pageId) return;
      const previous = changesRef.current;
      const byId = new Map(previous.map((change) => [change.id, change]));
      const previousIds = new Set(byId.keys());
      for (const change of answer.changes) byId.set(change.id, change);
      const merged = [...byId.values()].sort((a, b) => a.seq - b.seq);
      setChanges(merged);
      const overlapsLoadedWindow = answer.changes.some((change) => previousIds.has(change.id));
      const latestWindowFloor = answer.changes.reduce<number | null>((floor, change) => floor === null ? change.seq : Math.min(floor, change.seq), null);
      const hasDisjointNewerWindow = previous.length > 0 && !overlapsLoadedWindow && answer.hasMore && latestWindowFloor !== null &&
        previous.at(-1)!.seq < latestWindowFloor;
      if (!changesInitializedRef.current || previous.length === 0 || hasDisjointNewerWindow) {
        changesCursorRef.current = answer.nextBefore;
        setChangesCursor(answer.nextBefore);
        setHasMoreChanges(answer.hasMore);
      }
      changesInitializedRef.current = true;
    } catch (error) {
      if (readId === changesReadRef.current) setChangesError(error instanceof Error ? error.message : 'Could not load page changes');
    }
  }, [backendConnectionId, enabled, pageId, workspaceId]);

  const refresh = useCallback(() => {
    if (!enabled || !pageId) return;
    loadedPageIdRef.current = pageId;
    const generation = startResourceRead(key);
    const current = readResource<PageDto>(key).data;
    const read = async (attempt = 0): Promise<void> => {
      const page = await fetchPage(pageId, { ...identity, ...(attempt === 0 && current ? { since: current.viewVersion } : {}) });
      const cached = readResource<PageDto>(key).data;
      const minimum = Math.max(cached?.viewVersion ?? 0, expectedView.current.key === key ? expectedView.current.version : 0);
      if ((page?.viewVersion ?? current?.viewVersion ?? 0) < minimum) {
        // Another reader may already have delivered the required version.
        if (cached && cached.viewVersion >= minimum) { retainResource(key, generation); return; }
        // A delayed read/304 must never replace a committed milestone with an
        // older version. Retry the read, never the agent's write.
        if (attempt < 2 && mountedRef.current && activeIdentityRef.current === key) return read(attempt + 1);
        throw new Error('The latest page update is not available yet. Showing the last saved version.');
      }
      if (page) commitResourceRead(key, generation, page);
      else retainResource(key, generation);
    };
    void read().catch((error: unknown) => { failResourceRead(key, generation, error); });
    void refreshChanges();
  }, [backendConnectionId, enabled, key, pageId, refreshChanges, workspaceId]);

  useEffect(() => {
    if (!enabled || !pageId) return undefined;
    changesRef.current = [];
    changesCursorRef.current = null;
    changesInitializedRef.current = false;
    setChanges([]);
    setChangesCursor(null);
    setHasMoreChanges(false);
    setChangesError(null);
    setActionError(null);
    setLastSeenChangeSeq(0);
    loadedPageIdRef.current = pageId;
    refresh();
    return () => {
      changesReadRef.current += 1;
      loadedPageIdRef.current = null;
    };
  }, [enabled, pageId, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    return subscribePageChanges({ backendConnectionId, workspaceId, pageId }, (changed) => {
      if (changed.pageId === pageId && changed.viewVersion !== undefined) {
        expectedView.current.version = Math.max(expectedView.current.version, changed.viewVersion);
      }
      refresh();
    });
  }, [backendConnectionId, enabled, pageId, refresh, workspaceId]);

  useEffect(() => {
    if (!enabled) return undefined;
    const onFocus = () => refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, PAGE_POLL_MS);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, refresh]);

  const loadMoreChanges = useCallback(async () => {
    if (!enabled || !pageId || !hasMoreChanges || changesCursor === null) return;
    const readId = ++changesReadRef.current;
    try {
      const answer = await listPageChanges(pageId, {
        ...identity,
        direction: 'backward',
        beforeSeq: changesCursor,
        limit: CHANGE_PAGE_SIZE,
      });
      if (readId !== changesReadRef.current || loadedPageIdRef.current !== pageId) return;
      setChanges((previous) => {
        const byId = new Map(previous.map((change) => [change.id, change]));
        for (const change of answer.changes) byId.set(change.id, change);
        return [...byId.values()].sort((a, b) => a.seq - b.seq);
      });
      setChangesCursor(answer.nextBefore);
      changesCursorRef.current = answer.nextBefore;
      setHasMoreChanges(answer.hasMore);
      changesInitializedRef.current = true;
    } catch (error) {
      setChangesError(error instanceof Error ? error.message : 'Could not load page changes');
    }
  }, [backendConnectionId, changesCursor, enabled, hasMoreChanges, pageId, workspaceId]);

  const assertWritable = useCallback(() => {
    const current = readResource<PageDto>(key);
    if (!enabled || !pageId || !current.data || current.stale || current.status !== 'ready') {
      throw new Error('Page is not ready for editing');
    }
    return current.data;
  }, [enabled, key, pageId]);

  const edit = useCallback(async (ops: PageEditOp[]) => {
    const page = assertWritable();
    try {
      const answer = await editPage(pageId, { revision: page.revision, ops }, identity);
      writeResource(key, answer.page);
      notifyPageChanged({ backendConnectionId, workspaceId, pageId });
      await refreshChanges();
    } catch (error) {
      if ((error as { status?: number })?.status === 409) refresh();
      throw error;
    }
  }, [assertWritable, backendConnectionId, key, pageId, refresh, refreshChanges, workspaceId]);

  const patch = useCallback(async (body: { title?: string; color?: string | null; parentId?: string | null; position?: number }) => {
    const page = assertWritable();
    try {
      await patchPage(pageId, { revision: page.revision, ...body }, identity);
      notifyPageChanged({ backendConnectionId, workspaceId, pageId });
      refresh();
    } catch (error) {
      if ((error as { status?: number })?.status === 409) refresh();
      throw error;
    }
  }, [assertWritable, backendConnectionId, key, pageId, refresh, workspaceId]);

  const runChangeAction = useCallback(async (changeId: string, action: PageChangeAction, editedContent?: unknown) => {
    const requestKey = key;
    const requestGeneration = identityGenerationRef.current;
    const stillCurrent = () => mountedRef.current && activeIdentityRef.current === requestKey && identityGenerationRef.current === requestGeneration;
    try {
      assertWritable();
      const change = await changePageChange(changeId, action, identity, editedContent === undefined ? undefined : { editedContent });
      if (!stillCurrent()) return;
      setActionError(null);
      setChanges((previous) => {
        const byId = new Map(previous.map((item) => [item.id, item]));
        byId.set(change.id, change);
        return [...byId.values()].sort((a, b) => a.seq - b.seq);
      });
      notifyPageChanged({ backendConnectionId, workspaceId, pageId });
      void refresh();
    } catch (error) {
      if (!stillCurrent()) return;
      if ((error as { status?: number })?.status === 409) refresh();
      setActionError(error instanceof Error ? error.message : 'Could not update page activity');
    }
  }, [assertWritable, backendConnectionId, key, pageId, refresh, workspaceId]);

  const revert = useCallback(async (changeId: string) => { await runChangeAction(changeId, 'revert'); }, [runChangeAction]);
  const redo = useCallback(async (changeId: string) => { await runChangeAction(changeId, 'redo'); }, [runChangeAction]);
  const accept = useCallback(async (changeId: string, editedContent?: unknown) => { await runChangeAction(changeId, 'accept', editedContent); }, [runChangeAction]);
  const dismiss = useCallback(async (changeId: string) => { await runChangeAction(changeId, 'dismiss'); }, [runChangeAction]);
  const reopen = useCallback(async (changeId: string) => { await runChangeAction(changeId, 'reopen'); }, [runChangeAction]);

  const revertBatch = useCallback(async (batchId: string) => {
    const requestKey = key;
    const requestGeneration = identityGenerationRef.current;
    const stillCurrent = () => mountedRef.current && activeIdentityRef.current === requestKey && identityGenerationRef.current === requestGeneration;
    try {
      assertWritable();
      await revertPageBatch(batchId, identity);
      if (!stillCurrent()) return;
      setActionError(null);
      notifyPageChanged({ backendConnectionId, workspaceId, pageId });
      void refresh();
    } catch (error) {
      if (!stillCurrent()) return;
      if ((error as { status?: number })?.status === 409) refresh();
      setActionError(error instanceof Error ? error.message : 'Could not undo page activity');
    }
  }, [assertWritable, backendConnectionId, key, pageId, refresh, workspaceId]);

  const acknowledgeThrough = useCallback(async (seq: number) => {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid activity sequence');
    const requestKey = key;
    const requestGeneration = identityGenerationRef.current;
    const result = await acknowledgePageActivity(pageId, seq, identity);
    if (!mountedRef.current || activeIdentityRef.current !== requestKey || identityGenerationRef.current !== requestGeneration) return;
    setLastSeenChangeSeq((previous) => Math.max(previous, result.lastSeenChangeSeq));
  }, [backendConnectionId, key, pageId, workspaceId]);

  useEffect(() => {
    if (!enabled || !pageId) return undefined;
    let cancelled = false;
    void fetchPageActivitySeen(pageId, identity)
      .then((result) => { if (!cancelled) setLastSeenChangeSeq(result.lastSeenChangeSeq); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [backendConnectionId, enabled, pageId, workspaceId]);

  const status = snapshot.status;
  const error = snapshot.error ?? actionError ?? changesError;
  return {
    page: snapshot.data,
    changes,
    changesCursor,
    hasMoreChanges,
    lastSeenChangeSeq,
    status,
    error,
    stale: snapshot.stale,
    refresh,
    loadMoreChanges,
    edit,
    patch,
    revert,
    redo,
    accept,
    dismiss,
    reopen,
    revertBatch,
    acknowledgeThrough,
  };
}
