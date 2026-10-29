import type { ResultBundleV1 } from 'michi-shared';
import type { McpHttpEndpoint } from '../mcp-host/types';
import type { RuntimeSessionOwner } from './types';
import type { AgentRunToolInvoker, AgentRunToolName, BridgeContextResult } from './tools';

export type { McpHttpEndpoint } from '../mcp-host/types';

// ---------------------------------------------------------------------------
// MCP slot contract
//
// Adapters hand each agent session an HTTP MCP server that routes its tool
// calls back to that session. McpSlotProvider is what they need from the host
// for it: slots, chat session groups and the URLs that go into each CLI's MCP
// config. The CLI-specific entry shapes (Kiro's _meta, Codex's approval mode,
// Claude's alwaysLoad) stay in the adapters.
//
// Members marked "host tool extension" are optional: an adapter sets them so
// the result of one of the host's own tools (spawning branches, artifacts,
// turn metadata, Agent Runs) comes back to its session. A host that does not
// offer that tool ignores the callback and does not register the tool.
// ---------------------------------------------------------------------------

/**
 * A "slot" is a per-session binding that the MCP tool handler uses to route
 * incoming tool calls back to the owning session. The adapter hands the
 * agent a URL like /mcp/<slotId> when it starts the session, so every tool
 * the agent calls on that URL knows which session it belongs to.
 *
 * The runtime package's MCP host (runtime/src/mcp-host) owns slot ids,
 * routing, transport and the HTTP gates; this mutable object is the binding
 * of its slot, so runtimes keep reading and writing these fields directly.
 * McpSlotProvider.rebind writes the rebindable fields on this same object.
 */
export interface McpSlot {
  slotId: string;
  /**
   * Owner of the session this MCP slot serves: interactive for chats,
   * headless for Agent Runs. When absent (legacy callers), the slot is
   * treated as a chat slot with implicit Node ownership — existing callers
   * remain backward compatible.
   */
  owner?: RuntimeSessionOwner;
  /**
   * The host's node id for the owning chat: the durable identity the host
   * derives the workspace from (Michi: its SQLite node row). Warm slots
   * start null and are rebound when handed off to a real node.
   */
  nodeId: string | null;
  /**
   * Runtime session id used for callbacks into the owning agent session.
   * Historical name: this is not always a "parent" node id.
   */
  parentChatId: string;
  cwd: string;
  /**
   * Cached workspace id for compatibility and cold-start races. Tool calls
   * resolve the workspace from nodeId first, then runtime session ids, and
   * only use this cache as a final fallback.
   *
   * For headless owners this is the authoritative Workspace binding
   * supplied at slot creation — no Node lookup is performed.
   */
  workspaceId: string | null;
  /**
   * The host's user id of the chat owner; null where the host has no
   * signed-in users (Michi: on desktop). Tools that read the host's data
   * scope their reads by it (Michi: list_threads, search_messages,
   * read_node), so whoever gains access to one user's agent session cannot
   * read another user's data through it.
   */
  ownerUserId: string | null;
  /**
   * Explicit tool allow-list for this slot. When present, only tools whose
   * name appears in this set are registered on the MCP server. When absent,
   * all tools with matching callbacks are registered (legacy behavior).
   *
   * This is the product-level gate — independent of whether a callback
   * exists. A tool must appear here AND have a callback to be registered.
   */
  exposedToolNames?: ReadonlySet<string>;
  /**
   * Created by a restricted session (RuntimeToolProfile.restricted). A host
   * offers such a slot only the tools a restricted session may call. Michi:
   * the assistant's catalog, which also requires the slot's workspace to be
   * the assistant's; see slotCatalog.
   */
  restricted?: boolean;
  maintenance?: boolean;
  getActivePageTurnAttribution?: () => { turnId: string; assistantId: string } | null;
  getActiveMaintenanceExecutionContext?: () => import('./types').MaintenanceExecutionContext | null;
  /**
   * Whether this slot may run tools right now. Read on every call; while it
   * answers false every tool call is refused (listing still works). A
   * restricted session sets it (Claude: until its init check has passed), so
   * a process that failed its safety check is not served while it is still
   * shutting down.
   */
  isServing?: () => boolean;
  /** Host tool extension: spawn_branches is offered only when it is present. */
  onSpawnBranches?: (
    topics: Array<{ title: string; prompt: string }>,
  ) => Promise<Array<{ title: string; prompt: string; chatId: string }>>;
  /** Host tool extension: save_artifact is offered only when it is present. */
  onSaveArtifact?: (name: string, body: string | undefined, path?: string) => BridgeContextResult | null;
  /** Host tool extension: update_artifact is offered only when it is present. */
  onUpdateArtifact?: (name: string, body: string) => BridgeContextResult | null;
  /** Host tool extension: show_image is offered only when it is present. */
  onShowImage?: (inputPath: string, caption?: string) => { relPath: string; mimeType: string; size: number } | { error: string };
  /** Structured turn metadata callbacks of the host's turn-metadata
   * protocol. Optional so runtimes expose only the metadata tools they can
   * route back into their own event stream. Host tool extension. */
  onSetFollowUps?: (followUps: string[]) => void;
  /** Host tool extension (turn-metadata protocol). */
  onSetBranchOverview?: (overview: string) => void;
  /** Runtime end-of-turn marker emitted after set_branch_overview so an
   * ACP turn can finish with a non-empty model response. Described to the
   * model as a protocol marker (not a directive) to avoid triggering
   * prompt-injection defenses. The owning runtime strips it before
   * exposing assistant text. Host tool extension (turn-metadata protocol). */
  metadataDoneSentinel?: string;
  /**
   * Host tool extension (turn-metadata protocol): validates the turn's
   * metadata for the Stop hook.
   * @experimental Follow-ups Stop-hook POC; outside the v1 compatibility guarantee.
   */
  onValidateFollowUps?: () => Record<string, unknown>;
  /** Host tool extension: ask_user is offered only when it is present. */
  onAskUser?: (questions: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect: boolean;
  }>) => Promise<Record<string, string> | null>;
  /** Optional generic Agent Run tools, bound to the session's active turn;
   * absent, the slot offers none. Host tool extension. */
  agentRuns?: AgentRunToolInvoker;
  agentRunToolNames?: readonly AgentRunToolName[];
  /** Host tool extension: an Agent Run worker's submit_agent_result. */
  onSubmitAgentResult?: (payload: unknown) => ResultBundleV1;
  /**
   * Never on the binding: the session's sink (McpSlotCallbacks.sink) goes
   * only to the slot's tools, so a provider that spreads the callbacks onto
   * the slot has to leave it out.
   */
  sink?: never;
}

