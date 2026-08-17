import { spawn, ChildProcess } from "child_process";
import * as perf from "../perf";
import { log } from "../logger";
import { startupMark } from "../startupTrace";
import { BACKEND_STREAM_PROBE_ENABLED, writeBackendStreamProbe } from "../streamProbe";
import { HEARTBEAT_INTERVAL_MS } from "../../config/constants";
import { createKiroProfile } from "./profiles/kiro";
import type {
    AcpHandlerContext,
    AcpInitializeResult,
    AcpProfile,
    AcpUpdate,
    AcpUserAnswer,
} from "./types";
import { formatMcpToolOutput, isPlaceholderToolOutput } from "./toolCallTranslate";

/**
 * Idle timeout for an ACP RPC — reset every time we see progress on the
 * same sessionId (any session/update notification). The RPC only dies if
 * the agent goes totally silent for this long. Set to 0 to disable.
 *
 * Historically this was a HARD timeout, which killed long-running turns
 * even when kiro was still actively producing tool calls / chunks.
 */
const DEFAULT_TIMEOUT_MS = (() => {
    const raw = process.env.ACP_TIMEOUT_MS;
    if (raw === undefined) return 180_000;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return 180_000;
    return n; // 0 is allowed and means "no timeout"
})();

// Prompt turns can legitimately spend many minutes inside a tool call without
// ACP session/update traffic. The SSE layer emits synthetic heartbeats for UI
// liveness, and users can still cancel the turn explicitly.
const PROMPT_TIMEOUT_MS = 0;
const MAX_RPC_ERROR_DATA_CHARS = 4 * 1024;

export interface ACPErrorDetails {
    method?: string;
    sessionId?: string;
    rpcCode?: unknown;
    rpcData?: unknown;
}

export class ACPError extends Error {
    readonly method?: string;
    readonly sessionId?: string;
    readonly rpcCode?: unknown;
    readonly rpcData?: unknown;

    constructor(message: string, details: ACPErrorDetails = {}) {
        super(message);
        this.name = new.target.name;
        this.method = details.method;
        this.sessionId = details.sessionId;
        this.rpcCode = details.rpcCode;
        this.rpcData = details.rpcData;
    }
}
export class ACPNotRunningError extends ACPError {}
export class ACPProcessExitedError extends ACPError {}

export type { AcpUpdate };

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

