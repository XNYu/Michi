import type { Project } from '../../../state/chatTypes';
import { findTreeIdForNode } from '../../../state/tree';

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

  return project.chatIds.filter((id) => {
    const node = nodes[id];
    if (node?.deletedAt || node?.kind === 'digest' || node?.kind === 'artifact') return false;
    const treeId = findTreeIdForNode(id, project);
    return !!treeId && liveTreeIds.has(treeId);
  });
}