/**
 * Where a host's tools report what they did to the owning session: one call
 * per effect, with the host's own event `type` and `payload`. The adapter
 * puts each report on its session's event stream as a host_event, in the
 * order they arrive (a report without a payload gets a null one). An MCP
 * host's session tool sink (the package's SessionToolSink) takes it as is.
 */
export interface McpSlotEventSink {
  emit(event: { type: string; payload?: unknown }): void;
}

/**
 * What McpSlotProvider.create copies onto a new slot, all but `sink`. See
 * McpSlot for each member, including which are host tool extensions.
 */
export interface McpSlotCallbacks {
  /** Product owner identity. See McpSlot.owner. */
  owner?: RuntimeSessionOwner;
  /** Explicit tool allow-list. See McpSlot.exposedToolNames. */
  exposedToolNames?: ReadonlySet<string>;
  /** See McpSlot.restricted. */
  restricted?: boolean;
  maintenance?: boolean;
  getActivePageTurnAttribution?: () => { turnId: string; assistantId: string } | null;
  getActiveMaintenanceExecutionContext?: () => import('./types').MaintenanceExecutionContext | null;
  /** See McpSlot.isServing. */
  isServing?: McpSlot['isServing'];
  /**
   * Host tool extension: where the host's tools report their effect on this
   * session (Michi: spawned branches, saved and updated artifacts, shown
   * images). A tool reports once its callback has succeeded, before it
   * answers the agent. Not copied onto the slot: only the host's tools see
   * it. Absent, the reports are dropped.
   */
  sink?: McpSlotEventSink;
  onSpawnBranches?: McpSlot['onSpawnBranches'];
  onSaveArtifact?: McpSlot['onSaveArtifact'];
  onUpdateArtifact?: McpSlot['onUpdateArtifact'];
  onShowImage?: McpSlot['onShowImage'];
  onSetFollowUps?: McpSlot['onSetFollowUps'];
  onSetBranchOverview?: McpSlot['onSetBranchOverview'];
  metadataDoneSentinel?: McpSlot['metadataDoneSentinel'];
  /** @experimental See McpSlot.onValidateFollowUps. */
  onValidateFollowUps?: McpSlot['onValidateFollowUps'];
  onAskUser?: McpSlot['onAskUser'];
  agentRuns?: AgentRunToolInvoker;
  agentRunToolNames?: readonly AgentRunToolName[];
  onSubmitAgentResult?: McpSlot['onSubmitAgentResult'];
}

