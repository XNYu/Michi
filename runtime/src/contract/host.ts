import type {
  AgentSessionState,
  ChatPermissionMode,
  CrewMemoryMode,
  SubagentEnd,
  UserInputQuestion,
  WorkflowAction,
  WorkflowApprovalDto,
  WorkflowRunDtoV1,
  WorkflowRunStatus,
  WorkflowRuntime,
} from 'michi-shared';
import type { NormalizedEvent } from './events';
import type {
  AgentReasoning,
  AgentSession,
  BranchContext,
  CancelAck,
  ExtraContext,
  RuntimeSessionOwner,
  RuntimeToolProfile,
} from './types';

// ---------------------------------------------------------------------------
// Host ports
//
// Everything an adapter needs from the application that embeds it reaches it
// through one RuntimeHost. Each port method stands for one app function the
// adapters call today and keeps its arguments, return value and throw
// behavior, so an adapter call site switches to the port without changing
// meaning. createDefaultHost (core/defaultHost) implements every port in
// memory; Michi implements them over its own modules.
// ---------------------------------------------------------------------------

// Owner identity lives with the owner type; re-exported for the adapters that read it here.
export { ownerMode, type RuntimeOwnerMode } from './types';

// The wire types the ports below take and return, which a host names when it implements them.
export type {
  ChatPermissionMode, CrewMemoryMode, SubagentEnd, WorkflowAction, WorkflowApprovalDto, WorkflowApprovalOption,
  WorkflowLogEntry, WorkflowNodeDto, WorkflowNodeKind, WorkflowNodeStatus, WorkflowRunDtoV1, WorkflowRunStatus,
  WorkflowRuntime, WorkflowUsage,
} from 'michi-shared';

// ---- Config ----------------------------------------------------------------

export interface DefaultModelChangedEvent {
  runtime: string;
  model: string;
}

export interface TitleModelConfig {
  /**
   * Model id for the cheap one-shot title prompt. Null means no title model:
   * Kiro then generates no sidecar titles, while Codex runs its title thread
   * on the session's own model. TitlePolicy.enabled turns titles off.
   */
  model: string | null;
  timeoutMs: number;
}

export interface RuntimeConfigPort {
  /** The user's model for a runtime, or `''` when neither the user nor the host chose one. */
  defaultModel(runtimeId: string, userId?: string | null): string;
  defaultReasoning(runtimeId: string, userId?: string | null): AgentReasoning | undefined;
  /** Model and deadline for sidecar thread titles (product choice; see TitlePolicy). */
  titleModel(runtimeId: string): TitleModelConfig;
  /**
   * Called synchronously whenever the default model of a runtime changes.
   * Listeners must move heavy work off the call. Returns the unsubscribe.
   */
  onDefaultModelChanged(listener: (event: DefaultModelChangedEvent) => void): () => void;
  /** Per-user runtime feature flags. */
  features: {
    workflows(runtimeId: string, userId?: string | null): boolean;
  };
  /** Base directory for runtime-owned files. Callers create their subdirectories. */
  dataDir(): string;
}

// ---- Prompts ---------------------------------------------------------------

/** How a turn reports follow-ups and the branch overview. */
export type MetadataOutputMode =
  | 'sentinel'
  | 'sentinel-followups-tool-overview'
  | 'structured-tool';

/**
 * Which follow-up protocol the native runtimes run. The `'hook-tool'` value
 * belongs to the follow-ups Stop-hook POC: experimental, outside the v1
 * compatibility guarantee.
 */
export type FollowUpsExperimentMode = 'sentinel' | 'hook-tool';

export interface FirstTurnPrefixInput {
  cwd: string;
  /** Additional registered folders of the workspace. */
  folders?: Array<{ path: string; label?: string }>;
  contextManifest?: ExtraContext[];
  extraContexts?: ExtraContext[];
  /** Oldest-first ancestor chain; each entry contributes its history and pending answer. */
  ancestors?: AgentSession[];
  mergeContexts?: string[];
  workspaceInstructions?: string | null;
}

export interface PreambleInput extends FirstTurnPrefixInput {
  toolProfile?: RuntimeToolProfile;
  enableFollowUps: boolean;
}