function rpcErrorDataForLog(value: unknown): string | undefined {
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

function isAcpProfile(value: unknown): value is AcpProfile {
    return !!value
        && typeof value === "object"
        && "runtimeId" in (value as object)
        && "spawnArgs" in (value as object)
        && "protocolVersion" in (value as object)
        && "binaryPath" in (value as object);
}

interface Pending {
    method: string;
    sessionId?: string;
    timeoutMs: number;
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout | null;
}

type SessionQueueItem = { update: AcpUpdate } | { done: true };

class SessionQueue {
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

export class AcpClient {
    private proc: ChildProcess | null = null;
    private nextId = 0;
    private pending = new Map<number, Pending>();
    private buffer = "";
    private sessionQueues = new Map<string, SessionQueue>();
    private sessionInFlight = new Map<string, Promise<void>>();
    private stopped = false;
    private exitError: Error | null = null;
    private exitListeners: Array<(err: Error) => void> = [];
    /** Tracks pending permission requests so we can respond later. */
    private pendingPermissions = new Map<number, { sessionId: string }>();
    private lastMetadata = new Map<string, any>();
    private rawProbeState = new Map<string, { seq: number; prevAt: number; startedAt: number }>();
    private lastPromptSessionId: string | null = null;
    /** Latest ACP toolCallId (+ last rawOutput) per session, for MCP result backfill. */
    private inflightToolBySession = new Map<string, { toolCallId: string; lastOutput: unknown }>();
    private nextIncomingUserInputId = 0;
    private pendingUserInputs = new Map<number, {
        sessionId?: string;
        resolve: (answers: AcpUserAnswer[] | null) => void;
    }>();
    private readonly profile: AcpProfile;
    private readonly binaryPath: string;
    private readonly cwd: string;
    private readonly model?: string;
    private initializeResult: AcpInitializeResult | null = null;

    /** Fires when the underlying process crashes or exits unexpectedly.
     *  ChatManager uses this to clear its cached client so the next request
     *  can respawn. */
    onExit(fn: (err: Error) => void): void {
        this.exitListeners.push(fn);
    }

    isAlive(): boolean {
        return !this.stopped && !this.exitError && !!this.proc;
    }

    /**
     * Compatibility constructor: `new AcpClient(binary, cwd, model)` is Kiro.
     * New runtimes pass an AcpProfile as the first argument.
     */
    constructor(
        binaryOrProfile: string | AcpProfile = createKiroProfile().binaryPath,
        cwd: string = process.cwd(),
        model?: string,
    ) {
        if (isAcpProfile(binaryOrProfile)) {
            this.profile = binaryOrProfile;
        } else {
            this.profile = createKiroProfile({
                binaryPath: binaryOrProfile,
                cwd,
                model,
            });
        }
        this.binaryPath = this.profile.binaryPath;
        this.cwd = this.profile.cwd;
        this.model = this.profile.model;
    }

    get runtimeId(): string {
        return this.profile.runtimeId;
    }

    /** Result of the last successful `initialize` (authMethods + agentCapabilities). */
    getInitializeResult(): AcpInitializeResult | null {
        return this.initializeResult;
    }

    private writeRawUpdateProbe(sessionId: string | undefined, method: string, update: unknown): void {
        if (!sessionId) return;
        const now = Date.now();
        const state = this.rawProbeState.get(sessionId) ?? { seq: 0, prevAt: 0, startedAt: now };
        state.seq += 1;
        writeBackendStreamProbe({
            phase: "raw_update",
            layer: "acp",
            runtimeId: this.profile.runtimeId,
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

        this.profile.preflight?.();

        const args = this.profile.spawnArgs;
        const label = this.profile.logLabel;
        startupMark(`${label}_spawn_start`, { cwd: this.cwd, binaryPath: this.binaryPath });
        this.proc = spawn(this.binaryPath, args, {
            cwd: this.cwd,
            stdio: ["pipe", "pipe", "pipe"],
            detached: true, // own process group for clean group-kill
            env: this.profile.spawnEnv
                ? { ...process.env, ...this.profile.spawnEnv }
                : undefined,
        });
        startupMark(`${label}_spawn_done`, { cwd: this.cwd, pid: this.proc.pid });
        perf.mark("acp:spawn_requested", { cwd: this.cwd, pid: this.proc.pid });
        const pid = this.proc.pid;
        log.info("acp", `${label} process spawned`, {
            pid,
            cwd: this.cwd,
            model: this.model,
            binaryPath: this.binaryPath,
        });

        this.proc.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
        this.proc.stderr!.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            process.stderr.write(`[acp stderr] ${text}`);
            log.acpStderr(text);
        });

        this.proc.on("error", (err) => {
            log.error("acp", `${label} process error`, {
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
            if (expected) log.info("acp", `${label} process exited`, exitMeta);
            else log.error("acp", `${label} process exited unexpectedly`, exitMeta);
            this.stopped = true;
            const err = new ACPProcessExitedError(`ACP process exited with code ${code}`);
            this.exitError = err;
            this.failAllPending(err);
            this.pendingPermissions.clear();
            for (const q of this.sessionQueues.values()) q.push({ done: true });
            this.proc = null;
            for (const fn of this.exitListeners) {
                try { fn(err); } catch {}
            }
        });
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

    private handlerContext(): AcpHandlerContext {
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

    private dispatch(msg: any): void {
        // Incoming JSON-RPC request from the agent (has both id and method).
        if (msg && msg.id !== undefined && msg.id !== null && "method" in msg) {
            if (msg.method === "session/request_permission") {
                const { sessionId, toolCall, options } = msg.params ?? {};
                if (sessionId && toolCall) this.trackInflightTool(sessionId, toolCall);
                const mapped = this.profile.mapPermissionOptions
                    ? this.profile.mapPermissionOptions(Array.isArray(options) ? options : [])
                    : options;
                const queue = sessionId ? this.sessionQueues.get(sessionId) : undefined;
                if (queue) {
                    queue.push({
                        update: {
                            sessionUpdate: "permission_request",
                            requestId: msg.id,
                            toolCall,
                            options: mapped,
                        },
                    });
                }
                if (sessionId) {
                    this.pendingPermissions.set(msg.id, { sessionId });
                }
                return;
            }

            const ctx = this.handlerContext();
            void Promise.resolve(this.profile.handleIncomingRequest?.(msg, ctx) ?? false)
                .then((handled) => {
                    if (!handled) {
                        this.writeResponse(msg.id, undefined, {
                            code: -32601,
                            message: `Method not found: ${msg.method}`,
                        });
                    }
                })
                .catch((err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err);
                    this.writeResponse(msg.id, undefined, { code: -32603, message });
                });
            return;
        }

        if (msg && msg.id !== undefined && msg.id !== null && ("result" in msg || "error" in msg)) {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            if (p.timer) clearTimeout(p.timer);
            if (msg.error) {
                const message = typeof msg.error?.message === "string" && msg.error.message
                    ? msg.error.message
                    : "unknown ACP error";
                log.error("acp", "rpc request failed", {
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
                p.reject(new ACPError(message, {
                    method: p.method,
                    sessionId: p.sessionId,
                    rpcCode: msg.error?.code,
                    rpcData: msg.error?.data,
                }));
            } else {
                p.resolve(msg.result);
            }
            return;
        }

        if (msg?.method === "session/update") {
            const sid: string | undefined = msg.params?.sessionId;
            if (sid && msg.params?.update) this.trackInflightTool(sid, msg.params.update);
            if (BACKEND_STREAM_PROBE_ENABLED) this.writeRawUpdateProbe(sid, "session/update", msg.params?.update);
            if (sid) {
                for (const p of this.pending.values()) {
                    if (p.sessionId === sid) this.resetIdleTimer(p);
                }
            }
            const q = sid ? this.sessionQueues.get(sid) : undefined;
            if (q) q.push({ update: msg.params });
            if (sid && msg.params?.update) {
                this.profile.onSessionUpdate?.(sid, msg.params.update, this.handlerContext());
            }
            return;
        }

        if (typeof msg?.method === "string") {
            const ctx = this.handlerContext();
            if (this.profile.handleNotification?.(msg, ctx)) return;
        }
    }

    private resetIdleTimer(p: Pending): void {
        if (p.timer) clearTimeout(p.timer);
        if (p.timeoutMs === 0) {
            p.timer = null;
            return;
        }
        p.timer = setTimeout(() => {
            for (const [id, entry] of this.pending) {
                if (entry === p) {
                    this.pending.delete(id);
                    break;
                }
            }
            p.reject(
                new ACPError(
                    `Request ${p.method} idle for ${p.timeoutMs}ms (no updates from agent)`,
                ),
            );
        }, p.timeoutMs);
    }

    private failAllPending(err: Error): void {
        for (const p of this.pending.values()) {
            if (p.timer) clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
        for (const entry of this.pendingUserInputs.values()) {
            entry.resolve(null);
        }
        this.pendingUserInputs.clear();
    }

    private notify(method: string, params?: any): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.stopped || this.exitError) {
                reject(new ACPNotRunningError(this.exitError?.message || "ACP process stopped"));
                return;
            }
            if (!this.proc?.stdin || this.proc.stdin.destroyed) {
                reject(new ACPNotRunningError("ACP process is not running"));
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

    private send(
        method: string,
        params?: any,
        timeoutMs: number = DEFAULT_TIMEOUT_MS,
        sessionId?: string,
    ): Promise<any> {
        return new Promise((resolve, reject) => {
            if (this.stopped || this.exitError) {
                reject(new ACPNotRunningError(this.exitError?.message || "ACP process stopped"));
                return;
            }
            if (!this.proc?.stdin || this.proc.stdin.destroyed) {
                reject(new ACPNotRunningError("ACP process is not running"));
                return;
            }
            const id = this.nextId++;
            const p: Pending = {
                method,
                sessionId,
                timeoutMs,
                resolve,
                reject,
                timer: null,
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

    async initialize(): Promise<AcpInitializeResult> {
        const t0 = perf.now();
        const label = this.profile.logLabel;
        startupMark(`${label}_initialize_start`, { cwd: this.cwd });
        const result = (await this.send("initialize", {
            protocolVersion: this.profile.protocolVersion,
            clientInfo: this.profile.clientInfo,
            clientCapabilities: this.profile.clientCapabilities,
        })) ?? {};
        this.initializeResult = result;
        if (this.profile.buildAuthenticate) {
            const auth = this.profile.buildAuthenticate(result);
            if (auth) {
                await this.send("authenticate", auth);
            }
        }
        startupMark(`${label}_initialize_done`, { cwd: this.cwd });
        perf.measure("acp:initialize", t0, { cwd: this.cwd });
        return result;
    }

    async newSession(mcpServers: Array<{ name: string; type?: "http"; url?: string; command?: string; args?: string[]; headers?: [] }> = []): Promise<{ sessionId: string; modes?: any; models?: any; configOptions?: any }> {
        const t0 = perf.now();
        const label = this.profile.logLabel;
        startupMark(`${label}_session_new_start`, { cwd: this.cwd, mcpServerCount: mcpServers.length });
        const result = await this.send("session/new", { cwd: this.cwd, mcpServers });
        const sid = result.sessionId as string;
        this.sessionQueues.set(sid, new SessionQueue());
        startupMark(`${label}_session_new_done`, { cwd: this.cwd, sessionId: sid, mcpServerCount: mcpServers.length });
        perf.measure("acp:session_new", t0, { cwd: this.cwd, sessionId: sid });
        return { sessionId: sid, modes: result.modes, models: result.models, configOptions: result.configOptions };
    }

    async loadSession(
        sessionId: string,
        cwd: string,
        mcpServers: Array<{ name: string; type?: "http"; url?: string; command?: string; args?: string[]; headers?: [] }> = [],
    ): Promise<{ modes?: any; models?: any }> {
        const t0 = perf.now();
        if (!this.sessionQueues.has(sessionId)) {
            this.sessionQueues.set(sessionId, new SessionQueue());
        }
        const result = await this.send(
            "session/load",
            { sessionId, cwd, mcpServers },
            DEFAULT_TIMEOUT_MS,
            sessionId,
        );
        const q = this.sessionQueues.get(sessionId);
        if (q) q.drain();
        perf.measure("acp:session_load", t0, { cwd, sessionId });
        return { modes: result?.modes, models: result?.models };
    }

    async setMode(sessionId: string, modeId: string): Promise<void> {
        await this.send("session/set_mode", { sessionId, modeId });
    }

    async setModel(sessionId: string, modelId: string): Promise<void> {
        await this.send("session/set_model", { sessionId, modelId });
    }

    /** Inject an out-of-band synthetic session/update into the session queue.
     *  Used by ChatManager to surface events (like spawn_branches) that
     *  originate outside the ACP transport. No-op if the session doesn't exist. */
    injectUpdate(sessionId: string, update: AcpUpdate): void {
        const q = this.sessionQueues.get(sessionId);
        if (!q) return;
        q.push({ update });
    }

    /**
     * After a Michi HTTP MCP tools/call completes, push the real result onto
     * the in-flight ACP tool card. Conservative: requires a known toolCallId
     * for this session, an in-flight prompt, and a missing / `{success:true}`
     * current output. Does not invent a toolCallId.
     */
    backfillToolOutput(sessionId: string, result: unknown): boolean {
        if (!this.sessionInFlight.has(sessionId)) return false;
        const inflight = this.inflightToolBySession.get(sessionId);
        if (!inflight?.toolCallId) return false;
        if (!isPlaceholderToolOutput(inflight.lastOutput)) return false;
        const output = formatMcpToolOutput(result);
        this.injectUpdate(sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: inflight.toolCallId,
            rawOutput: output,
        });
        inflight.lastOutput = output;
        return true;
    }

    private trackInflightTool(sessionId: string, update: any): void {
        const id = typeof update?.toolCallId === "string" ? update.toolCallId : "";
        if (!id) return;
        const kind = update?.sessionUpdate;
        if (kind && kind !== "tool_call" && kind !== "tool_call_update") return;
        const prev = this.inflightToolBySession.get(sessionId);
        let lastOutput: unknown;
        if (update && Object.prototype.hasOwnProperty.call(update, "rawOutput")) {
            lastOutput = update.rawOutput;
        } else if (prev && prev.toolCallId === id) {
            lastOutput = prev.lastOutput;
        }
        this.inflightToolBySession.set(sessionId, { toolCallId: id, lastOutput });
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
    ): AsyncIterableIterator<AcpUpdate> {
        const tPromptIn = perf.now();
        perf.mark("acp:prompt_entered", { sid: sessionId, textLen: text.length });
        this.lastPromptSessionId = sessionId;
        const q = this.sessionQueues.get(sessionId);
        if (!q) throw new ACPError(`unknown session: ${sessionId}`);

        const prev = this.sessionInFlight.get(sessionId);
        if (prev) await prev.catch(() => {});

        q.drain();
        this.inflightToolBySession.delete(sessionId);
        if (BACKEND_STREAM_PROBE_ENABLED) this.rawProbeState.delete(sessionId);

        const preTurnMeta = this.lastMetadata.get(sessionId);
        if (preTurnMeta && !preTurnMeta.meteringUsage) {
            this.lastMetadata.delete(sessionId);
            q.push({ update: {
                sessionUpdate: "context_usage",
                contextUsagePercentage: preTurnMeta.contextUsagePercentage,
            }});
        }

        let lastActivity = Date.now();
        const heartbeat = setInterval(() => {
            const idle = Date.now() - lastActivity;
            if (idle >= HEARTBEAT_INTERVAL_MS) {
                q.push({ update: { sessionUpdate: "__heartbeat__", idleMs: idle } });
            }
        }, HEARTBEAT_INTERVAL_MS);

        let promptResult: any;
        let promptError: Error | null = null;
        const sendPromise = this.send(
            "session/prompt",
            { sessionId, prompt: [{ type: "text", text }, ...extraBlocks] },
            PROMPT_TIMEOUT_MS,
            sessionId,
        )
            .then((r) => {
                promptResult = r;
                q.push({ update: { sessionUpdate: "__send_complete__" } });
            })
            .catch((e) => {
                promptError = e as Error;
                q.push({ update: { sessionUpdate: "__send_complete__" } });
            });
        this.sessionInFlight.set(sessionId, sendPromise);

        let firstRealUpdateSeen = false;
        let firstChunkSeen = false;
        try {
            while (true) {
                const item = await q.get();
                if ("done" in item) {
                    throw new ACPProcessExitedError("ACP process exited mid-prompt");
                }
                const update = item.update.update || item.update;
                const kind = update?.sessionUpdate;

                if (kind === "__heartbeat__") {
                    yield update;
                    continue;
                }

                if (!firstRealUpdateSeen && kind !== "__send_complete__") {
                    firstRealUpdateSeen = true;
                    perf.measure("acp:prompt_to_first_update", tPromptIn, { sid: sessionId, kind });
                }
                if (!firstChunkSeen && kind === "agent_message_chunk") {
                    firstChunkSeen = true;
                    perf.measure("acp:prompt_to_first_chunk", tPromptIn, { sid: sessionId });
                }

                if (kind === "__send_complete__") {
                    if (promptError) throw promptError;
                    const stop = promptResult?.stopReason;
                    const buffered = this.lastMetadata.get(sessionId);
                    if (buffered?.meteringUsage) {
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

                lastActivity = Date.now();
                yield update;

                if (kind === "turn_end") return;
            }
        } finally {
            clearInterval(heartbeat);
            await sendPromise.catch(() => {});
            if (this.sessionInFlight.get(sessionId) === sendPromise) {
                this.sessionInFlight.delete(sessionId);
            }
        }
    }

    /** Send a JSON-RPC response to a pending permission request, selecting an option. */
    respondToPermission(requestId: number, optionId: string): void {
        const pending = this.pendingPermissions.get(requestId);
        if (!pending) return;
        this.pendingPermissions.delete(requestId);
        if (!this.proc?.stdin || this.proc.stdin.destroyed) return;
        const payload = JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            result: { outcome: { outcome: "selected", optionId } },
        });
        this.proc.stdin.write(payload + "\n");
    }

    /** Send a JSON-RPC response to a pending permission request, cancelling it. */
    cancelPermission(requestId: number): void {
        const pending = this.pendingPermissions.get(requestId);
        if (!pending) return;
        this.pendingPermissions.delete(requestId);
        if (!this.proc?.stdin || this.proc.stdin.destroyed) return;
        const payload = JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            result: { outcome: { outcome: "cancelled" } },
        });
        this.proc.stdin.write(payload + "\n");
    }

    /** Cancel all pending permission requests for a given session. */
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

    async cancel(sessionId: string): Promise<void> {
        if (!this.sessionQueues.has(sessionId)) return;
        this.cancelPermissionsForSession(sessionId);
        try {
            await this.notify("session/cancel", { sessionId });
        } catch {
            // best-effort
        }
    }

    destroySession(sessionId: string): void {
        this.sessionQueues.delete(sessionId);
        this.inflightToolBySession.delete(sessionId);
    }

    async shutdown(): Promise<void> {
        this.stopped = true;
        const proc = this.proc;
        if (!proc) return;
        const pid = proc.pid;

        try {
            if (pid) process.kill(-pid, "SIGTERM");
        } catch {}

        const exited = await new Promise<boolean>((resolve) => {
            const t = setTimeout(() => resolve(false), 5000);
            proc.once("exit", () => {
                clearTimeout(t);
                resolve(true);
            });
        });

        if (!exited && pid) {
            try {
                process.kill(-pid, "SIGKILL");
            } catch {}
        }

        this.proc = null;
        this.sessionQueues.clear();
        this.pendingPermissions.clear();
        this.failAllPending(new ACPNotRunningError("client shut down"));
    }
}
