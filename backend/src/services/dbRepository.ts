import { getDb, runInTransaction } from './db';
import { normalizeIncomingMessageRow } from './messageSerialization';

/**
 * How long tombstone rows (workspaces / nodes with non-null `purged_at`) are
 * kept around before GC. The window has to outlast any reasonable offline-tab
 * snapshot age — 90 days covers laptops sleeping for weeks and phones offline
 * for a couple of months. Beyond that the user accepts that an extremely
 * stale client could revive a deleted row, in exchange for not letting
 * tombstone tables grow without bound.
 *
 * GC runs lazily: every successful purge cleans up rows older than this
 * threshold. There is no background timer.
 */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// --- Row types ---

export interface WorkspaceRow {
  id: string;
  name: string;
  cwd?: string | null;
  active_tree_id?: string | null;
  created_at: number;
  updated_at: number;
  settings?: string | null;
  deleted_at?: number | null;
  archived_at?: number | null;
  backend?: string | null;
  /** Cloud-mode owner. Nullable in SQLite (NOT NULL enforced in app code).
   *  The route layer sets this to req.user.id on INSERT in cloud mode.
   *  Desktop mode: always null / ignored. */
  owner_user_id?: string | null;
  pinned_at?: number | null;
  /** Tombstone — Unix ms when this workspace was permanently purged. Non-null
   *  rows are filtered out of reads and refused on write so a stale POST /sync
   *  from another tab cannot resurrect them. GC'd by `runTombstoneGc()` after
   *  TOMBSTONE_TTL_MS. See migration 0004. */
  purged_at?: number | null;
  /** Per-workspace monotonic sync version (sync L2, migration 0006). Bumped
   *  once per sync txn; managed by bumpWorkspaceRev (L2.2), NOT bound by
   *  saveWorkspace's INSERT (defaults to 0 on insert, preserved on conflict). */
  sync_rev?: number;
}

export interface TreeRow {
  id: string;
  workspace_id: string;
  root_node_id: string;
  name?: string | null;
  archived_at?: number | null;
  pinned_at?: number | null;
  last_active_at: number;
  created_at: number;
  /** Per-row sync version (sync L2, migration 0006). NULL = predates versioning
   *  / no claim. Stamped by leaf save* via COALESCE; guard reads it in L2.2. */
  rev?: number | null;
}

export interface NodeRow {
  id: string;
  workspace_id: string;
  tree_id?: string | null;
  parent_node_id?: string | null;
  kind: string;
  title?: string | null;
  branch_overview?: string | null;
  status: string;
  position_x?: number | null;
  position_y?: number | null;
  minimized: number;
  deleted_at?: number | null;
  deletion_group_id?: string | null;
  spawned_by_agent: number;
  current_mode_id?: string | null;
  pane_width?: number | null;
  digest?: string | null;
  follow_ups?: string | null;
  follow_ups_source_message_id?: string | null;
  acp_session_id?: string | null;
  runtime_id?: string | null;
  provider_id?: string | null;
  model_id?: string | null;
  reasoning?: string | null;
  resume_fingerprint?: string | null;
  composer_draft?: string | null;
  external_session_id?: string | null;
  /** JSON-encoded TrimSnapshot. Non-null iff the node was trimmed (single-node
   *  trash entry, not a subtree deletion). Carries the undo data for restore. */
  trim_snapshot?: string | null;
  /** Tombstone — Unix ms when this node was permanently purged. Non-null rows
   *  are filtered out of reads and refused on write so a stale POST /sync from
   *  another tab cannot resurrect them. GC'd by `runTombstoneGc()` after
   *  TOMBSTONE_TTL_MS. See migration v16. */
  purged_at?: number | null;
  created_at: number;
  /** Per-row sync version (sync L2, migration 0006). NULL = predates versioning
   *  / no claim. Stamped by leaf save* via COALESCE; guard reads it in L2.2. */
  rev?: number | null;
}

/**
 * Undo payload written to `nodes.trim_snapshot` at trim time. Captures
 * everything `restoreTrimmedNode` needs to put the node back:
 *
 * - `parentId`     — the original parent of the trimmed node. If that
 *                    node is itself trimmed or gone by restore time, the
 *                    resolver walks the snapshot chain up to the nearest
 *                    live ancestor.
 * - `childrenIds`  — the ids that were the node's children at trim time.
 *                    Restore re-steals those still alive (and still parented
 *                    to the trim target) back under the node.
 * - `wasTreeRoot`  — set when the trimmed node was a tree root, so restore
 *                    can put the tree-root pointer back (or recreate the
 *                    tree row if it was dropped because the node had no
 *                    children at trim time).
 */
export interface TrimSnapshot {
  parentId: string | null;
  childrenIds: string[];
  wasTreeRoot: { treeId: string } | null;
}

export interface EdgeRow {
  id: string;
  workspace_id: string;
  source_node_id: string;
  target_node_id: string;
  kind: string;
  anchor_message_id?: string | null;
  created_at?: number | null;
  /** Per-row sync version (sync L2, migration 0006). NULL = predates versioning
   *  / no claim. Stamped by leaf save* via COALESCE; guard reads it in L2.2. */
  rev?: number | null;
}

export interface MessageRow {
  id: string;
  node_id: string;
  role: string;
  content: string;
  blocks?: string | null;
  tool_calls?: string | null;
  seq: number;
  created_at: number;
  /** Per-row sync version (sync L2, migration 0006). NULL = predates versioning
   *  / no claim. Stamped by leaf save* via COALESCE; guard reads it in L2.2. */
  rev?: number | null;
}

export interface ContextRow {
  id: string;
  workspace_id: string;
  name: string;
  file_path: string;
  size?: number | null;
  auto_inject: number;
  source: string;
  created_at: number;
  updated_at: number;
  /** Per-row sync version (sync L2, migration 0006). NULL = predates versioning
   *  / no claim. Stamped by leaf save* via COALESCE; guard reads it in L2.2. */
  rev?: number | null;
}

export interface FullWorkspaceData {
  workspace: WorkspaceRow;
  trees: TreeRow[];
  nodes: NodeRow[];
  edges: EdgeRow[];
  messages: MessageRow[];
  contexts: ContextRow[];
}

// --- Workspace CRUD ---

export function listWorkspaces(userId?: string): WorkspaceRow[] {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    return getDb().prepare(
      'SELECT * FROM workspaces WHERE owner_user_id = ? AND purged_at IS NULL ORDER BY updated_at DESC',
    ).all(userId) as unknown as WorkspaceRow[];
  }
  return getDb()
    .prepare('SELECT * FROM workspaces WHERE purged_at IS NULL ORDER BY updated_at DESC')
    .all() as unknown as WorkspaceRow[];
}

export function getWorkspace(id: string, userId?: string): WorkspaceRow | null {
  const row =
    (getDb().prepare('SELECT * FROM workspaces WHERE id = ? AND purged_at IS NULL').get(id) as unknown as WorkspaceRow)
    ?? null;
  if (process.env.MICHI_CLOUD === '1' && userId && row) {
    if (row.owner_user_id !== userId) return null;
  }
  return row;
}

/**
 * Upsert a workspace row. Refuses to write if a tombstone exists for this id
 * (purged_at IS NOT NULL) — that's the multi-tab anti-revival guard. The
 * caller's POST /sync will silently no-op for tombstoned ids; nodes / edges
 * referencing the workspace are skipped by their own guards (FK still works).
 */
export function saveWorkspace(ws: WorkspaceRow): void {
  // ON CONFLICT WHERE excluded.purged_at IS NULL would be cleaner but
  // sqlite3's WHERE clause on ON CONFLICT requires NOT NULL on the conflict
  // target's column — the row itself is the conflict, not excluded. Cheaper
  // and clearer to read-then-skip in app code.
  const existing = getDb()
    .prepare('SELECT purged_at FROM workspaces WHERE id = ?')
    .get(ws.id) as { purged_at: number | null } | undefined;
  if (existing && existing.purged_at !== null) return;

  getDb().prepare(`
    INSERT INTO workspaces (id, name, cwd, active_tree_id, created_at, updated_at, settings, deleted_at, archived_at, pinned_at, backend, owner_user_id)
    VALUES (@id, @name, @cwd, @active_tree_id, @created_at, @updated_at, @settings, @deleted_at, @archived_at, @pinned_at, @backend, @owner_user_id)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, cwd=excluded.cwd,
      active_tree_id=excluded.active_tree_id, updated_at=excluded.updated_at, settings=excluded.settings,
      deleted_at=excluded.deleted_at, archived_at=excluded.archived_at, pinned_at=excluded.pinned_at,
      backend=excluded.backend,
      owner_user_id=COALESCE(excluded.owner_user_id, workspaces.owner_user_id)
  `).run({ cwd: null, active_tree_id: null, settings: null, deleted_at: null, archived_at: null, pinned_at: null, backend: 'kiro', owner_user_id: null, ...ws });
}

/**
 * Permanently delete a workspace by tombstoning it. Cascades by also
 * tombstoning every node in the workspace and physically deleting messages,
 * edges, trees, contexts (those only matter when joined to a live node;
 * the node tombstone already blocks revival of the workspace's structure).
 *
 * Triggers a lazy GC pass at the end to drop tombstones older than
 * TOMBSTONE_TTL_MS. In cloud mode the workspace must be owned by the
 * caller for the tombstone to land — otherwise the call is a no-op.
 */
export function deleteWorkspace(id: string, userId?: string): void {
  runInTransaction(() => {
    const now = Date.now();
    const db = getDb();
    if (process.env.MICHI_CLOUD === '1' && userId) {
      const owned = db
        .prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?')
        .get(id, userId);
      if (!owned) return;
    }
    db.prepare('UPDATE workspaces SET purged_at = ? WHERE id = ? AND purged_at IS NULL')
      .run(now, id);
    db.prepare('UPDATE nodes SET purged_at = ? WHERE workspace_id = ? AND purged_at IS NULL')
      .run(now, id);
    db.prepare(
      'DELETE FROM messages WHERE node_id IN (SELECT id FROM nodes WHERE workspace_id = ?)',
    ).run(id);
    db.prepare('DELETE FROM edges WHERE workspace_id = ?').run(id);
    db.prepare('DELETE FROM trees WHERE workspace_id = ?').run(id);
    db.prepare('DELETE FROM contexts WHERE workspace_id = ?').run(id);
  });
  runTombstoneGc();
}

/**
 * Lazy garbage collector for tombstone rows. Drops nodes / workspaces whose
 * `purged_at` is older than `TOMBSTONE_TTL_MS`. Called at the end of every
 * successful purge / deleteWorkspace so the tables don't grow forever.
 *
 * Exported for tests and so an out-of-band ops command can trigger it.
 */
export function runTombstoneGc(): { workspaces: number; nodes: number } {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const db = getDb();
  const nodes = db.prepare(
    'DELETE FROM nodes WHERE purged_at IS NOT NULL AND purged_at < ?',
  ).run(cutoff).changes as number;
  const workspaces = db.prepare(
    'DELETE FROM workspaces WHERE purged_at IS NOT NULL AND purged_at < ?',
  ).run(cutoff).changes as number;
  return { nodes, workspaces };
}

