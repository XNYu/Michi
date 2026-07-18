import { useEffect, useRef, type MutableRefObject } from 'react';
import { fetchTreeMessages } from '../services/api';
import { buildMessagesByNode } from './chatHydration';
import { findTreeIdForNode } from './tree';
import type { ChatAction, ChatNodeState, Project } from './chatTypes';

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
 * - Keyed by `${projectId}::${treeId}`. Each key is fetched at most once per
 *   mount (tracked in `loadedKeysRef`); re-activating a loaded tree is a hit.
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
}: {
  hydrated: boolean;
  activeProjectId: string | null;
  projects: Project[];
  nodesRef: MutableRefObject<Record<string, ChatNodeState>>;
  dispatch: (action: ChatAction) => void;
}): void {
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
    let cancelled = false;

    const attemptLoad = () => {
      if (cancelled) return;
      if (loadedKeysRef.current.has(key)) {
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
        loadedKeysRef.current.delete(key);
      }

      const nodes = nodesRef.current;
      const placeholderNodeIds = activeProject.chatIds.filter((nid) => {
        const n = nodes[nid];
        if (!n || n.messagesLoaded !== false) return false;
        return findTreeIdForNode(nid, activeProject) === activeTreeId;
      });
      if (placeholderNodeIds.length === 0) {
        loadedKeysRef.current.add(key);
        return;
      }
      const treeNodeIds = placeholderNodeIds.filter((nid) => nodes[nid]?.status !== 'streaming');
      if (treeNodeIds.length === 0) return;
      const startNodes = new Map(treeNodeIds.map((nid) => [nid, nodes[nid]] as const));

      loadedKeysRef.current.add(key);
      (async () => {
        try {
          const rows = await fetchTreeMessages(projectId, activeTreeId);
          if (cancelled) return;
          const byNode = buildMessagesByNode(rows);
          let skippedChangedNode = false;
          for (const nid of treeNodeIds) {
            const current = nodesRef.current[nid];
            if (
              current !== startNodes.get(nid)
              || current?.messagesLoaded !== false
              || current.status === 'streaming'
            ) {
              delete byNode[nid];
              skippedChangedNode = true;
              continue;
            }
            if (!byNode[nid]) byNode[nid] = [];
          }
          const nodeIds = Object.keys(byNode);
          if (nodeIds.length > 0) {
            dispatch({ type: 'messages-loaded', nodeIds, messagesByNode: byNode });
          }
          if (skippedChangedNode) loadedKeysRef.current.delete(key);
        } catch {
          if (!cancelled) loadedKeysRef.current.delete(key);
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
      if (cancelled) return;
      const nodes = nodesRef.current;
      const hasPlaceholders = activeProject.chatIds.some((nid) => {
        const n = nodes[nid];
        if (!n || n.messagesLoaded !== false) return false;
        return findTreeIdForNode(nid, activeProject) === activeTreeId;
      });
      if (hasPlaceholders) {
        loadedKeysRef.current.delete(key);
        attemptLoad();
      }
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      loadedKeysRef.current.delete(key);
    };
  }, [hydrated, activeProject, activeTreeId, nodesRef, dispatch]);
}
