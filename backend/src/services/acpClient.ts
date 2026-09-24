import { ChildProcess } from "child_process";
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { killProcessTree, spawnAgentProcess } from "../agents/processTree";
import {
    exeName,
    findInDir,
    findOnPath,
    isRunnableFile,
} from "../agents/executableLookup";
import * as perf from "./perf";
import { log } from "./logger";
import { startupMark } from "./startupTrace";
import { BACKEND_STREAM_PROBE_ENABLED, writeBackendStreamProbe } from "./streamProbe";
import { HEARTBEAT_INTERVAL_MS } from "../config/constants";
import {
    kiroArgs, kiroSessionMeta, normalizeSessionInfo, rewindPoints, v3InfoUpdates,
    type KiroEngine, type AcpInitializeResult, type AcpMcpServer, type AcpSessionInfo,
    type AcpSessionOptions, type AcpConfigOption,
} from '../agents/kiro/kiroProtocol';

/**
 * Compatibility surface for the shared ACP client.
 *
 * The Kiro-hardcoded implementation used to live in this file. Transport now
 * lives in `./acp/client.ts`; Kiro is a profile (`./acp/profiles/kiro.ts`).
 * Existing imports (`AcpClient`, `findKiroCli`, `ACPError`, …) keep working.
 * `new AcpClient(binary, cwd, model)` still constructs a Kiro client.
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


import { ACPError, ACPNotRunningError, ACPProcessExitedError, ACPSessionRecoveryRequiredError } from "./acp/errors";
export { ACPError, ACPNotRunningError, ACPProcessExitedError, ACPSessionRecoveryRequiredError } from "./acp/errors";
export type { ACPErrorDetails } from "./acp/errors";

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

function newestVersionDirs(toolsDir: string): string[] {
    try {
        return readdirSync(toolsDir)
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
            })
            .map((v) => v.name);
    } catch {
        return [];
    }
}

function findKiroCli(): string {
    const env = process.env.KIRO_CLI_BIN;
    if (env && existsSync(env)) return env;

    const home = homedir();
    const local = findInDir(join(home, ".local", "bin"), "kiro-cli");
    if (local) return local;

    if (process.platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
        const toolboxBin = findInDir(join(localAppData, "Toolbox", "bin"), "kiro-cli");
        if (toolboxBin) return toolboxBin;
        const kiroCliDir = findInDir(join(localAppData, "Kiro-Cli"), "kiro-cli");
        if (kiroCliDir) return kiroCliDir;
    }

    if (process.platform === "darwin") {
        const toolsDir = join(home, ".toolbox", "tools", "kiro-cli");
        for (const version of newestVersionDirs(toolsDir)) {
            const cand = join(toolsDir, version, "Kiro CLI.app", "Contents", "MacOS", "kiro-cli");
            if (isRunnableFile(cand)) return cand;
        }
    }

    if (process.platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
        const toolsDir = join(localAppData, "Toolbox", "tools", "kiro-cli");
        for (const version of newestVersionDirs(toolsDir)) {
            const cand = findInDir(join(toolsDir, version), "kiro-cli");
            if (cand) return cand;
        }
    }

    const onPath = findOnPath("kiro-cli");
    if (onPath) return onPath;

    // Historical fallback: return the conventional toolbox path even if missing
    // so callers can surface a concrete path in error messages. Callers that
    // need to know whether kiro-cli is actually installed must use
    // probeKiroCli() — this function's return value proves nothing.
    if (process.platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
        return join(localAppData, "Toolbox", "bin", exeName("kiro-cli"));
    }
    return join(home, ".toolbox", "bin", "kiro-cli");
}

/**
 * Is kiro-cli actually present and runnable?
 *
 * findKiroCli() deliberately falls back to a conventional path that need not
 * exist, so its result cannot be used as an install check. This re-tests the
 * resolved path and is the only honest signal Michi has short of spawning the
 * binary. Filesystem-only, so it is safe to call from a status request.
 */
export function probeKiroCli(): { path: string; installed: boolean } {
    const path = findKiroCli();
    return { path, installed: isRunnableFile(path) };
}

