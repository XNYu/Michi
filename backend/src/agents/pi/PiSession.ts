import { createMaintenanceAccessTools } from '../../services/metaAgent/maintenanceAccess';
import { hostOwner } from '../ownerMapping';
import { ChatApprovalState, chatApprovalOptions, approvalCoversTool } from '../chatApprovalState';
import { chatNodeOf, chatOwner, isRunOwner } from '../ownerMapping';
import fs from "fs";
import path from "path";
import os from "os";
import { abortable, withDeadline } from '../runtimeLifecycle';
import type { UserInputAnswer, UserInputQuestion } from 'michi-shared';
import type {
    AgentReasoning,
    AgentSession,
    AgentTurnInput,
    CancelAck,
    ChatMessage,
    CompactResult,
    RuntimePermissionBroker,
    RuntimeSessionOwner,
    RuntimeToolProfile,
    MaintenanceExecutionContext,
    SteerResult,
} from "../types";
import { imageMimeType, prepareAttachments, type ResolvedAttachment } from "../attachments";
import type { NormalizedEvent, PermissionOption } from "../../services/chatEvents";
import type { PlanEntry } from "michi-shared";
import type { AgentToolBridge } from "../toolBridge";
import { resolveAgentRunToolsForSession } from "../toolBridge";
import { getRuntimeDeps } from "../runtimeDeps";
import { getProviderInfo, providerUsesAwsCredentials } from "./piProviders";
import { getModelAttemptIds, getUpstreamProviderId, resolvePiModel } from "./piProviders";
import { loadPiAi, loadPiAgentCore, loadPiTypebox } from "./piAi";
import { isGeminiArgon, isOpenRouterArgon } from './geminiArgonModel';
import { buildPiTools, piToolResultErrorOverride } from "./piTools";
import { PiTodoList } from "./piTodoTool";
import { PI_ASK_USER_INSTRUCTION, PI_ASK_USER_TOOL } from "./piAskUser";
import { interruptedToolResult } from "./piToolInterruption";
import type { PiExtensionUiHost } from "./piExtensionUi";
import {
    SEND_TO_THREAD_TOOL,
    threadMessageApprovalTitle,
    type ThreadMessageApprovalRequest,
    type ThreadMessageApprovalResult,
} from "../threadMessageTool";
import {
    scheduledJobApprovalPrompt,
    type ScheduledJobApprovalRequest,
    type ScheduledJobApprovalResult,
} from "../scheduledJobTools";
import { mapAgentEvent, type MapperContext } from "./eventMapper";
import type { MinimalAgentMessage } from "./historyAdapter";
import { makeTurnImageQuota, type TurnImageQuota } from "../tools/read";
import { chatPermissionMode } from "../permissionPolicy";
import { isAssistantProfile, piAssistantToolDecision } from "../../assistant/policy";
import { isMaintenanceProfile, META_AGENT_MAINTENANCE_TOOL_NAMES, maintenancePromptPrefix } from '../maintenancePolicy';
import { isMemoryExtractionToolName } from '../../services/memory/extractionProfile';
import { createMemoryExtractionTools } from '../../services/memory/extractionTools';
import { assertMetaAgentToolCatalog, isMetaAgentProfile } from '../metaAgentGuard';
import { createMaintenanceTools } from '../../services/pages/maintenanceTools';
import { followUpReminder } from "../preamble";
import { normalizeWorkspaceCwd } from "../tools/pathSandbox";
import { resolveBedrockCredentials } from "../../services/bedrockCredentials";
import { refreshBedrockCredentialsIfNeeded, refreshOnAuthFailure, isBedrockAuthError } from "../../services/bedrockCredentialManager";
import { McpClientManager } from "../../services/mcpClientManager";
import { readPiMcpServers } from "../../services/piMcpConfig";
import { buildMcpToolsForPi, deferMcpTools, mcpInputSchemaToTypebox, PI_TOOL_SEARCH_TOOL_NAME, shouldDeferMcpTools } from "./mcpToolBridge";
import type { PiSdkFeatures } from "./piSdkHarness";

/**
 * pi-agent-core accepts images as `prompt(text, ImageContent[])` with
 * base64 payloads. Unreadable files are skipped rather than failing the turn;
 * partitionAttachments has already stat-checked them, so this only guards
 * against a file disappearing between the two calls.
 */
function buildPiImageBlocks(
    images: ResolvedAttachment[],
): Array<{ type: "image"; data: string; mimeType: string }> {
    const blocks: Array<{ type: "image"; data: string; mimeType: string }> = [];
    for (const img of images) {
        const mimeType = imageMimeType(img.absPath);
        if (!mimeType) continue;
        try {
            blocks.push({ type: "image", data: fs.readFileSync(img.absPath).toString("base64"), mimeType });
        } catch {
            /* unreadable at send time — skip rather than fail the turn */
        }
    }
    return blocks;
}

export interface PiSessionDeps {
    bridge: AgentToolBridge;
    /** Preamble injected as system prompt. Built by PiRuntime. */
    preamble: string;
    /**
     * Short restatement of the [TITLE:] / [FOLLOW-UP n/3:] format rules,
     * glued onto the FIRST user message only. Belt-and-suspenders for Pi's
     * weaker providers (DeepSeek etc.) where format guidance in just the
     * system prompt isn't reliably followed; Anthropic via Pi doesn't need
     * it but the extra ~150 tokens once per fresh session is harmless.
     * Empty string disables the glue.
     */
    firstUserGlue?: string;
    cwd: string;
    enableFollowUps: boolean;
    parentChatId?: string;
    /** Workspace this session belongs to. Used by globalContext tools. */
    workspaceId: string | null;
    /**
     * Better-Auth user id of the chat owner. When set (cloud BYOK mode)
     * provider keys are looked up per-user. When null (local desktop /
     * Electron) the legacy env / disk store is used.
     */
    ownerUserId: string | null;
    owner?: RuntimeSessionOwner;
    profileHash?: string | null;
    toolProfile?: RuntimeToolProfile;
    permissionBroker?: RuntimePermissionBroker;
    requestedProvider?: string | null;
    requestedModel?: string | null;
    requestedReasoning?: AgentReasoning | null;
    /**
     * Prior messages from SQLite (rehydrate path). When non-empty:
     *   - Agent.initialState.messages is seeded with them
     *   - getHistory() reflects these messages so ancestor preamble stitching works
     */
    initialMessages?: MinimalAgentMessage[];
    /** Explicit host-owned extensions only; never discovered from user paths. */
    sdkExtensionFactories?: Array<(pi: any) => void | Promise<void>>;
    /** Allow native recovery only with the host-provided history replay. */
    restoreNative?: boolean;
    /** Persisted plan the todo list starts from (own latest, else the branch parent's at the cut). */
    initialPlan?: PlanEntry[] | null;
}

/**
 * Diagnostic — append every raw text_delta / thinking_delta and turn-boundary
 * marker from pi-agent-core to a per-session log file so we can inspect what
 * the model literally emitted (vs. what the frontend parses). Opt-in via the
 * MICHI_PI_RAW_DUMP env var: set it to "1" to write under
 * <tmpdir>/michi-pi-raw/<sessionId>.log, or to an explicit directory path.
 * Default off — leaves no disk writes on the hot path.
 */
function openRawDump(sessionId: string): {
    write: (kind: "chunk" | "thought" | "marker", text: string) => void;
    close: () => void;
} {
    const flag = process.env.MICHI_PI_RAW_DUMP;
    if (!flag) return { write: () => {}, close: () => {} };
    const dir = flag === "1" ? path.join(os.tmpdir(), "michi-pi-raw") : flag;
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
        console.warn(`[piRuntime] raw dump dir mkdir failed (${dir}):`, err);
        return { write: () => {}, close: () => {} };
    }
    const filePath = path.join(dir, `${sessionId}.log`);
    return {
        write: (kind, text) => {
            try {
                const prefix = kind === "marker" ? `\n[${text}]\n` : kind === "thought" ? `[THINK]${text}` : text;
                fs.appendFileSync(filePath, prefix);
            } catch {
                /* swallow — diagnostic only, never break the turn */
            }
        },
        close: () => {},
    };
}

