import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Public types of the generic MCP host. A host (any server-side Node process)
 * registers its own tools once, creates one slot per agent session, and hands
 * the slot's endpoint to the external agent process (Kiro, Crew, Codex,
 * Claude) as an HTTP MCP server. The package ships no product tools.
 */

export type McpHostLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Log callback. Slot and group ids reach it only redacted (first 4 hex chars + `…`). */
export type McpHostLog = (level: McpHostLogLevel, msg: string, data?: Record<string, unknown>) => void;

export interface McpHostOptions {
  /** Route prefix. Default `/mcp`, giving `/mcp/<slotId>`, `/mcp-session/<groupId>`, `/mcp-hooks/<slotId>/<name>`. */
  basePath?: string;
  /** MCP server name reported to clients. Default `host`. */
  serverName?: string;
  /** MCP server version reported to clients (initialize serverInfo.version). Default `0.0.0`. */
  serverVersion?: string;
  log?: McpHostLog;
  /**
   * Externally visible base URL used by `endpoint()` (and slotEndpoint(),
   * sessionGroupEndpoint(), hookUrl()) when the host mounts `handler()` on
   * its own server instead of calling `listen()`. May include a path prefix
   * that the host's router strips before calling `handler()` (for example
   * `http://127.0.0.1:3000/api` with routes matched on `/mcp/...`). A
   * function is read on every URL built, so a host can supply the URL
   * after its own server has bound a port. When set it takes precedence over
   * the URL of `listen()`.
   */
  publicBaseUrl?: string | (() => string | undefined);
  /**
   * Request body limit in bytes. Default 4 MB. Bodies over it get 413; with a
   * body pre-parsed by the host only its Content-Length can be checked.
   */
  maxBodyBytes?: number;
  /**
   * What a tool source that throws, or returns no array, does to the slot's
   * catalog. `fail` (default): tools/list answers HTTP 500 with a JSON-RPC
   * error and tools/call an isError result "tool catalog unavailable", so an
   * agent never takes a broken catalog for an empty one. The HTTP 500 holds
   * for a single tools/list request only: inside a JSON-RPC batch the
   * response is HTTP 200 carrying that JSON-RPC error. `skip`: that source
   * contributes no tools and the rest of the catalog is served. Either way the
   * failure is logged as a warning. Invalid entries are always skipped.
   */
  sourceErrors?: ToolSourceErrorMode;
}

export type ToolSourceErrorMode = 'fail' | 'skip';

export type JsonSchemaObject = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
};

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolCallContext<B> {
  /** Snapshot of the slot taken when the call started. */
  slot: SlotView<B>;
  sink: SessionToolSink;
  /** Aborted when the client cancels or disconnects, the slot is disposed, or the host closes. */
  signal: AbortSignal;
  /** The agent's tool-use id when the client sends one (Claude Code: `_meta["claudecode/toolUseId"]`). */
  toolCallId?: string;
}

export interface HostToolDef<B> {
  /** `[A-Za-z0-9_-]{1,64}`: the strictest name rule among the supported agents. */
  name: string;
  description: string;
  /** Sent to clients as-is. Arguments are not validated against it; the handler owns validation. */
  inputSchema: JsonSchemaObject;
  annotations?: ToolAnnotations;
  /** Evaluated on every tools/list and tools/call. Hidden tools are reported as unknown when called. */
  visible?(slot: SlotView<B>): boolean;
  handler(args: Record<string, unknown>, ctx: ToolCallContext<B>): Promise<ToolResult>;
}

/**
 * Tools computed per slot: called on every tools/list and tools/call with the
 * slot as it is then, and served in the order returned. Lets a host whose
 * catalog depends on session state (profiles, feature flags, the binding)
 * give different slots different definitions under the same tool name.
 */
export type HostToolSource<B> = (slot: SlotView<B>) => readonly HostToolDef<B>[];

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  question: string;
  header?: string;
  options: AskUserOption[];
  multiSelect: boolean;
}

export interface SessionToolSink {
  /** Side-channel for host tools to report events back to the owning session. */
  emit(event: { type: string; payload?: unknown }): void;
  /** Resolves with the answers keyed by question, or null when the user skipped. */
  askUser?(questions: AskUserQuestion[], signal?: AbortSignal): Promise<Record<string, string> | null>;
}

export interface SlotView<B> {
  readonly slotId: string;
  readonly sessionKey: string;
  readonly cwd: string;
  readonly binding: B;
}

export interface StructuredResultTool {
  name: string;
  description?: string;
  inputSchema: JsonSchemaObject;
  submit(value: unknown): { ok: true } | { ok: false; error: string };
}

export interface SlotBuiltins {
  /** Registers `ask_user` when true and the slot's sink implements `askUser`. */
  askUser?: boolean;
  /** Registers a result-submission tool under a host-chosen name. */
  structuredResult?: StructuredResultTool;
}

