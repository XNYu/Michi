import type { ChatNodeState, Project } from '../../../state/chatTypes';
import { buildBranchChildrenOf, isNodeUnread } from '../../../state/sidebarSelectors';

/** What a thread is doing right now, in the order the row's status dot cares
 *  about: a live stream outranks an unread reply. */
export type ContinueStatus = 'streaming' | 'unread' | 'idle';

export interface ContinueItem {
  /** Tree id. */
  id: string;
  projectId: string;
  projectName: string;
  rootNodeId: string;
  label: string;
  lastActiveAt: number;
  /** Live branch nodes under the thread's root (the root itself not counted). */
  branches: number;
  status: ContinueStatus;
}

/**
 * The threads Home offers to pick back up: the most recently active live
 * threads across every live workspace, newest first.
 *
 * Status and branch count are only worked out for the rows that survive the
 * cut, so a large workspace doesn't pay for threads that never render.
 */
export function buildContinueItems(
  projects: readonly Project[],
  nodes: Record<string, ChatNodeState>,
  focusedNodeId: string | null,
  limit: number,
): ContinueItem[] {
  const candidates: { project: Project; treeId: string; rootNodeId: string; name?: string; lastActiveAt: number }[] = [];
  for (const project of projects) {
    if (project.deletedAt || project.archivedAt) continue;
    for (const tree of project.trees) {
      if (tree.archivedAt) continue;
      if (nodes[tree.rootNodeId]?.deletedAt) continue;
      candidates.push({
        project,
        treeId: tree.id,
        rootNodeId: tree.rootNodeId,
        name: tree.name,
        lastActiveAt: tree.lastActiveAt,
      });
    }
  }
  candidates.sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  const childrenByProject = new Map<string, ReadonlyMap<string, readonly string[]>>();
  return candidates.slice(0, limit).map((c) => {
    let childrenOf = childrenByProject.get(c.project.id);
    if (!childrenOf) {
      childrenOf = buildBranchChildrenOf(c.project.edges);
      childrenByProject.set(c.project.id, childrenOf);
    }

    // One walk over the thread's live subtree yields all three facts.
    let branches = 0;
    let streaming = false;
    let unread = false;
    const seen = new Set<string>();
    const stack = [c.rootNodeId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const node = nodes[id];
      if (node?.deletedAt) continue;
      if (id !== c.rootNodeId) branches++;
      if (node) {
        if (node.status === 'streaming') streaming = true;
        if (isNodeUnread(node, focusedNodeId)) unread = true;
      }
      for (const child of childrenOf.get(id) ?? []) stack.push(child);
    }

    return {
      id: c.treeId,
      projectId: c.project.id,
      projectName: c.project.name,
      rootNodeId: c.rootNodeId,
      label: c.name || nodes[c.rootNodeId]?.title || 'Untitled',
      lastActiveAt: c.lastActiveAt,
      branches,
      status: streaming ? 'streaming' : unread ? 'unread' : 'idle',
    };
  });
}

export function continueItemsEqual(a: readonly ContinueItem[], b: readonly ContinueItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id
      || x.projectId !== y.projectId
      || x.projectName !== y.projectName
      || x.rootNodeId !== y.rootNodeId
      || x.label !== y.label
      || x.lastActiveAt !== y.lastActiveAt
      || x.branches !== y.branches
      || x.status !== y.status
    ) return false;
  }
  return true;
}