// Question IDs must not repeat when a node gets a replacement Session, or
// after a backend restart, so a renderer's stale reply never answers a newer
// question. Same scheme as the Claude adapter's interaction IDs.
let lastUserInputRequestId = Date.now() * 1_000;
function nextUserInputRequestId(): number {
    lastUserInputRequestId = Math.max(lastUserInputRequestId + 1, Date.now() * 1_000);
    if (!Number.isSafeInteger(lastUserInputRequestId)) throw new Error('Pi user input request ID exhausted');
    return lastUserInputRequestId;
}

/** How long ask_user waits for an answer; the other runtimes share MICHI_APPROVE_TIMEOUT_MS. */
function userInputTimeoutMs(): number {
    const parsed = Number.parseInt(process.env.MICHI_APPROVE_TIMEOUT_MS ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60 * 1000;
}

function describeCompaction(result: { tokensBefore?: unknown; estimatedTokensAfter?: unknown } | undefined): string {
    const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : null;
    const before = count(result?.tokensBefore);
    const after = count(result?.estimatedTokensAfter);
    return before && after ? `Compacted the conversation from about ${before} to about ${after} tokens.`
        : 'Compaction completed.';
}

/**
 * AgentSession backed by pi-agent-core's Agent.
 *
 * The Agent owns the messages array, abort controller, tool dispatch, and
 * per-turn loop. We subscribe to its events, push translated NormalizedEvents
 * onto an internal queue, and yield from the queue inside send().
 *
     * The "MCP" tools (set_title / set_follow_ups / spawn_branches /
     * save_artifact / update_artifact) are wired through the AgentToolBridge by buildPiTools —
 * same business effects as the Kiro path.
 */
export class PiSession implements AgentSession {
    public readonly id: string;
    public readonly runtimeId = "pi";
    public parentChatId?: string;
    private readonly cwd: string;
    private readonly bridge: AgentToolBridge;
    private readonly preamble: string;
    private readonly firstUserGlue: string;
    private firstUserPrimed: boolean;
    private readonly enableFollowUps: boolean;
    private readonly workspaceId: string | null;
    /**
     * Better-Auth user id of the chat owner, or null on local /
     * Electron deployments. Threaded into getProviderApiKey() so cloud
     * BYOK users can resolve their own encrypted key.
     */
    private readonly ownerUserId: string | null;
    public readonly owner: RuntimeSessionOwner;
    public readonly runtimeProfileHash: string | null;
    private readonly toolProfile: RuntimeToolProfile | undefined;
    private readonly permissionBroker: RuntimePermissionBroker | undefined;
    private readonly requestedProvider: string | null;
    private readonly requestedModel: string | null;
    private readonly requestedReasoning: AgentReasoning | null;
    private readonly history: ChatMessage[] = [];
    /**
     * Mutable per-turn budget shared with the read tool. Built once and
     * reused across turns; usedBytes is reset to 0 at the start of every
     * runTurn so each user turn gets a fresh image quota.
     */
    private readonly imageQuota: TurnImageQuota = makeTurnImageQuota();
    /**
     * Absolute paths the agent has successfully read this session. write
     * blocks overwriting an existing file the agent has not read; edit
     * always requires a prior read. Set is session-scoped (not turn) — once
     * seen, subsequent edits in later turns are unblocked.
     */
    private readonly seenPaths: Set<string> = new Set();
    /** Session-scoped todo list; its changes reach the UI as plan events. */
    private readonly todoList: PiTodoList;
    private agent: any | undefined;
    private hostTools: any[] = [];
    /** MCP tools are deferred behind tool_search (sticky; see applyMcpExposure). */
    private mcpToolSearch = false;
    private destroyed = false;
    /**
     * Lazily created on first turn when piMcpServers config is non-empty.
     * Disposed in destroy(). Session-scoped so each PiSession gets its own
     * MCP child processes (isolated env, independent lifecycle).
     */
    private mcpManager: McpClientManager | undefined;
    private mcpInitialized = false;
    private readonly mcpWarnings: NormalizedEvent[] = [];
    private mcpInitialization: Promise<any[]> | undefined;
    private mcpCleanup: Promise<void> | undefined;
    private pendingAssistantBuf: string[] | undefined;
    /**
     * Set at the start of every runTurn so beforeToolCall (which is wired
     * once when the Agent is built and lives across turns) can push
     * permission_request events into the active turn's event queue.
     * Cleared at turn end.
     */
    private activePush: ((ev: NormalizedEvent) => void) | undefined;
    private turnAbort: AbortController | undefined;
    private activePageTurnAttribution: { turnId: string; assistantId: string } | null = null;
    private activeMaintenanceExecutionContext: MaintenanceExecutionContext | null = null;
    private inFlightPrompt: Promise<void> | undefined;
    private recoveryError: Error | undefined;
    private recoveryWork: Promise<void> | undefined;
    public currentModelId: string | null = null;
    /**
     * Outstanding permission requests keyed by requestId. Resolved by
     * respondToPermission/cancelPermission, rejected on session destroy
     * or 5-minute timeout.
     */
    private readonly pendingPermissions = new Map<
        number,
        {
            resolve: (optionId: string | null) => void;
            timer: NodeJS.Timeout;
            toolName?: string;
            /** Single-use approval a tool requested itself; grants never cover it. */
            explicit?: boolean;
        }
    >();
    private nextRequestId = 1;
    /** Outstanding ask_user questions keyed by requestId; answered, skipped, timed out or cancelled. */
    private readonly pendingUserInputs = new Map<number, {
        resolve: (answers: UserInputAnswer[] | null) => void;
        timer: NodeJS.Timeout;
    }>();
    /** ChatHub tracks one pending question per turn, so a later question waits for the current one. */
    private userInputGate: Promise<void> = Promise.resolve();
    /** Pi extension notices raised before the turn's stream was ready (session_start); sent when it is. */
    private readonly extensionNotices: NormalizedEvent[] = [];
    /** Pi SDK extension dialogs use ask_user's channel; their notices are turn warnings (piExtensionUi). */
    private readonly extensionUi: PiExtensionUiHost = {
        activeTurn: () => this.activePush && this.turnAbort && !this.turnAbort.signal.aborted ? this.turnAbort.signal : undefined,
        requestUserInput: (questions, dismiss) => this.requestUserInput(questions, undefined, dismiss),
        notify: (notice) => {
            const event: NormalizedEvent = { kind: 'warning', ...notice };
            if (this.activePush) this.activePush(event);
            else if (this.extensionNotices.length < 10) this.extensionNotices.push(event);
        },
    };
    /** A manual compaction between turns; turns and other compactions are declined while it runs. */
    private compaction: { controller: AbortController; work: Promise<unknown> } | undefined;
    private readonly approvals = new ChatApprovalState();
    private turnPermissionMode: import('michi-shared').ChatPermissionMode | undefined;

    constructor(id: string, deps: PiSessionDeps) {
        this.id = id;
        this.cwd = normalizeWorkspaceCwd(deps.cwd);
        this.bridge = deps.bridge;
        this.preamble = deps.preamble;
        this.firstUserGlue = isAssistantProfile(deps.toolProfile) ? "" : deps.firstUserGlue ?? "";
        // Rehydrated sessions skip the first-user-message glue — there's no
        // "first" turn to remind once the conversation already has prior turns.
        this.firstUserPrimed = (deps.initialMessages?.length ?? 0) > 0;
        this.enableFollowUps = deps.enableFollowUps && !isAssistantProfile(deps.toolProfile);
        this.parentChatId = deps.parentChatId;
        this.workspaceId = deps.workspaceId;
        this.ownerUserId = deps.ownerUserId;
        this.owner = deps.owner ?? chatOwner(id);
        this.runtimeProfileHash = deps.profileHash ?? null;
        this.toolProfile = deps.toolProfile;
        this.permissionBroker = deps.permissionBroker;
        this.requestedProvider = deps.requestedProvider ?? null;
        this.requestedModel = deps.requestedModel ?? null;
        this.currentModelId = this.requestedModel;
        this.requestedReasoning = deps.requestedReasoning ?? null;
        this.todoList = new PiTodoList(deps.initialPlan);

        // Seed history from SQLite-rehydrated messages (text-only).
        const seed = deps.initialMessages ?? [];
        for (const m of seed) {
            const text = m.content[0]?.text ?? "";
            if (!text) continue;
            this.history.push({ role: m.role, content: text });
        }
    }

    getOwnerUserId(): string | null { return this.ownerUserId; }

    get currentModeId(): string | null {
        return null;
    }

    getHistory(): ChatMessage[] {
        return this.history;
    }

    getPendingAssistant(): string | undefined {
        return this.pendingAssistantBuf?.join("");
    }

    getActivePageTurnAttribution(): { turnId: string; assistantId: string } | null {
        return hostOwner(this.owner).kind === 'chat_node' ? this.activePageTurnAttribution : null;
    }

    getActiveMaintenanceExecutionContext(): MaintenanceExecutionContext | null {
        return this.activeMaintenanceExecutionContext;
    }

    private maintenanceContextForSend(input?: AgentTurnInput): MaintenanceExecutionContext | null {
        if (!isMaintenanceProfile(this.toolProfile)) {
            if (input?.maintenanceContext) throw new Error('Maintenance context supplied to a non-maintenance Pi session');
            return null;
        }
        const context = input?.maintenanceContext;
        if (!context || hostOwner(this.owner).kind !== 'chat_node' || !input?.turnId || !input.assistantMessageId
            || context.workspaceId !== this.workspaceId
            || context.ownerUserId !== (this.ownerUserId ?? 'local-user')
            || !context.jobId || !context.runId || !context.claimedBy || !context.planId
            || !Number.isSafeInteger(context.configRevision) || context.configRevision < 1
            || !Array.isArray(context.sources)) {
            throw new Error('Maintenance Pi send is missing a valid owner, workspace, or canonical turn binding');
        }
        return { ...context, execution: { nodeId: this.owner.key, turnId: input.turnId, assistantId: input.assistantMessageId, runId: context.runId } };
    }

    describeNativeState(): Record<string, unknown> {
        return {
            kind: 'pi-agent-core',
            status: this.destroyed ? 'destroyed' : this.recoveryError ? 'unavailable'
                : this.turnAbort?.signal.aborted || this.mcpCleanup ? 'stopping'
                : this.turnAbort ? 'running' : this.compaction ? 'compacting' : 'idle',
            recoveryRequired: !!this.recoveryError,
            recoveryAction: this.recoveryError ? 'restart_backend_if_still_unavailable' : undefined,
            detail: this.recoveryError?.message,
        };
    }

    async *send(rawUserText: string, input?: AgentTurnInput): AsyncIterableIterator<NormalizedEvent> {
        this.assertAvailable();
        if (this.compaction) {
            throw new Error('Pi is compacting this conversation. Please retry after it finishes; no new request was sent.');
        }
        if (this.turnAbort || this.inFlightPrompt || this.mcpInitialization || this.mcpCleanup) {
            throw new Error('The previous Pi task is still stopping. Please retry after it finishes; no new request was sent.');
        }
        const maintenanceContext = this.maintenanceContextForSend(input);
        this.turnPermissionMode = chatPermissionMode(this.owner, this.ownerUserId);
        const controller = new AbortController();
        this.turnAbort = controller;
        const pageTurnAttribution = hostOwner(this.owner).kind === 'chat_node' && input?.turnId && input.assistantMessageId
            ? { turnId: input.turnId, assistantId: input.assistantMessageId } : null;

        this.history.push({ role: "user", content: rawUserText });

        const buf: string[] = [];
        this.pendingAssistantBuf = buf;

        try {
            this.activePageTurnAttribution = pageTurnAttribution;
            this.activeMaintenanceExecutionContext = maintenanceContext;
            for await (const ev of this.runTurn(rawUserText, controller.signal, input)) {
                if (ev.kind === "chunk") buf.push(ev.text);
                yield ev;
                if (ev.kind === "turn_end") break;
            }
        } catch (error) {
            // runTurn cleanup can mark the session unavailable after the entry guard.
            const recoveryError = this.recoveryError as Error | undefined;
            if (recoveryError) {
                yield { kind: 'retry_end', detail: recoveryError.message };
                yield { kind: 'runtime_error', error: recoveryError.message, recoveryRequired: true };
                yield { kind: 'turn_end', stopReason: 'error' };
                return;
            }
            if (!controller.signal.aborted) throw error;
            yield { kind: 'turn_end', stopReason: 'cancelled' };
        } finally {
            controller.abort();
            if (this.turnAbort === controller) this.turnAbort = undefined;
            if (this.activePageTurnAttribution === pageTurnAttribution) this.activePageTurnAttribution = null;
            if (this.activeMaintenanceExecutionContext === maintenanceContext) this.activeMaintenanceExecutionContext = null;
            if (buf.length > 0) {
                this.history.push({ role: "assistant", content: buf.join("") });
            }
            this.pendingAssistantBuf = undefined;
            await this.onTurnSettled();
        }
    }

    protected async onTurnSettled(): Promise<void> {}

    /**
     * Ready the live Agent for a model request: current model, credentials,
     * reasoning and tools, building the Agent on first use. Turns run it before
     * prompting; manual compaction runs it between turns. Yields setup warnings.
     */
    private async *prepareTurn(signal: AbortSignal): AsyncGenerator<NormalizedEvent, { model: any }> {
        // Runtime ownership is required for durable Agent Runs even on local
        // desktop installs (where the synthetic owner is "local-user"). Do
        // not confuse that audit identity with a cloud BYOK credential owner:
        // local Pi sessions must keep resolving config/keys from env or the
        // shared ~/.michi/config.json store, exactly like ordinary chats.
        const ownerUserId = process.env.MICHI_CLOUD === "1"
            ? this.ownerUserId ?? undefined
            : undefined;
        const deps = getRuntimeDeps();
        const cfg = deps.agentConfig.getAgentConfig(ownerUserId);
        const provider = this.requestedProvider ?? cfg.provider;
        const upstreamProvider = getUpstreamProviderId(provider);
        const requestedModel = this.requestedModel ?? deps.agentConfig.resolveModel(this.runtimeId, ownerUserId);
        const modelAttemptIds = getModelAttemptIds(provider, requestedModel);

        // Resolve authentication: AWS credential chain for Bedrock, API key for everything else.
        const isAwsCred = providerUsesAwsCredentials(provider);
        let apiKey: string | null = null;
        let bedrockStreamOpts: Record<string, unknown> = {};
        let bedrockAuthRetry: Parameters<typeof streamSimpleWithFallback>[5];

        if (isAwsCred) {
            const creds = resolveBedrockCredentials();
            if (!creds) {
                throw new Error(
                    "Amazon Bedrock credentials not configured — add them in Settings or set AWS_PROFILE + AWS_REGION env vars.",
                );
            }
            await abortable(refreshBedrockCredentialsIfNeeded(creds), signal);
            bedrockAuthRetry = { isAuthError: isBedrockAuthError, refresh: () => refreshOnAuthFailure(creds) };
            bedrockStreamOpts = { region: creds.region };
            if (creds.bearerToken) bedrockStreamOpts.bearerToken = creds.bearerToken;
            if (creds.profile) bedrockStreamOpts.profile = creds.profile;
            if (creds.accessKeyId) {
                bedrockStreamOpts.accessKeyId = creds.accessKeyId;
                bedrockStreamOpts.secretAccessKey = creds.secretAccessKey;
            }
        } else {
            apiKey = deps.providerKeys.getProviderApiKey(provider, ownerUserId);
            if (!apiKey) {
                const name = getProviderInfo(provider)?.name ?? provider;
                // Tailor the error so cloud users see "set your key in Settings"
                // rather than the desktop-flavored "API key not configured".
                const hint = ownerUserId
                    ? `${name} API key not set for your account — add it in Settings.`
                    : `${name} API key not configured`;
                throw new Error(hint);
            }
        }

        const piMod: any = await abortable(loadPiAi(), signal);
        const piAgentCore: any = await abortable(loadPiAgentCore(), signal);
        const { Type } = await abortable(loadPiTypebox(), signal);
        const modelIds = modelAttemptIds.length > 0
            ? modelAttemptIds
            : [requestedModel];
        const modelAttempts = await abortable(Promise.all(
            modelIds.map((modelId) => resolvePiModel(provider, modelId)),
        ), signal);
        const model = modelAttempts[0];
        this.currentModelId = (model as any).id ?? requestedModel ?? null;
        const thinkingLevel = (() => {
            if (getProviderInfo(provider)?.supportsReasoning === false) return 'off';
            const requested = this.requestedReasoning ?? deps.agentConfig.resolveReasoning(this.runtimeId, ownerUserId);
            const defaultLevel = isGeminiArgon(model) || (model.provider === 'openrouter' && isOpenRouterArgon(model.id)) ? 'medium' : 'off';
            return piMod.clampThinkingLevel(model, requested ?? defaultLevel);
        })();
        const turnStreamFn = (_m: any, c: any, o: any) => {
            // SDK preflight/summary auth is not the credential authority. In
            // particular, never forward its host-managed placeholder as an AWS
            // bearer token or inherit a prior provider's headers/environment.
            const { apiKey: _sdkKey, headers: _sdkHeaders, env: _sdkEnv, ...options } = o ?? {};
            return streamSimpleWithFallback(piMod, upstreamProvider, modelAttempts, c,
                { ...options, ...(apiKey ? { apiKey } : {}), ...bedrockStreamOpts }, bedrockAuthRetry);
        };

        // Reset the per-turn image budget before each LLM-driven loop.
        this.imageQuota.usedBytes = 0;

        // Retry only failed MCP setup on later turns. Connected servers remain
        // session-scoped; a partial first catalog must not become permanent.
        const mcpTools = this.applyMcpExposure(isMetaAgentProfile(this.toolProfile) ? [] : await this.initMcpTools(Type, signal));
        signal.throwIfAborted();
        for (const warning of this.mcpWarnings.splice(0)) yield warning;
        if (this.agent) {
            const tools = [
                ...this.hostTools.filter((tool: { name: string }) => !tool.name.startsWith('mcp__')),
                ...mcpTools.filter((tool) => this.isToolAllowed(tool.name)),
            ];
            this.hostTools = tools;
            if (this.agent.updateTools) await this.agent.updateTools(tools);
            else this.agent.state.tools = tools;
        }

        // Lazily build the Agent on the first turn (and reuse on subsequent turns).
        if (!this.agent) {

            // Maintenance gets only its dedicated tools below, never the chat builtins.
            const tools = isMaintenanceProfile(this.toolProfile) ? [] : buildPiTools({
                bridge: this.bridge,
                cwd: this.cwd,
                // parentChatId here is the parent OF the spawned children (= this session),
                // distinct from this.parentChatId which is *this* session's ancestor.
                parentChatId: this.id,
                workspaceId: this.workspaceId,
                enableFollowUps: this.enableFollowUps,
                imageQuota: this.imageQuota,
                seenPaths: this.seenPaths,
                Type,
                ownerUserId: this.ownerUserId,
                // Stable closure: tools are built once, but activePush is rebound
                // each turn. show_image routes its inline image through here.
                emitImage: (ev) => this.activePush?.(ev),
                requestThreadMessageApproval: (request, signal) => this.requestThreadMessageApproval(request, signal),
                requestScheduledJobApproval: (request, signal) => this.requestScheduledJobApproval(request, signal),
                requestUserInput: (questions, signal) => this.requestUserInput(questions, signal),
                agentRunTools: resolveAgentRunToolsForSession(this.bridge, {
                    runtimeId: this.runtimeId,
                    sessionId: this.id,
                    owner: this.owner,
                    ownerUserId: this.ownerUserId,
                    workspaceId: this.workspaceId,
                    nodeId: chatNodeOf(this.owner) ?? null,
                }),
                owner: this.owner,
                toolProfile: this.toolProfile,
                getActivePageTurnAttribution: () => this.getActivePageTurnAttribution(),
                todoList: this.todoList,
            }).filter((tool) => this.isToolAllowed(tool.name));

            if (isMaintenanceProfile(this.toolProfile)) {
                const getContext = () => this.getActiveMaintenanceExecutionContext();
                const maintenanceTools = [...createMaintenanceTools(getContext, {}), ...createMaintenanceAccessTools(getContext, {
                    internalTools: (context) => buildPiTools({
                        bridge: this.bridge, cwd: this.cwd, parentChatId: this.id, workspaceId: context.workspaceId,
                        owner: this.owner, ownerUserId: context.ownerUserId, enableFollowUps: false,
                        imageQuota: this.imageQuota, seenPaths: this.seenPaths, Type,
                        getActivePageTurnAttribution: () => context.execution,
                    }).map((tool: any) => ({
                        name: tool.name, description: tool.description, inputSchema: tool.parameters,
                        execute: (args: Record<string, unknown>, signal?: AbortSignal) => tool.execute('maintenance', args, signal),
                    })),
                }), ...createMemoryExtractionTools(getContext)];
                for (const tool of maintenanceTools) {
                    // The profile's allow-list picks one closed toolset: Pages maintenance or automatic memory.
                    if (!(META_AGENT_MAINTENANCE_TOOL_NAMES.includes(tool.name) || isMemoryExtractionToolName(tool.name)) || !this.isToolAllowed(tool.name)) continue;
                    const parameters = mcpInputSchemaToTypebox(tool.parameters as unknown as Record<string, unknown>, Type);
                    tools.push({
                        name: tool.name,
                        label: tool.name.replaceAll('_', ' '),
                        description: tool.description,
                        parameters,
                        execute: async (_id: string, args: Record<string, unknown>, signal?: AbortSignal) => {
                            const { __tool_use_purpose: _purpose, ...input } = args ?? {};
                            return tool.execute(input, signal);
                        },
                    });
                }
            }

            // Append tools from configured MCP servers.
            if (mcpTools.length > 0) {
                tools.push(...mcpTools.filter((tool) => this.isToolAllowed(tool.name)));
            }
            if (isMetaAgentProfile(this.toolProfile)) {
                assertMetaAgentToolCatalog({ runtimeId: this.runtimeId, profile: this.toolProfile, observed: tools.map((tool: { name: string }) => tool.name) });
            }

            // Per-workspace Instructions panel feeds the system prompt directly
            // here. Pi has no warm pool, so we can apply it at session creation
            // without violating any pool-key invariants.
            const workspaceInstructions = !isMaintenanceProfile(this.toolProfile) && this.workspaceId
                ? deps.historyStore.getWorkspaceInstructions(this.workspaceId)
                : null;
            const askUser = tools.some((tool: { name: string }) => tool.name === PI_ASK_USER_TOOL) ? PI_ASK_USER_INSTRUCTION : null;
            const systemPrompt = [this.preamble, workspaceInstructions, askUser]
                .filter(Boolean)
                .join("\n\n");
            this.hostTools = tools;
            // Restricted, meta-agent and maintenance sessions get only the
            // host prompt. Cloud cwd is not a user's project.
            const projectContext = process.env.MICHI_CLOUD !== '1' && this.toolProfile?.restricted !== true
                && !isMetaAgentProfile(this.toolProfile) && !isMaintenanceProfile(this.toolProfile) && !isAssistantProfile(this.toolProfile);
            this.agent = await this.createHarness(piAgentCore, {
                initialState: {
                    systemPrompt,
                    model,
                    tools,
                    thinkingLevel,
                    messages: this.collectSeed(),
                },
                streamFn: turnStreamFn,
                extensionUi: this.extensionUi,
                beforeToolCall: async (
                    bcCtx: { toolCall: { name: string }; args: unknown },
                    signal?: AbortSignal,
                ): Promise<{ block: boolean; reason?: string } | undefined> => {
                    signal?.throwIfAborted();
                    if (isAssistantProfile(this.toolProfile) && isMetaAgentProfile(this.toolProfile)) {
                        // The assistant's tools enforce their own approvals; nothing else exists.
                        return piAssistantToolDecision(bcCtx.toolCall.name) === "allow"
                            ? undefined
                            : { block: true, reason: "The Michi assistant does not edit files, run commands or use other tools" };
                    }
                    if (isMaintenanceProfile(this.toolProfile)) {
                        return this.activeMaintenanceExecutionContext && this.isToolAllowed(bcCtx.toolCall.name)
                            ? undefined
                            : { block: true, reason: 'This Pi session may run only dedicated maintenance tools.' };
                    }
                    if (!this.isToolAllowed(bcCtx.toolCall.name)) {
                        return { block: true, reason: "tool is not enabled for this Agent Run" };
                    }
                    // Only declares already-registered, already-filtered tools;
                    // each loaded tool's own call still goes through the policy.
                    if (bcCtx.toolCall.name === PI_TOOL_SEARCH_TOOL_NAME && this.mcpToolSearch) return undefined;
                    if (this.permissionBroker) {
                        const permission = this.permissionBroker.requestPermission({
                            owner: this.owner,
                            ownerUserId: this.ownerUserId,
                            workspaceId: this.workspaceId,
                            toolName: bcCtx.toolCall.name,
                            input: bcCtx.args,
                        });
                        const decision = signal ? await abortable(Promise.resolve(permission), signal) : await permission;
                        signal?.throwIfAborted();
                        if (decision === "deny") return { block: true, reason: "denied by Run permission policy" };
                        // The question is itself the interaction; do not ask permission to ask it.
                        if (decision !== "ask" || bcCtx.toolCall.name === PI_ASK_USER_TOOL) return undefined;
                        const answer = await this.requestPermission(bcCtx.toolCall.name, bcCtx.args, signal);
                        return answer?.startsWith("allow")
                            ? undefined
                            : { block: true, reason: "denied by Run permission policy" };
                    }
                    // Michi's user channel, like send_to_thread: no permission card in front of a question.
                    if (bcCtx.toolCall.name === PI_ASK_USER_TOOL) return undefined;
                    const policy = this.approvals.policy(this.owner, this.ownerUserId, bcCtx.toolCall.name, false, this.turnPermissionMode);
                    if (policy === "allow") return undefined;
                    if (policy === "deny") return { block: true, reason: "denied by policy" };
                    const decision = await this.requestPermission(bcCtx.toolCall.name, bcCtx.args, signal);
                    signal?.throwIfAborted();
                    if (!this.approvals.accept(decision, this.owner, bcCtx.toolCall.name, this.ownerUserId)) {
                        return { block: true, reason: "user denied" };
                    }
                    for (const [id, request] of this.pendingPermissions) {
                        if (request.explicit) continue;
                        if (approvalCoversTool(decision, bcCtx.toolCall.name, request.toolName)) this.respondToPermission(id, 'allow_once');
                    }
                    return undefined;
                },
                // A call cut off by Stop tells the model its outcome is unknown.
                // dispose() marks the session destroyed before it aborts, so a
                // restart or release is not reported as the user's Stop.
                afterToolCall: (context: { result: unknown; isError: boolean }, signal?: AbortSignal) =>
                    interruptedToolResult(context, signal, this.destroyed ? 'session' : 'user') ?? piToolResultErrorOverride(context),
            }, { projectContext });
        }

        // Model configuration and credentials can change between turns. Never
        // retain the first prompt's credential/model closure in a live session.
        this.agent.state.model = model;
        this.agent.state.thinkingLevel = thinkingLevel;
        this.agent.streamFunction = turnStreamFn;
        if (this.agent.configureAuth) await this.agent.configureAuth(model.provider, apiKey);
        return { model };
    }

    private async *runTurn(rawText: string, signal: AbortSignal, input?: AgentTurnInput): AsyncIterableIterator<NormalizedEvent> {
        const { model } = yield* this.prepareTurn(signal);

        const promptText = this.firstUserPrimed || !this.firstUserGlue
            ? rawText
            : `${this.firstUserGlue}\n\n${rawText}`;
        this.firstUserPrimed = true;


        const ctx: MapperContext = {
            cumulative: { inputTokens: 0, outputTokens: 0, totalCost: 0 },
            contextWindow: (model as any).contextWindow,
            runStartMs: Date.now(),
        };

        // Events always enter the queue; the reader is only woken. A Stop that
        // interrupts the wait therefore never drops an event already reported.
        const queue: NormalizedEvent[] = [];
        let wakeReader: (() => void) | undefined;
        let done = false;
        let terminated = false;
        const wake = () => {
            const resolve = wakeReader;
            wakeReader = undefined;
            resolve?.();
        };

        const push = (ev: NormalizedEvent) => {
            queue.push(ev);
            wake();
        };
        this.activePush = push;
        for (const notice of this.extensionNotices.splice(0)) push(notice);
        const finish = () => {
            terminated = true;
            done = true;
            wake();
        };

        const dump = openRawDump(this.id);
        dump.write("marker", `turn start ${new Date().toISOString()} model=${(model as any)?.id ?? "?"}`);
        const agent = this.agent;
        const unsubscribe = agent.subscribe((event: any) => {
            if (signal.aborted) return;
            if (event?.type === "message_update") {
                const e = event.assistantMessageEvent;
                if (e?.type === "text_delta") dump.write("chunk", e.delta ?? "");
                else if (e?.type === "thinking_delta") dump.write("thought", e.delta ?? "");
            }
            for (const out of mapAgentEvent(event, ctx)) {
                push(out);
            }
            if (event.type === "agent_end") {
                dump.write("marker", "turn end");
                finish();
            }
        });

        // Append follow-up reminder when conversation is long enough that the
        // model may have lost attention on system-prompt instructions.
        const userTurnCount = this.history.filter((m) => m.role === "user").length;
        // Attachments were previously dropped entirely: send() took no `input`
        // parameter at all, so images never reached pi-agent-core (which accepts
        // them natively) and non-image files were invisible. Images now go as
        // native blocks; everything else is named by path so the agent can open
        // it with Michi's read tool.
        const { images, promptNote } = prepareAttachments(input?.attachments);
        const imageBlocks = buildPiImageBlocks(images);
        const textWithReminder =
            maintenancePromptPrefix(input?.maintenanceContext)
            + (input?.memoryContext ? `${input.memoryContext}\n\n---\n\n` : '')
            + (input?.pageContext ? `${input.pageContext}\n\n---\n\n` : '')
            + promptText + promptNote + followUpReminder(userTurnCount, this.enableFollowUps);

        // Kick off the prompt; don't await it here — yield events as they arrive.
        signal.throwIfAborted();
        const onAbort = () => agent.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        const promptPromise = Promise.resolve().then(() => {
            signal.throwIfAborted();
            return imageBlocks.length > 0
                ? agent.prompt(textWithReminder, imageBlocks)
                : agent.prompt(textWithReminder);
        }).catch((err: unknown) => {
            // If agent_end already finished the turn, drop late rejections.
            if (terminated) return;
            // Provider/runtime threw before agent_end could fire. Surface as turn_end:error.
            const aborted = (err as any)?.name === "AbortError";
            push({ kind: "turn_end", stopReason: aborted ? undefined : "error" });
            finish();
        });
        this.inFlightPrompt = promptPromise;
        void promptPromise.finally(() => {
            if (this.inFlightPrompt === promptPromise) this.inFlightPrompt = undefined;
            if (this.recoveryWork === promptPromise) {
                this.recoveryError = undefined;
                this.recoveryWork = undefined;
            }
        });

        try {
            while (true) {
                if (signal.aborted) {
                    // Stop ends the turn, but what the SDK reported before it
                    // (a finished tool, its plan, the call now cut off) is part
                    // of this turn's record. The subscriber queues nothing after
                    // the abort, so flushing cannot leak into a later turn.
                    while (queue.length > 0) {
                        const ev = queue.shift()!;
                        yield ev;
                        if (ev.kind === "turn_end") return;
                    }
                    signal.throwIfAborted();
                }
                if (queue.length === 0) {
                    if (done) break;
                    try {
                        await abortable(new Promise<void>((resolve) => (wakeReader = resolve)), signal);
                    } catch (error) {
                        if (!signal.aborted) throw error;
                    }
                    continue;
                }
                const ev = queue.shift()!;
                yield ev;
                if (ev.kind === "turn_end") break;
                // Local tools complete in <1ms, so tool_execution_start and tool_execution_end
                // land in the same frame; this gap lets the frontend render the "pending" chip.
                if (ev.kind === "tool_call") await new Promise((r) => setTimeout(r, 16));
            }
        } finally {
            unsubscribe();
            if (!terminated) agent.abort();
            finish();
            dump.close();
            signal.removeEventListener('abort', onAbort);
            if (this.activePush === push) this.activePush = undefined;
            try {
                await withDeadline(promptPromise, 5_000, 'Pi task did not stop in time');
            } catch {
                if (this.inFlightPrompt === promptPromise) {
                    this.recoveryWork = promptPromise;
                    throw this.markUnavailable('Pi provider did not stop within 5 seconds.');
                }
            }
        }
    }

    /** Full SDK sessions override this seam; tools and host policy stay shared. */
    protected async createHarness(core: any, options: any, _features: PiSdkFeatures): Promise<any> {
        return new core.Agent(options);
    }

    /** agent-core declares every tool it holds; only the SDK has tool_search. */
    protected supportsToolSearch(): boolean { return false; }

    /**
     * Put MCP tools behind tool_search when the session supports it and the
     * catalog is large. Once on, it stays on for the session, so servers that
     * connect on a later turn do not flip the loadout back.
     */
    private applyMcpExposure(tools: any[]): any[] {
        if (!this.supportsToolSearch()) return tools;
        this.mcpToolSearch ||= shouldDeferMcpTools({
            tools, mode: process.env.MICHI_PI_TOOL_SEARCH, allowlisted: !!this.toolProfile?.allowedToolNames,
        });
        return this.mcpToolSearch ? deferMcpTools(tools) : tools;
    }

    private isToolAllowed(toolName: string): boolean {
        const allowed = this.toolProfile?.allowedToolNames;
        return !allowed || allowed.includes(toolName);
    }

    /**
     * Build a permission_request event, push it onto the active turn's
     * queue, and await the user's decision (or 5-min timeout). Returns
     * the chosen optionId or null on timeout/abort/cancel.
     *
     * Called from beforeToolCall when policy === "ask". Honors the
     * pi-agent-core abort signal so cancelling a turn unblocks the
     * blocked tool call.
     */
    private async requestPermission(
        toolName: string,
        args: unknown,
        signal: AbortSignal | undefined,
        explicit?: { title: string; detail?: string; options: PermissionOption[] },
    ): Promise<string | null> {
        if (!this.activePush || signal?.aborted) return null;
        const requestId = this.nextRequestId++;
        const options: PermissionOption[] = explicit?.options ?? (!isRunOwner(this.owner) ? chatApprovalOptions(toolName) : [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject_once", name: "Deny", kind: "reject_once" },
        ]);
        const title = explicit?.title ?? formatPermissionTitle(toolName, args);

        return new Promise<string | null>((resolve) => {
            const timer = setTimeout(() => {
                this.pendingPermissions.delete(requestId);
                resolve(null);
            }, 5 * 60 * 1000);
            this.pendingPermissions.set(requestId, { resolve, timer, toolName, ...(explicit ? { explicit: true } : {}) });

            signal?.addEventListener(
                "abort",
                () => {
                    const entry = this.pendingPermissions.get(requestId);
                    if (!entry) return;
                    clearTimeout(entry.timer);
                    this.pendingPermissions.delete(requestId);
                    resolve(null);
                },
                { once: true },
            );

            this.activePush!({
                kind: "permission_request",
                requestId,
                title,
                ...(explicit?.detail ? { detail: explicit.detail } : {}),
                options,
                source: "michi_policy",
            });
        });
    }

    /**
     * send_to_thread's optional, explicitly requested approval. Independent of the chat's
     * permission mode and grants: only an explicit "allow_once" approves, and
     * no grant or session trust is recorded.
     */
    private async requestThreadMessageApproval(
        request: ThreadMessageApprovalRequest,
        signal: AbortSignal | undefined,
    ): Promise<ThreadMessageApprovalResult> {
        const { title, detail } = threadMessageApprovalTitle(request);
        const answer = await this.requestPermission(SEND_TO_THREAD_TOOL, request, signal, {
            title,
            detail,
            options: [
                { optionId: "reject_once", name: "Don't send", kind: "reject_once" },
                { optionId: "allow_once", name: "Send", kind: "allow_once" },
            ],
        });
        if (answer === "allow_once") return { approved: true };
        return { approved: false, reason: answer === null ? "no_answer" : "declined" };
    }

    /**
     * A scheduled job change's own approval. Like send_to_thread it ignores
     * the chat's permission mode and grants: only "allow_once" approves.
     */
    private async requestScheduledJobApproval(
        request: ScheduledJobApprovalRequest,
        signal: AbortSignal | undefined,
    ): Promise<ScheduledJobApprovalResult> {
        const { title, detail } = scheduledJobApprovalPrompt(request);
        const answer = await this.requestPermission(request.toolName, request, signal, {
            title,
            detail,
            options: [
                { optionId: "reject_once", name: "Cancel", kind: "reject_once" },
                { optionId: "allow_once", name: request.approveLabel, kind: "allow_once" },
            ],
        });
        if (answer === "allow_once") return { approved: true };
        return { approved: false, reason: answer === null ? "no_answer" : "declined" };
    }

    respondToPermission(requestId: number, optionId: string): void {
        if (isRunOwner(this.owner) && optionId === 'allow_session') throw new Error('Invalid permission option');
        if (optionId !== 'allow_once' && optionId !== 'allow_always' && optionId !== 'allow_session' && optionId !== 'reject_once') throw new Error('Invalid permission option');
        const entry = this.pendingPermissions.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pendingPermissions.delete(requestId);
        entry.resolve(optionId);
    }

    cancelPermission(requestId: number): void {
        const entry = this.pendingPermissions.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pendingPermissions.delete(requestId);
        entry.resolve(null);
    }

    /**
     * ask_user's channel: push user_input_request onto the active turn and wait
     * for respondToUserInput / skipUserInput, the timeout, or the turn stopping.
     * ChatHub keeps the request pending for replay, so a refreshed renderer can
     * still answer it while this session waits. `dismiss` (a Pi extension's
     * own signal or timeout) withdraws the question like a skip while the turn
     * goes on.
     */
    private async requestUserInput(questions: UserInputQuestion[], signal?: AbortSignal, dismiss?: AbortSignal): Promise<UserInputAnswer[] | null> {
        const push = this.activePush;
        const turn = this.turnAbort?.signal;
        if (!push || !turn || turn.aborted || signal?.aborted || dismiss?.aborted) return null;
        let release!: () => void;
        const mine = new Promise<void>((resolve) => { release = resolve; });
        const previous = this.userInputGate;
        this.userInputGate = previous.then(() => mine);
        try {
            const stopped = AbortSignal.any([turn, ...(signal ? [signal] : []), ...(dismiss ? [dismiss] : [])]);
            await abortable(previous, stopped).catch(() => {});
            if (stopped.aborted || this.activePush !== push) return null;
            const requestId = nextUserInputRequestId();
            const answers = await new Promise<UserInputAnswer[] | null>((resolve) => {
                const stop = () => this.skipUserInput(requestId);
                const finish = (value: UserInputAnswer[] | null) => {
                    stopped.removeEventListener('abort', stop);
                    resolve(value);
                };
                const timer = setTimeout(() => {
                    this.pendingUserInputs.delete(requestId);
                    finish(null);
                }, userInputTimeoutMs());
                this.pendingUserInputs.set(requestId, { resolve: finish, timer });
                stopped.addEventListener('abort', stop, { once: true });
                push({ kind: 'user_input_request', requestId, questions });
            });
            // A cancelled turn ends without resuming the model; ChatHub closes the card.
            if (turn.aborted || signal?.aborted) return null;
            // Timeouts have no route receipt; record the outcome for every path.
            if (this.activePush === push) {
                push({ kind: 'user_input_resolved', requestId, answers: answers ?? [], outcome: answers ? 'answered' : 'skipped' });
            }
            return answers;
        } finally {
            release();
        }
    }

    respondToUserInput(requestId: number, answers: UserInputAnswer[]): void {
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

    /**
     * Manual compaction between turns through the harness's native compact().
     * The Agent is prepared exactly as for a turn (current model, credentials,
     * tools), and built first if this session has not run a turn yet. It
     * resolves on completion, so the result reports `completed`. The SDK's
     * compact() aborts a running turn, so a busy session declines instead.
     */
    protected async compactBetweenTurns(instructions?: string): Promise<CompactResult> {
        if (this.recoveryError) return { started: false, detail: this.recoveryError.message };
        if (this.destroyed) return { started: false, detail: 'This Pi session has been closed.' };
        if (this.compaction) return { started: false, detail: 'Pi is already compacting this conversation.' };
        if (this.turnAbort || this.inFlightPrompt || this.mcpInitialization || this.mcpCleanup) {
            return { started: false, detail: 'Pi is still working on this conversation. Run /compact again after the current turn finishes.' };
        }
        const controller = new AbortController();
        const work = (async () => {
            const setup = this.prepareTurn(controller.signal);
            // Setup warnings belong to the next turn's stream.
            for (let step = await setup.next(); !step.done; step = await setup.next()) this.mcpWarnings.push(step.value);
            controller.signal.throwIfAborted();
            if (typeof this.agent?.compact !== 'function') throw new Error('This Pi engine cannot compact.');
            return this.agent.compact(instructions?.trim() || undefined);
        })();
        this.compaction = { controller, work };
        try {
            return { started: true, completed: true, detail: describeCompaction(await work) };
        } catch (error) {
            if (controller.signal.aborted) return { started: false, detail: 'Compaction was cancelled.' };
            const message = error instanceof Error ? error.message : String(error);
            return { started: false, detail: message.startsWith('Compaction') ? message : `Compaction failed: ${message}` };
        } finally {
            if (this.compaction?.work === work) this.compaction = undefined;
        }
    }

    private collectSeed(): MinimalAgentMessage[] {
        // Reconstruct seed messages from this.history. The constructor already
        // primed history from initialMessages; on first turn we project that
        // history back into Agent message shape.
        const out: MinimalAgentMessage[] = [];
        for (const m of this.history) {
            if (m.role === "user") {
                out.push({
                    role: "user",
                    content: [{ type: "text", text: m.content }],
                    timestamp: Date.now(),
                });
            } else if (m.role === "assistant") {
                out.push({
                    role: "assistant",
                    content: [{ type: "text", text: m.content }],
                    api: "rehydrated",
                    provider: "rehydrated",
                    model: "rehydrated",
                    usage: {
                        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                    stopReason: "stop",
                    timestamp: Date.now(),
                });
            }
        }
        // Drop the most recent user entry — runTurn will add it via prompt(). Otherwise it
        // would appear twice.
        if (out.length > 0 && out[out.length - 1].role === "user") {
            out.pop();
        }
        return out;
    }

    /**
     * pi-agent-core's own steering primitive: the message is queued onto the
     * running Agent and injected once the current assistant turn finishes,
     * inside the *same* agent run. Michi held this Agent instance all along and
     * simply never called it — steering fell through to the frontend's
     * next-turn queue, which instead ends the run and starts a fresh Michi turn.
     *
     * `pending: true` because delivery happens at the next turn boundary rather
     * than mid-token, which is what the composer needs in order to keep showing
     * the text as queued until the agent picks it up.
     */
    async steer(text: string): Promise<SteerResult> {
        const trimmed = text.trim();
        if (!trimmed) return { accepted: false, reason: "empty" };
        if (this.destroyed) return { accepted: false, reason: "destroyed" };
        if (!this.agent || !this.turnAbort) return { accepted: false, reason: "not_in_turn" };
        try {
            await this.agent.steer({
                role: "user",
                content: [{ type: "text", text: trimmed }],
                timestamp: Date.now(),
            });
        } catch (error) {
            return { accepted: false, reason: (error as Error).message || "steer_failed" };
        }
        return { accepted: true, pending: true };
    }

    cancel(): CancelAck {
        const acknowledged = !!this.turnAbort || !!this.agent || !!this.compaction;
        this.turnAbort?.abort();
        this.compaction?.controller.abort();
        if (this.mcpInitialization) void this.disposeMcpManager().catch(() => {});
        try {
            this.agent?.abort();
        } catch {
            /* ignore */
        }
        // In-process abort on the Agent we own — native, not a proxy signal.
        return {
            acknowledged,
            source: 'native',
            confidence: 'native',
            nativeMethod: 'Agent.abort',
        };
    }

    destroy(): void { void this.dispose().catch(() => {}); }

    assertAvailable(): void {
        if (this.recoveryError) throw this.recoveryError;
        if (this.destroyed) throw Object.assign(new Error('Pi session has been disposed'), { code: 'PI_SESSION_DISPOSED' });
    }

    /** Await native prompt/MCP retirement before the public id may be reused. */
    async dispose(): Promise<void> {
        this.destroyed = true;
        this.cancel();
        for (const [, entry] of this.pendingPermissions) {
            clearTimeout(entry.timer);
            entry.resolve(null);
        }
        this.pendingPermissions.clear();
        for (const [, entry] of this.pendingUserInputs) {
            clearTimeout(entry.timer);
            entry.resolve(null);
        }
        this.pendingUserInputs.clear();
        try {
            await withDeadline(Promise.all([
                this.inFlightPrompt,
                this.compaction?.work.catch(() => {}),
                this.mcpInitialization?.catch(() => {}),
                this.disposeMcpManager(),
            ]), 5_000, 'Pi resources did not stop in time');
        } catch { throw this.markUnavailable('Pi resources could not be stopped within 5 seconds.'); }
        await withDeadline(Promise.resolve(this.agent?.dispose?.()), 5_000, 'Pi SDK shutdown timed out');
        this.agent = undefined;
    }

    private markUnavailable(reason: string): Error {
        this.recoveryError = Object.assign(new Error(
            `${reason} This Pi session is unavailable; its history and ownership are retained. ` +
            'No overlapping work will be started. Retry after cleanup finishes; if it remains unavailable, restart the backend before retrying.',
        ), { code: 'PI_SESSION_UNAVAILABLE' });
        return this.recoveryError;
    }

    private disposeMcpManager(): Promise<void> {
        if (this.mcpCleanup) return this.mcpCleanup;
        const manager = this.mcpManager;
        if (!manager) return Promise.resolve();
        const work = withDeadline(Promise.resolve().then(() => manager.dispose()), 5_000, 'Pi MCP cleanup timed out')
            .then(() => {
                if (this.mcpManager === manager) {
                    this.mcpManager = undefined;
                    this.mcpInitialized = false;
                }
                if (this.mcpCleanup === work) this.mcpCleanup = undefined;
            }, () => { throw this.markUnavailable('Pi MCP resources could not be stopped within 5 seconds.'); });
        this.mcpCleanup = work;
        return work;
    }

    /**
     * Lazily connect to configured MCP servers and convert their tools into
     * Pi-compatible AgentTool entries.
     *
     * Subsequent turns reuse connected servers and retry failed setup.
     *
     * Errors are non-fatal: a failed MCP connection emits a setup warning but does
     * not prevent the session from running (with built-in tools only).
     */
    private initMcpTools(Type: any, signal: AbortSignal): Promise<any[]> {
        if (this.mcpInitialization) return this.mcpInitialization;
        const work = this.connectMcpTools(Type, signal);
        this.mcpInitialization = work;
        const clear = () => { if (this.mcpInitialization === work) this.mcpInitialization = undefined; };
        void work.then(clear, clear);
        return work;
    }

    private async connectMcpTools(Type: any, signal: AbortSignal): Promise<any[]> {
        if (this.mcpInitialized) {
            return this.mcpManager ? buildMcpToolsForPi({ mcpManager: this.mcpManager, Type }) : [];
        }

        // These are process-global desktop configs. A cloud session must not
        // inherit another user's commands, environment.
        // Until per-owner config exists, fail closed with an actionable warning.
        if (process.env.MICHI_CLOUD === '1') {
            this.mcpWarnings.push({ kind: 'warning', source: 'mcp', category: 'setup',
                code: 'MCP_CLOUD_CONFIG_UNAVAILABLE',
                message: 'External Pi MCP servers require per-user configuration in cloud mode and were not loaded.' });
            this.mcpInitialized = true;
            return [];
        }

        let configs: ReturnType<typeof readPiMcpServers>;
        try { configs = readPiMcpServers(); }
        catch (error) {
            this.mcpWarnings.push({ kind: 'warning', source: 'mcp', category: 'setup',
                code: 'MCP_CONFIG_INVALID', message: (error as Error).message });
            return this.mcpManager ? buildMcpToolsForPi({ mcpManager: this.mcpManager, Type }) : [];
        }
        if (configs.length === 0) {
            this.mcpInitialized = true;
            return [];
        }

        signal.throwIfAborted();
        const manager = this.mcpManager ?? new McpClientManager({ ownerUserId: this.ownerUserId });
        this.mcpManager = manager;
        let failed = false;
        try {
            for (const cfg of configs) {
                signal.throwIfAborted();
                if (manager.connectedServers().includes(cfg.serverName)) continue;
                try {
                    await abortable(manager.connect({ ...cfg, cwd: cfg.cwd ?? this.cwd }, signal), signal);
                } catch (err) {
                    signal.throwIfAborted();
                    if ((err as { code?: string }).code === 'MCP_CLEANUP_TIMEOUT') throw err;
                    failed = true;
                    this.mcpWarnings.push({ kind: 'warning', source: 'mcp', category: 'setup',
                        serverName: cfg.serverName, message: (err as Error).message });
                }
            }
            signal.throwIfAborted();
            if (manager.connectedServers().length === 0) {
                await this.disposeMcpManager();
                this.mcpInitialized = !failed;
                return [];
            }
            this.mcpInitialized = !failed;
            return buildMcpToolsForPi({ mcpManager: manager, Type });
        } catch (error) {
            await this.disposeMcpManager();
            throw error;
        }
    }
}

/**
 * Model-fallback wrapper that returns a real AssistantMessageEventStream
 * (has both `[Symbol.asyncIterator]` AND `.result()`), satisfying
 * pi-agent-core's `StreamFn` contract.
 *
 * Pattern: synchronously return an outer EventStream, drive it from an
 * async IIFE — identical to pi-ai's own faux/lazyStream pattern.
 */
export function streamSimpleWithFallback(
    piMod: any,
    upstreamProvider: string,
    models: any[],
    context: any,
    options: any,
    /** Bedrock: an auth error before any output refreshes credentials and retries the same model once. */
    authRetry?: { isAuthError(ev: any): boolean; refresh(): Promise<boolean> },
): any /* AssistantMessageEventStream */ {
    const outer = piMod.createAssistantMessageEventStream();
    const attempts = models.length > 0 ? models : [undefined];
    let authRetried = false;
    const fail = (error: unknown, modelId = '') => {
        const aborted = options?.signal?.aborted || (error as { name?: string })?.name === 'AbortError';
        outer.push({
            type: 'error',
            reason: aborted ? 'aborted' : 'error',
            error: {
                role: 'assistant', content: [], api: '', provider: upstreamProvider, model: modelId,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: aborted ? 'aborted' : 'error',
                errorMessage: error instanceof Error ? error.message : String(error),
                timestamp: Date.now(),
            },
        });
    };

    void (async () => {
        let lastError: any;

        for (let i = 0; i < attempts.length; i += 1) {
            const model = attempts[i];
            const modelId = model?.id;
            let yieldedAny = false;
            let retrySameModel = false;

            try {
                options?.signal?.throwIfAborted();
                const inner = piMod.streamSimple(model, context, options);
                let terminalSeen = false;
                for await (const ev of inner) {
                    if (ev?.type === 'error' && (options?.signal?.aborted || ev.reason === 'aborted' || ev.error?.stopReason === 'aborted')) {
                        outer.push({ ...ev, reason: 'aborted', error: { ...ev.error, stopReason: 'aborted' } });
                        return;
                    }
                    if (ev?.type === 'error' && !yieldedAny && authRetry && !authRetried && authRetry.isAuthError(ev)) {
                        authRetried = true;
                        const refresh = authRetry.refresh();
                        retrySameModel = options?.signal ? await abortable(refresh, options.signal) : await refresh;
                        if (retrySameModel) break;
                    }
                    // Still no output + error + more models to try → switch
                    if (ev?.type === "error" && !yieldedAny && i < attempts.length - 1) {
                        lastError = ev;
                        break;
                    }
                    yieldedAny = true;
                    outer.push(ev);
                    terminalSeen ||= ev?.type === 'done' || ev?.type === 'error';
                    // push of done/error event auto-resolves outer.result()
                }
                if (retrySameModel) {
                    i -= 1;
                    continue;
                }
                if (terminalSeen) return;
                if (yieldedAny) throw new Error('Pi provider stream ended without a terminal event');
            } catch (err) {
                if (options?.signal?.aborted || (err as { name?: string })?.name === 'AbortError' || yieldedAny || i === attempts.length - 1) {
                    fail(err, modelId);
                    return;
                }
                lastError = err;
            }
        }

        // All attempts exhausted without yielding any content
        if (lastError && typeof lastError === "object" && "type" in lastError) {
            outer.push(lastError);
        } else {
            fail(lastError ?? new Error('All model attempts failed'));
        }
    })().catch((error) => fail(error));

    return outer;
}

/**
 * Build the permission banner title. Phrased as a question so the
 * frontend can render it verbatim without prefixing "Allow X to ...".
 * Each ask-class tool gets a tailored phrasing.
 */
function formatPermissionTitle(toolName: string, args: unknown): string {
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    const path = typeof a.path === "string" ? a.path : "";
    const command = typeof a.command === "string" ? a.command : "";
    const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

    switch (toolName) {
        case "write":
            return path ? `Write to ${truncate(path, 80)}?` : "Write a file?";
        case "edit":
            return path ? `Edit ${truncate(path, 80)}?` : "Edit a file?";
        case "bash":
            return command ? `Run: ${truncate(command, 100)}` : "Run a shell command?";
        default: {
            // Fallback for any future ask-class tool.
            const summary = path || command || "";
            return summary ? `${toolName}: ${truncate(summary, 80)}` : `Run ${toolName}?`;
        }
    }
}