/**
 * Tombstone-status helpers used by the saveX functions to refuse writes that
 * would resurrect a tombstoned id. Cheap (single PK lookup), cached by
 * SQLite's prepared-statement cache.
 */
function isWorkspaceTombstoned(workspaceId: string): boolean {
  const row = getDb()
    .prepare('SELECT purged_at FROM workspaces WHERE id = ?')
    .get(workspaceId) as { purged_at: number | null } | undefined;
  return row?.purged_at != null;
}

function isNodeTombstoned(nodeId: string): boolean {
  const row = getDb()
    .prepare('SELECT purged_at FROM nodes WHERE id = ?')
    .get(nodeId) as { purged_at: number | null } | undefined;
  return row?.purged_at != null;
}

// --- Tree CRUD ---

export function listTrees(workspaceId: string, userId?: string): TreeRow[] {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    return getDb().prepare(
      'SELECT t.* FROM trees t JOIN workspaces w ON t.workspace_id = w.id WHERE t.workspace_id = ? AND w.owner_user_id = ? ORDER BY t.last_active_at DESC'
    ).all(workspaceId, userId) as unknown as TreeRow[];
  }
  return getDb().prepare('SELECT * FROM trees WHERE workspace_id = ? ORDER BY last_active_at DESC').all(workspaceId) as unknown as TreeRow[];
}

export function saveTree(tree: TreeRow, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    const owned = getDb().prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?').get(tree.workspace_id, userId);
    if (!owned) return;
  }
  // Tombstone guard — refuse to revive trees inside a purged workspace.
  if (isWorkspaceTombstoned(tree.workspace_id)) return;
  getDb().prepare(`
    INSERT INTO trees (id, workspace_id, root_node_id, name, archived_at, pinned_at, last_active_at, created_at, rev)
    VALUES (@id, @workspace_id, @root_node_id, @name, @archived_at, @pinned_at, @last_active_at, @created_at, @rev)
    ON CONFLICT(id) DO UPDATE SET
      root_node_id=excluded.root_node_id, name=excluded.name,
      archived_at=excluded.archived_at, pinned_at=excluded.pinned_at,
      last_active_at=excluded.last_active_at,
      rev=COALESCE(excluded.rev, trees.rev)
  `).run({ name: null, archived_at: null, pinned_at: null, rev: null, ...tree });
}

export function deleteTree(id: string, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    getDb().prepare(
      'DELETE FROM trees WHERE id = ? AND EXISTS (SELECT 1 FROM workspaces WHERE id = (SELECT workspace_id FROM trees WHERE id = ?) AND owner_user_id = ?)'
    ).run(id, id, userId);
    return;
  }
  getDb().prepare('DELETE FROM trees WHERE id = ?').run(id);
}

/**
 * Move a tree (its row + every node + every edge with both endpoints in the
 * tree's node set) from one workspace to another. Edges that cross the
 * boundary (only one endpoint inside the tree) are dropped — they would
 * otherwise violate the workspace_id invariant on the edges table.
 *
 * Idempotent on retry: ON CONFLICT in saveTree/saveNode/saveEdge handles
 * partial completion. The whole operation runs in a single transaction so
 * a crash leaves nothing half-moved.
 */
