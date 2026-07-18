import { getDb, runInTransaction } from './db';
import {
  getNode,
  getWorkspace,
  listEdges,
  listTrees,
  saveEdge,
  saveNode,
  saveTree,
  saveWorkspace,
  type EdgeRow,
  type NodeRow,
  type TreeRow,
  type WorkspaceRow,
} from './dbRepository';

export interface EnsureDurableGraphNodeInput {
  workspace: {
    id: string;
    name: string;
    cwd?: string | null;
    createdAt: number;
    activeTreeId?: string | null;
    settings?: Record<string, unknown> | null;
  };
  tree?: {
    id: string;
    rootNodeId: string;
    name?: string | null;
    archivedAt?: number | null;
    pinnedAt?: number | null;
    lastActiveAt: number;
    createdAt: number;
  };
  node: {
    id: string;
    treeId?: string | null;
    parentNodeId?: string | null;
    kind?: string;
    title?: string | null;
    spawnedByAgent?: boolean;
    /** Opaque frontend-owned draft/outbox payload. */
    composerDraft?: string | null;
    currentModeId?: string | null;
    createdAt: number;
  };
  edges: ReadonlyArray<{
    id: string;
    sourceNodeId: string;
    targetNodeId: string;
    kind: string;
    anchorMessageId?: string | null;
    createdAt?: number | null;
  }>;
  ownerUserId?: string | null;
}

export interface EnsureDurableGraphNodeResult {
  workspace: WorkspaceRow;
  tree: TreeRow | null;
  node: NodeRow;
  edges: EdgeRow[];
}

/** Remove only an untouched agent-spawn prerequisite whose runtime session
 * failed to materialize. The guards prevent compensation from deleting a
 * child that another concurrent path already bound or started. */
export function rollbackProvisionalSpawnNode(
  nodeId: string,
  workspaceId: string,
  ownerUserId?: string | null,
): boolean {
  return runInTransaction(() => {
    const row = getDb().prepare(`
      SELECT n.spawned_by_agent, n.status, n.acp_session_id,
             (SELECT COUNT(*) FROM messages m WHERE m.node_id = n.id) AS message_count,
             w.owner_user_id
        FROM nodes n JOIN workspaces w ON w.id = n.workspace_id
       WHERE n.id = ? AND n.workspace_id = ?
    `).get(nodeId, workspaceId) as {
      spawned_by_agent: number;
      status: string;
      acp_session_id: string | null;
      message_count: number;
      owner_user_id: string | null;
    } | undefined;
    if (!row) return false;
    if (process.env.MICHI_CLOUD === '1' && row.owner_user_id !== (ownerUserId ?? null)) return false;
    if (
      row.spawned_by_agent !== 1
      || row.status !== 'idle'
      || row.acp_session_id
      || row.message_count !== 0
    ) return false;
    getDb().prepare('DELETE FROM nodes WHERE id = ? AND workspace_id = ?').run(nodeId, workspaceId);
    return true;
  });
}

function requiredId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160) throw new Error(`${label} must be a non-empty id <=160 chars`);
  return trimmed;
}

/**
 * Idempotent graph prerequisite command used before a node can own a runtime
 * session. It intentionally creates only the addressed graph slice, never a
 * full workspace snapshot.
 */
