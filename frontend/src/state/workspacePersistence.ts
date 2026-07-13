import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import {
  fetchAllWorkspaces,
  fetchWorkspace,
  fetchWorkspaces,
  migrateLocalStorage,
  syncWorkspace,
} from '../services/api';
import { findTreeIdForNode } from './tree';
import {
  hydrateBackendWorkspaces,
  hydrateSavedState,
  mapContextRow,
  mapEdgeRow,
  mapMessageRow,
  mapNodeRowScalars,
  mapTreeRow,
  STATE_SCHEMA_VERSION,
  type HydratedState,
  type SavedState,
} from './chatHydration';
import { messageForPersistence } from './assistantBlocks';
import type { ChatNodeState, Project } from './chatTypes';
import { startupMarkOnce } from '../services/startupTrace';
import type { SyncWorkspaceResponse } from '../services/api';

// Note: the inbound load path for `Project.aiGlobalContext` lives in
// `chatHydration.ts` (which actually maps backend workspace rows to Project
// shape). This file owns the *outbound* save path: serializing the field into
// the `workspaces.settings` JSON blob during /sync. The dedicated
// POST /workspaces/:id/ai-global-context endpoint also writes the same field
// directly, so the next load picks it up either way.

/** Prefix for per-user namespaced workspace state keys. */
export const STATE_KEY_PREFIX = 'michi:v1:state:';

/** Legacy shared key used before per-user namespacing. Kept for migration + signOut cleanup. */
export const LEGACY_STATE_KEY = 'michi:v1:state';

/**
 * @deprecated Use buildStateKey(userId) or useStateKey() instead.
 * Kept for backward compatibility with non-hook callsites that have not yet
 * been updated.
 */
export const STATE_KEY = LEGACY_STATE_KEY;

/** Key set to '1' after the one-time localStorage-to-SQLite migration completes. */
export const MIGRATED_KEY = 'michi:migrated';

/** Build the per-user localStorage key for workspace state. */
export function buildStateKey(userId: string): string {
  return `${STATE_KEY_PREFIX}${userId}`;
}

// ── Per-project scoped localStorage layout ─────────────────────────────────
// Old layout: a single key (baseKey) holding {version, projects, activeProjectId, nodes}.
// New layout: a small index key + one blob per project, so a dirty tick only
// re-serializes the projects that actually changed.
//   `${baseKey}:index`   -> { version, activeProjectId, projectIds: string[] }
//   `${baseKey}:p:<id>`  -> { project: Project, nodes: Record<nodeId, ChatNodeState> }
// baseKey is `michi:v1:state:<userId>` (per-user) or `michi:v1:state` (legacy),
// so both derived keys start with STATE_KEY_PREFIX and are cleared by signOut.

interface StateIndex {
  version: number;
  activeProjectId: string | null;
  projectIds: string[];
}

/** localStorage key for the per-user/legacy state index. */
export function stateIndexKey(baseKey: string): string {
  return `${baseKey}:index`;
}

/** localStorage key for a single project's blob. */
export function stateProjectKey(baseKey: string, projectId: string): string {
  return `${baseKey}:p:${projectId}`;
}

/** localStorage key for a single window's active project id. */
export function activeProjectKey(baseKey: string, windowId: string): string {
  const ns = baseKey || LEGACY_STATE_KEY;
  return `${ns}:win:${windowId}:activeProject`;
}

export function readActiveProjectId(
  baseKey: string,
  windowId: string,
  legacy: string | null,
): string | null {
  if (typeof window === 'undefined') return legacy;
  const v = window.localStorage.getItem(activeProjectKey(baseKey, windowId));
  return v !== null ? v : legacy;
}

export function writeActiveProjectId(
  baseKey: string,
  windowId: string,
  projectId: string | null,
): void {
  if (typeof window === 'undefined') return;
  try {
    if (projectId === null) {
      window.localStorage.removeItem(activeProjectKey(baseKey, windowId));
    } else {
      window.localStorage.setItem(activeProjectKey(baseKey, windowId), projectId);
    }
  } catch {
    // Best effort: private browsing / quota errors should not break app state.
  }
}

export function mergeIndexProjectIds(diskIds: string[], memIds: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...diskIds, ...memIds]) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

const EMPTY_HYDRATED: HydratedState = { projects: [], activeProjectId: null, nodes: {} };

/**
 * Read the raw (pre-hydration) SavedState from localStorage. Prefers the new
 * per-project layout (index + per-project blobs) and falls back to the legacy
 * single-key blob. Returns null when nothing is stored. Does NOT run
 * hydrateSavedState — `readLocalStorageState` wraps the result for live state,
 * and the /migrate path forwards it raw, so both consume the same shape.
 */
export function readLocalStoragePayload(userId?: string): SavedState | null {
  if (typeof window === 'undefined') return null;
  const baseKey = userId ? buildStateKey(userId) : LEGACY_STATE_KEY;

  const rawIndex = window.localStorage.getItem(stateIndexKey(baseKey));
  if (rawIndex) {
    try {
      const index = JSON.parse(rawIndex) as StateIndex;
      const projects: SavedState['projects'] = [];
      const nodes: SavedState['nodes'] = {};
      for (const pid of index.projectIds ?? []) {
        const rawBlob = window.localStorage.getItem(stateProjectKey(baseKey, pid));
        if (!rawBlob) continue; // tolerate a missing / half-written blob
        try {
          const blob = JSON.parse(rawBlob) as { project: SavedState['projects'][number]; nodes: SavedState['nodes'] };
          if (!blob || !blob.project) continue;
          projects.push(blob.project);
          // node ids are unique across projects by invariant, so no key collision
          Object.assign(nodes, blob.nodes ?? {});
        } catch {
          continue; // tolerate a corrupt blob, same as a missing one
        }
      }
      return {
        version: index.version ?? STATE_SCHEMA_VERSION,
        projects,
        activeProjectId: index.activeProjectId ?? null,
        nodes,
      };
    } catch {
      // Malformed index — fall through to the legacy single-key layout.
    }
  }

  // Legacy single-key layout. Per-user falls back to the shared legacy key,
  // matching the prior readLocalStorageState behavior.
  const rawSingle =
    window.localStorage.getItem(baseKey) ??
    (userId ? window.localStorage.getItem(LEGACY_STATE_KEY) : null);
  if (!rawSingle) return null;
  try {
    return JSON.parse(rawSingle) as SavedState;
  } catch {
    return null;
  }
}

export function readLocalStorageState(userId?: string): HydratedState {
  const payload = readLocalStoragePayload(userId);
  if (!payload) return EMPTY_HYDRATED;
  return hydrateSavedState(payload);
}

export const readInitialHydrated = readLocalStorageState;

