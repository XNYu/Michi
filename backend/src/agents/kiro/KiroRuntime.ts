import { AcpClient } from "../../services/acpClient";
import type { McpSlotRegistry, McpSlotCallbacks } from "../../services/mcpServer";
import * as perf from "../../services/perf";
import type {
    AgentCapabilities,
    AgentRuntime,
    AgentSession,
    LoadAgentSessionOptions,
    ModelInfo,
    NewAgentSessionOptions,
    RuntimeSessionOwner,
    RuntimeToolProfile,
    RuntimePermissionBroker,
    SessionMode,
} from "../types";
import { assertOwner, ownerLabel } from "../types";
import { KIRO_METADATA_DONE_SENTINEL, KiroSession } from "./KiroSession";
import * as sessionRegistry from "../sessionRegistry";
import { buildPreamble } from "../preamble";
import type { AgentToolBridge, BridgeContextResult, SpawnedBranch } from "../toolBridge";
import { resolveAgentRunToolsForSession } from "../toolBridge";
import type { RuntimeModelCache } from "../runtimeModelCache";
import { getNode, getWorkspaceInstructions } from "../../services/dbRepository";
import { buildRunMcpSlotCallbacks } from "../runs/runMcpSlot";

// ---------------------------------------------------------------------------
// Process lifecycle constants
// ---------------------------------------------------------------------------

/**
 * Default maximum number of concurrent kiro-cli processes. Each worktree cwd
 * maps to one process; this cap prevents unbounded process creation when many
 * concurrent Runs target distinct worktrees.
 */
const DEFAULT_PROCESS_CAP = parseInt(process.env.MICHI_KIRO_MAX_PROCESSES ?? "20", 10);

/**
 * Idle TTL for a cwd-keyed kiro-cli process with no live sessions. After this
 * period the process is terminated to free resources. Reset whenever a new
 * session binds to the cwd. Default 5 minutes.
 */
const DEFAULT_IDLE_TTL_MS = parseInt(process.env.MICHI_KIRO_IDLE_TTL_MS ?? "300000", 10);

export { KiroConcurrencyError, AcpConcurrencyError } from "../acp/AcpRuntime";
export type { OpenSessionResult, LoadSessionResult, McpSlotCallbacksFactory } from "../acp/AcpRuntime";

/**
 * Internal binding record for a Kiro runtime session. Keyed by the public
 * session id (node id for chats, Attempt id for Runs) with a reverse index
 * from the native ACP session id. Carries the immutable owner identity, cwd,
 * profile hash, tool profile, permission broker, and MCP slot id.
 *
 * Cleanup and recovery operate on the binding rather than on inferred Node
 * ids, ensuring that Agent Run sessions (which have no backing node row) are
 * handled correctly.
 */
export interface KiroSessionBinding {
    publicSessionId: string;
    nativeSessionId: string;
    owner: RuntimeSessionOwner;
    cwd: string;
    workspaceId: string | null;
    ownerUserId: string | null;
    runtimeProfileHash: string | null;
    toolProfile?: RuntimeToolProfile;
    permissionBroker?: RuntimePermissionBroker;
    slotId?: string;
    modelId?: string | null;
}

/**
 * Factory the caller (ChatManager) provides for building MCP slot
 * callbacks. Receives a getter for the slotId that resolves once the
 * slot has been allocated, since the callbacks need to close over
 * slotId for the routing back to ChatManager.handleSpawnBranches /
 * handleSetTitle / etc.
 */
export type McpSlotCallbacksFactory = (getSlotId: () => string | undefined) => McpSlotCallbacks;

/**
 * Owns the ACP client pool keyed by cwd, the pre-warmed session pool,
 * the per-session current-mode cache, and the global availableModes
 * cache.
 *
 * INVARIANT (preserved from pre-refactor ChatManager): the pool is keyed
 * on cwd alone — two projects sharing a cwd silently share whichever
 * model spawned the first AcpClient. Do NOT change this here; it is
 * tracked separately.
 */
export class KiroConcurrencyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "KiroConcurrencyError";
    }
}

/**
 * Thrown when the global kiro-cli process cap is reached. Distinct from
 * `KiroConcurrencyError` (session cap) so callers can differentiate between
 * "too many sessions" and "too many processes" in capacity error reporting.
 */
export class KiroProcessCapError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "KiroProcessCapError";
    }
}

export class KiroRuntime implements AgentRuntime {
    public readonly id = "kiro" as const;
    public readonly label = "Kiro";
    public readonly capabilities: AgentCapabilities = {
        modes: true,
        permissions: true,
        models: true,
        providerModels: false,
        reasoning: false,
        supportedReasoningLevels: [],
        apiKeys: false,
        warmSessions: true,
        saveContext: true,
        spawnBranches: true,
        nativeResume: true,
    };

    private pool = new Map<string, AcpClient>();
    private startLocks = new Map<string, Promise<AcpClient>>();
    /**
     * Pool of pre-created ACP sessions, keyed by cwd. Each entry is a
     * `session/new` result that has NOT had a prompt sent yet. When a
     * chat is created in that cwd, we hand out the warmed sid instead
     * of paying ~3.7s for a fresh session/new round-trip, then kick off
     * a background replenish so the next chat in that cwd is again
     * fast.
     *
     * Each entry carries the MCP slotId allocated at pre-warm time —
     * when the session is claimed by a real chat, the caller updates
     * the slot's parentChatId from the "__pending__" sentinel to the
     * real sessionId.
     */
    private warmedSessions = new Map<string, { sid: string; slotId?: string; currentModeId?: string }>();
    /** Dedupes concurrent warm-next calls per cwd. */
    private warmSessionLocks = new Map<string, Promise<void>>();
    /** sessionId → ACP currentModeId (per-session; availableModes is global). */
    private sessionCurrentMode = new Map<string, string>();
    /** sessionId → ACP currentModelId (per-session). */
    private sessionCurrentModel = new Map<string, string>();
    /**
     * Global list of ACP modes (kiro's agent list). Empirically identical
     * across sessions and cwds in kiro-cli 2.1.0, so we cache once per boot.
     */
    private globalAvailableModes: any[] | null = null;
    /**
     * Global list of ACP models (claude-opus-4.7, claude-sonnet-4.6, etc.).
     * Like modes, empirically identical across sessions; cached once per boot.
     */
    private globalAvailableModels: any[] | null = null;
    private readonly modelCacheStore?: RuntimeModelCache;
    private modelCache: ModelInfo[] | null;
    private modelRefreshLock: Promise<ModelInfo[]> | null = null;
    private modesLoadLock: Promise<any[]> | null = null;

    /** sessionId → MCP slotId (owned here so newSession + loadSession + shutdown can manage it). */
    private slotByChatId = new Map<string, string>();
    /** sessionId → cwd binding. Used by permission forwarding and cwd-scoped purge. */
    private sessionCwd = new Map<string, string>();
    /** Michi node id → ACP session id. Public callers only use the node id. */
    private sidByNodeId = new Map<string, string>();
    /** ACP session id → Michi node id. Used when a cwd-scoped client exits. */
    private nodeIdBySid = new Map<string, string>();

    // -----------------------------------------------------------------------
    // Owner-aware binding records (Run + chat unified index)
    // -----------------------------------------------------------------------

    /**
     * publicSessionId (node id or Attempt id) → immutable binding record.
     * The authoritative index for all session metadata lookups by public id.
     */
    private bindings = new Map<string, KiroSessionBinding>();

    /**
     * nativeSessionId (ACP sid) → publicSessionId. Reverse index used when
     * a cwd-scoped client exits and we need to find all bindings to purge.
     */
    private publicIdByNativeSid = new Map<string, string>();
    /** Monotonic request id for user-input requests across all sessions. */
    private nextUserInputRequestId = 0;
    /** Pending user-input promises, keyed by requestId. */
    private readonly pendingUserInputs = new Map<
        number,
        { resolve: (answers: Array<{ question: string; answer: string }> | null) => void; timer: NodeJS.Timeout }
    >();

