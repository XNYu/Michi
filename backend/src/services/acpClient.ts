import { spawn, ChildProcess } from "child_process";
import { existsSync, readdirSync, accessSync, constants as fsConstants } from "fs";
import { homedir } from "os";
import { join } from "path";
import * as perf from "./perf";
import { log } from "./logger";
import { startupMark } from "./startupTrace";
import { BACKEND_STREAM_PROBE_ENABLED, writeBackendStreamProbe } from "./streamProbe";
import { HEARTBEAT_INTERVAL_MS } from "../config/constants";

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

export type AcpUpdate = Record<string, any>;

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

function findKiroCli(): string {
    const env = process.env.KIRO_CLI_BIN;
    if (env && existsSync(env)) return env;

    const home = homedir();

    const local = join(home, ".local", "bin", "kiro-cli");
    try {
        // existsSync follows symlinks, so a dangling link returns false.
        if (existsSync(local)) {
            accessSync(local, fsConstants.X_OK);
            return local;
        }
    } catch {}

    const toolsDir = join(home, ".toolbox", "tools", "kiro-cli");
    try {
        const versions = readdirSync(toolsDir)
            .map((name) => ({
                name,
                parts: name.split(".").map((x) => (/^\d+$/.test(x) ? Number(x) : 0)),
            }))
            .sort((a, b) => {
                for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
                    const av = a.parts[i] ?? 0;
                    const bv = b.parts[i] ?? 0;
                    if (av !== bv) return bv - av;
                }
                return 0;
            });
        for (const v of versions) {
            const cand = join(toolsDir, v.name, "Kiro CLI.app", "Contents", "MacOS", "kiro-cli");
            if (existsSync(cand)) {
                try {
                    accessSync(cand, fsConstants.X_OK);
                    return cand;
                } catch {}
            }
        }
    } catch {}

    for (const p of (process.env.PATH || "").split(":")) {
        if (!p) continue;
        const cand = join(p, "kiro-cli");
        if (existsSync(cand)) {
            try {
                accessSync(cand, fsConstants.X_OK);
                return cand;
            } catch {}
        }
    }

    return join(home, ".toolbox", "bin", "kiro-cli");
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
    /** Tracks pending permission requests from kiro-cli so we can respond later. */
    private pendingPermissions = new Map<number, { sessionId: string }>();
    /** Maps cwd-scoped session → whether it currently owns an active agent tool_call.
     *  Used to infer which session owns incoming _kiro.dev/subagent/list_update events
     *  (which lack a sessionId field). When multiple sessions have active agent calls,
     *  the MOST RECENT one wins — matching kiro-cli's internal behavior. */
    private subagentOwnerSession: string | null = null;
    /** Tracks the tool_call id that established ownership, so we can release it
     *  when that specific call completes rather than on any tool_call_update. */
    private subagentOwnerToolCallId: string | null = null;
    private lastMetadata = new Map<string, any>();
    /** Maps subagent sessionId → parent sessionId for tool activity forwarding. */
    private subagentParentMap = new Map<string, string>();
    private rawProbeState = new Map<string, { seq: number; prevAt: number; startedAt: number }>();

    /** Fires when the underlying process crashes or exits unexpectedly.
     *  ChatManager uses this to clear its cached client so the next request
     *  can respawn. */
    onExit(fn: (err: Error) => void): void {
        this.exitListeners.push(fn);
    }

    isAlive(): boolean {
        return !this.stopped && !this.exitError && !!this.proc;
    }

    constructor(
        private readonly binaryPath: string = findKiroCli(),
        private readonly cwd: string = process.cwd(),
        private readonly model?: string,
    ) {}

    private writeRawUpdateProbe(sessionId: string | undefined, method: string, update: unknown): void {
        if (!sessionId) return;
        const now = Date.now();
        const state = this.rawProbeState.get(sessionId) ?? { seq: 0, prevAt: 0, startedAt: now };
        state.seq += 1;
        writeBackendStreamProbe({
            phase: "raw_update",
            layer: "acp",
            runtimeId: "kiro",
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

        const args = ["acp", "-a"];
        if (this.model) args.push("--model", this.model);

        startupMark("kiro_spawn_start", { cwd: this.cwd, binaryPath: this.binaryPath });
        this.proc = spawn(this.binaryPath, args, {
            cwd: this.cwd,
            stdio: ["pipe", "pipe", "pipe"],
            detached: true, // own process group for clean group-kill
        });
        startupMark("kiro_spawn_done", { cwd: this.cwd, pid: this.proc.pid });
        perf.mark("acp:spawn_requested", { cwd: this.cwd, pid: this.proc.pid });
        const pid = this.proc.pid;
        log.info("acp", "kiro process spawned", {
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
            log.error("acp", "kiro process error", {
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
            if (expected) log.info("acp", "kiro process exited", exitMeta);
            else log.error("acp", "kiro process exited unexpectedly", exitMeta);
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

    private dispatch(msg: any): void {

        // Incoming JSON-RPC request from kiro-cli (has both id and method).
        // Currently only session/request_permission uses this pattern.
        if (msg && msg.id !== undefined && msg.id !== null && 'method' in msg) {
            if (msg.method === 'session/request_permission') {
                const { sessionId, toolCall, options } = msg.params ?? {};
                const queue = sessionId ? this.sessionQueues.get(sessionId) : undefined;
                if (queue) {
                    queue.push({
                        update: {
                            sessionUpdate: 'permission_request',
                            requestId: msg.id,
                            toolCall,
                            options,
                        },
                    });
                }
                if (sessionId) {
                    this.pendingPermissions.set(msg.id, { sessionId });
                }
            }
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
            if (BACKEND_STREAM_PROBE_ENABLED) this.writeRawUpdateProbe(sid, "session/update", msg.params?.update);
            // Any progress on this session resets the idle timer for the
            // in-flight session/prompt RPC — kiro is visibly still working.
            if (sid) {
                for (const p of this.pending.values()) {
                    if (p.sessionId === sid) this.resetIdleTimer(p);
                }
            }
            const q = sid ? this.sessionQueues.get(sid) : undefined;
            if (q) q.push({ update: msg.params });
            // Track subagent ownership: when a tool_call title matches
            // subagent-related patterns, record the sessionId as the owner.
            const updateKind = msg.params?.update?.sessionUpdate;
            if (updateKind === "tool_call" && sid) {
                const title = String(msg.params?.update?.title ?? "").trim().toLowerCase();
                if (
                    title === "agent" ||
                    title === "task" ||
                    title.includes("subagent") ||
                    title.includes("agent crew") ||
                    title.includes("spawn")
                ) {
                    this.subagentOwnerSession = sid;
                    this.subagentOwnerToolCallId = msg.params?.update?.toolCallId ?? null;
                }
            }
            // Release subagent ownership when the owning tool_call completes,
            // preventing stale ownership from routing a different session's
            // subagent events to the wrong parent.
            if (updateKind === "tool_call_update" && sid === this.subagentOwnerSession) {
                const status = msg.params?.update?.status;
                const toolCallId = msg.params?.update?.toolCallId;
                if (
                    toolCallId === this.subagentOwnerToolCallId &&
                    (status === "completed" || status === "error")
                ) {
                    this.subagentOwnerSession = null;
                    this.subagentOwnerToolCallId = null;
                    this.subagentParentMap.clear();
                }
            }
            // Forward subagent tool_call events to the parent session
            // so the UI can show what each subagent is doing.
            if (sid && (updateKind === "tool_call" || updateKind === "tool_call_update")) {
                const parentSid = this.subagentParentMap.get(sid);
                if (parentSid) {
                    const update = msg.params?.update ?? {};
                    const parentQ = this.sessionQueues.get(parentSid);
                    if (parentQ) {
                        parentQ.push({ update: {
                            sessionUpdate: "subagent_tool_activity",
                            subagentSessionId: sid,
                            toolCallId: update.toolCallId ?? "",
                            title: update.title ?? "",
                            status: update.status ?? "",
                            kind: update.kind ?? "",
                        }});
                    }
                }
            }
        }

        // _kiro.dev/* methods — route updates to the appropriate session queue.

        // _kiro.dev/session/update — Kiro extension session updates (e.g. tool_call_chunk).
        // These mirror session/update but on a separate channel.
        if (msg?.method === "_kiro.dev/session/update") {
            const sid: string | undefined = msg.params?.sessionId;
            if (BACKEND_STREAM_PROBE_ENABLED) this.writeRawUpdateProbe(sid, "_kiro.dev/session/update", msg.params?.update);
            if (sid) {
                for (const p of this.pending.values()) {
                    if (p.sessionId === sid) this.resetIdleTimer(p);
                }
            }
            // Forward to session queue as-is (tool_call_chunk etc.)
            const q = sid ? this.sessionQueues.get(sid) : undefined;
            if (q) q.push({ update: msg.params });
        }

        // _kiro.dev/subagent/list_update — no sessionId in payload.
        // Route to the session that owns the subagent tool call.
        if (msg?.method === "_kiro.dev/subagent/list_update") {
            const params = msg.params ?? {};
            const targetSid = this.subagentOwnerSession;
            if (targetSid) {
                // Build subagent→parent mapping so we can forward their tool_calls
                const subagents = params.subagents ?? [];
                for (const sa of subagents) {
                    if (sa.sessionId) this.subagentParentMap.set(sa.sessionId, targetSid);
                }
                const q = this.sessionQueues.get(targetSid);
                if (q) {
                    q.push({ update: {
                        sessionUpdate: "subagent_list_update",
                        subagents,
                    }});
                }
            }
            // Clear owner and parent map when subagent list empties (all done)
            if ((params.subagents ?? []).length === 0) {
                this.subagentOwnerSession = null;
                this.subagentParentMap.clear();
            }
        }

        // _kiro.dev/mcp/server_init_failure — MCP server failed to initialize.
        if (msg?.method === "_kiro.dev/mcp/server_init_failure") {
            const params = msg.params ?? {};
            const sid: string | undefined = typeof params.sessionId === "string" ? params.sessionId : undefined;
            log.error("mcp", "kiro mcp server initialization failed", {
                pid: this.proc?.pid,
                cwd: this.cwd,
                model: this.model,
                sessionId: sid,
                serverName: params.serverName ?? "",
                error: rpcErrorDataForLog(params.error),
            });
            const q = sid ? this.sessionQueues.get(sid) : undefined;
            if (q) {
                q.push({ update: {
                    sessionUpdate: "mcp_server_error",
                    serverName: params.serverName ?? "",
                    error: params.error ?? "",
                }});
            }
        }

        if (msg?.method === "_kiro.dev/session/inbox_notification") {
            const params = msg.params ?? {};
            const sid = typeof params.sessionId === "string" ? params.sessionId : undefined;
            if (sid) {
                console.log(`[acp] inbox notification for session ${sid}: ${params.messageCount ?? 0} message(s) from ${(params.senders ?? []).join(', ')}`);
            }
        }

        // _kiro.dev/mcp/server_initialized — skipped, noisy
        // _kiro.dev/commands/available — skipped, future command palette feature

        if (msg?.method === "_kiro.dev/metadata") {
            const params = msg.params ?? {};
            const sid: string | undefined = typeof params.sessionId === "string" ? params.sessionId : undefined;
            if (sid) {
                for (const p of this.pending.values()) {
                    if (p.sessionId === sid) this.resetIdleTimer(p);
                }
            }
            if (sid && params.meteringUsage) {
                // Turn-end metadata with usage summary — buffer only.
                // prompt() will yield it before turn_end. Do NOT also push
                // to the queue, or it will be emitted twice.
                this.lastMetadata.set(sid, params);
            } else if (sid) {
                // Mid-turn or between-turn metadata — context usage only.
                // Also buffer (prompt() drain would clear queued items).
                // If a prompt is in-flight, also push to queue for immediate delivery.
                this.lastMetadata.set(sid, params);
                if (this.sessionInFlight.has(sid)) {
                    const q = this.sessionQueues.get(sid);
                    if (q) {
                        q.push({ update: {
                            sessionUpdate: "context_usage",
                            contextUsagePercentage: params.contextUsagePercentage,
                        }});
                    }
                }
            }
        }
    }

    private resetIdleTimer(p: Pending): void {
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

    async initialize(): Promise<void> {
        const t0 = perf.now();
        startupMark("kiro_initialize_start", { cwd: this.cwd });
        await this.send("initialize", {
            protocolVersion: "2025-01-01",
            clientInfo: { name: "michi", version: "1.0.0" },
            clientCapabilities: {},
        });
        startupMark("kiro_initialize_done", { cwd: this.cwd });
        perf.measure("acp:initialize", t0, { cwd: this.cwd });
    }

    async newSession(mcpServers: Array<{ name: string; type?: "http"; url?: string; command?: string; args?: string[]; headers?: [] }> = []): Promise<{ sessionId: string; modes?: any; models?: any; configOptions?: any }> {
        const t0 = perf.now();
        startupMark("kiro_session_new_start", { cwd: this.cwd, mcpServerCount: mcpServers.length });
        const result = await this.send("session/new", { cwd: this.cwd, mcpServers });
        const sid = result.sessionId as string;
        this.sessionQueues.set(sid, new SessionQueue());
        startupMark("kiro_session_new_done", { cwd: this.cwd, sessionId: sid, mcpServerCount: mcpServers.length });
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
     * Stream session/update events for a single prompt turn. Ends with a
     * synthetic `{ sessionUpdate: "turn_end", stopReason }` item so callers
     * have a uniform sentinel. Also emits synthetic
     * `{ sessionUpdate: "__heartbeat__", idleMs }` items every
     * HEARTBEAT_INTERVAL_MS during silence so downstream SSE consumers can
     * tell "still working" from "stuck".
     */
    async *prompt(sessionId: string, text: string): AsyncIterableIterator<AcpUpdate> {
        const tPromptIn = perf.now();
        perf.mark("acp:prompt_entered", { sid: sessionId, textLen: text.length });
        const q = this.sessionQueues.get(sessionId);
        if (!q) throw new ACPError(`unknown session: ${sessionId}`);

        // Wait for any previous turn on this session to finish its RPC reply
        // (e.g. a cancelled turn whose session/prompt reply is still in-flight).
        // kiro rejects overlapping session/prompt calls on the same session.
        const prev = this.sessionInFlight.get(sessionId);
        if (prev) await prev.catch(() => {});

        // Discard any leftover items from a previously cancelled turn on this
        // session (final chunks, tool_call_updates, and the __send_complete__
        // sentinel from the prior prompt). Without this, the next turn's
        // stream would begin with stale content.
        q.drain();
        if (BACKEND_STREAM_PROBE_ENABLED) this.rawProbeState.delete(sessionId);

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
            { sessionId, prompt: [{ type: "text", text }] },
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
                    // Synthetic — don't touch lastActivity so idle keeps growing.
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
                    // Yield any buffered usage_summary that arrived via _kiro.dev/metadata
                    // BEFORE turn_end, because michi.ts breaks the loop on turn_end.
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

                // Real update from kiro — reset the idle clock.
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
            jsonrpc: '2.0',
            id: requestId,
            result: { outcome: { outcome: 'selected', optionId } },
        });
        this.proc.stdin.write(payload + '\n');
    }

    /** Send a JSON-RPC response to a pending permission request, cancelling it. */
    cancelPermission(requestId: number): void {
        const pending = this.pendingPermissions.get(requestId);
        if (!pending) return;
        this.pendingPermissions.delete(requestId);
        if (!this.proc?.stdin || this.proc.stdin.destroyed) return;
        const payload = JSON.stringify({
            jsonrpc: '2.0',
            id: requestId,
            result: { outcome: { outcome: 'cancelled' } },
        });
        this.proc.stdin.write(payload + '\n');
    }

    /** Cancel all pending permission requests for a given session. */
    cancelPermissionsForSession(sessionId: string): void {
        for (const [reqId, entry] of this.pendingPermissions) {
            if (entry.sessionId === sessionId) {
                this.cancelPermission(reqId);
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

export { findKiroCli };
