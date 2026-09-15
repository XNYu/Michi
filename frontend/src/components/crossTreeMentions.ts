import type { ChatNodeState, Project } from '../state/chatTypes';
import { chatLabel } from '../state/chatStore';
import { findTreeIdForNode } from '../state/tree';
import type { CrossTreeGroup } from './mentionItems';

/** Upper bound on cross-tree candidates so the @ popup stays scannable. */
export const CROSS_TREE_MENTION_CAP = 50;

/** Shared empty result so structural selectors can return a stable reference. */
export const EMPTY_CROSS_TREE_GROUPS: CrossTreeGroup[] = [];

/**
 * Collect @-mentionable nodes from threads OTHER than `excludeTreeId`, grouped
 * by thread and ordered by the thread's `lastActiveAt` descending. Archived
 * threads, deleted nodes, non-chat nodes and empty nodes are skipped. Total
 * candidates are capped at CROSS_TREE_MENTION_CAP.
 *
 * Pass `excludeTreeId: null` to include every thread — the Home composer has
 * no current thread, so every conversation in the workspace is "cross-tree".
 *
 * Pure: safe to call from a structural selector. Returns
 * EMPTY_CROSS_TREE_GROUPS (a stable reference) when nothing qualifies.
 */
export function collectCrossTreeGroups(
  nodesMap: Record<string, ChatNodeState>,
  project: Project,
  excludeTreeId: string | null,
): CrossTreeGroup[] {
  const groups: CrossTreeGroup[] = [];
  const otherTrees = project.trees
    .filter((t) => t.id !== excludeTreeId && !t.archivedAt)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  let totalCount = 0;
  for (const tree of otherTrees) {
    if (totalCount >= CROSS_TREE_MENTION_CAP) break;
    const treeNodes: ChatNodeState[] = [];
    for (const nid of project.chatIds) {
      if (totalCount + treeNodes.length >= CROSS_TREE_MENTION_CAP) break;
      const nd = nodesMap[nid];
      if (!nd || nd.deletedAt || nd.kind !== 'chat') continue;
      if (nd.messages.length === 0) continue;
      if (findTreeIdForNode(nid, project) !== tree.id) continue;
      treeNodes.push(nd);
    }
    if (treeNodes.length > 0) {
      const rootNode = nodesMap[tree.rootNodeId];
      const treeTitle = tree.name || rootNode?.title || chatLabel(rootNode) || `Thread ${tree.id.slice(0, 6)}`;
      groups.push({ treeTitle, nodes: treeNodes });
      totalCount += treeNodes.length;
    }
  }
  return groups.length > 0 ? groups : EMPTY_CROSS_TREE_GROUPS;
}
