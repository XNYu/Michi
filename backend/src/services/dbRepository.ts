import { getDb, prepareCached, runInTransaction } from './db';
import { randomUUID } from 'node:crypto';
import {
  appendBranchOverviewEntry,
  checkpointTurnContent,
  parseBranchOverviewEntries,
  serializeBranchOverviewEntries,
  type DurableMessage,
  type DurableTurnSnapshot,
} from 'michi-shared';
import { computeTranscriptFingerprint, type TranscriptMessage } from './resumeStrategy';

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
  /** Persistence ownership protocol. v2 workspaces reject legacy snapshot sync. */
  persistence_version?: number;
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
  last_applied_turn_id?: string | null;
  last_applied_seq?: number | null;
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
  metadata?: string | null;
  seq: number;
  created_at: number;
  /** Per-row sync version (sync L2, migration 0006). NULL = predates versioning
   *  / no claim. Stamped by leaf save* via COALESCE; guard reads it in L2.2. */
  rev?: number | null;
}

export interface TurnRow {
  turn_id: string;
  node_id: string;
  user_message_id: string | null;
  assistant_message_id: string;
  status: DurableTurnSnapshot['status'];
  last_seq: number;
  stop_reason: string | null;
  error: string | null;
  started_at: number;
  checkpoint_at: number | null;
  completed_at: number | null;
  updated_at: number;
}

export interface ContextRow {
  id: string;
  workspace_id: string;
  name: string;
  /** Empty string for `link` artifacts (which carry `url`). */
  file_path: string;
  size?: number | null;
  /** Retired UI flag; column kept for back-compat, always written 0. */
  auto_inject: number;
  source: string;
  /** Artifact type (migration 0008): 'doc' | 'file' | 'image' | 'link'. */
  type?: string | null;
  /** External URL for `link` artifacts. */
  url?: string | null;
  /** Provenance: node/message this artifact came from. */
  origin_node_id?: string | null;
  origin_message_id?: string | null;
  /** 'embedded' | 'reference' — durable so injection resolves after reload. */
  kind?: string | null;
  /** UI pin (shelf ordering); independent of the removed auto-inject. */
  pinned_at?: number | null;
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
      @trim_snapshot, @last_applied_turn_id, @last_applied_seq, @created_at, @rev)
    ON CONFLICT(id) DO UPDATE SET
      tree_id=excluded.tree_id, parent_node_id=excluded.parent_node_id,
      kind=excluded.kind, title=excluded.title, branch_overview=excluded.branch_overview, status=excluded.status,
      position_x=excluded.position_x, position_y=excluded.position_y,
      minimized=excluded.minimized, deleted_at=excluded.deleted_at,
      deletion_group_id=excluded.deletion_group_id, spawned_by_agent=excluded.spawned_by_agent,
      current_mode_id=excluded.current_mode_id, pane_width=excluded.pane_width,
      digest=excluded.digest, follow_ups=excluded.follow_ups,
      follow_ups_source_message_id=excluded.follow_ups_source_message_id,
      -- acp_session_id is minted server-side for Kiro. Preserve an existing
      -- binding when an older/newer frontend snapshot omits it or carries the
      -- public node id instead. updateNodeResumeBinding remains authoritative
      -- when a runtime intentionally re-binds the node.
      acp_session_id=COALESCE(nodes.acp_session_id, excluded.acp_session_id),
      -- Runtime ownership is also server-side. Agent-spawn can race a frontend
      -- graph snapshot that has not received runtime metadata yet; never let
      -- that nullable snapshot erase a binding persisted by the adapter.
      runtime_id=COALESCE(nodes.runtime_id, excluded.runtime_id),
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
      last_applied_turn_id=excluded.last_applied_turn_id,
      last_applied_seq=excluded.last_applied_seq,
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
    last_applied_turn_id: null,
    last_applied_seq: null,
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

/**
 * Append one per-turn entry to a node's branch-overview journal. The column
 * stores a JSON entry array; legacy plain-string snapshots hydrate as a
 * single entry before the append. Verbatim repeats of the last entry are
 * dropped (dual delivery: structured event + turn-end text fallback).
 */