    private readonly mcpBaseUrl: string;
    private readonly defaultCwd: string;
    /** Safety valve mirroring Claude/Codex. Kiro multiplexes many ACP sessions
     *  onto one kiro-cli per cwd, so there's no per-session process to cap —
     *  this only guards against unbounded session-map growth. Default high. */
    private readonly concurrencyCap: number;
    /**
     * Maximum number of concurrent kiro-cli processes (one per distinct cwd).
     * Prevents unbounded process creation when many concurrent Runs target
     * distinct worktrees. Distinct from `concurrencyCap` which guards session
     * count.
     */
    private readonly processCap: number;
    /**
     * Idle TTL for cwd-keyed processes with no live sessions. After this
     * duration the process is shut down. 0 disables idle cleanup.
     */
    private readonly idleTtlMs: number;
    /**
     * Per-cwd idle timer handles. When the last session for a cwd is released,
     * an idle timer is set. If no new session binds to that cwd before it
     * fires, the process is terminated. Creating a new session cancels the
     * timer. Cleared on shutdown.
     */
    private readonly idleTimers = new Map<string, NodeJS.Timeout>();
    /**
     * Per-cwd last-activity timestamps (epoch ms). Updated on every session
     * bind/release. Used for LRU eviction when the process cap is reached.
     */
    private readonly cwdLastActivity = new Map<string, number>();

    constructor(
        bridge: AgentToolBridge,
        mcpRegistry: McpSlotRegistry | undefined,
        mcpPort: number,
        defaultCwd: string = process.cwd(),
        modelCache?: RuntimeModelCache,
    ) {
        this.mcpBaseUrl = `http://127.0.0.1:${mcpPort}/api`;
        this.defaultCwd = defaultCwd;
        this.modelCacheStore = modelCache;
        this.modelCache = modelCache?.load(this.id) ?? null;
        this.concurrencyCap = parseInt(process.env.MICHI_KIRO_MAX_CONCURRENT ?? "100", 10);
        this.processCap = DEFAULT_PROCESS_CAP;
        this.idleTtlMs = DEFAULT_IDLE_TTL_MS;
    }

    /** Resolves the cwd for a sessionId — used by permission forwarding. */
    private getCwdForSession(sid: string): string | undefined {
        return this.sessionCwd.get(sid);
    }

    // -----------------------------------------------------------------------
    // Idle timer management
    // -----------------------------------------------------------------------

    /**
     * Cancel any pending idle timer for a cwd. Called when a new session
     * binds to the cwd, keeping the process alive.
     */
    private cancelIdleTimer(cwd: string): void {
        const timer = this.idleTimers.get(cwd);
        if (timer) {
            clearTimeout(timer);
            this.idleTimers.delete(cwd);
        }
    }

    /**
     * Touch the last-activity timestamp for a cwd. Called on session bind
     * and release to track LRU order.
     */
    private touchCwdActivity(cwd: string): void {
        this.cwdLastActivity.set(cwd, Date.now());
    }

    /**
     * Count live sessions for a specific cwd by scanning `sessionCwd`.
     */
    private liveSessionCountForCwd(cwd: string): number {
        let count = 0;
        for (const c of this.sessionCwd.values()) {
            if (c === cwd) count += 1;
        }
        return count;
    }

    /**
     * Schedule an idle timer for a cwd. When the timer fires and the cwd
     * still has no live sessions, the process is shut down. Skipped when
     * `idleTtlMs` is 0 (disabled) or when the cwd is the default warm cwd.
     */
    private scheduleIdleCleanup(cwd: string): void {
        if (this.idleTtlMs <= 0) return;
        // Don't idle-kill the default cwd — it serves modes/models probes.
        if (cwd === this.defaultCwd) return;
        this.cancelIdleTimer(cwd);

        const timer = setTimeout(async () => {
            this.idleTimers.delete(cwd);
            // Double-check: only kill if still idle.
            if (this.liveSessionCountForCwd(cwd) > 0) return;
            const client = this.pool.get(cwd);
            if (!client) return;
            perf.mark("idleCleanup:kill", { cwd });
            this.pool.delete(cwd);
            this.cwdLastActivity.delete(cwd);
            await client.shutdown().catch(() => {});
            this.purgeSessionsForCwd(cwd);
        }, this.idleTtlMs);

        // Prevent the idle timer from keeping the Node.js event loop alive
        // during shutdown.
        if (typeof timer === "object" && "unref" in timer) timer.unref();
        this.idleTimers.set(cwd, timer);
    }

    // -----------------------------------------------------------------------
    // Process cap management
    // -----------------------------------------------------------------------

    /**
     * Number of active kiro-cli processes (one per distinct cwd in the pool,
     * plus any in-flight starts). Exposed for testing.
     */
    get activeProcessCount(): number {
        return this.pool.size + this.startLocks.size;
    }

    /**
     * Evict the least-recently-used idle cwd client when the process cap is
     * reached. Returns true if space was freed. Only evicts a cwd that has
     * no live sessions.
     */
    private async evictLruIdleProcess(): Promise<boolean> {
        let oldestCwd: string | null = null;
        let oldestTs = Infinity;
        for (const [cwd, ts] of this.cwdLastActivity) {
            if (ts < oldestTs && this.liveSessionCountForCwd(cwd) === 0 && this.pool.has(cwd)) {
                oldestCwd = cwd;
                oldestTs = ts;
            }
        }
        if (!oldestCwd) return false;

        perf.mark("processCapEvict:lru", { cwd: oldestCwd });
        this.cancelIdleTimer(oldestCwd);
        const client = this.pool.get(oldestCwd);
        this.pool.delete(oldestCwd);
        this.cwdLastActivity.delete(oldestCwd);
        if (client) {
            await client.shutdown().catch(() => {});
            this.purgeSessionsForCwd(oldestCwd);
        }
        return true;
    }

    private bindNodeSession(nodeId: string, sid: string): void {
        this.sidByNodeId.set(nodeId, sid);
        this.nodeIdBySid.set(sid, nodeId);
        this.publicIdByNativeSid.set(sid, nodeId);
    }

    private unbindNativeSession(sid: string): string {
        const nodeId = this.nodeIdBySid.get(sid) ?? sid;
        this.nodeIdBySid.delete(sid);
        this.sidByNodeId.delete(nodeId);
        this.publicIdByNativeSid.delete(sid);
        this.bindings.delete(nodeId);
        return nodeId;
    }

    /**
     * Store an immutable binding record for a session. Populates both the
     * primary `bindings` map and the `publicIdByNativeSid` reverse index.
     */
    private storeBinding(binding: KiroSessionBinding): void {
        this.bindings.set(binding.publicSessionId, binding);
        this.publicIdByNativeSid.set(binding.nativeSessionId, binding.publicSessionId);
    }

    /** Look up a binding by public session id (node id or Attempt id). */
    getBinding(publicSessionId: string): KiroSessionBinding | undefined {
        return this.bindings.get(publicSessionId);
    }

    /** Look up a binding by native ACP session id (reverse lookup). */
    getBindingByNativeSid(nativeSid: string): KiroSessionBinding | undefined {
        const pubId = this.publicIdByNativeSid.get(nativeSid);
        return pubId ? this.bindings.get(pubId) : undefined;
    }

    /**
     * Drop every session bound to a cwd whose AcpClient just exited. Releases
     * MCP slots and clears the per-session caches so a fresh client starts
     * with a clean slate. Called from the AcpClient.onExit hook in
     * `ensureClient`. Also purges binding records for Agent Run sessions.
     */
    private purgeSessionsForCwd(cwd: string): void {
        for (const [sid, boundCwd] of this.sessionCwd) {
            if (boundCwd !== cwd) continue;
            sessionRegistry.dropSession(this.unbindNativeSession(sid));
            this.sessionCwd.delete(sid);
            this.sessionCurrentMode.delete(sid);
            this.sessionCurrentModel.delete(sid);
            const slotId = this.slotByChatId.get(sid);
            if (slotId) {
                this.mcpRegistry?.dispose(slotId);
                this.slotByChatId.delete(sid);
            }
        }
        const warmed = this.warmedSessions.get(cwd);
        if (warmed) {
            if (warmed.slotId) {
                this.mcpRegistry?.dispose(warmed.slotId);
            }
            this.warmedSessions.delete(cwd);
            this.sessionCurrentMode.delete(warmed.sid);
            this.sessionCurrentModel.delete(warmed.sid);
        }
    }

