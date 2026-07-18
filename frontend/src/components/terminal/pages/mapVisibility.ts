import type { Project } from '../../../state/chatTypes';

type MapNodeVisibilityState = {
  deletedAt?: number;
  kind?: 'chat' | 'digest' | 'artifact';
};

export function visibleMapNodeIds(
  project: Pick<Project, 'chatIds' | 'trees' | 'edges'> | null | undefined,
  nodes: Record<string, MapNodeVisibilityState | undefined>,
): string[] {
  if (!project) return [];

  const liveTreeIds = new Set(
    (project.trees ?? [])
      .filter((tree) => !tree.archivedAt && !nodes[tree.rootNodeId]?.deletedAt)
      .map((tree) => tree.id),
  );

  const treeIdByRoot = new Map(
    (project.trees ?? []).map((tree) => [tree.rootNodeId, tree.id] as const),
  );
  const parentOf = new Map<string, string>();
  for (const edge of project.edges) {
    if (edge.kind !== undefined && edge.kind !== 'branch') continue;
    parentOf.set(edge.target, edge.source);
  }
  const resolvedTreeIds = new Map<string, string | null>();

  const treeIdForNode = (nodeId: string): string | null => {
    const cached = resolvedTreeIds.get(nodeId);
    if (cached !== undefined || resolvedTreeIds.has(nodeId)) return cached ?? null;

    const path: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = nodeId;
    let treeId: string | null = null;
    while (current) {
      if (seen.has(current)) break;
      seen.add(current);
      path.push(current);

      if (resolvedTreeIds.has(current)) {
        treeId = resolvedTreeIds.get(current) ?? null;
        break;
      }
      const rootTreeId = treeIdByRoot.get(current);
      if (rootTreeId) {
        treeId = rootTreeId;
        break;
      }
      current = parentOf.get(current);
    }

    for (const id of path) resolvedTreeIds.set(id, treeId);
    return treeId;
  };

  return project.chatIds.filter((id) => {
    const node = nodes[id];
    if (node?.deletedAt || node?.kind === 'digest' || node?.kind === 'artifact') return false;
    const treeId = treeIdForNode(id);
    return !!treeId && liveTreeIds.has(treeId);
  });
}
