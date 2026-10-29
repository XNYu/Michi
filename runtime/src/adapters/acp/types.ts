export type AcpUpdate = Record<string, any>;

/**
 * A non-text ACP prompt content block appended after the text block. kiro-cli
 * advertises `promptCapabilities.image: true` at initialize; image blocks carry
 * base64 data + mimeType (verified against kiro-cli 2.14.0).
 */
export interface AcpPromptBlock {
    type: "image" | "resource";
    mimeType?: string;
    data?: string;
    [key: string]: unknown;
}

export interface AcpClientInfo {
    name: string;
    version: string;
}

export interface AcpAuthMethod {
    id: string;
    name?: string;
    description?: string;
}

export interface AcpPromptCapabilities {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
    [key: string]: unknown;
}

export interface AcpMcpCapabilities {
    http?: boolean;
    sse?: boolean;
    [key: string]: unknown;
}

export interface AcpAgentCapabilities {
    loadSession?: boolean;
    promptCapabilities?: AcpPromptCapabilities;
    mcpCapabilities?: AcpMcpCapabilities;
    [key: string]: unknown;
}

export interface AcpInitializeResult {
    protocolVersion?: string | number;
    authMethods?: AcpAuthMethod[];
    agentCapabilities?: AcpAgentCapabilities;
    [key: string]: unknown;
}

/** When the shared runtime should attach the Michi HTTP MCP slot. */
export type AcpMcpAttach = "always" | "ifAdvertised" | "never";

export function acpAgentCapabilities(init?: AcpInitializeResult | null): AcpAgentCapabilities {
    const caps = init?.agentCapabilities;
    return caps && typeof caps === "object" ? caps : {};
}

export function acpSupportsLoadSession(init?: AcpInitializeResult | null): boolean {
    return acpAgentCapabilities(init).loadSession === true;
}

export function acpSupportsHttpMcp(init?: AcpInitializeResult | null): boolean {
    return acpAgentCapabilities(init).mcpCapabilities?.http === true;
}

export function acpSupportsImagePrompt(init?: AcpInitializeResult | null): boolean {
    return acpAgentCapabilities(init).promptCapabilities?.image === true;
}

/**
 * `policy` is the profile's mcpAttach; unset means "ifAdvertised", whatever
 * the runtime. A runtime that always attaches says so in its profile. The
 * third parameter is accepted for callers written against the public client
 * and is not read.
 */
export function acpShouldAttachMcp(
    policy: AcpMcpAttach | undefined,
    init: AcpInitializeResult | null | undefined,
    _runtimeId?: string,
): boolean {
    const resolved: AcpMcpAttach = policy ?? "ifAdvertised";
    if (resolved === "always") return true;
    if (resolved === "never") return false;
    return acpSupportsHttpMcp(init);
}

export interface AcpUserAnswer {
    question: string;
    answer: string;
}

/** An MCP server entry of session/new and session/load. */
export interface AcpMcpServer {
    name: string;
    type?: "http" | "sse";
    url?: string;
    headers?: Array<{ name: string; value: string }>;
    command?: string;
    args?: string[];
    env?: Array<{ name: string; value: string }>;
    _meta?: Record<string, unknown>;
}

/** What session/new and session/load are asked for beyond cwd and MCP servers (see AcpProfile.sessionParams). */
export interface AcpSessionOptions {
    metadata?: Record<string, unknown>;
    modelId?: string;
    modeId?: string;
}

export interface AcpConfigValue {
    value: string;
    name?: string;
    description?: string;
    _meta?: Record<string, any>;
}

export interface AcpConfigOption {
    id: string;
    type: string;
    name?: string;
    category?: string;
    currentValue?: string | boolean;
    options?: Array<AcpConfigValue | { group: string; options: AcpConfigValue[] }>;
}

/** What the client keeps of a session from session/new, session/load, set_* replies and config updates. */
export interface AcpSessionInfo {
    _meta?: Record<string, unknown>;
    modes?: any;
    models?: any;
    configOptions?: AcpConfigOption[];
}

/** A permission request the agent is waiting on. */
export interface AcpPermissionRequest {
    /** The agent's own JSON-RPC id (the UI gets a numeric requestId instead). */
    rpcId: string | number;
    sessionId: string;
    options?: any[];
    meta?: any;
}

export interface AcpCancelOptions {
    /**
     * When no prompt of ours is out, leave alone a turn the agent started on
     * its own (one a subclass tracks; see AcpClient.spareBackgroundTurn).
     */
    spareOvertakenWake?: boolean;
}

/** What AcpClient.cancelAndSettle observed. */
export interface AcpCancelSettlement {
    /** As AcpClient.cancel: the client owned the session and handled the cancel. */
    dispatched: boolean;
    /**
     * The stopReason the session/prompt that was out at the cancel settled
     * with, within the deadline. Absent: no prompt was out, it failed (the
     * cancel watchdog among other causes), or the deadline passed.
     */
    stopReason?: string;
}

/**
 * Per-runtime ACP personality. The shared client owns NDJSON JSON-RPC
 * transport; the profile owns spawn/auth/protocol and vendor extensions.
 */