interface Pending {
    method: string;
    sessionId?: string;
    timeoutMs: number;
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout | null;
    hardTimeout?: boolean;
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
    /** Full prompt lifetimes, including the consumer's final queue cleanup. */
    private sessionInFlight = new Map<string, Promise<void>>();
    private readonly quarantinedSessions = new Set<string>();
    private readonly cancelTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly cancelTimeoutMs = 5_000;
    private stopped = false;
    private exitError: Error | null = null;
    private exitListeners: Array<(err: Error) => void> = [];
    /** Tracks pending permission requests from kiro-cli so we can respond later. */
    private pendingPermissions = new Map<number, { sessionId: string; options?: any[]; meta?: any }>();
    private initialization: AcpInitializeResult | null = null;
    private readonly sessionInfo = new Map<string, AcpSessionInfo>();
    private readonly lastUserMessageId = new Map<string, string>();
    private readonly loadingSessions = new Set<string>();
    private readonly mcpStatus = new Map<string, any[]>();
    private readonly mcpErrors = new Map<string, Set<string>>();
    private readonly steeredSessions = new Set<string>();
    private readonly activePrompts = new Set<string>();
    private readonly steerRequests = new Map<string, Set<Promise<unknown>>>();
    private readonly cancelledPrompts = new Set<string>();
    private readonly compactions = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
    private readonly compactingSessions = new Set<string>();
    /** Maps active agent tool_call ids → owning session ids.
     *  Used to infer which session owns incoming _kiro.dev/subagent/list_update
     *  events (which lack a sessionId field). When only one entry exists, routing
     *  is deterministic. When multiple sessions have concurrent agent calls,
     *  the most recently registered one wins — matching kiro-cli's behavior.
     *  Entries are removed when the corresponding tool_call completes/errors. */
    private subagentOwners = new Map<string, string>(); // toolCallId → sessionId
    /** Insertion-order counter so we can pick the most recent owner on ambiguity. */
    private subagentOwnerSeq = 0;
    private subagentOwnerOrder = new Map<string, number>(); // toolCallId → seq
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

    needsSessionRecovery(sessionId: string): boolean {
        return this.quarantinedSessions.has(sessionId);
    }

    hasSession(sessionId: string): boolean {
        return this.sessionQueues.has(sessionId) && !this.needsSessionRecovery(sessionId);
    }

    hasUnconfirmedExit(): boolean {
        return this.stopped && this.proc !== null;
    }

    /** Restart only when no healthy session or control RPC owns this process. */
    hasHealthyWork(): boolean {
        return [...this.sessionInFlight.keys()].some((sid) => !this.quarantinedSessions.has(sid))
            || [...this.pending.values()].some((p) => !p.sessionId || !this.quarantinedSessions.has(p.sessionId));
    }

    private assertSessionUsable(sessionId: string): void {
        if (this.needsSessionRecovery(sessionId)) {
            throw new ACPSessionRecoveryRequiredError(
                'The previous Kiro turn did not stop. The original session needs recovery before another message can be sent.',
                { sessionId },
            );
        }
    }

    private clearCancelTimer(sessionId: string): void {
        clearTimeout(this.cancelTimers.get(sessionId));
        this.cancelTimers.delete(sessionId);
    }

    /** Resolve the session that should receive subagent list_update events.
     *  With one active owner → deterministic. Multiple → most recently registered.
     *  None → null (event is discarded). */
    private resolveSubagentOwner(): string | null {
        if (this.subagentOwners.size === 0) return null;
        if (this.subagentOwners.size === 1) {
            return this.subagentOwners.values().next().value!;
        }
        // Multiple concurrent owners — pick the most recently registered (highest seq).
        let bestToolCallId: string | null = null;
        let bestSeq = -1;
        for (const [toolCallId] of this.subagentOwners) {
            const seq = this.subagentOwnerOrder.get(toolCallId) ?? 0;
            if (seq > bestSeq) {
                bestSeq = seq;
                bestToolCallId = toolCallId;
            }
        }
        return bestToolCallId ? this.subagentOwners.get(bestToolCallId) ?? null : null;
    }

    constructor(
        private readonly binaryPath: string = findKiroCli(),
        private readonly cwd: string = process.cwd(),
        private readonly model?: string,
        public readonly engine: KiroEngine = 'v2',
    ) {}

    get capabilities(): AcpInitializeResult['agentCapabilities'] {
        return this.initialization?.agentCapabilities;
    }

    getSessionInfo(sessionId: string): AcpSessionInfo | undefined {
        return this.sessionInfo.get(sessionId);
    }

    getLastUserMessageId(sessionId: string): string | undefined {
        return this.lastUserMessageId.get(sessionId);
    }

    private rememberSessionInfo(sessionId: string, info: AcpSessionInfo): AcpSessionInfo {
        const normalized = normalizeSessionInfo({ ...this.sessionInfo.get(sessionId), ...info });
        this.sessionInfo.set(sessionId, normalized);
        return normalized;
    }

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