function appendBranchOverviewJournal(nodeId: string, text: string): void {
  const row = prepareCached('SELECT branch_overview FROM nodes WHERE id = ?')
    .get(nodeId) as { branch_overview?: string | null } | undefined;
  if (!row) return;
  const entries = parseBranchOverviewEntries(row.branch_overview ?? null);
  const next = appendBranchOverviewEntry(entries, text, Date.now());
  if (next === entries) return;
  prepareCached('UPDATE nodes SET branch_overview = ? WHERE id = ?')
    .run(serializeBranchOverviewEntries(next), nodeId);
}

export function updateNodeBranchOverview(id: string, overview: string, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    const owned = getDb().prepare(
      'SELECT 1 FROM nodes WHERE id = ? AND EXISTS (SELECT 1 FROM workspaces WHERE id = (SELECT workspace_id FROM nodes WHERE id = ?) AND owner_user_id = ?)'
    ).get(id, id, userId);
    if (!owned) return;
  }
  appendBranchOverviewJournal(id, overview);
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
    INSERT INTO messages (id, node_id, role, content, blocks, tool_calls, metadata, seq, created_at, rev)
    VALUES (@id, @node_id, @role, @content, @blocks, @tool_calls, @metadata, @seq, @created_at, @rev)
    ON CONFLICT(id) DO UPDATE SET
      content=excluded.content,
      blocks=COALESCE(excluded.blocks, messages.blocks),
      tool_calls=COALESCE(excluded.tool_calls, messages.tool_calls),
      metadata=COALESCE(excluded.metadata, messages.metadata),
      rev=COALESCE(excluded.rev, messages.rev)
  `).run({ blocks: null, tool_calls: null, metadata: null, rev: null, ...msg });
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

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function durableMessageMetadata(message: DurableMessage): string | null {
  if (message.role === 'assistant') {
    return message.plan && message.plan.length > 0 ? jsonOrNull({ plan: message.plan }) : null;
  }
  return message.metadata && Object.keys(message.metadata).length > 0
    ? jsonOrNull(message.metadata)
    : null;
}

function getTurnRow(turnId: string): TurnRow | null {
  return (prepareCached('SELECT * FROM turns WHERE turn_id = ?').get(turnId) as TurnRow | undefined) ?? null;
}

function assertTurnIdentity(row: TurnRow, snapshot: DurableTurnSnapshot): void {
  if (
    row.node_id !== snapshot.nodeId
    || row.assistant_message_id !== snapshot.assistantId
    || row.user_message_id !== (snapshot.userMessage?.id ?? null)
  ) {
    throw new Error(`turn ${snapshot.turnId} was replayed with different durable identity`);
  }
}

function clearPendingSpawnPromptOutbox(nodeId: string): void {
  const row = prepareCached('SELECT composer_draft FROM nodes WHERE id = ?')
    .get(nodeId) as { composer_draft?: string | null } | undefined;
  const raw = row?.composer_draft;
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed?.__michiPendingSpawnPrompt !== 'string') return;
  } catch {
    return;
  }
  prepareCached('UPDATE nodes SET composer_draft = NULL WHERE id = ? AND composer_draft = ?')
    .run(nodeId, raw);
}

function writeAssistantSnapshot(snapshot: DurableTurnSnapshot, content = snapshot.assistantMessage.content): void {
  const message = snapshot.assistantMessage;
  const result = prepareCached(`
    UPDATE messages
    SET content = ?, blocks = ?, tool_calls = ?, metadata = ?
    WHERE id = ? AND node_id = ? AND role = 'assistant'
  `).run(
    content,
    message.blocks.length > 0 ? JSON.stringify(message.blocks) : null,
    message.toolCalls.length > 0 ? JSON.stringify(message.toolCalls) : null,
    durableMessageMetadata(message),
    message.id,
    snapshot.nodeId,
  );
  if (Number(result.changes) !== 1) {
    throw new Error(`assistant message ${message.id} is missing for turn ${snapshot.turnId}`);
  }
}

function writeTurnNodeProjection(snapshot: DurableTurnSnapshot, terminal: boolean): void {
  const metadata = snapshot.nodeMetadata;
  if (metadata.title) {
    prepareCached(`
      UPDATE nodes
      SET title = CASE WHEN title IS NULL OR TRIM(title) = '' THEN ? ELSE title END
      WHERE id = ?
    `).run(metadata.title, snapshot.nodeId);
  }
  if (metadata.followUps !== undefined) {
    prepareCached('UPDATE nodes SET follow_ups = ?, follow_ups_source_message_id = ? WHERE id = ?')
      .run(JSON.stringify(metadata.followUps), snapshot.assistantId, snapshot.nodeId);
  }
  // Journal append happens only at the turn's durability boundary so each
  // turn contributes at most one entry even when checkpoints ran earlier.
  if (terminal && metadata.branchOverview) {
    appendBranchOverviewJournal(snapshot.nodeId, metadata.branchOverview);
  }
  prepareCached(`
    UPDATE nodes
    SET status = ?, last_applied_turn_id = ?, last_applied_seq = ?
    WHERE id = ?
  `).run(
    terminal ? (snapshot.status === 'error' ? 'error' : 'idle') : 'streaming',
    snapshot.turnId,
    snapshot.lastAppliedSeq,
    snapshot.nodeId,
  );
}

function refreshResumeFingerprint(nodeId: string): void {
  const transcript: TranscriptMessage[] = listMessages(nodeId)
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content,
    }));
  prepareCached('UPDATE nodes SET resume_fingerprint = ? WHERE id = ?')
    .run(computeTranscriptFingerprint(transcript), nodeId);
}

/** Insert deterministic provisional messages and the turn receipt atomically. */
export function beginTurn(snapshot: DurableTurnSnapshot): TurnRow {
  return runInTransaction(() => {
    const existing = getTurnRow(snapshot.turnId);
    if (existing) {
      assertTurnIdentity(existing, snapshot);
      clearPendingSpawnPromptOutbox(snapshot.nodeId);
      return existing;
    }
    const node = getNode(snapshot.nodeId);
    if (!node) throw new Error(`node ${snapshot.nodeId} does not exist`);
    if (node.workspace_id !== snapshot.workspaceId) {
      throw new Error(`node ${snapshot.nodeId} does not belong to workspace ${snapshot.workspaceId}`);
    }
    // The spawn prompt is a one-shot durable outbox. Consume it in the same
    // transaction that makes the first turn visible, so a renderer/backend
    // crash after begin cannot replay the prompt or mask a real composer draft.
    clearPendingSpawnPromptOutbox(snapshot.nodeId);

    const max = prepareCached('SELECT COALESCE(MAX(seq), -1) AS seq FROM messages WHERE node_id = ?')
      .get(snapshot.nodeId) as { seq: number };
    let seq = max.seq + 1;
    if (snapshot.userMessage) {
      saveMessage({
        id: snapshot.userMessage.id,
        node_id: snapshot.nodeId,
        role: 'user',
        content: snapshot.userMessage.content,
        blocks: null,
        tool_calls: null,
        metadata: durableMessageMetadata(snapshot.userMessage),
        seq: seq++,
        created_at: snapshot.userMessage.createdAt,
      });
    }
    saveMessage({
      id: snapshot.assistantMessage.id,
      node_id: snapshot.nodeId,
      role: 'assistant',
      content: snapshot.assistantMessage.content,
      blocks: null,
      tool_calls: null,
      metadata: durableMessageMetadata(snapshot.assistantMessage),
      seq,
      created_at: snapshot.assistantMessage.createdAt,
    });
    const now = Date.now();
    prepareCached(`
      INSERT INTO turns (
        turn_id, node_id, user_message_id, assistant_message_id, status,
        last_seq, stop_reason, error, started_at, checkpoint_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, NULL, NULL, ?, NULL, NULL, ?)
    `).run(
      snapshot.turnId,
      snapshot.nodeId,
      snapshot.userMessage?.id ?? null,
      snapshot.assistantId,
      snapshot.lastAppliedSeq,
      snapshot.startedAt,
      now,
    );
    writeTurnNodeProjection(snapshot, false);
    return getTurnRow(snapshot.turnId)!;
  });
}

/** Persist a bounded partial snapshot without marking the turn terminal. */
export function checkpointTurn(snapshot: DurableTurnSnapshot): TurnRow {
  return runInTransaction(() => {
    const row = getTurnRow(snapshot.turnId);
    if (!row) throw new Error(`turn ${snapshot.turnId} has not begun`);
    assertTurnIdentity(row, snapshot);
    if (row.status !== 'active' || snapshot.lastAppliedSeq < row.last_seq) return row;
    writeAssistantSnapshot(snapshot, checkpointTurnContent(snapshot));
    writeTurnNodeProjection(snapshot, false);
    const now = Date.now();
    prepareCached(`
      UPDATE turns SET last_seq = ?, checkpoint_at = ?, updated_at = ? WHERE turn_id = ?
    `).run(snapshot.lastAppliedSeq, now, now, snapshot.turnId);
    return getTurnRow(snapshot.turnId)!;
  });
}

/** Atomically materialize the canonical terminal snapshot before SSE success. */
export function finalizeTurn(snapshot: DurableTurnSnapshot): TurnRow {
  if (snapshot.status === 'active') {
    throw new Error(`turn ${snapshot.turnId} cannot finalize while active`);
  }
  return runInTransaction(() => {
    const row = getTurnRow(snapshot.turnId);
    if (!row) throw new Error(`turn ${snapshot.turnId} has not begun`);
    assertTurnIdentity(row, snapshot);
    if (row.status !== 'active') {
      if (row.status !== snapshot.status) {
        throw new Error(`turn ${snapshot.turnId} is already finalized as ${row.status}`);
      }
      return row;
    }
    writeAssistantSnapshot(snapshot);
    writeTurnNodeProjection(snapshot, true);
    refreshResumeFingerprint(snapshot.nodeId);
    const now = Date.now();
    const completedAt = snapshot.completedAt ?? now;
    prepareCached(`
      UPDATE turns
      SET status = ?, last_seq = ?, stop_reason = ?, error = ?,
          checkpoint_at = ?, completed_at = ?, updated_at = ?
      WHERE turn_id = ?
    `).run(
      snapshot.status,
      snapshot.lastAppliedSeq,
      snapshot.stopReason ?? null,
      snapshot.error ?? null,
      now,
      completedAt,
      now,
      snapshot.turnId,
    );
    return getTurnRow(snapshot.turnId)!;
  });
}

/** Mark checkpointed turns left active by a previous process as interrupted. */
export function recoverInterruptedTurns(now = Date.now()): number {
  return runInTransaction(() => {
    const active = prepareCached("SELECT turn_id, node_id FROM turns WHERE status = 'active'")
      .all() as Array<{ turn_id: string; node_id: string }>;
    if (active.length === 0) return 0;
    prepareCached(`
      UPDATE turns
      SET status = 'error', error = 'backend_restarted', completed_at = ?, updated_at = ?
      WHERE status = 'active'
    `).run(now, now);
    const updateNode = prepareCached(`
      UPDATE nodes SET status = 'error' WHERE id = ? AND status = 'streaming'
    `);
    for (const turn of active) updateNode.run(turn.node_id);
    return active.length;
  });
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
    INSERT INTO contexts (id, workspace_id, name, file_path, size, auto_inject, source, type, url, origin_node_id, origin_message_id, kind, pinned_at, created_at, updated_at, rev)
    VALUES (@id, @workspace_id, @name, @file_path, @size, @auto_inject, @source, @type, @url, @origin_node_id, @origin_message_id, @kind, @pinned_at, @created_at, @updated_at, @rev)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, file_path=excluded.file_path, size=excluded.size, auto_inject=excluded.auto_inject,
      source=excluded.source, type=excluded.type, url=excluded.url,
      origin_node_id=excluded.origin_node_id, origin_message_id=excluded.origin_message_id,
      kind=excluded.kind, pinned_at=excluded.pinned_at, updated_at=excluded.updated_at,
      rev=COALESCE(excluded.rev, contexts.rev)
  `).run({
    ...ctx,
    size: ctx.size ?? null,
    type: ctx.type ?? null,
    url: ctx.url ?? null,
    origin_node_id: ctx.origin_node_id ?? null,
    origin_message_id: ctx.origin_message_id ?? null,
    kind: ctx.kind ?? null,
    pinned_at: ctx.pinned_at ?? null,
    rev: ctx.rev ?? null,
  });
}