export interface TurnMetadataValidation {
  status: 'inactive' | 'complete' | 'repair' | 'fail_open';
  missingTools: string[];
  /** Stop-hook response: empty unless the turn must be repaired. */
  response: Record<string, unknown>;
}

/**
 * Per-session tracker of the host's turn-metadata protocol (follow-ups and
 * branch overview reported through host tools or sentinels). Stateful across
 * one turn, so the port hands out an object rather than answering per call.
 * A host without the protocol returns an inert tracker.
 */
export interface TurnMetadataTracker {
  readonly validationActive: boolean;
  acceptsFollowUps(enabled: boolean): boolean;
  begin(): void;
  setFollowUps(values: readonly string[], enabled: boolean): string[] | null;
  setOverview(value: string): { overview: string; beforeSentinelsComplete: boolean } | null;
  validate(enableFollowUps: boolean): TurnMetadataValidation;
  observeChunk(text: string, enableFollowUps: boolean): void;
  suppressOutput(kind: string): boolean;
  completeOutputBoundary(): boolean;
  finish(): { chunks: number; thoughts: number };
}

export interface TurnSuffixInput {
  /**
   * How the session reports turn metadata: through the host's metadata tools
   * ('tools', Kiro), or as lines of its answer ('inline', Kiro Crew, whose
   * agents need no tools for it).
   */
  metadataChannel: 'tools' | 'inline';
  /** User turns in the session's history, this one included. */
  userTurnCount: number;
  enableFollowUps: boolean;
  owner?: RuntimeSessionOwner;
}

/**
 * Prompt text the host adds to sessions. A host with no prompts returns empty
 * values. The port also renders what callers pass in for the first turn
 * (FirstTurnPrefixInput: contextManifest, extraContexts, ancestors,
 * mergeContexts, workspaceInstructions) and the inherited BranchContext
 * transcript: an implementation that returns '' or null drops that context,
 * as createDefaultHost's does (with a warning).
 */
export interface PromptPolicyPort {
  /** Variable per-chat prefix for the first user message. */
  firstTurnPrefix(input: FirstTurnPrefixInput): string;
  /** Whole first-message preamble for runtimes without a system-prompt slot. */
  preamble(input: PreambleInput): string;
  /**
   * Stable system prompt. Must be pure for its arguments: warm-pool entries
   * share byte-identical spawn args. `restricted` selects the tool notes of
   * a restricted session; adapters pass SessionProfilePort.isRestricted.
   */
  stableSystemPrompt(
    metadataOutputMode?: MetadataOutputMode,
    enableFollowUps?: boolean,
    nativeAskUser?: boolean,
    restricted?: boolean,
    profile?: RuntimeToolProfile,
  ): string;
  /**
   * Text a session that reports turn metadata through the host's tools or
   * inline appends to each user turn it sends (the ACP adapters: Kiro,
   * Crew); history keeps the turn without it. Part of the host's optional
   * turn-metadata protocol: a host without one returns ''.
   */
  turnSuffix(input: TurnSuffixInput): string;
  followUpsExperimentMode(): FollowUpsExperimentMode;
  /**
   * The `hookPocEnabled` argument belongs to the follow-ups Stop-hook POC:
   * experimental, outside the v1 compatibility guarantee.
   */
  followUpsMetadataOutputMode(hookPocEnabled: boolean, mode: FollowUpsExperimentMode): MetadataOutputMode;
  /**
   * The `hookPocEnabled` argument belongs to the follow-ups Stop-hook POC:
   * experimental, outside the v1 compatibility guarantee.
   */
  followUpsTurnReminder(
    userTurnCount: number,
    hookPocEnabled: boolean,
    mode: FollowUpsExperimentMode,
    enableFollowUps?: boolean,
  ): string;
  /**
   * Text that ends a turn whose session shares one MCP endpoint with others
   * and names itself in every call (descriptor tool delivery
   * 'mcp-http-grouped'; Kiro v3 session anchors): the native session id to
   * pass. Absent: none.
   */
  mcpSessionReminder?(nativeSessionId: string): string;
  /**
   * A tool result as the session shows it, where the host's tool result
   * carries text for the agent that the user's tool chip leaves out (Michi:
   * its metadata tool tells a Kiro agent how to end its reply). Absent:
   * shown as received.
   */
  toolResultForDisplay?(output: string): string;
  /** One preamble block for an inherited branch transcript; null when there is nothing to show. */
  renderBranchContext(context: BranchContext, parentTitle?: string | null): string | null;
  /** The workspace's own instructions, or null. */
  workspaceInstructions(workspaceId: string): string | null;
  turnMetadata(mode: FollowUpsExperimentMode): TurnMetadataTracker;
}

