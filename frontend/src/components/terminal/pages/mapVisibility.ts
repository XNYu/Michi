import type { Project } from '../../../state/chatTypes';

type MapNodeVisibilityState = {
  deletedAt?: number;
  kind?: 'chat' | 'digest' | 'artifact';
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
  for (const edge of project.edges) {
    if (edge.kind !== undefined && edge.kind !== 'branch') continue;
    const next = children.get(edge.source) ?? [];
    next.push(edge.target);
    children.set(edge.source, next);
  }

  const reachable = new Set<string>();
  const queue = [activeTree.rootNodeId];
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
