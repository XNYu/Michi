import { useEffect, useRef } from 'react';
import { artifactWatchStreamUrl, postArtifactWatchPaths } from '../services/api';

/**
 * useArtifactWatch — subscribe to a workspace's artifact-change notifications so
 * an open ArtifactPane can show a "Changed on disk · refresh" badge when its file changes
 * on disk (from any source: agent Edit/Write, an external editor, git checkout).
 *
 * This is the app's only `EventSource`: the per-turn chat SSE streams are closed
 * when idle and can't deliver a notification between turns. This channel is
 * independent and persistent, using EventSource's built-in auto-reconnect.
 *
 * Contract:
 *   - `paths` is the set of stored artifact paths to watch (relative `.contexts/`
 *     paths or cwd-relative symlink paths). Absolute paths outside the cwd are
 *     dropped server-side by the sandbox — harmless to include.
 *   - On stream `open` and whenever `paths` change, we (re)declare the watch set.
 *     Declaring is idempotent and preserves the server's last-known baseline, so
 *     re-declaring never drops a change.
 *   - `onChanged` / `onRemoved` receive the STORED filePath (byte-matching what a
 *     pane holds in `n.artifact.filePath`), so the caller can string-match open
 *     artifact nodes. They are read through refs, so updating them never churns
 *     the EventSource.
 *
 * `enabled` should be false for cwd-less workspaces or when there is nothing to
 * watch — the hook then opens no connection.
 */
export function useArtifactWatch(opts: {
  workspaceId: string | undefined;
  enabled: boolean;
  paths: string[];
  onChanged: (filePath: string) => void;
  onRemoved: (filePath: string) => void;
}): void {
  const { workspaceId, enabled, paths, onChanged, onRemoved } = opts;

  // Latest callbacks + paths behind refs so the EventSource effect depends only
  // on identity (workspaceId/enabled), not on values that change every render.
  const onChangedRef = useRef(onChanged);
  const onRemovedRef = useRef(onRemoved);
  const pathsRef = useRef(paths);
  onChangedRef.current = onChanged;
  onRemovedRef.current = onRemoved;
  pathsRef.current = paths;

  // Stable key so the declare effect fires only on a real path-set change.
  const pathsKey = paths.join('\n');

  // EventSource lifecycle — one connection per (workspaceId, enabled).
  useEffect(() => {
    if (!enabled || !workspaceId) return;
    // No EventSource outside a browser (jsdom unit tests, SSR): skip the watch
    // rather than throw. Real browsers and the Playwright runtime always have it.
    if (typeof EventSource === 'undefined') return;

    const es = new EventSource(artifactWatchStreamUrl(workspaceId));

    const declare = () => {
      void postArtifactWatchPaths(workspaceId, pathsRef.current).catch(() => {
        // Best-effort: a failed declare just means no badge until the next
        // successful declare (stream open / path change). Not user-facing.
      });
    };

    // Re-declare on every (re)connect: an auto-reconnect rebuilds a fresh
    // server-side watcher entry that must be repopulated with our path set.
    es.addEventListener('open', declare);

    es.addEventListener('artifact_changed', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { filePath?: string };
        if (typeof data.filePath === 'string') onChangedRef.current(data.filePath);
      } catch {
        /* malformed frame — ignore */
      }
    });

    es.addEventListener('artifact_removed', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { filePath?: string };
        if (typeof data.filePath === 'string') onRemovedRef.current(data.filePath);
      } catch {
        /* malformed frame — ignore */
      }
    });

    return () => {
      es.close();
    };
  }, [workspaceId, enabled]);

  // Re-declare whenever the watched path set changes while the stream is live.
  // (The `open` handler covers the initial declare and every reconnect.)
  useEffect(() => {
    if (!enabled || !workspaceId) return;
    void postArtifactWatchPaths(workspaceId, pathsRef.current).catch(() => {});
    // pathsKey is the change signal; pathsRef.current carries the actual value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, enabled, pathsKey]);
}
