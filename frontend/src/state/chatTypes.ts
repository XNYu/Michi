import type { AgentSessionState, ChatStreamEnvelope, ChatStreamPayloads, SteerMessageOptions } from 'michi-shared';
import type { AgentCommand, AgentReasoning, PlanEntry, RuntimeId, SessionMode } from '../services/api';
import type { AgentStatus, PermissionRequest } from '../services/api';
import type { MentionRecord } from '../components/mentions';
import type { AttachmentRef } from '../lib/composerAttachments';
import type { UserInputAnswer, UserInputQuestion } from '../services/chatStreamEvents';
import type { BranchOverviewEntry, SteeringReport } from 'michi-shared';
import type { DurableMessageMetadata, ThreadMessageSource } from 'michi-shared';
import type { PaneItem, PaneLauncherChoice } from './paneItems';

export type { AgentStatus, PermissionRequest } from '../services/api';

export interface DigestState {
  /** Chat node ids whose transcripts feed the digest. */
  sources: string[];
  /** Snapshot of each source's fingerprint at generation time. */
  sourceFingerprints: Record<string, string>;
  /** The generated markdown. Empty string until the first generation completes. */
  content: string;
  /** Epoch ms when content was last written. 0 = never. */
  generatedAt: number;
  /**
   * Epoch ms when the user last opened the digest detail view. Used to drive
   * the unread indicator: a digest is unread iff `generatedAt > viewedAt`.
   * 0 = never viewed.
   */
  viewedAt: number;
  /** Mirror of chat status: 'streaming' while a generation/refresh is in flight. */
  status: 'idle' | 'streaming' | 'error';
  /** Last error message, if status === 'error'. */
  error?: string;
  /** Optional user-supplied prompt appended to the digest preamble. */
  customPrompt?: string;
  /** Ephemeral generation activity, never persisted or included in the result. */
  generation?: {
    startedAt: number;
    thought: string;
    activity: string;
  };
}

export type Theme = 'light' | 'dark';

export type NodeKind = 'chat' | 'digest' | 'artifact';

/** State for an artifact viewer pane (kind === 'artifact'). */
export interface ArtifactState {
  /** Relative file path within the workspace cwd. */
  filePath: string;
  /** Loaded text content. null = not yet fetched. */
  content: string | null;
  /** 'rendered' shows MarkdownContent; 'source' shows raw text. */
  viewMode: 'rendered' | 'source';
  /** File extension (without dot), e.g. 'md', 'ts'. */
  extension?: string;
  /** File basename, e.g. 'analysis.md'. */
  basename?: string;
  /** Size in bytes. */
  size?: number;
  /** Last-modified epoch ms. */
  modifiedAt?: number;
  /** Loading/error state. */
  status: 'idle' | 'loading' | 'error';
  error?: string;
  /**
   * Set by the artifact watcher when the file changed on disk since the last
   * load. Drives the "● Changed on disk · refresh" badge; content is NOT auto-replaced —
   * the user clicks to reload. Cleared on a successful reload.
   */
  pendingRefresh?: boolean;
  /** Set when the watcher reports the file was deleted on disk. */
  removed?: boolean;
}

export type ViewMode = 'single' | 'two' | 'three';

export interface ToolCallState {
  id: string;
  title: string;
  status: string;
  kind?: string;
  /** Agent's stated purpose for this tool call (from rawInput.__tool_use_purpose). */
  detail?: string;
  /** JSON-stringified tool input (truncated to 16KB). */
  inputJson?: string;
  /** Tool output/result (truncated to 16KB). */
  output?: string;
  /** Legacy/render hint. For block-first messages the tool block owns the
   *  section-local rawOffset; this field is kept for older projections and
   *  pre-block persisted data. */
  textOffset?: number;
  /** Wall-clock ms when the tool_call was first projected (see shared
   *  turnProjection mergeTool). Absent on turns persisted before the field
   *  existed — consumers must degrade to "no duration shown". */
  startedAt?: number;
  /** Wall-clock ms when the tool first reached a terminal status. */
  endedAt?: number;
}

/** Backend-clock ms (shared turnProjection appendText/closeTrailingTextBlock):
 *  when the block's first frame was observed and when a later block or the
 *  turn's end closed it. Absent on blocks persisted before the fields existed —
 *  consumers must degrade like they do for ToolCallState.startedAt/endedAt. */
interface TextBlockTiming {
  startedAt?: number;
  endedAt?: number;
}

export type AssistantBlock =
  | ({ id: string; kind: 'answer'; rawText: string; streaming?: boolean } & TextBlockTiming)
  | ({ id: string; kind: 'thinking'; rawText: string; streaming?: boolean } & TextBlockTiming)
  | {
      id: string;
      kind: 'tool';
      toolCallId: string;
      section: 'answer' | 'thinking';
      rawOffset: number;
    }
  | { id: string; kind: 'image'; workspaceId: string; path: string; caption?: string; mimeType: string; size: number }
  | {
      id: string;
      kind: 'user-input';
      requestId: number;
      interaction?: import('michi-shared').DurableUserInput;
      section: 'answer';
      rawOffset: number;
    };

export interface MessageAttachment {
  /** File name (basename), e.g. `MessageBlock.tsx`. */
  name: string;
  /** Absolute path on the user's disk. */
  absPath: string;
  /** Workspace-relative path (e.g. ".attachments/img.png"). Present for uploaded files. */
  relPath?: string;
}

/**
 * Optional structured metadata for a user send. Separates the bubble's
 * display representation from the wire payload sent to the agent.
 */
export interface UserSendMeta {
  /** Local input to restore if another window won the turn-start race. */
  rejectedDraft?: ComposerDraft;
  /** Restore transient composer attachments/comments after a rejected start. */
  onRejected?: () => void;
  crewMemoryMode?: import('michi-shared').CrewMemoryMode;
  permissionMode?: import('michi-shared').ChatPermissionMode;
  /** Approve for me on top of `permissionMode: 'ask'` (Kiro V3). */
  approveForMe?: boolean;
  /** Quoted passage for this turn. Rendered as a chip in the bubble. */
  quotedText?: string;
  /** Where quotedText came from (ChatMessage.quoteSource), for a retry's framing. */
  quoteSource?: import('../lib/quoteSource').AnyQuoteSource;
  /** File attachments for this turn. Rendered as decorative pills. */
  attachments?: MessageAttachment[];
  /** Pending reply-to-selection comments for this turn. Rendered as chips. */
  comments?: PendingComment[];
  /**
   * Bare prose override for the optimistic user-message `text`. When
   * absent, the second positional arg to send is used as both wire and
   * display text. Set this when the wire text contains flattened quote
   * prefix or attachment sentinel that should not appear in the bubble.
   */
  displayText?: string;
  /** Structured mention records from the composer. Persisted on the ChatMessage for click navigation. */
  mentions?: Array<{ kind: 'context' | 'node'; refId: string; label: string }>;
  /** Per-node runtime binding override from composer chips. Passed through to ensureSession. */
  runtimeId?: string;
  providerId?: string;
  modelId?: string;
  reasoning?: AgentReasoning | null;
  /**
   * The send isn't the composer's (a prompt the ⌘J assistant was asked to
   * send, a reply to a selection): leave the node's composer draft as it is.
   */
  keepDraft?: boolean;
}

/** Runtime binding fields a send or retry passes through to ensureSession. */
export type SendBindingMeta = Pick<UserSendMeta, 'runtimeId' | 'providerId' | 'modelId' | 'reasoning'>;

export interface CreateChildChatOptions {
  anchorMessageId?: string;
  /** Defaults to true. Background branches may opt out of taking focus. */
  focus?: boolean;
  /** Agent selection applied before the child's first turn starts. */
  modeId?: string;
  primaryAgent?: { backendConnectionId: string; definitionId: string };
}