    /**
     * Build MCP slot callbacks closing over a getter that resolves the
     * slotId once it has been allocated. The callbacks route back to the
     * runtime's handleSpawnBranches / handleSaveContext / handleUpdateContext.
     *
     * Workspace lookup happens in mcpServer from slot.nodeId -> nodes.workspace_id.
     * The runtime still keeps parentChatId as the ACP session id so callbacks can
     * inject updates into the right live Kiro session.
     */
    private makeSlotCallbacks(getSlotId: () => string | undefined): McpSlotCallbacks {
        return {
            onSpawnBranches: async (topics) => this.handleSpawnBranches(getSlotId()!, topics),
            onSaveArtifact: (name, body) => this.handleSaveContext(getSlotId()!, name, body),
            onUpdateArtifact: (name, body) => this.handleUpdateContext(getSlotId()!, name, body),
            onSetFollowUps: (followUps) => this.handleSetFollowUps(getSlotId()!, followUps),
            onSetBranchOverview: (overview) => this.handleSetBranchOverview(getSlotId()!, overview),
            metadataDoneSentinel: KIRO_METADATA_DONE_SENTINEL,
            // show_image is a Claude-runtime side-effect tool; the Kiro runtime
            // does not expose it. Satisfy the required callback with a stub.
            onShowImage: () => ({ error: "show_image is not supported on the Kiro runtime" }),
            onAskUser: (questions) => this.handleAskUser(getSlotId()!, questions),
        };
    }

    private async handleSpawnBranches(
        slotId: string,
        topics: Array<{ title: string; prompt: string }>,
    ): Promise<SpawnedBranch[]> {
        const slot = this.mcpRegistry?.get(slotId);
        if (!slot) return [];
        const parentSid = slot.parentChatId;
        if (parentSid === "__pending__") return [];
        const parentNodeId = slot.nodeId ?? this.nodeIdBySid.get(parentSid) ?? parentSid;
        const cwd = slot.cwd;
        const parentSession = sessionRegistry.getSession(parentNodeId) as KiroSession | undefined;

        const created = await this.bridge.spawnBranches({
            parentChatId: parentNodeId,
            cwd,
            enableFollowUps: parentSession?.getEnableFollowUps() !== false,
            ownerUserId: slot.ownerUserId,
            topics,
        });

        const client = this.getClient(cwd);
        if (client) {
            client.injectUpdate(parentSid, {
                sessionUpdate: "spawn_branches",
                topics: created,
            });
        }
        return created;
    }

    private handleSaveContext(slotId: string, name: string, body: string): BridgeContextResult | null {
        const slot = this.mcpRegistry?.get(slotId);
        if (!slot) return null;
        const parentChatId = slot.parentChatId;
        if (parentChatId === "__pending__") return null;
        const result = this.bridge.saveContext({ cwd: slot.cwd, chatId: parentChatId, ownerUserId: slot.ownerUserId, name, body });
        if (!result) return null;
        const client = this.getClient(slot.cwd);
        client?.injectUpdate(parentChatId, {
            sessionUpdate: "artifact_saved",
            contextId: result.id,
            name: result.name,
            filePath: result.filePath,
            size: result.size,
        });
        return result;
    }

    private handleUpdateContext(slotId: string, name: string, body: string): BridgeContextResult | null {
        const slot = this.mcpRegistry?.get(slotId);
        if (!slot) return null;
        const parentChatId = slot.parentChatId;
        if (parentChatId === "__pending__") return null;
        const result = this.bridge.updateContext({ cwd: slot.cwd, chatId: parentChatId, ownerUserId: slot.ownerUserId, name, body });
        if (!result) return null;
        const client = this.getClient(slot.cwd);
        client?.injectUpdate(parentChatId, {
            sessionUpdate: "artifact_updated",
            contextId: result.id,
            name: result.name,
            filePath: result.filePath,
            size: result.size,
        });
        return result;
    }

    private handleSetFollowUps(slotId: string, followUps: string[]): void {
        const slot = this.mcpRegistry?.get(slotId);
        if (!slot) return;
        const parentChatId = slot.parentChatId;
        if (parentChatId === "__pending__") return;
        const cleaned = followUps.map((f) => f.trim()).filter(Boolean).slice(0, 3);
        if (cleaned.length === 0) return;
        this.getClient(slot.cwd)?.injectUpdate(parentChatId, {
            sessionUpdate: "follow_ups",
            followUps: cleaned,
        });
    }

    private handleSetBranchOverview(slotId: string, overview: string): void {
        const slot = this.mcpRegistry?.get(slotId);
        if (!slot) return;
        const parentChatId = slot.parentChatId;
        if (parentChatId === "__pending__") return;
        const cleaned = overview.trim();
        if (!cleaned) return;
        this.getClient(slot.cwd)?.injectUpdate(parentChatId, {
            sessionUpdate: "branch_overview",
            overview: cleaned,
        });
    }

    private async handleAskUser(
        slotId: string,
        questions: Array<{
            question: string;
            header?: string;
            options: Array<{ label: string; description?: string }>;
            multiSelect: boolean;
        }>,
    ): Promise<Record<string, string> | null> {
        const slot = this.mcpRegistry?.get(slotId);
        if (!slot) return null;
        const parentChatId = slot.parentChatId;
        if (parentChatId === "__pending__") return null;

        const requestId = ++this.nextUserInputRequestId;
        const client = this.getClient(slot.cwd);

        // Push user_input_request so frontend renders the banner
        client?.injectUpdate(parentChatId, {
            sessionUpdate: "user_input_request",
            requestId,
            questions,
        });

        const TIMEOUT_MS = parseInt(process.env.MICHI_APPROVE_TIMEOUT_MS ?? "300000", 10);
        const answers = await new Promise<Array<{ question: string; answer: string }> | null>((resolve) => {
            const timer = setTimeout(() => {
                this.pendingUserInputs.delete(requestId);
                resolve(null);
            }, TIMEOUT_MS);
            this.pendingUserInputs.set(requestId, { resolve, timer });
        });

        // Push resolved event so frontend clears the banner
        client?.injectUpdate(parentChatId, {
            sessionUpdate: "user_input_resolved",
            requestId,
            answers: answers ?? [],
        });

        if (answers) {
            const result: Record<string, string> = {};
            for (const a of answers) result[a.question] = a.answer;
            return result;
        }
        return null;
    }

    respondToUserInput(requestId: number, answers: Array<{ question: string; answer: string }>): void {
        const entry = this.pendingUserInputs.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pendingUserInputs.delete(requestId);
        entry.resolve(answers);
    }

    skipUserInput(requestId: number): void {
        const entry = this.pendingUserInputs.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pendingUserInputs.delete(requestId);
        entry.resolve(null);
    }

    ensureClient(cwd: string, model?: string): Promise<AcpClient> {
        const alive = this.pool.get(cwd);
        if (alive && alive.isAlive()) {
            perf.mark("ensureClient:hit", { cwd });
            this.cancelIdleTimer(cwd);
            this.touchCwdActivity(cwd);
            return Promise.resolve(alive);
        }
        const pending = this.startLocks.get(cwd);
        if (pending) {
            perf.mark("ensureClient:pending", { cwd });
            return pending;
        }

        // Previous client for this cwd died; purge its sessions so we don't
        // leak dead sessionIds into new requests.
        if (alive) {
            this.pool.delete(cwd);
            this.purgeSessionsForCwd(cwd);
        }

        const t0 = perf.now();
        const p = (async () => {
            try {
                // Enforce global process cap before spawning a new process.
                if (this.activeProcessCount >= this.processCap) {
                    const evicted = await this.evictLruIdleProcess();
                    if (!evicted) {
                        throw new KiroProcessCapError(
                            `Kiro process cap (${this.processCap}) reached. All ${this.pool.size} processes have active sessions.`,
                        );
                    }
                }

                const c = new AcpClient(undefined, cwd, model);
                c.onExit(() => {
                    // If this is still the current client for that cwd, purge.
                    if (this.pool.get(cwd) === c) {
                        this.pool.delete(cwd);
                        this.purgeSessionsForCwd(cwd);
                    }
                });
                c.start();
                await c.initialize();
                this.pool.set(cwd, c);
                this.cancelIdleTimer(cwd);
                this.touchCwdActivity(cwd);
                perf.measure("ensureClient:cold", t0, { cwd });
                return c;
            } finally {
                this.startLocks.delete(cwd);
            }
        })();
        this.startLocks.set(cwd, p);
        return p;
    }

