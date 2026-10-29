import { assertToolCatalog, catalogUnavailable, guardError } from '../../core/restrictedCatalog';
import { assertReleaseOwnership } from '../../core/release';
import { RuntimeModelCatalog } from '../../core/modelCatalog';
import { PendingSessionAcquisitions } from '../../core/sessionAcquisition';
import { isCrewMemoryMode } from 'michi-shared';
import { AcpClient } from "./acpClient";
import type { McpSlotProvider, McpSlotCallbacks, McpSlotEventSink } from "../../contract/mcp";
import type {
    AgentCapabilities,
    AgentRuntime,
    AgentSession,
    AgentTurnInput,
    LoadAgentSessionOptions,
    ModelInfo,
    NewAgentSessionOptions,
    ForkAgentSessionOptions,
    RuntimeAvailability,
    RuntimeSessionOwner,
    RuntimeToolProfile,
    RuntimePermissionBroker,
    SessionMode,
} from "../../contract/types";
import { assertOwner, interactiveOwner } from "../../contract/types";
import { isHeadlessOwner, isInteractiveOwner } from './kiroOwner';
import { KiroSession } from "./KiroSession";
import type { AgentToolBridge, BridgeContextResult, SpawnedBranch } from "../../contract/tools";
import { resolveAgentRunToolsForSession } from "../../contract/tools";
import type { RuntimeModelCache } from "../../core/runtimeModelCache";
import { buildRunMcpSlotCallbacks } from "../../core/runMcpSlot";
import { hostEventSink } from "../../core/hostEventSink";
import { resolveShowImage } from "../../core/showImage";
import { hostEventUpdate } from "./kiroHostEvents";
import { NativeResumeFailedError, NativeResumeUnavailableError } from '../../contract/errors';
import { classifyAcpError, isNativeSessionUnavailable, KiroCancelRecoveryBusyError } from './acpErrors';
import { ACPNotRunningError, ACPProcessExitedError, probeKiroCli } from './acpClient';
import { KiroTitleGenerator } from './kiroTitleGenerator';
import type { GenerateTitleOptions } from '../../contract/types';
import { KIRO_APPROVE_FOR_ME_PRESET, KIRO_METADATA_DONE_SENTINEL, michiMcpServer, michiSessionMcpServer, rewindPoints, type AcpMcpServer, type KiroEngine } from './kiroProtocol';
import { kiroDescriptor, type KiroDescriptorOverride } from './kiroDescriptor';
import { KIRO_FLAVOR, joinSessionMetadata, type KiroFlavor } from './kiroFlavor';
import type { RuntimeDescriptor } from '../../contract/descriptor';
import type { PreambleInput, RuntimeHost, RuntimePortName, WorkflowRunContext } from '../../contract/host';
import { assertHostPorts } from '../../core/defaultHost';
import { sanitizeReasoningLevels, isReasoningLevel } from 'michi-shared';
import type { AcpLaunch, AcpClientOptions, AcpProcessOptions } from './acpClient';
import { createKiroWorkflowBridge } from '../../core/workflows/kiroWorkflowBridge';

// ---------------------------------------------------------------------------
// Process lifecycle constants
// ---------------------------------------------------------------------------

/** Defaults of the KiroAdapterOptions of the same names. */
const DEFAULT_PROCESS_CAP = 20;
const DEFAULT_IDLE_TTL_MS = 300_000;
const DEFAULT_WARM_POOL_SIZE = 3;
const DEFAULT_CONCURRENCY_CAP = 100;
const DEFAULT_APPROVE_TIMEOUT_MS = 300_000;

/**
 * kiro-cli v2 publishes no per-model effort metadata, but its `auto` router
 * rejects `/effort` ("Effort configuration is currently not available on
 * auto"). Mark it explicitly so the composer disables the control and session
 * setup skips applying effort instead of failing the turn. v3 reports this
 * through `_meta.kiro.hasEffort`, so it never needs the override.
 */
const KIRO_V2_MODELS_WITHOUT_EFFORT = new Set(["auto"]);

export function markKiroV2EffortSupport(models: ModelInfo[]): ModelInfo[] {
    return models.map((model) => KIRO_V2_MODELS_WITHOUT_EFFORT.has(model.id) && model.supportsReasoning === undefined
        ? { ...model, supportsReasoning: false, supportedReasoningLevels: [] }
        : model);
}

export interface OpenSessionResult {
    crewMemoryMode?: import("michi-shared").CrewMemoryMode;
    sid: string;
    slotId?: string;
    modes?: any;
}
export interface LoadSessionResult {
    sid: string;
    slotId?: string;
    modes?: any;
}

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
    engine?: KiroEngine;
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
 * Builds a session's MCP slot callbacks (KiroRuntime.makeSlotCallbacks).
 * Receives a getter for the slotId that resolves once the slot has been
 * allocated, since the callbacks and the slot's sink look their slot up
 * when they run.
 */
export type McpSlotCallbacksFactory = (getSlotId: () => string | undefined) => McpSlotCallbacks;

/** Whether a Meta agent session's tools may run: checked once, stopped for good on a later violation. */
interface MetaAgentGate { verified: boolean; failed: boolean }

/**
 * One kiro-cli shared by the Meta agent sessions of one toolset and agent
 * config (see KiroRuntime.openSharedMetaAgentSession). `sessions` are the
 * public ids opening on or bound to it. A retired worker takes no new
 * sessions and stops once its last one is released.
 */
interface SharedMetaAgentWorker {
    /** The toolset (and user, where users are isolated): one live worker per family. */
    family: string;
    key: string;
    worker: KiroRuntime;
    sessions: Set<string>;
    retired: boolean;
    idleTimer: NodeJS.Timeout | null;
    lastUsedAt: number;
}

/**
 * Owns the ACP client pool keyed by cwd, the pre-warmed session pool,
 * the per-session current-mode cache, and the global availableModes
 * cache.
 *
 * The pool is keyed by cwd within one engine. Model selection is applied to
 * each session, including warm sessions claimed from the same process.
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

/**
 * The adapter's options. Every optional field defaults to today's Kiro
 * behavior; the non-engine fields let another ACP agent that speaks Kiro's
 * protocol (Kiro Crew) reuse this runtime under its own id. Michi reads the
 * environment-backed ones in michiKiroOptions.ts; a v3 session worker gets
 * its parent's.
 */
export interface KiroAdapterOptions extends AcpProcessOptions {
    /** Host-owned restricted agent config and tool catalog policy. Absent: restricted sessions are refused. */
    restrictedAgent?: {
        ensure(dataDir: string, toolset: string, names: readonly string[]): { dir: string; agentName: string };
        clientOptions(engine: KiroEngine, agentName: string): AcpClientOptions;
        catalog(tags: readonly unknown[]): string[];
        /** Catalog entries outside the profile's tools that the host still accepts, in `catalog` terms. */
        extraAllowed?: readonly string[];
        isRestrictedMode?(modeId: string): boolean;
        verify(input: { client: AcpClient; sessionId: string; engine: KiroEngine; runtimeId: string; profile: RuntimeToolProfile; sinceSeq?: number }): Promise<string[]>;
    };
    /**
     * Runtime host ports. Required; see KIRO_HOST_PORTS. A v3 session worker
     * runs on its parent's host (and slot provider).
     */
    host: RuntimeHost;
    /** Kiro engine generation. Default v2; Michi's MICHI_KIRO_ENGINE resolves unset to v3 (resolveKiroEngine). */
    engine?: KiroEngine;
    isolatedSession?: boolean;
    /**
     * Maximum number of concurrent kiro-cli processes (Michi:
     * MICHI_KIRO_MAX_PROCESSES). Each worktree cwd maps to one process; this
     * cap prevents unbounded process creation when many concurrent Runs
     * target distinct worktrees. Default 20.
     */
    processCap?: number;
    /**
     * Idle TTL for a cwd-keyed kiro-cli process with no live sessions
     * (Michi: MICHI_KIRO_IDLE_TTL_MS). After this period the process is
     * terminated to free resources. Reset whenever a new session binds to the
     * cwd. 0 disables it. Default 5 minutes.
     */
    idleTtlMs?: number;
    /**
     * Number of pre-warmed ACP sessions to keep per cwd (Michi:
     * MICHI_KIRO_WARM_POOL_SIZE), at least 1. When a warmed session is
     * consumed, the pool replenishes in the background up to this depth.
     * Higher values reduce cold-start latency when many threads open
     * concurrently at the cost of idle session memory. Default 3.
     */
    warmPoolSize?: number;
    /** Maximum number of bound sessions (Michi: MICHI_KIRO_MAX_CONCURRENT). Default 100. */
    concurrencyCap?: number;
    /** How long ask_user waits for an answer (Michi: MICHI_APPROVE_TIMEOUT_MS), read per question. Default 5 minutes. */
    approveTimeoutMs?: () => number;
    /**
     * Custom Agents are on (Michi: MICHI_CUSTOM_AGENTS=1), so a shared v3 MCP
     * catalog advertises the Agent Run tools the bridge can create. Read
     * per catalog. Default off.
     */
    customAgents?: () => boolean;
    /** Runtime id. Default "kiro". Also keys the persistent model cache. */
    id?: string;
    /** Display label. Default "Kiro". */
    label?: string;
    /** How the agent differs from kiro-cli (Kiro Crew). Default KIRO_FLAVOR. */
    flavor?: KiroFlavor;
    /** Agent binary + argv. Default: kiro-cli with kiroArgs(engine, model). */
    launch?: AcpLaunch;
    /** false → no sidecar title generator. Default true (env-controlled). */
    sidecarTitles?: boolean;
    /** Applied last over the computed descriptor. */
    descriptorOverride?: KiroDescriptorOverride;
    /** Merged over the default Kiro capabilities. */
    capabilitiesOverride?: Partial<AgentCapabilities>;
    /**
     * Replaces the kiro-cli install probe. When it reports unavailable, the
     * runtime refuses to spawn its agent process (ensureClient rejects with
     * the detail) instead of starting a binary that cannot work.
     */
    checkAvailability?: () => RuntimeAvailability;
    /** Serialize startup and check sign-in without executing a CLI probe. */
    startClient?: (launch: () => Promise<void>) => Promise<void>;
    /**
     * Set only on the dedicated worker that hosts one Meta agent session: its
     * kiro-cli runs in the toolset's agent directory with that agent selected.
     */
    metaAgent?: { toolset: string; agentName: string };
}

/** What KiroRuntime is built from: the adapter's options plus the host's tool effects and MCP slots. */
export interface KiroRuntimeOptions extends KiroAdapterOptions {
    /** Business effects of the host's tools (spawn branches, save/update artifacts, Agent Run tools). */
    bridge: AgentToolBridge;
    /** The host's MCP slots, whose endpoints go into every session's MCP config. None: sessions get no host tools. */
    mcpSlots?: McpSlotProvider;
    /** Cwd for mode and model probes and the title session outside any chat. Default process.cwd(). */
    defaultCwd?: string;
    /** Persistent model catalog shared with the other CLI runtimes. */
    modelCache?: RuntimeModelCache;
}

/**
 * Host ports every Kiro runtime reads. backgroundTurns carries the turns v3
 * starts on its own; workflows (v3) and the flavor's own ports are added by
 * kiroHostPorts.
 */
const KIRO_HOST_PORTS: readonly RuntimePortName[] = [
    'config', 'prompt', 'profile', 'bindings', 'sessions', 'permissions', 'principal', 'observability', 'title', 'backgroundTurns',
];

function kiroHostPorts(flavor: KiroFlavor, engine: KiroEngine): RuntimePortName[] {
    return [
        ...KIRO_HOST_PORTS,
        ...(engine === 'v3' ? ['workflows' as const] : []),
        ...flavor.hostPorts,
    ];
}

const KIRO_CAPABILITIES: AgentCapabilities = {
    modes: true,
    permissions: true,
    models: true,
    providerModels: false,
    reasoning: true,
    supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    apiKeys: false,
    warmSessions: true,
    saveContext: true,
    spawnBranches: true,
    nativeResume: true,
    nativeResumeSettings: ['model', 'reasoning'],
};

export class KiroRuntime implements AgentRuntime {
    public readonly id: string;
    public readonly label: string;
    public readonly engine: KiroEngine;
    /** How this runtime's agent differs from kiro-cli; read instead of the id. */
    public readonly flavor: KiroFlavor;
    get nativeEngine(): KiroEngine { return this.engine; }
    /** Kiro V3's own agent (no launch override) has the Approve for me policy preset. */
    get approveForMe(): boolean { return this.engine === 'v3' && !this.runtimeOptions.launch; }

    /**
     * The policy presets a chat's session opens with: Approve for me when the
     * chat is in Ask with it on. Agent Runs and tool-profile sessions keep
     * Kiro's default policy. KiroSession reconciles a live session per turn.
     */
    policyPresetsFor(owner: RuntimeSessionOwner | undefined, ownerUserId?: string | null, toolProfile?: unknown): string[] {
        if (!this.approveForMe || toolProfile || !owner || !isInteractiveOwner(owner)) return [];
        const permissions = this.host.permissions;
        return permissions.mode(owner, ownerUserId) === 'ask' && permissions.approveForMe?.(owner, ownerUserId) === true
            ? [KIRO_APPROVE_FOR_ME_PRESET] : [];
    }
    get descriptor(): RuntimeDescriptor {
        return kiroDescriptor({
            engine: this.engine,
            clients: [...this.pool.values(), ...[...this.isolatedWorkers()].flatMap((worker) => [...worker.pool.values()])],
            mcpSlots: !this.mcpRegistry ? 'none' : this.sessionAnchorsEnabled ? 'chat-groups' : 'per-session',
            sidecarTitles: this.titleGenerator !== null,
            flavor: this.flavor,
            override: this.runtimeOptions.descriptorOverride,
        });
    }
    public readonly capabilities: AgentCapabilities;
    /** Native fork/rewind is attempted only while the descriptor advertises it. */
    private get nativeForkSupported(): boolean {
        return this.descriptor.harness.sessionFork.availability === 'native';
    }