// ---- Session profile ---------------------------------------------------------

/**
 * The host's restricted session profile: a session under it may call only the
 * host's own tools (no native file edits, shell or network), whatever its
 * permission mode. The host says which sessions are restricted; each adapter
 * enforces it on its own runtime (Claude: claudeRestrictedProfile.ts, Codex:
 * codexRestrictedProfile.ts) or refuses the session (unsupportedError).
 */
export interface SessionProfilePort {
  /** Optional embedding-host restrictions and catalog validation. */
  isMaintenance?(profile: RuntimeToolProfile | null | undefined): boolean;
  toolset?(profile: RuntimeToolProfile | null | undefined): string | null;
  maintenancePromptPrefix?(context: import('./types').MaintenanceTurnContext | null | undefined): string;
  assertToolCatalog?(input: { runtimeId: string; profile: RuntimeToolProfile | null | undefined; observed: readonly string[]; extraAllowed?: readonly string[] }): void;
  catalogUnavailable?(runtimeId: string, toolset: string, detail: string): Error;
  isGuardError?(error: unknown): boolean;
  guardError?(violation: { runtimeId: string; toolset: string; unexpectedTools: string[]; detail?: string }): Error;
  /** Must honor the contract's restricted flag (RuntimeToolProfile.restricted); a host may restrict more. */
  isRestricted(toolProfile: RuntimeToolProfile | null | undefined): boolean;
  /**
   * A workspace whose sessions run restricted; its native history never forks out.
   * A host that runs restricted sessions must report their workspaces here:
   * otherwise a native fork can carry a restricted parent's history into an
   * unrestricted child.
   */
  isRestrictedWorkspace(workspaceId: string | null | undefined): boolean;
  /** Joins the host's context prefix and the session's bootstrap in the profile's order. */
  composeFirstTurnPrefix(
    contextPrefix: string,
    bootstrap: string | undefined,
    toolProfile: RuntimeToolProfile | null | undefined,
  ): string;
  /** Error a runtime throws when it cannot enforce a restricted profile. */
  unsupportedError(runtimeId: string, profile?: RuntimeToolProfile | null): Error;
}

/** Default SessionProfilePort.unsupportedError for hosts without their own error type. */
export class SessionProfileUnsupportedError extends Error {
  constructor(readonly runtimeId: string) {
    super(`The ${runtimeId} runtime cannot enforce a restricted session profile.`);
    this.name = 'SessionProfileUnsupportedError';
  }
}

// ---- Native bindings ---------------------------------------------------------

/**
 * The node fields adapters read; a host's rows may carry more. Field names
 * are those of the host's stored session binding. Adapters compare `kind`
 * with `'chat'` (an interactive chat node) and read `status`, the native
 * session id columns, `runtime_engine` and `crew_memory_mode`. Part of the
 * frozen v1 contract: a host that stores bindings another way maps them
 * onto these fields.
 */
export interface HostNodeRecord {
  id: string;
  workspace_id: string;
  tree_id?: string | null;
  parent_node_id?: string | null;
  kind: string;
  status: string;
  runtime_id?: string | null;
  runtime_engine?: string | null;
  acp_session_id?: string | null;
  external_session_id?: string | null;
  crew_memory_mode?: string | null;
  deleted_at?: number | null;
  purged_at?: number | null;
}

/** The workspace fields adapters read: its folder, owner and lifecycle stamps. */
export interface HostWorkspaceRecord {
  id: string;
  cwd?: string | null;
  owner_user_id?: string | null;
  deleted_at?: number | null;
  archived_at?: number | null;
}

