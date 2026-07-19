import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { descendants } from './tree';
import type { ChatNodeState, Project, TrimSnapshot } from './chatTypes';
import {
  emptyWorkspaceTrash as apiEmptyWorkspaceTrash,
  purgeWorkspaceNodes as apiPurgeWorkspaceNodes,
} from '../services/api';

type PaneUpdater<T> = T | ((prev: T) => T);
type PaneSetter<T> = (updater: PaneUpdater<T>) => void;

/**
 * Prefix on a node's `deletionGroupId` marking it as *archived* rather than
 * trashed. Archive reuses the entire single-node trim engine (soft-remove +
 * reparent children up + `trimSnapshot`-driven restore); the only difference
 * is this prefix, which routes the node to the Archived surface instead of
 * Trash and exempts it from trash-only flows (TTL sweep, empty-trash, ⌘Z).
 */
export const ARCHIVE_GID_PREFIX = 'arch-';

/** True iff a deletion group id belongs to the archived lane (vs trash). */
export function isArchiveGroupId(gid: string | null | undefined): boolean {
  return !!gid && gid.startsWith(ARCHIVE_GID_PREFIX);
}

interface UseTrashActionsArgs {
  projects: Project[];
  nodesRef: MutableRefObject<Record<string, ChatNodeState>>;
  cancelFns: MutableRefObject<Record<string, () => void>>;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setNodes: Dispatch<SetStateAction<Record<string, ChatNodeState>>>;
  setOpenPanes: PaneSetter<string[]>;
  setFocusedPane: PaneSetter<string | null>;
  setFocusedNodeId: Dispatch<SetStateAction<string | null>>;
  setSelection: Dispatch<SetStateAction<ReadonlySet<string>>>;
  trashTTLDays: number;
  activeTreeRootNodeId: (project: Project | null | undefined) => string | null;
  /** See chatStore.tsx for semantics. Optional so tests can mount without it. */
  syncPausedRef?: MutableRefObject<boolean>;
  /** Bump the structure version so useStructuralSelector consumers re-compute. */
  bumpStructureVersion?: () => void;
}