export interface CreateSlotOptions<B> {
  sessionKey: string;
  cwd: string;
  binding: B;
  sink: SessionToolSink;
  /** When present, only these tool names are exposed, builtins included. */
  allowTools?: ReadonlySet<string>;
  builtins?: SlotBuiltins;
  /**
   * Default true. false: the slot has no URL of its own (its
   * `<basePath>/<slotId>` and hook routes answer 404, endpoint() throws) but
   * can still be a session group's catalog or be bound into a group. For a
   * catalog-only slot whose binding must never run tools by itself.
   */
  routable?: boolean;
}

export interface McpHttpEndpoint {
  type: 'http';
  url: string;
  /** Always empty; Kiro requires the field to be present. */
  headers: [];
}

export interface McpSlotHandle<B> extends SlotView<B> {
  endpoint(): McpHttpEndpoint;
  /**
   * Changes the slot from the next request on. A `binding` or `allowTools`
   * key that is present replaces the current value, an undefined one
   * included: undefined allowTools exposes every tool again. allowTools is
   * copied, as in createSlot.
   */
  rebind(p: { sessionKey?: string; binding?: B; allowTools?: ReadonlySet<string> }): void;
  /** The slot stops resolving immediately (404) and its in-flight calls are aborted. */
  dispose(): Promise<void>;
}

export interface SessionGroupOptions {
  /** Required string argument added to every tool; names the native session. Default `session_id`. */
  anchorArg?: string;
  /** Description of the anchor argument in tools/list, read by the agent. Default: a generic session-id description. */
  anchorDescription?: string;
}

export interface McpSessionGroup<B> {
  readonly groupId: string;
  endpoint(): McpHttpEndpoint;
  /** Routes calls whose anchor is `nativeSessionId` to `slot`. */
  bind(nativeSessionId: string, slot: McpSlotHandle<B>): void;
  /** Opens the turn window for a bound session; the returned function closes it. */
  beginTurn(nativeSessionId: string): () => void;
  /** Closes the session's turn window, whichever beginTurn opened it. No-op when it is not open. */
  endTurn(nativeSessionId: string): void;
  /** The live slot bound to `nativeSessionId`, turn window open or not; undefined after dispose. */
  resolve(nativeSessionId: string): SlotView<B> | undefined;
  /** Whether calls anchored to `nativeSessionId` are routed now: bound to a live slot with its turn window open. */
  isTurnActive(nativeSessionId: string): boolean;
  dispose(): void;
}

export type McpHostHandler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void>;

export interface McpHostListener {
  baseUrl: string;
  close(): Promise<void>;
}

export type HostHookHandler<B> = (slot: SlotView<B>, body: unknown) => Promise<unknown>;

/**
 * Catalog of a slot, in order: builtins, then the entries of every tool source
 * in registration order, then registerTool tools in registration order. When
 * two entries share a name the earlier one wins, so builtins shadow sources
 * and sources shadow registered tools. allowTools and visible() filter all of them.
 */
export interface McpHost<B> {
  registerTool(def: HostToolDef<B>): () => void;
  /** Adds a per-slot tool source (see HostToolSource). Invalid entries are skipped with a warning. */
  registerToolSource(source: HostToolSource<B>): () => void;
  registerHook(name: string, h: HostHookHandler<B>): () => void;
  createSlot(o: CreateSlotOptions<B>): McpSlotHandle<B>;
  createSessionGroup(catalogFrom: McpSlotHandle<B>, o?: SessionGroupOptions): McpSessionGroup<B>;
  /**
   * `<base><basePath>/<slotId>`, the URL a slot's endpoint() gives, computed
   * from the id alone: an unknown or disposed slot's URL answers 404, as does
   * that of a slot created with routable: false. The base is the one
   * endpoint() uses: publicBaseUrl, else the URL of listen(). Throws when
   * neither is set, as endpoint() does. The id is not encoded.
   */
  slotEndpoint(slotId: string): McpHttpEndpoint;
  /** `<base><basePath>-session/<groupId>`, a session group's endpoint(), computed from the id alone like slotEndpoint(). */
  sessionGroupEndpoint(groupId: string): McpHttpEndpoint;
  /**
   * `<base><basePath>-hooks/<slotId>/<name>`, the URL the hook registered as
   * `name` answers for the slot, computed from the id alone like
   * slotEndpoint(). `name` follows registerHook's name rule.
   */
  hookUrl(slotId: string, name: string): string;
  /**
   * Request handler for hosts that mount the routes on their own server.
   * `body` is an already parsed JSON body; when omitted the handler reads the
   * request stream itself (up to maxBodyBytes). A host that pre-parses must enforce
   * its own body limit; the handler can then only check Content-Length.
   */
  handler(): McpHostHandler;
  /** Binds 127.0.0.1 only. Port 0 (default) picks a free port. */
  listen(o?: { port?: number }): Promise<McpHostListener>;
  close(): Promise<void>;
}
