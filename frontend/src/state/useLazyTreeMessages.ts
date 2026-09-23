import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { buildMessagesByNode } from './chatHydration';
import { findTreeIdForNode } from './tree';
import type { ChatAction, ChatNodeState, Project } from './chatTypes';
import { sameTreeMessageNode, TreeMessageRequests } from './treeMessageRequests';

/**
 * Lazy-load the ACTIVE tree's message bodies on demand.
 *
 * Hydration loads structure + per-node counts for every workspace but message
 * bodies for only the initially-active tree. Whenever the active (project,
 * tree) changes to one whose nodes are still placeholders (`messagesLoaded ===
 * false`), this hook fetches that tree's bodies once and dispatches
 * `messages-loaded` to install them.
 *
 * Design notes:
 * - Loaded bodies stay in node state. Pending/short-lived speculative reads
 *   share a provider-scoped request pool, isolated by backend/workspace/tree.
 * - The `messages-loaded` action is NOT in NODE_ACTIVITY_ACTIONS and installs
 *   backend-authored bodies, so it never dirties the node for write-back.
 * - Best-effort: a failed fetch clears the key so a later activation retries;
 *   it never throws into render.
 * - A deferred retry (500ms) runs after the initial effect to catch cases
 *   where hydration's eager-load silently fails but marks the key as done
 *   before the nodes are installed with their true messagesLoaded state.
 */
