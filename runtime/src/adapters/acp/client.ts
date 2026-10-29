import { ChildProcess } from "child_process";
import { killProcessTree, spawnAgentProcess } from "../../core/processTree";
import type { RuntimeObservability } from "../../contract/host";
import { HEARTBEAT_INTERVAL_MS } from "../../core/constants";
import { ACPError, ACPProcessExitedError, ACPRequestNotSentError, ACPNotRunningError, ACPSessionRecoveryRequiredError } from "./errors";
import type {
    AcpAgentCapabilities, AcpCancelOptions, AcpCancelSettlement, AcpConfigOption, AcpHandlerContext, AcpIncomingMessage, AcpIncomingNotification, AcpIncomingRequest,
    AcpInitializeResult, AcpMcpServer, AcpPermissionRequest, AcpProfile, AcpPromptBlock, AcpRpcErrorPayload, AcpSessionInfo, AcpSessionOptions,
    AcpUpdate, AcpUserAnswer,
} from "./types";

/** Default AcpCoreOptions.acpIdleTimeoutMs. */
const DEFAULT_IDLE_TIMEOUT_MS = 180_000;

// Prompt turns can legitimately spend many minutes inside a tool call without
// ACP session/update traffic. The SSE layer emits synthetic heartbeats for UI
// liveness, and users can still cancel the turn explicitly.
const PROMPT_TIMEOUT_MS = 0;

const MAX_RPC_ERROR_DATA_CHARS = 4 * 1024;

function contentBlocks(content: unknown): unknown[] {
    if (Array.isArray(content)) return content;
    return content ? [content] : [];
}

function summarizeAcpUpdate(update: unknown): Record<string, unknown> {
    if (!update || typeof update !== "object") return {};
    const row = update as Record<string, any>;
    const blocks = contentBlocks(row.content);
    let textChars = 0;
    let textBytes = 0;
    let textBlockCount = 0;
    const contentTypes = new Set<string>();

    for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (typeof b.type === "string") contentTypes.add(b.type);
        if (b.type === "text" && typeof b.text === "string") {
            textBlockCount += 1;
            textChars += b.text.length;
            textBytes += Buffer.byteLength(b.text, "utf8");
        }
    }

    const out: Record<string, unknown> = {};
    if (blocks.length > 0) out.contentBlocks = blocks.length;
    if (contentTypes.size > 0) out.contentTypes = Array.from(contentTypes);
    if (textBlockCount > 0) {
        out.textBlockCount = textBlockCount;
        out.textChars = textChars;
        out.textBytes = textBytes;
    }
    if (Array.isArray(row.entries)) out.planEntries = row.entries.length;
    if (Array.isArray(row.availableCommands)) out.commandCount = row.availableCommands.length;
    if (Array.isArray(row.options)) out.permissionOptionCount = row.options.length;
    if (typeof row.title === "string") out.titleChars = row.title.length;
    if (typeof row.status === "string") out.status = row.status;
    if (typeof row.kind === "string") out.kindType = row.kind;
    return out;
}

/** An RPC error's data (or any agent-sent payload) as a bounded log string. */
export function rpcErrorDataForLog(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    let serialized: string;
    try {
        serialized = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
        serialized = String(value);
    }
    if (serialized.length <= MAX_RPC_ERROR_DATA_CHARS) return serialized;
    return `${serialized.slice(0, MAX_RPC_ERROR_DATA_CHARS)}…[truncated]`;
}

/** A request of ours awaiting its reply. */
export interface AcpPendingRequest {
    method: string;
    sessionId?: string;
    timeoutMs: number;
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout | null;
    hardTimeout?: boolean;
}

/** What a SessionQueue carries: a session update, or `done` once the agent process has exited. */
export type SessionQueueItem = { update: AcpUpdate } | { done: true };

/** One session's updates, in arrival order, for the prompt that reads them. */
export class SessionQueue {
    private items: SessionQueueItem[] = [];
    private waiter: ((item: SessionQueueItem) => void) | null = null;

    push(item: SessionQueueItem): void {
        if (this.waiter) {
            const w = this.waiter;
            this.waiter = null;
            w(item);
        } else {
            this.items.push(item);
        }
    }

    get(): Promise<SessionQueueItem> {
        const head = this.items.shift();
        if (head !== undefined) return Promise.resolve(head);
        return new Promise((resolve) => {
            this.waiter = resolve;
        });
    }

    /** Discard any pending items. Called before starting a new prompt turn so
     *  stale chunks emitted after a previous turn was cancelled don't leak in. */
    drain(): void {
        this.items = [];
    }
}

/** What a host provides the ACP client beyond the agent's profile. */
export interface AcpCoreOptions {
    /**
     * Logs, perf marks, startup marks, the raw stream probe and the child's
     * stderr. Default: none of them.
     */
    observability?: RuntimeObservability;
    /**
     * Idle timeout for an ACP RPC, reset every time we see progress on the
     * same sessionId. The RPC only dies if the agent goes totally silent for
     * this long. 0 disables it. Default 180000.
     */
    acpIdleTimeoutMs?: number;
    /**
     * The environment an agent child would inherit, read at each spawn (Michi:
     * its own). The profile's spawnEnvironment derives the child's from it; its
     * spawnEnv is merged onto it. Absent: the child inherits this process's
     * environment unchanged.
     */
    spawnEnv?: () => NodeJS.ProcessEnv;
}

/** A client built without a host reports nothing. */
const SILENT_OBSERVABILITY: RuntimeObservability = {
    log: () => {},
    perf: { now: () => performance.now(), mark: () => {}, measure: () => {} },
};

/**
 * Generic ACP client: one agent process speaking newline-delimited JSON-RPC
 * over stdio. It owns the process, request/reply correlation and deadlines,
 * and the initialize handshake; an AcpProfile declares what differs between
 * agents (launch, protocol version, client info, authentication).
 *
 * An agent whose protocol needs state of its own extends this class and
 * overrides its protected extension points; each default behaves as if the
 * agent had no such extension. Two rules for subclasses:
 * - The constructor calls no overridable method: a subclass's fields are not
 *   assigned until super() returns.
 * - An extension point that is synchronous for a caller stays so: do not add
 *   an await where the default has none.
 */