/**
 * A graph edge between two nodes. Adapters read only a `'branch'` edge's
 * `anchor_message_id`, to find where a native fork starts.
 */
export interface HostEdgeRecord {
  id: string;
  workspace_id: string;
  source_node_id: string;
  target_node_id: string;
  kind: string;
  anchor_message_id?: string | null;
}

export interface KiroForkAnchor {
  logIndex?: number;
  messageId?: string;
}

export interface SaveKiroForkAnchorInput {
  nodeId: string;
  nativeSessionId: string;
  engine: string;
  assistantMessageId: string;
  userMessageId?: string;
  anchor: KiroForkAnchor;
}

export interface SaveClaudeForkAnchorInput {
  nodeId: string;
  nativeSessionId: string;
  assistantMessageId: string;
  nativeMessageId: string;
  userMessageId?: string;
  /** The UUID of the SDK's original user envelope, never a tool result. */
  nativeUserMessageId?: string;
}

export interface ReadClaudeForkAnchorInput {
  nodeId: string;
  nativeSessionId: string;
  messageId: string;
  workspaceId?: string | null;
  ownerUserId?: string | null;
}

/** Native fork points recorded per message, owned by the host's store. */
export interface ForkAnchorStore {
  saveKiroForkAnchor(input: SaveKiroForkAnchorInput): void;
  readKiroForkAnchor(nodeId: string, nativeSessionId: string, engine: string, messageId: string): KiroForkAnchor | null;
  saveClaudeForkAnchor(input: SaveClaudeForkAnchorInput): void;
  /** The native message id, or null when the anchor is missing or the node is no longer the caller's. */
  readClaudeForkAnchor(input: ReadClaudeForkAnchorInput): string | null;
}

export interface CrewMemoryStore {
  /** The user's default Crew memory mode. */
  defaultMode(userId?: string | null): CrewMemoryMode;
  /** Pins a chat's mode. Called only after the node's owner was verified. */
  pin(nodeId: string, mode: CrewMemoryMode): void;
}

/**
 * Durable native-session bindings and the host rows adapters consult, keyed
 * by the host's node id, which is the key of the session's interactive owner.
 */
export interface NativeBindingPort {
  nodeBinding(nodeId: string): HostNodeRecord | null;
  workspace(workspaceId: string): HostWorkspaceRecord | null;
  edges(workspaceId: string): HostEdgeRecord[];
  /**
   * Durably binds an interactive owner's session to its native session id.
   * Synchronous; a throw means the binding was not stored, and the adapter
   * must fail closed (stop before forwarding the session's events) rather
   * than continue unbound. A headless owner has no durable binding: the host
   * throws for one. The Claude adapter calls it for its sessions; Kiro, Crew
   * and Codex do not, so the host records their nativeSessionId itself.
   */
  recordNativeSessionId(owner: RuntimeSessionOwner, nativeSessionId: string): void;
  forkAnchors: ForkAnchorStore;
  /** Required by the Crew flavor; see assertHostPorts('bindings.crewMemory'). */
  crewMemory?: CrewMemoryStore;
}

// ---- Sessions ------------------------------------------------------------------

/**
 * The host's directory of live sessions, keyed by session id. Adapters
 * register the sessions they open, drop the ones they close, find a session
 * by id, and read a new chat's ancestors for its first-turn preamble. A host
 * whose other code looks sessions up (routes, turn owners) backs this port
 * with the same directory, so both see one set of sessions.
 *
 * The methods keep the signatures of Michi's agents/sessionRegistry
 * accessors, which Michi's host delegates to.
 */