    /**
     * Force a fresh kiro process for a cwd, even if the current one still
     * reports isAlive(). Used by connection-class recovery: a `dispatch
     * failure` / stalled-stream error means the live process is holding a dead
     * AWS-SDK connection pool, so opening a new session on it would fail too —
     * only a new process clears it. Tears down the old client (SIGTERM→KILL),
     * purges its sessions + MCP slots, then cold-starts via ensureClient.
     */
    async forceRespawn(cwd: string): Promise<AcpClient> {
        const old = this.pool.get(cwd);
        if (old) {
            // Drop from the pool first so the onExit hook (which also purges)
            // sees `pool.get(cwd) !== old` and no-ops — we purge explicitly.
            this.pool.delete(cwd);
            await old.shutdown().catch(() => {});
            this.purgeSessionsForCwd(cwd);
        }
        return this.ensureClient(cwd);
    }

    /**
     * Recover a single dead session after a connection-class failure: respawn
     * the process, then `session/load` the SAME sid so kiro restores the full
     * on-disk transcript (~/.kiro/sessions/cli/<sid>.jsonl) — the model keeps
     * its memory of prior turns. The nativeSessionId is unchanged, so the
     * caller's KiroSession stays valid; only the MCP slot + runtime maps are
     * rebuilt (loadAcpSession handles both). Returns true iff the reload
     * succeeded; on failure the caller surfaces the original error.
     *
     * `purgeSessionsForCwd` (inside forceRespawn) drops the slot + registry
     * binding, so we snapshot the rebind metadata BEFORE respawning.
     */
    async recoverSession(sid: string, cwd: string): Promise<boolean> {
        const nodeId = this.nodeIdBySid.get(sid) ?? sid;
        const model = this.sessionCurrentModel.get(sid);
        const slotId = this.slotByChatId.get(sid);
        const slot = slotId ? this.mcpRegistry?.get(slotId) : undefined;
        const workspaceId = slot?.workspaceId ?? null;
        const ownerUserId = slot?.ownerUserId ?? null;

        await this.forceRespawn(cwd);
        try {
            await this.loadAcpSession({
                sessionId: sid,
                cwd,
                model: model ?? undefined,
                workspaceId,
                nodeId,
                ownerUserId,
            });
            return true;
        } catch (err) {
            perf.mark("recoverSession:load_failed", { cwd, sid });
            return false;
        }
    }

    /**
     * Rebind an Agent Run session after ACP process replacement.
     *
     * When an ACP process dies and is respawned, `purgeSessionsForCwd` clears
     * all runtime maps/slots for that cwd. A Run Attempt's Coordinator then
     * calls this method with the Attempt's persisted binding metadata. The
     * method:
     *
     * 1. Spawns or reuses a fresh client for the cwd.
     * 2. Calls ACP `session/load` with the original native session id.
     * 3. Creates a fresh owner-aware MCP slot with the Run's tool profile.
     * 4. Restores all binding records, cwd maps, and mode/model caches.
     * 5. Returns the rebuilt `KiroSession`.
     *
     * Unlike `recoverSession` (chat-specific, calls `loadAcpSession` with a
     * Node-oriented slot), this method reconstructs the full Run binding
     * including owner, broker, result callback, and tool profile.
     *
     * @throws When the ACP `session/load` fails or the client cannot start.
     */
    async rebindRunSession(binding: KiroSessionBinding): Promise<KiroSession> {
        const { publicSessionId, nativeSessionId, owner, cwd, workspaceId, ownerUserId, runtimeProfileHash, toolProfile, permissionBroker, modelId } = binding;

        if (owner.kind !== "agent_run") {
            throw new Error("rebindRunSession is only for agent_run owners");
        }

        perf.mark("rebindRunSession:start", { cwd, publicSessionId, nativeSessionId });

        // Build a fresh Run MCP slot.
        let slotId: string | undefined;
        const chatCallbacks = this.makeSlotCallbacks(() => slotId);
        const runOwner = owner as RuntimeSessionOwner & { kind: "agent_run" };
        const runToolProfile = toolProfile ?? { allowedToolNames: [] };
        const runCallbacks = buildRunMcpSlotCallbacks({
            owner: runOwner,
            workspaceId,
            ownerUserId,
            toolProfile: runToolProfile,
            chatCallbacks,
        });

        let mcpServers: Array<{ name: string; type: "http"; url: string; headers: [] }> = [];
        if (this.mcpRegistry) {
            const slot = this.mcpRegistry.create(
                nativeSessionId,
                cwd,
                ownerUserId,
                runCallbacks,
                { nodeId: null, workspaceId },
            );
            slotId = slot.slotId;
            mcpServers = [{
                name: "michi",
                type: "http",
                url: `${this.mcpBaseUrl}/mcp/${slotId}`,
                headers: [],
            }];
        }

        // Ensure client and load session.
        const c = await this.ensureClient(cwd, modelId ?? undefined);
        try {
            const result = await c.loadSession(nativeSessionId, cwd, mcpServers);
            if (result.modes?.currentModeId) {
                this.sessionCurrentMode.set(nativeSessionId, result.modes.currentModeId);
            }
            this.absorbModes(result.modes);
            this.absorbModels(nativeSessionId, result.models);
        } catch (err) {
            if (slotId) await this.mcpRegistry?.dispose(slotId).catch(() => {});
            throw err;
        }

        // Restore all runtime maps.
        if (slotId) this.slotByChatId.set(nativeSessionId, slotId);
        this.sessionCwd.set(nativeSessionId, cwd);
        this.bindNodeSession(publicSessionId, nativeSessionId);
        this.cancelIdleTimer(cwd);
        this.touchCwdActivity(cwd);

        // Store the restored binding.
        this.storeBinding({
            publicSessionId,
            nativeSessionId,
            owner,
            cwd,
            workspaceId,
            ownerUserId,
            runtimeProfileHash,
            toolProfile,
            permissionBroker,
            slotId,
            modelId,
        });

        perf.mark("rebindRunSession:done", { cwd, publicSessionId, nativeSessionId });

        return new KiroSession(publicSessionId, nativeSessionId, this, cwd, {
            owner,
            runtimeProfileHash,
            toolProfile,
            permissionBroker,
        });
    }