function readWorkspaceRowId(row: unknown): string | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const id = (row as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

// ── Shared row-mapping helpers ─────────────────────────────────────────────
// Both the full serializer (serializeWorkspaceForSync) and the delta serializer
// (serializeWorkspaceDelta) build their wire rows EXCLUSIVELY through these
// helpers. Keeping the per-entity mapping in one place is what guarantees the
// two paths CONVERGE: a delta of one change produces the exact same row shapes
// (and message-id derivation) a full sync of the post-change snapshot would.
// Do NOT inline divergent mapping logic in either serializer.

/** Build the single `workspaces` row. Identical for full + delta. */
export function serializeWorkspaceRow(project: Project) {
  // Embed per-workspace flags into the opaque settings JSON. Default ON: only
  // serialize aiGlobalContext when explicitly disabled, so existing rows that
  // never carried this field keep their default-true semantics.
  const settings: Record<string, unknown> = {};
  if (project.aiGlobalContext === false) settings.aiGlobalContext = false;
  // Only emit when non-empty: keeps the settings blob absent for the common
  // case where the user never touched Instructions.
  if (project.instructions && project.instructions.length > 0) {
    settings.instructions = project.instructions;
  }
  return {
    id: project.id,
    name: project.name,
    cwd: project.cwd || null,
    active_tree_id: project.activeTreeId || null,
    created_at: project.createdAt || Date.now(),
    updated_at: Date.now(),
    // /workspaces/:id/sync forwards settings straight to saveWorkspace, which
    // stores it as a TEXT column — pass a serialized JSON string (or null).
    settings: Object.keys(settings).length > 0 ? JSON.stringify(settings) : null,
    // Soft-delete + archive + pin timestamps live on the row so a "deleted"
    // workspace stays in the trash across restarts. Always emit (number or
    // null) so restore clears the column instead of leaving stale state.
    deleted_at: project.deletedAt ?? null,
    archived_at: project.archivedAt ?? null,
    pinned_at: project.pinnedAt ?? null,
  };
}

/** Build one `trees` row. */
export function serializeTreeRow(project: Project, t: Project['trees'][number]) {
  return {
    id: t.id,
    workspace_id: project.id,
    root_node_id: t.rootNodeId,
    name: t.name || null,
    archived_at: t.archivedAt || null,
    pinned_at: t.pinnedAt || null,
    last_active_at: t.lastActiveAt || Date.now(),
    created_at: t.createdAt || Date.now(),
  };
}

/**
 * Build one `nodes` row, or null when the node is missing from `nodes`.
 * Callers filter null out of the wire array.
 */
export function serializeNodeRow(
  project: Project,
  nodes: Record<string, ChatNodeState>,
  nid: string,
) {
  const n = nodes[nid];
  if (!n) return null;
  return {
    id: nid,
    workspace_id: project.id,
    tree_id: findTreeIdForNode(nid, project),
    parent_node_id: n.parentNodeId || null,
    kind: n.kind || 'chat',
    title: n.title || null,
    status: 'idle',
    position_x: n.position?.x ?? null,
    position_y: n.position?.y ?? null,
    minimized: n.minimized ? 1 : 0,
    deleted_at: n.deletedAt ?? null,
    deletion_group_id: n.deletionGroupId ?? null,
    spawned_by_agent: n.spawnedByAgent ? 1 : 0,
    current_mode_id: n.currentModeId ?? null,
    pane_width: n.paneWidth ?? null,
    digest: n.digest ? JSON.stringify({ ...n.digest, status: 'idle', error: undefined }) : null,
    follow_ups: n.followUps.length > 0 ? JSON.stringify(n.followUps) : null,
    follow_ups_source_message_id: n.followUpsSourceMessageId ?? null,
    acp_session_id: n.chatId ?? null,
    runtime_id: n.runtimeId ?? null,
    provider_id: n.providerId ?? null,
    model_id: n.modelId ?? null,
    reasoning: n.reasoning ?? null,
    resume_fingerprint: n.resumeFingerprint ?? null,
    composer_draft: n.composerDraft ? JSON.stringify(n.composerDraft) : null,
    trim_snapshot: n.trimSnapshot ? JSON.stringify(n.trimSnapshot) : null,
    created_at: n.messages[0]?.createdAt ?? project.createdAt ?? Date.now(),
  };
}

/** Build one `edges` row. The id derivation is the convergence key. */
export function serializeEdgeRow(project: Project, e: Project['edges'][number]) {
  return {
    id: `${e.kind || 'branch'}-${e.source}-${e.target}`,
    workspace_id: project.id,
    source_node_id: e.source,
    target_node_id: e.target,
    kind: e.kind || 'branch',
    anchor_message_id: e.anchorMessageId ?? null,
    created_at: e.createdAt ?? null,
  };
}

/**
 * Build the FULL message row list for one node (skipping streaming assistant
 * messages, exactly like the full serializer). The per-node message reconcile
 * on the backend treats this list as authoritative for that node, so it MUST be
 * the node's complete current message set. Returns [] when the node is missing.
 */
export function serializeMessageRowsForNode(
  nodes: Record<string, ChatNodeState>,
  nid: string,
) {
  const n = nodes[nid];
  if (!n) return [];
  return (n.messages || []).flatMap((m, i) => {
    if (m.role === 'assistant' && m.streaming) return [];
    const persisted = messageForPersistence(m);
    return [{
      id: m.id || `${nid}-${i}`,
      node_id: nid,
      role: m.role,
      content: persisted.content,
      blocks: persisted.blocks,
      tool_calls: persisted.toolCalls.length > 0 ? JSON.stringify(persisted.toolCalls) : null,
      seq: i,
      created_at: m.createdAt ?? Date.now(),
    }];
  });
}

/** Build one `contexts` row. */
export function serializeContextRow(project: Project, c: NonNullable<Project['contexts']>[number]) {
  return {
    id: c.id,
    workspace_id: project.id,
    name: c.name,
    file_path: c.filePath,
    size: c.size ?? null,
    auto_inject: c.autoInject ? 1 : 0,
    source: c.source || 'user',
    created_at: c.createdAt || Date.now(),
    updated_at: c.updatedAt || Date.now(),
  };
}

export function serializeWorkspaceForSync(
  project: Project,
  nodes: Record<string, ChatNodeState>,
) {
  return {
    workspace: serializeWorkspaceRow(project),
    trees: (project.trees || []).map((t) => serializeTreeRow(project, t)),
    nodes: project.chatIds
      .map((nid) => serializeNodeRow(project, nodes, nid))
      .filter(Boolean),
    edges: (project.edges || []).map((e) => serializeEdgeRow(project, e)),
    messages: project.chatIds.flatMap((nid) => serializeMessageRowsForNode(nodes, nid)),
    contexts: (project.contexts || []).map((c) => serializeContextRow(project, c)),
  };
}

// ── Incremental delta serialization ────────────────────────────────────────

/**
 * Per-project pending delta accumulated by the dirty-tracking effect between
 * flushes. Each set is in terms of the SERIALIZED id of the entity (e.g. edge
 * ids are `${kind}-${source}-${target}`, matching serializeEdgeRow).
 */
export interface WorkspaceDirtyDelta {
  /** Nodes whose row changed → upsert these node rows. */
  nodeIds: Set<string>;
  /** Nodes whose MESSAGE SET changed → upserts.messages + messageReconcileNodeIds. */
  messageNodeIds: Set<string>;
  /** Edges added/changed (by serialized edge id). */
  edgeUpsertIds: Set<string>;
  /** Edges removed (by serialized edge id). */
  edgeDeleteIds: Set<string>;
  treeUpsertIds: Set<string>;
  treeDeleteIds: Set<string>;
  contextUpsertIds: Set<string>;
  contextDeleteIds: Set<string>;
  /** Workspace-level field changed (name/cwd/activeTreeId/settings/deleted_at/archived_at). */
  workspaceChanged: boolean;
}

/** A fresh, empty dirty delta. */
export function emptyWorkspaceDirtyDelta(): WorkspaceDirtyDelta {
  return {
    nodeIds: new Set<string>(),
    messageNodeIds: new Set<string>(),
    edgeUpsertIds: new Set<string>(),
    edgeDeleteIds: new Set<string>(),
    treeUpsertIds: new Set<string>(),
    treeDeleteIds: new Set<string>(),
    contextUpsertIds: new Set<string>(),
    contextDeleteIds: new Set<string>(),
    workspaceChanged: false,
  };
}

// Serialized edge id, matching serializeEdgeRow's id derivation.
// Exported so accumulateWorkspaceDirtyDelta and the hook both use the same fn.
export function serializedEdgeId(e: Project['edges'][number]): string {
  return `${e.kind || 'branch'}-${e.source}-${e.target}`;
}

/**
 * Pure accumulator: diff `cur` (and `curNodes`) against `prev` / `prevNodes`
 * and merge the changes into `existing`, returning a new delta. Called once
 * per dirty project per React render; results fold into `dirtyDeltaByProjectRef`.
 *
 * Invariant maintained after every call: no id appears in BOTH an upsert set
 * and its corresponding delete set. Each entity transition is symmetric:
 *   - added/changed  → add to upsertIds,  remove from deleteIds
 *   - removed        → add to deleteIds,   remove from upsertIds
 * This ensures that a delete-then-re-add or add-then-delete sequence across
 * ticks within one flush window always converges to the LAST observed state.
 *
 * Node removal is intentionally NOT tracked here — node removal is handled by
 * the dedicated trash/purge endpoints, not by the delta path.
 */
export function accumulateWorkspaceDirtyDelta(
  prev: Project | undefined,
  cur: Project,
  prevNodes: Record<string, ChatNodeState>,
  curNodes: Record<string, ChatNodeState>,
  existing: WorkspaceDirtyDelta,
): WorkspaceDirtyDelta {
  // Clone the existing sets so we return a new object (pure function).
  const d: WorkspaceDirtyDelta = {
    nodeIds: new Set(existing.nodeIds),
    messageNodeIds: new Set(existing.messageNodeIds),
    edgeUpsertIds: new Set(existing.edgeUpsertIds),
    edgeDeleteIds: new Set(existing.edgeDeleteIds),
    treeUpsertIds: new Set(existing.treeUpsertIds),
    treeDeleteIds: new Set(existing.treeDeleteIds),
    contextUpsertIds: new Set(existing.contextUpsertIds),
    contextDeleteIds: new Set(existing.contextDeleteIds),
    workspaceChanged: existing.workspaceChanged,
  };

  if (!prev) {
    // Brand-new project: every entity is an upsert. The periodic full-sync
    // also covers fresh projects, but mark entities so the very first delta
    // (if it wins the race) carries the whole project.
    d.workspaceChanged = true;
    for (const nid of cur.chatIds) {
      d.nodeIds.add(nid);
      d.messageNodeIds.add(nid);
    }
    for (const e of cur.edges || []) {
      const id = serializedEdgeId(e);
      d.edgeUpsertIds.add(id);
      d.edgeDeleteIds.delete(id);
    }
    for (const t of cur.trees || []) {
      d.treeUpsertIds.add(t.id);
      d.treeDeleteIds.delete(t.id);
    }
    for (const c of cur.contexts || []) {
      d.contextUpsertIds.add(c.id);
      d.contextDeleteIds.delete(c.id);
    }
    return d;
  }

  // Workspace-level fields (name/cwd/activeTreeId/instructions/
  // aiGlobalContext/deletedAt/archivedAt) → workspace row changed.
  if (
    prev.name !== cur.name ||
    prev.cwd !== cur.cwd ||
    prev.activeTreeId !== cur.activeTreeId ||
    prev.instructions !== cur.instructions ||
    prev.aiGlobalContext !== cur.aiGlobalContext ||
    prev.deletedAt !== cur.deletedAt ||
    prev.archivedAt !== cur.archivedAt
  ) {
    d.workspaceChanged = true;
  }

  // Edges: diff by serialized id.
  // Invariant: upsertIds ∩ deleteIds = ∅ after each branch:
  //   added/changed → upsertIds.add, deleteIds.delete
  //   removed       → deleteIds.add, upsertIds.delete
  if (prev.edges !== cur.edges) {
    const prevEdges = new Map((prev.edges || []).map((e) => [serializedEdgeId(e), e] as const));
    const curEdges = new Map((cur.edges || []).map((e) => [serializedEdgeId(e), e] as const));
    for (const [id, e] of curEdges) {
      const pe = prevEdges.get(id);
      if (!pe || pe !== e) {
        // Added or changed — the last known state is "present": upsert wins.
        d.edgeUpsertIds.add(id);
        d.edgeDeleteIds.delete(id);
      }
    }
    for (const id of prevEdges.keys()) {
      if (!curEdges.has(id)) {
        // Removed — the last known state is "absent": delete wins.
        d.edgeDeleteIds.add(id);
        d.edgeUpsertIds.delete(id);
      }
    }
  }

  // Trees: diff by id.
  if (prev.trees !== cur.trees) {
    const prevTrees = new Map((prev.trees || []).map((t) => [t.id, t] as const));
    const curTrees = new Map((cur.trees || []).map((t) => [t.id, t] as const));
    for (const [id, t] of curTrees) {
      const pt = prevTrees.get(id);
      if (!pt || pt !== t) {
        d.treeUpsertIds.add(id);
        d.treeDeleteIds.delete(id);
      }
    }
    for (const id of prevTrees.keys()) {
      if (!curTrees.has(id)) {
        d.treeDeleteIds.add(id);
        d.treeUpsertIds.delete(id);
      }
    }
  }

  // Contexts: diff by id.
  if (prev.contexts !== cur.contexts) {
    const prevCtx = new Map((prev.contexts || []).map((c) => [c.id, c] as const));
    const curCtx = new Map((cur.contexts || []).map((c) => [c.id, c] as const));
    for (const [id, c] of curCtx) {
      const pc = prevCtx.get(id);
      if (!pc || pc !== c) {
        d.contextUpsertIds.add(id);
        d.contextDeleteIds.delete(id);
      }
    }
    for (const id of prevCtx.keys()) {
      if (!curCtx.has(id)) {
        d.contextDeleteIds.add(id);
        d.contextUpsertIds.delete(id);
      }
    }
  }

  // Nodes: attribute changes in curNodes to this project's chatIds.
  // Node removal is NOT tracked here — handled by trash/purge endpoints.
  for (const nid of cur.chatIds) {
    const curN = curNodes[nid];
    const prevN = prevNodes[nid];
    if (curN !== prevN) {
      d.nodeIds.add(nid);
      // New node (no prev) or message array reference changed → full message send.
      if (!prevN || curN?.messages !== prevN?.messages) {
        d.messageNodeIds.add(nid);
      }
    }
  }

  return d;
}

/**
 * Serialize ONLY the dirty entities of a project into the backend delta shape
 * (`POST /workspaces/:id/sync` with `mode:'delta'`). Built entirely from the
 * shared row helpers above, so every emitted row is byte-for-byte identical to
 * what serializeWorkspaceForSync would emit for the same entity — that's the
 * convergence guarantee.
 *
 * Emission rules (compact: keys present only when non-empty):
 *   - `workspace`: only when `dirty.workspaceChanged`.
 *   - `upserts.nodes`: rows for (nodeIds ∪ messageNodeIds) that still exist in
 *     project.chatIds. A node with message changes needs its row present too.
 *   - `upserts.messages`: flat list = each still-existing node in messageNodeIds
 *     mapped to its FULL current message rows.
 *   - `upserts.edges/trees/contexts`: rows for the respective upsert id sets.
 *   - `deletes.edges/trees/contexts`: the delete id sets as arrays.
 *   - `messageReconcileNodeIds`: Array.from(messageNodeIds) — present whenever
 *     messageNodeIds is non-empty (so trim-to-zero nodes still reconcile).
 */
export function serializeWorkspaceDelta(
  project: Project,
  nodes: Record<string, ChatNodeState>,
  dirty: WorkspaceDirtyDelta,
) {
  const chatIdSet = new Set(project.chatIds);
  const edgeById = new Map<string, Project['edges'][number]>(
    (project.edges || []).map((e) => [`${e.kind || 'branch'}-${e.source}-${e.target}`, e]),
  );
  const treeById = new Map((project.trees || []).map((t) => [t.id, t] as const));
  const contextById = new Map((project.contexts || []).map((c) => [c.id, c] as const));

  // Node rows: union of changed-row nodes and message-changed nodes (the latter
  // need their row present so the upsert+reconcile lands together), but only
  // those that still exist in the project.
  const nodeIdsToUpsert = new Set<string>();
  for (const nid of dirty.nodeIds) if (chatIdSet.has(nid)) nodeIdsToUpsert.add(nid);
  for (const nid of dirty.messageNodeIds) if (chatIdSet.has(nid)) nodeIdsToUpsert.add(nid);

  const upserts: {
    trees?: ReturnType<typeof serializeTreeRow>[];
    nodes?: NonNullable<ReturnType<typeof serializeNodeRow>>[];
    edges?: ReturnType<typeof serializeEdgeRow>[];
    messages?: ReturnType<typeof serializeMessageRowsForNode>;
    contexts?: ReturnType<typeof serializeContextRow>[];
  } = {};

  const nodeRows = Array.from(nodeIdsToUpsert)
    .map((nid) => serializeNodeRow(project, nodes, nid))
    .filter((r): r is NonNullable<typeof r> => r != null);
  if (nodeRows.length > 0) upserts.nodes = nodeRows;

  // Messages: FULL current message rows for each still-existing dirty node.
  // A node whose messages dropped to zero contributes nothing here but is still
  // listed in messageReconcileNodeIds below, so the backend wipes its messages.
  const messageRows = Array.from(dirty.messageNodeIds)
    .filter((nid) => chatIdSet.has(nid))
    .flatMap((nid) => serializeMessageRowsForNode(nodes, nid));
  if (messageRows.length > 0) upserts.messages = messageRows;

  const edgeRows = Array.from(dirty.edgeUpsertIds)
    .map((id) => edgeById.get(id))
    .filter((e): e is NonNullable<typeof e> => e != null)
    .map((e) => serializeEdgeRow(project, e));
  if (edgeRows.length > 0) upserts.edges = edgeRows;

  const treeRows = Array.from(dirty.treeUpsertIds)
    .map((id) => treeById.get(id))
    .filter((t): t is NonNullable<typeof t> => t != null)
    .map((t) => serializeTreeRow(project, t));
  if (treeRows.length > 0) upserts.trees = treeRows;

  const contextRows = Array.from(dirty.contextUpsertIds)
    .map((id) => contextById.get(id))
    .filter((c): c is NonNullable<typeof c> => c != null)
    .map((c) => serializeContextRow(project, c));
  if (contextRows.length > 0) upserts.contexts = contextRows;

  const deletes: { edges?: string[]; trees?: string[]; contexts?: string[] } = {};
  if (dirty.edgeDeleteIds.size > 0) deletes.edges = Array.from(dirty.edgeDeleteIds);
  if (dirty.treeDeleteIds.size > 0) deletes.trees = Array.from(dirty.treeDeleteIds);
  if (dirty.contextDeleteIds.size > 0) deletes.contexts = Array.from(dirty.contextDeleteIds);

  const payload: {
    mode: 'delta';
    workspace?: ReturnType<typeof serializeWorkspaceRow>;
    upserts: typeof upserts;
    deletes: typeof deletes;
    messageReconcileNodeIds?: string[];
  } = { mode: 'delta', upserts, deletes };

  if (dirty.workspaceChanged) payload.workspace = serializeWorkspaceRow(project);
  if (dirty.messageNodeIds.size > 0) {
    payload.messageReconcileNodeIds = Array.from(dirty.messageNodeIds);
  }

  return payload;
}

// ── L2: per-row rev tracking + conflict reconciliation ─────────────────────
// `rev` is the server-authoritative version a row was last written at. We keep
// it in a DEDICATED ref map (revByEntityIdRef), NOT on the reactive entities,
// for two reasons:
//   1. If rev lived on the entity, advancing it on ack would mint a new object,
//      re-triggering the dirty-tracking effect → an infinite re-sync loop that
//      grows sync_rev without bound.
//   2. Keeping rev off the entity guarantees the row serializers above stay
//      byte-identical, preserving the L1b delta==full convergence guarantee.
// The map key is the SAME row id the serializers and backend use: nodeId,
// serializedEdgeId(edge), treeId, contextId, and derived message id.

/**
 * For each id in `ids`, return its last-seen rev from the ref map, or null when
 * unknown (legacy / never-synced row → server `accepts()` treats null baseRev
 * as a no-claim and accepts). Pure; exported for tests.
 */
export function collectBaseRevs(
  ids: Iterable<string>,
  revByEntityId: Map<string, number>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const id of ids) out[id] = revByEntityId.get(id) ?? null;
  return out;
}

