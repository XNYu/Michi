import { DomainError } from './domainErrors';

export interface NodePlacementLookup {
  getTree(id: string): { workspace_id: string } | null | undefined;
  getNode(id: string): { workspace_id: string; tree_id?: string | null } | null | undefined;
}

/** Legacy nodes remain valid when both parent and child have no tree. A null
 * tree is an actual placement, not a wildcard for a node in another tree. */
export function assertNodePlacement(
  workspaceId: string,
  treeId: string | null,
  parentId: string | null,
  lookup: NodePlacementLookup,
): void {
  if (treeId && lookup.getTree(treeId)?.workspace_id !== workspaceId) {
    throw new DomainError('conflict', 'node_tree_workspace_mismatch', 'node tree must belong to the same workspace');
  }
  if (!parentId) return;
  const parent = lookup.getNode(parentId);
  if (!parent || parent.workspace_id !== workspaceId) {
    throw new DomainError('conflict', 'node_parent_workspace_mismatch', 'node parent and child must belong to the same workspace');
  }
  if ((parent.tree_id ?? null) !== treeId) {
    throw new DomainError('conflict', 'node_parent_tree_mismatch', 'node parent and child must belong to the same tree');
  }
}