export interface ChatMessage {
  usageSummary?: UsageSummary;
  warnings?: import('michi-shared').RuntimeWarning[];
  id: string;
  role: 'user' | 'assistant';
  /** User-typed body for user messages; legacy assistant body for old data. */
  text: string;
  toolCalls: ToolCallState[];
  /** Block-first assistant content. Hydration migrates assistant messages into this shape. */
  blocks?: AssistantBlock[];
  steeringReports?: SteeringReport[];
  steered?: boolean;
  streaming?: boolean;
  /** Legacy aggregate reasoning text for assistant messages created before blocks. */
  thought?: string;
  /** Latest plan entries from the agent. Plan events are a full replace, not an append. */
  plan?: PlanEntry[];
  /** Subagents this assistant turn delegated to; durable, persisted in metadata. */
  subagents?: SubagentInfo[];
  /** Unix ms when this message was created (user) or when the assistant turn began. Optional - legacy persisted messages lack it. */
  createdAt?: number;
  /**
   * Quoted passage the user attached to this turn (selection -> quote-reply).
   * Stored separately from `text` so the bubble can render it as a module.
   * Optional — historical messages flatten the quote into `text` via `> ...`
   * lines and rely on the legacy pre-wrap path.
   */
  quotedText?: string;
  /**
   * Where quotedText came from when not a selection from a reply (the ⌘J
   * assistant's attached context), so a retry frames it the same way. In
   * memory only: not persisted.
   */
  quoteSource?: import('../lib/quoteSource').AnyQuoteSource;
  /**
   * File attachments the user dropped/pasted onto this turn. Decorative in
   * the transcript; the wire payload still carries them via the
   * `[Attached files: ...]` sentinel. Optional for the same reason as
   * `quotedText`.
   */
  attachments?: MessageAttachment[];
  /**
   * Reply-to-selection comments attached to this turn. Each is a
   * (quotedText, body) pair the user wrote against an earlier assistant
   * reply. Optional — historical messages flatten the comment block into
   * `text` via `## My Comments on Previous Reply` markdown.
   */
  comments?: PendingComment[];
  /**
   * Structured mention records for this user message. Each entry preserves
   * the kind (context or node), the refId (contextId or nodeId), and the
   * display label. Used by highlightMentions to render clickable chips that
   * can navigate to the referenced artifact or conversation node.
   * Optional — historical messages rely on text-based matching as fallback.
   */
  mentions?: Array<{ kind: 'context' | 'node'; refId: string; label: string }>;
  /**
   * Set when this user message was relayed, with user approval, from another
   * thread's agent (send_to_thread). `text` then holds only the relayed body.
   */
  threadMessage?: ThreadMessageSource;
}

export interface UserInputRequest {
  requestId: number;
  interactionId?: string;
  questions: UserInputQuestion[];
  answers: UserInputAnswer[];
  resolved?: boolean;
  interrupted?: boolean;
}

/** Shared roster contract; folded by `mergeSubagentRoster` / `applySubagentActivity`. */
export type SubagentInfo = import('michi-shared').SubagentInfo;
export type SubagentActivity = import('michi-shared').SubagentActivity;

