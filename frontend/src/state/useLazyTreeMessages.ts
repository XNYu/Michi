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
    if (loadedKeysRef.current.has(key)) return;

    // Placeholder nodes belonging to THIS tree only. chatIds spans every tree,
    // so we must scope by tree membership — otherwise other trees' placeholders
    // would be wrongly backfilled to loaded-empty below.
    const nodes = nodesRef.current;
    const treeNodeIds = activeProject.chatIds.filter((nid) => {
      const n = nodes[nid];
      if (!n || n.messagesLoaded !== false) return false;
      return findTreeIdForNode(nid, activeProject) === activeTreeId;
    });
    if (treeNodeIds.length === 0) {
      // Nothing to load (already loaded or genuinely empty) — mark done.
      loadedKeysRef.current.add(key);
      return;
    }

    loadedKeysRef.current.add(key);
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchTreeMessages(projectId, activeTreeId);
        if (cancelled) return;
        const byNode = buildMessagesByNode(rows);
        // Ensure every placeholder node in this tree flips to loaded, even ones
        // the backend returned zero rows for (genuinely-empty nodes): give them
        // an explicit empty list so messagesLoaded becomes true.
        for (const nid of treeNodeIds) {
          if (!byNode[nid]) byNode[nid] = [];
        }
        dispatch({
          type: 'messages-loaded',
          nodeIds: Object.keys(byNode),
          messagesByNode: byNode,
        });
      } catch {
        if (!cancelled) loadedKeysRef.current.delete(key); // allow retry
      }
    })();
    return () => { cancelled = true; };
  }, [hydrated, activeProject, activeTreeId, nodesRef, dispatch]);
}
