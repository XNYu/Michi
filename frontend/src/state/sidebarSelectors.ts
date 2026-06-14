import type { Prefs } from './prefs';
import type { Tree, ChatNodeState, ProjectEdge, Project } from './chatTypes';


type ExpandedMaps = Prefs['sidebarExpanded'];

/** Explicit user toggle wins; otherwise the active workspace defaults open. */
export function isWorkspaceExpanded(
  expanded: ExpandedMaps,
  projectId: string,
  activeProjectId: string | null,
): boolean {
  const explicit = expanded.workspaces[projectId];
  if (explicit !== undefined) return explicit;
  return projectId === activeProjectId;
}

/** Explicit user toggle wins; otherwise the active thread defaults open.
 *  Switching the active tree should not collapse the previous one — callers
 *  are expected to persist `threads[prevActiveId] = true` at the activation
 *  site so the previously-active row keeps its open state. */
export function isThreadExpanded(
  expanded: ExpandedMaps,
  treeId: string,
  activeTreeId: string | null,
): boolean {
  const explicit = expanded.threads[treeId];
  if (explicit !== undefined) return explicit;
  return treeId === activeTreeId;
}

/** Branches default to collapsed; an explicit user toggle in
 *  `sidebarExpanded.branches` overrides. */
export function isBranchExpanded(
  expanded: ExpandedMaps,
  branchNodeId: string,
): boolean {
  return expanded.branches[branchNodeId] ?? false;
}

/** Render order: pinned live trees first (most recently pinned first), then
 *  remaining live trees by recent activity (`lastActiveAt` DESC), then
 *  archived trees at the end (also recent activity first among themselves).
 *  Active tree is NOT pulled to the top. */
export function sortTrees(trees: readonly Tree[], _activeTreeId: string | null): Tree[] {
  const recency = (t: Tree) => t.lastActiveAt ?? t.createdAt ?? 0;
  const byRecentDesc = (a: Tree, b: Tree) =>
    recency(b) - recency(a) || (b.createdAt ?? 0) - (a.createdAt ?? 0);
  const byPinnedDesc = (a: Tree, b: Tree) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
  const live = trees.filter((t) => !t.archivedAt);
  const pinned = live
    .filter((t) => !!t.pinnedAt)
    .slice()
    .sort((a, b) => byPinnedDesc(a, b) || byRecentDesc(a, b));
  const unpinned = live.filter((t) => !t.pinnedAt).slice().sort(byRecentDesc);
  const archived = trees.filter((t) => !!t.archivedAt).slice().sort(byRecentDesc);
  return [...pinned, ...unpinned, ...archived];
}

export type OpenState = 'none' | 'idle' | 'streaming';

const RANK: Record<OpenState, number> = { none: 0, idle: 1, streaming: 2 };
const RANK_TO_STATE: OpenState[] = ['none', 'idle', 'streaming'];

/**
 * Per-node contribution to the sidebar indicator.
 *
 * - 'streaming' — status === 'streaming', regardless of open panes, focus,
 *   or which workspace/thread is currently active. A running turn stays
 *   visible in the sidebar even after you navigate to a different thread or
 *   workspace (where the node is no longer one of the active slot's panes).
 * - 'idle' — open in the active slot's panes, unfocused, non-streaming
 *   (a background pane you have open in the current view).
 * - 'none' — not streaming, and either not an open pane or the focused pane
 *   (the focused-row highlight already conveys it). 'error' falls here when
 *   unopened; the pane caption surfaces error state, not the sidebar bar.
 */
export function nodeOpenState(
  nodeId: string,
  openPanes: readonly string[],
  focusedPane: string | null,
  status: ChatNodeState['status'],
): OpenState {
  // Streaming surfaces globally — independent of open panes, focus, and the
  // active workspace/thread slot. Navigating away must not hide a running turn.
  if (status === 'streaming') return 'streaming';
  if (!openPanes.includes(nodeId)) return 'none';
  // Idle is suppressed on the focused row (its highlight already conveys it).
  if (nodeId === focusedPane) return 'none';
  return 'idle';
}

/**
 * Roll up `perNode` over the subtree rooted at `rootNodeId`. Dead nodes
 * (per `isAlive`) are skipped along with their entire subtree. Aggregator
 * is max under `streaming > idle > none`, so any streaming descendant
 * dominates.
 */