export class AcpClient {
    protected proc: ChildProcess | null = null;
    protected nextId = 0;
    protected pending = new Map<number, AcpPendingRequest>();
    protected buffer = "";
    protected sessionQueues = new Map<string, SessionQueue>();
    protected readonly quarantinedSessions = new Set<string>();
    protected readonly cancelTimers = new Map<string, ReturnType<typeof setTimeout>>();
    protected readonly cancelTimeoutMs: number;
    protected stopped = false;
    protected exitError: Error | null = null;
    protected exitListeners: Array<(err: Error) => void> = [];
    /** Tracks pending permission requests from the agent so we can respond later. */
    protected pendingPermissions = new Map<number, AcpPermissionRequest>();
    protected nextPermissionId = -1;
    protected initialization: AcpInitializeResult | null = null;
    protected rawProbeState = new Map<string, { seq: number; prevAt: number; startedAt: number }>();
    /** Full prompt lifetimes, including the consumer's final queue cleanup. */
    protected sessionInFlight = new Map<string, Promise<void>>();
    protected readonly sessionInfo = new Map<string, AcpSessionInfo>();
    protected readonly loadingSessions = new Set<string>();
    protected readonly activePrompts = new Set<string>();
    protected readonly cancelledPrompts = new Set<string>();
    /** How each session's outstanding session/prompt RPC settles (see cancelAndSettle). */
    protected readonly promptOutcomes = new Map<string, Promise<{ stopReason?: string }>>();
    protected lastMetadata = new Map<string, any>();
    private lastPromptSessionId: string | null = null;
    private nextIncomingUserInputId = 0;
    /** Profile-driven questions to the user (see AcpHandlerContext.waitForUserInput). */
    private pendingUserInputs = new Map<number, {
        sessionId?: string;
        resolve: (answers: AcpUserAnswer[] | null) => void;
    }>();

    protected readonly profile: AcpProfile;
    /** Id of the owning runtime instance. */
    readonly runtimeId: string;
    protected readonly binaryPath: string;
    protected readonly cwd: string;
    protected readonly model?: string;
    protected readonly observability: RuntimeObservability;
    protected readonly idleTimeoutMs: number;
    protected readonly spawnEnv?: () => NodeJS.ProcessEnv;
    /** Names logs and startup marks. */
    protected readonly logLabel: string;
    /** Names the agent in user-visible errors. */
    protected readonly displayName: string;

    constructor(profile: AcpProfile, options: AcpCoreOptions = {}) {
        if (profile.spawnEnv && !profile.spawnEnvironment && !options.spawnEnv) {
            throw new ACPError("An ACP profile's spawnEnv needs the host's base environment (AcpCoreOptions.spawnEnv)");
        }
        this.profile = profile;
        this.runtimeId = profile.runtimeId;
        this.binaryPath = profile.binaryPath;
        this.cwd = profile.cwd;
        this.model = profile.model;
        this.logLabel = profile.logLabel;
        this.displayName = profile.displayName ?? profile.logLabel;
        this.observability = options.observability ?? SILENT_OBSERVABILITY;
        this.idleTimeoutMs = options.acpIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
        this.spawnEnv = options.spawnEnv;
        this.cancelTimeoutMs = profile.cancelTimeoutMs ?? 5_000;
    }

    /** Fires when the underlying process crashes or exits unexpectedly.
     *  ChatManager uses this to clear its cached client so the next request
     *  can respawn. */
    onExit(fn: (err: Error) => void): void {
        this.exitListeners.push(fn);
    }

    isAlive(): boolean {
        return !this.stopped && !this.exitError && !!this.proc;
    }

    needsSessionRecovery(sessionId: string): boolean {
        return this.quarantinedSessions.has(sessionId);
    }

    hasSession(sessionId: string): boolean {
        return this.sessionQueues.has(sessionId) && !this.needsSessionRecovery(sessionId);
    }

    /** Restart only when no healthy session or control RPC owns this process. */
    hasHealthyWork(): boolean {
        return [...this.sessionInFlight.keys()].some((sid) => !this.quarantinedSessions.has(sid))
            || [...this.pending.values()].some((p) => !p.sessionId || !this.quarantinedSessions.has(p.sessionId))
            || this.hasBackgroundWork();
    }

    hasUnconfirmedExit(): boolean {
        return this.stopped && this.proc !== null;
    }

    protected assertSessionUsable(sessionId: string): void {
        if (this.needsSessionRecovery(sessionId)) {
            throw new ACPSessionRecoveryRequiredError(
                `The previous ${this.displayName} turn did not stop. The original session needs recovery before another message can be sent.`,
                { sessionId },
            );
        }
    }

    protected clearCancelTimer(sessionId: string): void {
        clearTimeout(this.cancelTimers.get(sessionId));
        this.cancelTimers.delete(sessionId);
    }