export interface AcpProfile {
    readonly runtimeId: string;
    /** Used in logs / startup marks. Kiro keeps "kiro" for bit-identical logs. */
    readonly logLabel: string;
    /** The agent's name in the client's user-visible errors. Default: logLabel. */
    readonly displayName?: string;
    readonly binaryPath: string;
    readonly cwd: string;
    readonly model?: string;
    /** Read once per start(), so it may be a getter that resolves the argv each time. */
    readonly spawnArgs: string[];
    /**
     * Extra env merged at spawn onto the host's base environment
     * (AcpCoreOptions.spawnEnv), not onto process.env as in the public
     * client; the client's constructor refuses a profile that sets it when the
     * host gives no base environment. Omit to inherit unchanged.
     * spawnEnvironment, when present, takes precedence.
     */
    readonly spawnEnv?: NodeJS.ProcessEnv;
    readonly protocolVersion: string | number;
    /**
     * Refuse an initialize reply whose protocolVersion differs from
     * protocolVersion (ACPError "Unsupported ACP protocol version"); the reply
     * is then not kept.
     */
    readonly requireProtocolVersion?: boolean;
    readonly clientInfo: AcpClientInfo;
    readonly clientCapabilities: Record<string, unknown>;
    /**
     * How the shared runtime attaches the Michi HTTP MCP slot.
     * Kiro/Cursor/Grok are "always" (live probe confirmed HTTP MCP).
     */
    readonly mcpAttach?: AcpMcpAttach;
    /**
     * How long a session/cancel may take before the prompt is given up and its
     * native session quarantined. Default 5000.
     */
    readonly cancelTimeoutMs?: number;
    /**
     * The child's whole environment, from the host's base environment
     * (AcpCoreOptions.spawnEnv, when the host gives one). Undefined: the child
     * inherits this process's environment. Called once per start().
     */
    spawnEnvironment?(hostEnv: (() => NodeJS.ProcessEnv) | undefined): NodeJS.ProcessEnv | undefined;
    /**
     * Called after initialize. Return params for `authenticate`, or null/undefined
     * to skip (Kiro has no authenticate step).
     */
    buildAuthenticate?(init: AcpInitializeResult): Record<string, unknown> | null | undefined;
    /** Called at the start of start(). Throw a readable error if binary/auth is missing. */
    preflight?(): void;
    /** Fields added to session/new or session/load params after cwd and mcpServers (e.g. `_meta`). */
    sessionParams?(kind: "new" | "load", options: AcpSessionOptions): Record<string, unknown>;
    /** Adapt session info (from replies and config updates) before the client keeps it. */
    normalizeSessionInfo?(info: AcpSessionInfo): AcpSessionInfo;
    /** Fields added to a selected permission outcome's result, after `outcome`. */
    permissionResultMeta?(request: AcpPermissionRequest, optionId: string): Record<string, unknown>;
    /**
     * The usage_summary a prompt yields before its turn_end, from the metadata
     * buffered for the session. Undefined: the default (a `meteringUsage` summary, if any).
     */
    usageSummary?(buffered: Record<string, any> | undefined): AcpUpdate | undefined;
    /** Transform permission options before they reach the session queue / UI. */
    mapPermissionOptions?(options: unknown[]): unknown[];
    /**
     * Handle an incoming JSON-RPC *request* (has id + method) that the transport
     * does not recognize. Return true if handled (including after an async reply).
     * The transport never drops unknown blocking requests: unhandled ones get
     * JSON-RPC -32601.
     */
    handleIncomingRequest?(msg: AcpIncomingRequest, ctx: AcpHandlerContext): boolean | Promise<boolean>;
    /** Handle a vendor notification (no reply required). Return true if consumed. */
    handleNotification?(msg: AcpIncomingNotification, ctx: AcpHandlerContext): boolean;
    /** Extra processing of each session/update once it is queued or routed (e.g. tracking subagent ownership). */
    onSessionUpdate?(sessionId: string, update: AcpUpdate, ctx: AcpHandlerContext): void;
}

/** The `error` of a JSON-RPC reply from the agent, unchecked. */
export interface AcpRpcErrorPayload {
    code?: unknown;
    message?: unknown;
    data?: unknown;
}

/**
 * Any message the agent sends, before the client tells a request (id and
 * method), a reply (id and result or error) and a notification (method only)
 * apart. Nothing in it has been checked yet.
 */
export interface AcpIncomingMessage {
    jsonrpc?: string;
    id?: number | string | null;
    method?: string;
    params?: any;
    result?: any;
    error?: AcpRpcErrorPayload;
}

export interface AcpIncomingRequest {
    jsonrpc?: string;
    id: number | string;
    method: string;
    params?: any;
}

export interface AcpIncomingNotification {
    jsonrpc?: string;
    method: string;
    params?: any;
}

export interface AcpHandlerContext {
    cwd: string;
    model?: string;
    pid?: number;
    pushUpdate(sessionId: string, update: AcpUpdate): void;
    hasSession(sessionId: string): boolean;
    resetIdleTimers(sessionId: string): void;
    isSessionInFlight(sessionId: string): boolean;
    inferSessionId(params?: any): string | undefined;
    setLastMetadata(sessionId: string, params: any): void;
    getLastMetadata(sessionId: string): any;
    reply(id: number | string, result: unknown): void;
    replyError(id: number | string, error: { code: number; message: string; data?: unknown }): void;
    waitForUserInput(requestId: number, sessionId?: string): Promise<AcpUserAnswer[] | null>;
    nextUserInputRequestId(): number;
}