/**
 * Durable projection for agent save_artifact/update_artifact side effects.
 * Reuses the existing row id for a workspace/name pair so an SSE replay (or a
 * later full workspace load) observes one context rather than a duplicate.
 */
export function upsertAgentContextMetadata(input: {
  workspaceId: string;
  nodeId: string;
  name: string;
  filePath: string;
  size: number;
  userId?: string;
}): string | null {
  const workspace = getWorkspace(input.workspaceId, input.userId);
  if (!workspace) return null;
  const existing = listContexts(input.workspaceId, input.userId)
    .find((context) => context.name === input.name);
  const now = Date.now();
  const id = existing?.id ?? `ctx-${randomUUID()}`;
  saveContext({
    id,
    workspace_id: input.workspaceId,
    name: input.name,
    file_path: input.filePath,
    size: input.size,
    auto_inject: existing?.auto_inject ?? 0,
    source: 'agent',
    type: existing?.type ?? 'doc',
    url: existing?.url ?? null,
    origin_node_id: existing?.origin_node_id ?? input.nodeId,
    origin_message_id: existing?.origin_message_id ?? null,
    kind: existing?.kind ?? 'embedded',
    pinned_at: existing?.pinned_at ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    rev: existing?.rev ?? null,
  } as ContextRow, input.userId);
  return id;
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

/**
 * Structure + per-node message COUNT, with NO message bodies. This is the
 * lazy-load hydration payload: the frontend loads every workspace's structural
 * graph (trees/nodes/edges/contexts) plus a `message_count` per node, then
 * fetches the actual message bodies one tree at a time via `loadTreeMessages`.
 *
 * `messages` is intentionally always `[]` here so the shape stays assignable to
 * FullWorkspaceData — the count rides on each NodeRow as `message_count`.
 */
export interface NodeRowWithCount extends NodeRow {
  message_count: number;
}
export interface MetaWorkspaceData extends Omit<FullWorkspaceData, 'nodes' | 'messages'> {
  nodes: NodeRowWithCount[];
  messages: never[];
}

export function loadWorkspaceMeta(id: string, userId?: string): MetaWorkspaceData | null {
  const workspace = getWorkspace(id, userId);
  if (!workspace) return null;
  const trees = listTrees(id, userId);
  const nodes = listNodes(id, userId);
  const edges = listEdges(id, userId);
  const contexts = listContexts(id, userId);

  // One grouped COUNT for the whole workspace instead of N per-node queries.
  const countByNode = new Map<string, number>();
  const nodeIds = nodes.map(n => n.id);
  if (nodeIds.length > 0) {
    const placeholders = nodeIds.map(() => '?').join(',');
    const rows = getDb().prepare(
      `SELECT node_id, COUNT(*) as cnt FROM messages WHERE node_id IN (${placeholders}) GROUP BY node_id`
    ).all(...nodeIds) as unknown as Array<{ node_id: string; cnt: number }>;
    for (const r of rows) countByNode.set(r.node_id, r.cnt);
  }

  const nodesWithCount: NodeRowWithCount[] = nodes.map(n => ({
    ...n,
    message_count: countByNode.get(n.id) ?? 0,
  }));

  return { workspace, trees, nodes: nodesWithCount, edges, messages: [], contexts };
}

export function loadAllWorkspacesMeta(userId?: string): MetaWorkspaceData[] {
  const workspaces = listWorkspaces(userId);
  return workspaces
    .map(ws => loadWorkspaceMeta(ws.id, userId))
    .filter((d): d is MetaWorkspaceData => d !== null);
}

/**
 * Message bodies for every node in ONE tree, ordered by (node, seq). This is
 * the on-demand fetch behind lazy loading: the caller already has the tree's
 * structure from the meta payload and asks for its bodies when the tree is
 * activated / opened.
 *
 * Scoped to the tree via `nodes.tree_id`, so it never over-fetches sibling
 * trees. In cloud mode the workspace-owner check gates access (the route
 * applies `requireWorkspaceOwner`); the query itself is workspace-scoped.
 */
export function loadTreeMessages(workspaceId: string, treeId: string, userId?: string): MessageRow[] {
  // Resolve the tree's node ids first (workspace + user scoped via listNodes).
  const nodeIds = listNodes(workspaceId, userId)
    .filter(n => n.tree_id === treeId)
    .map(n => n.id);
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => '?').join(',');
  return getDb().prepare(
    `SELECT * FROM messages WHERE node_id IN (${placeholders}) ORDER BY node_id ASC, seq ASC`
  ).all(...nodeIds) as unknown as MessageRow[];
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
