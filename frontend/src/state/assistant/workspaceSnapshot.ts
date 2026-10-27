import { hydrateBackendWorkspaces } from '../chatHydration';
import type { ChatNodeState, Project, ProjectEdge } from '../chatTypes';
import { serializedEdgeId, type BackendInstalledEntities, type PendingBackendDeletes } from '../workspacePersistence';

export interface WorkspaceSnapshotMerge {
  projects: Project[];
  nodes: Record<string, ChatNodeState>;
}

function edgeKey(edge: ProjectEdge): string {
  return `${edge.source}\u0000${edge.target}\u0000${edge.kind ?? 'branch'}`;
}

/**
 * Bring a workspace the backend created after hydration (the assistant's
 * system workspace, provisioned on the first ⌘J; a fresh node after a reset)
 * into the store. Only adds what the store is missing: nodes it already holds
 * keep their live state (a stream, a draft), and the project keeps its own
 * fields. What the backend retired (a tree it archived, a node it deleted, as
 * a reset does) is retired here too. Returns the inputs themselves when
 * nothing changed, and null when the snapshot isn't a workspace.
 *
 * The snapshot may have been read before a removal this window made reached
 * the backend (`pendingDeletes`, asked about removals still on their way or
 * confirmed since `readStartedAt`: a tree moved or purged, an edge
 * unlinked): those trees and edges and the nodes of such a tree are not
 * brought back. Nor, in a workspace new to the store too, is a node the
 * store holds under another workspace, or a tree rooted on one: no node is
 * listed in two workspaces.
 */