export function ensureDurableGraphNode(input: EnsureDurableGraphNodeInput): EnsureDurableGraphNodeResult {
  return runInTransaction(() => {
    const workspaceId = requiredId(input.workspace.id, 'workspace.id');
    const nodeId = requiredId(input.node.id, 'node.id');
    const existingWorkspace = getWorkspace(workspaceId);
    if (
      process.env.MICHI_CLOUD === '1'
      && existingWorkspace
      && existingWorkspace.owner_user_id !== input.ownerUserId
    ) {
      throw new Error('workspace not found');
    }

    saveWorkspace({
      id: workspaceId,
      name: input.workspace.name.trim() || 'Untitled',
      cwd: input.workspace.cwd ?? null,
      active_tree_id: input.workspace.activeTreeId ?? null,
      created_at: input.workspace.createdAt,
      updated_at: Date.now(),
      settings: input.workspace.settings === undefined
        ? existingWorkspace?.settings ?? null
        : input.workspace.settings
          ? JSON.stringify(input.workspace.settings)
          : null,
      deleted_at: existingWorkspace?.deleted_at ?? null,
      archived_at: existingWorkspace?.archived_at ?? null,
      pinned_at: existingWorkspace?.pinned_at ?? null,
      backend: existingWorkspace?.backend ?? 'kiro',
      owner_user_id: input.ownerUserId ?? existingWorkspace?.owner_user_id ?? null,
    });

    let treeRow: TreeRow | null = null;
    if (input.tree) {
      const treeId = requiredId(input.tree.id, 'tree.id');
      if (input.node.treeId && input.node.treeId !== treeId) {
        throw new Error('node.treeId must match tree.id');
      }
      const existingTree = getDb().prepare(
        'SELECT workspace_id, root_node_id FROM trees WHERE id = ?',
      ).get(treeId) as { workspace_id: string; root_node_id: string } | undefined;
      if (existingTree?.workspace_id !== undefined && existingTree.workspace_id !== workspaceId) {
        throw new Error(`tree ${treeId} belongs to a different workspace`);
      }
      if (existingTree && existingTree.root_node_id !== input.tree.rootNodeId) {
        throw new Error(`tree ${treeId} was replayed with a different root`);
      }
      saveTree({
        id: treeId,
        workspace_id: workspaceId,
        root_node_id: requiredId(input.tree.rootNodeId, 'tree.rootNodeId'),
        name: input.tree.name ?? null,
        archived_at: input.tree.archivedAt ?? null,
        pinned_at: input.tree.pinnedAt ?? null,
        last_active_at: input.tree.lastActiveAt,
        created_at: input.tree.createdAt,
      }, input.ownerUserId ?? undefined);
      treeRow = listTrees(workspaceId).find((tree) => tree.id === treeId) ?? null;
    }

    if (input.node.treeId) {
      const nodeTree = getDb().prepare('SELECT workspace_id FROM trees WHERE id = ?')
        .get(input.node.treeId) as { workspace_id: string } | undefined;
      if (!nodeTree || nodeTree.workspace_id !== workspaceId) {
        throw new Error('node tree must belong to the same workspace');
      }
    }

    if (input.node.parentNodeId) {
      const parent = getNode(input.node.parentNodeId);
      if (!parent || parent.workspace_id !== workspaceId) {
        throw new Error('branch parent and child must belong to the same workspace');
      }
    }

    const existingNode = getNode(nodeId);
    if (existingNode) {
      if (
        existingNode.workspace_id !== workspaceId
        || (existingNode.tree_id ?? null) !== (input.node.treeId ?? null)
        || (existingNode.parent_node_id ?? null) !== (input.node.parentNodeId ?? null)
      ) {
        throw new Error(`node ${nodeId} was replayed with different graph identity`);
      }
    } else {
      saveNode({
        id: nodeId,
        workspace_id: workspaceId,
        tree_id: input.node.treeId ?? null,
        parent_node_id: input.node.parentNodeId ?? null,
        kind: input.node.kind ?? 'chat',
        title: input.node.title ?? null,
        status: 'idle',
        minimized: 0,
        spawned_by_agent: input.node.spawnedByAgent ? 1 : 0,
        current_mode_id: input.node.currentModeId ?? null,
        composer_draft: input.node.composerDraft ?? null,
        created_at: input.node.createdAt,
      }, input.ownerUserId ?? undefined);
    }

    if (input.tree) {
      const root = getNode(input.tree.rootNodeId);
      if (
        !root
        || root.workspace_id !== workspaceId
        || root.tree_id !== input.tree.id
      ) {
        throw new Error(`tree ${input.tree.id} root must belong to the same workspace and tree`);
      }
    }

    const activeTreeId = getWorkspace(workspaceId)?.active_tree_id;
    if (
      activeTreeId
      && !listTrees(workspaceId).some((candidate) => candidate.id === activeTreeId)
    ) {
      throw new Error('active tree must belong to the same workspace');
    }

    for (const edge of input.edges) {
      if (edge.targetNodeId !== nodeId) {
        throw new Error('graph prerequisite edges must target the ensured node');
      }
      const source = getNode(edge.sourceNodeId);
      const target = getNode(edge.targetNodeId);
      if (!source || !target || source.workspace_id !== workspaceId || target.workspace_id !== workspaceId) {
        throw new Error('edge endpoints must belong to the same workspace');
      }
      if (edge.kind === 'branch' && source.tree_id !== target.tree_id) {
        throw new Error('branch edge endpoints must belong to the same tree');
      }
      const existingEdge = getDb().prepare(`
        SELECT workspace_id, source_node_id, target_node_id, kind FROM edges WHERE id = ?
      `).get(edge.id) as {
        workspace_id: string;
        source_node_id: string;
        target_node_id: string;
        kind: string;
      } | undefined;
      if (existingEdge && existingEdge.workspace_id !== workspaceId) {
        throw new Error(`edge ${edge.id} belongs to a different workspace`);
      }
      if (
        existingEdge
        && (
          existingEdge.source_node_id !== edge.sourceNodeId
          || existingEdge.target_node_id !== edge.targetNodeId
          || existingEdge.kind !== edge.kind
        )
      ) {
        throw new Error(`edge ${edge.id} was replayed with different graph identity`);
      }
      saveEdge({
        id: requiredId(edge.id, 'edge.id'),
        workspace_id: workspaceId,
        source_node_id: edge.sourceNodeId,
        target_node_id: edge.targetNodeId,
        kind: edge.kind,
        anchor_message_id: edge.anchorMessageId ?? null,
        created_at: edge.createdAt ?? null,
      }, input.ownerUserId ?? undefined);
    }

    getDb().prepare('UPDATE workspaces SET persistence_version = 2 WHERE id = ?').run(workspaceId);
    const workspace = getWorkspace(workspaceId);
    const node = getNode(nodeId);
    if (!workspace || !node) throw new Error('graph prerequisite transaction did not materialize canonical rows');
    const edgeIds = new Set(input.edges.map((edge) => edge.id));
    return {
      workspace,
      tree: treeRow,
      node,
      edges: listEdges(workspaceId).filter((edge) => edgeIds.has(edge.id)),
    };
  });
}
