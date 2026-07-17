import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import {
  fetchAllWorkspacesMeta,
  fetchTreeMessages,
  fetchPersistenceCapabilities,
  fetchWorkspace,
  fetchWorkspaces,
  applyWorkspaceCommands,
} from '../services/api';
import type { WorkspaceCommand } from '../services/api';
import { findTreeIdForNode } from './tree';
import {
  hydrateBackendWorkspaces,
  hydrateSavedState,
  applyTreeMessages,
  buildMessagesByNode,
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
import { WorkspaceSyncQueue } from './workspaceSyncQueue';
import { API_BASE_URL } from '../config/env';

// Note: the inbound load path for `Project.aiGlobalContext` lives in
// `chatHydration.ts` (which actually maps backend workspace rows to Project
// shape). This file owns the outbound command-row serialization. The dedicated
// POST /workspaces/:id/ai-global-context endpoint also writes the same field
// directly, so the next load picks it up either way.

/** Prefix for per-user namespaced workspace state keys. */
export const STATE_KEY_PREFIX = 'michi:v1:state:';

/** Legacy shared key used before per-user namespacing. Kept for migration + signOut cleanup. */
export const LEGACY_STATE_KEY = 'michi:v1:state';

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

/** Remove the legacy durable chat mirror after backend v2 hydration succeeds. */
export function clearDurableLocalStorageMirror(baseKey: string): void {
  try {
    const rawIndex = window.localStorage.getItem(stateIndexKey(baseKey));
    if (rawIndex) {
      const parsed = JSON.parse(rawIndex) as Partial<StateIndex>;
      for (const projectId of parsed.projectIds ?? []) {
        window.localStorage.removeItem(stateProjectKey(baseKey, projectId));
      }
    }
    window.localStorage.removeItem(stateIndexKey(baseKey));
    window.localStorage.removeItem(baseKey);
  } catch {
    // Storage can be unavailable in private browsing; backend state remains authoritative.
  }
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
 * Backoff between hydration reachability retries while the backend is still
 * starting. Short enough that a cold start feels instant once the backend
 * binds; the loop only runs while every probe is rejecting.
 */
export const HYDRATION_RETRY_DELAY_MS = 250;

/**
 * Read the raw (pre-hydration) SavedState from localStorage. Prefers the new
 * per-project layout (index + per-project blobs) and falls back to the legacy
 * single-key blob. Returns null when nothing is stored. Does NOT run
 * hydrateSavedState — `readLocalStorageState` wraps the result for live state.
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
    // The command handler stores settings in a TEXT column, so pass a
    // serialized JSON string (or null).
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
    branch_overview: n.branchOverview || null,
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
    const metadata = m.role === 'assistant'
      ? (m.plan && m.plan.length > 0 ? { plan: m.plan } : null)
      : (m.quotedText || m.attachments?.length || m.comments?.length
          ? {
              quotedText: m.quotedText,
              attachments: m.attachments,
              comments: m.comments,
            }
          : null);
    return [{
      id: m.id || `${nid}-${i}`,
      node_id: nid,
      role: m.role,
      content: persisted.content,
      blocks: persisted.blocks,
      tool_calls: persisted.toolCalls.length > 0 ? JSON.stringify(persisted.toolCalls) : null,
      metadata: metadata ? JSON.stringify(metadata) : null,
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

export interface ExplicitCommandBatch {
  commands: WorkspaceCommand[];
  nodeProjectionUpdates: Map<string, string>;
}

function nodeCommandPatch(
  row: NonNullable<ReturnType<typeof serializeNodeRow>>,
  node: ChatNodeState,
): Record<string, unknown> {
  return {
    id: row.id,
    tree_id: row.tree_id,
    parent_node_id: row.parent_node_id,
    kind: row.kind,
    spawned_by_agent: row.spawned_by_agent,
    ...(node.titleNeedsPersistence ? { title: row.title } : {}),
    current_mode_id: row.current_mode_id,
    pane_width: row.pane_width,
    position_x: row.position_x,
    position_y: row.position_y,
    minimized: row.minimized,
    digest: row.digest,
    composer_draft: row.composer_draft,
    deleted_at: row.deleted_at,
    deletion_group_id: row.deletion_group_id,
    trim_snapshot: row.trim_snapshot,
  };
}

/** Convert an entity delta into explicit, message-free domain commands. */
export function buildExplicitWorkspaceCommands(
  project: Project,
  nodes: Record<string, ChatNodeState>,
  delta: WorkspaceDirtyDelta,
  knownNodeProjections: ReadonlyMap<string, string>,
): ExplicitCommandBatch {
  const commands: WorkspaceCommand[] = [];
  const nodeProjectionUpdates = new Map<string, string>();
  if (delta.workspaceChanged) {
    commands.push({ type: 'workspace.upsert', payload: serializeWorkspaceRow(project) });
  }

  for (const treeId of delta.treeUpsertIds) {
    const tree = project.trees.find((candidate) => candidate.id === treeId);
    if (tree) commands.push({ type: 'tree.upsert', payload: serializeTreeRow(project, tree) });
  }
  for (const nodeId of delta.nodeIds) {
    const row = serializeNodeRow(project, nodes, nodeId);
    if (!row) continue;
    const patch = nodeCommandPatch(row, nodes[nodeId]);
    const projection = JSON.stringify(patch);
    if (knownNodeProjections.get(nodeId) === projection) continue;
    commands.push({ type: 'node.upsert', payload: row });
    commands.push({ type: 'node.patch', payload: patch });
    nodeProjectionUpdates.set(nodeId, projection);
  }
  for (const edgeId of delta.edgeUpsertIds) {
    const edge = project.edges.find((candidate) => serializedEdgeId(candidate) === edgeId);
    if (edge) commands.push({ type: 'edge.upsert', payload: serializeEdgeRow(project, edge) });
  }
  for (const contextId of delta.contextUpsertIds) {
    const context = project.contexts?.find((candidate) => candidate.id === contextId);
    if (context) commands.push({ type: 'context.upsert', payload: serializeContextRow(project, context) });
  }
  for (const edgeId of delta.edgeDeleteIds) {
    commands.push({ type: 'edge.delete', payload: { id: edgeId } });
  }
  for (const contextId of delta.contextDeleteIds) {
    commands.push({ type: 'context.delete', payload: { id: contextId } });
  }
  for (const treeId of delta.treeDeleteIds) {
    commands.push({ type: 'tree.delete', payload: { id: treeId } });
  }
  return { commands, nodeProjectionUpdates };
}

export function mergeWorkspaceDirtyDelta(
  base: WorkspaceDirtyDelta,
  incoming: WorkspaceDirtyDelta,
): WorkspaceDirtyDelta {
  const merged = emptyWorkspaceDirtyDelta();
  for (const key of [
    'nodeIds', 'messageNodeIds', 'edgeUpsertIds', 'edgeDeleteIds',
    'treeUpsertIds', 'treeDeleteIds', 'contextUpsertIds', 'contextDeleteIds',
  ] as const) {
    for (const value of base[key]) merged[key].add(value);
    for (const value of incoming[key]) merged[key].add(value);
  }
  for (const id of merged.edgeUpsertIds) merged.edgeDeleteIds.delete(id);
  for (const id of merged.treeUpsertIds) merged.treeDeleteIds.delete(id);
  for (const id of merged.contextUpsertIds) merged.contextDeleteIds.delete(id);
  merged.workspaceChanged = base.workspaceChanged || incoming.workspaceChanged;
  return merged;
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
  /** Nodes whose message set changed. Turn messages persist outside this queue. */
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
    // Brand-new project: mark every structural entity so the first command
    // batch creates the whole workspace graph.
    d.workspaceChanged = true;
    for (const nid of cur.chatIds) {
      d.nodeIds.add(nid);
      // Never mark a lazy-load placeholder's messages dirty: its `messages:[]`
      // is NOT authoritative (bodies live unfetched in the DB). Only a node
      // whose bodies are loaded may drive message reconcile. See the
      // messagesLoaded invariant in chatTypes.
      if (curNodes[nid]?.messagesLoaded !== false) d.messageNodeIds.add(nid);
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
      // But never for a placeholder: its `messages:[]` is not authoritative.
      // The `messages-loaded` install flips messagesLoaded→true, so a genuine
      // load transition is picked up on the tick after loading, not suppressed.
      if (curN?.messagesLoaded !== false && (!prevN || curN?.messages !== prevN?.messages)) {
        d.messageNodeIds.add(nid);
      }
    }
  }

  return d;
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
  // namespace. Hydration reads via readLocalStoragePayload, so the data is
  // still reachable. LEGACY_STATE_KEY (if different) is left for the
  // legacy-shared→per-user key migration sentinel and is cleared by signOut.
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
  /** Authenticated user ID used to locate a pre-v2 localStorage migration payload. */
  userId?: string;
  /** Stable per-window id used to resolve activeProjectId during async hydration. */
  windowId?: string;
  /**
   * Held true by destructive async actions while they await a backend purge
   * endpoint. The 2s command flush inspects this so structural commands do not
   * race the explicit DELETE.
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
  // Compute the localStorage key used only for one-time migration and cleanup.
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
  const hydratedRef = useRef(hydrated);
  const dirtyRef = useRef(false);
  const dirtyProjectIdsRef = useRef(new Set<string>());
  // Entity-granular pending delta per dirty project, accumulated across ticks
  // and drained by explicit command batches.
  const dirtyDeltaByProjectRef = useRef(new Map<string, WorkspaceDirtyDelta>());
  const pendingCommandDeltaByProjectRef = useRef(new Map<string, WorkspaceDirtyDelta>());
  const nodeCommandProjectionRef = useRef(new Map<string, string>());
  const workspaceSyncQueueRef = useRef<WorkspaceSyncQueue | null>(null);
  if (!workspaceSyncQueueRef.current) {
    workspaceSyncQueueRef.current = new WorkspaceSyncQueue((err, projectId) => {
      console.warn(`workspace persistence queue task failed (${projectId}):`, err);
      dirtyRef.current = true;
    });
  }
  // Guards against scheduling multiple idle flushes before the first one runs.
  const idleScheduledRef = useRef(false);
  const justHydratedRef = useRef(false);
  const prevProjectsRef = useRef<Project[]>(projects);
  const prevNodesRef = useRef<Record<string, ChatNodeState>>(nodes);
  projectsRef.current = projects;
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
      for (const project of projects) {
        for (const nodeId of project.chatIds) {
          const row = serializeNodeRow(project, nodes, nodeId);
          if (!row) continue;
          nodeCommandProjectionRef.current.set(
            nodeId,
            JSON.stringify(nodeCommandPatch(row, nodes[nodeId])),
          );
        }
      }
      return;
    }
    // Detect which projects changed (content), were added, or were removed.
    // For each dirty project, accumulate entity-granular delta via the pure
    // accumulateWorkspaceDirtyDelta helper (which owns the symmetric upsert/
    // delete invariant and the node-diff logic).
    const changed = new Set<string>();
    const prevProjectById = new Map(prevProjectsRef.current.map((pp) => [pp.id, pp] as const));

    for (const p of projects) {
      const prev = prevProjectById.get(p.id);
      if (!prev) {
        changed.add(p.id);
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
        // Whole project removed. We do NOT attempt entity-level deletes here —
        // workspace deletion goes through dedicated DELETE endpoints. Drop any
        // pending commands for it so we don't write a gone project.
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
    if (changed.size > 0) {
      dirtyRef.current = true;
      for (const id of Array.from(changed)) dirtyProjectIdsRef.current.add(id);
    }
    prevProjectsRef.current = projects;
    prevNodesRef.current = nodes;
  }, [projects, nodes]); // eslint-disable-line react-hooks/exhaustive-deps -- hydrated intentionally excluded to avoid marking dirty on hydration

  // Periodically turn structural state changes into explicit v2 commands.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const intervalId = window.setInterval(() => {
      if (
        (!dirtyRef.current
          && pendingCommandDeltaByProjectRef.current.size === 0)
        || !hydratedRef.current
      ) return;
      // Skip while a destructive async action is mid-flight (see syncPausedRef).
      if (syncPausedRef?.current) return;
      // A flush is already queued — let it drain the (possibly grown) dirty set.
      if (idleScheduledRef.current) return;

      const flush = () => {
        idleScheduledRef.current = false;
        const deltaSnapshot = new Map(dirtyDeltaByProjectRef.current);

        for (const [projectId, delta] of deltaSnapshot) {
          const existing = pendingCommandDeltaByProjectRef.current.get(projectId) ?? emptyWorkspaceDirtyDelta();
          pendingCommandDeltaByProjectRef.current.set(
            projectId,
            mergeWorkspaceDirtyDelta(existing, delta),
          );
        }

        dirtyRef.current = false;
        dirtyProjectIdsRef.current.clear();
        dirtyDeltaByProjectRef.current.clear();

        for (const project of projectsRef.current) {
          if (!pendingCommandDeltaByProjectRef.current.has(project.id)) continue;
          const projectId = project.id;
          const queue = workspaceSyncQueueRef.current!;
          queue.enqueue(projectId, async () => {
            const latestProject = projectsRef.current.find((candidate) => candidate.id === projectId);
            const pending = pendingCommandDeltaByProjectRef.current.get(projectId);
            if (!latestProject || !pending) return;
            const batch = buildExplicitWorkspaceCommands(
              latestProject,
              nodesRef.current,
              pending,
              nodeCommandProjectionRef.current,
            );
            if (batch.commands.length === 0) {
              if (!queue.hasPending(projectId)) pendingCommandDeltaByProjectRef.current.delete(projectId);
              return;
            }
            const operationId = `cmd-${projectId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            await applyWorkspaceCommands(projectId, operationId, batch.commands);
            for (const [nodeId, projection] of batch.nodeProjectionUpdates) {
              nodeCommandProjectionRef.current.set(nodeId, projection);
            }
            if (!queue.hasPending(projectId) && !dirtyProjectIdsRef.current.has(projectId)) {
              pendingCommandDeltaByProjectRef.current.delete(projectId);
            }
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

  // Flush unsent structural commands with sendBeacon during unload.
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (typeof navigator.sendBeacon !== 'function') return;
      const deltas = new Map(pendingCommandDeltaByProjectRef.current);
      for (const [projectId, delta] of dirtyDeltaByProjectRef.current) {
        deltas.set(
          projectId,
          mergeWorkspaceDirtyDelta(deltas.get(projectId) ?? emptyWorkspaceDirtyDelta(), delta),
        );
      }
      for (const [projectId, delta] of deltas) {
        const project = projectsRef.current.find((candidate) => candidate.id === projectId);
        if (!project) continue;
        const batch = buildExplicitWorkspaceCommands(
          project,
          nodesRef.current,
          delta,
          nodeCommandProjectionRef.current,
        );
        if (batch.commands.length === 0) continue;
        const payload = JSON.stringify({
          operationId: `unload-${projectId}-${Date.now()}`,
          commands: batch.commands,
        });
        navigator.sendBeacon(
          `${API_BASE_URL}/workspaces/${encodeURIComponent(projectId)}/commands`,
          new Blob([payload], { type: 'application/json' }),
        );
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
    // The hydration barrier: never finalize hydration until the backend has
    // actually answered. On cold start the renderer runs before the backend is
    // listening, so the first fetch rejects (ECONNREFUSED). A REJECTED fetch is
    // "not ready yet" → wait and retry; it is NEVER interpreted as an empty
    // database. A RESOLVED value (even []) means the backend answered → proceed
    // and finalize. This is what keeps a startup race from wiping the UI to
    // empty over a DB that holds every workspace.
    const awaitBackendSnapshot = async (): Promise<unknown[] | null> => {
      for (;;) {
        if (cancelled) return null;
        try {
          // Capability probe is advisory: we log a v2 mismatch but do not gate
          // on it. Sharing the same attempt as the workspace fetch keeps the
          // readiness signal single-sourced — if the backend is up enough to
          // answer /workspaces/all, we proceed.
          try {
            const capabilities = await fetchPersistenceCapabilities();
            const v2Available =
              capabilities.protocolVersion >= 2
              && capabilities.authoritativeTurnPersistence
              && capabilities.durableNodePrerequisite
              && capabilities.explicitCommands
              && capabilities.backgroundWorkspaceSync === false;
            if (!v2Available) {
              console.warn('backend does not advertise the required persistence v2 capabilities');
            }
          } catch {
            // Capability endpoint unreachable → fall through to the workspace
            // fetch, which throws on the same unreachability and triggers retry.
          }
          // Meta mode: structure + per-node counts, NO message bodies. Bodies
          // for the active tree are eager-loaded below; other trees load on
          // demand when opened. This is what shrinks the boot payload from the
          // whole-forest 13MB to a ~structural fraction.
          return await fetchAllWorkspacesMeta();
        } catch {
          if (cancelled) return null;
          // Connection-level failure: the backend is still starting. Wait and
          // retry — do NOT finalize as empty.
          await new Promise<void>((resolve) => window.setTimeout(resolve, HYDRATION_RETRY_DELAY_MS));
        }
      }
    };
    (async () => {
      try {
        const fullWorkspaces = await awaitBackendSnapshot();
        if (cancelled || fullWorkspaces === null) return;
        if (Array.isArray(fullWorkspaces) && fullWorkspaces.length > 0) {
          const rawBackend = fullWorkspaces.filter(
            (w): w is Record<string, unknown> => !!w && typeof w === 'object',
          );
          const backendState = hydrateBackendWorkspaces(
            rawBackend,
            initialActiveProjectIdRef.current,
          );
          if (backendState.projects.length > 0) {
            // Eager-load the active workspace's active tree so first paint shows
            // real messages, not placeholders. Best-effort: a failure here just
            // leaves that tree to the on-demand path (it does not block boot).
            const resolvedActiveId = resolveActiveProjectForWindow(backendState.activeProjectId);
            const activeProject = backendState.projects.find((p) => p.id === resolvedActiveId);
            let nodes = backendState.nodes;
            if (activeProject?.activeTreeId) {
              try {
                const rows = await fetchTreeMessages(activeProject.id, activeProject.activeTreeId);
                if (cancelled) return;
                const byNode = buildMessagesByNode(rows);
                nodes = applyTreeMessages(nodes, byNode);
              } catch {
                // active tree stays placeholder → loads on first open.
              }
            }
            setProjects(backendState.projects);
            setActiveProjectId(resolvedActiveId);
            installNodes(nodes);
            clearDurableLocalStorageMirror(storageKeyRef.current);
          }
          finishHydration('backend');
        } else {
          // Backend has no workspaces for this user. Michi has always shipped
          // with the SQLite backend, so there is no pre-SQLite localStorage
          // corpus to migrate — this path just hydrates from whatever local
          // payload exists (offline/fresh-install fallback) or lands empty.
          const payload = readLocalStoragePayload(userId);
          const lsState = payload ? hydrateSavedState(payload) : EMPTY_HYDRATED;
          if (lsState.projects.length > 0) {
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