    isNativeResumeRetryable(error: unknown): boolean {
        // A completed transient error or a dead process can be retried. An
        // idle timeout may still have a load running, so it stays fail-closed.
        if (classifyAcpError(error) === 'auth') return false;
        return error instanceof ACPNotRunningError || error instanceof ACPProcessExitedError
            || classifyAcpError(error) === 'transient';
    }

    /**
     * Kiro had no install probe of any kind: findKiroCli() returns a
     * conventional path whether or not anything is there, so a machine without
     * kiro-cli still advertised the runtime as ready and only failed on the
     * first send. A live client for any cwd is proof enough on its own;
     * otherwise re-test the resolved binary path.
     */
    checkAvailability(): RuntimeAvailability {
        if (this.runtimeOptions.checkAvailability) return this.runtimeOptions.checkAvailability();
        for (const client of this.pool.values()) {
            if (client.isAlive()) return { available: true };
        }
        const { path, installed } = probeKiroCli(this.runtimeOptions.kiroCli?.());
        if (installed) return { available: true };
        return { available: false, detail: `kiro-cli not found (looked for ${path})` };
    }

    private pool = new Map<string, AcpClient>();
    private startLocks = new Map<string, Promise<AcpClient>>();
    private readonly cancelRecoveryLocks = new Map<string, Promise<AcpClient>>();
    private readonly cancelRecoveryTimeoutMs = 20_000;
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
    /** `workflows`: whether the warm session was opened with Kiro workflows on. */
    private warmedSessions = new Map<string, Array<{ sid: string; slotId?: string; currentModeId?: string; workflows?: boolean }>>();
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
     * Default mode assigned by ACP to a fresh session, keyed by cwd. Kiro may
     * resolve workspace-local agent configuration during session/new, so this
     * must not be shared across workspaces. Loaded sessions never populate it
     * because their current mode may be a historical user override.
     */
    private readonly defaultModeByCwd = new Map<string, string>();
    /**
     * Global list of ACP models (claude-opus-4.7, claude-sonnet-4.6, etc.).
     * Like modes, empirically identical across sessions; cached once per boot.
     */
    private globalAvailableModels: any[] | null = null;
    private readonly modelCacheStore?: RuntimeModelCache;
    private readonly modelCatalog: RuntimeModelCatalog<any[]>;
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
    /** Pre-warmed ACP sessions kept per cwd; see KiroAdapterOptions.warmPoolSize. */
    private readonly warmPoolSize: number;
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
    /**
     * Sidecar title generation on a cheap model. Lives on the defaultCwd
     * process (which already hosts modes/models probes) so no chat workspace
     * pays for an extra kiro-cli, and title prompts never share a session
     * with a chat. `null` when disabled via MICHI_TITLE_MODEL_KIRO=off.
     */
    private readonly titleGenerator: KiroTitleGenerator | null;
    private closing = false;
    private readonly acquisitions = new PendingSessionAcquisitions<AgentSession>();
    private readonly acquiredSessions = new Map<string, AgentSession>();
    private readonly modelCacheKey: string;
    private readonly isolatedSession: boolean;
    private readonly sessionWorkers = new Map<string, KiroRuntime>();
    /** Live shared Meta agent workers by key; retired ones are dropped from here while they drain. */
    private readonly metaAgentWorkers = new Map<string, SharedMetaAgentWorker>();
    /** Public session id → the shared Meta agent worker it is on (a subset of sessionWorkers). */
    private readonly metaAgentWorkerBySession = new Map<string, SharedMetaAgentWorker>();
    private readonly sessionAnchorsEnabled: boolean;
    private readonly mcpSessionGroups = new Map<string, string>();
    /** ACP session id → its Meta agent gate (Meta agent workers only). */
    private readonly metaAgentGates = new Map<string, MetaAgentGate>();
    private readonly runtimeOptions: KiroRuntimeOptions;
    /** Business effects of spawn_branches, save_artifact and update_artifact. */
    private readonly bridge: AgentToolBridge;
    /** The host's MCP slots (KiroRuntimeOptions.mcpSlots). */
    private readonly mcpRegistry: McpSlotProvider | undefined;

    constructor(options: KiroRuntimeOptions) {
        // tsc cannot see untyped (JS or require'd) callers of the old positional
        // form, nor members left undefined.
        if (typeof options !== 'object' || options === null || options.host == null || options.bridge == null) {
            throw new TypeError('KiroRuntime takes one options object { host, bridge, mcpSlots?, … } (runtime contract v1)');
        }
        this.runtimeOptions = options;
        this.bridge = options.bridge;
        this.mcpRegistry = options.mcpSlots;
        this.id = options.id ?? "kiro";
        this.label = options.label ?? "Kiro";
        this.flavor = options.flavor ?? KIRO_FLAVOR;
        this.capabilities = { ...KIRO_CAPABILITIES, ...options.capabilitiesOverride };
        this.engine = options.engine ?? 'v2';
        assertHostPorts(options.host, kiroHostPorts(this.flavor, this.engine), `KiroRuntime (${this.id})`);
        this.isolatedSession = options.isolatedSession === true;
        // Local v3 chats share one stable MCP catalog/connection by default.
        // Run workers and cloud deployments retain their isolated tool profiles.
        this.sessionAnchorsEnabled = this.flavor.sessionAnchors && this.engine === 'v3' && !this.isolatedSession
            && !!this.mcpRegistry && !this.host.principal.enforceUserOwnership();
        this.modelCacheKey = this.engine === 'v2' ? this.id : `${this.id}-v3`;
        this.defaultCwd = options.defaultCwd ?? process.cwd();
        this.modelCacheStore = options.modelCache;
        const cachedModels = this.modelCacheStore?.load(this.modelCacheKey) ?? null;
        // Snapshots written before the v2 effort override still lack it.
        this.modelCatalog = new RuntimeModelCatalog({
            initial: cachedModels && this.engine === 'v2' ? markKiroV2EffortSupport(cachedModels) : cachedModels,
            probe: () => this.getAvailableModels(),
            normalize: (list) => this.normalizeModels(list),
            persist: (models) => this.modelCacheStore?.save(this.modelCacheKey, models),
        });
        this.concurrencyCap = options.concurrencyCap ?? DEFAULT_CONCURRENCY_CAP;
        this.processCap = options.processCap ?? DEFAULT_PROCESS_CAP;
        this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
        this.warmPoolSize = Math.max(1, options.warmPoolSize ?? DEFAULT_WARM_POOL_SIZE);
        // The sidecar title model is Kiro's; Crew turns sidecar titles off.
        const titleConfig = this.host.config.titleModel('kiro');
        this.titleGenerator = options.sidecarTitles !== false && this.host.title.enabled(this.id) && titleConfig.model
            ? new KiroTitleGenerator({
                ensureClient: () => this.ensureClient(this.defaultCwd),
                model: titleConfig.model,
                timeoutMs: titleConfig.timeoutMs,
                prompt: (userText, contextText) => this.host.title.prompt(userText, contextText),
                log: (...args) => this.host.observability.log(...args),
            })
            : null;
    }

    /** The runtime host ports this runtime and its sessions read. */
    get host(): RuntimeHost { return this.runtimeOptions.host; }

    /** How this runtime's ACP clients find and run kiro-cli, and report. */
    private acpClientOptions(): AcpClientOptions {
        const { kiroCli, acpIdleTimeoutMs, spawnEnv, preloadTools, onSignedOut } = this.runtimeOptions;
        return { kiroCli, acpIdleTimeoutMs, spawnEnv, preloadTools, onSignedOut, ...this.clientOptions(), observability: this.host.observability };
    }

    private get usesSessionWorkers(): boolean { return this.engine === 'v3' && !this.isolatedSession && !this.sessionAnchorsEnabled; }

    private chatMcpServer(cwd: string, slotId: string): AcpMcpServer {
        if (!this.sessionAnchorsEnabled) return michiMcpServer(this.engine, this.mcpRegistry!.endpoint(slotId));
        let groupId = this.mcpSessionGroups.get(cwd);
        if (!groupId) {
            const catalog = this.mcpRegistry!.get(slotId)!;
            // The catalog must not depend on which chat or warm slot was last
            // created. Actual calls use the selected slot's own invoker/gates.
            // Production Custom Agents is an environment-only feature gate.
            // A factory exists even while it is off; do not advertise its tools
            // merely because that function is present on the bridge.
            const exposesAgentRuns = this.bridge.agentRuns
                || (this.runtimeOptions.customAgents?.() === true && this.bridge.agentRunToolsForSession);
            const agentRuns = exposesAgentRuns
                ? { invoke: async () => { throw new Error('MCP catalog cannot execute tools'); } } : undefined;
            groupId = this.mcpRegistry!.createSessionGroup({ ...catalog, agentRuns });
            this.mcpSessionGroups.set(cwd, groupId);
        }
        return michiSessionMcpServer(this.mcpRegistry!.sessionEndpoint(groupId));
    }

    /** The host's session-id reminder, on a shared v3 MCP catalog only. */
    getMcpSessionReminder(sid: string): string {
        if (!this.sessionAnchorsEnabled) return '';
        return this.host.prompt.mcpSessionReminder?.(sid) ?? '';
    }

    beginMcpSessionTurn(
        sid: string,
        getActivePageTurnAttribution: () => { turnId: string; assistantId: string } | null,
    ): () => void {
        const binding = this.getBindingByNativeSid(sid);
        const group = binding && this.mcpSessionGroups.get(binding.cwd);
        return group ? this.mcpRegistry!.beginSessionTurn(group, sid, getActivePageTurnAttribution) : () => {};
    }

    endMcpSessionTurn(sid: string): void {
        const binding = this.getBindingByNativeSid(sid);
        const group = binding && this.mcpSessionGroups.get(binding.cwd);
        if (group) this.mcpRegistry!.endSessionTurn(group, sid);
    }

    private workerForNativeId(sid: string): KiroRuntime | undefined {
        return [...this.isolatedWorkers()].find((worker) => worker.getBindingByNativeSid(sid));
    }

    /** Each worker once: per-session workers plus shared Meta agent workers, live, idle or draining. */
    private isolatedWorkers(): Set<KiroRuntime> {
        const workers = new Set(this.sessionWorkers.values());
        for (const entry of this.metaAgentWorkers.values()) workers.add(entry.worker);
        return workers;
    }

    private processCapError(): KiroProcessCapError {
        return new KiroProcessCapError(
            `Kiro process cap (${this.processCap}) reached: ${this.activeProcessCount} kiro-cli processes have open sessions.`,
        );
    }

    /**
     * Reserve room for one more process. Only when the cap is reached does it
     * wait, to stop an idle process (a pool cwd first, then a shared Meta
     * agent worker); the last check is synchronous so concurrent callers
     * cannot overshoot the cap.
     */
    private async ensureProcessSlot(): Promise<void> {
        if (this.activeProcessCount < this.processCap) return;
        if (!(await this.evictLruIdleProcess()) && !(await this.evictIdleMetaAgentWorker())) throw this.processCapError();
        if (this.activeProcessCount >= this.processCap) throw this.processCapError();
    }

    /** Different per-session MCP definitions require separate KAS processes. */
    private async openIsolatedSession(
        id: string, cwd: string, open: (worker: KiroRuntime) => Promise<AgentSession>, workerOptions: Partial<KiroRuntimeOptions> = {},
    ): Promise<AgentSession> {
        if (this.closing) throw new Error('Kiro runtime is shutting down');
        if (this.sessionWorkers.has(id)) throw new KiroConcurrencyError('Kiro session is already opening or bound');
        if (this.activeProcessCount >= this.processCap) {
            await this.ensureProcessSlot();
            if (this.closing) throw new Error('Kiro runtime is shutting down');
            if (this.sessionWorkers.has(id)) throw new KiroConcurrencyError('Kiro session is already opening or bound');
            if (this.activeProcessCount >= this.processCap) throw this.processCapError();
        }
        // Same host, bridge, slot provider and model cache: the worker's sessions are this runtime's sessions.
        const worker = new KiroRuntime({ ...this.runtimeOptions, defaultCwd: cwd, engine: this.engine, isolatedSession: true, ...workerOptions });
        this.sessionWorkers.set(id, worker);
        try { return await open(worker); }
        catch (error) { this.sessionWorkers.delete(id); await worker.shutdown(); throw error; }
    }

