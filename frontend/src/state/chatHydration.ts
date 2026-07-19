import { finalizeAssistantBlocks, migrateAssistantToBlocks, parseAssistantBlocks } from './assistantBlocks';
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
import { parseBranchOverviewEntries } from 'michi-shared';

export const STATE_SCHEMA_VERSION = 6;

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
      detail: asString(t.detail),
      inputJson: asString(t.inputJson),
      output: asString(t.output),
      textOffset: asOptionalNumber(t.textOffset),
    }];
  });
}

function parseMessageMetadata(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === 'string' && value.trim()) {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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

/** Read the server-owned spawn outbox without rendering it as a composer draft. */
function parsePendingSpawnPrompt(raw: unknown): string | undefined {
  let value = raw;
  if (typeof value === 'string' && value.trim()) {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prompt = (value as Record<string, unknown>).__michiPendingSpawnPrompt;
  return typeof prompt === 'string' && prompt.trim().length > 0 ? prompt : undefined;
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

/** Map one `contexts` row → ContextEntry (artifact), or null when required
 *  fields missing. A `link` artifact has a `url` and no file_path; every other
 *  type has a file_path. Require at least one so links survive reload. */
export function mapContextRow(row: Record<string, unknown>): ContextEntry | null {
  const id = asString(row.id);
  const name = asString(row.name);
  const filePath = asString(row.file_path) ?? '';
  const url = asString(row.url);
  if (!id || !name || (!filePath && !url)) return null;
  const rawType = asString(row.type);
  const type: ContextEntry['type'] =
    rawType === 'file' || rawType === 'image' || rawType === 'link' || rawType === 'doc'
      ? rawType
      : url
        ? 'link'
        : 'doc';
  const rawKind = asString(row.kind);
  const kind: ContextEntry['kind'] =
    rawKind === 'embedded' || rawKind === 'reference' ? rawKind : undefined;
  const originNodeId = asString(row.origin_node_id);
  const originMessageId = asString(row.origin_message_id);
  return {
    id,
    name,
    filePath,
    url: url ?? undefined,
    type,
    kind,
    origin: originNodeId ? { nodeId: originNodeId, messageId: originMessageId ?? undefined } : undefined,
    size: asOptionalNumber(row.size),
    pinnedAt: asOptionalNumber(row.pinned_at),
    source: row.source === 'agent' ? 'agent' : 'user',
    createdAt: asNumber(row.created_at, Date.now()),
    updatedAt: asNumber(row.updated_at, Date.now()),
  };
}

/** Map one `messages` row → ChatMessage. `fallbackSeq` derives the id when the
 *  row carries no explicit id (mirrors the inline hydration default). */
/**
 * Group raw backend message rows into a { nodeId → ordered ChatMessage[] } map.
 * Used by the lazy-load path: the per-tree message fetch returns a flat row
 * list (ordered by node, then seq), which this folds into the per-node shape
 * the `messages-loaded` action and the hydration eager-load both consume.
 * Rows already arrive ordered, so we preserve arrival order per node.
 */
export function buildMessagesByNode(rawRows: unknown[]): Record<string, ChatMessage[]> {
  const byNode: Record<string, ChatMessage[]> = {};
  if (!Array.isArray(rawRows)) return byNode;
  for (const raw of rawRows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const nodeId = asString(row.node_id);
    if (!nodeId) continue;
    const list = byNode[nodeId] ?? (byNode[nodeId] = []);
    list.push(mapMessageRow(row, list.length));
  }
  return byNode;
}

/**
 * Install fetched message bodies onto placeholder nodes. Pure: returns a new
 * nodes map (only touched nodes get new object identities). Each node in
 * `messagesByNode` gets its messages replaced and `messagesLoaded` flipped to
 * true; `messageCount` is synced to the loaded length. Nodes absent from the
 * map are returned by reference (untouched). Shared by the hydration
 * eager-load and the `messages-loaded` reducer action so both converge.
 */
export function applyTreeMessages(
  nodes: Record<string, ChatNodeState>,
  messagesByNode: Record<string, ChatMessage[]>,
): Record<string, ChatNodeState> {
  const ids = Object.keys(messagesByNode);
  if (ids.length === 0) return nodes;
  const next = { ...nodes };
  for (const nodeId of ids) {
    const prev = next[nodeId];
    if (!prev) continue; // node not present locally (e.g. trimmed) — skip
    const messages = messagesByNode[nodeId];
    next[nodeId] = {
      ...prev,
      messages,
      messagesLoaded: true,
      messageCount: messages.length,
    };
  }
  return next;
}

export function mapMessageRow(row: Record<string, unknown>, fallbackSeq = 0): ChatMessage {
  const nodeId = asString(row.node_id) ?? '';
  const role = row.role === 'assistant' ? 'assistant' : 'user';
  const rawContent = typeof row.content === 'string' ? row.content : '';
  const metadata = parseMessageMetadata(row.metadata);
  const baseMsg: ChatMessage = {
    id: asString(row.id) ?? `${nodeId}-${asNumber(row.seq, fallbackSeq)}`,
    role,
    text: rawContent,
    toolCalls: parseToolCalls(row.tool_calls),
    blocks: role === 'assistant' ? parseAssistantBlocks(row.blocks) : undefined,
    streaming: false,
    createdAt: asOptionalNumber(row.created_at),
    quotedText: asString(metadata.quotedText),
    attachments: Array.isArray(metadata.attachments)
      ? metadata.attachments.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const attachment = item as Record<string, unknown>;
          const name = asString(attachment.name);
          const absPath = asString(attachment.absPath);
          return name && absPath ? [{ name, absPath }] : [];
        })
      : undefined,
    comments: Array.isArray(metadata.comments)
      ? metadata.comments as ChatMessage['comments']
      : undefined,
    plan: Array.isArray(metadata.plan)
      ? metadata.plan as ChatMessage['plan']
      : undefined,
  };
  return role === 'assistant' ? finalizeAssistantBlocks(migrateAssistantToBlocks(baseMsg)) : baseMsg;
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
  const hasRuntimeBinding = !!asString(row.acp_session_id) || !!asString(row.external_session_id);
  const posX = asOptionalNumber(row.position_x);
  const posY = asOptionalNumber(row.position_y);
  return {
    nodeId,
    kind,
    // Compatibility marker only: a bound node always uses its nodeId on the
    // public API. Runtime-native ids remain in SQLite/backend adapters.
    chatId: hasRuntimeBinding ? nodeId : null,
    runtimeId: inferRuntimeId(row, nodeId),
    providerId: asString(row.provider_id) ?? null,
    modelId: asString(row.model_id) ?? null,
    reasoning: asString(row.reasoning) as ChatNodeState['reasoning'] ?? null,
    resumeFingerprint: asString(row.resume_fingerprint) ?? null,
    parentNodeId: asString(row.parent_node_id),
    followUps: parseJsonStringArray(row.follow_ups),
    followUpsSourceMessageId: asString(row.follow_ups_source_message_id) || undefined,
    title: asString(row.title),
    branchOverviewEntries: (() => {
      const entries = parseBranchOverviewEntries(row.branch_overview);
      return entries.length > 0 ? entries : undefined;
    })(),
    branchOverview: (() => {
      const entries = parseBranchOverviewEntries(row.branch_overview);
      return entries.length > 0 ? entries[entries.length - 1].text : undefined;
    })(),
    status: row.status === 'streaming' ? 'streaming' : row.status === 'error' ? 'error' : 'idle',
    lastAppliedTurnId: asString(row.last_applied_turn_id),
    lastAppliedSeq: asOptionalNumber(row.last_applied_seq),
    lastAppliedBackgroundTurnId: asString(row.last_applied_turn_id),
    lastAppliedBackgroundSeq: asOptionalNumber(row.last_applied_seq),
    minimized: row.minimized === 1 || row.minimized === true || undefined,
    position: posX !== undefined && posY !== undefined ? { x: posX, y: posY } : undefined,
    spawnedByAgent: row.spawned_by_agent === 1 || row.spawned_by_agent === true || undefined,
    pendingSpawnPrompt: parsePendingSpawnPrompt(row.composer_draft),
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
    const messageRowsByNode = new Map<string, Array<Record<string, unknown>>>();
    for (const row of messageRows) {
      const nodeId = asString(row.node_id);
      if (!nodeId) continue;
      const arr = messageRowsByNode.get(nodeId) ?? [];
      arr.push(row as Record<string, unknown>);
      messageRowsByNode.set(nodeId, arr);
    }
    const messagesByNode = new Map<string, ChatMessage[]>();
    messageRowsByNode.forEach((rows, nodeId) => {
      // Sort by seq (monotonic insert order); fall back to createdAt for legacy data without seq.
      rows.sort((a, b) => {
        const seqA = asOptionalNumber(a.seq);
        const seqB = asOptionalNumber(b.seq);
        if (seqA != null && seqB != null) return seqA - seqB;
        return (asNumber(a.created_at, 0)) - (asNumber(b.created_at, 0));
      });
      messagesByNode.set(nodeId, rows.map((row, i) => mapMessageRow(row, i)));
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
      // Lazy-load markers. The meta payload carries `message_count` on each row
      // and NO bodies; the full payload carries bodies and no count. A node is a
      // placeholder (messagesLoaded:false) only in meta mode — i.e. when the row
      // reports a count but no bodies were assembled for it. In full mode every
      // node is authoritative (messagesLoaded:true), including genuinely-empty
      // ones. This is the placeholder-vs-empty distinction the write-back guard
      // and the lazy trigger both key off of.
      const assembled = messagesByNode.get(nodeId) ?? [];
      const rawCount = asOptionalNumber(row.message_count);
      const isMetaRow = rawCount !== undefined && assembled.length === 0;
      nodes[nodeId] = {
        ...scalars,
        // Cross-row derived fields the single-row scalar mapper cannot know:
        projectId,
        mergeSources: mergeSourcesByTarget.get(nodeId),
        messages: assembled,
        messagesLoaded: !isMetaRow,
        messageCount: rawCount ?? assembled.length,
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
 * Convert a saved snapshot back into live state. A legacy runtime binding is
 * retained only as the public node-id marker; runtime-native ids never return
 * to frontend state. Status is forced idle and lingering `streaming` flags on
 * assistant messages are cleared. Malformed or wrong-version input yields an
 * empty state.
 */
export function hydrateSavedState(saved: unknown): HydratedState {
  if (!saved || typeof saved !== 'object') return emptyHydrated();
  const s = saved as Partial<SavedState>;
  if (![1, 2, 3, 4, 5, 6].includes(s.version ?? 0)) return emptyHydrated();
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
      chatId: (typeof raw.chatId === 'string' && raw.chatId) ? raw.nodeId : null,
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
      lastAppliedTurnId:
        typeof (raw as any).lastAppliedTurnId === 'string' ? (raw as any).lastAppliedTurnId : undefined,
      lastAppliedSeq:
        typeof (raw as any).lastAppliedSeq === 'number' ? (raw as any).lastAppliedSeq : undefined,
      lastAppliedBackgroundTurnId:
        typeof (raw as any).lastAppliedBackgroundTurnId === 'string'
          ? (raw as any).lastAppliedBackgroundTurnId
          : typeof (raw as any).lastAppliedTurnId === 'string' ? (raw as any).lastAppliedTurnId : undefined,
      lastAppliedBackgroundSeq:
        typeof (raw as any).lastAppliedBackgroundSeq === 'number'
          ? (raw as any).lastAppliedBackgroundSeq
          : typeof (raw as any).lastAppliedSeq === 'number' ? (raw as any).lastAppliedSeq : undefined,
      projectId: raw.projectId,
      parentNodeId: raw.parentNodeId,
      mergeSources: raw.mergeSources,
      messages: msgs,
      followUps: raw.followUps ?? [],
      title: raw.title,
      branchOverviewEntries: (() => {
        if (Array.isArray((raw as any).branchOverviewEntries) && (raw as any).branchOverviewEntries.length > 0) {
          return parseBranchOverviewEntries((raw as any).branchOverviewEntries);
        }
        const legacy = (raw as any).branchOverview;
        if (typeof legacy === 'string' && legacy.trim().length > 0) {
          return parseBranchOverviewEntries(legacy);
        }
        return undefined;
      })(),
      branchOverview: (() => {
        if (Array.isArray((raw as any).branchOverviewEntries) && (raw as any).branchOverviewEntries.length > 0) {
          const entries = parseBranchOverviewEntries((raw as any).branchOverviewEntries);
          return entries.length > 0 ? entries[entries.length - 1].text : undefined;
        }
        const legacy = (raw as any).branchOverview;
        return typeof legacy === 'string' && legacy.trim().length > 0 ? legacy : undefined;
      })(),
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
      pendingSpawnPrompt:
        typeof (raw as any).pendingSpawnPrompt === 'string' && (raw as any).pendingSpawnPrompt.trim()
          ? (raw as any).pendingSpawnPrompt
          : undefined,
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
      // Keep any artifact with a name plus at least one payload: a filePath
      // (doc/file/image) OR a url (link). Pre-artifact rows always had filePath.
      .filter(
        (c: any) =>
          typeof c?.name === 'string' &&
          ((typeof c?.filePath === 'string' && c.filePath) || typeof c?.url === 'string'),
      )
      .map((c: any) => {
        const url = typeof c.url === 'string' ? c.url : undefined;
        const filePath = typeof c.filePath === 'string' ? c.filePath : '';
        const type: ContextEntry['type'] =
          c.type === 'file' || c.type === 'image' || c.type === 'link' || c.type === 'doc'
            ? c.type
            : url
              ? 'link'
              : 'doc';
        const kind: ContextEntry['kind'] =
          c.kind === 'embedded' || c.kind === 'reference' ? c.kind : undefined;
        const originNodeId =
          c.origin && typeof c.origin.nodeId === 'string' ? c.origin.nodeId : undefined;
        return {
          id: typeof c.id === 'string' ? c.id : `ctx-${now}-${Math.random().toString(36).slice(2, 6)}`,
          name: c.name,
          filePath,
          url,
          type,
          kind,
          origin: originNodeId
            ? {
                nodeId: originNodeId,
                messageId:
                  c.origin && typeof c.origin.messageId === 'string' ? c.origin.messageId : undefined,
              }
            : undefined,
          size: typeof c.size === 'number' && Number.isFinite(c.size) ? c.size : undefined,
          pinnedAt: typeof c.pinnedAt === 'number' && Number.isFinite(c.pinnedAt) ? c.pinnedAt : undefined,
          source: c.source === 'agent' ? 'agent' : 'user',
          createdAt: typeof c.createdAt === 'number' ? c.createdAt : now,
          updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : now,
        };
      });
  }

  return {
    projects,
    activeProjectId: s.activeProjectId ?? null,
    nodes,
  };
}