    /**
     * "Test Connection": force a fresh kiro process for the cwd and prove it
     * can complete a `session/new` round-trip. A dead AWS-SDK connection pool
     * (the `dispatch failure` cause) can't be cleared without a new process, so
     * we always respawn first. The throw-away probe session is destroyed
     * immediately. Returns `{ ok }` or `{ ok:false, detail }` with kiro's
     * message so the UI can distinguish "back online" from "still broken".
     */
    async checkHealth(cwd: string): Promise<{ ok: boolean; detail?: string }> {
        try {
            const c = await this.forceRespawn(cwd);
            const { sessionId: sid } = await c.newSession([]);
            c.destroySession(sid);
            return { ok: true };
        } catch (err) {
            return { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
    }

    /**
     * Opportunistic update of the global availableModes cache from any
     * `modes` payload that came back with a session/new or session/load
     * response. First non-empty list wins; later sessions don't overwrite.
     */
    private absorbModes(modes: any): void {
        if (!modes) return;
        if (!this.globalAvailableModes && Array.isArray(modes.availableModes)) {
            this.globalAvailableModes = modes.availableModes;
        }
    }

    /**
     * Mirror of `absorbModes` for the `models` payload from session/new
     * and session/load. Caches the global model catalog and records the
     * currentModelId for the session.
     */
    private absorbModels(sid: string, models: any): void {
        if (!models) return;
        if (Array.isArray(models.availableModels)) {
            this.storeAvailableModels(models.availableModels);
        }
        if (typeof models.currentModelId === "string" && models.currentModelId) {
            this.sessionCurrentModel.set(sid, models.currentModelId);
        }
    }

    private normalizeModels(list: any[]): ModelInfo[] {
        return list
            .map((m: any): ModelInfo => ({
                id: String(m?.modelId ?? ""),
                label: typeof m?.name === "string" ? m.name : undefined,
                description: typeof m?.description === "string" ? m.description : undefined,
            }))
            .filter((m) => m.id);
    }

    private storeAvailableModels(list: any[]): void {
        this.globalAvailableModels = list;
        const normalized = this.normalizeModels(list);
        if (normalized.length > 0) {
            this.modelCache = normalized;
            this.modelCacheStore?.save(this.id, normalized);
        }
    }

    /**
     * Allocate a fresh MCP slot + open a new ACP session. Shared between
     * real-chat creation (newChat) and background pre-warming
     * (warmNextSession). Does NOT update the slot's parentChatId from
     * "__pending__" — the caller is responsible for that once the sid is
     * actually bound to a chat.
     *
     * Updates `sessionCurrentMode` and `globalAvailableModes` from the
     * session/new response so callers don't have to.
     */
    async openSession(
        c: AcpClient,
        cwd: string,
        makeCallbacks: McpSlotCallbacksFactory,
    ): Promise<OpenSessionResult> {
        let slotId: string | undefined;
        let mcpServers: Array<{ name: string; type: "http"; url: string; headers: [] }> = [];
        if (this.mcpRegistry) {
            const cbs = makeCallbacks(() => slotId);
            const slot = this.mcpRegistry.create(
                "__pending__", // filled in when the sid is bound to a chat
                cwd,
                null, // ownerUserId: patched in newSession after openSession returns
                cbs,
                { nodeId: null },
            );
            slotId = slot.slotId;
            mcpServers = [
                {
                    name: "michi",
                    type: "http",
                    url: `${this.mcpBaseUrl}/mcp/${slotId}`,
                    headers: [],
                },
            ];
        }
        let result: { sessionId: string; modes?: any; models?: any; configOptions?: any };
        try {
            result = await c.newSession(mcpServers);
        } catch (err) {
            if (slotId) await this.mcpRegistry?.dispose(slotId).catch(() => {});
            throw err;
        }
        const { sessionId: sid, modes, models } = result;
        if (modes && typeof modes.currentModeId === "string") {
            this.sessionCurrentMode.set(sid, modes.currentModeId);
        }
        this.absorbModes(modes);
        this.absorbModels(sid, models);
        return { sid, slotId, modes };
    }

    /**
     * Restore a previously-created ACP session via session/load. Used by
     * ChatManager when the frontend has a persisted chatId from SQLite
     * but the current backend process doesn't know about it
     * (post-restart). Allocates a fresh MCP slot bound to the existing
     * sessionId (not the "__pending__" sentinel — we already know the
     * sid).
     *
     * Updates `sessionCurrentMode` and `globalAvailableModes` from the
     * session/load response.
     *
     * Named `loadAcpSession` (not `loadSession`) so it doesn't collide
     * with the `AgentRuntime.loadSession` contract method below — the
     * contract returns a thin `AgentSession`, while this rich variant is
     * called by ChatManager and exposes slotId + modes.
     */
    async loadAcpSession(opts: {
        sessionId: string;
        cwd: string;
        model?: string;
        /** Workspace this session belongs to — cached on the MCP slot as a fallback. */
        workspaceId?: string | null;
        /** Michi node id for the session, used as the durable MCP workspace binding. */
        nodeId?: string | null;
        /** Chat owner's Better-Auth user id. Scopes globalContext tool reads in cloud mode. */
        ownerUserId?: string | null;
    }): Promise<LoadSessionResult> {
        const { sessionId, cwd, model } = opts;
        const c = await this.ensureClient(cwd, model);
        const makeCallbacks: McpSlotCallbacksFactory = (getSlotId) =>
            this.makeSlotCallbacks(getSlotId);

        let slotId: string | undefined;
        let mcpServers: Array<{ name: string; type: "http"; url: string; headers: [] }> = [];
        if (this.mcpRegistry) {
            const cbs = makeCallbacks(() => slotId);
            const slot = this.mcpRegistry.create(sessionId, cwd, opts.ownerUserId ?? null, cbs, {
                nodeId: opts.nodeId ?? null,
                workspaceId: opts.workspaceId ?? null,
            });
            slotId = slot.slotId;
            mcpServers = [
                {
                    name: "michi",
                    type: "http",
                    url: `${this.mcpBaseUrl}/mcp/${slotId}`,
                    headers: [],
                },
            ];
        }

        let result: { modes?: any; models?: any };
        try {
            result = await c.loadSession(sessionId, cwd, mcpServers);
        } catch (err) {
            if (slotId) await this.mcpRegistry?.dispose(slotId).catch(() => {});
            throw err;
        }
        if (result.modes?.currentModeId) {
            this.sessionCurrentMode.set(sessionId, result.modes.currentModeId);
        }
        this.absorbModes(result.modes);
        this.absorbModels(sessionId, result.models);
        return { sid: sessionId, slotId, modes: result.modes };
    }

    /**
     * Kick off a background session/new for this cwd so the next chat
     * creation can claim a pre-warmed sid instead of paying ~3.7s for
     * the round-trip. No-op if a warmed session already exists or if a
     * warm is already in flight. Fire-and-forget from the caller's
     * perspective — errors are logged but not thrown.
     *
     * `makeCallbacks` is provided by ChatManager because the callbacks
     * need to close over a slotId getter and route to ChatManager state.
     */
    warmNextSession(cwd: string): void {
        if (this.warmedSessions.has(cwd)) return;
        if (this.warmSessionLocks.has(cwd)) return;
        const makeCallbacks: McpSlotCallbacksFactory = (getSlotId) => this.makeSlotCallbacks(getSlotId);
        const p = (async () => {
            const t0 = perf.now();
            try {
                const c = await this.ensureClient(cwd);
                const { sid, slotId, modes } = await this.openSession(c, cwd, makeCallbacks);
                // Double-check we still want this entry (shutdown race).
                if (this.pool.get(cwd) !== c) {
                    if (slotId) await this.mcpRegistry?.dispose(slotId);
                    return;
                }
                this.warmedSessions.set(cwd, { sid, slotId, currentModeId: modes?.currentModeId });
                perf.measure("warm:session_ready", t0, { cwd, sid });
            } catch (err) {
                console.warn(`[kiroRuntime] warmNextSession(${cwd}) failed:`, err);
            } finally {
                this.warmSessionLocks.delete(cwd);
            }
        })();
        this.warmSessionLocks.set(cwd, p);
    }

    /**
     * Pop the warmed session for this cwd, if any. Returns undefined
     * when the pool is empty. Caller is expected to bind the sid to a
     * chat (update slot parentChatId, fill sessions/sessionCwd maps).
     * Refilling the pool happens in the background via a follow-up
     * `warmNextSession` call from the caller — KiroRuntime cannot
     * trigger it itself because it needs the caller's
     * `makeCallbacks` factory.
     *
     * Side effect: if the warmed entry carried a `currentModeId`, the
     * sessionCurrentMode cache is populated for the sid before returning
     * — so callers don't have to thread the mode through themselves.
     */
    consumeWarmedSession(cwd: string): { sid: string; slotId?: string; currentModeId?: string } | undefined {
        const entry = this.warmedSessions.get(cwd);
        if (!entry) return undefined;
        this.warmedSessions.delete(cwd);
        if (entry.currentModeId) {
            this.sessionCurrentMode.set(entry.sid, entry.currentModeId);
        }
        // Refill in the background so the next request in this cwd is also fast.
        this.warmNextSession(cwd);
        return entry;
    }

    /** For ChatManager.cancel() etc. — return the live client for a cwd. */
    getClient(cwd: string): AcpClient | undefined {
        return this.pool.get(cwd);
    }

    /** Snapshot of the warmed-session entries (for shutdown slot release). */
    listWarmedSessions(): Array<{ sid: string; slotId?: string; currentModeId?: string }> {
        return [...this.warmedSessions.values()];
    }

    /** currentModeId for a session (undefined if unknown). */
    getCurrentMode(sid: string): string | undefined {
        return this.sessionCurrentMode.get(sid);
    }

    /**
     * Global ACP availableModes (kiro agent list). Lazily loaded. When
     * a background warmNextSession has an inflight session/new for
     * defaultCwd, we wait for it rather than opening a redundant session
     * — the warmed session's response populates globalAvailableModes as
     * a side effect. Only when no warm is available do we fall back to
     * opening our own throw-away session.
     */
    async getAvailableModes(): Promise<any[]> {
        if (this.globalAvailableModes) return this.globalAvailableModes;
        if (this.modesLoadLock) return this.modesLoadLock;

        // If a warmNextSession is already in flight for defaultCwd, wait
        // for it — it will populate globalAvailableModes via openSession's
        // modes response. Avoids double-paying session/new during startup
        // when the frontend's first /api/modes call races with warm().
        const inflightWarm = this.warmSessionLocks.get(this.defaultCwd);
        if (inflightWarm) {
            await inflightWarm.catch(() => {});
            if (this.globalAvailableModes) return this.globalAvailableModes;
        }

        const t0 = perf.now();
        this.modesLoadLock = (async () => {
            const c = await this.ensureClient(this.defaultCwd);
            const { sessionId: sid, modes, models } = await c.newSession([]);
            c.destroySession(sid);
            const list = Array.isArray(modes?.availableModes) ? modes.availableModes : [];
            this.globalAvailableModes = list;
            if (Array.isArray(models?.availableModels)) this.storeAvailableModels(models.availableModels);
            perf.measure("getAvailableModes:fallback_session_new", t0);
            return list;
        })().finally(() => {
            this.modesLoadLock = null;
        });
        return this.modesLoadLock;
    }

    /** Switch the active mode (kiro-cli uses this to switch agents). */
    async setMode(sid: string, modeId: string): Promise<void> {
        const cwd = this.getCwdForSession(sid);
        if (!cwd) throw new Error("unknown chat");
        const c = this.pool.get(cwd);
        if (!c) throw new Error("client not running");
        await c.setMode(sid, modeId);
        this.sessionCurrentMode.set(sid, modeId);
    }

    /** currentModelId for a session (undefined if unknown). */
    getCurrentModel(sid: string): string | undefined {
        return this.sessionCurrentModel.get(sid);
    }

    /**
     * Global ACP availableModels. Populated as a side effect of
     * absorbModels() on any session/new or session/load response. Falls
     * back to opening a session in defaultCwd to fetch the catalog.
     */
    async getAvailableModels(): Promise<any[]> {
        if (this.globalAvailableModels) return this.globalAvailableModels;
        await this.getAvailableModes().catch(() => {});
        return this.globalAvailableModels ?? [];
    }

    /** Switch the active model on a live ACP session. */
    async setModel(sid: string, modelId: string): Promise<void> {
        const cwd = this.getCwdForSession(sid);
        if (!cwd) throw new Error("unknown chat");
        const c = this.pool.get(cwd);
        if (!c) throw new Error("client not running");
        await c.setModel(sid, modelId);
        this.sessionCurrentModel.set(sid, modelId);
    }

    /** Forward a user's permission approval to the ACP client. */
    respondToPermission(sid: string, requestId: number, optionId: string): void {
        const cwd = this.getCwdForSession(sid);
        if (!cwd) return;
        const client = this.pool.get(cwd);
        client?.respondToPermission(requestId, optionId);
    }

    /** Forward a user's permission denial/cancellation to the ACP client. */
    cancelPermission(sid: string, requestId: number): void {
        const cwd = this.getCwdForSession(sid);
        if (!cwd) return;
        const client = this.pool.get(cwd);
        client?.cancelPermission(requestId);
    }

    /**
     * AgentRuntime contract: ensure the runtime is ready to handle
     * requests for `cwd` — start the ACP client, kick off a pre-warmed
     * session, and (for the boot-time defaultCwd warm) prime the global
     * modes cache off that warmed session's response so the frontend's
     * first /api/modes call doesn't pay another session/new.
     */
    async warm(cwd: string, opts?: { model?: string | null }): Promise<void> {
        await this.ensureClient(cwd, opts?.model ?? undefined);
        this.warmNextSession(cwd);
        const warmLock = this.warmSessionLocks.get(cwd);
        if (warmLock) await warmLock.catch(() => {});
        await this.getAvailableModes().catch(() => {});
    }

    /**
     * AgentRuntime contract: create a new session, allocate a real MCP
     * slot wired to this runtime's bridge, optionally consume a warmed
     * session, waiting for an in-flight warm slot before falling back to
     * a cold session/new, build the first-message preamble (including
     * ancestor stitching from sessionRegistry), prime the KiroSession,
     * and return it. The caller is expected to register the returned
     * session in sessionRegistry so subsequent ancestor lookups find it.
     *
     * For `agent_run` owners: always creates a fresh ACP `session/new` with a
     * dedicated owner-aware MCP slot via `buildRunMcpSlotCallbacks`. The warm
     * session pool is never consumed — Runs must have their own tool roster
     * (including `submit_agent_result`) from the start.
     */
    async newSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
        const owner: RuntimeSessionOwner = opts.owner ?? { kind: "chat_node", nodeId: opts.sessionId ?? "__unknown__" };
        const isAgentRun = owner.kind === "agent_run";

        // Defensive cap (safety valve). Skip when this node already has a bound
        // session so reconnects/double-loads are never rejected.
        const alreadyBound = opts.sessionId ? this.sidByNodeId.has(opts.sessionId) : false;
        if (!alreadyBound && this.sessionCwd.size >= this.concurrencyCap) {
            throw new KiroConcurrencyError(
                `Kiro concurrency cap (${this.concurrencyCap}) reached. Try again when an existing session finishes.`,
            );
        }

        const tTotal = perf.now();
        const c = await this.ensureClient(opts.cwd, opts.model ?? undefined);

        let sid: string;
        let slotId: string | undefined;

        if (isAgentRun) {
            // ---------------------------------------------------------------
            // Agent Run path: always fresh session/new with Run MCP slot.
            // Never consume the warm-session pool.
            // ---------------------------------------------------------------
            const tNew = perf.now();

            // Build the Run MCP slot callbacks using the W0 factory.
            const chatCallbacks = this.makeSlotCallbacks(() => slotId);
            const runOwner = owner as RuntimeSessionOwner & { kind: "agent_run" };
            const toolProfile = opts.toolProfile ?? { allowedToolNames: [] };
            const runCallbacks = buildRunMcpSlotCallbacks({
                owner: runOwner,
                workspaceId: opts.workspaceId ?? null,
                ownerUserId: opts.ownerUserId ?? null,
                toolProfile,
                chatCallbacks,
            });

            // Allocate the MCP slot and open the ACP session.
            let mcpServers: Array<{ name: string; type: "http"; url: string; headers: [] }> = [];
            if (this.mcpRegistry) {
                const slot = this.mcpRegistry.create(
                    "__pending__",
                    opts.cwd,
                    opts.ownerUserId ?? null,
                    runCallbacks,
                    { nodeId: null, workspaceId: opts.workspaceId ?? null },
                );
                slotId = slot.slotId;
                mcpServers = [{
                    name: "michi",
                    type: "http",
                    url: `${this.mcpBaseUrl}/mcp/${slotId}`,
                    headers: [],
                }];
            }

            let result: { sessionId: string; modes?: any; models?: any };
            try {
                result = await c.newSession(mcpServers);
            } catch (err) {
                if (slotId) await this.mcpRegistry?.dispose(slotId).catch(() => {});
                throw err;
            }
            sid = result.sessionId;
            if (result.modes?.currentModeId) {
                this.sessionCurrentMode.set(sid, result.modes.currentModeId);
            }
            this.absorbModes(result.modes);
            this.absorbModels(sid, result.models);

            // Finalize the slot binding.
            if (slotId) {
                const slot = this.mcpRegistry?.get(slotId);
                if (slot) {
                    slot.parentChatId = sid;
                }
                this.slotByChatId.set(sid, slotId);
            }

            perf.measure("newSession:agent_run", tNew, { cwd: opts.cwd, sid });
        } else {
            // ---------------------------------------------------------------
            // Chat path: existing warm-session + cold-open logic (unchanged).
            // ---------------------------------------------------------------
            let warmed = this.consumeWarmedSession(opts.cwd);
            if (!warmed) {
                const warmLock = this.warmSessionLocks.get(opts.cwd);
                if (warmLock) {
                    const tWait = perf.now();
                    perf.mark("newChat:warm_inflight_wait_start", { cwd: opts.cwd });
                    await warmLock.catch(() => {});
                    warmed = this.consumeWarmedSession(opts.cwd);
                    perf.measure(
                        warmed ? "newChat:warm_inflight_hit" : "newChat:warm_inflight_miss",
                        tWait,
                        { cwd: opts.cwd, sid: warmed?.sid },
                    );
                }
            }
            if (warmed) {
                sid = warmed.sid;
                slotId = warmed.slotId;
                perf.mark("newChat:warmed_hit", { cwd: opts.cwd, sid });
            } else {
                const tNew = perf.now();
                const opened = await this.openSession(c, opts.cwd, (getSlotId) =>
                    this.makeSlotCallbacks(getSlotId),
                );
                sid = opened.sid;
                slotId = opened.slotId;
                perf.measure("newChat:session_new", tNew, { cwd: opts.cwd, sid });
            }

            if (slotId) {
                const slot = this.mcpRegistry?.get(slotId);
                if (slot) {
                    slot.parentChatId = sid;
                    slot.nodeId = opts.sessionId ?? sid;
                    slot.workspaceId = opts.workspaceId ?? null;
                    slot.ownerUserId = opts.ownerUserId ?? null;
                    slot.agentRuns = resolveAgentRunToolsForSession(this.bridge, {
                        runtimeId: this.id,
                        sessionId: sid,
                        owner: { kind: 'chat_node', nodeId: opts.sessionId ?? sid },
                        ownerUserId: opts.ownerUserId ?? null,
                        workspaceId: opts.workspaceId ?? null,
                        nodeId: opts.sessionId ?? sid,
                    }) ?? undefined;
                }
                this.slotByChatId.set(sid, slotId);
            }
        }

        perf.measure("newChat:total", tTotal, { cwd: opts.cwd, sid, agentRun: isAgentRun });
        const publicId = isAgentRun
            ? (owner as Extract<RuntimeSessionOwner, { kind: "agent_run" }>).attemptId
            : (opts.sessionId ?? sid);

        this.sessionCwd.set(sid, opts.cwd);
        this.bindNodeSession(publicId, sid);

        // Store the binding record for owner-aware lookups and release guards.
        this.storeBinding({
            publicSessionId: publicId,
            nativeSessionId: sid,
            owner,
            cwd: opts.cwd,
            workspaceId: opts.workspaceId ?? null,
            ownerUserId: opts.ownerUserId ?? null,
            runtimeProfileHash: opts.profileHash ?? null,
            toolProfile: opts.toolProfile,
            permissionBroker: opts.permissionBroker,
            slotId,
            modelId: opts.model ?? null,
        });

        const enableFollowUps = isAgentRun ? false : (opts.enableFollowUps !== false);
        const session = new KiroSession(publicId, sid, this, opts.cwd, {
            parentChatId: opts.parentChatId,
            enableFollowUps,
            owner,
            runtimeProfileHash: opts.profileHash ?? null,
            toolProfile: opts.toolProfile,
            permissionBroker: opts.permissionBroker,
        });

        if (!isAgentRun) {
            // Walk the parent's chain (parent's own ancestors + parent itself).
            // The new sid is not yet in sessionRegistry — caller registers it on
            // return — so we explicitly resolve from opts.parentChatId.
            const ancestorChain: AgentSession[] = [];
            if (opts.parentChatId) {
                sessionRegistry.ensureAncestorChainLoaded(opts.parentChatId);
                const parent = sessionRegistry.getSession(opts.parentChatId);
                if (parent) {
                    ancestorChain.push(...sessionRegistry.getAncestors(opts.parentChatId), parent);
                }
            }

            const workspaceInstructions = opts.workspaceId
                ? getWorkspaceInstructions(opts.workspaceId)
                : null;

            const preamble = buildPreamble({
                enableFollowUps,
                cwd: opts.cwd,
                contextManifest: opts.contextManifest,
                extraContexts: opts.extraContexts,
                ancestors: ancestorChain,
                mergeContexts: opts.mergeContexts,
                workspaceInstructions,
            });
            session.primeFirstMessage(preamble);
        } else if (opts.bootstrapInstructions) {
            // Agent Run sessions use bootstrap instructions as the first-message preamble.
            session.primeFirstMessage(opts.bootstrapInstructions);
        }

        return session;
    }

    /**
     * AgentRuntime contract: restore an existing session by id with the
     * runtime's real MCP slot callbacks. The returned session has
     * primed=true semantics (no preamble re-injected; the original
     * preamble was sent in the prior backend run).
     *
     * For `agent_run` owners: the `nativeResumeToken` from the Attempt's
     * recovery metadata is used as the ACP session id. The method MUST NOT
     * query the nodes table — Runs have no backing node row.
     */
    async loadSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
        const owner: RuntimeSessionOwner = opts.owner ?? { kind: "chat_node", nodeId: opts.nodeId ?? opts.sessionId };
        const isAgentRun = owner.kind === "agent_run";

        let nativeSessionId: string;

        if (isAgentRun) {
            // Agent Run path: use nativeResumeToken directly — never query nodes.
            if (!opts.nativeResumeToken || typeof opts.nativeResumeToken !== "string") {
                throw new Error("Kiro agent_run loadSession requires a string nativeResumeToken (ACP session id)");
            }
            nativeSessionId = opts.nativeResumeToken;
        } else {
            // Chat path: existing Node-based ACP sid lookup (unchanged).
            const nodeId = opts.nodeId ?? opts.sessionId;
            const storedSid = getNode(nodeId)?.acp_session_id ?? null;
            nativeSessionId = storedSid && storedSid !== nodeId
                ? storedSid
                : opts.nodeId
                    ? opts.sessionId
                    : storedSid ?? opts.sessionId;
        }

        const publicId = isAgentRun
            ? (owner as Extract<RuntimeSessionOwner, { kind: "agent_run" }>).attemptId
            : (opts.nodeId ?? opts.sessionId);

        if (isAgentRun) {
            // Build a fresh Run MCP slot for the resumed session.
            const chatCallbacks = this.makeSlotCallbacks(() => resumeSlotId);
            const runOwner = owner as RuntimeSessionOwner & { kind: "agent_run" };
            const toolProfile = opts.toolProfile ?? { allowedToolNames: [] };
            let resumeSlotId: string | undefined;
            const runCallbacks = buildRunMcpSlotCallbacks({
                owner: runOwner,
                workspaceId: opts.workspaceId ?? null,
                ownerUserId: opts.ownerUserId ?? null,
                toolProfile,
                chatCallbacks,
            });

            let mcpServers: Array<{ name: string; type: "http"; url: string; headers: [] }> = [];
            if (this.mcpRegistry) {
                const slot = this.mcpRegistry.create(
                    nativeSessionId,
                    opts.cwd,
                    opts.ownerUserId ?? null,
                    runCallbacks,
                    { nodeId: null, workspaceId: opts.workspaceId ?? null },
                );
                resumeSlotId = slot.slotId;
                mcpServers = [{
                    name: "michi",
                    type: "http",
                    url: `${this.mcpBaseUrl}/mcp/${resumeSlotId}`,
                    headers: [],
                }];
            }

            const c = await this.ensureClient(opts.cwd, opts.model ?? undefined);
            try {
                const result = await c.loadSession(nativeSessionId, opts.cwd, mcpServers);
                if (result.modes?.currentModeId) {
                    this.sessionCurrentMode.set(nativeSessionId, result.modes.currentModeId);
                }
                this.absorbModes(result.modes);
                this.absorbModels(nativeSessionId, result.models);
            } catch (err) {
                if (resumeSlotId) await this.mcpRegistry?.dispose(resumeSlotId).catch(() => {});
                throw err;
            }

            if (resumeSlotId) this.slotByChatId.set(nativeSessionId, resumeSlotId);
            this.sessionCwd.set(nativeSessionId, opts.cwd);
            this.bindNodeSession(publicId, nativeSessionId);

            this.storeBinding({
                publicSessionId: publicId,
                nativeSessionId,
                owner,
                cwd: opts.cwd,
                workspaceId: opts.workspaceId ?? null,
                ownerUserId: opts.ownerUserId ?? null,
                runtimeProfileHash: opts.profileHash ?? null,
                toolProfile: opts.toolProfile,
                permissionBroker: opts.permissionBroker,
                slotId: resumeSlotId,
                modelId: opts.model ?? null,
            });

            return new KiroSession(publicId, nativeSessionId, this, opts.cwd, {
                owner,
                runtimeProfileHash: opts.profileHash ?? null,
                toolProfile: opts.toolProfile,
                permissionBroker: opts.permissionBroker,
            });
        }

        // Chat path (unchanged).
        const nodeId = opts.nodeId ?? opts.sessionId;
        const result = await this.loadAcpSession({
            sessionId: nativeSessionId,
            cwd: opts.cwd,
            model: opts.model ?? undefined,
            workspaceId: opts.workspaceId ?? null,
            nodeId,
            ownerUserId: opts.ownerUserId ?? null,
        });
        if (result.slotId) {
            const slot = this.mcpRegistry?.get(result.slotId);
            if (slot) {
                slot.agentRuns = resolveAgentRunToolsForSession(this.bridge, {
                    runtimeId: this.id,
                    sessionId: result.sid,
                    owner: { kind: 'chat_node', nodeId },
                    ownerUserId: opts.ownerUserId ?? null,
                    workspaceId: opts.workspaceId ?? null,
                    nodeId,
                }) ?? undefined;
            }
        }
        if (result.slotId) this.slotByChatId.set(result.sid, result.slotId);
        this.sessionCwd.set(result.sid, opts.cwd);
        this.bindNodeSession(nodeId, result.sid);

        this.storeBinding({
            publicSessionId: nodeId,
            nativeSessionId: result.sid,
            owner,
            cwd: opts.cwd,
            workspaceId: opts.workspaceId ?? null,
            ownerUserId: opts.ownerUserId ?? null,
            runtimeProfileHash: opts.profileHash ?? null,
            toolProfile: opts.toolProfile,
            permissionBroker: opts.permissionBroker,
            slotId: result.slotId,
            modelId: opts.model ?? null,
        });

        return new KiroSession(nodeId, result.sid, this, opts.cwd, {
            owner,
            runtimeProfileHash: opts.profileHash ?? null,
        });
    }