/**
 * Collect every row id present in a sync payload — both the full snapshot shape
 * ({workspace, trees, nodes, edges, messages, contexts}) and the delta shape
 * ({upserts:{...}, deletes}). Deletes are intentionally excluded (the backend
 * does not guard deletes). The workspace row itself is keyed separately (by
 * project id via syncRevByProjectRef), so it is not included here.
 */
export function collectSentRowIds(payload: unknown): Set<string> {
  const ids = new Set<string>();
  if (!payload || typeof payload !== 'object') return ids;
  const p = payload as Record<string, unknown>;
  const addRows = (rows: unknown) => {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      const id = r && typeof r === 'object' ? (r as Record<string, unknown>).id : undefined;
      if (typeof id === 'string' && id.length > 0) ids.add(id);
    }
  };
  // Full snapshot: top-level row arrays.
  addRows(p.trees);
  addRows(p.nodes);
  addRows(p.edges);
  addRows(p.messages);
  addRows(p.contexts);
  // Delta: upserts.{trees,nodes,edges,messages,contexts}.
  const upserts = p.upserts;
  if (upserts && typeof upserts === 'object') {
    const u = upserts as Record<string, unknown>;
    addRows(u.trees);
    addRows(u.nodes);
    addRows(u.edges);
    addRows(u.messages);
    addRows(u.contexts);
  }
  return ids;
}

