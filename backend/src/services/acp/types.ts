export type AcpUpdate = Record<string, any>;

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

export function acpShouldAttachMcp(
    policy: AcpMcpAttach | undefined,
    init: AcpInitializeResult | null | undefined,
    runtimeId?: string,
): boolean {
    const resolved: AcpMcpAttach = policy ?? (runtimeId === "kiro" ? "always" : "ifAdvertised");
    if (resolved === "always") return true;
    if (resolved === "never") return false;
    return acpSupportsHttpMcp(init);
}

export interface AcpUserAnswer {
    question: string;
    answer: string;
}

/**
 * Per-runtime ACP personality. The shared client owns NDJSON JSON-RPC
 * transport; the profile owns spawn/auth/protocol and vendor extensions.
 */
export interface AcpProfile {
    readonly runtimeId: string;
    /** Used in logs / startup marks. Kiro keeps "kiro" for bit-identical logs. */
    readonly logLabel: string;
    readonly binaryPath: string;
    readonly cwd: string;
    readonly model?: string;
    readonly spawnArgs: string[];
    /** Extra env merged onto process.env at spawn. Omit to inherit unchanged. */
    readonly spawnEnv?: NodeJS.ProcessEnv;
    readonly protocolVersion: string | number;
    readonly clientInfo: AcpClientInfo;
    readonly clientCapabilities: Record<string, unknown>;
    /**
     * How the shared runtime attaches the Michi HTTP MCP slot.
     * Kiro/Cursor/Grok are "always" (live probe confirmed HTTP MCP).
     */
    readonly mcpAttach?: AcpMcpAttach;
    /**
     * Called after initialize. Return params for `authenticate`, or null/undefined
     * to skip (Kiro has no authenticate step).
     */
    buildAuthenticate?(init: AcpInitializeResult): Record<string, unknown> | null | undefined;
    /** Called at the start of start(). Throw a readable error if binary/auth is missing. */
    preflight?(): void;
    /** Transform permission options before they reach the session queue / UI. */
    mapPermissionOptions?(options: unknown[]): unknown[];
    /**
     * Handle an incoming JSON-RPC *request* (has id + method) that the transport
     * does not recognize. Return true if handled (including after an async reply).
     * The transport never drops unknown blocking requests: unhandled ones get
     * JSON-RPC Method not found.
     */
    handleIncomingRequest?(msg: AcpIncomingRequest, ctx: AcpHandlerContext): boolean | Promise<boolean>;
    /** Handle a vendor notification (no reply required). Return true if consumed. */
    handleNotification?(msg: AcpIncomingNotification, ctx: AcpHandlerContext): boolean;
    /** Extra per-session/update processing (Kiro subagent ownership). */
    onSessionUpdate?(sessionId: string, update: AcpUpdate, ctx: AcpHandlerContext): void;
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
