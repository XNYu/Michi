import { useEffect, useRef } from 'react';
import { artifactWatchStreamUrl, postArtifactWatchPaths } from '../services/api';
import { fetchStream } from '../services/api/streamTransport';
import { readSseStream } from '../services/api/sseParser';

/**
 * useArtifactWatch — subscribe to a workspace's artifact-change notifications so
 * an open ArtifactPane can show a "Changed on disk · refresh" badge when its file changes
 * on disk (from any source: agent Edit/Write, an external editor, git checkout).
 *
 * This independent, persistent feed shares the gateway's WebSocket with chat
 * streams, so idle file watches do not consume HTTP request connections.
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
 *     the connection.
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

  // Latest callbacks + paths behind refs so the subscription effect depends only
  // on identity (workspaceId/enabled), not on values that change every render.
  const onChangedRef = useRef(onChanged);
  const onRemovedRef = useRef(onRemoved);
  const pathsRef = useRef(paths);
  onChangedRef.current = onChanged;
  onRemovedRef.current = onRemoved;
  pathsRef.current = paths;

  // Stable key so the declare effect fires only on a real path-set change.
  const pathsKey = paths.join('\n');

  // Subscription lifecycle: one channel per (workspaceId, enabled).
  useEffect(() => {
    if (!enabled || !workspaceId) return;
    // Preserve the test/SSR opt-out used by store tests without a watch server.
    if (typeof EventSource === 'undefined') return;
    let stopped = false;
    let controller: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const declare = () => {
      void postArtifactWatchPaths(workspaceId, pathsRef.current).catch(() => {});
    };
    const connect = async () => {
      controller = new AbortController();
      const armWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => controller?.abort(), 60_000);
      };
      try {
        armWatchdog();
        const response = await fetchStream(artifactWatchStreamUrl(workspaceId), { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('File watch unavailable');
        if (stopped) { await response.body.cancel(); return; }
        declare();
        await readSseStream(response.body.getReader(), (event, raw) => {
          try {
            const data = JSON.parse(raw) as { filePath?: string };
            if (typeof data.filePath !== 'string') return;
            if (event === 'artifact_changed') onChangedRef.current(data.filePath);
            else if (event === 'artifact_removed') onRemovedRef.current(data.filePath);
          } catch { /* malformed frame */ }
        }, { onRead: armWatchdog, shouldStop: () => stopped });
      } catch {
        // Watching is best-effort; reconnect and re-declare the complete set.
      } finally {
        clearTimeout(watchdog);
        if (!stopped) retry = setTimeout(() => void connect(), 3_000);
      }
    };
    void connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(watchdog);
      controller?.abort();
    };
  }, [workspaceId, enabled]);

  // Re-declare whenever the watched path set changes while the stream is live.
  // (The `open` handler covers the initial declare and every reconnect.)
  useEffect(() => {
    if (!enabled || !workspaceId) return;
    void postArtifactWatchPaths(workspaceId, pathsRef.current).catch(() => {});
    // pathsKey is the change signal; pathsRef.current carries the actual value.
  }, [workspaceId, enabled, pathsKey]);
}