export interface SessionRegistryPort {
  /**
   * Makes the parent chain of `chatId` readable through getSession and
   * getAncestors, adding ancestors that are no longer live from the host's
   * history where it keeps one (Michi: read-only history stubs from SQLite).
   * Already-known sessions are kept; safe to call repeatedly. Adapters call
   * it right before getAncestors.
   */
  ensureAncestorChainLoaded(chatId: string): void;
  /** Trusted lookup by session id, without an ownership check. */
  getSession(chatId: string): AgentSession | undefined;
  /**
   * The parentChatId chain above `chatId`, oldest first, ending with its
   * immediate parent. Stops at the first ancestor the directory does not
   * hold and at a cycle.
   */
  getAncestors(chatId: string): AgentSession[];
  /**
   * Registers a live session, replacing any entry with its id. Without an
   * owner the directory uses the session's own, else the interactive owner of its id.
   */
  registerSession(session: AgentSession, ownerUserId?: string | null, owner?: RuntimeSessionOwner): void;
  dropSession(chatId: string): void;
}

// ---- Permissions -------------------------------------------------------------

export type HostPermissionDecision = 'allow' | 'ask' | 'deny';

export interface PermissionDecisionRequest {
  owner: RuntimeSessionOwner;
  ownerUserId: string | null;
  toolName: string;
  /** A runtime's own approval request rather than a pre-execution check. Default false. */
  nativeRequest?: boolean;
  /** The mode already resolved for this turn; resolved from `mode()` when absent. */
  mode?: ChatPermissionMode;
}

/** The host's chat permission policy: modes, always-allow grants and their revocation. */
export interface PermissionPolicyPort {
  mode(owner: RuntimeSessionOwner | undefined, ownerUserId?: string | null): ChatPermissionMode;
  /** The user whose grants apply: `ownerUserId`, or the host's owner of the chat when absent. */
  resolveOwnerUserId(owner: RuntimeSessionOwner, ownerUserId?: string | null): string | null | undefined;
  decide(request: PermissionDecisionRequest): HostPermissionDecision;
  grant(request: { owner: RuntimeSessionOwner; ownerUserId?: string | null; toolName: string }): void;
  /** Changes on explicit permission updates, revoking temporary session trust. */
  resetToken?(owner: RuntimeSessionOwner, ownerUserId?: string | null): string | undefined;
  /**
   * The key grant() stores a tool name's always-allow grant under. Adapters
   * compare tool names in this form when one answer may also cover another
   * pending request (ApprovalCoordinator's canonicalize). Absent: the name
   * itself.
   */
  grantKey?(toolName: string): string;
}

// ---- Principal -----------------------------------------------------------------

/** Maps session owner users onto the host's principals. The package has no default principal. */
export interface PrincipalResolver {
  /** `ownerUserId`, or the host's local principal when there is none. */
  resolve(ownerUserId: string | null | undefined): string;
  /** Whether a stored workspace owner admits `principal`. */
  workspaceOwnerMatches(storedOwnerUserId: string | null, principal: string): boolean;
  /**
   * Whether every session belongs to one authenticated user (Michi: cloud
   * mode). When true, a session without an owner user has nobody to show
   * background work or workflows to, Claude keeps history per user and does
   * not fork it natively, and Kiro does not share one MCP catalog across
   * chats. Read on every call. Same name and shape as the session
   * directory's `enforceUserOwnership` option.
   */
  enforceUserOwnership(): boolean;
}

// ---- Observability -----------------------------------------------------------

export type RuntimeLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RuntimePerf {
  /** Millisecond timestamp for `measure`. Works whether or not perf output is on. */
  now(): number;
  mark(stage: string, meta?: Record<string, unknown>): void;
  measure(stage: string, startTime: number, meta?: Record<string, unknown>): void;
}

export interface RuntimeObservability {
  log(level: RuntimeLogLevel, scope: string, msg: string, data?: Record<string, unknown>): void;
  perf: RuntimePerf;
  startupMark?(name: string, extra?: Record<string, unknown>): void;
  /** Raw stream probe. Callers skip building rows unless `enabled()`. */
  streamProbe?: {
    enabled(): boolean;
    write(row: Record<string, unknown>): void;
  };
  /** Raw stderr of a runtime's child process, unparsed. */
  childStderr?(runtimeId: string, chunk: string): void;
}

// ---- Background turns ----------------------------------------------------------

