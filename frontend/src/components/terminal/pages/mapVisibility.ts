import type { Project } from '../../../state/chatTypes';

type MapNodeVisibilityState = {
  deletedAt?: number;
  kind?: 'chat' | 'digest' | 'artifact';
  mergeSources?: string[];
};

export function visibleMapNodeIds(
  project: Pick<Project, 'chatIds' | 'trees' | 'edges' | 'activeTreeId'> | null | undefined,
  nodes: Record<string, MapNodeVisibilityState | undefined>,
): string[] {
  if (!project?.activeTreeId) return [];
  const activeTree = project.trees.find((tree) => tree.id === project.activeTreeId);
  const rootNode = activeTree ? nodes[activeTree.rootNodeId] : undefined;
  if (!activeTree || activeTree.archivedAt || !rootNode || rootNode.deletedAt) return [];

  const children = new Map<string, string[]>();
  const branchParent = new Map<string, string>();
  for (const edge of project.edges) {
    if (edge.kind !== undefined && edge.kind !== 'branch' && edge.kind !== 'merge') continue;
    const next = children.get(edge.source) ?? [];
    next.push(edge.target);
    children.set(edge.source, next);
    // Track branch parents so we can walk UP from merge sources to tree roots.
    if (edge.kind === undefined || edge.kind === 'branch') {
      branchParent.set(edge.target, edge.source);
    }
  }

  // Seed the BFS with the tree root. For merge trees, also seed with the
  // merge sources and their entire ancestor chains (walk up branch edges to
  // each source's tree root) so the map shows the full context that was merged.
  const seedSet = new Set<string>([activeTree.rootNodeId]);
  if (activeTree.kind === 'merge' && rootNode.mergeSources) {
    for (const srcId of rootNode.mergeSources) {
      // Walk up from each merge source to its tree root via branch edges.
      let cur: string | undefined = srcId;
      while (cur && !seedSet.has(cur)) {
        seedSet.add(cur);
        cur = branchParent.get(cur);
      }
    }
  }

  const reachable = new Set<string>();
  const queue = [...seedSet];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    const node = nodes[id];
    if (!node || node.deletedAt || node.kind === 'digest' || node.kind === 'artifact') continue;
    reachable.add(id);
    for (const childId of children.get(id) ?? []) queue.push(childId);
  }

  return project.chatIds.filter((id) => reachable.has(id));
}