/**
 * THE self-conflict fix. For every row id that was SENT this flush and is NOT in
 * `conflictIds`, advance its local base rev to `newRev`. Because rev lives in a
 * ref (not the entity), this does NOT re-dirty anything. Canonical rule: the
 * client that wrote a row is authoritative until another device bumps past — so
 * its base rev becomes `newRev`, and the next sync of that row sends
 * baseRev=newRev → server stored==newRev → accepts(newRev,newRev)=true → never
 * self-conflicts. Pure (mutates the passed map); exported for tests.
 */
export function advanceAcceptedRevs(
  revByEntityId: Map<string, number>,
  sentIds: Iterable<string>,
  conflictIds: Iterable<string>,
  newRev: number,
): void {
  const conflicted = new Set(conflictIds);
  for (const id of sentIds) {
    if (!conflicted.has(id)) revByEntityId.set(id, newRev);
  }
}

/**
 * Decide whether a project's backend sync must be retried on the next flush.
 *
 * The flush clears the local dirty state as soon as the localStorage write
 * succeeds, BEFORE the async backend POST resolves. If that POST does not
 * durably land, the change would be silently dropped (next backend-first
 * hydration overwrites local with the stale server value). This returns true
 * for every non-durable outcome so the caller can re-mark the project:
 *   - `failed` (the promise rejected: network / 500 / SQLITE_BUSY past
 *     busy_timeout — syncWorkspace throws on !res.ok),
 *   - a missing response body, or
 *   - an explicit `ok: false`.
 * A normal `{ ok: true, ... }` (including a tombstoned `{ ok: true, ignored }`)
 * returns false. Pure; exported for tests.
 */
export function shouldRetryBackendSync(
  outcome: SyncWorkspaceResponse | null | undefined,
  failed: boolean,
): boolean {
  if (failed) return true;
  if (!outcome) return true;
  return outcome.ok === false;
}

/** Read an integer `rev` off a raw backend row (SELECT * shape). */
function readRowRev(row: unknown): number | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const v = (row as Record<string, unknown>).rev;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Adopt the server's value for each conflicted row into the reactive state
 * (§5.3 converge-to-server), per-row. Only the conflicted ids are touched —
 * unconflicted local edits are preserved (we do NOT re-pull the whole
 * workspace). Returns new {projects, nodes} (or the same references when
 * nothing changed) and writes the adopted rows' server rev into
 * `revByEntityId`. Pure w.r.t. the inputs; exported for tests.
 */