        const args = kiroArgs(this.engine, this.model);

        startupMark("kiro_spawn_start", { cwd: this.cwd, binaryPath: this.binaryPath });
        this.proc = spawnAgentProcess(this.binaryPath, args, {
            cwd: this.cwd,
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

        // An expired cancellation has no safe event boundary. Never let late
        // chunks/permissions from that native session enter another turn.
        if (msg?.params?.sessionId && this.needsSessionRecovery(msg.params.sessionId)) {
            if (msg.method === 'session/request_permission' && msg.id != null) {
                this.pendingPermissions.set(msg.id, { sessionId: msg.params.sessionId });
                this.cancelPermission(msg.id);
            }
            return;
        }

        // Incoming JSON-RPC request from kiro-cli (has both id and method).
        // Currently only session/request_permission uses this pattern.
        if (msg && msg.id !== undefined && msg.id !== null && 'method' in msg) {
            if (msg.method === 'session/request_permission') {
                const { sessionId, toolCall, options, _meta } = msg.params ?? {};
                const queue = sessionId ? this.sessionQueues.get(sessionId) : undefined;
                this.pendingPermissions.set(msg.id, { sessionId, options, meta: _meta });
                if (queue) {
                    queue.push({
                        update: {
                            sessionUpdate: 'permission_request',
                            requestId: msg.id,
                            toolCall,
                            options,
                            _meta,
                        },
                    });
                } else {
                    this.cancelPermission(msg.id);
                }
            } else {
                this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                    error: { code: -32601, message: `Unsupported client method: ${msg.method}` },
                }) + '\n');
            }
            return;
        }

        if (msg && msg.id !== undefined && msg.id !== null && ("result" in msg || "error" in msg)) {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            if (p.timer) clearTimeout(p.timer);
            if (p.method === 'session/prompt' && p.sessionId) this.clearCancelTimer(p.sessionId);
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
            const update = msg.params?.update;
            if (sid && update) {
                if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
                    this.rememberSessionInfo(sid, { configOptions: update.configOptions });
                }
                if (update.sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string') {
                    this.rememberSessionInfo(sid, { modes: { ...this.sessionInfo.get(sid)?.modes, currentModeId: update.currentModeId } });
                }
                const nativeUserId = update._meta?.kiro?.userMessageId;
                if (typeof nativeUserId === 'string') this.lastUserMessageId.set(sid, nativeUserId);
                // load already rehydrates Michi's transcript from SQLite. Keep
                // identity/config metadata, never append replay as live output.
                if (this.loadingSessions.has(sid) || update._meta?.kiro?.replay === true) return;
                if (this.engine === 'v3' && update.sessionUpdate === 'session_info_update') {
                    for (const normalized of v3InfoUpdates(update)) {
                        if (normalized.sessionUpdate === 'usage_summary') {
                            const context = this.lastMetadata.get(sid)?.contextUsagePercentage;
                            this.lastMetadata.set(sid, { ...normalized,
                                ...(context !== undefined ? { contextUsagePercentage: context } : {}),
                            });
                        } else if (normalized.sessionUpdate === 'context_usage') {
                            this.lastMetadata.set(sid, { ...this.lastMetadata.get(sid), ...normalized });
                            this.injectUpdate(sid, normalized);
                        } else this.injectUpdate(sid, normalized);
                    }
                    return;
                }
            }
            if (BACKEND_STREAM_PROBE_ENABLED) this.writeRawUpdateProbe(sid, "session/update", msg.params?.update);
            // Any progress on this session resets the idle timer for the
            // in-flight session/prompt RPC — kiro is visibly still working.
            if (sid) {
                for (const p of this.pending.values()) {
                    if (p.sessionId === sid && !p.hardTimeout) this.resetIdleTimer(p);
                }
            }
            const q = sid ? this.sessionQueues.get(sid) : undefined;
            if (q) q.push({ update: msg.params });
            const updateKind = msg.params?.update?.sessionUpdate;
            // Track subagent ownership: when a tool_call title matches
            // subagent-related patterns, record the toolCallId → sessionId mapping.
            if (updateKind === "tool_call" && sid) {
                const title = String(msg.params?.update?.title ?? "").trim().toLowerCase();
                if (
                    title === "agent" ||
                    title === "task" ||
                    title.includes("subagent") ||
                    title.includes("agent crew") ||
                    title.includes("spawn")
                ) {
                    const toolCallId = msg.params?.update?.toolCallId;
                    if (toolCallId) {
                        this.subagentOwners.set(toolCallId, sid);
                        this.subagentOwnerOrder.set(toolCallId, ++this.subagentOwnerSeq);
                    }
                }
            }
            // Release subagent ownership when the owning tool_call completes.
            if (updateKind === "tool_call_update" && sid) {
                const status = msg.params?.update?.status;
                const toolCallId = msg.params?.update?.toolCallId;
                if (
                    toolCallId &&
                    this.subagentOwners.get(toolCallId) === sid &&
                    (status === "completed" || status === "error")
                ) {
                    this.subagentOwners.delete(toolCallId);
                    this.subagentOwnerOrder.delete(toolCallId);
                    // Only clear parent mappings that belong to this owner.
                    // Other concurrent sessions keep their own subagent→parent entries.
                    for (const [subSid, parentSid] of this.subagentParentMap) {
                        if (parentSid === sid) this.subagentParentMap.delete(subSid);
                    }
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

        if (this.engine === 'v3' && msg?.method === '_kiro/mcp/status') {
            const { sessionId, servers } = msg.params ?? {};
            if (typeof sessionId !== 'string' || !Array.isArray(servers)) return;
            this.mcpStatus.set(sessionId, servers);
            const seen = this.mcpErrors.get(sessionId) ?? new Set<string>();
            this.mcpErrors.set(sessionId, seen);
            for (const server of servers) {
                if (server.status !== 'failed' && server.status !== 'error') continue;
                const error = typeof server.error === 'string' ? server.error : 'MCP server connection failed';
                const key = `${server.name}:${error}`;
                if (seen.has(key)) continue;
                seen.add(key);
                this.injectUpdate(sessionId, { sessionUpdate: 'mcp_server_error', serverName: server.name, error });
            }
            return;
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
        // With the per-tool-call Map, a single active owner is deterministic.
        // Multiple concurrent owners → pick the most recently registered (LIFO).
        // No owners → discard the event.
        if (msg?.method === "_kiro.dev/subagent/list_update") {
            const params = msg.params ?? {};
            const subagents = params.subagents ?? [];
            const targetSid = this.resolveSubagentOwner();
            if (targetSid) {
                // Build subagent→parent mapping so we can forward their tool_calls
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
            // When roster empties, clear ONLY the resolved owner's entries
            if (subagents.length === 0 && targetSid) {
                for (const [subSid, parentSid] of this.subagentParentMap) {
                    if (parentSid === targetSid) this.subagentParentMap.delete(subSid);
                }
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

        // _kiro.dev/compaction/status — compaction lifecycle notification.
        // Emitted by kiro-cli when `/compact` is executed (either via
        // commands/execute or as a prompt-text slash command). The agent
        // pushes { type: "started" } then { type: "completed", summary }.
        if (msg?.method === "_kiro.dev/compaction/status") {
            const params = msg.params ?? {};
            const sid: string | undefined = typeof params.sessionId === "string" ? params.sessionId : undefined;
            const statusType = params.status?.type; // "started" | "completed"
            if (sid) {
                if (statusType === 'completed') this.compactions.get(sid)?.resolve();
                if (statusType === 'failed' || statusType === 'error') {
                    this.compactions.get(sid)?.reject(new ACPError(params.status?.message ?? 'Kiro compaction failed'));
                }
                const q = this.sessionQueues.get(sid);
                if (q) {
                    if (statusType === "started") {
                        q.push({ update: { sessionUpdate: "compaction_start" } });
                    } else if (statusType === "completed") {
                        q.push({ update: {
                            sessionUpdate: "compaction_end",
                            summary: typeof params.summary === "string" ? params.summary : undefined,
                        }});
                    }
                }
            }
        }

        // _kiro.dev/clear/status — session history cleared notification.
        // Emitted after `/clear` completes via commands/execute.
        if (msg?.method === "_kiro.dev/clear/status") {
            const params = msg.params ?? {};
            const sid: string | undefined = typeof params.sessionId === "string" ? params.sessionId : undefined;
            if (sid) {
                const q = this.sessionQueues.get(sid);
                if (q) {
                    q.push({ update: { sessionUpdate: "clear_status" } });
                }
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
                    p.hardTimeout
                        ? `Request ${p.method} exceeded its ${p.timeoutMs}ms recovery deadline`
                        : `Request ${p.method} idle for ${p.timeoutMs}ms (no updates from agent)`,
                    { method: p.method, sessionId: p.sessionId },
                ),
            );
        }, p.timeoutMs);
    }

    private failAllPending(err: Error): void {
        for (const timer of this.cancelTimers.values()) clearTimeout(timer);
        this.cancelTimers.clear();
        for (const p of this.pending.values()) {
            if (p.timer) clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
        for (const compaction of this.compactions.values()) compaction.reject(err);
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
        hardTimeout = false,
    ): Promise<any> {
        return new Promise((resolve, reject) => {
            if (params?.sessionId) this.assertSessionUsable(params.sessionId);
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

    async initialize(timeoutMs?: number): Promise<void> {
        const t0 = perf.now();
        startupMark("kiro_initialize_start", { cwd: this.cwd });
        const result = await this.send("initialize", {
            protocolVersion: 1,
            clientInfo: { name: "michi", version: "1.0.0" },
            clientCapabilities: {},
        }, timeoutMs, undefined, timeoutMs !== undefined);
        if (result?.protocolVersion !== 1) throw new ACPError('Unsupported ACP protocol version');
        this.initialization = result;
        startupMark("kiro_initialize_done", { cwd: this.cwd });
        perf.measure("acp:initialize", t0, { cwd: this.cwd });
    }

    async newSession(mcpServers: AcpMcpServer[] = [], options: AcpSessionOptions = {}): Promise<AcpSessionInfo & { sessionId: string }> {
        const t0 = perf.now();
        startupMark("kiro_session_new_start", { cwd: this.cwd, mcpServerCount: mcpServers.length });
        const result = await this.send("session/new", { cwd: this.cwd, mcpServers,
            ...kiroSessionMeta(this.engine, { modelId: this.model, ...options }),
        });
        const sid = result.sessionId as string;
        if (typeof sid !== 'string' || !sid) throw new ACPError('session/new returned no sessionId');
        this.sessionQueues.set(sid, new SessionQueue());
        startupMark("kiro_session_new_done", { cwd: this.cwd, sessionId: sid, mcpServerCount: mcpServers.length });
        perf.measure("acp:session_new", t0, { cwd: this.cwd, sessionId: sid });
        return { ...this.rememberSessionInfo(sid, result), sessionId: sid };
    }

    async loadSession(
        sessionId: string,
        cwd: string,
        mcpServers: AcpMcpServer[] = [],
        timeoutMs?: number,
        options: AcpSessionOptions = {},
    ): Promise<AcpSessionInfo> {
        const t0 = perf.now();
        this.assertSessionUsable(sessionId);
        const createdQueue = !this.sessionQueues.has(sessionId);
        if (createdQueue) {
            this.sessionQueues.set(sessionId, new SessionQueue());
        }
        let result;
        this.loadingSessions.add(sessionId);
        try {
            result = await this.send(
                "session/load",
                { sessionId, cwd, mcpServers, ...kiroSessionMeta(this.engine, options) },
                timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
        perf.measure("acp:session_load", t0, { cwd, sessionId });
        return this.rememberSessionInfo(sessionId, result ?? {});
    }

    async setMode(sessionId: string, modeId: string): Promise<void> {
        const result = await this.send("session/set_mode", { sessionId, modeId }, DEFAULT_TIMEOUT_MS, sessionId);
        if (result?.configOptions || result?.modes) this.rememberSessionInfo(sessionId, result);
        const applied = result?.modes?.currentModeId ?? result?.configOptions?.find((c: AcpConfigOption) => c.id === 'mode')?.currentValue;
        if (applied && applied !== modeId) throw new ACPError(`Kiro did not select requested agent ${modeId}`);
        const info = this.sessionInfo.get(sessionId);
        if (info) this.sessionInfo.set(sessionId, { ...info, modes: { ...info.modes, currentModeId: modeId } });
    }

    async setModel(sessionId: string, modelId: string, timeoutMs?: number): Promise<void> {
        if (this.engine === 'v3') {
            const option = this.sessionInfo.get(sessionId)?.configOptions?.find((c) => c.id === 'model' || c.category === 'model');
            if (!option) throw new ACPError('This Kiro session does not expose a model config option');
            await this.setConfigOption(sessionId, option.id, modelId, timeoutMs);
        } else {
            await this.send("session/set_model", { sessionId, modelId }, timeoutMs, sessionId, timeoutMs !== undefined);
            const info = this.sessionInfo.get(sessionId);
            if (info) this.sessionInfo.set(sessionId, { ...info, models: { ...info.models, currentModelId: modelId } });
        }
    }

    async setConfigOption(sessionId: string, configId: string, value: string | boolean, timeoutMs?: number): Promise<AcpConfigOption[]> {
        if (this.engine !== 'v3') throw new ACPError('Generic config options require Kiro v3');
        const result = await this.send('session/set_config_option', { sessionId, configId, value }, timeoutMs, sessionId, timeoutMs !== undefined);
        if (!Array.isArray(result?.configOptions)) throw new ACPError('Kiro returned no config options after configuration');
        this.rememberSessionInfo(sessionId, result);
        const applied = result.configOptions.find((c: AcpConfigOption) => c.id === configId);
        if (applied && applied.currentValue !== value) throw new ACPError(`Kiro did not apply config option ${configId}`);
        return result.configOptions;
    }

    async steer(sessionId: string, message: string): Promise<{ queued: boolean; messageId?: string }> {
        if (!message.trim() || !this.activePrompts.has(sessionId)) return { queued: false };
        if (this.cancelledPrompts.has(sessionId)) return { queued: false };
        const requests = this.steerRequests.get(sessionId) ?? new Set<Promise<unknown>>();
        this.steerRequests.set(sessionId, requests);
        const request = this.send('_session/steer', { sessionId, message }, 10_000, sessionId, true);
        requests.add(request);
        try {
            const result = await request;
            if (result?.queued === true) this.steeredSessions.add(sessionId);
            return { queued: result?.queued === true && !this.cancelledPrompts.has(sessionId),
                ...(typeof result?.messageId === 'string' ? { messageId: result.messageId } : {}),
            };
        } finally {
            requests.delete(request);
            if (requests.size === 0) this.steerRequests.delete(sessionId);
        }
    }

    async clearSteer(sessionId: string): Promise<{ cleared: boolean; messageIds?: string[] }> {
        const result = await this.send('_session/steer/clear', { sessionId }, 10_000, sessionId, true);
        if (result?.cleared === true) this.steeredSessions.delete(sessionId);
        return { cleared: result?.cleared === true,
            ...(Array.isArray(result?.messageIds) ? { messageIds: result.messageIds.filter((id: unknown) => typeof id === 'string') } : {}),
        };
    }

    async forkSession(sessionId: string, point?: { logIndex?: number; messageId?: string }): Promise<string> {
        if (this.sessionInFlight.has(sessionId)) throw new ACPError('Cannot fork an active Kiro session');
        let release!: () => void;
        const lock = new Promise<void>((resolve) => { release = resolve; });
        this.sessionInFlight.set(sessionId, lock);
        try {
            let childId: unknown;
            if (this.engine === 'v2') {
                const catalog = await this.executeCommand(sessionId, 'rewind', {});
                if (!catalog.success) throw new ACPError(catalog.message ?? 'Kiro rewind failed');
                const points = rewindPoints(catalog);
                const index = point?.logIndex ?? points[0]?.logIndex;
                if (index === undefined || !points.some((row) => row.logIndex === index)) throw new ACPError('No matching Kiro rewind point');
                const result = await this.executeCommand(sessionId, 'rewind', { value: String(index) });
                if (!result.success) throw new ACPError(result.message ?? 'Kiro rewind failed');
                childId = (result.data as any)?.sessionId;
            } else {
                if (!this.capabilities?.sessionCapabilities?.fork) throw new ACPError('Kiro did not advertise session/fork');
                const result = await this.send('session/fork', { sessionId, cwd: this.cwd,
                    ...(point?.messageId ? { _meta: { kiro: { messageId: point.messageId, createdReason: 'rewind' } } } : {}),
                }, DEFAULT_TIMEOUT_MS, sessionId);
                childId = result?.sessionId;
            }
            if (typeof childId !== 'string' || !childId || childId === sessionId) throw new ACPError('Kiro fork did not return an independent session');
            // The runtime loads this child with its own MCP slot before use.
            return childId;
        } finally {
            release();
            if (this.sessionInFlight.get(sessionId) === lock) this.sessionInFlight.delete(sessionId);
        }
    }

    /** Reserve the idle session until native compaction actually completes.
     * v2's command response is only an acknowledgement; completion is a later
     * notification. v3's dedicated request resolves after compaction. */
    async compact(sessionId: string, instructions?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ success: boolean; message?: string }> {
        this.assertSessionUsable(sessionId);
        const prompting = this.activePrompts.has(sessionId)
            && [...this.pending.values()].some((request) => request.sessionId === sessionId && request.method === 'session/prompt');
        if (prompting || this.compactingSessions.has(sessionId)) return { success: false, message: 'Cannot compact an active Kiro session' };
        const previous = this.sessionInFlight.get(sessionId);
        let release!: () => void;
        const finished = new Promise<void>((resolve) => { release = resolve; });
        const lock = previous ? previous.then(() => finished) : finished;
        this.sessionInFlight.set(sessionId, lock);
        this.compactingSessions.add(sessionId);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            // The prompt response can precede consumer/steering cleanup. Keep
            // that boundary intact even when the UI already received done.
            await previous;
            this.assertSessionUsable(sessionId);
            const completed = this.engine === 'v2' ? new Promise<void>((resolve, reject) => {
                this.compactions.set(sessionId, { resolve, reject });
                timer = setTimeout(() => reject(new ACPSessionRecoveryRequiredError('Kiro compaction completion timed out', { sessionId })), timeoutMs);
            }) : undefined;
            // A process exit may reject completion before the command responds.
            void completed?.catch(() => {});
            const result = await this.executeCommand(sessionId, 'compact', instructions?.trim() ? { instructions: instructions.trim() } : undefined, timeoutMs);
            if (!result.success) return result;
            await completed;
            return { success: true, message: 'Compaction completed' };
        } catch (error) {
            // Do not reuse a session whose compaction may still be in flight.
            this.quarantinedSessions.add(sessionId);
            throw error;
        } finally {
            clearTimeout(timer);
            this.compactions.delete(sessionId);
            this.compactingSessions.delete(sessionId);
            release();
            if (this.sessionInFlight.get(sessionId) === lock) this.sessionInFlight.delete(sessionId);
        }
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
    async *prompt(
        sessionId: string,
        text: string,
        extraBlocks: AcpPromptBlock[] = [],
        signal?: AbortSignal,
    ): AsyncIterableIterator<AcpUpdate> {
        const tPromptIn = perf.now();
        this.assertSessionUsable(sessionId);
        perf.mark("acp:prompt_entered", { sid: sessionId, textLen: text.length });
        const q = this.sessionQueues.get(sessionId);
        if (!q) throw new ACPError(`unknown session: ${sessionId}`);

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
            heartbeat = setInterval(() => {
                const idle = Date.now() - lastActivity;
                if (idle >= HEARTBEAT_INTERVAL_MS) {
                    q.push({ update: { sessionUpdate: "__heartbeat__", idleMs: idle } });
                }
            }, HEARTBEAT_INTERVAL_MS);

            let promptResult: any;
            let promptError: Error | null = null;
            started = true;
            this.activePrompts.add(sessionId);
            sendPromise = this.send(
                "session/prompt",
                { sessionId, prompt: [{ type: "text", text }, ...extraBlocks] },
                PROMPT_TIMEOUT_MS,
                sessionId,
            )
                .then((r) => {
                    this.activePrompts.delete(sessionId);
                    this.clearCancelTimer(sessionId);
                    promptResult = r;
                    q.push({ update: { sessionUpdate: "__send_complete__" } });
                })
                .catch((e) => {
                    this.activePrompts.delete(sessionId);
                    this.clearCancelTimer(sessionId);
                    promptError = e as Error;
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
                    if (this.engine === 'v3' && buffered?.source === 'kiro-v3') {
                        yield { ...buffered, sessionUpdate: 'usage_summary' };
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

                // Real update from kiro — reset the idle clock.
                lastActivity = Date.now();
                yield update;

                if (kind === "turn_end") return;
            }
        } finally {
            clearInterval(heartbeat);
            await sendPromise;
            if (started) {
                this.activePrompts.delete(sessionId);
                await Promise.allSettled(this.steerRequests.get(sessionId) ?? []);
                if (this.steeredSessions.has(sessionId) && !this.needsSessionRecovery(sessionId)) {
                    try {
                        if (!(await this.clearSteer(sessionId)).cleared) this.quarantinedSessions.add(sessionId);
                    } catch { this.quarantinedSessions.add(sessionId); }
                }
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
            id: requestId,
            result: { outcome: { outcome: 'selected', optionId },
                ...this.permissionConsent(pending, optionId),
            },
        });
        this.proc.stdin.write(payload + '\n');
    }

    respondToPermissionKind(requestId: number, kind: 'allow_once' | 'reject_once'): void {
        const option = this.pendingPermissions.get(requestId)?.options?.find((option) => option.kind === kind);
        if (option) this.respondToPermission(requestId, option.optionId);
        else this.cancelPermission(requestId);
    }

    private permissionConsent(pending: { options?: any[]; meta?: any }, optionId: string): Record<string, unknown> {
        const option = pending.options?.find((option) => option.optionId === optionId);
        const consent = pending.meta?.kiro?.consent;
        if (this.engine !== 'v3' || !consent || !['allow_always', 'reject_always'].includes(option?.kind)) return {};
        // Limit provider persistence to this session and the exact triggering
        // resource, never infer a wildcard grant from a tool's display title.
        return { _meta: { kiro: { consent: { capability: consent.capability, scope: 'session',
            resource: consent.triggeringResource ?? consent.resource, workspaceRoot: consent.workspaceRoot,
        } } } };
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

    /**
     * Execute a Kiro slash command via the ACP `_kiro.dev/commands/execute`
     * request instead of sending it as prompt text. Returns the structured
     * response `{ success, message?, data? }`.
     *
     * Only verified-safe commands should use this path; commands that hang
     * (e.g. `/help`, `/model`) must fall back to prompt text.
     *
     * Side-effects like `_kiro.dev/compaction/status` are delivered as
     * separate notifications and routed to the session queue by dispatch().
     */
    async executeCommand(
        sessionId: string,
        command: string,
        args?: Record<string, unknown>,
        timeoutMs = DEFAULT_TIMEOUT_MS,
    ): Promise<{ success: boolean; message?: string; data?: unknown }> {
        if (this.engine === 'v3') {
            const methods: Record<string, string> = { compact: '_kiro/session/compact', context: '_kiro/session/context',
                history: '_kiro/session/history', export: '_kiro/session/export', code: '_kiro/codeIntelligence', usage: '_kiro/account/getUsage' };
            if (command === 'mcp') return { success: true, data: this.mcpStatus.get(sessionId) ?? [] };
            const method = methods[command];
            if (!method) return { success: false, message: `/${command} has no Kiro v3 command RPC` };
            const result = await this.send(method, { ...args, sessionId }, timeoutMs, sessionId, true);
            return { success: result?.success !== false, message: result?.message, data: result };
        }
        const payload: Record<string, unknown> = {
            sessionId,
            command: { command, args: args ?? {} },
        };
        return this.send(
            "_kiro.dev/commands/execute",
            payload,
            timeoutMs,
            sessionId,
            true,
        );
    }

    /**
     * Dispatch ACP `session/cancel`. Resolves `true` when this client owned the
     * session and a cancel was actually dispatched, `false` when there was
     * nothing to cancel. ACP has no cancel *response*, so `true` means "the
     * request was handed to the transport", not "the agent stopped" — callers
     * that surface this to the UI must label it `inferred`, never `native`.
     */
    async cancel(sessionId: string): Promise<boolean> {
        if (!this.sessionQueues.has(sessionId)) return false;
        if (this.sessionInFlight.has(sessionId)) this.cancelledPrompts.add(sessionId);
        this.cancelPermissionsForSession(sessionId);
        const active = [...this.pending.entries()].find(([, p]) => p.method === 'session/prompt' && p.sessionId === sessionId);
        if (active && !this.cancelTimers.has(sessionId)) {
            const [id, pending] = active;
            const timer = setTimeout(() => {
                this.cancelTimers.delete(sessionId);
                if (this.pending.get(id) !== pending) return;
                this.quarantinedSessions.add(sessionId);
                this.cancelPermissionsForSession(sessionId);
                this.sessionQueues.get(sessionId)?.drain();
                this.sessionQueues.delete(sessionId);
                this.pending.delete(id);
                clearTimeout(pending.timer ?? undefined);
                log.warn('acp', 'cancel deadline exceeded; native session quarantined', {
                    sessionId, pid: this.proc?.pid, timeoutMs: this.cancelTimeoutMs,
                });
                pending.reject(new ACPSessionRecoveryRequiredError(
                    'Kiro did not finish cancellation. The original session has been retained for recovery.',
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

    destroySession(sessionId: string): void {
        this.compactions.get(sessionId)?.reject(new ACPError('Kiro session released during compaction'));
        this.cancelPermissionsForSession(sessionId);
        this.sessionQueues.delete(sessionId);
        this.sessionInfo.delete(sessionId);
        this.lastMetadata.delete(sessionId);
        this.lastUserMessageId.delete(sessionId);
        this.mcpStatus.delete(sessionId);
        this.mcpErrors.delete(sessionId);
        this.steeredSessions.delete(sessionId);
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
        if (!exited) throw new ACPError('Kiro process exit could not be confirmed; native recovery was stopped.');

        this.proc = null;
        this.sessionQueues.clear();
        this.pendingPermissions.clear();
        this.failAllPending(new ACPNotRunningError("client shut down"));
    }
}

export { findKiroCli };