export interface BackgroundTurn {
  chatId: string;
  /** The interactive owner of the session whose turn it is; the host maps it to its chat. */
  owner: RuntimeSessionOwner;
  ownerUserId?: string | null;
  events: AsyncIterableIterator<NormalizedEvent>;
  /** Stops the runtime's own turn when nobody can see or answer it. */
  cancel?: () => Promise<CancelAck | void> | CancelAck | void;
  /** The live session, so a user's Stop also interrupts the native work. */
  session?: AgentSession;
}

/**
 * The host's owner of chat turns, for turns a runtime starts on its own (a
 * background task finishing while the chat is idle).
 *
 * Contract: `consume` must drain `events` to the end or cancel the turn and
 * then drain it. The runtime's idle pump holds the session's turn mutex until
 * the iterator finishes, so an abandoned iterator makes every later send fail
 * as busy. A consumer that cannot begin the turn (its chat is gone, or its
 * owner is not interactive) calls `cancel` when present, then drains and
 * discards the events. Adapters wait
 * for consumed turns to end before their shutdown completes.
 *
 * Required on RuntimeHost; the adapters that depend on it still assert it at
 * construction (assertHostPorts(host, ['backgroundTurns'], …)) for untyped hosts:
 * - Claude: idle self-turns (ClaudeRuntime onSelfTurn) and the native fork
 *   guard, which must not fork a chat whose turn is active; without the
 *   queries the guard would pass every fork (fail open).
 * - Kiro and Crew: agent turns Kiro V3 starts when a workflow finishes.
 * The three queries ask whether any turn of a chat is active, not only a
 * background one; their names follow Michi's chat hub.
 */
export interface BackgroundTurnConsumer {
  consume(turn: BackgroundTurn): void;
  /** A foreground turn of the chat is active. */
  isActive(chatId: string): boolean;
  /** The chat's session owns a running turn. */
  isOwnerTurnActive(chatId: string): boolean;
  /** A self-started turn of the chat is queued or running. */
  hasPendingSelfTurn(chatId: string): boolean;
}

// ---- Workflow runs -------------------------------------------------------------

export interface WorkflowRunContext {
  ownerUserId: string;
  /** Null when the session has not learned its workspace; the host's for the owner is used. */
  workspaceId: string | null;
  /** The owner of the session driving the run; the host maps it to where the run is shown. */
  owner: RuntimeSessionOwner;
}

export type WorkflowControl = () => Promise<void>;
export type WorkflowControls = Partial<Record<WorkflowAction, WorkflowControl>>;
/** Called once per approval: the chosen option, or null when it lapsed. */
export type WorkflowApprovalResolver = (optionId: string | null, endedAs?: WorkflowRunStatus) => void;

/** Where adapters fold native workflow events and register a run's controls and approvals. */
export interface WorkflowRunSink {
  /** Create or update a run; `mutate` returning its input means no change. Null when the run cannot be tracked. */
  update(
    context: WorkflowRunContext,
    runtime: WorkflowRuntime,
    nativeId: string,
    mutate: (run: WorkflowRunDtoV1) => WorkflowRunDtoV1,
  ): WorkflowRunDtoV1 | null;
  /** Update a run already live in this process, by native id. */
  updateKnown(runtime: WorkflowRuntime, nativeId: string, mutate: (run: WorkflowRunDtoV1) => WorkflowRunDtoV1): WorkflowRunDtoV1 | null;
  /** Controls the driving adapter accepts; replaces earlier ones. */
  registerControls(ownerUserId: string, runtime: WorkflowRuntime, nativeId: string, controls: WorkflowControls): void;
  /** False (nothing resolved) when the run is not live or open, so the caller falls back. */
  requestApproval(
    ownerUserId: string,
    runtime: WorkflowRuntime,
    nativeId: string,
    approval: Omit<WorkflowApprovalDto, 'requestedAt'>,
    resolve: WorkflowApprovalResolver,
  ): boolean;
  withdrawApproval(ownerUserId: string, runtime: WorkflowRuntime, nativeId: string, approvalId: string): void;
  /** The driving runtime went away; a reason cancels the run if it is still open. */
  releaseControls(ownerUserId: string, runtime: WorkflowRuntime, nativeId: string, reason?: string): void;
}

// ---- Background subagents ------------------------------------------------------