export interface UsageSummary {
  totalCredits?: number;
  charge?: import('michi-shared').UsageCharge;
  turnDurationMs?: number;
  source?: string;
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface ComposerMention {
  /** Inclusive: index of the leading '@' in the textarea value. */
  start: number;
  /** Exclusive: index of the first char after the chip body. */
  end: number;
  kind: 'context' | 'node';
  /** contextId for kind='context'; nodeId for kind='node'. */
  refId: string;
  /** Display label (without leading @). What the chip renders. */
  label: string;
}

export interface ComposerDraft {
  value: string;
  mentions: ComposerMention[];
  /** Selection quote the composer is replying to. Attachments are intentionally not persisted. */
  quotedText?: string;
  quoteSource?: import('../lib/quoteSource').AnyQuoteSource;
}

/**
 * Undo payload stamped onto a node when it is sent to trash via single-node
 * trim (Phase 2). Mirrors the backend `TrimSnapshot` so the same JSON
 * round-trips through the sync layer. Captures the minimum needed to reverse
 * the operation:
 *
 * - `parentId`     — the trimmed node's parent at trim time. Restore puts
 *                    the node back under this id; if that ancestor is itself
 *                    trimmed/gone, the resolver walks the snapshot chain up
 *                    until it finds a live ancestor (or null = new root).
 * - `childrenIds`  — the ids that became the trimmed node's children at
 *                    trim time. Restore re-steals the ones still alive AND
 *                    still parented to the resolved target parent.
 * - `wasTreeRoot`  — set when the trimmed node was a tree root. Restore
 *                    re-seats the tree's `rootNodeId` (or recreates the
 *                    tree row if trim dropped it because the node had no
 *                    live children at trim time).
 */
export interface TrimSnapshot {
  parentId: string | null;
  childrenIds: string[];
  wasTreeRoot: { treeId: string } | null;
}

export interface ChatNodeState {
  /** Server-owned native Page helper binding. Hydrated for embedding only;
   * never accepted from workspace sync writes. */
  pageId?: string | null;
  /** Server-owned: the Meta agent maintenance job that ran this transcript.
   * Hydrated read-only, never written back by workspace sync. */
  maintenanceJobId?: string | null;
  permissionMode?: import('michi-shared').ChatPermissionMode;
  /** Approve for me on top of `permissionMode: 'ask'` (Kiro V3). Server-owned, like permissionMode. */
  permissionApproveForMe?: boolean;
  /** Stable id used as the key in the nodes map. */
  nodeId: string;
  /** 'chat' for normal agent-backed threads; 'digest' for generated markdown docs. */
  kind: NodeKind;
  /**
   * Compatibility binding marker. Null before ensure-session; once bound it
   * must equal nodeId. Runtime-native ids never enter frontend state.
   */
  chatId: string | null;
  /** Runtime that owns this backend session. Undefined until the first session is created. */
  runtimeId?: RuntimeId;
  /** Provider/model/reasoning that created the current session binding. Used to decide exact vs compatible resume. */
  providerId?: string | null;
  modelId?: string | null;
  reasoning?: AgentReasoning | null;
  /** Live catalog for this session; refreshed on reconnect, never a global default. */
  sessionState?: AgentSessionState;
  commandResult?: { command: string; status: 'running' | 'completed' | 'error'; message: string };
  /** @deprecated Fingerprint check removed. Field retained for DB hydration compatibility only; always null for new nodes. */
  resumeFingerprint?: string | null;
  projectId: string;
  /** nodeId of the parent node (used for fork transcript seeding on backend). */
  parentNodeId?: string;
  /** For merge nodes: additional source node ids whose context seeds the first message. parentNodeId is the first one; mergeSources holds the rest. */
  mergeSources?: string[];
  /** Set when this node was materialized from a branch (Extract as new thread).
   *  Server-owned; messages with seq < inheritedMessageCount are copied history. */
  forkedFromNodeId?: string;
  forkBoundaryMessageId?: string;
  inheritedMessageCount?: number;
  messages: ChatMessage[];
  /**
   * Lazy-load marker (in-memory only, NEVER persisted or sent in any write-back
   * command payload). `false`/`undefined` = placeholder: this node's `messages`
   * are NOT the authoritative set — the bodies live in the DB and have not been
   * fetched yet (the tree hasn't been opened). `true` = bodies are loaded and
   * `messages` is authoritative.
   *
   * The distinction between "placeholder" (messagesLoaded:false, messages:[])
   * and "genuinely empty" (messagesLoaded:true, messages:[]) is what keeps a
   * placeholder node from ever being treated as if it truly has no messages.
   */
  messagesLoaded?: boolean;
  /**
   * Message count from the meta hydration payload, shown by Map/Digest/Branches
   * while bodies are unloaded. In-memory only; never persisted / written back.
   * Once messages load, `messages.length` is authoritative and this is ignored.
   */
  messageCount?: number;
  followUps: string[];
  /** id of the assistant message whose reply produced the current `followUps[]`.
   *  Set by `set-follow-ups` AND `done`. Cleared by `retry-trim` if its target is gone.
   *  Persisted as `follow_ups_source_message_id`. */
  followUpsSourceMessageId?: string;
  /**
   * Transient — true while the agent is in the middle of calling the
   * `set_follow_ups` tool (i.e. generating follow-up arguments after text
   * streaming completes). The UI renders a skeleton while this is true and
   * `followUps` is still empty. Cleared on `set-follow-ups` or `done`/`error`.
   * Not persisted.
   */
  followUpsGenerating?: boolean;
  /**
   * Transient UI boundary: all three body-generated follow-up sentinels have
   * arrived, so the user-facing answer is complete even though the backend
   * turn may still be finishing hidden overview metadata work.
   */
  visibleResponseComplete?: boolean;
  /**
   * Assistant turn that is still draining hidden metadata after the visible
   * response has completed. The node itself is idle/user-interactive while
   * this is set; it exists only to keep a late done/error from an older turn
   * from overwriting a newer foreground turn. Not persisted.
   */
  backgroundTurnAssistantId?: string;
  /** Title parsed from the agent's reply. null/undefined falls back to first user msg. */
  title?: string;
  /** Transient marker for titles created by a user/domain action. Runtime titles
   * are persisted by the backend turn writer and must not schedule a second write. */
  titleNeedsPersistence?: boolean;
  /** Agent-maintained append-only journal of per-turn overview entries,
   * rendered chronologically in the active thread's Branches document. */
  branchOverviewEntries?: BranchOverviewEntry[];
  /** Derived convenience: text of the latest journal entry. Kept in sync by
   * the reducer so existing reads (Branches page, export, fallback) don't
   * need changes. Never set directly — always derived from entries. */
  branchOverview?: string;
  /** Transient assistant message id that supplied the structured SSE overview.
   * Lets the terminal `done` parser remain a legacy fallback without
   * overwriting the canonical server-side extraction. */
  branchOverviewSourceMessageId?: string;
  status: 'idle' | 'streaming' | 'error';
  /** Current foreground or self-turn identity, separate from replay watermarks. */
  activeTurnId?: string;
  /** Backend cancel phase; the composer may already be locally idle. */
  cancelPhase?: 'requested' | 'acknowledged' | 'settled';
  compacting?: boolean;
  /** Transient session connection/recovery status; never model answer text. */
  runtimeActivity?: string;
  /** Epoch ms when the current streaming turn began. Survives remounts. */
  streamingStartedAt?: number;
  error?: string;
  /** Classification of the last error (Kiro runtime): 'connection' | 'auth' |
   * 'generic'. Drives the error banner variant + Test Connection affordance.
   * Undefined for unclassified errors / non-Kiro runtimes. Transient only —
   * not persisted; cleared when a new turn starts. */
  errorKind?: string;
  /** Original execution identity retained when its durable outcome is unknown. */
  errorTurnId?: string;
  errorRecovery?: 'checking' | 'unavailable';
  minimized?: boolean;
  /**
   * Transient - how long (ms) the agent has been silent during the current
   * streaming turn. Updated from backend heartbeat events; cleared on any
   * real progress (chunk/tool_call) and when the turn ends. Not persisted.
   */
  streamingIdleMs?: number;
  /** Broadcast turn id associated with lastAppliedSeq. Seq alone is insufficient
   * because each turn starts at 0. Transient per-window observer watermark. */
  lastAppliedTurnId?: string;
  /** Highest broadcast seq applied for lastAppliedTurnId. Transient. */
  lastAppliedSeq?: number;
  /** Background feed replay cursor. It is per-window/transient and must never
   * be persisted as the foreground durable replay watermark. */
  lastAppliedBackgroundTurnId?: string;
  lastAppliedBackgroundSeq?: number;
  /** Legacy manual layout position retained for older persisted state. */
  position?: { x: number; y: number };
  /**
   * Peer nodeIds whose last-reply context has already been injected into
   * this node's agent session. Prevents double-injection when the user sends
   * multiple messages after creating a link. Cleared if the link is removed
   * and re-created later (so a fresh link re-injects fresh context).
   */
  consumedLinks?: string[];
  /** Populated iff kind === 'digest'. Holds the generated markdown, sources, and fingerprints. */
  digest?: DigestState;
  /** Populated iff kind === 'artifact'. Holds the file viewer state. */
  artifact?: ArtifactState;
  /** True iff this node was created by an agent-initiated spawn_branches tool call. */
  spawnedByAgent?: boolean;
  /**
   * Server-durable first prompt for an agent-spawned child. This is a one-shot
   * outbox item, not a user composer draft; clear it only after turn_start.
   */
  pendingSpawnPrompt?: string;
  /**
   * Unix ms when this node was soft-deleted. Presence means it's in the
   * trash - renderers / tree walkers skip it. Absent = live. Cleared on
   * restore; the node + its descendants are purged permanently once
   * (now - deletedAt) exceeds the TTL.
   */
  deletedAt?: number;
  /**
   * Groups nodes that were deleted in the same `deleteNode()` call (a root +
   * its descendants). Restore / permanent-delete operate on a whole group.
   */
  deletionGroupId?: string;
  /**
   * Set when the node was sent to trash via single-node trim (Phase 2). Holds
   * everything `restoreTrimmedNode()` needs to reverse the operation: the
   * original parent, the children that got reparented up, and the tree-root
   * pointer if the trimmed node was a tree root. Absent on subtree
   * deletions, which use `deletionGroupId` for restore lookups.
   */
  trimSnapshot?: TrimSnapshot;
  /**
   * The agent's currently-advertised slash-command catalog for this session.
   * Populated from `available_commands_update` ACP events, which Kiro
   * publishes at session start and whenever its mode / command set
   * changes. Not persisted - rebuilt on each run.
   */
  agentCommands?: AgentCommand[];
  /** ACP currentModeId for this session (aka the Kiro agent id). Null until bound. */
  currentModeId?: string | null;
  /** Pending tool-call permission request from the agent. Present while awaiting user approval. */
  pendingPermission?: PermissionRequest | null;
  /** Pending AskUserQuestion from the agent. Present while awaiting user answers. */
  pendingUserInput?: UserInputRequest | null;
  /** User-set pane width in pixels. undefined = flex (1fr). Persisted. */
  paneWidth?: number;
  subagents?: SubagentInfo[];
  contextUsagePercentage?: number;
  usageSummary?: UsageSummary;
  mcpServerError?: { serverName: string; error: string } | null;
  warning?: import('michi-shared').RuntimeWarning | null;
  errorRecoverable?: boolean;
  errorCompletedAt?: number;
  /**
   * Persisted composer draft for this node. Lets the user switch threads,
   * workspaces, or panes without losing partially-written text and @mentions.
   */
  composerDraft?: ComposerDraft;
  /**
   * In-memory list of selection comments the user has accumulated on this
   * node's assistant messages. The user selects a passage → picks
   * `comment` from the selection action bar → writes a reply. Comments
   * queue here until the next outgoing prompt from this node, at which
   * point they are formatted into a markdown block, prepended to the
   * user's text, and cleared. Not persisted across reloads; survives
   * pane switches / workspace reloads only because the nodes map itself
   * is kept in memory for that duration.
   */
  pendingComments?: PendingComment[];
  /**
   * Messages the user wrote while this node was streaming. Flushed as
   * one combined message when the current turn finishes (done/cancel);
   * preserved + flagged via `queueErrored` if the stream errored. See
   * `docs/superpowers/specs/2026-05-07-composer-queue-design.md`.
   */
  pendingQueued?: PendingQueuedMessage[];
  /**
   * Set true by the stream-error handler when the queue is non-empty
   * at error time. UI shows a paused/danger rail until the user
   * either dequeues everything or re-sends manually.
   */
  queueErrored?: boolean;
  /**
   * Wall-clock ms of the last assistant `done`. Bumped only on the final
   * response, not on streaming chunks. Mirrors `digest.generatedAt`.
   * Used to compute unread state (see sidebarSelectors.isNodeUnread).
   * Persisted via workspacePersistence dirty-bit flush.
   */
  lastAssistantAt?: number;
  /**
   * Wall-clock ms when the user last opened (focused) this node.
   * Set on focusedNodeId change in chatStore. Mirrors `digest.viewedAt`.
   * Unread iff `lastAssistantAt > viewedAt` (with focusedNodeId excluded
   * by the selector). Persisted.
   */
  viewedAt?: number;
  /**
   * Node-level pin. Unix ms when the user pinned this branch node; absent =
   * not pinned. A pinned node floats to the top of its sibling group in the
   * sidebar (most recently pinned first), mirroring `Tree.pinnedAt` one level
   * down. Root nodes use the thread-level pin instead. Persisted as
   * `nodes.pinned_at`.
   */
  pinnedAt?: number;
}

export interface PendingComment {
  /** Stable id used for remove-comment lookups. */
  id: string;
  /** Selected passage text (whitespace-trimmed). */
  quotedText: string;
  /** User's reply to that passage. */
  body: string;
  /** Unix ms when added; kept for UI ordering / potential future sorting. */
  createdAt: number;
  /** When the comment targets an artifact file, carries source metadata. */
  source?: import('../lib/quoteSource').QuoteSource;
}

/**
 * A message the user composed while node N was streaming. Held in
 * memory on N until the stream ends, then flushed as one combined
 * user message via sendMessage. Cleared on stream-error (with the
 * `queueErrored` flag set so the UI can prompt for manual re-send),
 * or on dequeue (when the user × the pill — TPane restores the
 * entry to the composer draft).
 */
export interface PendingQueuedMessage {
  /** A steer request owns this entry until it settles; do not auto-flush it. */
  steering?: boolean;
  /** Stable id used for dequeue lookups. */
  id: string;
  /** User's literal text, including @chip labels (not wire tokens). */
  value: string;
  /** Mention offsets, used by expandMentions at flush time. */
  mentions: MentionRecord[];
  /** Attachments queued with this message; concatenated on flush. */
  attachments: AttachmentRef[];
  /** Quoted-selection text active at queue time, if any. */
  quotedText?: string;
  /** Where quotedText came from, when not a selection from a reply (the ⌘J assistant's attached context). */
  quoteSource?: import('../lib/quoteSource').AnyQuoteSource;
  /** Pre-formatted comment block (from formatCommentsBlock) active at queue time. */
  commentBlock?: string;
  /** Structured source metadata retained when this queue is flushed. */
  comments?: PendingComment[];
  /** Wall-clock at queue time. Recorded but unused in v1. */
  queuedAt: number;
}

export interface Tree {
  /** Tree id. Independent of node ids. */
  id: string;
  /** Root nodeId of this tree. Member of the owning project's chatIds. */
  rootNodeId: string;
  /** User-set name. Falls back to the root node's title in UI. */
  name?: string;
  createdAt: number;
  /** Bumped whenever a node-level event (chunk/done/user-send/title/...) lands on a node in this tree. */
  lastActiveAt: number;
  /** Presence means archived. */
  archivedAt?: number;
  /** Presence means pinned. Pinned trees sort to the top of the manage list. */
  pinnedAt?: number;
  /** 'merge' = root is a merge node; sidebar renders this tree under the
   *  Merged section instead of the main Threads list. Undefined / 'normal'
   *  is the default. */
  kind?: 'normal' | 'merge';
}

/**
 * A workspace-scoped artifact (the 3a "Artifacts" shelf). One flat list per
 * project, four types. What it IS (`type`) is orthogonal to how "use it"
 * resolves (`kind`):
 *
 *   type=doc   kind=embedded  → filePath under .contexts/; @-mention inlines body
 *   type=file  kind=reference → filePath is an abs disk path; @-mention emits
 *                               `[Referenced file at: <path>]`
 *   type=image kind=reference → filePath (abs path / .attachments); same as file
 *   type=link  (no kind)      → url only, no file; @-mention emits `[Link: <url>]`
 *
 * Exactly one of `filePath` (doc/file/image) or `url` (link) is the payload.
 */
export interface ArtifactEntry {
  id: string;
  /** Unique per project, [\p{L}\p{N}_-]+. */
  name: string;
  /** '' for link artifacts (they carry `url`). Otherwise the path/rel-path. */
  filePath: string;
  /** External URL for link artifacts. Mutually exclusive with a real filePath. */
  url?: string;
  /** What this artifact IS. Absent on legacy rows → inferred (url→link, else doc). */
  type?: 'doc' | 'file' | 'image' | 'link';
  /** Best-effort byte/char estimate used for first-message budget checks. */
  size?: number;
  /** Provenance breadcrumb: the node/message this artifact came from. Metadata only. */
  origin?: { nodeId: string; messageId?: string };
  /** Presence = pinned to the top of the shelf. UI ordering only; NOT injection. */
  pinnedAt?: number;
  source: 'user' | 'agent';
  /**
   * `embedded` (default if absent): file lives under the workspace's
   * `.contexts/` directory, content was imported. `@`-mention reads and
   * embeds the body.
   * `reference`: filePath is an absolute path on the user's disk; nothing
   * was copied. `@`-mention emits a path-only line; the agent reads via
   * its filesystem tools.
   * `symlink`: filePath is a cwd-relative path under `.artifacts/` that is a
   * symlink to an external file (no bytes copied). The agent's fs tools follow
   * it → live bidirectional read/write; the in-app viewers 404 it (realpath
   * guard), so it opens via the OS default app.
   */
  kind?: 'embedded' | 'reference' | 'symlink';
  createdAt: number;
  updatedAt: number;
}

export type EdgeKind = 'branch' | 'merge' | 'link' | 'digest-source';

export interface ProjectEdge {
  source: string;
  target: string;
  kind?: EdgeKind;
  /** For kind='branch': id of the message in `source` where the fork was
   *  anchored. Undefined for historical edges and orphaned anchors.
   *  Persisted as `anchor_message_id`. */
  anchorMessageId?: string;
  /** Unix ms when the fork was created. Used to sort stacked markers
   *  and as the "branched 5m ago" display. Persisted as `created_at`. */
  createdAt?: number;
}

export interface FolderEntry {
  id: string;
  path: string;
  label?: string;
  addedAt: number;
}

export interface Project {
  id: string;
  name: string;
  /** Execution backend for this workspace. Undefined/'local' keeps legacy local behavior. */
  backendConnectionId?: string;
  /** Absolute path the backend runs the agent in. Undefined = default cwd. */
  cwd?: string;
  /** Registered folders for this workspace. folders[0].path is the immutable cwd.
   *  Empty/undefined + cwd present → auto-upgrade on hydration. Defaults to []. */
  folders?: FolderEntry[];
  /** nodeIds belonging to this project, in creation order. First = root. */
  chatIds: string[];
  /** edges parent -> child, using nodeIds. kind defaults to 'branch'. */
  edges: ProjectEdge[];
  createdAt: number;
  /** Trees rooted inside this workspace. Usually at least one. */
  trees: Tree[];
  /** id of the currently-active tree. null only when every tree is archived or deleted. */
  activeTreeId: string | null;
  artifacts?: ArtifactEntry[];
  deletedAt?: number;
  /** Presence means archived. Hidden from main sidebar list, lives under a collapsed section. */
  archivedAt?: number;
  /** Presence means pinned to top of sidebar. */
  pinnedAt?: number;
  /** Per-workspace toggle for AI to use list_threads / search_messages / read_node tools. Default true. */
  aiGlobalContext?: boolean;
  /** Per-workspace system-prompt addendum. Edited via the manage page's
   *  Instructions panel. Stored inside workspaces.settings JSON. */
  instructions?: string;
  /** Set on workspaces Michi itself owns (settings.system, e.g. 'assistant').
   *  They never appear where workspaces are listed; see state/assistant/systemWorkspace.ts. */
  system?: string;
}

export type ChatAction =
  | { type: 'create'; nodeId: string; projectId: string; parentNodeId?: string; mergeSources?: string[]; modeId?: string }
  | { type: 'set-permission-mode'; nodeId: string; mode: import('michi-shared').ChatPermissionMode; approveForMe?: boolean }
  | {
      type: 'bind-chat';
      nodeId: string;
      /** Deprecated compatibility input; reducers ignore it and bind to nodeId. */
      chatId?: string;
      currentModeId?: string | null;
      runtimeId?: RuntimeId;
      providerId?: string | null;
      modelId?: string | null;
      reasoning?: AgentReasoning | null;
    }
  | { type: 'unbind-chat'; nodeId: string }
  | {
      type: 'user-send';
      nodeId: string;
      userText: string;
      assistantId: string;
      quotedText?: string;
      attachments?: MessageAttachment[];
      comments?: PendingComment[];
      mentions?: Array<{ kind: 'context' | 'node'; refId: string; label: string }>;
      /** Not a composer send: the composer draft stays (UserSendMeta.keepDraft). */
      keepDraft?: boolean;
      quoteSource?: import('../lib/quoteSource').AnyQuoteSource;
    }
  | { type: 'chunk'; nodeId: string; assistantId: string; text: string; observedAt?: number }
  | { type: 'steering-report'; nodeId: string; assistantId: string; reports: SteeringReport[] }
  | { type: 'steer-accepted'; nodeId: string; data: ChatStreamPayloads['steer_accepted'] & ChatStreamEnvelope }
  | { type: 'queue-steering'; nodeId: string; queueId: string; steering: boolean }
  | { type: 'thought'; nodeId: string; assistantId: string; text: string; observedAt?: number }
  | { type: 'plan'; nodeId: string; assistantId: string; entries: PlanEntry[] }
  | { type: 'tool-call'; nodeId: string; assistantId: string; tool: ToolCallState; observedAt?: number }
  | { type: 'tool-call-update'; nodeId: string; assistantId: string; tool: ToolCallState; observedAt?: number }
  | { type: 'image-block'; nodeId: string; assistantId: string; path: string; caption?: string; mimeType: string; size: number }
  | {
      type: 'done';
      nodeId: string;
      assistantId: string;
      completedAt?: number;
      /** The turn was cancelled (Stop / abort). Still-active tool calls are
       *  finalized as 'interrupted' instead of 'completed'. */
      aborted?: boolean;
    }
  | { type: 'recover-original-result'; nodeId: string; turnId: string; assistantId: string; assistant: ChatMessage; lastSeq: number; cursor: 'foreground' | 'background' }
  | { type: 'error-recovery'; nodeId: string; state?: 'checking' | 'unavailable' }
  | { type: 'error'; nodeId: string; assistantId: string; message: string; errorKind?: string; recoverable?: boolean; completedAt?: number; turnId?: string }
  | {
      type: 'observer-turn-start';
      nodeId: string;
      turnId: string;
      assistantId: string;
      userText: string;
      selfInitiated?: boolean;
      /** Metadata of the turn's visible user message (e.g. a cross-thread message source). */
      userMetadata?: DurableMessageMetadata;
      cursor?: 'foreground' | 'background';
    }
  | { type: 'apply-seq'; nodeId: string; turnId: string; seq: number }
  | { type: 'active-turn'; nodeId: string; assistantId: string; turnId: string }
  | { type: 'apply-background-seq'; nodeId: string; turnId: string; seq: number }
  | { type: 'block-reset'; nodeId: string; assistantId: string }
  | { type: 'realign-assistant-id'; nodeId: string; fromId: string; toId: string }
  | {
      /**
       * Lazy-load: install fetched message bodies for the nodes of one tree.
       * `messagesByNode` maps nodeId → its full ordered message list. Every
       * listed node flips to `messagesLoaded: true`. Nodes not in the map are
       * untouched. This action MUST NOT dirty the node for write-back — the
       * bodies just came FROM the backend and re-sending them is a no-op the
       * write-back layer isn't even capable of (messages are backend-authored).
       */
      type: 'messages-loaded';
      nodeIds: string[];
      messagesByNode: Record<string, ChatMessage[]>;
    }
  | { type: 'retry-trim'; nodeId: string; fromIndex?: number }
  | { type: 'heartbeat'; nodeId: string; idleMs: number }
  | { type: 'set-minimized'; nodeId: string; minimized: boolean }
  | { type: 'set-position'; nodeId: string; position: { x: number; y: number } }
  | { type: 'clear-positions'; nodeIds: string[] }
  | { type: 'consume-links'; nodeId: string; peerIds: string[] }
  | { type: 'forget-consumed-link'; nodeId: string; peerId: string }
  | { type: 'create-artifact'; nodeId: string; projectId: string; filePath: string }
  | { type: 'artifact-loading'; nodeId: string }
  | { type: 'artifact-loaded'; nodeId: string; content: string; basename: string; extension: string; size: number; modifiedAt: number }
  | { type: 'artifact-error'; nodeId: string; error: string }
  | { type: 'artifact-set-view'; nodeId: string; viewMode: 'rendered' | 'source' }
  | { type: 'artifact-mark-stale'; nodeId: string }
  | { type: 'artifact-mark-removed'; nodeId: string }
  | { type: 'create-digest'; nodeId: string; projectId: string; sources: string[] }
  | { type: 'digest-started'; nodeId: string }
  | { type: 'digest-chunk'; nodeId: string; text: string }
  | { type: 'digest-thought'; nodeId: string; text: string }
  | { type: 'digest-status'; nodeId: string; text: string }
  | {
      type: 'digest-generated';
      nodeId: string;
      content: string;
      sourceFingerprints: Record<string, string>;
      generatedAt: number;
      /** When set, replace the digest's source list. Used by rebuilds that
       *  pick up chats added to the originating tree after the digest was
       *  first created. */
      sources?: string[];
    }
  | { type: 'digest-error'; nodeId: string; message: string }
  | { type: 'digest-set-prompt'; nodeId: string; customPrompt: string }
  | { type: 'digest-viewed'; nodeId: string; viewedAt: number }
  | { type: 'node-viewed'; nodeId: string; viewedAt: number }
  | { type: 'mark-all-read'; viewedAt: number }
  | { type: 'set-title'; nodeId: string; title: string }
  | { type: 'set-branch-overview'; nodeId: string; overview: string; assistantId?: string }
  | { type: 'rename-node'; nodeId: string; title: string }
  | { type: 'pin-node'; nodeId: string; now: number }
  | { type: 'unpin-node'; nodeId: string }
  | { type: 'set-follow-ups'; nodeId: string; followUps: string[] }
  | { type: 'visible-response-complete'; nodeId: string; assistantId: string }
  | { type: 'follow-ups-status'; nodeId: string; status: 'in_progress' | 'completed' | 'failed' }
  | { type: 'command-result'; nodeId: string; result: NonNullable<ChatNodeState['commandResult']> }
  | { type: 'session-state'; nodeId: string; state: AgentSessionState }
  | { type: 'set-commands'; nodeId: string; commands: AgentCommand[] }
  | { type: 'set-current-mode'; nodeId: string; currentModeId: string }
  | { type: 'set-pane-width'; nodeId: string; width: number | undefined }
  | {
      type: 'agent-spawn';
      parentNodeId: string;
      projectId: string;
      nodes: Array<{ nodeId: string; chatId: string; title: string; prompt: string; runtimeId?: RuntimeId }>;
    }
  | { type: 'spawn-prompt-started'; nodeId: string }
  | { type: 'permission-request'; nodeId: string; permission: PermissionRequest }
  | { type: 'permission-resolved'; nodeId: string; requestId?: number }
  | { type: 'user-input-request'; nodeId: string; assistantId?: string; userInput: UserInputRequest }
  | { type: 'user-input-resolved'; nodeId: string; requestId?: number; interactionId?: string; answers?: UserInputAnswer[]; outcome?: 'answered' | 'skipped' }
  /** Roster patch; `assistantId` targets the message that owns the roster. */
  | { type: 'subagent-list-update'; nodeId: string; assistantId?: string; subagents: import('michi-shared').SubagentPatch[] }
  | ({ type: 'subagent-tool-activity'; nodeId: string; assistantId?: string } & import('michi-shared').SubagentActivityPayload)
  /**
   * Background subagents of a node that ended without a turn reporting
   * them (their agent process ended first); the backend already stored the
   * same ends. From the workflow-runs feed of `workspaceId`.
   */
  | { type: 'background-subagents-ended'; nodeId: string; workspaceId: string; subagents: import('michi-shared').SubagentEnd[] }
  | { type: 'context-usage'; nodeId: string; contextUsagePercentage: number }
  | {
      type: 'usage-summary';
      nodeId: string;
      assistantId?: string;
      contextUsagePercentage?: number;
      totalCredits?: number;
      charge?: import('michi-shared').UsageCharge;
      turnDurationMs?: number;
      source?: string;
      totalTokens?: number;
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
      reasoningOutputTokens?: number;
    }
  | { type: 'cancel-phase'; nodeId: string; phase: 'requested' | 'acknowledged' | 'settled' }
  | { type: 'optimistic-cancel'; nodeId: string }
  | { type: 'compaction'; nodeId: string; active: boolean }
  | { type: 'runtime-activity'; nodeId: string; assistantId?: string; detail?: string }
  | { type: 'cancel-recovery'; nodeId: string; assistantId: string; state: 'pending' | 'settled' | 'error'; detail?: string }
  | { type: 'warning'; nodeId: string; assistantId?: string; warning: import('michi-shared').RuntimeWarning }
  | { type: 'mcp-server-error'; nodeId: string; serverName: string; error: string }
  | { type: 'set-composer-draft'; nodeId: string; draft: ComposerDraft | null; preserveExisting?: boolean }
  | { type: 'add-comment'; nodeId: string; comment: PendingComment }
  | { type: 'edit-comment'; nodeId: string; commentId: string; body: string }
  | { type: 'remove-comment'; nodeId: string; commentId: string }
  | { type: 'clear-comments'; nodeId: string }
  | { type: 'queue-message'; nodeId: string; message: PendingQueuedMessage }
  | { type: 'dequeue-message'; nodeId: string; messageId: string }
  | { type: 'flush-queue'; nodeId: string }
  | { type: 'mark-queue-errored'; nodeId: string };

export type ProjectAction =
  | { type: 'create-tree'; treeId: string; rootNodeId: string; now: number; kind?: 'normal' | 'merge' }
  | { type: 'archive-tree'; treeId: string; now: number }
  | { type: 'unarchive-tree'; treeId: string; now: number }
  | { type: 'pin-tree'; treeId: string; now: number }
  | { type: 'unpin-tree'; treeId: string }
  | { type: 'rename-tree'; treeId: string; name: string }
  | { type: 'activate-tree'; treeId: string | null }
  | { type: 'touch-tree'; treeId: string; now: number }
  | {
      type: 'upsert-context';
      projectId: string;
      context: {
        id?: string;
        name: string;
        filePath: string;
        url?: string;
        type?: 'doc' | 'file' | 'image' | 'link';
        size?: number;
        source?: 'user' | 'agent';
        origin?: { nodeId: string; messageId?: string };
        kind?: 'embedded' | 'reference' | 'symlink';
      };
    }
  | {
      type: 'update-context-by-name';
      projectId: string;
      context: {
        id?: string;
        name: string;
        filePath: string;
        url?: string;
        type?: 'doc' | 'file' | 'image' | 'link';
        size?: number;
        source?: 'user' | 'agent';
        origin?: { nodeId: string; messageId?: string };
        kind?: 'embedded' | 'reference' | 'symlink';
      };
    }
  | { type: 'delete-context'; projectId: string; contextId: string }
  | { type: 'pin-context'; projectId: string; contextId: string; now: number }
  | { type: 'unpin-context'; projectId: string; contextId: string }
  | { type: 'rename-context'; projectId: string; contextId: string; newName: string };

export interface ChatContextValue {
  projects: Project[];
  activeProjectId: string | null;
  activeProject: Project | null;
  order: string[];
  edges: ProjectEdge[];
  theme: Theme;
  toggleTheme: () => void;
  createProject: (name?: string, cwd?: string, folders?: FolderEntry[], backendConnectionId?: string) => Promise<string>;
  /**
   * Activate the singleton "Chats" workspace, lazily creating it (and a root
   * thread) on first call. The Skip path of the new-workspace dialog and
   * any other "just chat" entry point should call this instead of spawning
   * a fresh Untitled workspace.
   */
  enterChatsWorkspace: () => Promise<string>;
  renameProject: (projectId: string, name: string) => void;
  /** Replace the absolute folder bound to a workspace. Desktop-only UI supplies the path. */
  setProjectCwd: (projectId: string, cwd: string) => void;
  /** Add a secondary folder to the workspace's allowlist. */
  addFolder: (projectId: string, folderPath: string, label?: string) => void;
  /** Remove a secondary folder (cannot remove folders[0]). */
  removeFolder: (projectId: string, folderId: string) => void;
  /** Update a folder's display label. */
  updateFolderLabel: (projectId: string, folderId: string, label: string) => void;
  /** Persist the per-workspace system-prompt addendum. Empty string clears it. */
  setProjectInstructions: (projectId: string, instructions: string) => void;
  deleteProject: (projectId: string) => void;
  restoreProject: (projectId: string) => void;
  /**
   * Permanently delete a workspace and all of its data on the backend.
   * Resolves once the backend cascade completes; rejects if the network
   * call fails (local state is still cleared either way). Callers that
   * don't need to await fire-and-forget the returned Promise.
   */
  purgeProject: (projectId: string) => Promise<void>;
  archiveProject: (projectId: string) => void;
  unarchiveProject: (projectId: string) => void;
  selectProject: (projectId: string) => void;
  sendMessage: (
    nodeId: string,
    text: string,
    meta?: UserSendMeta,
  ) => void;
  /** Inspect the original turn when its outcome is unknown; otherwise trim and resend for a fresh reply. */
  retryLastTurn: (nodeId: string, fromIndex?: number, binding?: SendBindingMeta) => void;
  /** Explicitly execute again; an uncertain original attempt keeps its existing output and anchors. */
  rerunLastTurn: (nodeId: string, fromIndex?: number, binding?: SendBindingMeta) => void;
  /** Trim from a given user message index and resend with new (edited) text. */
  editAndResend: (nodeId: string, fromIndex: number, newText: string) => void;
  createChildChat: (
    parentNodeId: string,
    firstMessage: string,
    meta?: UserSendMeta,
    // focus defaults to true (open + focus the new pane). Pass focus:false for
    // chat-pane branch gestures that should keep the user on the current pane.
    opts?: CreateChildChatOptions,
  ) => Promise<string>;
  /** Create an empty child chat (no streaming turn) branched from the given node. Returns the new nodeId. */
  createBlankChild: (parentNodeId: string, opts?: { anchorMessageId?: string }) => Promise<string>;
  createMergedChat: (sourceNodeIds: string[]) => Promise<string>;
  cancelStream: (nodeId: string) => void;
  /** Runtime Agent catalog, refreshed on workspace and Backend changes. */
  availableModes: SessionMode[];
  /** The mode ACP assigns to a brand-new session before any user override. Null when unavailable. */
  defaultModeId: string | null;
  agentModesLoading: boolean;
  agentModesError: string | null;
  retryAgentModes: () => void;
  /**
   * Current agent runtime status from `/api/agent/status` (capabilities,
   * runtime label, provider list, etc.). null until first fetch resolves.
   */
  agentStatus: AgentStatus | null;
  /**
   * Error message recorded when /api/ready reports `failed` during boot
   * (e.g. kiro-cli ENOENT). null when warm is pending or has succeeded.
   * Surfaced by UI to let the user retry without reopening Settings.
   */
  warmFailedError: string | null;
  /**
   * Force a refresh of agentStatus by dispatching `michi:reload-agent-status`.
   * Use after saving keys / changing runtime / provider so listeners (the
   * gate, settings, toolbar chips) all see the new status.
   */
  refreshAgentStatus: () => void;
  /** Switch the active agent/mode for a chat via ACP session/set_mode. Optimistically updates local state. */
  switchAgent: (nodeId: string, modeId: string) => Promise<void>;
  deleteNode: (nodeId: string) => void;
  /**
   * Single-node trim: send the node to trash AND reparent its children up.
   * Tree-root case promotes the oldest live child to the new root and the
   * remaining children become its children (Option A). Restore reverses
   * via the trimSnapshot stamped on the node.
   */
  trimNode: (nodeId: string) => void;
  /** Move this chat and its descendants into a new tree, materializing parent history. */
  extractNodeTree: (nodeId: string) => Promise<string | undefined>;
  /**
   * Archive a single node. Same mechanics as {@link trimNode} (children
   * reparent up, restorable via the trimSnapshot) but routed to the Archived
   * surface instead of Trash and exempt from trash-only purge flows.
   */
  archiveNode: (nodeId: string) => void;
  /** Restore the most-recently-deleted group. Returns the root nodeId of the restored subtree, or null if nothing to restore. Cmd+Z binds to this. */
  restoreLastDeletion: () => string | null;
  /** Restore a specific deletion group. Returns the root nodeId, or null. */
  restoreDeletion: (groupId: string) => string | null;
  /** Permanently purge a deletion group (local state only). Prefer `purgeDeletionAsync` from UI. */
  purgeDeletion: (groupId: string) => void;
  /**
   * Permanently purge a deletion group, awaiting backend confirmation
   * before clearing local state. Resolves with the count of rows the
   * backend physically removed; rejects if the network call fails so
   * the UI can keep the trash entry visible and surface the error.
   */
  purgeDeletionAsync: (groupId: string) => Promise<{ purged: number }>;
  /** Permanently purge everything in the trash (local state only). Prefer `emptyTrashAsync` from UI. */
  emptyTrash: () => void;
  /**
   * Permanently purge every deletion group across every workspace,
   * awaiting backend confirmation before clearing local state.
   * Sync is paused for the duration to prevent a stale POST /sync
   * from resurrecting just-purged rows. Resolves with the aggregate
   * row count; rejects on the first backend failure.
   */
  emptyTrashAsync: () => Promise<{ purged: number }>;
  setMinimized: (nodeId: string, minimized: boolean) => void;
  setPaneWidth: (paneId: string, width: number | undefined) => void;
  setNodePosition: (nodeId: string, position: { x: number; y: number }) => void;
  /** Clears legacy manual positions for every node in the active project. */
  resetLayout: (projectId: string) => void;
  /**
   * Fan out N research branches from a parent node, each seeded with its own
   * starting message. Returns the new node ids in input order.
   */
  fanoutBranches: (
    parentNodeId: string,
    topics: string[],
    opts?: { anchorMessageId?: string },
  ) => Promise<string[]>;
  /**
   * Link two existing nodes (no-op if already linked or self-loop). A link
   * is a bidirectional context bridge: next time either node sends a
   * message, the other's latest reply is injected into its agent session.
   * Returns true iff a new edge was created.
   */
  linkNodes: (a: string, b: string) => boolean;
  /** Remove the link edge between a and b (no-op if absent). */
  unlinkNodes: (a: string, b: string) => void;
  /** Create a digest node whose sources are the given chat node ids. */
  createDigest: (projectId: string, sources: string[], customPrompt?: string) => Promise<string>;
  /** Re-run digest generation for an existing digest node, aborting any in-flight gen. */
  refreshDigest: (nodeId: string) => Promise<void>;
  /** Update the custom prompt for a digest node. */
  setDigestPrompt: (nodeId: string, customPrompt: string) => void;
  /** Mark a digest node as viewed (clears its unread state). */
  markDigestViewed: (nodeId: string) => void;
  /** Save or clear the composer draft for a node. */
  setComposerDraft: (nodeId: string, draft: ComposerDraft | null) => void;
  /** Delete a digest node (aborts in-flight generation, removes edges + state). */
  deleteDigest: (nodeId: string) => void;
  /** Compatibility entry point for artifact shelf/link callers. Returns a file PaneItem id. */
  openArtifactPane: (filePath: string, options?: { parseSourceLocation?: boolean }) => Promise<string>;
  /** Open a blank multifunction pane whose content is selected in-place. */
  openLauncherPane: () => string;
  /** Transform a blank multifunction pane without changing its layout slot. */
  activateLauncherPane: (paneId: string, choice: PaneLauncherChoice) => Promise<string>;
  /** Move an existing detached terminal into a launcher slot. */
  adoptTerminalPane: (launcherPaneId: string, terminalPaneId: string) => void;
  /** Open a standalone file viewer without inserting it into the chat graph. */
  openFilePane: (filePath: string, options?: { parseSourceLocation?: boolean }) => string;
  /** Open a workspace-owned native Page beside chat in the active pane slot. */
  openPagePane: (page: { pageId: string; workspaceId: string; backendConnectionId: string; title?: string }) => string;
  /** Open a workspace-relative working-tree diff. */
  openDiffPane: (filePath: string) => string;
  /** Open a persistent PTY surface rooted at cwd (active workspace cwd by default). */
  openTerminalPane: (cwd?: string) => string;
  /** Open a secure native browser surface. */
  openBrowserPane: (url?: string) => string;
  /** Patch serializable pane metadata such as title, URL, or view mode. */
  updatePaneItem: (paneId: string, patch: Partial<PaneItem>) => void;
  /** Non-node pane descriptors, keyed by pane id. Runtime objects never enter React state. */
  paneItems: Record<string, PaneItem>;
  /** Pane ids currently open in tab order. Existing ids may still be chat-node ids. */
  openPanes: string[];
  /** Currently-focused pane nodeId. Always one of openPanes if non-empty. */
  focusedPane: string | null;
  /** Monotonic counter bumped on every focusPane call — lets effects fire even
   *  when the focused pane id hasn't changed (e.g. clicking an already-focused
   *  pane that scrolled out of view). */
  focusNonce: number;
  /** The globally-focused chat node id (independent of open panes). null = none. */
  focusedNodeId: string | null;
  setFocusedNodeId: (nodeId: string | null) => void;
  /** How many panes to render side-by-side. Overflow panes live in the tab strip. */
  viewMode: ViewMode;
  openPane: (nodeId: string) => void;
  /**
   * Open a pane in a *specific* (project, tree) slot — bypasses the
   * activeProject/activeTree-derived paneKey. Use this when activating a
   * different thread *and* opening a non-root pane in the same tick: the
   * derived paneKey hasn't refreshed yet, so plain `openPane` would write
   * into the outgoing thread's slot.
   */
  openPaneInTree: (projectId: string, treeId: string, nodeId: string) => void;
  closePane: (nodeId: string) => void;
  focusPane: (nodeId: string) => void;
  /** Reorder open panes: move `fromId` to the index of `toId`. */
  reorderPane: (fromId: string, toId: string) => void;
  /** Step back to the previously focused chat location (browser-style; crosses
   *  trees/workspaces). No-op when the back stack is empty. In-memory only. */
  navBack: () => void;
  /** Step forward again after navBack. No-op when the forward stack is empty. */
  navForward: () => void;
  /** Whether navBack has a destination — drives the topbar button enabled state. */
  canNavBack: boolean;
  /** Whether navForward has a destination. */
  canNavForward: boolean;
  setViewMode: (mode: ViewMode) => void;
  /** Node ids currently selected for multi-node operations. In-memory only; clears on project switch. */
  selection: ReadonlySet<string>;
  toggleSelection: (nodeId: string) => void;
  clearSelection: () => void;
  createThread: (modeId?: string) => string | null;
  setChatPermissionMode: (nodeId: string, choice: import('michi-shared').ChatPermissionChoice) => Promise<void>;
  archiveTree: (treeId: string) => void;
  unarchiveTree: (treeId: string) => void;
  pinTree: (treeId: string) => void;
  unpinTree: (treeId: string) => void;
  pinProject: (projectId: string) => void;
  unpinProject: (projectId: string) => void;
  renameTree: (treeId: string, name: string, targetProjectId?: string) => void;
  deleteTree: (treeId: string) => void;
  activateTree: (treeId: string, targetProjectId?: string) => void;
  /** Move a thread (its tree row, nodes, and intra-tree edges) to another
   *  workspace. Atomic on the backend; client state mirrors the same slice.
   *  Streaming threads and same-workspace targets are no-ops. */
  moveTreeToWorkspace: (treeId: string, targetProjectId: string) => Promise<void>;
  createContext: (
    name: string,
    filePath: string,
    opts?: {
      url?: string;
      type?: 'doc' | 'file' | 'image' | 'link';
      source?: 'user' | 'agent';
      size?: number;
      kind?: 'embedded' | 'reference' | 'symlink';
      origin?: { nodeId: string; messageId?: string };
    },
  ) => void;
  updateContext: (
    contextId: string,
    patch: { name?: string; filePath?: string; size?: number },
  ) => void;
  deleteContext: (contextId: string) => void;
  /** Toggle the shelf pin (pinnedAt) for an artifact. UI ordering only. */
  pinContext: (contextId: string) => void;
  /** Approve a pending tool-call permission request. */
  resolvePermission: (nodeId: string, optionId: string) => void;
  /** Deny/cancel a pending tool-call permission request. */
  denyPermission: (nodeId: string) => void;
  /** Submit answers to a pending AskUserQuestion request. */
  resolveUserInputRequest: (nodeId: string, answers: Array<{ question: string; answer: string }>) => void;
  /** Skip/dismiss a pending AskUserQuestion request. */
  skipUserInputRequest: (nodeId: string) => void;
  /** Whether initial data has been loaded from backend/localStorage. */
  hydrated: boolean;
  /** Tree-level multi-select for bulk operations. */
  treeSelection: ReadonlySet<string>;
  toggleTreeSelection: (treeId: string) => void;
  clearTreeSelection: () => void;
  selectAllTrees: () => void;
  bulkArchiveTrees: () => void;
  bulkDeleteTrees: () => void;
  bulkUnarchiveTrees: () => void;
  /** Current search term to highlight in chat messages. Null when inactive. */
  searchHighlightTerm: { term: string; nodeId: string } | null;
  setSearchHighlightTerm: (term: { term: string; nodeId: string } | null) => void;
  /**
   * Queue a reply-to-selection on a node. Persists only in memory and
   * flushes on the next outgoing prompt. `quotedText` is the selected
   * passage, `body` is the user's reply.
   */
  addPendingComment: (nodeId: string, quotedText: string, body: string, source?: import('../lib/quoteSource').QuoteSource, context?: import('./fileFeedbackTypes').FileFeedbackTarget) => boolean;
  /** Update the body text of a pending comment. No-op if the id is unknown. */
  editPendingComment: (nodeId: string, commentId: string, body: string) => void;
  /** Drop one pending comment by id. No-op if the id is unknown. */
  removePendingComment: (nodeId: string, commentId: string) => void;
  /** Drop every pending comment on the node. Called by the composer on send. */
  clearPendingComments: (nodeId: string) => void;
  /** Same-turn native steer. Returns accepted=false when the runtime is invisible. */
  steerMessage: (nodeId: string, text: string, options?: SteerMessageOptions) => Promise<boolean>;
  compactContext: (nodeId: string, instructions?: string) => Promise<{ started: boolean; detail?: string }>;
  /** Push a queued message onto the node (used while streaming). */
  queueMessage: (nodeId: string, message: PendingQueuedMessage) => void;
  /** Remove a queued message by id (used when the user × the pill). */
  dequeueMessage: (nodeId: string, messageId: string) => void;
  /** Clear the queue and the errored flag on a node. */
  flushQueue: (nodeId: string) => void;
  /** Mark the queue paused after a stream error. */
  markQueueErrored: (nodeId: string) => void;
  /** Whether the sidebar is filtered to unread-only. Session-scoped (not persisted). */
  unreadFilterOn: boolean;
  setUnreadFilterOn: (on: boolean) => void;
  /** Mark every unread chat thread as read in one pass (clears the unread
   *  filter list). Digest nodes keep their own read model and are untouched. */
  markAllRead: () => void;
  renameNode: (nodeId: string, title: string) => void;
  /** Toggle the node-level sidebar pin (`pinnedAt`). Ordering only — the
   *  node stays where it is in the conversation graph. */
  pinNode: (nodeId: string) => void;
  unpinNode: (nodeId: string) => void;
}

/** Projects + UI-state slice of the chat store — every field that is NOT
 *  the per-node messages map and NOT a callback. Lives in its own context
 *  so streaming chunks (which only mutate `nodes`) don't re-render
 *  consumers that read project / pane / selection state.
 *
 *  Pane-layout fields (`openPanes`, `paneItems`, `focusedPane`,
 *  `focusNonce`, `viewMode`) live in {@link ChatPaneValue} instead.
 *  Splitting them out prevents every sidebar row from re-rendering on
 *  each pane-focus click. */
export type ChatProjectsValue = Pick<
  ChatContextValue,
  | 'projects'
  | 'activeProjectId'
  | 'activeProject'
  | 'order'
  | 'edges'
  | 'theme'
  | 'availableModes'
  | 'defaultModeId'
  | 'agentModesLoading'
  | 'agentModesError'
  | 'retryAgentModes'
  | 'agentStatus'
  | 'warmFailedError'
  | 'refreshAgentStatus'
  | 'focusedNodeId'
  | 'selection'
  | 'hydrated'
  | 'treeSelection'
  | 'searchHighlightTerm'
  | 'unreadFilterOn'
  | 'canNavBack'
  | 'canNavForward'
>;

/** Pane-layout slice of the chat store. Separated from ChatProjectsValue
 *  because pane focus/open/close changes are high-frequency and only a
 *  handful of components (Dashboard, Topbar, WorkspaceRow, ActivityView)
 *  need them. Sidebar rows that only read project/selection/theme state
 *  no longer re-render on every pane click. */
export type ChatPaneValue = Pick<
  ChatContextValue,
  | 'openPanes'
  | 'paneItems'
  | 'focusedPane'
  | 'focusNonce'
  | 'viewMode'
> & {
  /** Single-page mode's tabs: every pane in the slot except browser items. */
  tabPanes?: string[];
  /** Single-page mode's visible pane ('' otherwise); feeds paneScopeKey. */
  pagePane?: string;
};

/** Callback-only slice for hot chat surfaces. It intentionally excludes the
 *  node map so streamed chunks do not wake every pane through React context. */
export type ChatActionsValue = Pick<
  ChatContextValue,
  | 'createProject'
  | 'enterChatsWorkspace'
  | 'selectProject'
  | 'renameProject'
  | 'archiveProject'
  | 'unarchiveProject'
  | 'deleteProject'
  | 'sendMessage'
  | 'retryLastTurn'
  | 'rerunLastTurn'
  | 'editAndResend'
  | 'createChildChat'
  | 'createBlankChild'
  | 'createMergedChat'
  | 'fanoutBranches'
  | 'switchAgent'
  | 'cancelStream'
  | 'deleteNode'
  | 'trimNode'
  | 'extractNodeTree'
  | 'archiveNode'
  | 'setMinimized'
  | 'setPaneWidth'
  | 'openPane'
  | 'openPaneInTree'
  | 'closePane'
  | 'focusPane'
  | 'toggleSelection'
  | 'clearSelection'
  | 'restoreLastDeletion'
  | 'createThread'
  | 'archiveTree'
  | 'unarchiveTree'
  | 'pinTree'
  | 'unpinTree'
  | 'pinProject'
  | 'unpinProject'
  | 'renameTree'
  | 'deleteTree'
  | 'activateTree'
  | 'moveTreeToWorkspace'
  | 'toggleTreeSelection'
  | 'clearTreeSelection'
  | 'selectAllTrees'
  | 'bulkArchiveTrees'
  | 'bulkDeleteTrees'
  | 'setFocusedNodeId'
  | 'createDigest'
  | 'resolvePermission'
  | 'setChatPermissionMode'
  | 'denyPermission'
  | 'resolveUserInputRequest'
  | 'skipUserInputRequest'
  | 'addPendingComment'
  | 'editPendingComment'
  | 'removePendingComment'
  | 'clearPendingComments'
  | 'steerMessage'
  | 'compactContext'
  | 'queueMessage'
  | 'dequeueMessage'
  | 'setComposerDraft'
  | 'createContext'
  | 'reorderPane'
  | 'openArtifactPane'
  | 'openLauncherPane'
  | 'activateLauncherPane'
  | 'adoptTerminalPane'
  | 'openFilePane'
  | 'openPagePane'
  | 'openDiffPane'
  | 'openTerminalPane'
  | 'openBrowserPane'
  | 'updatePaneItem'
  | 'navBack'
  | 'navForward'
  | 'setUnreadFilterOn'
  | 'markAllRead'
  | 'renameNode'
  | 'pinNode'
  | 'unpinNode'
> & {
  /**
   * Synchronous node-state dispatcher — bypasses async session plumbing
   * (`ensureSession`, `runChatStream`). Used by callers that manage session
   * lifecycle independently and by the structural-channel hook tests.
   */
  dispatch: (a: ChatAction) => void;
};