    /**
     * Meta agent sessions of one toolset share a kiro-cli: its cwd, agent and
     * permission policy are the toolset's, and its gates, MCP slots and
     * catalog checks are per session. `family` is the toolset (and, where
     * users are isolated, the user); `key` adds the agent config, so a
     * changed config starts a new worker and the family's old one drains.
     */
    private async openSharedMetaAgentSession(
        id: string, family: string, key: string, dir: string, metaAgent: { toolset: string; agentName: string },
        open: (worker: KiroRuntime) => Promise<AgentSession>,
    ): Promise<AgentSession> {
        if (this.closing) throw new Error('Kiro runtime is shutting down');
        if (this.sessionWorkers.has(id)) throw new KiroConcurrencyError('Kiro session is already opening or bound');
        if (!this.metaAgentWorkers.has(key) && this.activeProcessCount >= this.processCap) {
            await this.ensureProcessSlot();
            if (this.closing) throw new Error('Kiro runtime is shutting down');
            if (this.sessionWorkers.has(id)) throw new KiroConcurrencyError('Kiro session is already opening or bound');
            if (!this.metaAgentWorkers.has(key) && this.activeProcessCount >= this.processCap) throw this.processCapError();
        }
        let entry = this.metaAgentWorkers.get(key);
        if (!entry) {
            for (const other of [...this.metaAgentWorkers.values()]) if (other.family === family) void this.retireMetaAgentWorker(other);
            const worker = new KiroRuntime({
                ...this.runtimeOptions, defaultCwd: dir, engine: this.engine, isolatedSession: true, metaAgent, sidecarTitles: false,
            });
            entry = { family, key, worker, sessions: new Set(), retired: false, idleTimer: null, lastUsedAt: Date.now() };
            this.metaAgentWorkers.set(key, entry);
        }
        this.cancelMetaAgentIdle(entry);
        entry.sessions.add(id);
        entry.lastUsedAt = Date.now();
        this.sessionWorkers.set(id, entry.worker);
        this.metaAgentWorkerBySession.set(id, entry);
        try {
            return await open(entry.worker);
        } catch (error) {
            this.sessionWorkers.delete(id);
            this.metaAgentWorkerBySession.delete(id);
            entry.sessions.delete(id);
            // A missing native session says nothing about the process; any other failure
            // (start, agent selection, catalog check) retires it for the next session.
            if (error instanceof NativeResumeUnavailableError) this.settleMetaAgentWorker(entry);
            else await this.retireMetaAgentWorker(entry);
            throw error;
        }
    }

    private cancelMetaAgentIdle(entry: SharedMetaAgentWorker): void {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
    }

    /** Stop a shared worker at once (it must have no sessions). */
    private async stopMetaAgentWorker(entry: SharedMetaAgentWorker): Promise<void> {
        this.cancelMetaAgentIdle(entry);
        if (this.metaAgentWorkers.get(entry.key) === entry) this.metaAgentWorkers.delete(entry.key);
        this.host.observability.perf.mark("metaAgentWorker:stop", { cwd: entry.worker.defaultCwd });
        await entry.worker.shutdown().catch(() => {});
    }

    /** Take no new sessions; stop now if none are left, else when the last is released. */
    private async retireMetaAgentWorker(entry: SharedMetaAgentWorker): Promise<void> {
        entry.retired = true;
        if (this.metaAgentWorkers.get(entry.key) === entry) this.metaAgentWorkers.delete(entry.key);
        if (entry.sessions.size === 0) await this.stopMetaAgentWorker(entry);
    }

    /** After a session left a live worker: with none left, stop it after the idle TTL. */
    private settleMetaAgentWorker(entry: SharedMetaAgentWorker): void {
        if (entry.sessions.size > 0 || entry.retired || this.idleTtlMs <= 0) return;
        this.cancelMetaAgentIdle(entry);
        entry.lastUsedAt = Date.now();
        const timer = setTimeout(() => {
            entry.idleTimer = null;
            if (entry.sessions.size === 0 && this.metaAgentWorkers.get(entry.key) === entry) void this.stopMetaAgentWorker(entry);
        }, this.idleTtlMs);
        if (typeof timer === "object" && "unref" in timer) timer.unref();
        entry.idleTimer = timer;
    }

    /** At the process cap, stop the least recently used shared worker that has no sessions. */
    private async evictIdleMetaAgentWorker(): Promise<boolean> {
        let oldest: SharedMetaAgentWorker | null = null;
        for (const entry of this.metaAgentWorkers.values()) {
            if (entry.sessions.size === 0 && (!oldest || entry.lastUsedAt < oldest.lastUsedAt)) oldest = entry;
        }
        if (!oldest) return false;
        this.host.observability.perf.mark("processCapEvict:metaAgent", { cwd: oldest.worker.defaultCwd });
        await this.stopMetaAgentWorker(oldest);
        return true;
    }

    /**
     * Generate a sidebar title on the cheap title session. Never throws: a
     * failure here must not affect the chat turn it runs beside.
     */
    async generateTitle(opts: GenerateTitleOptions): Promise<string | null> {
        if (!this.titleGenerator) return null;
        try {
            return await this.titleGenerator.generate(opts.userText, opts.signal, opts.contextText);
        } catch (err) {
            this.host.observability.log('warn', "chat", "kiro title generation failed", { error: (err as Error).message });
            return null;
        }
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
            this.host.observability.perf.mark("idleCleanup:kill", { cwd });
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
     * plus any in-flight starts and isolated workers, each shared Meta agent
     * worker once). Exposed for testing.
     */
    get activeProcessCount(): number {
        return this.pool.size + this.startLocks.size + this.isolatedWorkers().size;
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

        this.host.observability.perf.mark("processCapEvict:lru", { cwd: oldestCwd });
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
        this.acquiredSessions.delete(nodeId);
        this.metaAgentGates.delete(sid);
        return nodeId;
    }

    /**
     * Store an immutable binding record for a session. Populates both the
     * primary `bindings` map and the `publicIdByNativeSid` reverse index.
     */
    private storeBinding(binding: KiroSessionBinding): void {
        binding.engine ??= this.engine;
        this.bindings.set(binding.publicSessionId, binding);
        this.publicIdByNativeSid.set(binding.nativeSessionId, binding.publicSessionId);
        if (this.sessionAnchorsEnabled && isInteractiveOwner(binding.owner) && binding.slotId) {
            const group = this.mcpSessionGroups.get(binding.cwd);
            if (!group) throw new Error('Missing MCP session group');
            this.mcpRegistry!.bindSession(group, binding.nativeSessionId, binding.slotId);
        }
    }

    /** Look up a binding by public session id (node id or Attempt id). */
    getBinding(publicSessionId: string): KiroSessionBinding | undefined {
        const worker = this.sessionWorkers.get(publicSessionId);
        if (worker) return worker.getBinding(publicSessionId);
        return this.bindings.get(publicSessionId);
    }

    /** Look up a binding by native ACP session id (reverse lookup). */
    getBindingByNativeSid(nativeSid: string): KiroSessionBinding | undefined {
        const worker = this.workerForNativeId(nativeSid);
        if (worker) return worker.getBindingByNativeSid(nativeSid);
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
        const group = this.mcpSessionGroups.get(cwd);
        if (group) this.mcpRegistry?.disposeSessionGroup(group);
        this.mcpSessionGroups.delete(cwd);
        for (const [sid, boundCwd] of this.sessionCwd) {
            if (boundCwd !== cwd) continue;
            this.host.sessions.dropSession(this.unbindNativeSession(sid));
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
            for (const entry of warmed) {
                if (entry.slotId) {
                    this.mcpRegistry?.dispose(entry.slotId);
                }
                this.sessionCurrentMode.delete(entry.sid);
                this.sessionCurrentModel.delete(entry.sid);
            }
            this.warmedSessions.delete(cwd);
        }
    }

    /**
     * Build MCP slot callbacks closing over a getter that resolves the
     * slotId once it has been allocated. The callbacks route back to the
     * runtime's handleSpawnBranches / handleSaveContext / handleUpdateContext.
     *
     * Workspace lookup happens in mcpServer from slot.nodeId -> nodes.workspace_id.
     * The runtime still keeps parentChatId as the ACP session id so the slot's
     * sink and the turn-metadata callbacks inject updates into the right live
     * Kiro session. A business effect the bridge lacks gets no callback, so
     * its tool is not offered.
     */
    private makeSlotCallbacks(getSlotId: () => string | undefined): McpSlotCallbacks {
        return {
            getActivePageTurnAttribution: () => {
                const slotId = getSlotId();
                const slot = slotId ? this.mcpRegistry?.get(slotId) : undefined;
                const binding = slot?.parentChatId && slot.parentChatId !== '__pending__'
                    ? this.getBindingByNativeSid(slot.parentChatId) : undefined;
                if (binding?.owner.mode !== 'interactive') return null;
                const session = this.host.sessions.getSession(binding.publicSessionId);
                return session instanceof KiroSession ? session.getActivePageTurnAttribution() : null;
            },
            sink: this.slotEventSink(getSlotId),
            ...(this.bridge.spawnBranches ? { onSpawnBranches: async (topics) => this.handleSpawnBranches(getSlotId()!, topics) } : {}),
            ...(this.bridge.saveContext ? { onSaveArtifact: (name, body, path) => this.handleSaveContext(getSlotId()!, name, body, path) } : {}),
            ...(this.bridge.updateContext ? { onUpdateArtifact: (name, body) => this.handleUpdateContext(getSlotId()!, name, body) } : {}),
            onSetFollowUps: (followUps) => this.handleSetFollowUps(getSlotId()!, followUps),
            onSetBranchOverview: (overview) => this.handleSetBranchOverview(getSlotId()!, overview),
            metadataDoneSentinel: KIRO_METADATA_DONE_SENTINEL,
            onShowImage: (inputPath) => this.handleShowImage(getSlotId(), inputPath),
            onAskUser: (questions) => this.handleAskUser(getSlotId()!, questions),
        };
    }

    /**
     * The sink of a slot (McpSlotCallbacks.sink): each event the host's tools
     * report is injected into the slot's ACP session as it is reported, so the
     * session yields it in order with the agent's updates, before the tool
     * answers the agent. The slot is looked up when the event is reported,
     * after the tool's effect ran: for spawn_branches that is after the
     * bridge's await, which may open the new chats' sessions. With no slot
     * (disposed while the tool ran), no bound session (a warm slot) or no
     * client for its cwd the event is dropped.
     */
    private slotEventSink(getSlotId: () => string | undefined): McpSlotEventSink {
        return hostEventSink((event) => {
            const slot = this.mcpRegistry?.get(getSlotId()!);
            if (!slot || slot.parentChatId === "__pending__") return;
            this.getClient(slot.cwd)?.injectUpdate(slot.parentChatId, hostEventUpdate(event));
        });
    }

    // The three handlers below run only from the callbacks makeSlotCallbacks
    // registers while the bridge has their method.
    private async handleSpawnBranches(
        slotId: string,
        topics: Array<{ title: string; prompt: string }>,
    ): Promise<SpawnedBranch[]> {
        const slot = this.mcpRegistry?.get(slotId);
        if (!slot) return [];
        const parentSid = slot.parentChatId;
        if (parentSid === "__pending__") return [];
        const parentNodeId = slot.nodeId ?? this.nodeIdBySid.get(parentSid) ?? parentSid;
        const parentSession = this.host.sessions.getSession(parentNodeId) as KiroSession | undefined;

        return this.bridge.spawnBranches!({
            parentChatId: parentNodeId,
            cwd: slot.cwd,
            enableFollowUps: parentSession?.getEnableFollowUps() !== false,
            ownerUserId: slot.ownerUserId,
            topics,
        });
    }

    private handleSaveContext(slotId: string, name: string, body: string | undefined, path?: string): BridgeContextResult | null {
        const slot = this.mcpRegistry?.get(slotId);
        if (!slot) return null;
        const parentChatId = slot.parentChatId;
        if (parentChatId === "__pending__") return null;
        return this.bridge.saveContext!({ cwd: slot.cwd, chatId: parentChatId, ownerUserId: slot.ownerUserId, name, body, path });
    }

    private handleUpdateContext(slotId: string, name: string, body: string): BridgeContextResult | null {
        const slot = this.mcpRegistry?.get(slotId);
        if (!slot) return null;
        const parentChatId = slot.parentChatId;
        if (parentChatId === "__pending__") return null;
        return this.bridge.updateContext!({ cwd: slot.cwd, chatId: parentChatId, ownerUserId: slot.ownerUserId, name, body });
    }