export function mergeWorkspaceSnapshot(
  currentProjects: Project[],
  currentNodes: Record<string, ChatNodeState>,
  rawWorkspace: unknown,
  options: {
    pendingDeletes?: (local: Project, readStartedAt: number | undefined) => PendingBackendDeletes;
    /** When the snapshot's read began (Date.now()); unknown counts every remembered removal. */
    readStartedAt?: number;
  } = {},
): WorkspaceSnapshotMerge | null {
  const hydrated = hydrateBackendWorkspaces([rawWorkspace]);
  const server = hydrated.projects[0];
  if (!server) return null;

  const local = currentProjects.find((project) => project.id === server.id);
  const pending = local ? options.pendingDeletes?.(local, options.readStartedAt) : undefined;
  // A node the store holds under another workspace was moved there.
  const movedElsewhere = (id: string) => !!currentNodes[id] && currentNodes[id].projectId !== server.id;
  const skippedTrees = new Set(
    server.trees
      .filter((tree) => !local?.trees.some((t) => t.id === tree.id)
        && (pending?.treeIds.has(tree.id) || movedElsewhere(tree.rootNodeId)))
      .map((tree) => tree.id),
  );
  const skippedNodes = new Set(server.trees.filter((tree) => skippedTrees.has(tree.id)).map((tree) => tree.rootNodeId));
  if (skippedTrees.size > 0) {
    const rows = (rawWorkspace as { nodes?: Array<{ id?: unknown; tree_id?: unknown } | null> } | null)?.nodes;
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row?.id === 'string' && typeof row.tree_id === 'string' && skippedTrees.has(row.tree_id)) skippedNodes.add(row.id);
    }
  }

  let nodes = currentNodes;
  for (const [nodeId, node] of Object.entries(hydrated.nodes)) {
    // Another workspace's node is that workspace's to change.
    if (skippedNodes.has(nodeId) || movedElsewhere(nodeId)) continue;
    const held = currentNodes[nodeId];
    let next: ChatNodeState | null = null;
    if (!held) next = node;
    else {
      const patch: Partial<ChatNodeState> = {};
      // `pageId` is server-owned identity metadata. Reconcile it even on
      // existing nodes so promotion takes effect immediately after a fresh
      // workspace snapshot; preserve every local runtime/message field.
      if (node.pageId !== undefined && node.pageId !== held.pageId) patch.pageId = node.pageId;
      if (node.maintenanceJobId && node.maintenanceJobId !== held.maintenanceJobId) patch.maintenanceJobId = node.maintenanceJobId;
      if (node.deletedAt != null && held.deletedAt == null) patch.deletedAt = node.deletedAt;
      if (Object.keys(patch).length > 0) next = { ...held, ...patch };
    }
    if (!next) continue;
    if (nodes === currentNodes) nodes = { ...currentNodes };
    nodes[nodeId] = next;
  }

  const belongsHere = (id: string) => !skippedNodes.has(id) && !movedElsewhere(id);
  const edgeBelongsHere = (edge: ProjectEdge) => belongsHere(edge.source) && belongsHere(edge.target);

  if (!local) {
    const trees = server.trees.filter((tree) => !skippedTrees.has(tree.id));
    const fresh: Project = {
      ...server,
      chatIds: server.chatIds.filter(belongsHere),
      trees,
      edges: server.edges.filter(edgeBelongsHere),
      // As hydration picks one: the most recently active tree still open.
      activeTreeId: server.activeTreeId && skippedTrees.has(server.activeTreeId)
        ? [...trees].filter((tree) => !tree.archivedAt).sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id ?? null
        : server.activeTreeId,
    };
    return { projects: [...currentProjects, fresh], nodes };
  }

  const chatIds = [...local.chatIds, ...server.chatIds.filter((id) => !local.chatIds.includes(id) && belongsHere(id))];
  let treesRetired = false;
  const localTrees = local.trees.map((tree) => {
    const archivedAt = server.trees.find((t) => t.id === tree.id)?.archivedAt;
    if (archivedAt == null || tree.archivedAt != null) return tree;
    treesRetired = true;
    return { ...tree, archivedAt };
  });
  const trees = [
    ...localTrees,
    ...server.trees.filter((tree) => !local.trees.some((t) => t.id === tree.id) && !skippedTrees.has(tree.id)),
  ];
  const localEdges = new Set(local.edges.map(edgeKey));
  const edges = [
    ...local.edges,
    ...server.edges.filter((edge) => !localEdges.has(edgeKey(edge))
      && !pending?.edgeIds.has(serializedEdgeId(edge))
      && edgeBelongsHere(edge)),
  ];
  const unchanged = !treesRetired
    && chatIds.length === local.chatIds.length
    && trees.length === local.trees.length
    && edges.length === local.edges.length
    && (local.system ?? null) === (server.system ?? null);
  if (unchanged) return { projects: currentProjects, nodes };

  const merged: Project = {
    ...local,
    chatIds,
    trees,
    edges,
    ...(server.system ? { system: server.system } : {}),
    // The local choice stands unless the backend just archived that tree (a
    // reset): then the backend's active tree, the new conversation, takes over.
    activeTreeId: local.activeTreeId && !trees.find((t) => t.id === local.activeTreeId)?.archivedAt
      ? local.activeTreeId
      : server.activeTreeId ?? local.activeTreeId,
  };
  return { projects: currentProjects.map((project) => (project.id === merged.id ? merged : project)), nodes };
}

/**
 * What a merge brought into the store that it didn't hold before (the
 * workspace itself when new; its new nodes, trees and edges otherwise), for
 * the persistence layer to take as already durable. Null when nothing new.
 */
export function backendInstalledEntities(
  before: Project[],
  beforeNodes: Record<string, ChatNodeState>,
  merged: WorkspaceSnapshotMerge,
): BackendInstalledEntities | null {
  for (const project of merged.projects) {
    const local = before.find((candidate) => candidate.id === project.id);
    if (local === project) continue;
    const nodeIds = project.chatIds.filter((id) => !beforeNodes[id]);
    const treeIds = project.trees.filter((tree) => !local?.trees.some((t) => t.id === tree.id)).map((tree) => tree.id);
    const localEdges = new Set((local?.edges ?? []).map(serializedEdgeId));
    const edgeIds = project.edges.map(serializedEdgeId).filter((id) => !localEdges.has(id));
    if (local && nodeIds.length === 0 && treeIds.length === 0 && edgeIds.length === 0) return null;
    return { projectId: project.id, newProject: !local, nodeIds, treeIds, edgeIds };
  }
  return null;
}