export function useTrashActions({
  projects,
  nodesRef,
  cancelFns,
  setProjects,
  setNodes,
  setOpenPanes,
  setFocusedPane,
  setFocusedNodeId,
  setSelection,
  trashTTLDays,
  activeTreeRootNodeId,
  syncPausedRef,
  bumpStructureVersion,
}: UseTrashActionsArgs) {
  const deleteNode = useCallback((nodeId: string) => {
    const project = projects.find((p) => p.chatIds.includes(nodeId));
    if (!project) return;
    const rootOfActive = activeTreeRootNodeId(project);
    if (rootOfActive === nodeId) return;
    if (project.trees.some((t) => t.rootNodeId === nodeId)) return;

    const live = project.edges.filter(
      (e) => !nodesRef.current[e.source]?.deletedAt && !nodesRef.current[e.target]?.deletedAt,
    );
    const dead = descendants(nodeId, live);
    dead.add(nodeId);

    dead.forEach((id) => {
      cancelFns.current[id]?.();
    });

    const gid = `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const at = Date.now();
    const next = { ...nodesRef.current };
    dead.forEach((id) => {
      const cur = next[id];
      if (!cur) return;
      next[id] = { ...cur, deletedAt: at, deletionGroupId: gid };
    });
    nodesRef.current = next;
    setNodes(next);
    bumpStructureVersion?.();

    setProjects((prev) =>
      prev.map((p) => (p.id === project.id ? { ...p } : p)),
    );
    setOpenPanes((prev) => prev.filter((id) => !dead.has(id)));
    setFocusedPane((cur) => (cur && dead.has(cur) ? null : cur));
    setFocusedNodeId((cur) => (cur && dead.has(cur) ? null : cur));
    setSelection((prev) => {
      if (!Array.from(dead).some((id) => prev.has(id))) return prev;
      const nextSelection = new Set(prev);
      dead.forEach((id) => nextSelection.delete(id));
      return nextSelection;
    });
  }, [
    activeTreeRootNodeId,
    bumpStructureVersion,
    cancelFns,
    nodesRef,
    projects,
    setFocusedNodeId,
    setFocusedPane,
    setNodes,
    setOpenPanes,
    setProjects,
    setSelection,
  ]);

  /**
   * Single-node trim: send `nodeId` to trash while keeping its descendants
   * live by reparenting them up. Mirrors the SQL algorithm in
   * `dbRepository.trimNode` so the next persistence sync upserts a state the
   * backend would have computed itself. The 2-second sync interval is
   * sufficient — trim is non-destructive (only flips `deletedAt`); a stale
   * snapshot revival window can't lose data.
   *
   * Tree-root case (Option A): the oldest live child is promoted to new root
   * and the rest of the children become siblings under it. The tree's
   * `rootNodeId` is updated in the same setProjects call.
   *
   * No-op when the node is unknown or already trashed (idempotent).
   *
   * `gidPrefix` decides the lane: `'trim'` → Trash, `'arch'` → Archived. Both
   * lanes share this exact algorithm; see `ARCHIVE_GID_PREFIX`.
   */
  const pruneNode = useCallback((nodeId: string, gidPrefix: 'trim' | 'arch') => {
    const project = projects.find((p) => p.chatIds.includes(nodeId));
    if (!project) return;
    const x = nodesRef.current[nodeId];
    if (!x || x.deletedAt) return;

    cancelFns.current[nodeId]?.();

    const childrenIds = Object.values(nodesRef.current)
      .filter((n) => n.parentNodeId === nodeId && n.nodeId !== nodeId)
      .map((n) => n.nodeId);

    const treeOfRoot = project.trees.find((t) => t.rootNodeId === nodeId) ?? null;
    const wasTreeRoot: TrimSnapshot['wasTreeRoot'] = treeOfRoot
      ? { treeId: treeOfRoot.id }
      : null;

    const snapshot: TrimSnapshot = {
      parentId: x.parentNodeId ?? null,
      childrenIds,
      wasTreeRoot,
    };

    const gid = `${gidPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const at = Date.now();

    // Resolve the new parent for the children.
    let newParent: string | null;
    let newRoot: string | null = null;     // For tree-root case
    let otherChildren: string[] = [];       // children that go under newRoot in tree-root case
    if (wasTreeRoot) {
      // Pick the oldest LIVE child by createdAt-ish proxy (first in chatIds
      // order — chatIds is creation order, which the existing project layer
      // treats as the truth-source for "oldest first").
      const orderedChatIds = project.chatIds;
      const liveChildrenInOrder = orderedChatIds.filter((id) => {
        const n = nodesRef.current[id];
        return n && childrenIds.includes(id) && !n.deletedAt;
      });
      newRoot = liveChildrenInOrder[0] ?? null;
      newParent = newRoot;          // Each non-root child is parented to newRoot
      otherChildren = childrenIds.filter((id) => id !== newRoot);
    } else {
      newParent = x.parentNodeId ?? null;
    }

    // Update nodes map: stamp X with snapshot + trash markers, reparent
    // children. For tree-root case the promoted newRoot's parentNodeId
    // becomes undefined.
    const nextNodes = { ...nodesRef.current };
    nextNodes[nodeId] = {
      ...x,
      deletedAt: at,
      deletionGroupId: gid,
      trimSnapshot: snapshot,
    };
    if (wasTreeRoot && newRoot) {
      const r = nextNodes[newRoot];
      if (r) {
        nextNodes[newRoot] = { ...r, parentNodeId: undefined };
      }
      for (const cid of otherChildren) {
        const c = nextNodes[cid];
        if (c) nextNodes[cid] = { ...c, parentNodeId: newRoot };
      }
    } else {
      for (const cid of childrenIds) {
        const c = nextNodes[cid];
        if (c) nextNodes[cid] = { ...c, parentNodeId: newParent ?? undefined };
      }
    }
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
    bumpStructureVersion?.();

    // Update project: rewire branch edges (drop X's edges, add bypass edges
    // from newParent to each surviving child). Tree.rootNodeId update for
    // tree-root case.
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== project.id) return p;

        // Drop branch edges touching the trimmed node, keep cross-tree edges
        // (merge / link / digest-source) untouched — those are user-managed.
        const survivingEdges = p.edges.filter(
          (e) => !(e.kind === undefined || e.kind === 'branch') ||
                 (e.source !== nodeId && e.target !== nodeId),
        );

        const ensureEdge = (source: string, target: string) => {
          if (survivingEdges.some(
            (e) => e.source === source && e.target === target &&
              (e.kind === undefined || e.kind === 'branch'),
          )) return;
          survivingEdges.push({ source, target, kind: 'branch' });
        };

        if (wasTreeRoot && newRoot) {
          for (const oid of otherChildren) ensureEdge(newRoot, oid);
        } else if (newParent) {
          for (const cid of childrenIds) ensureEdge(newParent, cid);
        }

        let nextTrees = p.trees;
        let nextActive = p.activeTreeId;
        if (wasTreeRoot && treeOfRoot) {
          if (newRoot) {
            nextTrees = p.trees.map((t) =>
              t.id === treeOfRoot.id ? { ...t, rootNodeId: newRoot } : t,
            );
          } else {
            // No live child to promote — drop the tree row.
            nextTrees = p.trees.filter((t) => t.id !== treeOfRoot.id);
            if (p.activeTreeId === treeOfRoot.id) {
              const fallback = nextTrees
                .filter((t) => !t.archivedAt)
                .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
              nextActive = fallback ? fallback.id : null;
            }
          }
        }

        return { ...p, edges: survivingEdges, trees: nextTrees, activeTreeId: nextActive };
      }),
    );

    // Pane / focus / selection cleanup — same as deleteNode but only for X.
    setOpenPanes((prev) => prev.filter((id) => id !== nodeId));
    setFocusedPane((cur) => (cur === nodeId ? null : cur));
    setFocusedNodeId((cur) => (cur === nodeId ? null : cur));
    setSelection((prev) => {
      if (!prev.has(nodeId)) return prev;
      const nextSel = new Set(prev);
      nextSel.delete(nodeId);
      return nextSel;
    });
  }, [
    bumpStructureVersion,
    cancelFns,
    nodesRef,
    projects,
    setFocusedNodeId,
    setFocusedPane,
    setNodes,
    setOpenPanes,
    setProjects,
    setSelection,
  ]);

  /** Send a single node to Trash, reparenting its children up. */
  const trimNode = useCallback((nodeId: string) => pruneNode(nodeId, 'trim'), [pruneNode]);

  /**
   * Archive a single node. Identical mechanics to {@link trimNode} (children
   * reparent up, restorable via the trimSnapshot) but routed to the Archived
   * surface and exempt from trash-only purge flows.
   */
  const archiveNode = useCallback((nodeId: string) => pruneNode(nodeId, 'arch'), [pruneNode]);

  /**
   * Reverse a single-node trim using the trimSnapshot stored on the node.
   * Walk up the snapshot's parent chain until hitting a live ancestor (or
   * null = becomes a tree root). Re-steal any snapshot child that's still
   * live AND still parented to the resolved target parent. Re-seat the
   * tree root pointer if the trimmed node was a tree root. Mirrors
   * dbRepository.restoreTrimmedNode().
   *
   * Returns the restored nodeId on success.
   */
  const restoreFromTrimSnapshot = useCallback((nodeId: string): string | null => {
    const x = nodesRef.current[nodeId];
    if (!x?.trimSnapshot) return null;
    const snap = x.trimSnapshot;
    const project = projects.find((p) => p.chatIds.includes(nodeId));
    if (!project) return null;

    // Walk-up resolver: find nearest live ancestor.
    let target: string | null = snap.parentId;
    const seen = new Set<string>();
    while (target) {
      if (seen.has(target)) { target = null; break; }
      seen.add(target);
      const a = nodesRef.current[target];
      if (!a) { target = null; break; }
      if (!a.deletedAt) break;
      // Ancestor is also trashed: prefer its trimSnapshot.parentId for the
      // conceptual chain; fall back to its current parentNodeId for
      // subtree-deleted ancestors.
      target = a.trimSnapshot ? a.trimSnapshot.parentId : (a.parentNodeId ?? null);
    }

    const stolen: string[] = [];
    for (const cid of snap.childrenIds) {
      const c = nodesRef.current[cid];
      if (!c || c.deletedAt) continue;
      if ((c.parentNodeId ?? null) !== target) continue;
      stolen.push(cid);
    }

    const nextNodes = { ...nodesRef.current };
    {
      const cur = nextNodes[nodeId];
      if (cur) {
        const { deletedAt, deletionGroupId, trimSnapshot, ...rest } = cur;
        nextNodes[nodeId] = { ...(rest as ChatNodeState), parentNodeId: target ?? undefined };
      }
    }
    for (const cid of stolen) {
      const c = nextNodes[cid];
      if (c) nextNodes[cid] = { ...c, parentNodeId: nodeId };
    }
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
    bumpStructureVersion?.();

    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== project.id) return p;
        // Drop the bypass edge target→stolen and re-add target→nodeId,
        // nodeId→stolen.
        const filtered = p.edges.filter((e) => {
          if (e.kind && e.kind !== 'branch') return true;
          if (target && e.source === target && stolen.includes(e.target)) return false;
          return true;
        });
        const ensureEdge = (source: string, t: string) => {
          if (filtered.some(
            (e) => e.source === source && e.target === t &&
              (e.kind === undefined || e.kind === 'branch'),
          )) return;
          filtered.push({ source, target: t, kind: 'branch' });
        };
        if (target) ensureEdge(target, nodeId);
        for (const cid of stolen) ensureEdge(nodeId, cid);

        // Tree root re-seat / recreate.
        let nextTrees = p.trees;
        let nextActive = p.activeTreeId;
        if (snap.wasTreeRoot) {
          const tid = snap.wasTreeRoot.treeId;
          if (p.trees.some((t) => t.id === tid)) {
            nextTrees = p.trees.map((t) => t.id === tid ? { ...t, rootNodeId: nodeId } : t);
          } else {
            const now = Date.now();
            nextTrees = [
              ...p.trees,
              { id: tid, rootNodeId: nodeId, createdAt: now, lastActiveAt: now },
            ];
            if (!p.activeTreeId) nextActive = tid;
          }
        }
        return { ...p, edges: filtered, trees: nextTrees, activeTreeId: nextActive };
      }),
    );
    return nodeId;
  }, [bumpStructureVersion, nodesRef, projects, setNodes, setProjects]);

  const restoreDeletion = useCallback((groupId: string): string | null => {
    const ids: string[] = [];
    for (const [id, n] of Object.entries(nodesRef.current)) {
      if (n.deletionGroupId === groupId) ids.push(id);
    }
    if (ids.length === 0) return null;

    // Trim case: there is exactly one node in the group AND it carries a
    // trimSnapshot. Use the snapshot-driven restore (walk-up + re-steal +
    // tree pointer) instead of the subtree-restore path.
    if (ids.length === 1 && nodesRef.current[ids[0]]?.trimSnapshot) {
      return restoreFromTrimSnapshot(ids[0]);
    }

    const deletedSet = new Set(ids);
    let root: string | null = null;
    for (const id of ids) {
      const parent = nodesRef.current[id]?.parentNodeId;
      if (!parent || !deletedSet.has(parent)) {
        root = id;
        break;
      }
    }

    const next = { ...nodesRef.current };
    for (const id of ids) {
      const cur = next[id];
      if (!cur) continue;
      const { deletedAt, deletionGroupId, ...rest } = cur;
      next[id] = rest as ChatNodeState;
    }
    nodesRef.current = next;
    setNodes(next);
    bumpStructureVersion?.();

    setProjects((prev) =>
      prev.map((p) => (ids.some((id) => p.chatIds.includes(id)) ? { ...p } : p)),
    );
    return root;
  }, [bumpStructureVersion, nodesRef, restoreFromTrimSnapshot, setNodes, setProjects]);

  const purgeDeletion = useCallback((groupId: string) => {
    const ids = new Set<string>();
    for (const [id, n] of Object.entries(nodesRef.current)) {
      if (n.deletionGroupId === groupId) ids.add(id);
    }
    if (ids.size === 0) return;

    setProjects((prev) =>
      prev.map((p) => {
        if (!p.chatIds.some((id) => ids.has(id))) return p;
        const survivingTrees = p.trees.filter((t) => !ids.has(t.rootNodeId));
        let nextActive = p.activeTreeId;
        if (p.activeTreeId != null && !survivingTrees.some((t) => t.id === p.activeTreeId)) {
          const fallback = [...survivingTrees]
            .filter((t) => !t.archivedAt)
            .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
          nextActive = fallback ? fallback.id : null;
        }
        return {
          ...p,
          chatIds: p.chatIds.filter((id) => !ids.has(id)),
          edges: p.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
          trees: survivingTrees,
          activeTreeId: nextActive,
        };
      }),
    );
    const next = { ...nodesRef.current };
    ids.forEach((id) => delete next[id]);
    nodesRef.current = next;
    setNodes(next);
    bumpStructureVersion?.();
  }, [bumpStructureVersion, nodesRef, setNodes, setProjects]);

  const restoreLastDeletion = useCallback((): string | null => {
    const gidToAt = new Map<string, number>();
    for (const n of Object.values(nodesRef.current)) {
      if (!n.deletionGroupId || !n.deletedAt) continue;
      if (isArchiveGroupId(n.deletionGroupId)) continue; // ⌘Z is trash-only
      const cur = gidToAt.get(n.deletionGroupId);
      if (cur === undefined || n.deletedAt > cur) gidToAt.set(n.deletionGroupId, n.deletedAt);
    }
    let newest: string | null = null;
    let newestAt = -Infinity;
    gidToAt.forEach((at, g) => {
      if (at > newestAt) {
        newest = g;
        newestAt = at;
      }
    });
    if (!newest) return null;
    return restoreDeletion(newest);
  }, [nodesRef, restoreDeletion]);

  const emptyTrash = useCallback(() => {
    const gids = new Set<string>();
    for (const n of Object.values(nodesRef.current)) {
      if (n.deletionGroupId && !isArchiveGroupId(n.deletionGroupId)) gids.add(n.deletionGroupId);
    }
    gids.forEach((g) => purgeDeletion(g));
  }, [nodesRef, purgeDeletion]);

  /**
   * Permanently purge a single deletion group, awaiting backend
   * confirmation before clearing local state. Resolves with the count of
   * rows the backend physically removed. Throws if the backend rejects so
   * the caller can keep the local trash entry visible and surface an error.
   *
   * The persistence interval is paused for the duration so an in-flight
   * pre-purge POST /sync cannot revive the rows by re-inserting them.
   */
  const purgeDeletionAsync = useCallback(
    async (groupId: string): Promise<{ purged: number }> => {
      const nodesById = nodesRef.current;
      const ids: string[] = [];
      let projectId: string | undefined;
      for (const [id, n] of Object.entries(nodesById)) {
        if (n.deletionGroupId !== groupId) continue;
        ids.push(id);
        if (!projectId) projectId = n.projectId;
      }
      if (ids.length === 0 || !projectId) return { purged: 0 };

      if (syncPausedRef) syncPausedRef.current = true;
      try {
        const res = await apiPurgeWorkspaceNodes(projectId, ids);
        purgeDeletion(groupId);
        return { purged: res.purged ?? 0 };
      } finally {
        if (syncPausedRef) syncPausedRef.current = false;
      }
    },
    [nodesRef, purgeDeletion, syncPausedRef],
  );

  /**
   * Permanently purge every deletion group across every workspace,
   * awaiting backend confirmation before clearing local state. Calls one
   * `/trash/empty` endpoint per workspace in parallel. Resolves with the
   * aggregated row count; throws on the first backend failure so callers
   * can decide whether to retry. Local state is only cleared on success.
   */
  const emptyTrashAsync = useCallback(
    async (): Promise<{ purged: number }> => {
      const workspaceIds = new Set<string>();
      for (const n of Object.values(nodesRef.current)) {
        if (n.deletionGroupId && !isArchiveGroupId(n.deletionGroupId)) workspaceIds.add(n.projectId);
      }
      if (workspaceIds.size === 0) return { purged: 0 };

      if (syncPausedRef) syncPausedRef.current = true;
      try {
        const results = await Promise.all(
          Array.from(workspaceIds).map((id) => apiEmptyWorkspaceTrash(id)),
        );
        const total = results.reduce((s, r) => s + (r.purged ?? 0), 0);
        emptyTrash();
        return { purged: total };
      } finally {
        if (syncPausedRef) syncPausedRef.current = false;
      }
    },
    [nodesRef, emptyTrash, syncPausedRef],
  );

  useEffect(() => {
    const sweep = () => {
      if (!trashTTLDays || trashTTLDays <= 0) return;
      const cutoff = Date.now() - trashTTLDays * 86400000;
      const gidToOldest = new Map<string, number>();
      for (const n of Object.values(nodesRef.current)) {
        if (!n.deletionGroupId || !n.deletedAt) continue;
        if (isArchiveGroupId(n.deletionGroupId)) continue; // archived lane never auto-purges
        const cur = gidToOldest.get(n.deletionGroupId);
        if (cur === undefined || n.deletedAt < cur) {
          gidToOldest.set(n.deletionGroupId, n.deletedAt);
        }
      }
      gidToOldest.forEach((at, gid) => {
        if (at < cutoff) purgeDeletion(gid);
      });
    };
    sweep();
    const handle = setInterval(sweep, 3600_000);
    return () => clearInterval(handle);
  }, [nodesRef, purgeDeletion, trashTTLDays]);

  return {
    deleteNode,
    trimNode,
    archiveNode,
    restoreDeletion,
    purgeDeletion,
    purgeDeletionAsync,
    restoreLastDeletion,
    emptyTrash,
    emptyTrashAsync,
  };
}