export function moveTreeToWorkspace(
  treeId: string,
  fromWorkspaceId: string,
  toWorkspaceId: string,
  userId?: string,
): { movedNodes: number; movedEdges: number; droppedEdges: number } {
  return runInTransaction(() => {
    const db = getDb();
    if (process.env.MICHI_CLOUD === '1' && userId) {
      const srcOwned = db.prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?').get(fromWorkspaceId, userId);
      if (!srcOwned) throw new Error(`source workspace ${fromWorkspaceId} not found`);
      const dstOwned = db.prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?').get(toWorkspaceId, userId);
      if (!dstOwned) throw new Error(`target workspace ${toWorkspaceId} not found`);
    }
    const tree = db
      .prepare('SELECT * FROM trees WHERE id = ? AND workspace_id = ?')
      .get(treeId, fromWorkspaceId) as TreeRow | undefined;
    if (!tree) throw new Error(`tree ${treeId} not found in workspace ${fromWorkspaceId}`);
    const toWs = db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(toWorkspaceId);
    if (!toWs) throw new Error(`target workspace ${toWorkspaceId} not found`);

    // Tree row: just flip workspace_id.
    db.prepare('UPDATE trees SET workspace_id = ? WHERE id = ?').run(toWorkspaceId, treeId);

    // Nodes: every node carrying this tree_id, regardless of source workspace.
    const nodeRows = db
      .prepare('SELECT id FROM nodes WHERE tree_id = ?')
      .all(treeId) as { id: string }[];
    const nodeIds = new Set(nodeRows.map((r) => r.id));
    if (nodeIds.size > 0) {
      const placeholders = Array.from(nodeIds).map(() => '?').join(',');
      db.prepare(
        `UPDATE nodes SET workspace_id = ? WHERE id IN (${placeholders})`,
      ).run(toWorkspaceId, ...Array.from(nodeIds));
    }

    // Edges: take edges in the source workspace where BOTH endpoints are in
    // the moved node set, flip them to the target. Drop edges that straddle
    // the boundary — those would land in a workspace whose chatIds no longer
    // contain one of the endpoints.
    const sourceEdges = db
      .prepare('SELECT id, source_node_id, target_node_id FROM edges WHERE workspace_id = ?')
      .all(fromWorkspaceId) as { id: string; source_node_id: string; target_node_id: string }[];
    const moveIds: string[] = [];
    const dropIds: string[] = [];
    for (const e of sourceEdges) {
      const a = nodeIds.has(e.source_node_id);
      const b = nodeIds.has(e.target_node_id);
      if (a && b) moveIds.push(e.id);
      else if (a !== b) dropIds.push(e.id);
    }
    if (moveIds.length > 0) {
      const ph = moveIds.map(() => '?').join(',');
      db.prepare(`UPDATE edges SET workspace_id = ? WHERE id IN (${ph})`)
        .run(toWorkspaceId, ...moveIds);
    }
    if (dropIds.length > 0) {
      const ph = dropIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM edges WHERE id IN (${ph})`).run(...dropIds);
    }

    return {
      movedNodes: nodeIds.size,
      movedEdges: moveIds.length,
      droppedEdges: dropIds.length,
    };
  });
}

// --- Node CRUD ---

export function listNodes(workspaceId: string, userId?: string): NodeRow[] {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    return getDb().prepare(
      `SELECT n.* FROM nodes n JOIN workspaces w ON n.workspace_id = w.id
       WHERE n.workspace_id = ? AND w.owner_user_id = ? AND n.purged_at IS NULL`,
    ).all(workspaceId, userId) as unknown as NodeRow[];
  }
  return getDb()
    .prepare('SELECT * FROM nodes WHERE workspace_id = ? AND purged_at IS NULL')
    .all(workspaceId) as unknown as NodeRow[];
}

export function getNode(id: string): NodeRow | null {
  return (
    (getDb().prepare('SELECT * FROM nodes WHERE id = ? AND purged_at IS NULL').get(id) as unknown as NodeRow)
    ?? null
  );
}

export function saveNode(node: NodeRow, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    const owned = getDb().prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?').get(node.workspace_id, userId);
    if (!owned) return;
  }
  // Tombstone guard — refuse to upsert any id that is tombstoned, OR whose
  // owning workspace is tombstoned. Multi-tab anti-revival bedrock: a stale
  // POST /sync from another tab can no longer undo a purge.
  if (isNodeTombstoned(node.id) || isWorkspaceTombstoned(node.workspace_id)) return;

  getDb().prepare(`
    INSERT INTO nodes (id, workspace_id, tree_id, parent_node_id, kind, title, branch_overview, status,
      position_x, position_y, minimized, deleted_at, deletion_group_id,
      spawned_by_agent, current_mode_id, pane_width, digest, follow_ups, follow_ups_source_message_id,
      acp_session_id, runtime_id,
      provider_id, model_id, reasoning, resume_fingerprint, composer_draft, external_session_id,
      trim_snapshot, last_applied_turn_id, last_applied_seq, created_at, rev)
    VALUES (@id, @workspace_id, @tree_id, @parent_node_id, @kind, @title, @branch_overview, @status,
      @position_x, @position_y, @minimized, @deleted_at, @deletion_group_id,
      @spawned_by_agent, @current_mode_id, @pane_width, @digest, @follow_ups, @follow_ups_source_message_id,
      @acp_session_id, @runtime_id,
      @provider_id, @model_id, @reasoning, @resume_fingerprint, @composer_draft, @external_session_id,
      @trim_snapshot, @created_at, @rev)
    ON CONFLICT(id) DO UPDATE SET
      tree_id=excluded.tree_id, parent_node_id=excluded.parent_node_id,
      kind=excluded.kind, title=excluded.title, branch_overview=excluded.branch_overview, status=excluded.status,
      position_x=excluded.position_x, position_y=excluded.position_y,
      minimized=excluded.minimized, deleted_at=excluded.deleted_at,
      deletion_group_id=excluded.deletion_group_id, spawned_by_agent=excluded.spawned_by_agent,
      current_mode_id=excluded.current_mode_id, pane_width=excluded.pane_width,
      digest=excluded.digest, follow_ups=excluded.follow_ups,
      follow_ups_source_message_id=excluded.follow_ups_source_message_id,
      acp_session_id=excluded.acp_session_id, runtime_id=excluded.runtime_id,
      provider_id=excluded.provider_id, model_id=excluded.model_id,
      reasoning=excluded.reasoning, resume_fingerprint=excluded.resume_fingerprint,
      composer_draft=excluded.composer_draft,
      -- external_session_id is minted server-side from claude system/init and is
      -- NOT carried in the frontend node sync payload (serializeNodeRow omits it).
      -- A plain excluded.external_session_id therefore clobbered the just-persisted
      -- claude session UUID back to NULL on the very next sync, permanently breaking
      -- native claude --resume (loadSession threw, then silent fresh+replay). COALESCE
      -- preserves the stored value when the incoming row omits it, matching the rev
      -- guard on this same statement. An explicit non-null value still wins.
      external_session_id=COALESCE(excluded.external_session_id, nodes.external_session_id),
      trim_snapshot=excluded.trim_snapshot,
      rev=COALESCE(excluded.rev, nodes.rev)
  `).run({
    tree_id: null,
    parent_node_id: null,
    title: null,
    branch_overview: null,
    position_x: null,
    position_y: null,
    deleted_at: null,
    deletion_group_id: null,
    current_mode_id: null,
    pane_width: null,
    digest: null,
    follow_ups: null,
    follow_ups_source_message_id: null,
    acp_session_id: null,
    runtime_id: null,
    provider_id: null,
    model_id: null,
    reasoning: null,
    resume_fingerprint: null,
    composer_draft: null,
    external_session_id: null,
    trim_snapshot: null,
    rev: null,
    ...node,
  });
}

export function updateNodeTitle(id: string, title: string, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    getDb().prepare(
      'UPDATE nodes SET title = ? WHERE id = ? AND EXISTS (SELECT 1 FROM workspaces WHERE id = (SELECT workspace_id FROM nodes WHERE id = ?) AND owner_user_id = ?)'
    ).run(title, id, id, userId);
    return;
  }
  getDb().prepare('UPDATE nodes SET title = ? WHERE id = ?').run(title, id);
}

export function updateNodeBranchOverview(id: string, overview: string, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    getDb().prepare(
      'UPDATE nodes SET branch_overview = ? WHERE id = ? AND EXISTS (SELECT 1 FROM workspaces WHERE id = (SELECT workspace_id FROM nodes WHERE id = ?) AND owner_user_id = ?)'
    ).run(overview, id, id, userId);
    return;
  }
  getDb().prepare('UPDATE nodes SET branch_overview = ? WHERE id = ?').run(overview, id);
}

export function softDeleteNode(id: string, deletedAt: number, groupId: string, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    getDb().prepare(
      'UPDATE nodes SET deleted_at = ?, deletion_group_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM workspaces WHERE id = (SELECT workspace_id FROM nodes WHERE id = ?) AND owner_user_id = ?)'
    ).run(deletedAt, groupId, id, id, userId);
    return;
  }
  getDb().prepare('UPDATE nodes SET deleted_at = ?, deletion_group_id = ? WHERE id = ?').run(deletedAt, groupId, id);
}

export function restoreNode(id: string, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    getDb().prepare(
      'UPDATE nodes SET deleted_at = NULL, deletion_group_id = NULL WHERE id = ? AND EXISTS (SELECT 1 FROM workspaces WHERE id = (SELECT workspace_id FROM nodes WHERE id = ?) AND owner_user_id = ?)'
    ).run(id, id, userId);
    return;
  }
  getDb().prepare('UPDATE nodes SET deleted_at = NULL, deletion_group_id = NULL WHERE id = ?').run(id);
}

/**
 * Empty a workspace's trash by tombstoning every soft-deleted node. Returns
 * the count of rows newly tombstoned (already-tombstoned rows are skipped).
 *
 * Why tombstones instead of physical DELETE: a stale POST /sync from another
 * tab carries a snapshot in which the just-purged ids are still alive. With
 * `purged_at` non-null, `saveNode` refuses to revive them.
 *
 * Messages and edges of tombstoned nodes are physically deleted in the same
 * transaction — they only matter when joined to a live node, and the node
 * tombstone already blocks anything from re-creating that join. Trees whose
 * root is now tombstoned (or never had any live nodes) are dropped.
 *
 * Triggers `runTombstoneGc()` at the end so old tombstones don't accumulate.
 */
export function emptyWorkspaceTrash(workspaceId: string): number {
  const changed = runInTransaction(() => {
    const now = Date.now();
    const db = getDb();
    // Archived nodes also carry deleted_at (archive reuses the trim engine),
    // so they are explicitly excluded here — "empty trash" must never touch the
    // archived lane. They are removed only via explicit purgeWorkspaceNodes.
    const result = db.prepare(
      `UPDATE nodes SET purged_at = ?
       WHERE workspace_id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL
         AND (deletion_group_id IS NULL OR deletion_group_id NOT LIKE 'arch-%')`,
    ).run(now, workspaceId);
    // Drop dependent rows for the just-tombstoned nodes. These are physically
    // deleted because a tombstoned node can never come back, so its messages /
    // edges have nowhere to attach.
    db.prepare(
      `DELETE FROM messages
       WHERE node_id IN (SELECT id FROM nodes WHERE workspace_id = ? AND purged_at IS NOT NULL)`,
    ).run(workspaceId);
    db.prepare(
      `DELETE FROM edges
       WHERE workspace_id = ?
         AND (source_node_id IN (SELECT id FROM nodes WHERE workspace_id = ? AND purged_at IS NOT NULL)
              OR target_node_id IN (SELECT id FROM nodes WHERE workspace_id = ? AND purged_at IS NOT NULL))`,
    ).run(workspaceId, workspaceId, workspaceId);
    db.prepare(
      `DELETE FROM trees
       WHERE workspace_id = ?
         AND root_node_id NOT IN (SELECT id FROM nodes WHERE workspace_id = ? AND purged_at IS NULL)`,
    ).run(workspaceId, workspaceId);
    return result.changes as number;
  });
  runTombstoneGc();
  return changed;
}

/**
 * Tombstone an explicit list of node ids inside a workspace. Used for the
 * "delete permanently" action on a single trash group. nodeIds outside the
 * given workspace are ignored (defence in depth). Same cascade rules as
 * `emptyWorkspaceTrash` — messages/edges/orphan-trees are physically dropped
 * in the same transaction; the tombstone is the anti-revival mechanism.
 */
export function purgeWorkspaceNodes(workspaceId: string, nodeIds: readonly string[]): number {
  if (nodeIds.length === 0) return 0;
  const changed = runInTransaction(() => {
    const now = Date.now();
    const placeholders = nodeIds.map(() => '?').join(',');
    const db = getDb();
    const result = db.prepare(
      `UPDATE nodes SET purged_at = ?
       WHERE workspace_id = ? AND id IN (${placeholders}) AND purged_at IS NULL`,
    ).run(now, workspaceId, ...nodeIds);
    db.prepare(
      `DELETE FROM messages
       WHERE node_id IN (SELECT id FROM nodes WHERE workspace_id = ? AND purged_at IS NOT NULL
                           AND id IN (${placeholders}))`,
    ).run(workspaceId, ...nodeIds);
    db.prepare(
      `DELETE FROM edges
       WHERE workspace_id = ?
         AND (source_node_id IN (${placeholders}) OR target_node_id IN (${placeholders}))`,
    ).run(workspaceId, ...nodeIds, ...nodeIds);
    db.prepare(
      `DELETE FROM trees
       WHERE workspace_id = ?
         AND root_node_id NOT IN (SELECT id FROM nodes WHERE workspace_id = ? AND purged_at IS NULL)`,
    ).run(workspaceId, workspaceId);
    return result.changes as number;
  });
  runTombstoneGc();
  return changed;
}

/**
 * Single-node trim: send a node to trash while keeping its descendants live by
 * reparenting them up. Used for "prune this node out of the conversation"
 * (Phase 2 of the trash redesign). All mutations run in one transaction so a
 * crash leaves the workspace in a consistent state.
 *
 * Algorithm:
 * 1. Snapshot { parentId, childrenIds, wasTreeRoot } into `nodes.trim_snapshot`
 *    so `restoreTrimmedNode` can reverse this operation byte-for-byte.
 * 2. Mark the node trashed (deleted_at, deletion_group_id).
 * 3. Re-home the node's children:
 *    - Normal case (node is mid-tree): every child's parent_node_id becomes
 *      the trimmed node's old parent. New branch edges (old_parent → child)
 *      replace (trimmed → child); the (old_parent → trimmed) edge is dropped.
 *    - Tree-root case with at least one live child: promote the oldest live
 *      child to the new tree root (parent_node_id = NULL). The remaining
 *      children become children of that new root — preserving the
 *      single-root invariant the rest of the codebase relies on. The tree
 *      row's root_node_id pointer is updated in the same step.
 *    - Tree-root case with no live children: the tree row is dropped — there
 *      is no node left to host it.
 *
 * Edge ids follow the existing `branch-<src>-<tgt>` convention; INSERT OR
 * IGNORE skips duplicates so a re-run on an already-rewired graph is safe.
 */
export function trimNode(
  workspaceId: string,
  nodeId: string,
  deletedAt: number,
  groupId: string,
): { trimmed: number } {
  return runInTransaction(() => {
    const db = getDb();

    const x = db.prepare(`SELECT id, parent_node_id, workspace_id
                          FROM nodes WHERE id = ? AND workspace_id = ?`)
      .get(nodeId, workspaceId) as { id: string; parent_node_id: string | null; workspace_id: string } | undefined;
    if (!x) return { trimmed: 0 };

    // Children = every node currently pointing at X as parent. Includes both
    // live and already-trashed children — trashed ones still need reparenting
    // at the DB level so that, post-trim, no `parent_node_id` dangles at X.
    // Their own trim_snapshot / deletion_group_id keep them in the trash view.
    const childRows = db.prepare(
      'SELECT id FROM nodes WHERE workspace_id = ? AND parent_node_id = ? AND id <> ?',
    ).all(workspaceId, nodeId, nodeId) as { id: string }[];
    const childrenIds = childRows.map((c) => c.id);

    const treeRow = db.prepare(
      'SELECT id FROM trees WHERE workspace_id = ? AND root_node_id = ?',
    ).get(workspaceId, nodeId) as { id: string } | undefined;
    const wasTreeRoot: TrimSnapshot['wasTreeRoot'] = treeRow ? { treeId: treeRow.id } : null;

    const snapshot: TrimSnapshot = {
      parentId: x.parent_node_id,
      childrenIds,
      wasTreeRoot,
    };

    // Mark the node trashed and stamp the undo data on the same row.
    db.prepare(`UPDATE nodes
                SET trim_snapshot = ?, deleted_at = ?, deletion_group_id = ?
                WHERE id = ?`)
      .run(JSON.stringify(snapshot), deletedAt, groupId, nodeId);

    // Drop the trimmed node's branch edges in both directions. The
    // surrounding-graph rewires (below) re-add the parent→children
    // bypass edges as appropriate.
    db.prepare(
      `DELETE FROM edges WHERE workspace_id = ? AND source_node_id = ? AND kind = 'branch'`,
    ).run(workspaceId, nodeId);
    db.prepare(
      `DELETE FROM edges WHERE workspace_id = ? AND target_node_id = ? AND kind = 'branch'`,
    ).run(workspaceId, nodeId);

    if (wasTreeRoot) {
      // Tree root branch: a tree must always have exactly one root, so we
      // pick the oldest LIVE child as the new root and re-parent the
      // surviving siblings under it. Trashed children stay parented to the
      // new root too — keeping their parent pointer stable so that if they
      // are later restored, they still find a live ancestor.
      const liveChildren = childrenIds.length > 0
        ? (db.prepare(
            `SELECT id FROM nodes
             WHERE workspace_id = ? AND id IN (${childrenIds.map(() => '?').join(',')})
               AND deleted_at IS NULL
             ORDER BY created_at ASC`,
          ).all(workspaceId, ...childrenIds) as { id: string }[])
        : [];

      if (liveChildren.length === 0) {
        // No live children — there is no candidate root. Drop the tree row,
        // but FIRST null out tree_id on any node still pointing at it
        // (including the trimmed node itself, which holds the snapshot we
        // need for restore). Without this, the trees.id FK CASCADE on
        // nodes.tree_id would physically delete those rows.
        db.prepare('UPDATE nodes SET tree_id = NULL WHERE workspace_id = ? AND tree_id = ?')
          .run(workspaceId, wasTreeRoot.treeId);
        db.prepare('DELETE FROM trees WHERE id = ?').run(wasTreeRoot.treeId);
      } else {
        const newRoot = liveChildren[0].id;
        // Promote newRoot — tree root carries parent_node_id = NULL.
        db.prepare('UPDATE nodes SET parent_node_id = NULL WHERE id = ?').run(newRoot);
        // Every other child (live or trashed) becomes a child of newRoot.
        const others = childrenIds.filter((id) => id !== newRoot);
        if (others.length > 0) {
          const ph = others.map(() => '?').join(',');
          db.prepare(`UPDATE nodes SET parent_node_id = ? WHERE id IN (${ph})`)
            .run(newRoot, ...others);
          // Add the (newRoot → other) branch edges that replace the dropped
          // (trimmed → other) edges. INSERT OR IGNORE handles re-runs and
          // any pre-existing edge from earlier graph shapes.
          const insert = db.prepare(
            `INSERT OR IGNORE INTO edges (id, workspace_id, source_node_id, target_node_id, kind)
             VALUES (?, ?, ?, ?, 'branch')`,
          );
          for (const oid of others) {
            insert.run(`branch-${newRoot}-${oid}`, workspaceId, newRoot, oid);
          }
        }
        db.prepare('UPDATE trees SET root_node_id = ? WHERE id = ?').run(newRoot, wasTreeRoot.treeId);
      }
    } else {
      // Normal trim: every child slides up to the trimmed node's old parent.
      if (childrenIds.length > 0) {
        const ph = childrenIds.map(() => '?').join(',');
        db.prepare(`UPDATE nodes SET parent_node_id = ? WHERE id IN (${ph})`)
          .run(x.parent_node_id, ...childrenIds);
        if (x.parent_node_id) {
          const insert = db.prepare(
            `INSERT OR IGNORE INTO edges (id, workspace_id, source_node_id, target_node_id, kind)
             VALUES (?, ?, ?, ?, 'branch')`,
          );
          for (const cid of childrenIds) {
            insert.run(`branch-${x.parent_node_id}-${cid}`, workspaceId, x.parent_node_id, cid);
          }
        }
      }
    }

    return { trimmed: 1 };
  });
}

/**
 * Undo a `trimNode`: put the node back where it came from. Mirrors the
 * algorithm in `trimNode` step-for-step, with one twist: the original parent
 * recorded in the snapshot may itself have been trimmed (or hard-purged) in
 * the meantime. The walk-up resolver follows the chain of `trim_snapshot`s
 * until it finds the nearest live ancestor, or `null` if every ancestor is
 * gone (the restored node becomes a tree root in that case).
 *
 * Children that are still live AND whose current parent is the resolved
 * target parent are re-stolen back under the restored node. Children that
 * have since been trashed, purged, or reparented further are left alone —
 * restore is intent-driven, not history-rewriting.
 *
 * Returns { restored: false } if there is no `trim_snapshot` on the node
 * (e.g. it was subtree-deleted, not trimmed) so callers know to fall back
 * to `restoreNode`.
 */
export function restoreTrimmedNode(
  workspaceId: string,
  nodeId: string,
): { restored: boolean } {
  return runInTransaction(() => {
    const db = getDb();

    const x = db.prepare(
      `SELECT id, trim_snapshot FROM nodes WHERE id = ? AND workspace_id = ?`,
    ).get(nodeId, workspaceId) as { id: string; trim_snapshot: string | null } | undefined;
    if (!x || !x.trim_snapshot) return { restored: false };

    const snap = JSON.parse(x.trim_snapshot) as TrimSnapshot;

    // Walk up: from snap.parentId, climb until we hit a live ancestor or run
    // out. Each hop prefers the ancestor's own trim_snapshot.parentId over
    // its current parent_node_id — that preserves the conceptual chain
    // ("under what I was originally under, transitively") instead of the
    // post-trim collapsed chain.
    let targetParent: string | null = snap.parentId;
    const seen = new Set<string>();
    while (targetParent) {
      if (seen.has(targetParent)) {
        // Defensive: should never loop, but if a corrupted snapshot points
        // back at itself, bail out and make the node a root.
        targetParent = null;
        break;
      }
      seen.add(targetParent);
      const p = db.prepare(
        `SELECT id, parent_node_id, deleted_at, trim_snapshot
         FROM nodes WHERE id = ? AND workspace_id = ?`,
      ).get(targetParent, workspaceId) as
        | { id: string; parent_node_id: string | null; deleted_at: number | null; trim_snapshot: string | null }
        | undefined;
      if (!p) { targetParent = null; break; }
      if (p.deleted_at === null) break;
      if (p.trim_snapshot) {
        targetParent = (JSON.parse(p.trim_snapshot) as TrimSnapshot).parentId;
      } else {
        // Subtree-deleted ancestor — its parent_node_id is the last known
        // structural parent; keep climbing.
        targetParent = p.parent_node_id;
      }
    }

    // Apply: restore X with the resolved parent and clear all trash markers.
    db.prepare(`UPDATE nodes
                SET parent_node_id = ?, deleted_at = NULL, deletion_group_id = NULL, trim_snapshot = NULL
                WHERE id = ?`)
      .run(targetParent, nodeId);

    // Re-steal: any snapshot child that's still live and currently parented
    // to the same target parent (i.e. it slid up to where X used to be)
    // moves back under X. Children that were trashed, purged, or reparented
    // further by another trim stay where they are.
    const liveStolenIds: string[] = [];
    if (snap.childrenIds.length > 0) {
      const childRows = db.prepare(
        `SELECT id, parent_node_id, deleted_at
         FROM nodes WHERE workspace_id = ? AND id IN (${snap.childrenIds.map(() => '?').join(',')})`,
      ).all(workspaceId, ...snap.childrenIds) as { id: string; parent_node_id: string | null; deleted_at: number | null }[];
      for (const c of childRows) {
        if (c.deleted_at !== null) continue;
        if (c.parent_node_id !== targetParent) continue;
        liveStolenIds.push(c.id);
      }
      if (liveStolenIds.length > 0) {
        const ph = liveStolenIds.map(() => '?').join(',');
        db.prepare(`UPDATE nodes SET parent_node_id = ? WHERE id IN (${ph})`)
          .run(nodeId, ...liveStolenIds);
      }
    }

    // Rewire edges in step with the new parent/child topology.
    if (targetParent) {
      db.prepare(
        `INSERT OR IGNORE INTO edges (id, workspace_id, source_node_id, target_node_id, kind)
         VALUES (?, ?, ?, ?, 'branch')`,
      ).run(`branch-${targetParent}-${nodeId}`, workspaceId, targetParent, nodeId);
      if (liveStolenIds.length > 0) {
        // Drop the (targetParent → stolen) bypass edges that trim added.
        const ph = liveStolenIds.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM edges WHERE workspace_id = ? AND source_node_id = ?
             AND target_node_id IN (${ph}) AND kind = 'branch'`,
        ).run(workspaceId, targetParent, ...liveStolenIds);
      }
    }
    if (liveStolenIds.length > 0) {
      const insert = db.prepare(
        `INSERT OR IGNORE INTO edges (id, workspace_id, source_node_id, target_node_id, kind)
         VALUES (?, ?, ?, ?, 'branch')`,
      );
      for (const cid of liveStolenIds) {
        insert.run(`branch-${nodeId}-${cid}`, workspaceId, nodeId, cid);
      }
    }

    // Tree-root restoration: re-seat the root pointer (or recreate the row
    // if trim dropped it because there were no live children at the time).
    if (snap.wasTreeRoot) {
      const tree = db.prepare('SELECT id FROM trees WHERE id = ? AND workspace_id = ?')
        .get(snap.wasTreeRoot.treeId, workspaceId);
      if (tree) {
        db.prepare('UPDATE trees SET root_node_id = ? WHERE id = ?')
          .run(nodeId, snap.wasTreeRoot.treeId);
      } else {
        const now = Date.now();
        db.prepare(
          `INSERT INTO trees (id, workspace_id, root_node_id, last_active_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(snap.wasTreeRoot.treeId, workspaceId, nodeId, now, now);
        // Trim cleared tree_id on the node when it dropped the tree (to
        // avoid the CASCADE wiping the snapshot row). Re-bind it now.
        db.prepare('UPDATE nodes SET tree_id = ? WHERE id = ?')
          .run(snap.wasTreeRoot.treeId, nodeId);
      }
    }

    return { restored: true };
  });
}

// --- Edge CRUD ---

export function listEdges(workspaceId: string, userId?: string): EdgeRow[] {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    return getDb().prepare(
      'SELECT e.* FROM edges e JOIN workspaces w ON e.workspace_id = w.id WHERE e.workspace_id = ? AND w.owner_user_id = ?'
    ).all(workspaceId, userId) as unknown as EdgeRow[];
  }
  return getDb().prepare('SELECT * FROM edges WHERE workspace_id = ?').all(workspaceId) as unknown as EdgeRow[];
}

export function saveEdge(edge: EdgeRow, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    const owned = getDb().prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?').get(edge.workspace_id, userId);
    if (!owned) return;
  }
  // Tombstone guard — refuse if either endpoint or the workspace is purged.
  if (
    isWorkspaceTombstoned(edge.workspace_id)
    || isNodeTombstoned(edge.source_node_id)
    || isNodeTombstoned(edge.target_node_id)
  ) return;
  getDb().prepare(`
    INSERT INTO edges (id, workspace_id, source_node_id, target_node_id, kind, anchor_message_id, created_at, rev)
    VALUES (@id, @workspace_id, @source_node_id, @target_node_id, @kind, @anchor_message_id, @created_at, @rev)
    ON CONFLICT(id) DO UPDATE SET
      source_node_id=excluded.source_node_id,
      target_node_id=excluded.target_node_id,
      kind=excluded.kind,
      anchor_message_id=excluded.anchor_message_id,
      created_at=excluded.created_at,
      rev=COALESCE(excluded.rev, edges.rev)
  `).run({ anchor_message_id: null, created_at: null, rev: null, ...edge });
}

export function deleteEdge(id: string, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    getDb().prepare(
      'DELETE FROM edges WHERE id = ? AND EXISTS (SELECT 1 FROM workspaces WHERE id = (SELECT workspace_id FROM edges WHERE id = ?) AND owner_user_id = ?)'
    ).run(id, id, userId);
    return;
  }
  getDb().prepare('DELETE FROM edges WHERE id = ?').run(id);
}

// --- Message CRUD ---

export function listMessages(nodeId: string, userId?: string): MessageRow[] {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    return getDb().prepare(
      'SELECT m.* FROM messages m JOIN nodes n ON m.node_id = n.id JOIN workspaces w ON n.workspace_id = w.id WHERE m.node_id = ? AND w.owner_user_id = ? ORDER BY m.seq ASC'
    ).all(nodeId, userId) as unknown as MessageRow[];
  }
  return getDb().prepare('SELECT * FROM messages WHERE node_id = ? ORDER BY seq ASC').all(nodeId) as unknown as MessageRow[];
}

export function saveMessage(msg: MessageRow, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    const owned = getDb().prepare(
      'SELECT 1 FROM nodes n JOIN workspaces w ON n.workspace_id = w.id WHERE n.id = ? AND w.owner_user_id = ?'
    ).get(msg.node_id, userId);
    if (!owned) return;
  }
  // Tombstone guard — messages can't outlive their owning node.
  if (isNodeTombstoned(msg.node_id)) return;
  getDb().prepare(`
    INSERT INTO messages (id, node_id, role, content, blocks, tool_calls, seq, created_at, rev)
    VALUES (@id, @node_id, @role, @content, @blocks, @tool_calls, @seq, @created_at, @rev)
    ON CONFLICT(id) DO UPDATE SET
      content=excluded.content,
      blocks=COALESCE(excluded.blocks, messages.blocks),
      tool_calls=COALESCE(excluded.tool_calls, messages.tool_calls),
      rev=COALESCE(excluded.rev, messages.rev)
  `).run({ blocks: null, tool_calls: null, rev: null, ...msg });
}

export function getMessageCount(nodeId: string, userId?: string): number {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    const row = getDb().prepare(
      'SELECT COUNT(*) as cnt FROM messages m JOIN nodes n ON m.node_id = n.id JOIN workspaces w ON n.workspace_id = w.id WHERE m.node_id = ? AND w.owner_user_id = ?'
    ).get(nodeId, userId) as unknown as { cnt: number };
    return row.cnt;
  }
  const row = getDb().prepare('SELECT COUNT(*) as cnt FROM messages WHERE node_id = ?').get(nodeId) as unknown as { cnt: number };
  return row.cnt;
}

// --- Context CRUD ---

export function listContexts(workspaceId: string, userId?: string): ContextRow[] {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    return getDb().prepare(
      'SELECT c.* FROM contexts c JOIN workspaces w ON c.workspace_id = w.id WHERE c.workspace_id = ? AND w.owner_user_id = ? ORDER BY c.created_at ASC'
    ).all(workspaceId, userId) as unknown as ContextRow[];
  }
  return getDb().prepare('SELECT * FROM contexts WHERE workspace_id = ? ORDER BY created_at ASC').all(workspaceId) as unknown as ContextRow[];
}

export function saveContext(ctx: ContextRow, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    const owned = getDb().prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?').get(ctx.workspace_id, userId);
    if (!owned) return;
  }
  // Tombstone guard — contexts inside a purged workspace stay purged.
  if (isWorkspaceTombstoned(ctx.workspace_id)) return;
  getDb().prepare(`
    INSERT INTO contexts (id, workspace_id, name, file_path, size, auto_inject, source, created_at, updated_at, rev)
    VALUES (@id, @workspace_id, @name, @file_path, @size, @auto_inject, @source, @created_at, @updated_at, @rev)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, file_path=excluded.file_path, size=excluded.size, auto_inject=excluded.auto_inject,
      source=excluded.source, updated_at=excluded.updated_at,
      rev=COALESCE(excluded.rev, contexts.rev)
  `).run({ ...ctx, size: ctx.size ?? null, rev: ctx.rev ?? null });
}

export function deleteContext(id: string, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    getDb().prepare(
      'DELETE FROM contexts WHERE id = ? AND EXISTS (SELECT 1 FROM workspaces WHERE id = (SELECT workspace_id FROM contexts WHERE id = ?) AND owner_user_id = ?)'
    ).run(id, id, userId);
    return;
  }
  getDb().prepare('DELETE FROM contexts WHERE id = ?').run(id);
}

// --- Bulk loaders ---

export function loadFullWorkspace(id: string, userId?: string): FullWorkspaceData | null {
  const workspace = getWorkspace(id, userId);
  if (!workspace) return null;
  const trees = listTrees(id, userId);
  const nodes = listNodes(id, userId);
  const edges = listEdges(id, userId);
  const nodeIds = nodes.map(n => n.id);
  let messages: MessageRow[] = [];
  if (nodeIds.length > 0) {
    // Batch load messages for all nodes in this workspace
    const placeholders = nodeIds.map(() => '?').join(',');
    messages = getDb().prepare(
      `SELECT * FROM messages WHERE node_id IN (${placeholders}) ORDER BY seq ASC`
    ).all(...nodeIds) as unknown as MessageRow[];
  }
  const contexts = listContexts(id, userId);
  return { workspace, trees, nodes, edges, messages, contexts };
}

export function loadAllWorkspaces(userId?: string): FullWorkspaceData[] {
  const workspaces = listWorkspaces(userId);
  return workspaces.map(ws => loadFullWorkspace(ws.id, userId)).filter((d): d is FullWorkspaceData => d !== null);
}

// --- Bulk sync (reconcile) ---

/**
 * Tables that carry a per-row `rev` and participate in the sync conflict guard.
 * The literal-union type doubles as the runtime whitelist for `readRowRev` /
 * `loadRowById`: the table name is ALWAYS one of these (it comes from our own
 * code, never from user input), so interpolating it into SQL is safe.
 */
export type RevTable = 'nodes' | 'edges' | 'messages' | 'trees' | 'contexts';

/**
 * Bump a workspace's monotonic `sync_rev` by one and return the new value.
 *
 * MUST be a bare UPDATE — `runInTransaction` (db.ts) uses a non-nestable
 * `BEGIN`, and the sync txn is already open when this is called from inside
 * `syncWorkspaceState` / `syncWorkspaceDelta`. Do NOT wrap in runInTransaction.
 *
 * Uses RETURNING when available (better-sqlite3 / modern SQLite); a guard reads
 * back via SELECT so the helper is robust even if RETURNING isn't honoured.
 * Returns 0 if the workspace row is absent (nothing to bump / stamp).
 */
export function bumpWorkspaceRev(wsId: string): number {
  const db = getDb();
  const updated = db
    .prepare('UPDATE workspaces SET sync_rev = sync_rev + 1 WHERE id = ? RETURNING sync_rev')
    .get(wsId) as { sync_rev: number } | undefined;
  if (updated && typeof updated.sync_rev === 'number') return updated.sync_rev;
  // Fallback: the UPDATE either didn't return a row (RETURNING unsupported) or
  // the row is absent. Re-read to distinguish.
  const row = db
    .prepare('SELECT sync_rev FROM workspaces WHERE id = ?')
    .get(wsId) as { sync_rev: number } | undefined;
  return row?.sync_rev ?? 0;
}

/**
 * Read the stored `rev` of a single row **within the given workspace**, or null
 * if the row is absent (or its rev is NULL — legacy / never-synced).
 *
 * The `workspaceId` scope is security-critical in cloud mode: without it a
 * payload containing a foreign row id would read the other tenant's rev and
 * potentially expose it in `conflicts[].serverRow`. Scoping to the workspace
 * means a foreign id is invisible here → `readRowRev` returns null →
 * `accepts(null, …)` = true → the write is attempted and harmlessly no-op'd by
 * the leaf save's owner guard → `loadRowById` is never reached → no data leak.
 *
 * Table name is whitelisted via the `RevTable` type; never user input.
 * `messages` has no `workspace_id` column, so it uses a node subquery.
 */
export function readRowRev(table: RevTable, workspaceId: string, id: string): number | null {
  const db = getDb();
  let row: { rev: number | null } | undefined;
  if (table === 'messages') {
    row = db
      .prepare(
        'SELECT rev FROM messages WHERE id = ? AND node_id IN (SELECT id FROM nodes WHERE workspace_id = ?)',
      )
      .get(id, workspaceId) as { rev: number | null } | undefined;
  } else {
    row = db
      .prepare(`SELECT rev FROM ${table} WHERE id = ? AND workspace_id = ?`)
      .get(id, workspaceId) as { rev: number | null } | undefined;
  }
  return row?.rev ?? null;
}

/**
 * Load a full row by id **within the given workspace** for the `serverRow` of a
 * conflict. Workspace-scoping prevents returning another tenant's row.
 * Table name is whitelisted via `RevTable`; never user input.
 * `messages` uses the node subquery (no direct `workspace_id` column).
 */
export function loadRowById(table: RevTable, workspaceId: string, id: string): unknown {
  const db = getDb();
  if (table === 'messages') {
    return (
      db
        .prepare(
          'SELECT * FROM messages WHERE id = ? AND node_id IN (SELECT id FROM nodes WHERE workspace_id = ?)',
        )
        .get(id, workspaceId) ?? null
    );
  }
  return (
    db
      .prepare(`SELECT * FROM ${table} WHERE id = ? AND workspace_id = ?`)
      .get(id, workspaceId) ?? null
  );
}

/**
 * Server-authoritative conflict decision for a single row.
 *
 *   storedRev == null → accept (legacy / never-synced: no spurious conflict on
 *                       the first sync after the migration).
 *   baseRev   == null → accept (client has no claim on this id — a new row).
 *   else              → accept iff storedRev <= baseRev. A stale client whose
 *                       baseRev is behind the stored rev (storedRev > baseRev)
 *                       is a CONFLICT and its write is dropped (server wins).
 */
export function accepts(storedRev: number | null, baseRev: number | null | undefined): boolean {
  if (storedRev == null) return true;
  if (baseRev == null) return true;
  return storedRev <= baseRev;
}

/** A row whose client write was rejected because the client's base rev was
 *  behind the server's stored rev. The server's current row wins; the client
 *  resolves using `serverRow`. */
export interface SyncConflict {
  id: string;
  table: RevTable;
  serverRow: unknown;
}

/**
 * Result of a sync path. Tombstoned workspaces short-circuit (no rev bump, no
 * writes); otherwise the workspace's `sync_rev` was bumped once to `newRev`,
 * every accepted row stamped with it, and any rejected (stale) rows collected
 * into `conflicts`.
 */
export type SyncResult =
  | { tombstoned: true }
  | { tombstoned: false; newRev: number; conflicts: SyncConflict[] };

export interface SyncWorkspacePayload {
  workspace?: WorkspaceRow | null;
  trees?: TreeRow[];
  nodes?: NodeRow[];
  edges?: EdgeRow[];
  messages?: MessageRow[];
  contexts?: ContextRow[];
  /**
   * Per-row last-seen `rev` the client is writing against, keyed by row id
   * (messages keyed by their DERIVED id — see normalizeIncomingMessageRow).
   * A sibling map, NOT embedded in the row objects (keeps row serialization
   * byte-identical so delta and full paths converge). Absent / null entry =
   * "no claim" → unconditional accept. See `accepts`.
   */
  baseRevs?: Record<string, number | null>;
  /**
   * The workspace `sync_rev` the client last observed (its hydration/last-ack
   * value). Guards reconcile-delete (delete-by-absence): only a client that has
   * seen every prior change may authoritatively delete a live row by omitting
   * it. If the stored sync_rev has advanced past `baseSyncRev`, the client is
   * STALE and ALL by-absence deletes are suppressed this sync — a stale
   * full-sync self-heal must never physically destroy a peer's live row (H2).
   *
   * Upserts (rev-guarded by `accepts`) and explicit deletes are unaffected.
   * Absent / null = "fresh" → reconcile-delete runs as before (backward-compat;
   * single-writer always omits or is current, so its behavior is unchanged).
   */
  baseSyncRev?: number | null;
}

/**
 * Reconcile a workspace's structural rows against a full-snapshot payload from
 * the frontend. This replaces the old "blind DELETE everything + reinsert"
 * sync path: we upsert every payload row, then delete only the rows that exist
 * in the DB but are ABSENT from the payload. Happy-path results are identical
 * to the wholesale-replace approach, but we no longer destructively wipe rows
 * we are about to re-write.
 *
 * Anti-revival bedrock is preserved:
 *   - If the workspace itself is tombstoned (`purged_at` set) the whole call is
 *     a no-op (returns `{ tombstoned: true }`), so a stale snapshot from another tab can't
 *     reach in and rewrite structural rows.
 *   - Reconcile-delete of nodes is scoped to `purged_at IS NULL`; tombstoned
 *     node rows are never physically removed (that would defeat the guard).
 *   - The upsert leaf functions (saveNode/saveEdge/…) already refuse to revive
 *     tombstoned ids, so a payload containing a purged id is silently ignored.
 *
 * Per-entity reconcile only runs when that payload array is provided
 * (Array.isArray), mirroring the route's existing guards. A provided-but-empty
 * array means "no rows of this kind" → all live rows of that kind are
 * reconciled away, matching the old wipe-then-reinsert semantics.
 *
 * `PRAGMA defer_foreign_keys = ON` is kept (deferred to a later phase): it lets
 * the upserts/deletes happen in any order within the txn, with all FKs still
 * verified at COMMIT.
 *
 * @returns On a live workspace, `{ tombstoned: false, newRev, conflicts }`:
 *          the bumped `sync_rev` plus any rows whose client baseRev was stale
 *          (their writes were dropped, server values preserved). On a
 *          tombstoned workspace, `{ tombstoned: true }` (no rev bump, no write).
 */
export function syncWorkspaceState(
  workspaceId: string,
  payload: SyncWorkspacePayload,
  userId?: string,
): SyncResult {
  const { workspace, trees, nodes, edges, messages, contexts } = payload;
  const baseRevs = payload.baseRevs;
  const db = getDb();

  // Phase 3 anti-revival: if the workspace itself is tombstoned, the entire
  // sync is a no-op. Without this a stale snapshot from another tab would
  // still try to reach into the table and rewrite structural rows.
  const ws = db.prepare(
    'SELECT purged_at FROM workspaces WHERE id = ?',
  ).get(workspaceId) as { purged_at: number | null } | undefined;
  if (ws && ws.purged_at !== null) {
    return { tombstoned: true };
  }

  // Hoisted out of the txn callback so the post-commit return can read them.
  // `R` is the freshly bumped sync_rev every accepted row is stamped with;
  // `conflicts` collects rows whose client baseRev was behind the stored rev.
  let R = 0;
  const conflicts: SyncConflict[] = [];

  // Kill switch: MICHI_SYNC_CONFLICTS=0 → accept-all (L1b fallback), keeping
  // bump + stamp so re-enabling is seamless. Default ON (enforcement active).
  const enforce = process.env.MICHI_SYNC_CONFLICTS !== '0';

  runInTransaction(() => {
    // Defer FK checks to commit time. Reconcile reorders inserts/deletes
    // freely (children before parents, nodes before their edges, etc.); the
    // immediate-FK check on parent_node_id / source/target would otherwise
    // fail mid-statement. All FKs are still verified at COMMIT.
    db.exec('PRAGMA defer_foreign_keys = ON');

    if (workspace) {
      // Stamp owner_user_id on INSERT; saveWorkspace's COALESCE preserves the
      // existing owner on UPDATE, so passing userId here is harmless for
      // updates and load-bearing for inserts.
      saveWorkspace({
        ...workspace,
        id: workspaceId,
        owner_user_id: process.env.MICHI_CLOUD === '1' ? (userId ?? null) : null,
      });
    }

    // Bump the workspace rev ONCE per sync txn (after saveWorkspace so the row
    // exists). Every accepted upsert below is stamped with R; the per-row guard
    // (accepts) compares the row's STORED rev against the client's baseRev.
    R = bumpWorkspaceRev(workspaceId);

    // Freshness gate for reconcile-delete (H2). `R` is the post-bump rev, so the
    // workspace's pre-bump rev — the latest state this sync could have known
    // about — is `R - 1`. The client is FRESH iff the rev it last observed is
    // not behind that: any peer write since `baseSyncRev` advanced the stored
    // rev past it. A stale client must NOT delete-by-absence (it would destroy a
    // live row a peer added but this client never saw). Absent/null baseSyncRev
    // = fresh (backward-compat: single-writer + every pre-H2 caller). Upserts
    // and explicit reconcile are unaffected — only delete-by-absence is gated.
    const baseSyncRev = payload.baseSyncRev;
    const fresh = baseSyncRev == null || baseSyncRev >= R - 1;

    // --- Upsert all payload rows via the existing repo functions ---
    // Each row is guarded: accept (and stamp rev = R) iff the client's baseRev
    // is not behind the stored rev; otherwise drop the write and record a
    // conflict carrying the server's current row. Reconcile-delete below is
    // intentionally NOT guarded (absence is authoritative); a conflicted row's
    // id is still in the payload id-set so reconcile-delete leaves it in place.
    // When `enforce` is false (kill switch) every row is accepted; rev is still
    // stamped and conflicts stays empty.
    if (Array.isArray(trees)) {
      trees.forEach((t: TreeRow) => {
        if (!enforce || accepts(readRowRev('trees', workspaceId, t.id), baseRevs?.[t.id])) saveTree({ ...t, rev: R }, userId);
        else conflicts.push({ id: t.id, table: 'trees', serverRow: loadRowById('trees', workspaceId, t.id) });
      });
    }
    if (Array.isArray(nodes)) {
      nodes.forEach((n: NodeRow) => {
        if (!enforce || accepts(readRowRev('nodes', workspaceId, n.id), baseRevs?.[n.id])) saveNode({ ...n, rev: R }, userId);
        else conflicts.push({ id: n.id, table: 'nodes', serverRow: loadRowById('nodes', workspaceId, n.id) });
      });
    }
    if (Array.isArray(edges)) {
      edges.forEach((e: EdgeRow) => {
        if (!enforce || accepts(readRowRev('edges', workspaceId, e.id), baseRevs?.[e.id])) saveEdge({ ...e, rev: R }, userId);
        else conflicts.push({ id: e.id, table: 'edges', serverRow: loadRowById('edges', workspaceId, e.id) });
      });
    }
    if (Array.isArray(messages)) {
      messages.forEach((m: MessageRow, seq: number) => {
        // Derive the message row ONCE; its id is the table PK and the baseRevs
        // key, reused for both the guard lookup and the save.
        const row = normalizeIncomingMessageRow(m as unknown as Record<string, unknown>, String(m.node_id ?? ''), seq);
        if (!enforce || accepts(readRowRev('messages', workspaceId, row.id), baseRevs?.[row.id])) saveMessage({ ...row, rev: R }, userId);
        else conflicts.push({ id: row.id, table: 'messages', serverRow: loadRowById('messages', workspaceId, row.id) });
      });
    }
    if (Array.isArray(contexts)) {
      contexts.forEach((c: ContextRow) => {
        if (!enforce || accepts(readRowRev('contexts', workspaceId, c.id), baseRevs?.[c.id])) saveContext({ ...c, rev: R }, userId);
        else conflicts.push({ id: c.id, table: 'contexts', serverRow: loadRowById('contexts', workspaceId, c.id) });
      });
    }

    // --- Reconcile-delete: remove rows in the DB but absent from the payload ---
    // GATED on `fresh` (H2): a stale client's absence is NOT authoritative —
    // suppressing these deletes preserves a peer's live rows the client never
    // saw. A fresh client (or any pre-H2 caller that omits baseSyncRev) runs the
    // full reconcile exactly as before. Upserts above already ran regardless.
    if (fresh) {
      // Nodes: live (purged_at IS NULL) DB ids minus payload ids. NEVER touch a
      // tombstoned row. Also drop the deleted nodes' messages (FK).
      if (Array.isArray(nodes)) {
        const payloadNodeIds = new Set(nodes.map((n) => n.id));
        const toDeleteNodeIds = listNodes(workspaceId, userId)
          .map((n) => n.id)
          .filter((id) => !payloadNodeIds.has(id));
        if (toDeleteNodeIds.length > 0) {
          const ph = toDeleteNodeIds.map(() => '?').join(',');
          db.prepare(`DELETE FROM messages WHERE node_id IN (${ph})`).run(...toDeleteNodeIds);
          db.prepare(
            `DELETE FROM nodes WHERE id IN (${ph}) AND workspace_id = ? AND purged_at IS NULL`,
          ).run(...toDeleteNodeIds, workspaceId);
        }
      }

      // Messages of KEPT nodes: for nodes still present after the node-reconcile,
      // drop messages whose id is not in the payload's message-id set. Mirrors
      // the old "delete all then reinsert kept" but only removes truly-gone rows.
      if (Array.isArray(messages)) {
        const payloadMessageIds = messages
          .map((m, seq) =>
            normalizeIncomingMessageRow(m as unknown as Record<string, unknown>, String(m.node_id ?? ''), seq).id,
          );
        const keptNodeSelect =
          'SELECT id FROM nodes WHERE workspace_id = ? AND purged_at IS NULL';
        if (payloadMessageIds.length > 0) {
          const ph = payloadMessageIds.map(() => '?').join(',');
          db.prepare(
            `DELETE FROM messages
             WHERE node_id IN (${keptNodeSelect}) AND id NOT IN (${ph})`,
          ).run(workspaceId, ...payloadMessageIds);
        } else {
          // empty messages payload → wipe all messages of kept nodes (matches provided-but-empty = wipe semantics)
          db.prepare(
            `DELETE FROM messages WHERE node_id IN (${keptNodeSelect})`,
          ).run(workspaceId);
        }
      }

      // Edges: live DB ids minus payload ids.
      if (Array.isArray(edges)) {
        const payloadEdgeIds = new Set(edges.map((e) => e.id));
        const toDeleteEdgeIds = listEdges(workspaceId, userId)
          .map((e) => e.id)
          .filter((id) => !payloadEdgeIds.has(id));
        if (toDeleteEdgeIds.length > 0) {
          const ph = toDeleteEdgeIds.map(() => '?').join(',');
          db.prepare(
            `DELETE FROM edges WHERE id IN (${ph}) AND workspace_id = ?`,
          ).run(...toDeleteEdgeIds, workspaceId);
        }
      }

      // Trees: live DB ids minus payload ids.
      if (Array.isArray(trees)) {
        const payloadTreeIds = new Set(trees.map((t) => t.id));
        const toDeleteTreeIds = listTrees(workspaceId, userId)
          .map((t) => t.id)
          .filter((id) => !payloadTreeIds.has(id));
        if (toDeleteTreeIds.length > 0) {
          const ph = toDeleteTreeIds.map(() => '?').join(',');
          db.prepare(
            `DELETE FROM trees WHERE id IN (${ph}) AND workspace_id = ?`,
          ).run(...toDeleteTreeIds, workspaceId);
        }
      }

      // Contexts: live DB ids minus payload ids.
      if (Array.isArray(contexts)) {
        const payloadContextIds = new Set(contexts.map((c) => c.id));
        const toDeleteContextIds = listContexts(workspaceId, userId)
          .map((c) => c.id)
          .filter((id) => !payloadContextIds.has(id));
        if (toDeleteContextIds.length > 0) {
          const ph = toDeleteContextIds.map(() => '?').join(',');
          db.prepare(
            `DELETE FROM contexts WHERE id IN (${ph}) AND workspace_id = ?`,
          ).run(...toDeleteContextIds, workspaceId);
        }
      }
    }
  });

  return { tombstoned: false, newRev: R, conflicts };
}

// --- Bulk sync (incremental delta) ---

export interface SyncWorkspaceDelta {
  workspace?: WorkspaceRow | null;
  upserts?: {
    trees?: TreeRow[];
    nodes?: NodeRow[];
    edges?: EdgeRow[];
    // Grouped-by-node on the client: the FULL set of each dirty node's
    // messages. The id set per node is authoritative for that node only.
    messages?: MessageRow[];
    contexts?: ContextRow[];
  };
  deletes?: {
    edges?: string[];
    trees?: string[];
    contexts?: string[];
    // NOTE: intentionally NO `nodes` — node removal stays on the trash/purge
    // endpoints (anti-revival). Deleting nodes here would let a stale delta
    // physically drop rows that the tombstone bedrock is meant to protect.
  };
  /**
   * Explicit per-node message-reconcile authority list. The frontend MUST
   * include a node id here whenever this delta is authoritative for that
   * node's FULL message set — including when the set has dropped to zero
   * (which a flat `upserts.messages` array alone cannot express: an empty
   * or absent array is ambiguous between "no messages changed" and "all
   * messages removed").
   *
   * Reconcile node set = (nodes that appear in `upserts.messages`)
   *                    ∪ (this array, if provided).
   *
   * For each node in that union: delete every DB message for that node
   * whose derived id is NOT in the delta's message-id set for that node.
   * A node listed here but absent from `upserts.messages` has an empty
   * id-set ⇒ ALL of its messages are deleted.
   *
   * Backward-compat: if this field is absent the behaviour is unchanged —
   * only nodes present in `upserts.messages` are reconciled.
   */
  messageReconcileNodeIds?: string[];
  /**
   * Per-row last-seen `rev` the client is writing against, keyed by row id
   * (messages keyed by their DERIVED id — see normalizeIncomingMessageRow).
   * Sibling map identical in shape to the full path's `baseRevs`. Deletes need
   * no baseRev (they are not guarded). Absent / null entry = "no claim". */
  baseRevs?: Record<string, number | null>;
}

/**
 * Apply an INCREMENTAL delta to a workspace's structural rows. This is the
 * counterpart to `syncWorkspaceState` (the full-snapshot reconcile): instead
 * of comparing the whole DB against a whole snapshot, the client sends only
 * what changed — upserts for dirty rows, explicit id lists for removals, and
 * the full message set for each dirty node.
 *
 * The delta is designed to CONVERGE with the full path: applying a delta that
 * represents one change produces exactly the same DB state as a full sync of
 * the post-change snapshot would. We achieve this by reusing the SAME leaf
 * save fns, the SAME message-id derivation (`normalizeIncomingMessageRow`),
 * and the SAME per-node message-reconcile shape the full path uses for kept
 * nodes — just scoped to the nodes the delta actually mentions.
 *
 * Differences from the full path (by design — that's what makes it a delta):
 *   - We do NOT reconcile-delete nodes/edges/trees/contexts that are simply
 *     absent. Absence in a delta means "unchanged", not "deleted". Removals
 *     are explicit (`deletes.*`) — except nodes, which are never deleted here.
 *   - Per-node message reconcile runs for the UNION of nodes that appear in
 *     `upserts.messages` AND nodes listed in `messageReconcileNodeIds`. A node
 *     listed in `messageReconcileNodeIds` but absent from `upserts.messages`
 *     has an empty authority set → all its messages are deleted. If
 *     `messageReconcileNodeIds` is absent, only nodes in `upserts.messages`
 *     are reconciled (backward-compat). Messages of nodes in neither set are
 *     untouched.
 *
 * Anti-revival bedrock is identical to the full path:
 *   - Tombstoned WORKSPACE → whole call is a no-op (`{ tombstoned: true }`).
 *   - The leaf save fns refuse to revive tombstoned ids, so a delta carrying a
 *     purged id is silently ignored.
 *   - Nodes are never physically deleted here at all.
 *
 * @returns On a live workspace, `{ tombstoned: false, newRev, conflicts }`
 *          (same shape as the full path). On a tombstoned workspace,
 *          `{ tombstoned: true }`. The rev is bumped once even for a
 *          delete-only delta (sync_rev is the L3 clock).
 */
export function syncWorkspaceDelta(
  workspaceId: string,
  delta: SyncWorkspaceDelta,
  userId?: string,
): SyncResult {
  const { workspace, upserts, deletes } = delta;
  const baseRevs = delta.baseRevs;
  const db = getDb();

  // Anti-revival: same workspace-tombstone short-circuit as syncWorkspaceState.
  // Read purged_at inline (not isWorkspaceTombstoned) so a non-existent row —
  // a brand-new workspace's first delta — falls through and is created below.
  const ws = db.prepare(
    'SELECT purged_at FROM workspaces WHERE id = ?',
  ).get(workspaceId) as { purged_at: number | null } | undefined;
  if (ws && ws.purged_at !== null) {
    return { tombstoned: true };
  }

  // Hoisted out of the txn callback so the post-commit return can read them.
  let R = 0;
  const conflicts: SyncConflict[] = [];

  // Kill switch: MICHI_SYNC_CONFLICTS=0 → accept-all (L1b fallback), keeping
  // bump + stamp so re-enabling is seamless. Default ON (enforcement active).
  const enforce = process.env.MICHI_SYNC_CONFLICTS !== '0';

  runInTransaction(() => {
    // Defer FK checks to commit time, matching the full path: a delta may carry
    // an edge before its node, or messages before their node, in any order.
    db.exec('PRAGMA defer_foreign_keys = ON');

    if (workspace) {
      // Stamp owner_user_id on INSERT; saveWorkspace's COALESCE preserves the
      // existing owner on UPDATE. Identical to the full path.
      saveWorkspace({
        ...workspace,
        id: workspaceId,
        owner_user_id: process.env.MICHI_CLOUD === '1' ? (userId ?? null) : null,
      });
    }

    // Bump the workspace rev ONCE per sync txn (after saveWorkspace so the row
    // exists), even when this delta carries only deletes — sync_rev is the L3
    // clock and must advance on every applied delta. Every accepted upsert is
    // stamped with R; the message-reconcile + explicit-deletes below are
    // authoritative and intentionally NOT guarded.
    R = bumpWorkspaceRev(workspaceId);

    // --- Upserts via the existing leaf save fns (Array.isArray-gated) ---
    // Each row is guarded by accepts(stored, baseRev); accepted rows are
    // stamped rev = R, rejected rows are dropped and recorded as conflicts.
    // When `enforce` is false (kill switch) every row is accepted; rev is still
    // stamped and conflicts stays empty.
    if (Array.isArray(upserts?.trees)) {
      upserts!.trees!.forEach((t: TreeRow) => {
        if (!enforce || accepts(readRowRev('trees', workspaceId, t.id), baseRevs?.[t.id])) saveTree({ ...t, rev: R }, userId);
        else conflicts.push({ id: t.id, table: 'trees', serverRow: loadRowById('trees', workspaceId, t.id) });
      });
    }
    if (Array.isArray(upserts?.nodes)) {
      upserts!.nodes!.forEach((n: NodeRow) => {
        if (!enforce || accepts(readRowRev('nodes', workspaceId, n.id), baseRevs?.[n.id])) saveNode({ ...n, rev: R }, userId);
        else conflicts.push({ id: n.id, table: 'nodes', serverRow: loadRowById('nodes', workspaceId, n.id) });
      });
    }
    if (Array.isArray(upserts?.edges)) {
      upserts!.edges!.forEach((e: EdgeRow) => {
        if (!enforce || accepts(readRowRev('edges', workspaceId, e.id), baseRevs?.[e.id])) saveEdge({ ...e, rev: R }, userId);
        else conflicts.push({ id: e.id, table: 'edges', serverRow: loadRowById('edges', workspaceId, e.id) });
      });
    }
    if (Array.isArray(upserts?.messages)) {
      upserts!.messages!.forEach((m: MessageRow, seq: number) => {
        // Derive the message row ONCE; its id is the table PK and the baseRevs
        // key, reused for both the guard lookup and the save (same id the
        // per-node message reconcile below derives).
        const row = normalizeIncomingMessageRow(m as unknown as Record<string, unknown>, String(m.node_id ?? ''), seq);
        if (!enforce || accepts(readRowRev('messages', workspaceId, row.id), baseRevs?.[row.id])) saveMessage({ ...row, rev: R }, userId);
        else conflicts.push({ id: row.id, table: 'messages', serverRow: loadRowById('messages', workspaceId, row.id) });
      });
    }
    if (Array.isArray(upserts?.contexts)) {
      upserts!.contexts!.forEach((c: ContextRow) => {
        if (!enforce || accepts(readRowRev('contexts', workspaceId, c.id), baseRevs?.[c.id])) saveContext({ ...c, rev: R }, userId);
        else conflicts.push({ id: c.id, table: 'contexts', serverRow: loadRowById('contexts', workspaceId, c.id) });
      });
    }

    // --- Per-dirty-node message reconcile ---
    // Reconcile node set = (nodes in upserts.messages) ∪ (messageReconcileNodeIds).
    // messageReconcileNodeIds lets the client mark a node authoritative even
    // when its message set is NOW empty — something a flat messages array alone
    // cannot express. For each node in the union: delete DB messages whose
    // derived id is absent from the delta's id set for that node. An empty id
    // set (node listed in messageReconcileNodeIds but absent from
    // upserts.messages) means "this node now has zero messages" → wipe all.
    //
    // NOTE on id derivation: the backend fallback format is `${nodeId}-msg-${seq}`
    // (see normalizeIncomingMessageRow). The frontend hydration fallback uses
    // `${nodeId}-${seq}` — a different format. They are harmless today because
    // explicit ids dominate in practice, but do NOT silently "fix" one side
    // without updating the other.
    //
    // Defense-in-depth: every DELETE is workspace-scoped via a subquery on
    // nodes.workspace_id, matching the full path's structural pattern and making
    // this function self-defending even without the route's ownership gate.
    {
      // Build id-set map from upserts.messages (empty map if no messages array).
      const idsByNode = new Map<string, string[]>();
      if (Array.isArray(upserts?.messages)) {
        upserts!.messages!.forEach((m: MessageRow, seq: number) => {
          const nodeId = String(m.node_id ?? '');
          const derived = normalizeIncomingMessageRow(m as unknown as Record<string, unknown>, nodeId, seq);
          const list = idsByNode.get(derived.node_id) ?? [];
          list.push(derived.id);
          idsByNode.set(derived.node_id, list);
        });
      }

      // Union with messageReconcileNodeIds: any node listed there that is not
      // already in the map gets an empty id-set (meaning "wipe all messages").
      if (Array.isArray(delta.messageReconcileNodeIds)) {
        for (const nodeId of delta.messageReconcileNodeIds) {
          if (!idsByNode.has(nodeId)) {
            idsByNode.set(nodeId, []);
          }
        }
      }

      const wsScope = 'SELECT id FROM nodes WHERE workspace_id = ?';
      for (const [nodeId, ids] of idsByNode) {
        if (ids.length > 0) {
          const ph = ids.map(() => '?').join(',');
          db.prepare(
            `DELETE FROM messages WHERE node_id = ? AND node_id IN (${wsScope}) AND id NOT IN (${ph})`,
          ).run(nodeId, workspaceId, ...ids);
        } else {
          // Empty id set ⇒ this node now has zero messages → wipe all.
          // Reachable when a node appears in messageReconcileNodeIds but has
          // no entries in upserts.messages (trim-to-empty flow).
          db.prepare(
            `DELETE FROM messages WHERE node_id = ? AND node_id IN (${wsScope})`,
          ).run(nodeId, workspaceId);
        }
      }
    }

    // --- Explicit deletes (Array.isArray-gated) ---
    // We use plain workspace-scoped DELETEs rather than the deleteEdge/
    // deleteTree/deleteContext leaf helpers. The leaf helpers do the same
    // physical `DELETE FROM <t> WHERE id=?` (no cascades/reparenting beyond
    // standard FK), but in cloud mode they re-derive ownership per id via a
    // correlated subquery. The full reconcile path instead deletes with a
    // single `... WHERE id IN (...) AND workspace_id=?`. We mirror the full
    // path exactly so a delete-via-delta and a delete-via-omission in a full
    // sync converge to identical DB state, and the `workspace_id` guard keeps
    // a delta from ever reaching across workspace boundaries. NEVER delete
    // nodes here (see SyncWorkspaceDelta.deletes — anti-revival).
    if (Array.isArray(deletes?.edges) && deletes!.edges!.length > 0) {
      const ids = deletes!.edges!;
      const ph = ids.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM edges WHERE id IN (${ph}) AND workspace_id = ?`,
      ).run(...ids, workspaceId);
    }
    if (Array.isArray(deletes?.trees) && deletes!.trees!.length > 0) {
      const ids = deletes!.trees!;
      const ph = ids.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM trees WHERE id IN (${ph}) AND workspace_id = ?`,
      ).run(...ids, workspaceId);
    }
    if (Array.isArray(deletes?.contexts) && deletes!.contexts!.length > 0) {
      const ids = deletes!.contexts!;
      const ph = ids.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM contexts WHERE id IN (${ph}) AND workspace_id = ?`,
      ).run(...ids, workspaceId);
    }
  });

  return { tombstoned: false, newRev: R, conflicts };
}

