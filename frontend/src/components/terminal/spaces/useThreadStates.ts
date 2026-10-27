import { useEffect, useMemo, useState } from 'react';
import type { ThreadCardItem } from 'michi-shared';
import { THREAD_STATE_LIMITS } from 'michi-shared';
import { serverEntityId } from '../../../config/backendIdentity';
import { fetchThreadStates } from '../../../services/api/spacesHome';

/** How often an open task board re-reads its conversations; focusing the window reads them too. */
const REFRESH_MS = 60_000;
const NONE: ReadonlyMap<string, ThreadCardItem> = new Map();

export interface ThreadStates {
  /** Keyed by the ids the cells hold. */
  byNode: ReadonlyMap<string, ThreadCardItem>;
  loaded: boolean;
  failed: boolean;
}

interface Answer {
  /** The id set (and connection) this answer was read for. */
  key: string;
  byNode: ReadonlyMap<string, ThreadCardItem>;
  failed: boolean;
}

/**
 * Where the named conversations stand now, read in as many requests as the
 * endpoint's id limit needs. `loaded` is true only once every id of the current
 * set has been read; after the set changes the previous answer stays in
 * `byNode` for display, but nothing is called gone on its strength. A failed
 * read keeps the last answer.
 */
export function useThreadStates(connectionId: string, nodeIds: readonly string[], enabled = true): ThreadStates {
  const key = useMemo(() => JSON.stringify([connectionId, [...new Set(nodeIds)].sort()]), [connectionId, nodeIds]);
  const [state, setState] = useState<Answer>({ key: '', byNode: NONE, failed: false });
  useEffect(() => {
    if (!enabled) return undefined;
    const [connection, ids] = JSON.parse(key) as [string, string[]];
    if (!ids.length) {
      setState({ key, byNode: NONE, failed: false });
      return undefined;
    }
    const batches: string[][] = [];
    for (let at = 0; at < ids.length; at += THREAD_STATE_LIMITS.nodeIds) batches.push(ids.slice(at, at + THREAD_STATE_LIMITS.nodeIds));
    let live = true;
    let latest = 0;
    const controller = new AbortController();
    const load = () => {
      const request = ++latest;
      void Promise.all(batches.map((batch) => fetchThreadStates(connection, { nodeIds: batch, signal: controller.signal }))).then(
        (answers) => {
          if (!live || request !== latest) return;
          const byNode = new Map(answers.flat().map((item) => [serverEntityId(item.nodeId, connection), item] as const));
          setState({ key, byNode, failed: false });
        },
        () => { if (live && request === latest) setState((current) => ({ ...current, failed: true })); },
      );
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    window.addEventListener('focus', load);
    return () => {
      live = false;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, [enabled, key]);
  return useMemo(() => ({ byNode: state.byNode, loaded: state.key === key, failed: state.failed }), [state, key]);
}