export function useLazyTreeMessages({
  hydrated,
  activeProjectId,
  projects,
  nodesRef,
  dispatch,
  reconnectStreamingRef,
}: {
  hydrated: boolean;
  activeProjectId: string | null;
  projects: Project[];
  nodesRef: MutableRefObject<Record<string, ChatNodeState>>;
  dispatch: (action: ChatAction) => void;
  // Called with each streaming node whose checkpoint body was just installed,
  // so the foreground-replay path can reattach its live SSE stream. Stable ref
  // so this hook's effect deps stay quiet.
  reconnectStreamingRef?: MutableRefObject<(nodeId: string) => void>;
}): (nodeId: string) => void {
  const requestsRef = useRef<TreeMessageRequests | null>(null);
  if (!requestsRef.current) requestsRef.current = new TreeMessageRequests();
  const requests = requestsRef.current;
  const latest = useRef({ hydrated, projects });
  latest.current = { hydrated, projects };
  useEffect(() => () => requests.clear(), [requests]);
  const prefetchNode = useCallback((nodeId: string) => {
    if (!latest.current.hydrated) return;
    const node = nodesRef.current[nodeId];
    if (!node || node.deletedAt) return;
    const project = latest.current.projects.find((candidate) => candidate.id === node.projectId);
    if (!project) return;
    const treeId = findTreeIdForNode(nodeId, project);
    if (treeId) requests.prefetch(project, treeId, nodesRef.current);
  }, [nodesRef, requests]);
  // Keys (project::tree) already loaded or in-flight this mount.
  const loadedKeysRef = useRef<Set<string>>(new Set());

  const activeProject = activeProjectId
    ? projects.find((p) => p.id === activeProjectId) ?? null
    : null;
  const activeTreeId = activeProject?.activeTreeId ?? null;

  useEffect(() => {
    if (!hydrated || !activeProject || !activeTreeId) return;
    const projectId = activeProject.id;
    const key = `${projectId}::${activeTreeId}`;
    const loadedKeys = loadedKeysRef.current;
    let cancelled = false;
    let inFlight = false;
    const controller = new AbortController();

    const attemptLoad = () => {
      if (cancelled || inFlight) return;
      if (loadedKeys.has(key)) {
        // Already loaded or in-flight — but verify the nodes actually have
        // their messages. If not (e.g. hydration eager-load silently failed
        // but installed placeholder nodes), clear the key and retry.
        const nodes = nodesRef.current;
        const stillPlaceholder = activeProject.chatIds.some((nid) => {
          const n = nodes[nid];
          if (!n || n.messagesLoaded !== false) return false;
          return findTreeIdForNode(nid, activeProject) === activeTreeId;
        });
        if (!stillPlaceholder) return;
        loadedKeys.delete(key);
      }

      const nodes = nodesRef.current;
      const placeholderNodeIds = activeProject.chatIds.filter((nid) => {
        const n = nodes[nid];
        if (!n || n.messagesLoaded !== false) return false;
        return findTreeIdForNode(nid, activeProject) === activeTreeId;
      });
      if (placeholderNodeIds.length === 0) {
        loadedKeys.add(key);
        return;
      }
      // A streaming node with content is a live foreground turn — never install
      // a stale DB snapshot over its in-flight text. But a streaming node with
      // NO messages is a hydrated reconnect target (backend marked it streaming
      // at turn-start; meta mode left the body unloaded): load its checkpoint so
      // the pane shows progress and recover() can reattach. Empty ⇒ nothing to
      // clobber, so it is safe.
      const treeNodeIds = placeholderNodeIds.filter((nid) => {
        const n = nodes[nid];
        return !(n?.status === 'streaming' && n.messages.length > 0);
      });
      if (treeNodeIds.length === 0) return;
      const request = requests.acquire(activeProject, activeTreeId, nodes, controller.signal);
      if (!request) return;
      const startNodes = request.nodes;

      loadedKeys.add(key);
      inFlight = true;
      (async () => {
        try {
          const rows = await request.promise;
          if (cancelled) return;
          const loaded = buildMessagesByNode(rows);
          const byNode: typeof loaded = {};
          let skippedChangedNode = false;
          for (const nid of treeNodeIds) {
            const current = nodesRef.current[nid];
            if (
              !sameTreeMessageNode(startNodes.get(nid), current)
              || current?.messagesLoaded !== false
              // A node that gained content while the fetch was in flight became
              // a live turn — drop the stale snapshot. A still-empty streaming
              // node is our reconnect target; keep it. The snapshot comparison
              // catches user-send changes while ignoring only viewedAt.
              || (current.status === 'streaming' && current.messages.length > 0)
            ) {
              skippedChangedNode = true;
              continue;
            }
            byNode[nid] = loaded[nid] ?? [];
          }
          const nodeIds = Object.keys(byNode);
          if (nodeIds.length > 0) {
            dispatch({ type: 'messages-loaded', nodeIds, messagesByNode: byNode });
            // Now that a reconnect target's assistant message exists, ask the
            // foreground-replay path to reattach its live stream. dispatch
            // updates nodesRef synchronously, so status is already fresh here.
            if (reconnectStreamingRef) {
              for (const nid of nodeIds) {
                if (nodesRef.current[nid]?.status === 'streaming') reconnectStreamingRef.current(nid);
              }
            }
          }
          if (skippedChangedNode) loadedKeys.delete(key);
        } catch {
          if (!cancelled) loadedKeys.delete(key);
        } finally {
          inFlight = false;
        }
      })();
    };

    attemptLoad();

    // Deferred retry: if the initial attempt found no placeholders (because
    // hydration's eager-load appeared to succeed), re-check after a short
    // delay. This catches the race where installNodes sets messagesLoaded:true
    // on the ref but the rendered component hasn't received the update yet,
    // or where the eager-load result was silently lost.
    const retryTimer = setTimeout(() => {
      if (cancelled || inFlight) return;
      const nodes = nodesRef.current;
      const hasPlaceholders = activeProject.chatIds.some((nid) => {
        const n = nodes[nid];
        if (!n || n.messagesLoaded !== false) return false;
        return findTreeIdForNode(nid, activeProject) === activeTreeId;
      });
      if (hasPlaceholders) {
        loadedKeys.delete(key);
        attemptLoad();
      }
    }, 500);

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(retryTimer);
      loadedKeys.delete(key);
    };
  }, [hydrated, activeProject, activeTreeId, nodesRef, dispatch, reconnectStreamingRef, requests]);
  return prefetchNode;
}