export function adoptConflictsIntoState(
  projects: Project[],
  nodes: Record<string, ChatNodeState>,
  conflicts: NonNullable<SyncWorkspaceResponse['conflicts']>,
  projectId: string,
  revByEntityId: Map<string, number>,
): { projects: Project[]; nodes: Record<string, ChatNodeState> } {
  if (conflicts.length === 0) return { projects, nodes };

  let nextNodes = nodes;
  // Track which project objects we have cloned so repeated edits share one copy.
  const projectClones = new Map<string, Project>();
  const getProjectClone = (pid: string): Project | undefined => {
    const existing = projectClones.get(pid);
    if (existing) return existing;
    const orig = projects.find((p) => p.id === pid);
    if (!orig) return undefined;
    const clone: Project = {
      ...orig,
      edges: [...orig.edges],
      trees: [...orig.trees],
      contexts: orig.contexts ? [...orig.contexts] : orig.contexts,
    };
    projectClones.set(pid, clone);
    return clone;
  };

  for (const c of conflicts) {
    const serverRow = c.serverRow as Record<string, unknown> | null;
    if (!serverRow || typeof serverRow !== 'object') continue;
    const rev = readRowRev(serverRow);

    switch (c.table) {
      case 'nodes': {
        const prev = nextNodes[c.id];
        if (!prev) break; // node not locally present — nothing to converge into
        const scalars = mapNodeRowScalars(serverRow);
        // Spread server scalars over the local node, preserving cross-row
        // derived state (messages append-only/reconciled separately, plus
        // mergeSources/digest/projectId the single-row mapper cannot know).
        const merged: ChatNodeState = {
          ...prev,
          ...scalars,
          projectId: prev.projectId,
          mergeSources: prev.mergeSources,
          messages: prev.messages,
          digest: prev.digest,
        } as ChatNodeState;
        nextNodes = { ...nextNodes, [c.id]: merged };
        if (rev !== undefined) revByEntityId.set(c.id, rev);
        break;
      }
      case 'edges': {
        const edge = mapEdgeRow(serverRow);
        if (!edge) break;
        const clone = getProjectClone(projectId);
        if (!clone) break;
        const idx = clone.edges.findIndex((e) => serializedEdgeId(e) === c.id);
        if (idx >= 0) clone.edges[idx] = edge;
        else clone.edges.push(edge);
        if (rev !== undefined) revByEntityId.set(c.id, rev);
        break;
      }
      case 'trees': {
        const tree = mapTreeRow(serverRow);
        if (!tree) break;
        const clone = getProjectClone(projectId);
        if (!clone) break;
        const idx = clone.trees.findIndex((t) => t.id === c.id);
        if (idx >= 0) clone.trees[idx] = tree;
        else clone.trees.push(tree);
        if (rev !== undefined) revByEntityId.set(c.id, rev);
        break;
      }
      case 'contexts': {
        const ctx = mapContextRow(serverRow);
        if (!ctx) break;
        const clone = getProjectClone(projectId);
        if (!clone) break;
        const list = clone.contexts ?? [];
        const idx = list.findIndex((x) => x.id === c.id);
        if (idx >= 0) list[idx] = ctx;
        else list.push(ctx);
        clone.contexts = list;
        if (rev !== undefined) revByEntityId.set(c.id, rev);
        break;
      }
      case 'messages': {
        const nodeId = asString(serverRow.node_id);
        if (!nodeId) break;
        const node = nextNodes[nodeId];
        if (!node) break;
        const msg = mapMessageRow(serverRow);
        const idx = node.messages.findIndex((m) => m.id === c.id);
        const nextMessages = idx >= 0
          ? node.messages.map((m, i) => (i === idx ? msg : m))
          : [...node.messages, msg];
        nextNodes = { ...nextNodes, [nodeId]: { ...node, messages: nextMessages } };
        if (rev !== undefined) revByEntityId.set(c.id, rev);
        break;
      }
      default:
        break;
    }
  }

  const nextProjects = projectClones.size > 0
    ? projects.map((p) => projectClones.get(p.id) ?? p)
    : projects;

  return { projects: nextProjects, nodes: nextNodes };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Seed the rev refs from freshly-fetched backend workspaces (the full
 * `{workspace, trees, nodes, edges, messages, contexts}` shape, rows carrying
 * `rev` / `sync_rev` via SELECT *). The per-row key is `row.id` — which the
 * backend stores using the SAME derivation the serializers use (edge ids are
 * `${kind}-${source}-${target}`, message ids the persisted id), so the keys
 * line up with what collectBaseRevs later looks up. Rows without a numeric rev
 * (legacy / NULL) are skipped → their baseRev stays null → server accepts.
 * Mutates the passed maps; exported for tests.
 */
export function populateRevsFromBackend(
  rawWorkspaces: unknown[],
  revByEntityId: Map<string, number>,
  syncRevByProject: Map<string, number>,
): void {
  if (!Array.isArray(rawWorkspaces)) return;
  const seedRows = (rows: unknown) => {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const row = r as Record<string, unknown>;
      const id = asString(row.id);
      const rev = readRowRev(row);
      if (id && rev !== undefined) revByEntityId.set(id, rev);
    }
  };
  for (const raw of rawWorkspaces) {
    if (!raw || typeof raw !== 'object') continue;
    const full = raw as Record<string, unknown>;
    const workspace = full.workspace as Record<string, unknown> | undefined;
    const wsId = workspace ? asString(workspace.id) : undefined;
    if (wsId && workspace) {
      const syncRev = workspace.sync_rev;
      if (typeof syncRev === 'number' && Number.isFinite(syncRev)) {
        syncRevByProject.set(wsId, syncRev);
      }
    }
    seedRows(full.trees);
    seedRows(full.nodes);
    seedRows(full.edges);
    seedRows(full.messages);
    seedRows(full.contexts);
  }
}

interface ScopedWriteArgs {
  baseKey: string;
  projects: Project[];
  activeProjectId: string | null;
  nodes: Record<string, ChatNodeState>;
  /** Projects whose content changed (and removed-project ids, for cleanup). */
  changedIds: Set<string>;
  /** True when the project list or activeProjectId changed (index needs a rewrite). */
  indexDirty: boolean;
}

/**
 * Write only the changed projects to per-project localStorage keys, plus a small
 * index. Invariants:
 *  - Seed-on-first-write: when no index exists yet, persist EVERY current project
 *    once (so the index never references a missing blob) and drop the legacy
 *    single-key blob. Subsequent writes are scoped to `changedIds`.
 *  - A changed id with no current project = a deleted project -> removeItem.
 *  - Each blob write is isolated; one quota failure does not abort the flush.
 *  - Blobs are written before the index within a single flush.
 */