export function subtreeOpenState(
  rootNodeId: string,
  edges: readonly ProjectEdge[],
  isAlive: (nodeId: string) => boolean,
  perNode: (nodeId: string) => OpenState,
): OpenState {
  if (!isAlive(rootNodeId)) return 'none';

  // Adjacency: parent -> children, only following 'branch' edges (digest /
  // merge edges live on the same nodes table but are not part of the
  // hierarchical tree the sidebar renders).
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    const isBranchEdge = e.kind === 'branch' || e.kind === undefined;
    if (!isBranchEdge) continue;
    const arr = childrenOf.get(e.source) ?? [];
    arr.push(e.target);
    childrenOf.set(e.source, arr);
  }

  let bestRank = RANK[perNode(rootNodeId)];
  const stack = [rootNodeId];
  const seen = new Set<string>([rootNodeId]);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const child of childrenOf.get(cur) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      if (!isAlive(child)) continue;
      const r = RANK[perNode(child)];
      if (r > bestRank) bestRank = r;
      if (bestRank === 2) return 'streaming'; // short-circuit on max
      stack.push(child);
    }
  }
  return RANK_TO_STATE[bestRank];
}

/**
 * Sort live workspaces (not deleted, not archived) for the sidebar.
 *
 * Layout: projects not in `workspaceOrder` render first, sorted by
 * `createdAt` DESC (newest at top — so any freshly-created workspace
 * floats above the explicit drag-saved order). Projects present in
 * `workspaceOrder` render after, in the user's explicit drag order.
 * Stale IDs in `workspaceOrder` (referencing a deleted/archived/unknown
 * project) are ignored at sort time so the caller doesn't have to prune
 * them eagerly.
 */
export function sortLiveProjects(
  projects: readonly Project[],
  workspaceOrder: readonly string[],
): Project[] {
  const live = projects.filter((p) => !p.deletedAt && !p.archivedAt);
  const orderIndex = new Map<string, number>();
  workspaceOrder.forEach((id, i) => orderIndex.set(id, i));
  const unknown = live
    .filter((p) => !orderIndex.has(p.id))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const known = live
    .filter((p) => orderIndex.has(p.id))
    .sort((a, b) => orderIndex.get(a.id)! - orderIndex.get(b.id)!);
  return [...unknown, ...known];
}

export interface MergeReferenceGroup {
  mergeNodeId: string;
  sources: string[];
}

/**
 * One group per merge node in the project, newest-first by chatIds insertion
 * order. `sources` is the merge node's mergeSources array in original order.
 */
export function mergeReferences(
  project: Project,
  nodes: Readonly<Record<string, ChatNodeState>>,
): MergeReferenceGroup[] {
  const groups: MergeReferenceGroup[] = [];
  for (let i = project.chatIds.length - 1; i >= 0; i--) {
    const id = project.chatIds[i];
    const n = nodes[id];
    if (!n || !n.mergeSources || n.mergeSources.length === 0) continue;
    groups.push({ mergeNodeId: id, sources: [...n.mergeSources] });
  }
  return groups;
}

/**
 * A node is unread iff its last assistant `done` is newer than the user's last
 * view. Focused node is treated as read (the focused-pane highlight already
 * tells the user "you are looking at this"; flashing unread on it is noise).
 * Digest nodes have their own unread model (see digest.ts) and are excluded.
 */
export function isNodeUnread(
  node: ChatNodeState,
  focusedNodeId: string | null,
): boolean {
  if (node.kind === 'digest') return false;
  if (focusedNodeId !== null && node.nodeId === focusedNodeId) return false;
  const last = node.lastAssistantAt ?? 0;
  const seen = node.viewedAt ?? 0;
  return last > seen;
}

export function selectUnreadTotal(
  nodes: Record<string, ChatNodeState>,
  focusedNodeId: string | null,
): number {
  let count = 0;
  for (const id in nodes) if (isNodeUnread(nodes[id], focusedNodeId)) count++;
  return count;
}

/**
 * True iff any node in the subtree rooted at `tree.rootNodeId` (traversed via
 * branch edges) is unread. Mirrors the pattern used by `subtreeOpenState`.
 */
export function treeHasUnread(
  tree: Tree,
  edges: readonly ProjectEdge[],
  nodes: Record<string, ChatNodeState>,
  focusedNodeId: string | null,
): boolean {
  const root = nodes[tree.rootNodeId];
  if (root && isNodeUnread(root, focusedNodeId)) return true;
  // Build children map from branch edges only
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    const isBranch = e.kind === 'branch' || e.kind === undefined;
    if (!isBranch) continue;
    const arr = childrenOf.get(e.source) ?? [];
    arr.push(e.target);
    childrenOf.set(e.source, arr);
  }
  const stack = [...(childrenOf.get(tree.rootNodeId) ?? [])];
  const seen = new Set<string>([tree.rootNodeId]);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes[id];
    if (node && isNodeUnread(node, focusedNodeId)) return true;
    for (const child of childrenOf.get(id) ?? []) stack.push(child);
  }
  return false;
}

export function workspaceHasUnread(
  project: Project,
  nodes: Record<string, ChatNodeState>,
  focusedNodeId: string | null,
): boolean {
  for (const id of project.chatIds ?? []) {
    const node = nodes[id];
    if (node && isNodeUnread(node, focusedNodeId)) return true;
  }
  return false;
}