// --- aiGlobalContext toggle (stored inside workspaces.settings JSON) ---

export function getAiGlobalContext(workspaceId: string, userId?: string): boolean {
  let sql = 'SELECT settings FROM workspaces WHERE id = ?';
  const params: string[] = [workspaceId];
  if (process.env.MICHI_CLOUD === '1' && userId) {
    sql += ' AND owner_user_id = ?';
    params.push(userId);
  }
  const row = getDb().prepare(sql).get(...params as [string, ...string[]]) as { settings: string | null } | undefined;
  if (!row?.settings) return true; // default ON
  try {
    const parsed = JSON.parse(row.settings) as Record<string, unknown>;
    return parsed.aiGlobalContext !== false; // default ON unless explicitly false
  } catch {
    return true;
  }
}

export function setAiGlobalContext(workspaceId: string, on: boolean, userId?: string): void {
  const db = getDb();
  let sql = 'SELECT settings FROM workspaces WHERE id = ?';
  const params: string[] = [workspaceId];
  if (process.env.MICHI_CLOUD === '1' && userId) {
    sql += ' AND owner_user_id = ?';
    params.push(userId);
  }
  const row = db.prepare(sql).get(...params as [string, ...string[]]) as { settings: string | null } | undefined;
  let parsed: Record<string, unknown> = {};
  if (row?.settings) {
    try {
      parsed = JSON.parse(row.settings) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  // If cloud mode and userId was given, row will be null for non-owned workspaces — no-op.
  if (!row && process.env.MICHI_CLOUD === '1' && userId) return;
  parsed.aiGlobalContext = on;
  const serialized = JSON.stringify(parsed);
  if (process.env.MICHI_CLOUD === '1' && userId) {
    db.prepare('UPDATE workspaces SET settings = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?')
      .run(serialized, Date.now(), workspaceId, userId);
  } else {
    db.prepare('UPDATE workspaces SET settings = ?, updated_at = ? WHERE id = ?')
      .run(serialized, Date.now(), workspaceId);
  }
}

// --- per-workspace system-prompt addendum (stored inside workspaces.settings JSON) ---

/** Returns the workspace's Instructions text, or null when unset/empty. The
 *  frontend keeps the field optional; the runtime should treat a null return
 *  as "no addendum, use the default system prompt only". */
export function getWorkspaceInstructions(workspaceId: string): string | null {
  const row = getDb()
    .prepare('SELECT settings FROM workspaces WHERE id = ?')
    .get(workspaceId) as { settings: string | null } | undefined;
  if (!row?.settings) return null;
  try {
    const parsed = JSON.parse(row.settings) as Record<string, unknown>;
    const value = parsed.instructions;
    if (typeof value !== 'string') return null;
    return value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

// --- per-workspace, per-tool always-allow grants ---

export interface PermissionGrant {
  workspace_id: string;
  tool_name: string;
  granted_at: number;
}

export function listGrants(workspaceId: string): PermissionGrant[] {
  return getDb()
    .prepare(
      'SELECT workspace_id, tool_name, granted_at FROM workspace_permission_grants WHERE workspace_id = ? ORDER BY tool_name ASC',
    )
    .all(workspaceId) as unknown as PermissionGrant[];
}

export function hasGrant(workspaceId: string, toolName: string): boolean {
  const row = getDb()
    .prepare(
      'SELECT 1 FROM workspace_permission_grants WHERE workspace_id = ? AND tool_name = ?',
    )
    .get(workspaceId, toolName);
  return !!row;
}

export function grantPermission(workspaceId: string, toolName: string): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO workspace_permission_grants (workspace_id, tool_name, granted_at) VALUES (?, ?, ?)',
    )
    .run(workspaceId, toolName, Date.now());
}

export function revokePermission(workspaceId: string, toolName: string): void {
  getDb()
    .prepare(
      'DELETE FROM workspace_permission_grants WHERE workspace_id = ? AND tool_name = ?',
    )
    .run(workspaceId, toolName);
}

// --- Backend / external session helpers (v9) ---

export function setWorkspaceBackend(workspaceId: string, backend: string): void {
  getDb().prepare('UPDATE workspaces SET backend = ?, updated_at = ? WHERE id = ?')
         .run(backend, Date.now(), workspaceId);
}

export function getWorkspaceBackend(workspaceId: string): string | null {
  const row = getDb().prepare('SELECT backend FROM workspaces WHERE id = ?')
                     .get(workspaceId) as { backend: string | null } | undefined;
  return row?.backend ?? null;
}

export function setNodeExternalSessionId(nodeId: string, externalSessionId: string): void {
  getDb().prepare('UPDATE nodes SET external_session_id = ? WHERE id = ?')
         .run(externalSessionId, nodeId);
}

export function getNodeExternalSessionId(nodeId: string): string | null {
  const row = getDb().prepare('SELECT external_session_id FROM nodes WHERE id = ?')
                     .get(nodeId) as { external_session_id: string | null } | undefined;
  return row?.external_session_id ?? null;
}

export function updateNodeResumeBinding(
  nodeId: string,
  fields: {
    acp_session_id: string;
    runtime_id: string;
    provider_id?: string | null;
    model_id?: string | null;
    reasoning?: string | null;
    resume_fingerprint?: string | null;
    current_mode_id?: string | null;
  },
): void {
  // current_mode_id uses COALESCE(?, current_mode_id): a freshly (re)bound
  // kiro session doesn't report its agent (session.currentModeId is null on
  // resume), so a plain assignment would wipe the user's persisted agent on
  // every ensure-session. Passing null here means "unknown — keep the stored
  // mode"; only a non-null mode (e.g. after an explicit switch) overwrites it.
  // The other columns are authoritative from the resume signature and assign
  // unconditionally.
  getDb().prepare(`
    UPDATE nodes
       SET acp_session_id = ?,
           runtime_id = ?,
           provider_id = ?,
           model_id = ?,
           reasoning = ?,
           resume_fingerprint = ?,
           current_mode_id = COALESCE(?, current_mode_id)
     WHERE id = ?
  `).run(
    fields.acp_session_id,
    fields.runtime_id,
    fields.provider_id ?? null,
    fields.model_id ?? null,
    fields.reasoning ?? null,
    fields.resume_fingerprint ?? null,
    fields.current_mode_id ?? null,
    nodeId,
  );
}

export function updateNodeResumeFingerprint(nodeId: string, fingerprint: string): void {
  getDb().prepare('UPDATE nodes SET resume_fingerprint = ? WHERE id = ?')
    .run(fingerprint, nodeId);
}

// --- user_agent_configs ---

export interface UserAgentConfigRow {
  user_id: string;
  runtime: string;
  provider: string;
  model_by_runtime: string;
  reasoning_by_runtime: string;
  updated_at: number;
}

export function getUserAgentConfig(userId: string): UserAgentConfigRow | null {
  return (getDb().prepare('SELECT * FROM user_agent_configs WHERE user_id = ?').get(userId) as unknown as UserAgentConfigRow) ?? null;
}

export function upsertUserAgentConfig(
  userId: string,
  patch: Partial<Pick<UserAgentConfigRow, 'runtime' | 'provider' | 'model_by_runtime' | 'reasoning_by_runtime'>>,
): void {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO user_agent_configs (user_id, runtime, provider, model_by_runtime, reasoning_by_runtime, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      runtime              = COALESCE(excluded.runtime, user_agent_configs.runtime),
      provider             = COALESCE(excluded.provider, user_agent_configs.provider),
      model_by_runtime     = COALESCE(excluded.model_by_runtime, user_agent_configs.model_by_runtime),
      reasoning_by_runtime = COALESCE(excluded.reasoning_by_runtime, user_agent_configs.reasoning_by_runtime),
      updated_at           = excluded.updated_at
  `).run(
    userId,
    patch.runtime ?? null,
    patch.provider ?? null,
    patch.model_by_runtime ?? null,
    patch.reasoning_by_runtime ?? null,
    now,
  );
}

// --- Ownership helpers (used by ownership middleware) ---

/** Returns the workspace_id for a node/chat id, or null if not found.
 *  Single SQL hit — no caching. Used by requireChatOwner / requireNodeOwner. */
export function getNodeWorkspaceId(nodeId: string): string | null {
  const row = getDb()
    .prepare('SELECT workspace_id FROM nodes WHERE id = ?')
    .get(nodeId) as { workspace_id: string } | undefined;
  return row?.workspace_id ?? null;
}

export interface NodeSessionBinding {
  nodeId: string;
  workspaceId: string;
}

/**
 * Resolve a Michi node/workspace binding from either a node id or a runtime
 * session id. Prefer the node id path, then fall back to persisted ACP /
 * external session ids for older callers that only have the runtime id.
 */
export function getNodeSessionBinding(identifier: string, userId?: string | null): NodeSessionBinding | null {
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  if (process.env.MICHI_CLOUD === '1' && !userId) return null;

  const lookup = (column: 'id' | 'acp_session_id' | 'external_session_id'): NodeSessionBinding | null => {
    let sql = `SELECT n.id, n.workspace_id FROM nodes n`;
    const params: string[] = [trimmed];
    if (process.env.MICHI_CLOUD === '1' && userId) {
      sql += ' JOIN workspaces w ON w.id = n.workspace_id';
    }
    sql += ` WHERE n.${column} = ? AND n.purged_at IS NULL`;
    if (process.env.MICHI_CLOUD === '1' && userId) {
      sql += ' AND w.owner_user_id = ?';
      params.push(userId);
    }
    const row = getDb().prepare(sql).get(...params) as { id: string; workspace_id: string } | undefined;
    return row ? { nodeId: row.id, workspaceId: row.workspace_id } : null;
  };

  return lookup('id') ?? lookup('acp_session_id') ?? lookup('external_session_id');
}