export function writeScopedLocalStorage({
  baseKey,
  projects,
  activeProjectId,
  nodes,
  changedIds,
  indexDirty,
}: ScopedWriteArgs): void {
  if (typeof window === 'undefined') return;
  const ls = window.localStorage;
  const indexKey = stateIndexKey(baseKey);
  // If the index write below fails (e.g. quota), the next flush re-detects
  // seeding=true and retries — intentional self-healing so a partial seed is
  // always completed before delta writes begin.
  const seeding = ls.getItem(indexKey) == null;

  const projectById = new Map(projects.map((p) => [p.id, p]));
  // First write seeds all projects; later writes only touch changed ones.
  const idsToWrite = seeding ? new Set(projects.map((p) => p.id)) : changedIds;

  for (const pid of idsToWrite) {
    const project = projectById.get(pid);
    if (!project) {
      // Removed project — drop its blob.
      try {
        ls.removeItem(stateProjectKey(baseKey, pid));
      } catch {
        /* ignore */
      }
      continue;
    }
    const subset: Record<string, ChatNodeState> = {};
    for (const nid of project.chatIds) {
      const n = nodes[nid];
      if (n) subset[nid] = n;
    }
    try {
      ls.setItem(stateProjectKey(baseKey, pid), JSON.stringify({ project, nodes: subset }));
    } catch (err) {
      // Isolated: a quota failure on one project does not abort the others.
      console.warn(`persist project blob failed (${pid}):`, err);
    }
  }

  // Rewrite the index when seeding, when the project set / active changed, or
  // when any project blob was (re)written this flush.
  // Also refresh the index whenever any blob was written, so its version stays current.
  if (seeding || indexDirty || changedIds.size > 0) {
    let diskIds: string[] = [];
    try {
      const rawPrev = ls.getItem(indexKey);
      if (rawPrev) {
        const prev = JSON.parse(rawPrev) as Partial<StateIndex>;
        if (Array.isArray(prev.projectIds)) {
          diskIds = prev.projectIds.filter((x): x is string => typeof x === 'string');
        }
      }
    } catch {
      // Malformed prior index: treat as empty and let this write reseed it.
    }

    const removedThisFlush = new Set<string>();
    for (const pid of changedIds) {
      if (!projectById.has(pid)) removedThisFlush.add(pid);
    }
    const projectIds = mergeIndexProjectIds(
      diskIds,
      projects.map((p) => p.id),
    ).filter((id) => !removedThisFlush.has(id));

    const index: StateIndex = {
      // The index carries the schema version, but per-project blobs are NOT
      // re-written on a version bump (only changed ones are). A future
      // STATE_SCHEMA_VERSION change must therefore force a full re-seed
      // (e.g. bump the key prefix) rather than rely on this field alone.
      version: STATE_SCHEMA_VERSION,
      activeProjectId,
      projectIds,
    };
    try {
      ls.setItem(indexKey, JSON.stringify(index));
    } catch (err) {
      console.warn('persist index failed:', err);
    }
  }

  // After a successful seed, reclaim the legacy single-key blob for this
  // namespace. The /migrate path now reads via readLocalStoragePayload, so the
  // data is still reachable. LEGACY_STATE_KEY (if different) is left for the
  // migrate sentinel logic and is cleared by signOut.
  if (seeding) {
    try {
      ls.removeItem(baseKey);
    } catch {
      /* ignore */
    }
  }
}

interface UseWorkspacePersistenceArgs {
  projects: Project[];
  activeProjectId: string | null;
  nodes: Record<string, ChatNodeState>;
  hydrated: boolean;
  nodesRef: MutableRefObject<Record<string, ChatNodeState>>;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setActiveProjectId: Dispatch<SetStateAction<string | null>>;
  setNodes: Dispatch<SetStateAction<Record<string, ChatNodeState>>>;
  setHydrated: Dispatch<SetStateAction<boolean>>;
  /** Authenticated user ID. When present, workspace state is stored under
   *  michi:v1:state:<userId> instead of the shared michi:v1:state key. */
  userId?: string;
  /** Stable per-window id used to resolve activeProjectId during async hydration. */
  windowId?: string;
  /**
   * Held true by destructive async actions while they await a backend purge
   * endpoint. The 2s sync interval inspects this and skips its POST /sync
   * tick so a pre-purge snapshot can't race-cover the explicit DELETE.
   * Optional for backwards compat with tests that mount the hook directly.
   */
  syncPausedRef?: MutableRefObject<boolean>;
}

