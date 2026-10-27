import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTaskDatabaseId, openTaskDatabase } from '../../../services/api/taskDatabase';
import { PageApiError } from '../../../services/api/pages';
import { notifyPageChanged, subscribePageChanges } from '../../../state/pages/pageEvents';

export interface TaskDatabaseState {
  /** undefined while reading; null when the workspace has none yet. */
  databaseId: string | null | undefined;
  error: string | null;
  creating: boolean;
  /** The server refused to make a task database here (the Pages Home); the error says why and Create one is not offered. */
  refused: boolean;
  create: () => Promise<void>;
  /** Reads again after a failed read. */
  retry: () => void;
}

/**
 * The workspace's task database: read once, read again whenever the
 * workspace's pages change while it has none (another board, or the
 * assistant, may make it), and made on request.
 */
export function useTaskDatabase(connectionId: string, workspaceId: string): TaskDatabaseState {
  const key = `${connectionId}\u0000${workspaceId}`;
  // The id belongs to the workspace it was read for; another workspace's id is not an answer.
  const [known, setKnown] = useState<{ key: string; databaseId: string | null } | null>(null);
  const databaseId = known?.key === key ? known.databaseId : undefined;
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // A refusal is the server's answer for this workspace, kept apart from read errors so a later read cannot clear it.
  const [refusal, setRefusal] = useState<{ key: string; message: string } | null>(null);
  const refused = refusal?.key === key;
  const [reads, setReads] = useState(0);
  const keyRef = useRef(key);
  keyRef.current = key;
  useEffect(() => { setError(null); setCreating(false); }, [key]);
  useEffect(() => {
    const controller = new AbortController();
    void fetchTaskDatabaseId({ backendConnectionId: connectionId, workspaceId, signal: controller.signal }).then(
      (id) => { if (!controller.signal.aborted) { setKnown({ key, databaseId: id }); setError(null); } },
      (cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Couldn't read this workspace's task database"); },
    );
    return () => controller.abort();
  }, [connectionId, key, workspaceId, reads]);
  useEffect(() => {
    if (databaseId !== null || refused) return undefined;
    return subscribePageChanges({ backendConnectionId: connectionId, workspaceId }, () => setReads((n) => n + 1));
  }, [connectionId, databaseId, refused, workspaceId]);
  const create = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const { database } = await openTaskDatabase({ backendConnectionId: connectionId, workspaceId });
      notifyPageChanged({ backendConnectionId: connectionId, workspaceId });
      // The person moved to another workspace meanwhile: this answer is not theirs.
      if (keyRef.current !== key) return;
      setKnown({ key, databaseId: database.id });
    } catch (cause) {
      if (keyRef.current !== key) return;
      const message = cause instanceof Error ? cause.message : "Couldn't make the task database";
      if (cause instanceof PageApiError && cause.code === 'tasks_need_workspace') setRefusal({ key, message });
      setError(message);
    } finally {
      if (keyRef.current === key) setCreating(false);
    }
  }, [connectionId, key, workspaceId]);
  const retry = useCallback(() => { setError(null); setReads((n) => n + 1); }, []);
  return { databaseId, error: refused ? refusal.message : error, creating, refused, create, retry };
}