    /**
     * Hold a session's turn reservation (as a prompt does), so later
     * prompts wait for it; returns its release.
     */
    protected reserveSession(sessionId: string): () => void {
        const prev = this.sessionInFlight.get(sessionId);
        let release!: () => void;
        const finished = new Promise<void>((resolve) => { release = resolve; });
        const reservation = prev ? prev.then(() => finished) : finished;
        this.sessionInFlight.set(sessionId, reservation);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            release();
            void reservation.then(() => {
                if (this.sessionInFlight.get(sessionId) === reservation) this.sessionInFlight.delete(sessionId);
            });
        };
    }

    /** Refuse a session until recovered. */
    protected quarantine(sessionId: string): void {
        this.quarantinedSessions.add(sessionId);
        this.onQuarantine(sessionId);
    }

    get capabilities(): AcpAgentCapabilities | undefined {
        return this.initialization?.agentCapabilities;
    }

    /** Result of the last successful `initialize` (authMethods + agentCapabilities). */
    getInitializeResult(): AcpInitializeResult | null {
        return this.initialization;
    }

    getSessionInfo(sessionId: string): AcpSessionInfo | undefined {
        return this.sessionInfo.get(sessionId);
    }

    protected rememberSessionInfo(sessionId: string, info: AcpSessionInfo): AcpSessionInfo {
        const merged = { ...this.sessionInfo.get(sessionId), ...info };
        const normalized = this.profile.normalizeSessionInfo ? this.profile.normalizeSessionInfo(merged) : merged;
        this.sessionInfo.set(sessionId, normalized);
        this.onSessionInfoChanged(sessionId);
        return normalized;
    }

    protected writeRawUpdateProbe(sessionId: string | undefined, method: string, update: unknown): void {
        if (!sessionId) return;
        const now = Date.now();
        const state = this.rawProbeState.get(sessionId) ?? { seq: 0, prevAt: 0, startedAt: now };
        state.seq += 1;
        this.observability.streamProbe?.write({
            phase: "raw_update",
            layer: "acp",
            runtimeId: this.runtimeId,
            chatId: sessionId,
            sessionId,
            method,
            seq: state.seq,
            updateKind: update && typeof update === "object"
                ? String((update as Record<string, unknown>).sessionUpdate ?? "unknown")
                : "unknown",
            dtMs: state.prevAt === 0 ? 0 : now - state.prevAt,
            sinceStartMs: now - state.startedAt,
            atEpochMs: now,
            ...summarizeAcpUpdate(update),
        });
        state.prevAt = now;
        this.rawProbeState.set(sessionId, state);
    }

    start(): void {
        if (this.proc) return;
        this.stopped = false;
        this.exitError = null;
        this.initialization = null;

        this.profile.preflight?.();

        const args = this.profile.spawnArgs;

        this.observability.startupMark?.(`${this.logLabel}_spawn_start`, { cwd: this.cwd, binaryPath: this.binaryPath });
        const env = this.childEnvironment();
        this.proc = spawnAgentProcess(this.binaryPath, args, {
            cwd: this.cwd,
            ...(env ? { env } : {}),
        });
        this.observability.perf.mark("acp:spawn_requested", { cwd: this.cwd, pid: this.proc.pid });
        const pid = this.proc.pid;
        this.proc.once('spawn', () => {
            this.observability.startupMark?.(`${this.logLabel}_spawn_done`, { cwd: this.cwd, pid });
            this.observability.log('info', "acp", `${this.logLabel} process spawned`, {
                pid,
                cwd: this.cwd,
                model: this.model,
                binaryPath: this.binaryPath,
            });
        });

        this.proc.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
        this.proc.stderr!.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            this.onChildStderr(text);
            process.stderr.write(`[acp stderr] ${text}`);
            this.observability.childStderr?.(this.runtimeId, text);
        });

        this.proc.on("error", (err) => {
            this.observability.log('error', "acp", `${this.logLabel} process error`, {
                pid,
                cwd: this.cwd,
                model: this.model,
                errorName: err.name,
                errorMessage: err.message,
                errorCode: (err as NodeJS.ErrnoException).code,
            });
            this.exitError = err;
            this.failAllPending(err);
        });

        this.proc.on("exit", (code, signal) => {
            const expected = this.stopped;
            const exitMeta = {
                pid,
                cwd: this.cwd,
                model: this.model,
                code,
                signal,
                expected,
                pendingRpcCount: this.pending.size,
                sessionCount: this.sessionQueues.size,
            };
            if (expected) this.observability.log('info', "acp", `${this.logLabel} process exited`, exitMeta);
            else this.observability.log('error', "acp", `${this.logLabel} process exited unexpectedly`, exitMeta);
            this.stopped = true;
            const err = this.processExitError(code, signal);
            this.exitError = err;
            this.failAllPending(err);
            this.pendingPermissions.clear();
            for (const q of this.sessionQueues.values()) q.push({ done: true });
            this.onProcessExit();
            this.proc = null;
            for (const fn of this.exitListeners) {
                try { fn(err); } catch {}
            }
        });
    }

    /** The child's environment: the profile's, or its extra entries on the host's; undefined inherits ours. */
    private childEnvironment(): NodeJS.ProcessEnv | undefined {
        if (this.profile.spawnEnvironment) return this.profile.spawnEnvironment(this.spawnEnv);
        return this.profile.spawnEnv && this.spawnEnv ? { ...this.spawnEnv(), ...this.profile.spawnEnv } : undefined;
    }

    private onStdout(chunk: Buffer): void {
        this.buffer += chunk.toString();
        let idx: number;
        while ((idx = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (!line) continue;
            let msg: any;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            this.dispatch(msg);
        }
    }

    /**
     * Route one message from the agent. In order, each step may end it:
     * Michi's own `_michi/permission_resolved`; interceptMessage; any frame of
     * a quarantined session (dropped, a permission request cancelled);
     * requests; replies; session/update; other notifications.
     */
    protected dispatch(msg: AcpIncomingMessage): void {
        if (msg?.method === '_michi/permission_resolved') {
            const { sessionId, requestId } = msg.params ?? {};
            if (this.pendingPermissions.get(requestId)?.sessionId === sessionId) {
                this.pendingPermissions.delete(requestId);
                this.sessionQueues.get(sessionId)?.push({ update: { sessionUpdate: 'permission_resolved', requestId } });
            }
            return;
        }

        if (this.interceptMessage(msg)) return;

        // An expired cancellation has no safe event boundary. Never let late
        // chunks/permissions from that native session enter another turn.
        if (msg?.params?.sessionId && this.needsSessionRecovery(msg.params.sessionId)) {
            if (msg.method === 'session/request_permission' && msg.id != null) {
                this.cancelPermission(this.registerPendingPermission(msg.id, { sessionId: msg.params.sessionId }));
            }
            return;
        }

        // Incoming JSON-RPC request from the agent (has both id and method).
        if (msg && msg.id !== undefined && msg.id !== null && 'method' in msg) {
            if (msg.method === 'session/request_permission') {
                const { sessionId, toolCall, options, _meta } = msg.params ?? {};
                const queue = sessionId ? this.sessionQueues.get(sessionId) : undefined;
                const requestId = this.registerPendingPermission(msg.id, { sessionId, options, meta: _meta });
                // The UI sees the profile's options; answers are checked against the agent's.
                const shown = this.profile.mapPermissionOptions
                    ? this.profile.mapPermissionOptions(Array.isArray(options) ? options : [])
                    : options;
                const routed = sessionId
                    ? this.routePermissionRequest(sessionId, { sessionUpdate: 'permission_request', requestId, toolCall, options: shown, _meta })
                    : 'none';
                if (routed === 'dropped') {
                    this.cancelPermission(requestId);
                } else if (routed === 'delivered') {
                    // Waits where it was routed (see routePermissionRequest).
                } else if (queue) {
                    queue.push({
                        update: {
                            sessionUpdate: 'permission_request',
                            requestId,
                            toolCall,
                            options: shown,
                            _meta,
                        },
                    });
                } else if (!this.routeUnqueuedPermission(sessionId, requestId, toolCall, options)) {
                    this.cancelPermission(requestId);
                }
            } else {
                this.handleIncomingRequest(msg as AcpIncomingRequest);
            }
            return;
        }

        if (this.handleResponse(msg)) return;

        if (msg?.method === "session/update") {
            const sid: string | undefined = msg.params?.sessionId;
            const update = msg.params?.update;
            if (sid && update && this.claimSessionUpdate(sid, update, msg as AcpIncomingNotification)) return;
            if (sid && update) {
                if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
                    this.rememberSessionInfo(sid, { configOptions: update.configOptions });
                }
                if (update.sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string') {
                    this.rememberSessionInfo(sid, {
                        modes: { ...this.sessionInfo.get(sid)?.modes, currentModeId: update.currentModeId },
                        configOptions: this.sessionInfo.get(sid)?.configOptions?.map((option) =>
                            option.id === 'mode' || option.category === 'mode' ? { ...option, currentValue: update.currentModeId } : option),
                    });
                }
                if (this.beforeQueueUpdate(sid, update, msg as AcpIncomingNotification)) return;
                // Loading replays the session's history, which the host already has.
                // Known behavior, pinned by golden S14: a replayed frame returns
                // here (or in a subclass's beforeQueueUpdate) before the
                // idle-timer reset below, so it does not extend session/load's
                // own idle deadline. Kept as is; see follow-up task B, "should
                // replay frames during session/load reset that request's idle
                // timer".
                if (this.loadingSessions.has(sid)) return;
            }
            if (this.observability.streamProbe?.enabled()) this.writeRawUpdateProbe(sid, "session/update", msg.params?.update);
            // Any progress on this session resets the idle timer for the
            // in-flight session/prompt RPC — the agent is visibly still working.
            if (sid) {
                for (const p of this.pending.values()) {
                    if (p.sessionId === sid && !p.hardTimeout) this.resetIdleTimer(p);
                }
            }
            if (!this.routeSessionUpdate(sid, msg as AcpIncomingNotification)) {
                const q = sid ? this.sessionQueues.get(sid) : undefined;
                if (q) q.push({ update: msg.params });
            }
            this.afterSessionUpdate(sid, msg as AcpIncomingNotification);
            return;
        }

        if (typeof msg?.method === "string") this.handleNotification(msg as AcpIncomingNotification);
    }

    /** Settle the request a reply answers. False when `msg` is not a reply. */
    protected handleResponse(msg: AcpIncomingMessage): boolean {
        if (!(msg && msg.id !== undefined && msg.id !== null && ("result" in msg || "error" in msg))) return false;
        const p = this.pending.get(msg.id as number);
        if (!p) return true;
        this.pending.delete(msg.id as number);
        if (p.timer) clearTimeout(p.timer);
        if (p.method === 'session/prompt' && p.sessionId) this.clearCancelTimer(p.sessionId);
        if (msg.error) {
            const message = typeof msg.error?.message === "string" && msg.error.message
                ? msg.error.message
                : "unknown ACP error";
            this.observability.log('error', "acp", "rpc request failed", {
                pid: this.proc?.pid,
                cwd: this.cwd,
                model: this.model,
                rpcId: msg.id,
                method: p.method,
                sessionId: p.sessionId,
                rpcCode: msg.error?.code,
                rpcMessage: message,
                rpcData: rpcErrorDataForLog(msg.error?.data),
            });
            p.reject(this.mapRpcError(p, msg.error) ?? new ACPError(message, {
                method: p.method,
                sessionId: p.sessionId,
                rpcCode: msg.error?.code,
                rpcData: msg.error?.data,
            }));
        } else {
            p.resolve(msg.result);
        }
        return true;
    }

    protected resetIdleTimer(p: AcpPendingRequest): void {
        if (p.timer) clearTimeout(p.timer);
        if (p.timeoutMs === 0) {
            p.timer = null;
            return;
        }
        p.timer = setTimeout(() => {
            // Find this pending's id to delete it.
            for (const [id, entry] of this.pending) {
                if (entry === p) {
                    this.pending.delete(id);
                    break;
                }
            }
            p.reject(
                new ACPError(
                    p.hardTimeout
                        ? `Request ${p.method} exceeded its ${p.timeoutMs}ms recovery deadline`
                        : `Request ${p.method} idle for ${p.timeoutMs}ms (no updates from agent)`,
                    { method: p.method, sessionId: p.sessionId },
                ),
            );
        }, p.timeoutMs);
    }

    protected failAllPending(err: Error): void {
        for (const timer of this.cancelTimers.values()) clearTimeout(timer);
        this.cancelTimers.clear();
        for (const p of this.pending.values()) {
            if (p.timer) clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
        for (const entry of this.pendingUserInputs.values()) {
            entry.resolve(null);
        }
        this.pendingUserInputs.clear();
        this.onFailAllPending(err);
    }

    protected notify(method: string, params?: any): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.stopped || this.exitError) {
                reject(this.notSentError());
                return;
            }
            if (!this.proc?.stdin || this.proc.stdin.destroyed) {
                reject(new ACPRequestNotSentError("ACP process is not running"));
                return;
            }
            const payload = JSON.stringify({
                jsonrpc: "2.0",
                method,
                ...(params !== undefined ? { params } : {}),
            });
            this.proc.stdin.write(payload + "\n", (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    protected send(
        method: string,
        params?: any,
        timeoutMs: number = this.idleTimeoutMs,
        sessionId?: string,
        hardTimeout = false,
    ): Promise<any> {
        return new Promise((resolve, reject) => {
            if (params?.sessionId) this.assertSessionUsable(params.sessionId);
            if (this.stopped || this.exitError) {
                reject(this.notSentError());
                return;
            }
            if (!this.proc?.stdin || this.proc.stdin.destroyed) {
                reject(new ACPRequestNotSentError("ACP process is not running"));
                return;
            }
            const id = this.nextId++;
            const p: AcpPendingRequest = {
                method,
                sessionId,
                timeoutMs,
                resolve,
                reject,
                timer: null,
                hardTimeout,
            };
            this.pending.set(id, p);
            this.resetIdleTimer(p);
            const payload = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
            this.proc.stdin.write(payload + "\n", (err) => {
                if (err) {
                    if (this.pending.delete(id)) {
                        if (p.timer) clearTimeout(p.timer);
                        reject(err);
                    }
                }
            });
        });
    }

    async initialize(timeoutMs?: number): Promise<AcpInitializeResult> {
        const t0 = this.observability.perf.now();
        this.observability.startupMark?.(`${this.logLabel}_initialize_start`, { cwd: this.cwd });
        const result: AcpInitializeResult = (await this.send("initialize", {
            protocolVersion: this.profile.protocolVersion,
            clientInfo: this.profile.clientInfo,
            clientCapabilities: this.profile.clientCapabilities,
        }, timeoutMs, undefined, timeoutMs !== undefined)) ?? {};
        if (this.profile.requireProtocolVersion && result.protocolVersion !== this.profile.protocolVersion) {
            throw new ACPError('Unsupported ACP protocol version');
        }
        this.initialization = result;
        if (this.profile.buildAuthenticate) {
            const auth = this.profile.buildAuthenticate(result);
            if (auth) await this.send("authenticate", auth);
        }
        this.observability.startupMark?.(`${this.logLabel}_initialize_done`, { cwd: this.cwd });
        this.observability.perf.measure("acp:initialize", t0, { cwd: this.cwd });
        return result;
    }

    async newSession(mcpServers: AcpMcpServer[] = [], options: AcpSessionOptions = {}): Promise<AcpSessionInfo & { sessionId: string }> {
        const t0 = this.observability.perf.now();
        this.observability.startupMark?.(`${this.logLabel}_session_new_start`, { cwd: this.cwd, mcpServerCount: mcpServers.length });
        const result = await this.send("session/new", { cwd: this.cwd, mcpServers,
            ...this.profile.sessionParams?.('new', options),
        });
        const sid = result.sessionId as string;
        if (typeof sid !== 'string' || !sid) throw new ACPError('session/new returned no sessionId');
        this.sessionQueues.set(sid, new SessionQueue());
        this.observability.startupMark?.(`${this.logLabel}_session_new_done`, { cwd: this.cwd, sessionId: sid, mcpServerCount: mcpServers.length });
        this.observability.perf.measure("acp:session_new", t0, { cwd: this.cwd, sessionId: sid });
        return { ...this.rememberSessionInfo(sid, result), sessionId: sid };
    }

    async loadSession(
        sessionId: string,
        cwd: string,
        mcpServers: AcpMcpServer[] = [],
        timeoutMs?: number,
        options: AcpSessionOptions = {},
    ): Promise<AcpSessionInfo> {
        const t0 = this.observability.perf.now();
        this.assertSessionUsable(sessionId);
        const verified = this.beforeLoadSession(sessionId, cwd, timeoutMs);
        if (verified) await verified;
        const createdQueue = !this.sessionQueues.has(sessionId);
        if (createdQueue) {
            this.sessionQueues.set(sessionId, new SessionQueue());
        }
        let result;
        this.loadingSessions.add(sessionId);
        try {
            result = await this.send(
                "session/load",
                { sessionId, cwd, mcpServers, ...this.profile.sessionParams?.('load', options) },
                timeoutMs ?? this.idleTimeoutMs,
                sessionId,
                timeoutMs !== undefined,
            );
        } catch (error) {
            if (createdQueue) this.sessionQueues.delete(sessionId);
            throw error;
        } finally {
            this.loadingSessions.delete(sessionId);
        }
        const q = this.sessionQueues.get(sessionId);
        if (q) q.drain();
        this.observability.perf.measure("acp:session_load", t0, { cwd, sessionId });
        return this.rememberSessionInfo(sessionId, result ?? {});
    }

    async setMode(sessionId: string, modeId: string): Promise<void> {
        const result = await this.send("session/set_mode", { sessionId, modeId }, this.idleTimeoutMs, sessionId);
        if (result?.configOptions || result?.modes) this.rememberSessionInfo(sessionId, result);
        const applied = result?.modes?.currentModeId ?? result?.configOptions?.find((c: AcpConfigOption) => c.id === 'mode')?.currentValue;
        if (applied && applied !== modeId) throw new ACPError(`${this.displayName} did not select requested agent ${modeId}`);
        const info = this.sessionInfo.get(sessionId);
        if (info) this.rememberSessionInfo(sessionId, { modes: { ...info.modes, currentModeId: modeId },
            configOptions: info.configOptions?.map((option) => option.id === 'mode' || option.category === 'mode'
                ? { ...option, currentValue: modeId } : option),
        });
    }

    async setModel(sessionId: string, modelId: string, timeoutMs?: number): Promise<void> {
        await this.send("session/set_model", { sessionId, modelId }, timeoutMs, sessionId, timeoutMs !== undefined);
        const info = this.sessionInfo.get(sessionId);
        if (info) this.sessionInfo.set(sessionId, { ...info, models: { ...info.models, currentModelId: modelId } });
    }

    /** A request the core does not define (ACP extension methods are underscored). */
    async extensionRequest(method: string, params: Record<string, unknown>): Promise<any> {
        return this.send(method, params);
    }

    /** The prompt's RPC settled. */
    protected settlePrompt(sessionId: string): void {
        this.activePrompts.delete(sessionId);
        this.clearCancelTimer(sessionId);
        this.onPromptSettled(sessionId);
    }

    /**
     * Stream session/update events for a single prompt turn. Ends with a
     * synthetic `{ sessionUpdate: "turn_end", stopReason }` item so callers
     * have a uniform sentinel. Also emits synthetic
     * `{ sessionUpdate: "__heartbeat__", idleMs }` items every
     * HEARTBEAT_INTERVAL_MS during silence so downstream SSE consumers can
     * tell "still working" from "stuck".
     */
    async *prompt(
        sessionId: string,
        text: string,
        extraBlocks: AcpPromptBlock[] = [],
        signal?: AbortSignal,
    ): AsyncIterableIterator<AcpUpdate> {
        const tPromptIn = this.observability.perf.now();
        this.assertSessionUsable(sessionId);
        this.observability.perf.mark("acp:prompt_entered", { sid: sessionId, textLen: text.length });
        this.lastPromptSessionId = sessionId;
        const q = this.sessionQueues.get(sessionId);
        if (!q) throw new ACPError(`unknown session: ${sessionId}`);

        this.onPromptRequested(sessionId, signal);
        let promptToken: unknown;
        let promptRejected = false;
        // Reserve the entire turn before awaiting its predecessor. Waiting only
        // for the RPC lets a successor drain the queue while the old generator
        // is still consuming it; reserving after await also races queued prompts.
        const prev = this.sessionInFlight.get(sessionId);
        let releaseTurn!: () => void;
        const consumerFinished = new Promise<void>((resolve) => { releaseTurn = resolve; });
        const turnFinished = prev ? prev.then(() => consumerFinished) : consumerFinished;
        this.sessionInFlight.set(sessionId, turnFinished);
        let predecessorFinished = !prev;
        void prev?.then(() => { predecessorFinished = true; });
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let sendPromise: Promise<void> | undefined;
        let started = false;
        try {
            if (prev) {
                await new Promise<void>((resolve) => {
                    const done = () => { signal?.removeEventListener('abort', done); resolve(); };
                    if (signal?.aborted) done();
                    else {
                        signal?.addEventListener('abort', done, { once: true });
                        void prev.then(done);
                    }
                });
            }
            if (signal?.aborted) {
                yield { sessionUpdate: "turn_end", stopReason: "cancelled" };
                return;
            }
            this.assertSessionUsable(sessionId);
            if (this.sessionQueues.get(sessionId) !== q) throw new ACPError(`unknown session: ${sessionId}`);

            // Discard any leftover items from a previously cancelled turn on this
            // session (final chunks, tool_call_updates, and the __send_complete__
            // sentinel from the prior prompt). Without this, the next turn's
            // stream would begin with stale content.
            q.drain();
            for (const update of this.promptPrelude(sessionId)) q.push({ update });
            if (this.observability.streamProbe?.enabled()) this.rawProbeState.delete(sessionId);

            // Yield any buffered context_usage that arrived between turns
            // (before prompt() was called, so it would have been drained above).
            const preTurnMeta = this.lastMetadata.get(sessionId);
            if (preTurnMeta && !preTurnMeta.meteringUsage) {
                this.lastMetadata.delete(sessionId);
                q.push({ update: {
                    sessionUpdate: "context_usage",
                    contextUsagePercentage: preTurnMeta.contextUsagePercentage,
                }});
            }

            let lastActivity = Date.now();
            heartbeat = setInterval(() => {
                const idle = Date.now() - lastActivity;
                if (idle >= HEARTBEAT_INTERVAL_MS) {
                    q.push({ update: { sessionUpdate: "__heartbeat__", idleMs: idle } });
                }
            }, HEARTBEAT_INTERVAL_MS);

            let promptResult: any;
            let promptError: Error | null = null;
            started = true;
            // A cancel recorded while this prompt only waited (for a turn
            // before it) belonged to that turn; this one starts uncancelled.
            this.cancelledPrompts.delete(sessionId);
            promptToken = this.onPromptStart(sessionId);
            this.activePrompts.add(sessionId);
            // Settled before the turn's end is queued, so a cancel waiting on
            // it (cancelAndSettle) hears the result before the consumer does.
            let settleOutcome!: (outcome: { stopReason?: string }) => void;
            const outcome = new Promise<{ stopReason?: string }>((resolve) => { settleOutcome = resolve; });
            this.promptOutcomes.set(sessionId, outcome);
            const recordOutcome = (result: { stopReason?: string }) => {
                settleOutcome(result);
                if (this.promptOutcomes.get(sessionId) === outcome) this.promptOutcomes.delete(sessionId);
            };
            sendPromise = this.send(
                "session/prompt",
                { sessionId, prompt: [{ type: "text", text }, ...extraBlocks] },
                PROMPT_TIMEOUT_MS,
                sessionId,
            )
                .then((r) => {
                    this.settlePrompt(sessionId);
                    promptResult = r;
                    recordOutcome(typeof r?.stopReason === "string" ? { stopReason: r.stopReason } : {});
                    q.push({ update: { sessionUpdate: "__send_complete__" } });
                })
                .catch((e) => {
                    this.settlePrompt(sessionId);
                    promptError = e as Error;
                    promptRejected = true;
                    recordOutcome({});
                    q.push({ update: { sessionUpdate: "__send_complete__" } });
                });
            let firstRealUpdateSeen = false;
            let firstChunkSeen = false;
            while (true) {
                const item = await q.get();
                if ("done" in item) {
                    throw new ACPProcessExitedError("ACP process exited mid-prompt");
                }
                const update = item.update.update || item.update;
                const kind = update?.sessionUpdate;

                if (kind === "__heartbeat__") {
                    // Synthetic — don't touch lastActivity so idle keeps growing.
                    yield update;
                    continue;
                }

                if (!firstRealUpdateSeen && kind !== "__send_complete__") {
                    firstRealUpdateSeen = true;
                    this.observability.perf.measure("acp:prompt_to_first_update", tPromptIn, { sid: sessionId, kind });
                }
                if (!firstChunkSeen && kind === "agent_message_chunk") {
                    firstChunkSeen = true;
                    this.observability.perf.measure("acp:prompt_to_first_chunk", tPromptIn, { sid: sessionId });
                }

                if (kind === "__send_complete__") {
                    if (promptError) throw promptError;
                    const stop = promptResult?.stopReason;
                    // Yield any buffered usage_summary BEFORE turn_end, because
                    // consumers stop reading at turn_end.
                    const buffered = this.lastMetadata.get(sessionId);
                    const summary = this.profile.usageSummary?.(buffered);
                    if (summary) {
                        yield summary;
                    } else if (buffered?.meteringUsage) {
                        yield {
                            sessionUpdate: "usage_summary",
                            contextUsagePercentage: buffered.contextUsagePercentage,
                            meteringUsage: buffered.meteringUsage,
                            turnDurationMs: buffered.turnDurationMs,
                        };
                    }
                    this.lastMetadata.delete(sessionId);
                    yield { sessionUpdate: "turn_end", stopReason: stop };
                    return;
                }

                // Real update from the agent — reset the idle clock.
                lastActivity = Date.now();
                yield update;

                if (kind === "turn_end") return;
            }
        } finally {
            clearInterval(heartbeat);
            await sendPromise;
            if (started) {
                this.onPromptEnding(sessionId, promptToken, promptRejected);
                this.activePrompts.delete(sessionId);
                const ended = this.onPromptEnded(sessionId);
                if (ended) await ended;
                this.cancelledPrompts.delete(sessionId);
            }
            releaseTurn();
            if (predecessorFinished && this.sessionInFlight.get(sessionId) === turnFinished) {
                this.sessionInFlight.delete(sessionId);
            }
            void turnFinished.then(() => {
                if (this.sessionInFlight.get(sessionId) === turnFinished) this.sessionInFlight.delete(sessionId);
            });
        }
    }

    /** Keep the UI's numeric contract independent of provider JSON-RPC IDs. */
    protected registerPendingPermission(rpcId: string | number, entry: { sessionId: string; options?: any[]; meta?: any }): number {
        let requestId = rpcId;
        if (typeof requestId !== 'number' || !Number.isFinite(requestId) || this.pendingPermissions.has(requestId)) {
            while (this.pendingPermissions.has(this.nextPermissionId)) this.nextPermissionId--;
            requestId = this.nextPermissionId--;
        }
        this.pendingPermissions.set(requestId, { ...entry, rpcId });
        return requestId;
    }

    /** Send a JSON-RPC response to a pending permission request, selecting an option. */
    respondToPermission(requestId: number, optionId: string): void {
        const pending = this.pendingPermissions.get(requestId);
        if (!pending) return;
        if (pending.options && !pending.options.some((option) => option.optionId === optionId)) {
            throw new ACPError('Unknown permission option');
        }
        this.pendingPermissions.delete(requestId);
        if (!this.proc?.stdin || this.proc.stdin.destroyed) return;
        const payload = JSON.stringify({
            jsonrpc: '2.0',
            id: pending.rpcId,
            result: { outcome: { outcome: 'selected', optionId },
                ...this.profile.permissionResultMeta?.(pending, optionId),
            },
        });
        this.proc.stdin.write(payload + '\n');
    }

    respondToPermissionKind(requestId: number, kind: 'allow_once' | 'reject_once'): void {
        const option = this.pendingPermissions.get(requestId)?.options?.find((option) => option.kind === kind);
        if (option) this.respondToPermission(requestId, option.optionId);
        else this.cancelPermission(requestId);
    }

    /** Send a JSON-RPC response to a pending permission request, cancelling it. */
    cancelPermission(requestId: number): void {
        const pending = this.pendingPermissions.get(requestId);
        if (!pending) return;
        this.pendingPermissions.delete(requestId);
        if (!this.proc?.stdin || this.proc.stdin.destroyed) return;
        const payload = JSON.stringify({
            jsonrpc: '2.0',
            id: pending.rpcId,
            result: { outcome: { outcome: 'cancelled' } },
        });
        this.proc.stdin.write(payload + '\n');
    }

    /** Cancel all pending permission requests (and user questions) for a given session. */
    cancelPermissionsForSession(sessionId: string): void {
        for (const [reqId, entry] of this.pendingPermissions) {
            if (entry.sessionId === sessionId) {
                this.cancelPermission(reqId);
            }
        }
        for (const [reqId, entry] of this.pendingUserInputs) {
            if (entry.sessionId === sessionId) {
                this.pendingUserInputs.delete(reqId);
                entry.resolve(null);
            }
        }
    }

    /** Resolve a profile-driven user-input request (e.g. cursor/ask_question). */
    respondToUserInput(requestId: number, answers: AcpUserAnswer[]): boolean {
        const entry = this.pendingUserInputs.get(requestId);
        if (!entry) return false;
        this.pendingUserInputs.delete(requestId);
        entry.resolve(answers);
        return true;
    }

    skipUserInput(requestId: number): boolean {
        const entry = this.pendingUserInputs.get(requestId);
        if (!entry) return false;
        this.pendingUserInputs.delete(requestId);
        entry.resolve(null);
        return true;
    }

    /** What a profile's hooks may use of this client. */
    protected handlerContext(): AcpHandlerContext {
        return {
            cwd: this.cwd,
            model: this.model,
            pid: this.proc?.pid,
            pushUpdate: (sessionId, update) => {
                const q = this.sessionQueues.get(sessionId);
                if (q) q.push({ update });
            },
            hasSession: (sessionId) => this.sessionQueues.has(sessionId),
            resetIdleTimers: (sessionId) => {
                for (const p of this.pending.values()) {
                    if (p.sessionId === sessionId) this.resetIdleTimer(p);
                }
            },
            isSessionInFlight: (sessionId) => this.sessionInFlight.has(sessionId),
            inferSessionId: (params) => this.inferSessionId(params),
            setLastMetadata: (sessionId, params) => this.lastMetadata.set(sessionId, params),
            getLastMetadata: (sessionId) => this.lastMetadata.get(sessionId),
            reply: (id, result) => this.writeResponse(id, result),
            replyError: (id, error) => this.writeResponse(id, undefined, error),
            waitForUserInput: (requestId, sessionId) => this.waitForUserInput(requestId, sessionId),
            nextUserInputRequestId: () => ++this.nextIncomingUserInputId,
        };
    }

    /** The session a message without a sessionId most likely belongs to. */
    private inferSessionId(params?: any): string | undefined {
        if (typeof params?.sessionId === "string" && params.sessionId) return params.sessionId;
        const inflight = [...this.sessionInFlight.keys()];
        if (inflight.length === 1) return inflight[0];
        if (this.lastPromptSessionId && this.sessionQueues.has(this.lastPromptSessionId)) {
            return this.lastPromptSessionId;
        }
        if (this.sessionQueues.size === 1) return [...this.sessionQueues.keys()][0];
        return undefined;
    }

    private writeResponse(
        id: number | string,
        result?: unknown,
        error?: { code: number; message: string; data?: unknown },
    ): void {
        if (!this.proc?.stdin || this.proc.stdin.destroyed) return;
        const payload = error
            ? { jsonrpc: "2.0", id, error }
            : { jsonrpc: "2.0", id, result };
        this.proc.stdin.write(JSON.stringify(payload) + "\n");
    }

    private waitForUserInput(requestId: number, sessionId?: string): Promise<AcpUserAnswer[] | null> {
        return new Promise((resolve) => {
            this.pendingUserInputs.set(requestId, { sessionId, resolve });
        });
    }

    /** Inject an out-of-band synthetic session/update into the session queue,
     *  for events that originate outside the ACP transport (such as what an
     *  adapter's host tools report). False when nothing took it: no such
     *  session, or routeInjectedUpdate dropped it. */
    injectUpdate(sessionId: string, update: AcpUpdate): boolean {
        const routed = this.routeInjectedUpdate(sessionId, update);
        if (routed !== undefined) return routed;
        const q = this.sessionQueues.get(sessionId);
        if (!q) return false;
        q.push({ update });
        return true;
    }

    /**
     * Dispatch ACP `session/cancel`. Resolves `true` when this client owned the
     * session and a cancel was actually dispatched, `false` when there was
     * nothing to cancel. ACP has no cancel *response*, so `true` means "the
     * request was handed to the transport", not "the agent stopped" — callers
     * that surface this to the UI must label it `inferred`, never `native`.
     * With `spareOvertakenWake`, `true` can also mean the turn needed no
     * native cancel: no prompt of ours was out, and only a wake runs.
     */
    async cancel(sessionId: string, options: AcpCancelOptions = {}): Promise<boolean> {
        if (!this.sessionQueues.has(sessionId)) return false;
        if (this.sessionInFlight.has(sessionId)) this.cancelledPrompts.add(sessionId);
        const active = [...this.pending.entries()].find(([, p]) => p.method === 'session/prompt' && p.sessionId === sessionId);
        // With no prompt of ours out, a cancel would reach only a turn the
        // agent started on its own; a subclass may leave it to run.
        if (!active && options.spareOvertakenWake && this.spareBackgroundTurn(sessionId)) return true;
        this.cancelPermissionsForSession(sessionId);
        if (active && !this.cancelTimers.has(sessionId)) {
            const [id, pending] = active;
            const timer = setTimeout(() => {
                this.cancelTimers.delete(sessionId);
                if (this.pending.get(id) !== pending) return;
                this.quarantine(sessionId);
                this.cancelPermissionsForSession(sessionId);
                this.sessionQueues.get(sessionId)?.drain();
                this.sessionQueues.delete(sessionId);
                this.pending.delete(id);
                clearTimeout(pending.timer ?? undefined);
                this.observability.log('warn', 'acp', 'cancel deadline exceeded; native session quarantined', {
                    sessionId, pid: this.proc?.pid, timeoutMs: this.cancelTimeoutMs,
                });
                pending.reject(new ACPSessionRecoveryRequiredError(
                    `${this.displayName} did not finish cancellation. The original session has been retained for recovery.`,
                    { method: 'session/prompt', sessionId },
                ));
            }, this.cancelTimeoutMs);
            timer.unref();
            this.cancelTimers.set(sessionId, timer);
        }
        // A blocked stdin callback must not block the HTTP cancel response.
        void this.notify("session/cancel", { sessionId }).catch(() => {});
        return true;
    }

    /**
     * cancel(), then wait up to `timeoutMs` (default: the cancel deadline)
     * for the session/prompt that was out to settle. ACP has the agent end a
     * cancelled prompt with stopReason "cancelled": that answer is the
     * agent's own acknowledgement. Only the stopReason is reported; whether
     * it counts as one is the caller's to decide.
     */
    async cancelAndSettle(sessionId: string, options: AcpCancelOptions = {}, timeoutMs = this.cancelTimeoutMs): Promise<AcpCancelSettlement> {
        const outcome = this.promptOutcomes.get(sessionId);
        const dispatched = await this.cancel(sessionId, options);
        if (!dispatched || !outcome) return { dispatched };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), timeoutMs);
            timer.unref?.();
        });
        try {
            const settled = await Promise.race([outcome, deadline]);
            return settled?.stopReason !== undefined ? { dispatched, stopReason: settled.stopReason } : { dispatched };
        } finally {
            clearTimeout(timer);
        }
    }

    destroySession(sessionId: string): void {
        this.cancelPermissionsForSession(sessionId);
        this.onDestroySession(sessionId);
        this.sessionQueues.delete(sessionId);
        this.sessionInfo.delete(sessionId);
        this.lastMetadata.delete(sessionId);
        this.cancelledPrompts.delete(sessionId);
    }

    async shutdown(): Promise<void> {
        this.stopped = true;
        const proc = this.proc;
        if (!proc) {
            this.failAllPending(new ACPNotRunningError('client shut down'));
            return;
        }
        const pid = proc.pid;
        const stop = (signal: 'SIGTERM' | 'SIGKILL', ms: number) => new Promise<boolean>((resolve) => {
            if (proc.exitCode != null || proc.signalCode != null) { resolve(true); return; }
            const done = (exited: boolean) => {
                clearTimeout(timer);
                proc.removeListener('exit', onExit);
                resolve(exited);
            };
            const onExit = () => done(true);
            const timer = setTimeout(() => done(false), ms);
            proc.once('exit', onExit);
            try { if (pid) killProcessTree(pid, signal); } catch { /* wait for confirmed exit */ }
        });
        const exited = await stop('SIGTERM', 5_000) || await stop('SIGKILL', 1_000);
        if (!exited) throw new ACPError(`${this.displayName} process exit could not be confirmed; native recovery was stopped.`);

        this.proc = null;
        this.sessionQueues.clear();
        this.pendingPermissions.clear();
        this.failAllPending(new ACPNotRunningError("client shut down"));
    }

    // -----------------------------------------------------------------------
    // Extension points. Each default behaves as if the agent had no extension.
    // -----------------------------------------------------------------------

    /** A chunk of the child's stderr, before it is echoed and reported. */
    protected onChildStderr(_text: string): void {}

    /**
     * The error the process's exit fails pending requests with and hands to
     * onExit listeners. Later sends fail with notSentError(), which by default
     * carries its message.
     */
    protected processExitError(code: number | null, _signal: NodeJS.Signals | null): Error {
        return new ACPProcessExitedError(`ACP process exited with code ${code}`);
    }

    /** The error an RPC error reply rejects its request with; undefined for the default ACPError. */
    protected mapRpcError(_request: AcpPendingRequest, _error: AcpRpcErrorPayload): Error | undefined {
        return undefined;
    }

    /** The error a request or notification fails with when the process has stopped or exited. */
    protected notSentError(): Error {
        return new ACPRequestNotSentError(this.exitError?.message || "ACP process stopped");
    }

    /** Take a message before anything else sees it (even a quarantined session's frame). */
    protected interceptMessage(_msg: AcpIncomingMessage): boolean {
        return false;
    }

    /**
     * Route a permission request away from the session's queue: 'delivered'
     * (it waits there), 'dropped' (it is cancelled), or 'none' (queued as usual).
     */
    protected routePermissionRequest(_sessionId: string, _update: AcpUpdate): 'delivered' | 'dropped' | 'none' {
        return 'none';
    }

    /** A permission request for a session with no queue: true if taken, else it is cancelled. */
    protected routeUnqueuedPermission(_sessionId: unknown, _requestId: number, _toolCall: unknown, _options: unknown): boolean {
        return false;
    }

    /**
     * A request other than session/request_permission: the profile's
     * handleIncomingRequest answers it, else -32601. Without that hook the
     * refusal is written at once.
     */
    protected handleIncomingRequest(msg: AcpIncomingRequest): void {
        const handle = this.profile.handleIncomingRequest?.bind(this.profile);
        if (!handle) {
            this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                error: { code: -32601, message: `Unsupported client method: ${msg.method}` },
            }) + '\n');
            return;
        }
        void new Promise<boolean>((resolve) => resolve(handle(msg, this.handlerContext())))
            .then((handled) => {
                if (!handled) {
                    this.writeResponse(msg.id, undefined, { code: -32601, message: `Unsupported client method: ${msg.method}` });
                }
            })
            .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                this.writeResponse(msg.id, undefined, { code: -32603, message });
            });
    }

    /** Take a session/update before the client records anything from it. */
    protected claimSessionUpdate(_sessionId: string, _update: AcpUpdate, _msg: AcpIncomingNotification): boolean {
        return false;
    }

    /**
     * Consume a session/update after config and mode changes are recorded and
     * before it is queued (and before it resets idle timers).
     */
    protected beforeQueueUpdate(_sessionId: string, _update: AcpUpdate, _msg: AcpIncomingNotification): boolean {
        return false;
    }

    /** Route a session/update instead of queueing it for its session; true when routed. */
    protected routeSessionUpdate(_sessionId: string | undefined, _msg: AcpIncomingNotification): boolean {
        return false;
    }

    /** A session/update was queued or routed: the profile's onSessionUpdate sees it. */
    protected afterSessionUpdate(sessionId: string | undefined, msg: AcpIncomingNotification): void {
        if (sessionId && msg.params?.update) this.profile.onSessionUpdate?.(sessionId, msg.params.update, this.handlerContext());
    }

    /** A notification other than session/update: the profile's handleNotification sees it. */
    protected handleNotification(msg: AcpIncomingNotification): void {
        this.profile.handleNotification?.(msg, this.handlerContext());
    }

    /** prompt() was called; it has not reserved the session yet. */
    protected onPromptRequested(_sessionId: string, _signal: AbortSignal | undefined): void {}

    /** Updates a prompt yields first, after the queue is drained of the previous turn's leftovers. */
    protected promptPrelude(_sessionId: string): AcpUpdate[] {
        return [];
    }

    /** The prompt is about to be sent; what this returns is handed to onPromptEnding. */
    protected onPromptStart(_sessionId: string): unknown {
        return undefined;
    }

    /** The prompt's RPC settled (resolved or rejected); its stream may still be read. */
    protected onPromptSettled(_sessionId: string): void {}

    /** A sent prompt's stream ended; `rejected` when the agent refused the prompt. */
    protected onPromptEnding(_sessionId: string, _token: unknown, _rejected: boolean): void {}

    /**
     * After onPromptEnding and the prompt leaving activePrompts, before the
     * session is released: work the next turn must wait for. Return undefined
     * to add no wait.
     */
    protected onPromptEnded(_sessionId: string): Promise<void> | undefined {
        return undefined;
    }

    /** The session's info changed (see rememberSessionInfo). */
    protected onSessionInfoChanged(_sessionId: string): void {}

    /**
     * Checks before session/load; a rejection refuses the load. Return
     * undefined, not a resolved promise, to add no wait.
     */
    protected beforeLoadSession(_sessionId: string, _cwd: string, _timeoutMs: number | undefined): Promise<void> | undefined {
        return undefined;
    }

    /** Health counts this work too (see hasHealthyWork): restarting the process would end it. */
    protected hasBackgroundWork(): boolean {
        return false;
    }

    /** The session was quarantined (see quarantine). */
    protected onQuarantine(_sessionId: string): void {}

    /**
     * Route an injected update elsewhere: true or false is injectUpdate's
     * result; undefined queues it for the session as usual.
     */
    protected routeInjectedUpdate(_sessionId: string, _update: AcpUpdate): boolean | undefined {
        return undefined;
    }

    /**
     * cancel(…, { spareOvertakenWake }) with no prompt of ours out: true when
     * the only turn running is one the agent started on its own and it is left
     * to run (cancel then resolves true without a session/cancel).
     */
    protected spareBackgroundTurn(_sessionId: string): boolean {
        return false;
    }

    /** The session is being released; its permissions are already cancelled. */
    protected onDestroySession(_sessionId: string): void {}

    /** The process exited; pending requests, permissions and queues are already settled. */
    protected onProcessExit(): void {}

    /** Every pending request was failed with `error`. */
    protected onFailAllPending(_error: Error): void {}
}