/** Slot fields McpSlotProvider.rebind may change after creation. */
export type McpSlotRebindPatch = Partial<Pick<McpSlot,
  | 'owner'
  | 'exposedToolNames'
  | 'parentChatId'
  | 'nodeId'
  | 'workspaceId'
  | 'ownerUserId'
  | 'agentRuns'
  | 'agentRunToolNames'
  | 'onSubmitAgentResult'
>>;

/**
 * The host's MCP slots as adapters use them. createMcpSlotProvider
 * (`./mcp-host`) implements it on the package's MCP host.
 */
export interface McpSlotProvider {
  /**
   * Creates a slot for a session and returns its binding: the live object
   * every tool call on the slot reads, so a later rebind is seen by the next
   * call. `cbs.sink` goes to the slot's tools, not onto the binding.
   * `opts.nodeId` and `opts.workspaceId` default to null.
   */
  create(
    parentChatId: string,
    cwd: string,
    ownerUserId: string | null,
    cbs: McpSlotCallbacks,
    opts?: { nodeId?: string | null; workspaceId?: string | null },
  ): McpSlot;
  /** The live binding of a slot; undefined for an unknown or disposed slot. */
  get(slotId: string): McpSlot | undefined;
  /**
   * Drops the slot at once: its URL answers 404, its in-flight calls are
   * aborted and it is unbound from every session group. No-op for an
   * unknown or disposed slot.
   */
  dispose(slotId: string): Promise<void>;

  /**
   * Chat session group: one stable catalog and URL for many native sessions.
   * Serves a copy of `catalog`; each call names its session in `session_id`
   * and runs with the slot bound to it. Returns the group id.
   */
  createSessionGroup(catalog: McpSlot): string;
  /**
   * Routes the group's calls for native session `sessionId` to `slotId` and
   * closes that session's turn window. Throws unless the slot is live, is not
   * an Agent Run slot, has a nodeId and has `parentChatId === sessionId`.
   */
  bindSession(groupId: string, sessionId: string, slotId: string): void;
  /** Opens a bound session's turn window; the returned function closes it. Throws when the session is not bound. */
  beginSessionTurn(groupId: string, sessionId: string, attribution?: McpSlot['getActivePageTurnAttribution']): () => void;
  /** Closes the session's turn window. No-op when it is not open. */
  endSessionTurn(groupId: string, sessionId: string): void;
  /** Disposes the group and its catalog copy. No-op for an unknown group. */
  disposeSessionGroup(groupId: string): void;

  /**
   * The slot's HTTP MCP server for the agent's MCP config. The URL shape is
   * an external contract: the agent CLIs receive it as is, and Crew's relay
   * accepts only `http://127.0.0.1:<port>/api/mcp/<slotId>` with empty
   * headers. Computed from the id alone, as the adapters' URLs always were:
   * an unknown or disposed slot's URL answers 404.
   */
  endpoint(slotId: string): McpHttpEndpoint;
  /** The session group's HTTP MCP server (`.../mcp-session/<groupId>`). Computed from the id alone, like endpoint(). */
  sessionEndpoint(groupId: string): McpHttpEndpoint;
  /**
   * URL the agent's `hook` hook posts to (Codex's Stop hook). Computed from
   * the id alone. Through the package's MCP host (`/mcp-hooks/<slotId>/<hook>`)
   * an unknown or disposed slot answers 404; the bundled Stop-hook runner
   * fails open on any non-2xx answer, so the turn ends unrepaired either way.
   * A host may serve its own route instead and answer such a slot with `{}`
   * (Michi does, at `.../codex-hooks/<slotId>/stop`).
   * @experimental Follow-ups Stop-hook POC; outside the v1 compatibility guarantee.
   */
  hookEndpoint(slotId: string, hook: 'stop'): string;
  /**
   * Assigns the patch's fields on the slot's binding, the same object get()
   * returns, so tool calls see them from the next call on. Absent keys are
   * left alone. An undefined value clears an optional field (owner,
   * exposedToolNames, agentRuns, agentRunToolNames, onSubmitAgentResult) and
   * is ignored for the fields McpSlot requires (parentChatId, nodeId,
   * workspaceId, ownerUserId; null clears the last three). No-op for an
   * unknown or disposed slot, as get() returns undefined for it.
   */
  rebind(slotId: string, patch: McpSlotRebindPatch): void;
}
