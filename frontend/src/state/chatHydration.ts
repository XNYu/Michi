import { migrateAssistantToBlocks, parseAssistantBlocks } from './assistantBlocks';
import type {
  ChatMessage,
  ChatNodeState,
  ComposerDraft,
  ContextEntry,
  NodeKind,
  Project,
  ToolCallState,
  Tree,
  TrimSnapshot,
} from './chatTypes';
import type { DigestState } from './digest';

export const STATE_SCHEMA_VERSION = 5;

export interface SavedState {
  version: number;
  projects: Project[];
  activeProjectId: string | null;
  nodes: Record<string, Partial<ChatNodeState> & { nodeId: string; projectId: string; messages?: ChatMessage[] }>;
}

export interface HydratedState {
  projects: Project[];
  activeProjectId: string | null;
  nodes: Record<string, ChatNodeState>;
}

function emptyHydrated(): HydratedState {
  return { projects: [], activeProjectId: null, nodes: {} };
}

type BackendEdgeKind = NonNullable<Project['edges'][number]['kind']>;

interface BackendFullWorkspace {
  workspace?: Record<string, unknown>;
  trees?: Array<Record<string, unknown>>;
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
  messages?: Array<Record<string, unknown>>;
  contexts?: Array<Record<string, unknown>>;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function inferRuntimeId(row: Record<string, unknown>, nodeId: string): string | undefined {
  const explicit = asString(row.runtime_id);
  if (explicit) return explicit;
  if (asString(row.external_session_id)) return 'claude';
  const sessionId = asString(row.acp_session_id);
  if (!sessionId) return undefined;
  return sessionId === nodeId ? 'pi' : 'kiro';
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asOptionalNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function parseJsonStringArray(v: unknown): string[] {
  if (!v || typeof v !== 'string') return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeEdgeKind(v: unknown): BackendEdgeKind {
  return v === 'merge' || v === 'link' || v === 'digest-source' ? v : 'branch';
}

function parseToolCalls(raw: unknown): ToolCallState[] {
  let value = raw;
  if (typeof value === 'string' && value.trim()) {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ToolCallState[] => {
    if (!item || typeof item !== 'object') return [];
    const t = item as Record<string, unknown>;
    const id = asString(t.id) ?? asString(t.toolCallId);
    if (!id) return [];
    return [{
      id,
      title: asString(t.title) ?? '',
      status: asString(t.status) ?? '',
      kind: asString(t.kind),
      textOffset: asOptionalNumber(t.textOffset),
    }];
  });
}

function parseComposerDraft(raw: unknown): ComposerDraft | undefined {
  let value = raw;
  if (typeof value === 'string' && value.trim()) {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  const d = value as Record<string, unknown>;
  const text = typeof d.value === 'string' ? d.value : '';
  const mentions = Array.isArray(d.mentions)
    ? d.mentions.flatMap((item): ComposerDraft['mentions'] => {
        if (!item || typeof item !== 'object') return [];
        const m = item as Record<string, unknown>;
        if (
          typeof m.start !== 'number' ||
          typeof m.end !== 'number' ||
          (m.kind !== 'context' && m.kind !== 'node') ||
          typeof m.refId !== 'string' ||
          typeof m.label !== 'string'
        ) {
          return [];
        }
        return [{
          start: m.start,
          end: m.end,
          kind: m.kind,
          refId: m.refId,
          label: m.label,
        }];
      })
    : [];
  const quotedText = typeof d.quotedText === 'string' && d.quotedText.trim()
    ? d.quotedText
    : undefined;
  if (!text && mentions.length === 0 && !quotedText) return undefined;
  return { value: text, mentions, quotedText };
}

function parseTrimSnapshot(raw: unknown): TrimSnapshot | undefined {
  let value = raw;
  if (typeof value === 'string' && value.trim()) {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  const d = value as Record<string, unknown>;
  if (
    !(d.parentId === null || typeof d.parentId === 'string') ||
    !Array.isArray(d.childrenIds) ||
    !d.childrenIds.every((c) => typeof c === 'string')
  ) {
    return undefined;
  }
  let wasTreeRoot: TrimSnapshot['wasTreeRoot'] = null;
  if (d.wasTreeRoot && typeof d.wasTreeRoot === 'object') {
    const w = d.wasTreeRoot as Record<string, unknown>;
    if (typeof w.treeId === 'string') wasTreeRoot = { treeId: w.treeId };
  }
  return {
    parentId: d.parentId as string | null,
    childrenIds: d.childrenIds as string[],
    wasTreeRoot,
  };
}

function parseDigest(raw: unknown): DigestState | undefined {
  let value = raw;
  if (typeof value === 'string' && value.trim()) {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  const d = value as Record<string, unknown>;
  const sources = Array.isArray(d.sources) ? d.sources.filter((x): x is string => typeof x === 'string') : [];
  const rawFingerprints = d.sourceFingerprints;
  const sourceFingerprints: Record<string, string> = {};
  if (rawFingerprints && typeof rawFingerprints === 'object') {
    for (const [k, v] of Object.entries(rawFingerprints)) {
      if (typeof v === 'string') sourceFingerprints[k] = v;
    }
  }
  return {
    sources,
    sourceFingerprints,
    content: typeof d.content === 'string' ? d.content : '',
    generatedAt: asNumber(d.generatedAt, 0),
    viewedAt: asNumber(d.viewedAt, 0),
    status: 'idle',
    customPrompt: asString(d.customPrompt),
  };
}

// ── Single-row → entity mappers ────────────────────────────────────────────
// These pure helpers map ONE backend row (the `SELECT *` shape) into the
// corresponding live-state entity (or the row-owned fields of one). They are
// the same mapping `hydrateBackendWorkspaces` performs inline; factoring them
// out lets the conflict-adoption path (workspacePersistence.ts) converge a
// single conflicted row to the server's value without re-pulling the whole
// workspace. Cross-row derived data (a node's messages / mergeSources / digest,
// an edge's reverse index) is NOT owned by a single row, so the node mapper
// only returns that row's own scalar fields — callers preserve local derived
// state (messages are append-only and reconciled separately).

/** Map one `edges` row → ProjectEdge, or null when source/target is missing. */
export function mapEdgeRow(row: Record<string, unknown>): Project['edges'][number] | null {
  const source = asString(row.source_node_id);
  const target = asString(row.target_node_id);
  if (!source || !target) return null;
  const anchorMessageId = asString(row.anchor_message_id) || undefined;
  const createdAt = asOptionalNumber(row.created_at);
  return { source, target, kind: normalizeEdgeKind(row.kind), anchorMessageId, createdAt };
}

/** Map one `trees` row → Tree, or null when id/root_node_id is missing. */
export function mapTreeRow(row: Record<string, unknown>): Tree | null {
  const id = asString(row.id);
  const rootNodeId = asString(row.root_node_id);
  if (!id || !rootNodeId) return null;
  return {
    id,
    rootNodeId,
    name: asString(row.name),
    createdAt: asNumber(row.created_at, Date.now()),
    lastActiveAt: asNumber(row.last_active_at, Date.now()),
    archivedAt: asOptionalNumber(row.archived_at),
    pinnedAt: asOptionalNumber(row.pinned_at),
  };
}

/** Map one `contexts` row → ContextEntry, or null when required fields missing. */
export function mapContextRow(row: Record<string, unknown>): ContextEntry | null {
  const id = asString(row.id);
  const name = asString(row.name);
  const filePath = asString(row.file_path);
  if (!id || !name || !filePath) return null;
  return {
    id,
    name,
    filePath,
    size: asOptionalNumber(row.size),
    autoInject: row.auto_inject === 1 || row.auto_inject === true || undefined,
    source: row.source === 'agent' ? 'agent' : 'user',
    createdAt: asNumber(row.created_at, Date.now()),
    updatedAt: asNumber(row.updated_at, Date.now()),
  };
}

/** Map one `messages` row → ChatMessage. `fallbackSeq` derives the id when the
 *  row carries no explicit id (mirrors the inline hydration default). */
export function mapMessageRow(row: Record<string, unknown>, fallbackSeq = 0): ChatMessage {
  const nodeId = asString(row.node_id) ?? '';
  const role = row.role === 'assistant' ? 'assistant' : 'user';
  const rawContent = typeof row.content === 'string' ? row.content : '';
  const baseMsg: ChatMessage = {
    id: asString(row.id) ?? `${nodeId}-${asNumber(row.seq, fallbackSeq)}`,
    role,
    text: rawContent,
    toolCalls: parseToolCalls(row.tool_calls),
    blocks: role === 'assistant' ? parseAssistantBlocks(row.blocks) : undefined,
    streaming: false,
    createdAt: asOptionalNumber(row.created_at),
  };
  return role === 'assistant' ? migrateAssistantToBlocks(baseMsg) : baseMsg;
}

/**
 * Map the row-owned scalar fields of one `nodes` row → a partial ChatNodeState.
 * Excludes cross-row derived fields (`messages`, `mergeSources`, `digest`)
 * which depend on the message/edge rows; callers merge those separately.
 * Used by conflict adoption to converge a single node's scalars to the server
 * value while preserving the locally-reconciled message list.
 */
export function mapNodeRowScalars(row: Record<string, unknown>): Partial<ChatNodeState> {
  const nodeId = asString(row.id)!;
  const kind: NodeKind = row.kind === 'digest' ? 'digest' : 'chat';
  const posX = asOptionalNumber(row.position_x);
  const posY = asOptionalNumber(row.position_y);
  return {
    nodeId,
    kind,
    chatId: asString(row.acp_session_id) ?? null,
    runtimeId: inferRuntimeId(row, nodeId),
    providerId: asString(row.provider_id) ?? null,
    modelId: asString(row.model_id) ?? null,
    reasoning: asString(row.reasoning) as ChatNodeState['reasoning'] ?? null,
    resumeFingerprint: asString(row.resume_fingerprint) ?? null,
    parentNodeId: asString(row.parent_node_id),
    followUps: parseJsonStringArray(row.follow_ups),
    followUpsSourceMessageId: asString(row.follow_ups_source_message_id) || undefined,
    title: asString(row.title),
    branchOverview: asString(row.branch_overview) || undefined,
    status: 'idle',
    minimized: row.minimized === 1 || row.minimized === true || undefined,
    position: posX !== undefined && posY !== undefined ? { x: posX, y: posY } : undefined,
    spawnedByAgent: row.spawned_by_agent === 1 || row.spawned_by_agent === true || undefined,
    deletedAt: asOptionalNumber(row.deleted_at),
    deletionGroupId: asString(row.deletion_group_id),
    trimSnapshot: parseTrimSnapshot(row.trim_snapshot),
    currentModeId: asString(row.current_mode_id) ?? null,
    paneWidth: asOptionalNumber(row.pane_width),
    composerDraft: parseComposerDraft(row.composer_draft),
  };
}

/**
 * Convert the SQLite REST shape back into the frontend's live state shape.
 * Backend sessions still cannot survive a restart, so every restored node is
 * deliberately chatId=null/status=idle, matching localStorage hydration.
 */
export function hydrateBackendWorkspaces(
  rawWorkspaces: unknown[],
  preferredActiveProjectId?: string | null,
): HydratedState {
  if (!Array.isArray(rawWorkspaces) || rawWorkspaces.length === 0) return emptyHydrated();

  const projects: Project[] = [];
  const nodes: Record<string, ChatNodeState> = {};

  for (const raw of rawWorkspaces) {
    if (!raw || typeof raw !== 'object') continue;
    const full = raw as BackendFullWorkspace;
    const workspace = full.workspace;
    const projectId = workspace ? asString(workspace.id) : undefined;
    if (!workspace || !projectId) continue;

    const edgeRows = Array.isArray(full.edges) ? full.edges : [];
    const edges: Project['edges'] = edgeRows.flatMap((row) => {
      const edge = mapEdgeRow(row);
      return edge ? [edge] : [];
    });

    const mergeSourcesByTarget = new Map<string, string[]>();
    const digestSourcesByTarget = new Map<string, string[]>();
    for (const e of edges) {
      if (e.kind === 'merge') {
        mergeSourcesByTarget.set(e.target, [...(mergeSourcesByTarget.get(e.target) ?? []), e.source]);
      } else if (e.kind === 'digest-source') {
        digestSourcesByTarget.set(e.target, [...(digestSourcesByTarget.get(e.target) ?? []), e.source]);
      }
    }

    const messageRows = Array.isArray(full.messages) ? full.messages : [];
    const messagesByNode = new Map<string, ChatMessage[]>();
    for (const row of messageRows) {
      const nodeId = asString(row.node_id);
      if (!nodeId) continue;
      const msg = mapMessageRow(row, messagesByNode.get(nodeId)?.length ?? 0);
      messagesByNode.set(nodeId, [...(messagesByNode.get(nodeId) ?? []), msg]);
    }
    messagesByNode.forEach((list, nodeId) => {
      list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      messagesByNode.set(nodeId, list);
    });

    const nodeRows = (Array.isArray(full.nodes) ? full.nodes : [])
      .filter((row) => !!asString(row.id))
      .sort((a, b) => asNumber(a.created_at, 0) - asNumber(b.created_at, 0));
    const chatIds = nodeRows.map((row) => asString(row.id)!).filter(Boolean);

    const treeRows = Array.isArray(full.trees) ? full.trees : [];
    let trees: Tree[] = treeRows.flatMap((row) => {
      const tree = mapTreeRow(row);
      return tree ? [tree] : [];
    });
    if (trees.length === 0 && chatIds[0]) {
      const createdAt = asNumber(workspace.created_at, Date.now());
      trees = [{ id: `t-${projectId}-root`, rootNodeId: chatIds[0], createdAt, lastActiveAt: createdAt }];
    }

    const requestedActiveTreeId = asString(workspace.active_tree_id);
    const activeTreeId = requestedActiveTreeId && trees.some((t) => t.id === requestedActiveTreeId)
      ? requestedActiveTreeId
      : [...trees].filter((t) => !t.archivedAt).sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id ?? null;

    const contexts: ContextEntry[] = (Array.isArray(full.contexts) ? full.contexts : []).flatMap((row) => {
      const ctx = mapContextRow(row);
      return ctx ? [ctx] : [];
    });

    // settings JSON column is opaque on the backend; the frontend owns its
    // shape. Today it carries aiGlobalContext and instructions.
    let instructions: string | undefined;
    let aiGlobalContext: boolean | undefined;
    const rawSettings = asString(workspace.settings);
    if (rawSettings) {
      try {
        const parsed = JSON.parse(rawSettings) as Record<string, unknown>;
        if (typeof parsed.instructions === 'string') instructions = parsed.instructions;
        if (parsed.aiGlobalContext === false) aiGlobalContext = false;
      } catch {
        // ignore malformed JSON — defaults apply
      }
    }

    const project: Project = {
      id: projectId,
      name: asString(workspace.name) ?? 'Untitled',
      cwd: asString(workspace.cwd),
      chatIds,
      edges,
      createdAt: asNumber(workspace.created_at, Date.now()),
      trees,
      activeTreeId,
      contexts,
      deletedAt: asOptionalNumber(workspace.deleted_at),
      archivedAt: asOptionalNumber(workspace.archived_at),
      pinnedAt: asOptionalNumber(workspace.pinned_at),
      aiGlobalContext,
      instructions,
    };
    projects.push(project);

    for (const row of nodeRows) {
      const nodeId = asString(row.id)!;
      const scalars = mapNodeRowScalars(row);
      let digest = parseDigest(row.digest);
      if (scalars.kind === 'digest' && !digest) {
        digest = {
          sources: digestSourcesByTarget.get(nodeId) ?? [],
          sourceFingerprints: {},
          content: '',
          generatedAt: 0,
          viewedAt: 0,
          status: 'idle',
        };
      }
      nodes[nodeId] = {
        ...scalars,
        // Cross-row derived fields the single-row scalar mapper cannot know:
        projectId,
        mergeSources: mergeSourcesByTarget.get(nodeId),
        messages: messagesByNode.get(nodeId) ?? [],
        digest,
      } as ChatNodeState;
    }
  }

  const isLive = (p: Project) => !p.deletedAt && !p.archivedAt;
  const preferredIsLive =
    preferredActiveProjectId &&
    projects.some((p) => p.id === preferredActiveProjectId && isLive(p));
  const activeProjectId = preferredIsLive
    ? preferredActiveProjectId!
    : projects.find(isLive)?.id ?? null;

  return { projects, activeProjectId, nodes };
}

/**
 * Convert a saved snapshot back into live state. chatId fields are nulled
 * (backend sessions don't survive restarts); status is forced idle; any
 * lingering `streaming` flags on assistant messages are cleared.
 * Malformed or wrong-version input yields an empty state.
 */
export function hydrateSavedState(saved: unknown): HydratedState {
  if (!saved || typeof saved !== 'object') return emptyHydrated();
  const s = saved as Partial<SavedState>;
  if (![1, 2, 3, 4, 5].includes(s.version ?? 0)) return emptyHydrated();
  if (!Array.isArray(s.projects) || !s.nodes || typeof s.nodes !== 'object') {
    return emptyHydrated();
  }

  const nodes: Record<string, ChatNodeState> = {};
  for (const [id, raw] of Object.entries(s.nodes)) {
    const msgs = (raw.messages ?? []).map((m) => {
      const isAssistant = m.role === 'assistant';
      const hydrated: ChatMessage = {
        ...m,
        streaming: false,
        blocks: isAssistant ? parseAssistantBlocks((m as any).blocks) : undefined,
        text: typeof m.text === 'string' ? m.text : '',
      };
      // Drop legacy parts-pipeline fields if a persisted dump still carries
      // them (parts / pendingParts / pendingAfterTextPartId / pendingAfterOffset).
      const hydratedAny = hydrated as unknown as Record<string, unknown>;
      delete hydratedAny.parts;
      delete hydratedAny.pendingParts;
      delete hydratedAny.pendingAfterTextPartId;
      delete hydratedAny.pendingAfterOffset;
      return isAssistant ? migrateAssistantToBlocks(hydrated) : hydrated;
    });
    const pos = raw.position;
    const validPos =
      pos && typeof pos === 'object' && typeof pos.x === 'number' && typeof pos.y === 'number'
        ? { x: pos.x, y: pos.y }
        : undefined;
    nodes[id] = {
      nodeId: raw.nodeId,
      kind: raw.kind === 'digest' ? 'digest' : 'chat',
      chatId: (typeof raw.chatId === 'string' && raw.chatId) ? raw.chatId : null,
      runtimeId:
        typeof (raw as any).runtimeId === 'string' && (raw as any).runtimeId
          ? (raw as any).runtimeId
          : (typeof raw.chatId === 'string' && raw.chatId && raw.chatId !== raw.nodeId ? 'kiro' : undefined),
      providerId:
        typeof (raw as any).providerId === 'string' ? (raw as any).providerId : null,
      modelId:
        typeof (raw as any).modelId === 'string' ? (raw as any).modelId : null,
      reasoning:
        typeof (raw as any).reasoning === 'string' ? (raw as any).reasoning : null,
      resumeFingerprint:
        typeof (raw as any).resumeFingerprint === 'string' ? (raw as any).resumeFingerprint : null,
      projectId: raw.projectId,
      parentNodeId: raw.parentNodeId,
      mergeSources: raw.mergeSources,
      messages: msgs,
      followUps: raw.followUps ?? [],
      title: raw.title,
      branchOverview:
        typeof (raw as any).branchOverview === 'string' && (raw as any).branchOverview.trim().length > 0
          ? (raw as any).branchOverview
          : undefined,
      status: 'idle',
      minimized: raw.minimized,
      position: validPos,
      viewedAt: typeof (raw as any).viewedAt === 'number' ? (raw as any).viewedAt : undefined,
      lastAssistantAt: typeof (raw as any).lastAssistantAt === 'number' ? (raw as any).lastAssistantAt : undefined,
      // Persist digest state across reloads; force status idle so a stuck
      // 'streaming' flag from a crashed generation doesn't look live.
      digest: (raw as any).digest
        ? { ...(raw as any).digest, status: 'idle', error: undefined }
        : undefined,
      // Preserve chatId from saved state so session/load can restore the ACP
      // session without re-sending PREAMBLE. Falls back to null if missing.
      // on next send — drop consumedLinks too so the fresh session gets fresh
      // peer context.
      consumedLinks: undefined,
      spawnedByAgent: (raw as any).spawnedByAgent === true || undefined,
      deletedAt:
        typeof (raw as any).deletedAt === 'number' ? (raw as any).deletedAt : undefined,
      deletionGroupId:
        typeof (raw as any).deletionGroupId === 'string'
          ? (raw as any).deletionGroupId
          : undefined,
      trimSnapshot: parseTrimSnapshot((raw as any).trimSnapshot),
      composerDraft: parseComposerDraft((raw as any).composerDraft),
    };
  }

  const now = Date.now();
  const projects: Project[] = (s.projects ?? []).flatMap((p) => {
    const proj = p as Project;
    if (Array.isArray(proj.trees) && proj.trees.length > 0) {
      return [proj];
    }
    const rootId = proj.chatIds?.[0];
    if (!rootId) {
      // Legacy project with no nodes — drop it rather than synthesize a
      // tree pointing at undefined. Users only see this if a snapshot was
      // corrupted; losing a rootless workspace is safer than crashing
      // downstream renderers that assume rootNodeId resolves to a node.
      return [];
    }
    const tree: Tree = {
      id: `t-${p.id}-root`,
      rootNodeId: rootId,
      createdAt: proj.createdAt ?? now,
      lastActiveAt: now,
    };
    return [{ ...proj, trees: [tree], activeTreeId: tree.id }];
  });

  // v2->v3: add contexts array to projects that lack it.
  // v3->v4: old text-body contexts were replaced by file-based contexts. Drop
  // only entries that do not have a filePath; preserve valid v4 file contexts.
  for (const p of projects) {
    const rawContexts = Array.isArray((p as any).contexts) ? (p as any).contexts : [];
    p.contexts = rawContexts
      .filter((c: any) => typeof c?.name === 'string' && typeof c?.filePath === 'string' && c.filePath)
      .map((c: any) => ({
        id: typeof c.id === 'string' ? c.id : `ctx-${now}-${Math.random().toString(36).slice(2, 6)}`,
        name: c.name,
        filePath: c.filePath,
        size: typeof c.size === 'number' && Number.isFinite(c.size) ? c.size : undefined,
        autoInject: c.autoInject === true || undefined,
        source: c.source === 'agent' ? 'agent' : 'user',
        createdAt: typeof c.createdAt === 'number' ? c.createdAt : now,
        updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : now,
      }));
  }

  return {
    projects,
    activeProjectId: s.activeProjectId ?? null,
    nodes,
  };
}