export interface BackgroundSubagentContext {
  ownerUserId: string;
  /** Null when the session has not learned its workspace; the host's for the owner is used. */
  workspaceId: string | null;
  /** The interactive owner of the reporting session; the host maps it to its chat. */
  owner: RuntimeSessionOwner;
}

/** Background subagents a live session still tracks, reported per session source. */
export interface BackgroundSubagentSink {
  /** The source's background subagents for the owner now; an empty list withdraws them. */
  report(context: BackgroundSubagentContext, source: string, sessionIds: readonly string[]): void;
  /** The source's process ended with these still tracked: withdraw them and record how each ended. */
  end(context: BackgroundSubagentContext, source: string, ends: readonly SubagentEnd[]): void;
}

// ---- Titles --------------------------------------------------------------------

/**
 * Product half of thread titles a runtime generates beside the main turn
 * (Kiro's sidecar prompt, Codex's title thread): whether to generate them and
 * the instruction text. The model and its deadline come from
 * RuntimeConfigPort.titleModel. Racing the deadline and cleaning the model's
 * output are runtime mechanism and stay in the package.
 */
export interface TitlePolicy {
  /** Whether the runtime generates titles at all; false leaves titling to the host. */
  enabled(runtimeId: string): boolean;
  /** The one-shot prompt a sidecar title model gets (Kiro): the instructions with the user's message. */
  prompt(userText: string, contextText?: string): string;
}

// ---- Interaction ---------------------------------------------------------------

export interface InteractionRequest {
  owner: RuntimeSessionOwner;
  ownerUserId: string | null;
  questions: readonly UserInputQuestion[];
}

/**
 * Answers structured questions (`ask_user`, native question tools and MCP
 * elicitations) for hosts that have no interactive event stream. Every
 * session today surfaces `user_input_request` on its events and waits for
 * AgentSession.respondToUserInput / skipUserInput instead.
 *
 * @experimental No adapter calls it, and a host that provides it is never
 * asked. Outside the v1 compatibility guarantee: its shape may change when
 * an adapter starts calling it.
 */
export interface InteractionBroker {
  /** Answers keyed by question, or null when skipped. */
  askUser(request: InteractionRequest, signal?: AbortSignal): Promise<Record<string, string> | null>;
}

// ---- Host ------------------------------------------------------------------------

export interface RuntimeHost {
  config: RuntimeConfigPort;
  prompt: PromptPolicyPort;
  profile: SessionProfilePort;
  bindings: NativeBindingPort;
  sessions: SessionRegistryPort;
  permissions: PermissionPolicyPort;
  principal: PrincipalResolver;
  observability: RuntimeObservability;
  title: TitlePolicy;
  /** Asserted by Claude, Kiro and Crew; see BackgroundTurnConsumer. */
  backgroundTurns: BackgroundTurnConsumer;
  /** Asserted by Claude (workflow tap) and Kiro V3 (workflow bridge). */
  workflows: WorkflowRunSink;
  /** Asserted by Claude and Codex, which report background subagents. */
  backgroundSubagents: BackgroundSubagentSink;
  /**
   * @experimental No adapter calls it; its shape may change when one does.
   * Outside the v1 compatibility guarantee.
   */
  interaction?: InteractionBroker;
  /**
   * A live session's state (mode, model, options) changed; persist it. The
   * session directory reports these: createDefaultHost's sessions port, and
   * the directory createRuntimeManager({ host }) builds for a host with its
   * own sessions port, call it and log through observability.log. A host
   * that keeps no session state may leave it out. Michi's registry persists
   * through its own state feed.
   */
  onSessionStateChanged?(session: AgentSession, ownerUserId: string | null, state: AgentSessionState): void;
}

/** A RuntimeHost member, or `bindings.crewMemory`. */
export type RuntimePortName = keyof RuntimeHost | 'bindings.crewMemory';

/** A host lacks ports an adapter requires. Lists every missing port at once. */
export class RuntimeHostConfigError extends Error {
  constructor(readonly who: string, readonly missing: readonly RuntimePortName[]) {
    super(`${who} requires host ports that are missing: ${missing.join(', ')}`);
    this.name = 'RuntimeHostConfigError';
  }
}
