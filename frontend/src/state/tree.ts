export interface TreeEdge {
  source: string;
  target: string;
  /**
   * Optional edge kind. 'branch' (or undefined) = parent→child tree edge;
   * 'merge' = multi-source merge node reference; 'link' = user-drawn
   * cross-reference; 'digest-source' = digest node references a chat node
   * as a source. Only 'branch'/undefined edges participate in tree walks.
   */
  kind?: 'branch' | 'merge' | 'link' | 'digest-source';
}

export interface TreeNode {
  nodeId: string;
  depth: number;
  children: TreeNode[];
}

/**
 * Predicate signature used by tree walkers to skip soft-deleted nodes. The
 * renderer passes `(id) => !nodes[id]?.deletedAt`; tree walkers drop any
 * edge whose source or target is dead, so deleted subtrees disappear from
 * the structure view without needing a full copy of the edge list.
 */
export type NodeAlive = (nodeId: string) => boolean;

function isTreeEdge(e: TreeEdge): boolean {
  return e.kind === undefined || e.kind === 'branch';
}

/**
 * Build a tree rooted at `rootId` using a DFS traversal of the edges.
 * Merge edges (kind='merge') are ignored so multi-parent merge nodes don't
 * double up in the structure tree. Orphan edges (source unreachable from
 * the root) are naturally ignored by the DFS.
 */
export function buildTree(
  rootId: string,
  edges: readonly TreeEdge[],
  isAlive?: NodeAlive,
): TreeNode {
  const alive = isAlive ?? (() => true);
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!isTreeEdge(e)) continue;
    if (!alive(e.source) || !alive(e.target)) continue;
    const arr = childrenOf.get(e.source) ?? [];
    arr.push(e.target);
    childrenOf.set(e.source, arr);
  }

  const visit = (nodeId: string, depth: number): TreeNode => {
    const childIds = childrenOf.get(nodeId) ?? [];
    return {
      nodeId,
      depth,
      children: childIds.map((cid) => visit(cid, depth + 1)),
    };
  };

  return visit(rootId, 0);
}

/**
 * Collect all nodeIds reachable from `rootId` via outgoing branch edges,
 * excluding `rootId` itself. Merge edges are ignored so deleting a
 * merge node doesn't cascade-delete its sources (and vice versa).
 * Cycle-safe.
 */
export function descendants(
  rootId: string,
  edges: readonly TreeEdge[],
  isAlive?: NodeAlive,
): Set<string> {
  const alive = isAlive ?? (() => true);
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!isTreeEdge(e)) continue;
    if (!alive(e.source) || !alive(e.target)) continue;
    const arr = childrenOf.get(e.source) ?? [];
    arr.push(e.target);
    childrenOf.set(e.source, arr);
  }
  const out = new Set<string>();
  const stack = [...(childrenOf.get(rootId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id) || id === rootId) continue;
    out.add(id);
    const kids = childrenOf.get(id);
    if (kids) stack.push(...kids);
  }
  return out;
}

/**
 * Locate which tree a node belongs to by walking parent branch edges back
 * to a root that matches one of `project.trees`. Merge / link / digest-source
 * edges are ignored so merge nodes stay attached to their primary-branch
 * tree. Returns null if the node is not reachable from any root.
 */
export function findTreeIdForNode(
  nodeId: string,
  project: { trees: Array<{ id: string; rootNodeId: string }>; edges: readonly TreeEdge[] },
): string | null {
  // Direct-root shortcut.
  const asRoot = project.trees.find((t) => t.rootNodeId === nodeId);
  if (asRoot) return asRoot.id;

  // Build child→parent map from branch edges only (so merge nodes anchor to
  // their primary source's tree).
  const parentOf = new Map<string, string>();
  for (const e of project.edges) {
    if (e.kind !== undefined && e.kind !== 'branch') continue;
    parentOf.set(e.target, e.source);
  }

  const seen = new Set<string>();
  let cur: string | undefined = nodeId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const matched = project.trees.find((t) => t.rootNodeId === cur);
    if (matched) return matched.id;
    cur = parentOf.get(cur);
  }
  return null;
}