    /**
     * AgentRuntime contract: release a session by public id.
     *
     * When `expectedOwner` is provided, ownership is verified before teardown.
     * A stale Attempt cannot release a session that has been rebound to a new
     * chat or another Run's session — the session is left intact for its real
     * owner.
     */
    async releaseSession(sessionId: string, expectedOwner?: RuntimeSessionOwner): Promise<void> {
        const sid = this.sidByNodeId.get(sessionId) ?? sessionId;
        const nodeId = this.nodeIdBySid.get(sid) ?? sessionId;

        // Owner verification guard.
        if (expectedOwner) {
            const binding = this.bindings.get(nodeId) ?? this.bindings.get(sessionId);
            if (binding) {
                assertOwner(binding.owner, expectedOwner);
            }
        }

        const cwd = this.sessionCwd.get(sid);
        const client = cwd ? this.pool.get(cwd) : undefined;
        if (client) {
            await client.cancel(sid).catch(() => {});
            client.destroySession(sid);
        }
        const slotId = this.slotByChatId.get(sid);
        if (slotId) {
            await this.mcpRegistry?.dispose(slotId).catch(() => {});
        }
        this.slotByChatId.delete(sid);
        this.sessionCwd.delete(sid);
        this.sessionCurrentMode.delete(sid);
        this.sessionCurrentModel.delete(sid);
        this.unbindNativeSession(sid);
        sessionRegistry.dropSession(nodeId);

        // If the cwd now has no live sessions, schedule idle cleanup.
        if (cwd && this.liveSessionCountForCwd(cwd) === 0) {
            this.touchCwdActivity(cwd);
            this.scheduleIdleCleanup(cwd);
        }
    }