export function useWorkspacePersistence({
  projects,
  activeProjectId,
  nodes,
  hydrated,
  nodesRef,
  setProjects,
  setActiveProjectId,
  setNodes,
  setHydrated,
  userId,
  windowId,
  syncPausedRef,
}: UseWorkspacePersistenceArgs) {
  // Compute the active localStorage key for this session. When userId is known,
  // use the per-user namespaced key; fall back to the legacy shared key so that
  // no-auth / Electron deployments continue to work unmodified.
  const storageKey = userId ? buildStateKey(userId) : LEGACY_STATE_KEY;
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;
  const resolveActiveProjectForWindow = (legacy: string | null): string | null =>
    windowId ? readActiveProjectId(storageKeyRef.current, windowId, legacy) : legacy;

  // One-shot migration: if the legacy shared key has data and the per-user key
  // does not, copy the legacy data into the per-user slot (idempotent — guard
  // prevents repeated copies). Then record michi:migrated = '1' so that
  // signOutAndReset() knows to clean it up on the next sign-out.
  useEffect(() => {
    if (!userId) return;
    const perUserKey = buildStateKey(userId);
    const alreadyMigrated = window.localStorage.getItem(MIGRATED_KEY) === '1';
    if (alreadyMigrated) return;
    const legacyRaw = window.localStorage.getItem(LEGACY_STATE_KEY);
    const perUserRaw = window.localStorage.getItem(perUserKey);
    if (legacyRaw && !perUserRaw) {
      try {
        window.localStorage.setItem(perUserKey, legacyRaw);
        window.localStorage.setItem(MIGRATED_KEY, '1');
      } catch {
        // Quota error or private browsing — silently skip.
      }
    }
  }, [userId]);
  const projectsRef = useRef(projects);
  const activeProjectIdRef = useRef(activeProjectId);
  const hydratedRef = useRef(hydrated);
  const dirtyRef = useRef(false);
  const dirtyProjectIdsRef = useRef(new Set<string>());
  // Entity-granular pending delta per dirty project, accumulated across ticks
  // and drained on a successful backend flush (in lockstep with the
  // project-granular dirty refs). The localStorage path stays project-granular;
  // only the backend /sync path consumes this finer map.
  const dirtyDeltaByProjectRef = useRef(new Map<string, WorkspaceDirtyDelta>());
  // L2 server-authoritative rev tracking. Kept in dedicated refs (NOT on the
  // reactive entities) so advancing a rev on ack cannot re-trigger the
  // dirty-tracking effect and cannot perturb the byte-identical row
  // serializers. Keys: per-row last-seen rev (key = serializer/backend row id)
  // and per-workspace last-seen sync_rev (key = project id).
  const revByEntityIdRef = useRef(new Map<string, number>());
  const syncRevByProjectRef = useRef(new Map<string, number>());
  // Timestamp of the last FULL (mode:'full') backend sync. The flush sends a
  // full snapshot instead of a delta once this is older than the cadence,
  // self-healing any entity-level dirty mis-attribution.
  const lastFullSyncAtRef = useRef(0);
  // Projects whose backend sync did NOT durably land (rejected / ok:false)
  // AFTER the local dirty refs were already cleared. Re-flushed as a FULL
  // snapshot on the next tick so a transient backend failure (SQLITE_BUSY past
  // busy_timeout, network blip, 500) can never silently drop a change. Each id
  // is cleared on a confirmed-accepted sync. (spec §18/D12 "backend-dirty 集合")
  const backendDirtyRef = useRef(new Set<string>());
  // Index needs rewriting when the project list or activeProjectId changes,
  // independent of whether any project's content changed.
  const indexDirtyRef = useRef(false);
  // Guards against scheduling multiple idle flushes before the first one runs.
  const idleScheduledRef = useRef(false);
  const justHydratedRef = useRef(false);
  const prevProjectsRef = useRef<Project[]>(projects);
  const prevNodesRef = useRef<Record<string, ChatNodeState>>(nodes);
  const prevActiveProjectIdRef = useRef<string | null>(activeProjectId);
  projectsRef.current = projects;
  activeProjectIdRef.current = activeProjectId;
  hydratedRef.current = hydrated;

  // Mark dirty when state changes (only after hydration completes).
  // Skip the first render after hydration to avoid writing back the state
  // that was just loaded from the backend.
  // Tracks which specific projects changed so the interval only syncs those.
  useEffect(() => {
    if (!hydrated) return;
    if (!justHydratedRef.current) {
      justHydratedRef.current = true;
      prevProjectsRef.current = projects;
      prevNodesRef.current = nodes;
      prevActiveProjectIdRef.current = activeProjectId;
      return;
    }
    // Detect which projects changed (content), were added, or were removed.
    // For each dirty project, accumulate entity-granular delta via the pure
    // accumulateWorkspaceDirtyDelta helper (which owns the symmetric upsert/
    // delete invariant and the node-diff logic).
    const changed = new Set<string>();
    let listChanged = false;
    const prevProjectById = new Map(prevProjectsRef.current.map((pp) => [pp.id, pp] as const));

    for (const p of projects) {
      const prev = prevProjectById.get(p.id);
      if (!prev) {
        changed.add(p.id);
        listChanged = true; // added
      } else if (prev !== p) {
        changed.add(p.id); // content changed
      }
      // Accumulate entity-granular delta for every project that is new or
      // changed (accumulateWorkspaceDirtyDelta is a no-op when prev===cur for
      // all fields, so calling it on unchanged projects is safe but skipped
      // here for efficiency via the `changed` guard).
      if (changed.has(p.id)) {
        const existing = dirtyDeltaByProjectRef.current.get(p.id) ?? emptyWorkspaceDirtyDelta();
        dirtyDeltaByProjectRef.current.set(
          p.id,
          accumulateWorkspaceDirtyDelta(prev, p, prevNodesRef.current, nodes, existing),
        );
      }
    }
    for (const pp of prevProjectsRef.current) {
      if (!projects.find((p) => p.id === pp.id)) {
        changed.add(pp.id);
        listChanged = true; // removed
        // Whole project removed. We do NOT attempt entity-level deletes here —
        // workspace deletion goes through dedicated DELETE endpoints, and the
        // periodic full-sync self-heal reconciles anything stale. Drop any
        // pending delta for it so we don't ship a delta for a gone project.
        dirtyDeltaByProjectRef.current.delete(pp.id);
      }
    }
    // Node changes that didn't cause a project-reference change (nodes is
    // separate from projects in the state shape). For those projects not yet
    // in `changed`, check if any of their nodes changed and accumulate.
    if (nodes !== prevNodesRef.current) {
      for (const p of projects) {
        if (changed.has(p.id)) continue; // already accumulated above
        let nodeTouched = false;
        for (const nid of p.chatIds) {
          if (nodes[nid] !== prevNodesRef.current[nid]) { nodeTouched = true; break; }
        }
        if (nodeTouched) {
          changed.add(p.id);
          const existing = dirtyDeltaByProjectRef.current.get(p.id) ?? emptyWorkspaceDirtyDelta();
          dirtyDeltaByProjectRef.current.set(
            p.id,
            accumulateWorkspaceDirtyDelta(p, p, prevNodesRef.current, nodes, existing),
          );
        }
      }
    }
    const activeChanged = activeProjectId !== prevActiveProjectIdRef.current;
    if (changed.size > 0 || activeChanged) {
      dirtyRef.current = true;
      for (const id of Array.from(changed)) dirtyProjectIdsRef.current.add(id);
      if (listChanged || activeChanged) indexDirtyRef.current = true;
    }
    prevProjectsRef.current = projects;
    prevNodesRef.current = nodes;
    prevActiveProjectIdRef.current = activeProjectId;
  }, [projects, activeProjectId, nodes]); // eslint-disable-line react-hooks/exhaustive-deps -- hydrated intentionally excluded to avoid marking dirty on hydration

  // Periodic save: flush changed projects to localStorage + backend every 2s
  // when dirty. The localStorage write is scoped to changed projects and run
  // off the critical path via requestIdleCallback; dirty refs are cleared
  // INSIDE the flush (not before scheduling) so a pending idle flush cannot be
  // lost if the tab unloads first.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const intervalId = window.setInterval(() => {
      // Fire when something changed locally OR a prior backend sync still owes
      // a retry. Without the backendDirtyRef clause, a project that failed to
      // sync but has no new local edits would never get re-sent.
      if ((!dirtyRef.current && backendDirtyRef.current.size === 0) || !hydratedRef.current) return;
      // Skip while a destructive async action is mid-flight (see syncPausedRef).
      if (syncPausedRef?.current) return;
      // A flush is already queued — let it drain the (possibly grown) dirty set.
      if (idleScheduledRef.current) return;

      const flush = () => {
        idleScheduledRef.current = false;
        // Snapshot dirty state, then clear ONLY on a successful write so a
        // failed flush is retried on the next tick.
        const changedIds = new Set(Array.from(dirtyProjectIdsRef.current));
        const indexDirty = indexDirtyRef.current;

        // Snapshot the per-project deltas alongside the project-granular set so
        // both clear together only on a successful local write.
        const deltaSnapshot = new Map(dirtyDeltaByProjectRef.current);

        try {
          writeScopedLocalStorage({
            baseKey: storageKeyRef.current,
            projects: projectsRef.current,
            activeProjectId: activeProjectIdRef.current,
            nodes: nodesRef.current,
            changedIds,
            indexDirty,
          });
          dirtyRef.current = false;
          dirtyProjectIdsRef.current.clear();
          dirtyDeltaByProjectRef.current.clear();
          indexDirtyRef.current = false;
        } catch (err) {
          console.warn('persist failed:', err);
          // dirtyRef stays true -> next tick retries.
        }

        // Periodic full-sync self-heal: on a slow cadence (every 60s) send a
        // FULL snapshot instead of a delta for the dirty projects. This heals
        // any entity-level dirty mis-attribution that a long delta-only streak
        // could accumulate. The localStorage path above is unchanged either way.
        const FULL_SYNC_INTERVAL_MS = 60_000;
        const doFullSync = Date.now() - lastFullSyncAtRef.current > FULL_SYNC_INTERVAL_MS;
        if (doFullSync) lastFullSyncAtRef.current = Date.now();

        // Backend sync: only projects whose CONTENT changed. Uses the snapshot
        // regardless of the local write outcome (idempotent delete+reinsert).
        // Per project, send a DELTA (cheap, incremental) — or a FULL snapshot on
        // the slow self-heal cadence.
        // Projects to push this flush: those whose content changed since the
        // last flush, PLUS any owed a retry from a prior backend failure.
        const backendIds = new Set<string>(changedIds);
        for (const id of backendDirtyRef.current) backendIds.add(id);

        for (const project of projectsRef.current) {
          if (!backendIds.has(project.id)) continue;
          const projectId = project.id;
          // A retry's per-project delta was cleared when its earlier flush
          // cleared the dirty refs, so re-send it as a FULL snapshot of current
          // state — always correct and self-healing — exactly like the slow
          // full-sync cadence.
          const isRetry = backendDirtyRef.current.has(projectId);
          const sendFull = doFullSync || isRetry;
          const body = sendFull
            ? serializeWorkspaceForSync(project, nodesRef.current)
            : serializeWorkspaceDelta(
                project,
                nodesRef.current,
                deltaSnapshot.get(project.id) ?? emptyWorkspaceDirtyDelta(),
              );
          // Attach baseRevs as a SIBLING field on the payload (NOT inside the
          // serialized rows — keeps them byte-identical for convergence). The
          // ids are exactly the rows we are sending, read straight off the body
          // so the full and delta paths share one extraction.
          const sentIds = collectSentRowIds(body);
          const payload = {
            ...body,
            baseRevs: collectBaseRevs(sentIds, revByEntityIdRef.current),
            // H2 freshness gate: only by-absence reconcile-delete (the FULL
            // snapshot) needs to prove freshness, so baseSyncRev rides every
            // full send — the slow cadence AND a retry. The delta path never
            // deletes by absence, so it omits baseSyncRev.
            ...(sendFull
              ? { baseSyncRev: syncRevByProjectRef.current.get(projectId) ?? null }
              : {}),
          };
          syncWorkspace(projectId, payload)
            .then((resp) => {
              // Not durably accepted (rejected handled in .catch; here: no body
              // or explicit ok:false) → leave the project owed a retry.
              if (shouldRetryBackendSync(resp, false)) {
                backendDirtyRef.current.add(projectId);
                dirtyRef.current = true; // ensure the next tick wakes the flush
                return;
              }
              // Durably accepted → clear any pending retry for this project.
              backendDirtyRef.current.delete(projectId);
              // Tombstoned workspace short-circuit — nothing to advance/adopt.
              if (resp.ignored) return;
              const conflicts = resp.conflicts ?? [];
              const conflictIds = conflicts.map((c) => c.id);
              // Advance every accepted row's local rev → newRev (the self-
              // conflict fix). Because rev is in a ref, this does NOT re-dirty
              // anything. Also advance the workspace sync_rev.
              if (typeof resp.newRev === 'number') {
                advanceAcceptedRevs(revByEntityIdRef.current, sentIds, conflictIds, resp.newRev);
                syncRevByProjectRef.current.set(projectId, resp.newRev);
              }
              // Per-row adopt-server for conflicts (§5.3 converge-to-server):
              // replace ONLY the conflicted ids in reactive state; unconflicted
              // local edits stay. Do NOT re-pull the whole workspace.
              if (conflicts.length > 0) {
                console.warn('[sync] conflict', projectId, conflictIds);
                const curProjects = projectsRef.current;
                const curNodes = nodesRef.current;
                const adopted = adoptConflictsIntoState(
                  curProjects,
                  curNodes,
                  conflicts,
                  projectId,
                  revByEntityIdRef.current,
                );
                if (adopted.nodes !== curNodes) {
                  nodesRef.current = adopted.nodes;
                  setNodes(adopted.nodes);
                }
                if (adopted.projects !== curProjects) {
                  setProjects(adopted.projects);
                }
              }
            })
            .catch((err) => {
              console.warn(`workspace sync failed (${projectId}):`, err);
              // Re-mark so the next tick retries (full snapshot). Without this a
              // transient failure (SQLITE_BUSY past busy_timeout, network, 500)
              // is silently dropped after the dirty refs were already cleared.
              backendDirtyRef.current.add(projectId);
              dirtyRef.current = true;
            });
        }
      };

      idleScheduledRef.current = true;
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(flush, { timeout: 2000 });
      } else {
        flush(); // jsdom / older Safari: run synchronously.
      }
    }, 2000);
    return () => window.clearInterval(intervalId);
  }, [nodesRef]); // eslint-disable-line react-hooks/exhaustive-deps -- syncPausedRef is a stable MutableRefObject; .current is read at call time

  // Flush on beforeunload: synchronous scoped localStorage write + best-effort
  // SQLite sync. Cannot use requestIdleCallback here (it won't run during
  // unload), so this reads the CURRENT dirty refs directly. If an idle flush
  // was pending (refs not yet cleared), this captures it; if it already ran
  // (refs cleared), changedIds is empty and nothing is rewritten.
  useEffect(() => {
    const handleBeforeUnload = () => {
      const changedIds = new Set(Array.from(dirtyProjectIdsRef.current));
      // Refs are intentionally NOT cleared here — the tab is unloading, so
      // next-tick cleanup is irrelevant.
      try {
        writeScopedLocalStorage({
          baseKey: storageKeyRef.current,
          projects: projectsRef.current,
          activeProjectId: activeProjectIdRef.current,
          nodes: nodesRef.current,
          changedIds,
          indexDirty: indexDirtyRef.current,
        });
      } catch {
        // Best-effort: quota errors or private browsing may prevent writes.
      }
      // Best-effort SQLite flush for changed projects. NOTE: browsers cancel
      // pending fetch() on unload, so this often silently fails; localStorage
      // above is the reliable path and SQLite catches up on next interval /
      // restart.
      for (const project of projectsRef.current) {
        if (!changedIds.has(project.id)) continue;
        syncWorkspace(project.id, serializeWorkspaceForSync(project, nodesRef.current)).catch(() => {});
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [nodesRef]);

  const initialActiveProjectIdRef = useRef(activeProjectId);

  useEffect(() => {
    let cancelled = false;
    const installNodes = (next: Record<string, ChatNodeState>) => {
      nodesRef.current = next;
      setNodes(next);
    };
    const finishHydration = (hydrateSource: string) => {
      startupMarkOnce('state_hydrate_done', { hydrateSource });
      setHydrated(true);
    };
    startupMarkOnce('state_hydrate_start');
    (async () => {
      try {
        const fullWorkspaces = await fetchAllWorkspaces();
        if (cancelled) return;
        if (Array.isArray(fullWorkspaces) && fullWorkspaces.length > 0) {
          const rawBackend = fullWorkspaces.filter(
            (w): w is Record<string, unknown> => !!w && typeof w === 'object',
          );
          // Seed rev refs from the raw backend rows BEFORE hydrating, so the
          // first /sync after boot carries correct baseRevs (key = serializer
          // row id). The localStorage-only path below leaves the refs empty
          // (→ baseRev null → server accepts; correct for offline).
          populateRevsFromBackend(rawBackend, revByEntityIdRef.current, syncRevByProjectRef.current);
          const backendState = hydrateBackendWorkspaces(
            rawBackend,
            initialActiveProjectIdRef.current,
          );
          if (backendState.projects.length > 0) {
            setProjects(backendState.projects);
            setActiveProjectId(resolveActiveProjectForWindow(backendState.activeProjectId));
            installNodes(backendState.nodes);
          }
          finishHydration('backend');
        } else {
          const alreadyMigrated = window.localStorage.getItem(MIGRATED_KEY) === '1';
          // Raw payload (new per-project layout OR legacy single key). Used for
          // both the /migrate POST (raw shape) and local install (hydrated).
          const payload = readLocalStoragePayload(userId);
          const lsState = payload ? hydrateSavedState(payload) : EMPTY_HYDRATED;
          if (!alreadyMigrated && payload && payload.projects.length > 0) {
            try {
              await migrateLocalStorage(payload);
              window.localStorage.setItem(MIGRATED_KEY, '1');
              const wsAfter = await fetchWorkspaces();
              if (cancelled) return;
              if (Array.isArray(wsAfter) && wsAfter.length > 0) {
                const full = (
                  await Promise.all(
                    wsAfter.map(async (row) => {
                      const id = readWorkspaceRowId(row);
                      return id ? fetchWorkspace(id) : null;
                    }),
                  )
                ).filter((w): w is Record<string, unknown> => !!w && typeof w === 'object');
                if (cancelled) return;
                // Seed rev refs from the post-migration backend rows too.
                populateRevsFromBackend(full, revByEntityIdRef.current, syncRevByProjectRef.current);
                const migrated = hydrateBackendWorkspaces(full, lsState.activeProjectId);
                setProjects(migrated.projects);
                setActiveProjectId(resolveActiveProjectForWindow(migrated.activeProjectId));
                installNodes(migrated.nodes);
                finishHydration('migration');
              }
            } catch {
              if (cancelled) return;
              setProjects(lsState.projects);
              setActiveProjectId(resolveActiveProjectForWindow(lsState.activeProjectId));
              installNodes(lsState.nodes);
              finishHydration('localStorage');
            }
          } else if (lsState.projects.length > 0) {
            if (cancelled) return;
            setProjects(lsState.projects);
            setActiveProjectId(resolveActiveProjectForWindow(lsState.activeProjectId));
            installNodes(lsState.nodes);
          }
          if (!cancelled) finishHydration(lsState.projects.length > 0 ? 'localStorage' : 'empty');
        }
      } catch {
        if (!cancelled) {
          const lsState = readLocalStorageState(userId);
          setProjects(lsState.projects);
          setActiveProjectId(resolveActiveProjectForWindow(lsState.activeProjectId));
          installNodes(lsState.nodes);
          finishHydration('fallbackLocalStorage');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nodesRef, setActiveProjectId, setHydrated, setNodes, setProjects, userId]);
}