    /**
     * show_image validates the image inside the slot's cwd; Michi's handler
     * reports the image through the slot's sink. A slot with no session yet
     * would drop that event, so it refuses rather than claim a display.
     */
    private handleShowImage(slotId: string | undefined, inputPath: string): { relPath: string; mimeType: string; size: number } | { error: string } {
        const slot = slotId ? this.mcpRegistry?.get(slotId) : undefined;
        if (!slot || slot.parentChatId === "__pending__") return { error: "no conversation is bound to this session" };
        const r = resolveShowImage(slot.cwd, inputPath);
        if (!r.ok) return { error: r.error };
        return { relPath: r.relPath, mimeType: r.mimeType, size: r.size };
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

        // Push user_input_request so frontend renders the banner. A question
        // nobody can see (no session, or a turn whose frames are discarded)
        // is answered "no answer" now rather than after the timeout.
        const shown = client?.injectUpdate(parentChatId, {
            sessionUpdate: "user_input_request",
            requestId,
            questions,
        }) === true;
        if (!shown) return null;

        const TIMEOUT_MS = this.runtimeOptions.approveTimeoutMs?.() ?? DEFAULT_APPROVE_TIMEOUT_MS;
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

    /** Only an explicit availability override can block a spawn; Kiro's default never does. */
    private launchUnavailableDetail(): string | null {
        const check = this.runtimeOptions.checkAvailability;
        if (!check) return null;
        const availability = check();
        return availability.available ? null : (availability.detail ?? `${this.label} is unavailable`);
    }

    private clientOptions(): AcpClientOptions | undefined {
        const meta = this.runtimeOptions.metaAgent;
        return meta ? this.runtimeOptions.restrictedAgent!.clientOptions(this.engine, meta.agentName) : undefined;
    }

    ensureClient(cwd: string, model?: string): Promise<AcpClient> {
        if (this.closing) return Promise.reject(new ACPNotRunningError('Kiro runtime is shutting down'));
        const recovery = this.cancelRecoveryLocks.get(cwd);
        if (recovery) return recovery;
        const alive = this.pool.get(cwd);
        if (alive?.hasUnconfirmedExit?.()) {
            return Promise.reject(new NativeResumeFailedError(new Error('Kiro process exit has not been confirmed')));
        }
        if (alive && alive.isAlive()) {
            this.host.observability.perf.mark("ensureClient:hit", { cwd });
            this.cancelIdleTimer(cwd);
            this.touchCwdActivity(cwd);
            return Promise.resolve(alive);
        }
        const pending = this.startLocks.get(cwd);
        if (pending) {
            this.host.observability.perf.mark("ensureClient:pending", { cwd });
            return pending;
        }

        // Previous client for this cwd died; purge its sessions so we don't
        // leak dead sessionIds into new requests.
        if (alive) {
            this.pool.delete(cwd);
            this.purgeSessionsForCwd(cwd);
        }

        const t0 = this.host.observability.perf.now();
        const p = (async () => {
            try {
                if (this.closing) throw new ACPNotRunningError('Kiro runtime is shutting down');
                const unavailable = this.launchUnavailableDetail();
                if (unavailable) throw new Error(unavailable);
                const c = new AcpClient(undefined, cwd, model, this.engine, this.runtimeOptions.launch, this.id, this.acpClientOptions());
                this.attachWorkflowBridge(c);
                c.onExit(() => {
                    // If this is still the current client for that cwd, purge.
                    if (this.pool.get(cwd) === c) {
                        this.pool.delete(cwd);
                        this.purgeSessionsForCwd(cwd);
                    }
                });
                try {
                    const launch = async () => {
                        if (this.closing) throw new ACPNotRunningError('Kiro runtime is shutting down');
                        // Enforce global process cap before spawning a new process.
                        if (this.activeProcessCount >= this.processCap) {
                            const evicted = await this.evictLruIdleProcess() || await this.evictIdleMetaAgentWorker();
                            if (!evicted) throw this.processCapError();
                        }

                        c.start();
                        await c.initialize();
                    };
                    await (this.runtimeOptions.startClient ? this.runtimeOptions.startClient(launch) : launch());
                } catch (error) {
                    await c.shutdown().catch(() => {});
                    throw error;
                }
                this.pool.set(cwd, c);
                this.cancelIdleTimer(cwd);
                this.touchCwdActivity(cwd);
                this.host.observability.perf.measure("ensureClient:cold", t0, { cwd });
                return c;
            } finally {
                this.startLocks.delete(cwd);
            }
        })();
        this.startLocks.set(cwd, p);
        return p;
    }

    /** A cancellation watchdog fences only its session. Restart is deferred to
     * the next user turn, and forbidden while another session owns the process. */
    recoverCancelledSession(sid: string, cwd: string): Promise<AcpClient> {
        const pending = this.cancelRecoveryLocks.get(cwd);
        if (pending) return pending.then((client) => {
            if (!client.hasSession(sid)) throw new NativeResumeFailedError(new Error('Please retry this session after the shared process recovery'));
            return client;
        });
        const old = this.pool.get(cwd);
        if (!old?.needsSessionRecovery(sid)) return this.ensureClient(cwd);
        // Reloading here would rebuild an ordinary chat slot; reopen through the runtime instead.
        if (this.runtimeOptions.metaAgent) {
            return Promise.reject(new NativeResumeFailedError(new Error('The Meta agent session must be reopened after a stuck cancellation')));
        }
        if (old.hasHealthyWork()) return Promise.reject(new KiroCancelRecoveryBusyError({ workflowRunning: old.hasOpenWorkflowRuns() }));
        const binding = this.getBindingByNativeSid(sid);
        const session = binding ? this.host.sessions.getSession(binding.publicSessionId) : undefined;
        if (!binding || !session || !isInteractiveOwner(binding.owner)) {
            return Promise.reject(new NativeResumeFailedError(new Error('Session requires owner-managed native recovery')));
        }
        const model = this.getCurrentModel(sid) ?? binding.modelId ?? undefined;
        const deadline = Date.now() + this.cancelRecoveryTimeoutMs;
        const remaining = () => {
            const ms = deadline - Date.now();
            if (ms <= 0) throw new Error('Native recovery deadline exceeded');
            return ms;
        };
        const work = Promise.resolve().then(async () => {
            // Recheck inside the reserved cwd operation before stopping anything.
            if (this.pool.get(cwd) !== old) throw new NativeResumeFailedError(new Error('Kiro process changed during recovery; retry'));
            if (old.hasHealthyWork()) throw new KiroCancelRecoveryBusyError({ workflowRunning: old.hasOpenWorkflowRuns() });
            let client: AcpClient | undefined;
            try {
                // Keep the stopped client in the pool until exit is confirmed.
                // A failed teardown must never start another writer for this SID.
                await old.shutdown();
                this.pool.delete(cwd);
                this.purgeSessionsForCwd(cwd);
                remaining();
                client = new AcpClient(undefined, cwd, model, this.engine, this.runtimeOptions.launch, this.id, this.acpClientOptions());
                this.attachWorkflowBridge(client);
                const replacement = client;
                client.onExit(() => {
                    if (this.pool.get(cwd) === replacement) {
                        this.pool.delete(cwd);
                        this.purgeSessionsForCwd(cwd);
                    }
                });
                const launch = async () => {
                    remaining();
                    if (this.closing) throw new ACPNotRunningError('Kiro runtime is shutting down');
                    replacement.start();
                    await replacement.initialize(remaining());
                };
                await (this.runtimeOptions.startClient ? this.runtimeOptions.startClient(launch) : launch());
                const loaded = await this.loadAcpSession({
                    sessionId: sid, cwd, model, nodeId: binding.publicSessionId,
                    workspaceId: binding.workspaceId, ownerUserId: binding.ownerUserId,
                    client, deadline,
                    workflows: isInteractiveOwner(binding.owner) && this.workflowsWanted(binding.ownerUserId),
                    policyPresets: this.policyPresetsFor(binding.owner, binding.ownerUserId, binding.toolProfile),
                });
                this.pool.set(cwd, client);
                this.sessionCwd.set(sid, cwd);
                this.bindNodeSession(binding.publicSessionId, sid);
                if (loaded.slotId) this.slotByChatId.set(sid, loaded.slotId);
                if (loaded.slotId) this.mcpRegistry?.rebind(loaded.slotId, { agentRuns: resolveAgentRunToolsForSession(this.bridge, {
                    runtimeId: this.id, sessionId: sid, owner: binding.owner,
                    ownerUserId: binding.ownerUserId, workspaceId: binding.workspaceId, nodeId: binding.publicSessionId,
                }) ?? undefined });
                this.storeBinding({ ...binding, slotId: loaded.slotId });
                this.host.sessions.registerSession(session, binding.ownerUserId);
                this.cancelIdleTimer(cwd);
                this.touchCwdActivity(cwd);
                this.host.observability.perf.mark('cancelRecovery:restored', { sid, cwd, elapsedMs: this.cancelRecoveryTimeoutMs - (deadline - Date.now()) });
                return client;
            } catch (error) {
                if (client) {
                    try { await client.shutdown(); }
                    catch { this.pool.set(cwd, client); }
                }
                throw error instanceof NativeResumeFailedError ? error : new NativeResumeFailedError(error);
            }
        }).finally(() => {
            if (this.cancelRecoveryLocks.get(cwd) === work) this.cancelRecoveryLocks.delete(cwd);
        });
        this.cancelRecoveryLocks.set(cwd, work);
        return work;
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
        if (this.runtimeOptions.metaAgent) return false;
        const binding = this.sessionAnchorsEnabled ? this.getBindingByNativeSid(sid) : undefined;
        const session = binding ? this.host.sessions.getSession(binding.publicSessionId) : undefined;
        const nodeId = this.nodeIdBySid.get(sid) ?? sid;
        const model = this.sessionCurrentModel.get(sid);
        const slotId = this.slotByChatId.get(sid);
        const slot = slotId ? this.mcpRegistry?.get(slotId) : undefined;
        const workspaceId = slot?.workspaceId ?? null;
        const ownerUserId = slot?.ownerUserId ?? null;
        // Workflow traffic is attributed through the session's binding, which
        // only the anchored path below restores (the respawn purges it).
        // Without it a workflow would run with no card and every step
        // approval cancelled, so the reload keeps workflows off; the chat's
        // next ordinary session load turns them back on.
        const workflows = !!binding && isInteractiveOwner(binding.owner) && this.workflowsWanted(binding.ownerUserId);

        await this.forceRespawn(cwd);
        try {
            const loaded = await this.loadAcpSession({
                sessionId: sid,
                cwd,
                model: model ?? undefined,
                workspaceId,
                nodeId,
                ownerUserId,
                workflows,
                policyPresets: binding ? this.policyPresetsFor(binding.owner, binding.ownerUserId, binding.toolProfile) : [],
            });
            if (binding) {
                this.sessionCwd.set(sid, cwd);
                this.bindNodeSession(binding.publicSessionId, sid);
                if (loaded.slotId) this.slotByChatId.set(sid, loaded.slotId);
                if (loaded.slotId) this.mcpRegistry?.rebind(loaded.slotId, { agentRuns: resolveAgentRunToolsForSession(this.bridge, {
                    runtimeId: this.id, sessionId: sid, owner: binding.owner,
                    ownerUserId: binding.ownerUserId, workspaceId: binding.workspaceId, nodeId: binding.publicSessionId,
                }) ?? undefined });
                this.storeBinding({ ...binding, slotId: loaded.slotId });
                if (session) this.host.sessions.registerSession(session, binding.ownerUserId);
            }
            return true;
        } catch (err) {
            this.host.observability.perf.mark("recoverSession:load_failed", { cwd, sid });
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
        if ((binding.engine ?? 'v2') !== this.engine) throw new NativeResumeUnavailableError('Kiro Run belongs to another engine');
        const { publicSessionId, nativeSessionId, owner, cwd, workspaceId, ownerUserId, runtimeProfileHash, toolProfile, permissionBroker, modelId } = binding;

        if (!isHeadlessOwner(owner)) {
            throw new Error("rebindRunSession is only for agent_run owners");
        }

        this.host.observability.perf.mark("rebindRunSession:start", { cwd, publicSessionId, nativeSessionId });

        // Build a fresh Run MCP slot.
        let slotId: string | undefined;
        const chatCallbacks = this.makeSlotCallbacks(() => slotId);
        const runToolProfile = toolProfile ?? { allowedToolNames: [] };
        const runCallbacks = buildRunMcpSlotCallbacks({
            owner,
            workspaceId,
            ownerUserId,
            toolProfile: runToolProfile,
            chatCallbacks,
        });

        let mcpServers: AcpMcpServer[] = [];
        if (this.mcpRegistry) {
            const slot = this.mcpRegistry.create(
                nativeSessionId,
                cwd,
                ownerUserId,
                runCallbacks,
                { nodeId: null, workspaceId },
            );
            slotId = slot.slotId;
            mcpServers = [michiMcpServer(this.engine, this.mcpRegistry.endpoint(slotId))];
        }

        // Ensure client and load session.
        const c = await this.ensureClient(cwd, modelId ?? undefined);
        try {
            const result = await c.loadSession(nativeSessionId, cwd, mcpServers, undefined, { modelId: modelId ?? undefined });
            if (modelId && result.models?.currentModelId !== modelId) await c.setModel(nativeSessionId, modelId);
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

        this.host.observability.perf.mark("rebindRunSession:done", { cwd, publicSessionId, nativeSessionId });

        const session = new KiroSession(publicSessionId, nativeSessionId, this, cwd, {
            runtimeId: this.id,
            flavor: this.flavor,
            enableFollowUps: false,
            owner,
            runtimeProfileHash,
            toolProfile,
            permissionBroker,
            ownerUserId,
            workspaceId,
        });
        this.acquiredSessions.set(publicSessionId, session);
        return session;
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
            const { sessionId: sid, modes } = await c.newSession([]);
            this.absorbFreshModes(cwd, modes);
            c.destroySession(sid);
            return { ok: true };
        } catch (err) {
            return { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
    }

    /**
     * Opportunistic update of the global availableModes cache from any modes
     * payload. The catalog is process-global; the selected/default mode is not.
     */
    private absorbModes(modes: any): void {
        if (!modes) return;
        if (!this.globalAvailableModes && Array.isArray(modes.availableModes)) {
            this.globalAvailableModes = modes.availableModes;
        }
    }

    /** Record the initial mode reported by a fresh session/new for this cwd. */
    private absorbFreshModes(cwd: string, modes: any): void {
        this.absorbModes(modes);
        if (typeof modes?.currentModeId === "string" && modes.currentModeId) {
            this.defaultModeByCwd.set(cwd, modes.currentModeId);
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
        const models = list
            .map((m: any): ModelInfo => ({
                id: String(m?.modelId ?? ""),
                label: typeof m?.name === "string" ? m.name : undefined,
                description: typeof m?.description === "string" ? m.description : undefined,
                ...(this.engine === 'v3' ? {
                    supportsReasoning: m?._meta?.kiro?.hasEffort === true,
                    supportedReasoningLevels: sanitizeReasoningLevels(m?._meta?.kiro?.effortLevels),
                    ...(isReasoningLevel(m?._meta?.kiro?.defaultEffortLevel)
                        ? { defaultReasoning: m._meta.kiro.defaultEffortLevel } : {}),
                } : {}),
            }))
            .filter((m) => m.id);
        return this.engine === 'v2' ? markKiroV2EffortSupport(models) : models;
    }

    private storeAvailableModels(list: any[]): void {
        this.globalAvailableModels = list;
        this.modelCatalog.replace(list);
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
        metadata?: Record<string, unknown>,
        workflows = false,
        binding?: { nodeId?: string | null; workspaceId?: string | null; ownerUserId?: string | null },
        policyPresets: readonly string[] = [],
    ): Promise<OpenSessionResult> {
        let slotId: string | undefined;
        let mcpServers: AcpMcpServer[] = [];
        if (this.mcpRegistry) {
            const cbs = makeCallbacks(() => slotId);
            const slot = this.mcpRegistry.create(
                "__pending__", // filled in when the sid is bound to a chat
                cwd,
                binding?.ownerUserId ?? null, // warm slots are bound when claimed
                cbs,
                { nodeId: binding?.nodeId ?? null, workspaceId: binding?.workspaceId ?? null },
            );
            slotId = slot.slotId;
            mcpServers = [this.chatMcpServer(cwd, slotId)];
        }
        let result: { sessionId: string; modes?: any; models?: any; configOptions?: any; _meta?: Record<string, unknown> };
        try {
            result = await c.newSession(mcpServers, { metadata, ...(workflows ? { workflowsEnabled: true } : {}),
                ...(policyPresets.length ? { policyPresets } : {}) });
        } catch (err) {
            if (slotId) await this.mcpRegistry?.dispose(slotId).catch(() => {});
            throw err;
        }
        const { sessionId: sid, modes, models } = result;
        if (modes && typeof modes.currentModeId === "string") {
            this.sessionCurrentMode.set(sid, modes.currentModeId);
        }
        this.absorbFreshModes(cwd, modes);
        this.absorbModels(sid, models);
        return { sid, slotId, modes, ...(isCrewMemoryMode(result._meta?.crewMemoryMode) ? { crewMemoryMode: result._meta.crewMemoryMode } : {}) };
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
        /** Reserved replacement client and shared hard deadline for cancel recovery. */
        client?: AcpClient;
        deadline?: number;
        /** Open the session with Kiro workflows on (chat sessions whose owner opted in). */
        workflows?: boolean;
        /** V3 policy presets to seed (policyPresetsFor). */
        policyPresets?: readonly string[];
    }): Promise<LoadSessionResult> {
        const { sessionId, cwd, model } = opts;
        const c = opts.client ?? await this.ensureClient(cwd, model);
        const remaining = () => opts.deadline === undefined ? undefined : Math.max(1, opts.deadline - Date.now());
        const makeCallbacks: McpSlotCallbacksFactory = (getSlotId) =>
            this.makeSlotCallbacks(getSlotId);

        let slotId: string | undefined;
        let mcpServers: AcpMcpServer[] = [];
        if (this.mcpRegistry) {
            const cbs = makeCallbacks(() => slotId);
            const slot = this.mcpRegistry.create(sessionId, cwd, opts.ownerUserId ?? null, cbs, {
                nodeId: opts.nodeId ?? null,
                workspaceId: opts.workspaceId ?? null,
            });
            slot.owner = interactiveOwner(opts.nodeId ?? sessionId);
            slotId = slot.slotId;
            mcpServers = [this.chatMcpServer(cwd, slotId)];
        }

        let result: { modes?: any; models?: any; _meta?: Record<string, unknown> };
        try {
            result = await c.loadSession(sessionId, cwd, mcpServers, remaining(), { modelId: model, ...(opts.workflows ? { workflowsEnabled: true } : {}),
                ...(opts.policyPresets?.length ? { policyPresets: opts.policyPresets } : {}) });
            if (model && result.models?.currentModelId !== model) {
                await c.setModel(sessionId, model, remaining());
                result.models = { ...result.models, currentModelId: model };
            }
        } catch (err) {
            if (slotId) await this.mcpRegistry?.dispose(slotId).catch(() => {});
            // A session the flavor cannot replace (a Crew slot's memory
            // identity) fails visibly instead of being reconstructed.
            if (this.flavor.nativeSessions.replaceable && isNativeSessionUnavailable(err, sessionId)) throw new NativeResumeUnavailableError('Kiro native session is unavailable');
            throw err;
        }
        if (result.modes?.currentModeId) {
            this.sessionCurrentMode.set(sessionId, result.modes.currentModeId);
        }
        if (this.flavor.memory && opts.nodeId) this.flavor.memory.keepLoaded(this.host, opts.nodeId, result._meta);
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
        if (this.closing) return;
        const pool = this.warmedSessions.get(cwd);
        if (pool && pool.length >= this.warmPoolSize) return;
        if (this.warmSessionLocks.has(cwd)) return;
        const makeCallbacks: McpSlotCallbacksFactory = (getSlotId) => this.makeSlotCallbacks(getSlotId);
        const p = (async () => {
            const t0 = this.host.observability.perf.now();
            let succeeded = false;
            try {
                const c = await this.ensureClient(cwd);
                // Warm sessions belong to no user yet: the local preference applies.
                const workflows = this.workflowsWanted(null);
                const { sid, slotId, modes } = await this.openSession(c, cwd, makeCallbacks, undefined, workflows);
                // Double-check we still want this entry (shutdown race).
                if (this.pool.get(cwd) !== c) {
                    if (slotId) await this.mcpRegistry?.dispose(slotId);
                    return;
                }
                const entry = { sid, slotId, currentModeId: modes?.currentModeId, workflows };
                const existing = this.warmedSessions.get(cwd);
                if (existing) {
                    existing.push(entry);
                } else {
                    this.warmedSessions.set(cwd, [entry]);
                }
                this.host.observability.perf.measure("warm:session_ready", t0, { cwd, sid, poolSize: (existing?.length ?? 1) });
                succeeded = true;
            } catch (err) {
                this.host.observability.log('warn', 'acp', `warmNextSession(${cwd}) failed`, { error: err });
            } finally {
                this.warmSessionLocks.delete(cwd);
                // Continue filling the pool if still below target.
                const currentPool = this.warmedSessions.get(cwd);
                if (succeeded && !this.closing && (!currentPool || currentPool.length < this.warmPoolSize)) {
                    this.warmNextSession(cwd);
                }
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
    consumeWarmedSession(cwd: string, workflows = false): { sid: string; slotId?: string; currentModeId?: string } | undefined {
        const pool = this.warmedSessions.get(cwd);
        if (!pool || pool.length === 0) return undefined;
        if ((pool[0].workflows ?? false) !== workflows) {
            // The Workflows setting changed since these were warmed: they
            // carry the old `_meta.kiro.settings`. Drop them and re-warm.
            this.warmedSessions.delete(cwd);
            const client = this.pool.get(cwd);
            for (const stale of pool) {
                client?.destroySession(stale.sid);
                if (stale.slotId) void this.mcpRegistry?.dispose(stale.slotId).catch(() => {});
            }
            this.warmNextSession(cwd);
            return undefined;
        }
        const entry = pool.shift()!;
        if (pool.length === 0) this.warmedSessions.delete(cwd);
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
        return [...this.warmedSessions.values()].flat();
    }

    /** currentModeId for a session (undefined if unknown). */
    getCurrentMode(sid: string): string | undefined {
        const worker = this.workerForNativeId(sid);
        if (worker) return worker.getCurrentMode(sid);
        const cwd = this.sessionCwd.get(sid);
        return (cwd ? this.pool.get(cwd)?.getSessionInfo?.(sid)?.modes?.currentModeId : undefined)
            ?? this.sessionCurrentMode.get(sid);
    }

    /** The initial mode most recently reported by session/new for this cwd. */
    getDefaultModeId(cwd: string): string | null {
        return this.defaultModeByCwd.get(cwd) ?? null;
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

        const t0 = this.host.observability.perf.now();
        this.modesLoadLock = (async () => {
            const c = await this.ensureClient(this.defaultCwd);
            const { sessionId: sid, modes, models } = await c.newSession([]);
            c.destroySession(sid);
            this.absorbFreshModes(this.defaultCwd, modes);
            const list = Array.isArray(modes?.availableModes) ? modes.availableModes : [];
            if (Array.isArray(models?.availableModels)) this.storeAvailableModels(models.availableModels);
            this.host.observability.perf.measure("getAvailableModes:fallback_session_new", t0);
            return list;
        })().finally(() => {
            this.modesLoadLock = null;
        });
        return this.modesLoadLock;
    }

    /** Switch the active mode (kiro-cli uses this to switch agents). */
    async setMode(sid: string, modeId: string): Promise<void> {
        const worker = this.workerForNativeId(sid);
        if (worker) return worker.setMode(sid, modeId);
        const meta = this.runtimeOptions.metaAgent;
        if (meta && modeId !== meta.agentName) throw new Error('The Meta agent cannot switch to another Kiro agent');
        const cwd = this.getCwdForSession(sid);
        if (!cwd) throw new Error("unknown chat");
        const c = this.pool.get(cwd);
        if (!c) throw new Error("client not running");
        await c.setMode(sid, modeId);
        this.sessionCurrentMode.set(sid, modeId);
    }

    /** currentModelId for a session (undefined if unknown). */
    getCurrentModel(sid: string): string | undefined {
        const worker = this.workerForNativeId(sid);
        if (worker) return worker.getCurrentModel(sid);
        const cwd = this.sessionCwd.get(sid);
        return (cwd ? this.pool.get(cwd)?.getSessionInfo?.(sid)?.models?.currentModelId : undefined)
            ?? this.sessionCurrentModel.get(sid);
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
        const worker = this.workerForNativeId(sid);
        if (worker) return worker.setModel(sid, modelId);
        const cwd = this.getCwdForSession(sid);
        if (!cwd) throw new Error("unknown chat");
        const c = this.pool.get(cwd);
        if (!c) throw new Error("client not running");
        await c.setModel(sid, modelId);
        this.sessionCurrentModel.set(sid, modelId);
    }

    /** Forward a user's permission approval to the ACP client. */
    respondToPermission(sid: string, requestId: number, optionId: string): void {
        const worker = this.workerForNativeId(sid);
        if (worker) return worker.respondToPermission(sid, requestId, optionId);
        const cwd = this.getCwdForSession(sid);
        if (!cwd) return;
        const client = this.pool.get(cwd);
        client?.respondToPermission(requestId, optionId);
    }

    /**
     * Execute a Kiro slash command via `_kiro.dev/commands/execute`.
     *
     * Only commands verified to complete cleanly (see EXECUTE_ALLOWLIST)
     * should be routed here. Commands that hang or require interactive
     * sub-prompts must remain as prompt text fallback.
     */
    async executeCommand(
        sid: string,
        command: string,
        args?: Record<string, unknown>,
    ): Promise<{ success: boolean; message?: string; data?: unknown }> {
        const worker = this.workerForNativeId(sid);
        if (worker) return worker.executeCommand(sid, command, args);
        if (this.runtimeOptions.metaAgent) return { success: false, message: 'Kiro commands are off for the Meta agent.' };
        const cwd = this.getCwdForSession(sid);
        if (!cwd) throw new Error("unknown session");
        const c = this.pool.get(cwd);
        if (!c) throw new Error("client not running");
        return c.executeCommand(sid, command, args);
    }

    /** Forward a user's permission denial/cancellation to the ACP client. */
    cancelPermission(sid: string, requestId: number): void {
        const worker = this.workerForNativeId(sid);
        if (worker) return worker.cancelPermission(sid, requestId);
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
        if (this.usesSessionWorkers) { await this.getAvailableModes(); return; }
        await this.ensureClient(cwd, opts?.model ?? undefined);
        this.warmNextSession(cwd);
        const warmLock = this.warmSessionLocks.get(cwd);
        if (warmLock) await warmLock.catch(() => {});
        await this.getAvailableModes().catch(() => {});
    }

    /**
     * Kiro workflows are opt-in per user (Settings → Model → Workflows) and
     * exist only on V3. Only chat sessions get them: an Agent Run has no
     * surface for a workflow it would launch.
     */
    private workflowsWanted(ownerUserId: string | null): boolean {
        if (this.engine !== 'v3') return false;
        // Cloud sessions without a user cannot carry a per-user preference.
        if (this.host.principal.enforceUserOwnership() && !ownerUserId) return false;
        try { return this.host.config.features.workflows(this.id, ownerUserId); }
        catch { return false; }
    }

    /** Route this client's workflow traffic to the workflow hub. */
    private attachWorkflowBridge(client: AcpClient): void {
        if (this.engine !== 'v3') return;
        const bridge = createKiroWorkflowBridge({
            // Asserted for v3 at construction (kiroHostPorts).
            hub: this.host.workflows!,
            resolve: (nativeSessionId) => this.workflowContext(nativeSessionId),
            control: (method, workflowId, parentSessionId) => client.workflowControl(method, workflowId, parentSessionId),
            supports: (method) => client.supportsWorkflowControl(method),
            answerPermission: (requestId, optionId) => {
                if (optionId) client.respondToPermission(requestId, optionId);
                else client.cancelPermission(requestId);
            },
        });
        client.setWorkflowRouter({
            onEvent: (method, params) => bridge.handle(method, params),
            isStepSession: (sessionId) => bridge.isStepSession(sessionId),
            hasOpenRuns: () => bridge.hasOpenRuns(),
            requestPermission: (request) => bridge.requestPermission(request),
        });
        client.onExit(() => bridge.release('Interrupted: the Kiro session ended before this workflow finished'));
        this.attachAgentTurns(client);
    }

    /**
     * Kiro V3 wakes a chat's session on its own when a workflow it launched
     * finishes, and reports back in a turn of its own. Show that turn as a
     * self-initiated chat turn, the way Claude's background work is shown.
     * Agent Runs and sessions Michi cannot place are left unclaimed (their
     * frames are discarded, never buffered into the next prompt).
     */
    private attachAgentTurns(client: AcpClient): void {
        client.setAgentTurnHandler((nativeSessionId) => {
            const binding = this.getBindingByNativeSid(nativeSessionId);
            if (!binding || !isInteractiveOwner(binding.owner)) return null;
            const session = this.host.sessions.getSession(binding.publicSessionId);
            if (!(session instanceof KiroSession) || session.nativeSessionId !== nativeSessionId) return null;
            // Asserted at construction (KIRO_HOST_PORTS).
            return (updates) => this.host.backgroundTurns!.consume({
                chatId: binding.publicSessionId,
                owner: binding.owner,
                ownerUserId: binding.ownerUserId,
                events: session.agentTurnEvents(updates),
                cancel: () => session.cancelAgentTurn(),
            });
        });
    }

    private workflowContext(nativeSessionId: string): WorkflowRunContext | null {
        const publicId = this.publicIdByNativeSid.get(nativeSessionId);
        const binding = publicId ? this.bindings.get(publicId) : undefined;
        if (!binding) return null;
        if (!binding.ownerUserId && this.host.principal.enforceUserOwnership()) return null;
        return {
            ownerUserId: this.host.principal.resolve(binding.ownerUserId),
            workspaceId: binding.workspaceId,
            owner: binding.owner,
        };
    }

    /**
     * AgentRuntime contract: create a new session, allocate a real MCP
     * slot wired to this runtime's bridge, optionally consume a warmed
     * session, waiting for an in-flight warm slot before falling back to
     * a cold session/new, build the first-message preamble (including
     * ancestor stitching from the session directory), prime the KiroSession,
     * and return it. The caller is expected to register the returned
     * session in the session directory so subsequent ancestor lookups find it.
     *
     * For headless owners: always creates a fresh ACP `session/new` with a
     * dedicated owner-aware MCP slot via `buildRunMcpSlotCallbacks`. The warm
     * session pool is never consumed — Runs must have their own tool roster
     * (including `submit_agent_result`) from the start.
     */
    async newSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
        if (this.host.profile.isRestricted(opts.toolProfile)) return this.acquireSession(opts, () => this.openMetaAgentSession(opts, 'new'));
        return this.acquireSession(opts, () => this.createSession(opts));
    }

    private async acquireSession(opts: NewAgentSessionOptions | LoadAgentSessionOptions,
        create: () => Promise<AgentSession>): Promise<AgentSession> {
        const id = isHeadlessOwner(opts.owner) ? opts.owner.key
            : ('nodeId' in opts ? opts.nodeId : undefined) ?? opts.sessionId;
        // Legacy callers let ACP allocate the public id; no id can be joined yet.
        if (!id) return create();
        const owner = opts.owner ?? interactiveOwner(id);
        const compatible = (session: AgentSession) => {
            assertOwner(session.owner ?? interactiveOwner(session.id), owner);
            const binding = this.getBinding(id);
            if (binding?.ownerUserId !== (opts.ownerUserId ?? null)) throw new Error('session user owner mismatch');
            if ((session.runtimeProfileHash ?? null) !== (opts.profileHash ?? null)) throw new Error(`session ${id} runtime profile hash mismatch`);
            return session;
        };
        return this.acquisitions.acquire(id, async () => {
            const existing = this.acquiredSessions.get(id);
            if (existing && this.getBinding(id)) return compatible(existing);
            const session = await create();
            this.acquiredSessions.set(id, session);
            return session;
        }, compatible);
    }

    private async createSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
        if (this.usesSessionWorkers || (this.sessionAnchorsEnabled && (isHeadlessOwner(opts.owner) || !!opts.toolProfile))) {
            const id = isHeadlessOwner(opts.owner) ? opts.owner.key : opts.sessionId;
            if (!id) throw new Error('Kiro v3 requires a public session id');
            return this.openIsolatedSession(id, opts.cwd, (worker) => worker.newSession(opts));
        }
        const owner: RuntimeSessionOwner = opts.owner ?? interactiveOwner(opts.sessionId ?? "__unknown__");
        const isAgentRun = isHeadlessOwner(owner);

        // Defensive cap (safety valve). Skip when this node already has a bound
        // session so reconnects/double-loads are never rejected.
        const alreadyBound = opts.sessionId ? this.sidByNodeId.has(opts.sessionId) : false;
        if (!alreadyBound && this.sessionCwd.size >= this.concurrencyCap) {
            throw new KiroConcurrencyError(
                `Kiro concurrency cap (${this.concurrencyCap}) reached. Try again when an existing session finishes.`,
            );
        }

        const tTotal = this.host.observability.perf.now();
        const c = await this.ensureClient(opts.cwd, opts.model ?? undefined);

        let sid: string;
        let slotId: string | undefined;
        const memory = this.flavor.memory?.forNewSession(this.host, opts);
        const metadata = joinSessionMetadata(memory?.metadata, this.flavor.sessionMetadata?.(this.host, opts));

        if (isAgentRun) {
            // ---------------------------------------------------------------
            // Agent Run path: always fresh session/new with Run MCP slot.
            // Never consume the warm-session pool.
            // ---------------------------------------------------------------
            const tNew = this.host.observability.perf.now();

            // Build the Run MCP slot callbacks using the W0 factory.
            const chatCallbacks = this.makeSlotCallbacks(() => slotId);
            const toolProfile = opts.toolProfile ?? { allowedToolNames: [] };
            const runCallbacks = buildRunMcpSlotCallbacks({
                owner,
                workspaceId: opts.workspaceId ?? null,
                ownerUserId: opts.ownerUserId ?? null,
                toolProfile,
                chatCallbacks,
            });

            // Allocate the MCP slot and open the ACP session.
            let mcpServers: AcpMcpServer[] = [];
            if (this.mcpRegistry) {
                const slot = this.mcpRegistry.create(
                    "__pending__",
                    opts.cwd,
                    opts.ownerUserId ?? null,
                    runCallbacks,
                    { nodeId: null, workspaceId: opts.workspaceId ?? null },
                );
                slotId = slot.slotId;
                mcpServers = [michiMcpServer(this.engine, this.mcpRegistry.endpoint(slotId))];
            }

            let result: { sessionId: string; modes?: any; models?: any };
            try {
                // Agent Runs have no surface for a workflow they launch; keep it off.
                result = await c.newSession(mcpServers, { metadata });
            } catch (err) {
                if (slotId) await this.mcpRegistry?.dispose(slotId).catch(() => {});
                throw err;
            }
            sid = result.sessionId;
            if (result.modes?.currentModeId) {
                this.sessionCurrentMode.set(sid, result.modes.currentModeId);
            }
            this.absorbFreshModes(opts.cwd, result.modes);
            this.absorbModels(sid, result.models);

            // Finalize the slot binding.
            if (slotId) {
                this.mcpRegistry?.rebind(slotId, { parentChatId: sid });
                this.slotByChatId.set(sid, slotId);
            }

            this.host.observability.perf.measure("newSession:agent_run", tNew, { cwd: opts.cwd, sid });
        } else {
            // ---------------------------------------------------------------
            // Chat path: existing warm-session + cold-open logic (unchanged).
            // ---------------------------------------------------------------
            const workflows = this.workflowsWanted(opts.ownerUserId ?? null);
            // Warm sessions open with Kiro's default policy; one with a preset opens fresh.
            const policyPresets = opts.sessionId ? this.policyPresetsFor(owner, opts.ownerUserId ?? null, opts.toolProfile) : [];
            const useWarm = !opts.toolProfile && policyPresets.length === 0;
            let warmed = useWarm ? this.consumeWarmedSession(opts.cwd, workflows) : undefined;
            if (!warmed && useWarm) {
                const warmLock = this.warmSessionLocks.get(opts.cwd);
                if (warmLock) {
                    const tWait = this.host.observability.perf.now();
                    this.host.observability.perf.mark("newChat:warm_inflight_wait_start", { cwd: opts.cwd });
                    await warmLock.catch(() => {});
                    warmed = this.consumeWarmedSession(opts.cwd, workflows);
                    this.host.observability.perf.measure(
                        warmed ? "newChat:warm_inflight_hit" : "newChat:warm_inflight_miss",
                        tWait,
                        { cwd: opts.cwd, sid: warmed?.sid },
                    );
                }
            }
            if (warmed) {
                sid = warmed.sid;
                slotId = warmed.slotId;
                this.host.observability.perf.mark("newChat:warmed_hit", { cwd: opts.cwd, sid });
            } else {
                const tNew = this.host.observability.perf.now();
                const opened = await this.openSession(c, opts.cwd, (getSlotId) =>
                    this.makeSlotCallbacks(getSlotId),
                    metadata,
                    workflows,
                    opts.toolProfile ? { nodeId: opts.sessionId, workspaceId: opts.workspaceId, ownerUserId: opts.ownerUserId } : undefined,
                    policyPresets,
                );
                sid = opened.sid;
                slotId = opened.slotId;
                this.host.observability.perf.measure("newChat:session_new", tNew, { cwd: opts.cwd, sid });
            }

            if (slotId) {
                // Before storeBinding: binding a chat group requires the slot's
                // parentChatId and nodeId.
                this.mcpRegistry?.rebind(slotId, {
                    owner: interactiveOwner(opts.sessionId ?? sid),
                    parentChatId: sid,
                    nodeId: opts.sessionId ?? sid,
                    workspaceId: opts.workspaceId ?? null,
                    ownerUserId: opts.ownerUserId ?? null,
                    agentRuns: resolveAgentRunToolsForSession(this.bridge, {
                        runtimeId: this.id,
                        sessionId: sid,
                        owner: interactiveOwner(opts.sessionId ?? sid),
                        ownerUserId: opts.ownerUserId ?? null,
                        workspaceId: opts.workspaceId ?? null,
                        nodeId: opts.sessionId ?? sid,
                    }) ?? undefined,
                });
                this.slotByChatId.set(sid, slotId);
            }
        }

        this.host.observability.perf.measure("newChat:total", tTotal, { cwd: opts.cwd, sid, agentRun: isAgentRun });
        const publicId = isAgentRun ? owner.key : (opts.sessionId ?? sid);

        try {
            // A warm session or a shared cwd process may have another model.
            // Apply settings to this session, never trust the process argv alone.
            if (opts.model && this.sessionCurrentModel.get(sid) !== opts.model) {
                await c.setModel(sid, opts.model);
                this.sessionCurrentModel.set(sid, opts.model);
            }
            await this.applyReasoning(c, sid, opts.reasoning);
        } catch (error) {
            c.destroySession(sid);
            if (slotId) await this.mcpRegistry?.dispose(slotId).catch(() => {});
            this.slotByChatId.delete(sid);
            this.sessionCurrentMode.delete(sid);
            this.sessionCurrentModel.delete(sid);
            throw error;
        }

        if (memory && isInteractiveOwner(owner)) memory.keep(owner.key);
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
            runtimeId: this.id,
            flavor: this.flavor,
            parentChatId: opts.parentChatId,
            enableFollowUps,
            owner,
            runtimeProfileHash: opts.profileHash ?? null,
            toolProfile: opts.toolProfile,
            permissionBroker: opts.permissionBroker,
            ownerUserId: opts.ownerUserId ?? null,
            workspaceId: opts.workspaceId ?? null,
        });

        if (!isAgentRun) {
            // Walk the parent's chain (parent's own ancestors + parent itself).
            // The new sid is not yet in the session directory — caller registers it on
            // return — so we explicitly resolve from opts.parentChatId.
            const ancestorChain: AgentSession[] = [];
            if (!opts.branchContext && opts.parentChatId) {
                this.host.sessions.ensureAncestorChainLoaded(opts.parentChatId);
                const parent = this.host.sessions.getSession(opts.parentChatId);
                if (parent) {
                    ancestorChain.push(...this.host.sessions.getAncestors(opts.parentChatId), parent);
                }
            }

            const workspaceInstructions = opts.workspaceId
                ? this.host.prompt.workspaceInstructions(opts.workspaceId)
                : null;

            const branchContextText = opts.branchContext
                ? this.host.prompt.renderBranchContext(opts.branchContext)
                : null;
            const preamble = this.firstMessagePrefix({
                enableFollowUps,
                cwd: opts.cwd,
                contextManifest: opts.contextManifest,
                extraContexts: opts.extraContexts,
                ancestors: ancestorChain,
                mergeContexts: [
                    ...(branchContextText ? [branchContextText] : []),
                    ...(opts.mergeContexts ?? []),
                ],
                workspaceInstructions,
            });
            session.primeFirstMessage([preamble, opts.bootstrapInstructions].filter(Boolean).join("\n\n"));
        } else if (opts.bootstrapInstructions) {
            // Agent Run sessions use bootstrap instructions as the first-message preamble.
            session.primeFirstMessage(opts.bootstrapInstructions);
        }

        return session;
    }

    // ---- Meta agent -----------------------------------------------------------

    /** Crew and other ACP adapters cannot host the Meta agent: their tools come from elsewhere. */
    private assertMetaAgentRuntime(profile: RuntimeToolProfile | null | undefined): string {
        const toolset = this.host.profile.toolset?.(profile);
        if (!toolset) throw this.host.profile.unsupportedError(this.id, profile);
        if (!this.runtimeOptions.restrictedAgent || this.runtimeOptions.launch) {
            throw this.host.profile.unsupportedError(this.id, profile);
        }
        return toolset;
    }

    /**
     * A Meta agent session runs in a kiro-cli in the toolset's agent
     * directory, never a chat or warm process. Sessions of one toolset share
     * that worker (openSharedMetaAgentSession); inside it the agent is
     * selected and its catalog checked before each session is returned.
     */
    private async openMetaAgentSession(opts: NewAgentSessionOptions | LoadAgentSessionOptions, mode: 'new' | 'load'): Promise<AgentSession> {
        const toolset = this.assertMetaAgentRuntime(opts.toolProfile);
        const meta = this.runtimeOptions.metaAgent;
        if (meta) {
            if (meta.toolset !== toolset) throw new Error('This Kiro worker hosts the other Meta agent toolset');
            return mode === 'new'
                ? this.createMetaAgentSession(opts as NewAgentSessionOptions)
                : this.restoreMetaAgentSession(opts as LoadAgentSessionOptions);
        }
        const id = ('nodeId' in opts ? opts.nodeId : undefined) ?? opts.sessionId;
        if (!id || (opts.owner && opts.owner.mode !== 'interactive')) throw new Error('The Meta agent runs only as a chat session');
        const names = opts.toolProfile?.allowedToolNames ?? [];
        const { dir, agentName } = this.runtimeOptions.restrictedAgent!.ensure(this.host.config.dataDir(), toolset, names);
        const family = [toolset, this.host.principal.enforceUserOwnership() ? opts.ownerUserId ?? '' : ''].join('\u0000');
        const key = [family, agentName, dir, ...[...new Set(names)].sort()].join('\u0000');
        return this.openSharedMetaAgentSession(id, family, key, dir, { toolset, agentName }, (worker) => mode === 'new'
            ? worker.newSession({ ...opts, cwd: dir } as NewAgentSessionOptions)
            : worker.loadSession({ ...opts, cwd: dir } as LoadAgentSessionOptions));
    }

    private metaAgentSlot(
        opts: { workspaceId?: string | null; ownerUserId?: string | null },
        profile: RuntimeToolProfile,
        nodeId: string,
        parentChatId: string,
        gate: MetaAgentGate,
        getSession: () => KiroSession | undefined,
    ): { slotId: string; mcpServers: AcpMcpServer[] } {
        if (!this.mcpRegistry) throw new Error('The Meta agent needs Michi\'s MCP server');
        const toolset = this.runtimeOptions.metaAgent!.toolset;
        let slotId: string | undefined;
        const slot = this.mcpRegistry.create(parentChatId, this.defaultCwd, opts.ownerUserId ?? null, {
            ...this.makeSlotCallbacks(() => slotId),
            owner: interactiveOwner(nodeId),
            exposedToolNames: new Set(profile.allowedToolNames ?? []),
            ...(toolset === 'chat' ? { restricted: true } : {
                maintenance: true,
                getActiveMaintenanceExecutionContext: () => getSession()?.getActiveMaintenanceExecutionContext() ?? null,
            }),
            isServing: () => gate.verified && !gate.failed,
        }, { nodeId, workspaceId: opts.workspaceId ?? null });
        slotId = slot.slotId;
        return { slotId, mcpServers: [michiMcpServer(this.engine, this.mcpRegistry.endpoint(slotId))] };
    }

    /** Select the toolset's agent (v3 ignores `--agent`), apply model settings, then check the catalog. */
    private async selectVerifiedMetaAgent(
        c: AcpClient, sid: string, currentModeId: string | undefined, profile: RuntimeToolProfile,
        model: string | null | undefined, reasoning: string | null | undefined,
    ): Promise<void> {
        const meta = this.runtimeOptions.metaAgent!;
        const since = c.toolCatalog(sid)?.seq ?? 0;
        if (this.engine === 'v3' || currentModeId !== meta.agentName) {
            try { await c.setMode(sid, meta.agentName); }
            catch (error) {
                throw catalogUnavailable(this.host, this.id, meta.toolset,
                    `Kiro did not select the Meta agent: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        this.sessionCurrentMode.set(sid, meta.agentName);
        if (model && this.sessionCurrentModel.get(sid) !== model) {
            await c.setModel(sid, model);
            this.sessionCurrentModel.set(sid, model);
        }
        await this.applyReasoning(c, sid, reasoning);
        await this.runtimeOptions.restrictedAgent!.verify({ client: c, sessionId: sid, engine: this.engine, runtimeId: this.id, profile, sinceSeq: since });
    }

    /** v3 can republish the catalog later; a catalog outside the toolset stops the session's tools and turn. */
    private watchMetaAgentCatalog(c: AcpClient, sid: string, profile: RuntimeToolProfile, gate: MetaAgentGate): void {
        if (this.engine !== 'v3') return;
        const off = c.onToolCatalogChange(sid, () => {
            if (gate.failed || this.metaAgentGates.get(sid) !== gate) { off(); return; }
            if (!this.metaAgentCatalogError(sid, profile, c.toolCatalog(sid)?.tags)) return;
            gate.failed = true;
            off();
            this.host.observability.log('error', 'acp', 'Kiro changed the Meta agent tool catalog; its tools are stopped', { sid });
            void c.cancel(sid).catch(() => {});
        });
    }

    private metaAgentCatalogError(sid: string, profile: RuntimeToolProfile, tags: unknown[] | undefined): Error | null {
        const toolset = this.runtimeOptions.metaAgent!.toolset;
        if (!tags) return catalogUnavailable(this.host, this.id, toolset, 'Kiro has no tool catalog for this session');
        try {
            const agent = this.runtimeOptions.restrictedAgent!;
            assertToolCatalog(this.host, { runtimeId: this.id, profile, observed: agent.catalog(tags), extraAllowed: agent.extraAllowed });
            return null;
        } catch (error) {
            return error as Error;
        }
    }

    /**
     * On a Meta agent worker: whether this session leaves the shared kiro-cli
     * unfit for the next one: its process is gone or unconfirmed, its turn did
     * not stop (quarantined), or Kiro changed its catalog.
     */
    private metaAgentSessionDamaged(publicSessionId: string): boolean {
        const client = this.pool.get(this.defaultCwd);
        if (!client || !client.isAlive() || client.hasUnconfirmedExit?.()) return true;
        const sid = this.sidByNodeId.get(publicSessionId);
        if (!sid) return false;
        return client.needsSessionRecovery?.(sid) === true || this.metaAgentGates.get(sid)?.failed === true;
    }

    /** Before each Meta agent turn: the session passed its check and, on v3, its latest catalog still does. */
    assertMetaAgentReady(sid: string): void {
        const worker = this.workerForNativeId(sid);
        if (worker) return worker.assertMetaAgentReady(sid);
        const meta = this.runtimeOptions.metaAgent;
        if (!meta) throw new Error('Not a Meta agent session');
        const gate = this.metaAgentGates.get(sid);
        const binding = this.getBindingByNativeSid(sid);
        if (!gate || !binding?.toolProfile) throw new Error('This Kiro Meta agent session has ended; open it again.');
        if (!gate.verified) throw catalogUnavailable(this.host, this.id, meta.toolset, 'this Kiro session has not passed its restriction check');
        if (this.engine === 'v3') {
            const error = this.metaAgentCatalogError(sid, binding.toolProfile, this.pool.get(binding.cwd)?.toolCatalog(sid)?.tags);
            if (error) { gate.failed = true; throw error; }
        }
        if (gate.failed) throw catalogUnavailable(this.host, this.id, meta.toolset, 'Kiro changed this session\'s tool catalog');
    }

    private bindMetaAgentSession(
        opts: NewAgentSessionOptions | LoadAgentSessionOptions, profile: RuntimeToolProfile,
        nodeId: string, sid: string, slotId: string, gate: MetaAgentGate,
    ): KiroSession {
        const owner: RuntimeSessionOwner = interactiveOwner(nodeId);
        this.slotByChatId.set(sid, slotId);
        this.sessionCwd.set(sid, this.defaultCwd);
        this.bindNodeSession(nodeId, sid);
        this.metaAgentGates.set(sid, gate);
        this.storeBinding({
            publicSessionId: nodeId,
            nativeSessionId: sid,
            owner,
            cwd: this.defaultCwd,
            workspaceId: opts.workspaceId ?? null,
            ownerUserId: opts.ownerUserId ?? null,
            runtimeProfileHash: opts.profileHash ?? null,
            toolProfile: profile,
            slotId,
            modelId: opts.model ?? null,
        });
        return new KiroSession(nodeId, sid, this, this.defaultCwd, {
            runtimeId: this.id,
            parentChatId: 'parentChatId' in opts ? opts.parentChatId : undefined,
            enableFollowUps: false,
            owner,
            runtimeProfileHash: opts.profileHash ?? null,
            toolProfile: profile,
            workspaceId: opts.workspaceId ?? null,
            ownerUserId: opts.ownerUserId ?? null,
        });
    }

    private async createMetaAgentSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
        const profile = opts.toolProfile!;
        const nodeId = opts.sessionId;
        if (!nodeId) throw new Error('The Meta agent needs a public session id');
        const toolset = this.runtimeOptions.metaAgent!.toolset;
        const c = await this.ensureClient(this.defaultCwd, opts.model ?? undefined);
        const gate: MetaAgentGate = { verified: false, failed: false };
        let session: KiroSession | undefined;
        const { slotId, mcpServers } = this.metaAgentSlot(opts, profile, nodeId, '__pending__', gate, () => session);
        let sid: string | undefined;
        try {
            const result = await c.newSession(mcpServers);
            sid = result.sessionId;
            const slot = this.mcpRegistry!.get(slotId);
            if (slot) slot.parentChatId = sid;
            this.absorbModels(sid, result.models);
            await this.selectVerifiedMetaAgent(c, sid, result.modes?.currentModeId, profile, opts.model, opts.reasoning);
        } catch (error) {
            if (sid) { c.destroySession(sid); this.sessionCurrentMode.delete(sid); this.sessionCurrentModel.delete(sid); }
            await this.mcpRegistry?.dispose(slotId).catch(() => {});
            throw error;
        }
        gate.verified = true;
        session = this.bindMetaAgentSession(opts, profile, nodeId, sid, slotId, gate);
        this.watchMetaAgentCatalog(c, sid, profile, gate);
        const branchContextText = opts.branchContext ? this.host.prompt.renderBranchContext(opts.branchContext) : null;
        const preamble = this.host.prompt.preamble({
            enableFollowUps: session.getEnableFollowUps(),
            toolProfile: profile,
            cwd: this.defaultCwd,
            contextManifest: opts.contextManifest,
            extraContexts: opts.extraContexts,
            ancestors: [],
            mergeContexts: [
                ...(branchContextText ? [branchContextText] : []),
                ...(opts.mergeContexts ?? []),
            ],
            workspaceInstructions: toolset === 'chat' && opts.workspaceId ? this.host.prompt.workspaceInstructions(opts.workspaceId) : null,
        });
        session.primeFirstMessage(this.host.profile.composeFirstTurnPrefix(preamble, opts.bootstrapInstructions, profile));
        return session;
    }

    private async restoreMetaAgentSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
        const profile = opts.toolProfile!;
        const nodeId = opts.nodeId ?? opts.sessionId;
        const storedEngine = opts.nativeEngine ?? this.host.bindings.nodeBinding(nodeId)?.runtime_engine ?? 'v2';
        if (storedEngine !== this.engine) throw new NativeResumeUnavailableError('Kiro native session belongs to another engine');
        const storedSid = this.host.bindings.nodeBinding(nodeId)?.acp_session_id ?? null;
        const sid = storedSid && storedSid !== nodeId ? storedSid : opts.nodeId ? opts.sessionId : storedSid ?? opts.sessionId;
        const c = await this.ensureClient(this.defaultCwd, opts.model ?? undefined);
        const gate: MetaAgentGate = { verified: false, failed: false };
        let session: KiroSession | undefined;
        const { slotId, mcpServers } = this.metaAgentSlot(opts, profile, nodeId, sid, gate, () => session);
        try {
            let result;
            try {
                result = await c.loadSession(sid, this.defaultCwd, mcpServers, undefined, { modelId: opts.model ?? undefined });
            } catch (error) {
                if (isNativeSessionUnavailable(error, sid)) throw new NativeResumeUnavailableError('Kiro native session is unavailable');
                throw error;
            }
            this.absorbModels(sid, result.models);
            await this.selectVerifiedMetaAgent(c, sid, result.modes?.currentModeId, profile, opts.model, opts.reasoning);
        } catch (error) {
            c.destroySession(sid);
            this.sessionCurrentMode.delete(sid);
            this.sessionCurrentModel.delete(sid);
            await this.mcpRegistry?.dispose(slotId).catch(() => {});
            throw error;
        }
        gate.verified = true;
        session = this.bindMetaAgentSession(opts, profile, nodeId, sid, slotId, gate);
        this.watchMetaAgentCatalog(c, sid, profile, gate);
        return session;
    }

    /** The host's text before a new chat's first message, as the flavor places it. */
    private firstMessagePrefix(input: PreambleInput): string {
        return this.flavor.prompt.firstMessage(this.host, input);
    }

    private async applyReasoning(client: AcpClient, sid: string, reasoning?: string | null): Promise<void> {
        if (!reasoning) return;
        if (this.engine === 'v2') {
            const result = await client.executeCommand(sid, 'effort', { value: reasoning });
            if (!result.success) throw new Error(result.message ?? 'Kiro rejected reasoning effort');
            return;
        }
        const option = client.getSessionInfo(sid)?.configOptions?.find((c) => c.id === 'effortLevel' || c.category === 'thought_level');
        if (!option) throw new Error('The selected Kiro model does not expose reasoning effort');
        await client.setConfigOption(sid, option.id, reasoning);
    }

    async forkSession(opts: ForkAgentSessionOptions): Promise<AgentSession> {
        if (this.host.profile.isRestricted(opts.toolProfile)) {
            this.assertMetaAgentRuntime(opts.toolProfile);
            throw new NativeResumeUnavailableError('The Meta agent does not fork native Kiro history');
        }
        if (this.usesSessionWorkers) {
            if (!opts.sessionId) throw new Error('Kiro v3 fork requires a child node id');
            return this.openIsolatedSession(opts.sessionId, opts.cwd, (worker) => worker.forkSession(opts));
        }
        if (!opts.sessionId || isHeadlessOwner(opts.owner)) throw new NativeResumeUnavailableError('Only chat nodes can inherit a native Kiro conversation');
        const parent = opts.parentChatId ? this.host.bindings.nodeBinding(opts.parentChatId) : null;
        if (parent && (parent.runtime_engine ?? 'v2') !== this.engine) throw new NativeResumeUnavailableError('Kiro engines differ');
        const edge = opts.workspaceId ? this.host.bindings.edges(opts.workspaceId).find((edge) => edge.kind === 'branch'
            && edge.source_node_id === opts.parentChatId && edge.target_node_id === opts.sessionId) : undefined;
        const anchorMessageId = opts.anchorMessageId ?? edge?.anchor_message_id;
        const point = anchorMessageId && opts.parentChatId
            ? this.host.bindings.forkAnchors.readKiroForkAnchor(opts.parentChatId, opts.sourceNativeSessionId, this.engine, anchorMessageId) : undefined;
        if (anchorMessageId && !point) throw new NativeResumeUnavailableError('No native Kiro anchor for the selected historical message');
        const c = await this.ensureClient(opts.cwd);
        // A fresh V3 child worker negotiates capabilities only after initialize.
        // Explicit unavailability lets tryForkChatSession use its normal fallback.
        if (!this.nativeForkSupported) throw new NativeResumeUnavailableError(`${this.label} does not support native fork`);
        const alreadyLoaded = c.hasSession(opts.sourceNativeSessionId);
        let childId: string;
        try {
            if (!alreadyLoaded) await c.loadSession(opts.sourceNativeSessionId, opts.cwd, []);
            childId = await c.forkSession(opts.sourceNativeSessionId, point ?? undefined);
        } catch (error) {
            if (this.flavor.nativeSessions.replaceable && isNativeSessionUnavailable(error, opts.sourceNativeSessionId)) throw new NativeResumeUnavailableError('Kiro parent session is unavailable');
            throw error;
        } finally {
            if (!alreadyLoaded) c.destroySession(opts.sourceNativeSessionId);
        }
        // Rebind the copied native history to the child's own MCP slot. The
        // anchor experiment keeps the URL stable and routes by the new SID.
        const loaded = await this.loadSession({ ...opts, sessionId: childId, nodeId: opts.sessionId, nativeEngine: this.engine });
        loaded.parentChatId = opts.parentChatId;
        (loaded as KiroSession).primeFirstMessage(this.firstMessagePrefix({
            enableFollowUps: opts.enableFollowUps !== false, cwd: opts.cwd,
            contextManifest: opts.contextManifest, extraContexts: opts.extraContexts,
            ancestors: [], mergeContexts: opts.mergeContexts,
            workspaceInstructions: opts.workspaceId ? this.host.prompt.workspaceInstructions(opts.workspaceId) : null,
        }));
        return loaded;
    }

    async recordForkAnchor(nodeId: string, sid: string, input: AgentTurnInput): Promise<void> {
        // Anchors only feed native fork; skip the rewind round-trip after every turn.
        if (!this.nativeForkSupported) return;
        const cwd = this.sessionCwd.get(sid);
        const c = cwd ? this.pool.get(cwd) : undefined;
        if (!c || !input.assistantMessageId || !isInteractiveOwner(this.getBindingByNativeSid(sid)?.owner)) return;
        try {
            const anchor = this.flavor.nativeSessions.forkAnchor
                ? await this.flavor.nativeSessions.forkAnchor(c, sid)
                : this.engine === 'v3'
                ? { messageId: c.getLastUserMessageId(sid) }
                : { logIndex: rewindPoints(await c.executeCommand(sid, 'rewind', {}, 5_000))[0]?.logIndex };
            if (anchor.messageId === undefined && anchor.logIndex === undefined) return;
            this.host.bindings.forkAnchors.saveKiroForkAnchor({ nodeId, nativeSessionId: sid, engine: this.engine,
                assistantMessageId: input.assistantMessageId, userMessageId: input.userMessageId, anchor });
        } catch (error) {
            // A failed optional anchor lookup must not change a completed turn
            // into a retry. Historical forks then use explicit text fallback.
            this.host.observability.log('warn', 'acp', 'could not retain Kiro fork anchor', { nodeId, engine: this.engine, error: String(error) });
        }
    }

    /**
     * AgentRuntime contract: restore an existing session by id with the
     * runtime's real MCP slot callbacks. The returned session has
     * primed=true semantics (no preamble re-injected; the original
     * preamble was sent in the prior backend run).
     *
     * For headless owners: the `nativeResumeToken` the host recorded for the
     * session is used as the ACP session id. The method MUST NOT look up a
     * host node binding — a headless session has none.
     */
    async loadSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
        if (this.host.profile.isRestricted(opts.toolProfile)) return this.acquireSession(opts, () => this.openMetaAgentSession(opts, 'load'));
        return this.acquireSession(opts, () => this.restoreSession(opts));
    }

    private async restoreSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
        if (this.usesSessionWorkers || (this.sessionAnchorsEnabled && (isHeadlessOwner(opts.owner) || !!opts.toolProfile))) {
            const id = isHeadlessOwner(opts.owner) ? opts.owner.key : opts.nodeId ?? opts.sessionId;
            return this.openIsolatedSession(id, opts.cwd, (worker) => worker.loadSession(opts));
        }
        const owner: RuntimeSessionOwner = opts.owner ?? interactiveOwner(opts.nodeId ?? opts.sessionId);
        const isAgentRun = isHeadlessOwner(owner);
        const storedEngine = opts.nativeEngine ?? (!isAgentRun ? this.host.bindings.nodeBinding(opts.nodeId ?? opts.sessionId)?.runtime_engine : undefined) ?? 'v2';
        const tokenEngine = typeof opts.nativeResumeToken === 'object' && opts.nativeResumeToken !== null && !Array.isArray(opts.nativeResumeToken)
            ? opts.nativeResumeToken.engine : undefined;
        if ((tokenEngine ?? storedEngine) !== this.engine) throw new NativeResumeUnavailableError('Kiro native session belongs to another engine');

        let nativeSessionId: string;

        if (isAgentRun) {
            // Agent Run path: use nativeResumeToken directly — never query nodes.
            const token = opts.nativeResumeToken;
            const sid = typeof token === 'string' ? token
                : token && typeof token === 'object' && !Array.isArray(token) ? token.sessionId : undefined;
            if (typeof sid !== 'string' || !sid) {
                throw new Error("Kiro agent_run loadSession requires a string nativeResumeToken (ACP session id)");
            }
            nativeSessionId = sid;
        } else {
            // Chat path: existing Node-based ACP sid lookup (unchanged).
            const nodeId = opts.nodeId ?? opts.sessionId;
            const storedSid = this.host.bindings.nodeBinding(nodeId)?.acp_session_id ?? null;
            nativeSessionId = storedSid && storedSid !== nodeId
                ? storedSid
                : opts.nodeId
                    ? opts.sessionId
                    : storedSid ?? opts.sessionId;
        }

        const publicId = isAgentRun ? owner.key : (opts.nodeId ?? opts.sessionId);

        if (isAgentRun) {
            // Build a fresh Run MCP slot for the resumed session.
            const chatCallbacks = this.makeSlotCallbacks(() => resumeSlotId);
            const toolProfile = opts.toolProfile ?? { allowedToolNames: [] };
            let resumeSlotId: string | undefined;
            const runCallbacks = buildRunMcpSlotCallbacks({
                owner,
                workspaceId: opts.workspaceId ?? null,
                ownerUserId: opts.ownerUserId ?? null,
                toolProfile,
                chatCallbacks,
            });

            let mcpServers: AcpMcpServer[] = [];
            if (this.mcpRegistry) {
                const slot = this.mcpRegistry.create(
                    nativeSessionId,
                    opts.cwd,
                    opts.ownerUserId ?? null,
                    runCallbacks,
                    { nodeId: null, workspaceId: opts.workspaceId ?? null },
                );
                resumeSlotId = slot.slotId;
                mcpServers = [michiMcpServer(this.engine, this.mcpRegistry.endpoint(resumeSlotId))];
            }

            const c = await this.ensureClient(opts.cwd, opts.model ?? undefined);
            try {
                const result = await c.loadSession(nativeSessionId, opts.cwd, mcpServers, undefined, { modelId: opts.model ?? undefined });
                if (opts.model && result.models?.currentModelId !== opts.model) {
                    await c.setModel(nativeSessionId, opts.model);
                    result.models = { ...result.models, currentModelId: opts.model };
                }
                if (result.modes?.currentModeId) {
                    this.sessionCurrentMode.set(nativeSessionId, result.modes.currentModeId);
                }
                this.absorbModes(result.modes);
                this.absorbModels(nativeSessionId, result.models);
                await this.applyReasoning(c, nativeSessionId, opts.reasoning);
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
                runtimeId: this.id,
                flavor: this.flavor,
                enableFollowUps: false,
                owner,
                runtimeProfileHash: opts.profileHash ?? null,
                toolProfile: opts.toolProfile,
                permissionBroker: opts.permissionBroker,
                ownerUserId: opts.ownerUserId ?? null,
                workspaceId: opts.workspaceId ?? null,
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
            workflows: this.workflowsWanted(opts.ownerUserId ?? null),
            policyPresets: this.policyPresetsFor(interactiveOwner(nodeId), opts.ownerUserId ?? null, opts.toolProfile),
        });
        if (opts.toolProfile && !this.host.profile.isRestricted(opts.toolProfile)) {
            if (this.runtimeOptions.restrictedAgent?.isRestrictedMode?.(result.modes?.currentModeId ?? '')) {
                (await this.ensureClient(opts.cwd)).destroySession(result.sid);
                if (result.slotId) await this.mcpRegistry?.dispose(result.slotId).catch(() => {});
                throw new NativeResumeUnavailableError('Assistant native history uses a retired restricted profile');
            }
        }
        if (opts.reasoning) {
            try { await this.applyReasoning(await this.ensureClient(opts.cwd), result.sid, opts.reasoning); }
            catch (error) {
                if (result.slotId) await this.mcpRegistry?.dispose(result.slotId).catch(() => {});
                throw error;
            }
        }
        if (result.slotId) {
            this.mcpRegistry?.rebind(result.slotId, {
                agentRuns: resolveAgentRunToolsForSession(this.bridge, {
                    runtimeId: this.id,
                    sessionId: result.sid,
                    owner: interactiveOwner(nodeId),
                    ownerUserId: opts.ownerUserId ?? null,
                    workspaceId: opts.workspaceId ?? null,
                    nodeId,
                }) ?? undefined,
            });
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
            runtimeId: this.id,
            flavor: this.flavor,
            enableFollowUps: opts.enableFollowUps !== false,
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
        return this.acquisitions.release(sessionId, () => this.disposeSession(sessionId, expectedOwner));
    }

    private async disposeSession(sessionId: string, expectedOwner?: RuntimeSessionOwner): Promise<void> {
        const shared = this.metaAgentWorkerBySession.get(sessionId);
        if (shared) {
            // Judged before release clears the session's state: a stuck turn, a
            // failed catalog or a dead process retires the shared worker.
            const damaged = shared.worker.metaAgentSessionDamaged(sessionId);
            await shared.worker.releaseSession(sessionId, expectedOwner);
            this.sessionWorkers.delete(sessionId);
            this.metaAgentWorkerBySession.delete(sessionId);
            this.acquiredSessions.delete(sessionId);
            shared.sessions.delete(sessionId);
            if (damaged || shared.retired) await this.retireMetaAgentWorker(shared);
            else this.settleMetaAgentWorker(shared);
            return;
        }
        const worker = this.sessionWorkers.get(sessionId);
        if (worker) {
            await worker.releaseSession(sessionId, expectedOwner);
            this.sessionWorkers.delete(sessionId);
            this.acquiredSessions.delete(sessionId);
            await worker.shutdown();
            return;
        }
        const sid = this.sidByNodeId.get(sessionId) ?? sessionId;
        const nodeId = this.nodeIdBySid.get(sid) ?? sessionId;

        // Owner verification guard.
        if (expectedOwner) {
            const binding = this.bindings.get(nodeId) ?? this.bindings.get(sessionId);
            if (binding) {
                assertReleaseOwnership(binding.owner, expectedOwner);
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
        this.host.sessions.dropSession(nodeId);

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
        if (this.modelCatalog.cached) {
            void this.refreshModels().catch((err: unknown) => {
                this.host.observability.log('warn', 'acp', 'model refresh failed; using cached catalog', { error: (err as Error).message });
            });
            return this.modelCatalog.cached;
        }
        return this.refreshModels();
    }

    async refreshModels(): Promise<ModelInfo[]> {
        return this.modelCatalog.refresh();
    }

    /** Shutdown: kill all clients in pool and reset internal maps. */
    async shutdown(): Promise<void> {
        this.closing = true;
        this.acquiredSessions.clear();
        const workers = [...this.isolatedWorkers()];
        for (const entry of this.metaAgentWorkers.values()) this.cancelMetaAgentIdle(entry);
        this.sessionWorkers.clear();
        this.metaAgentWorkers.clear();
        this.metaAgentWorkerBySession.clear();
        await Promise.all(workers.map((worker) => worker.shutdown()));
        await Promise.allSettled([...this.startLocks.values(), ...this.warmSessionLocks.values()]);
        await Promise.allSettled(this.cancelRecoveryLocks.values());
        await this.titleGenerator?.shutdown().catch(() => {});
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
        for (const pool of this.warmedSessions.values()) {
            for (const entry of pool) {
                if (entry.slotId) await this.mcpRegistry?.dispose(entry.slotId);
            }
        }
        // Release slots bound to live sessions.
        for (const slotId of this.slotByChatId.values()) await this.mcpRegistry?.dispose(slotId);
        this.slotByChatId.clear();
        this.sessionCwd.clear();
        this.sidByNodeId.clear();
        this.nodeIdBySid.clear();
        this.bindings.clear();
        for (const group of this.mcpSessionGroups.values()) this.mcpRegistry?.disposeSessionGroup(group);
        this.mcpSessionGroups.clear();
        this.publicIdByNativeSid.clear();
        const clients = [...this.pool.values()];
        this.pool.clear();
        this.warmedSessions.clear();
        this.warmSessionLocks.clear();
        this.sessionCurrentMode.clear();
        this.sessionCurrentModel.clear();
        this.globalAvailableModes = null;
        this.defaultModeByCwd.clear();
        this.globalAvailableModels = null;
        await Promise.all(clients.map((c) => c.shutdown().catch(() => {})));
    }
}