    /**
     * AgentRuntime contract: list available agent modes. Adapts the
     * existing `getAvailableModes` payload into the SessionMode shape
     * (id/label/description). Kiro's modes are global, not per-session,
     * so the sessionId arg is ignored.
     */
    async listModes(_sessionId: string): Promise<SessionMode[]> {
        const list = await this.getAvailableModes();
        return list
            .map((m: any): SessionMode => ({
                id: String(m?.id ?? ""),
                label: typeof m?.name === "string" ? m.name : undefined,
                description: typeof m?.description === "string" ? m.description : undefined,
            }))
            .filter((m) => m.id);
    }

    /**
     * AgentRuntime contract: list available ACP models. Adapts the
     * existing `getAvailableModels` payload into the ModelInfo shape.
     * Kiro's models are global (kiro-cli's bundled claude variants), not
     * per-session.
     *
     * NOTE: ACP names this field `modelId` (not `id` like modes use). Don't
     * "normalize" it here — `setModel` round-trips the same string back to
     * `session/set_model { modelId }`, and renaming would silently desync.
     */
    async listModels(): Promise<ModelInfo[]> {
        if (this.modelCache) {
            void this.refreshModels().catch((err: unknown) => {
                console.warn("[KiroRuntime] model refresh failed; using cached catalog:", (err as Error).message);
            });
            return this.modelCache;
        }
        return this.refreshModels();
    }

    async refreshModels(): Promise<ModelInfo[]> {
        if (this.modelRefreshLock) return this.modelRefreshLock;

        this.modelRefreshLock = (async () => {
            const live = await this.getAvailableModels();
            const normalized = this.normalizeModels(live);
            // Preserve the previous snapshot when Kiro returns a transiently
            // empty models payload during startup.
            if (normalized.length > 0) {
                this.modelCache = normalized;
                this.modelCacheStore?.save(this.id, normalized);
            }
            return this.modelCache ?? normalized;
        })().finally(() => {
            this.modelRefreshLock = null;
        });

        return this.modelRefreshLock;
    }

    /** Shutdown: kill all clients in pool and reset internal maps. */
    async shutdown(): Promise<void> {
        // Clear pending user-input requests (avoid leaked timers + dangling promises).
        for (const [, entry] of this.pendingUserInputs) {
            clearTimeout(entry.timer);
            entry.resolve(null);
        }
        this.pendingUserInputs.clear();

        // Clear all idle timers so they don't fire after shutdown.
        for (const timer of this.idleTimers.values()) clearTimeout(timer);
        this.idleTimers.clear();
        this.cwdLastActivity.clear();

        // Release slots held by warmed (unclaimed) sessions before dropping clients.
        for (const entry of this.warmedSessions.values()) {
            if (entry.slotId) await this.mcpRegistry?.dispose(entry.slotId);
        }
        // Release slots bound to live sessions.
        for (const slotId of this.slotByChatId.values()) await this.mcpRegistry?.dispose(slotId);
        this.slotByChatId.clear();
        this.sessionCwd.clear();
        this.sidByNodeId.clear();
        this.nodeIdBySid.clear();
        this.bindings.clear();
        this.publicIdByNativeSid.clear();
        const clients = [...this.pool.values()];
        this.pool.clear();
        this.warmedSessions.clear();
        this.warmSessionLocks.clear();
        this.sessionCurrentMode.clear();
        this.sessionCurrentModel.clear();
        this.globalAvailableModes = null;
        this.globalAvailableModels = null;
        await Promise.all(clients.map((c) => c.shutdown().catch(() => {})));
    }
}
