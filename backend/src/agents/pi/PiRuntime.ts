import { assertReleaseOwnership } from '../runs/runtimeRunAdapter';
import { randomUUID } from "crypto";
import type { RuntimeDescriptor } from "michi-runtime/internal/contract/descriptor";
import { PI_RUNTIME_DESCRIPTOR, PI_CORE_RUNTIME_DESCRIPTOR } from "./piDescriptor";
import type {
    AgentCapabilities,
    AgentProviderInfo,
    AgentRuntimeWithProviders,
    AgentSession,
    LoadAgentSessionOptions,
    ModelInfo,
    NewAgentSessionOptions,
    RuntimeSessionOwner,
    VerifyProviderKeyOptions,
    VerifyProviderKeyResult,
} from "../types";
import type { AgentToolBridge } from "../toolBridge";
import { sameOwner } from "../types";
import { chatNodeOf, chatOwner, isRunOwner } from "../ownerMapping";
import type { PlanEntry } from "michi-shared";
import { PendingSessionAcquisitions } from "../sessionAcquisition";
import { PiSession, type PiSessionDeps } from "./PiSession";
import { isMetaAgentProfile } from "../metaAgentGuard";
import { createPiSession, selectPiSessionKind, shouldNavigatePiTreeOnMichiBranch } from "./PiSdkSession";
import * as sessionRegistry from "../sessionRegistry";
import { buildPreamble, buildFormatReminder } from "../preamble";
import { isAssistantProfile } from "../../assistant/policy";
import { isMaintenanceProfile } from '../maintenancePolicy';
import { renderBranchContext } from "../../services/branchBoundary";
import {
    listPiModels,
    listProviderInfos,
    selectDefaultModelId,
    verifyPiProviderKey,
} from "./piProviders";
import { getRuntimeDeps } from "../runtimeDeps";
import { rowsToAgentMessages } from "./historyAdapter";

/**
 * AgentRuntime adapter for the @earendil-works/pi-ai package.
 *
 * Capabilities:
 *   - providerModels=true (a single binary catalog of providers/models is
 *     advertised; the active one is read from agentConfig)
 *   - reasoning=true / apiKeys=true / saveContext=true / spawnBranches=true
 *     (saveContext covers both save_artifact and update_artifact tools)
 *   - modes=false / permissions=true / warmSessions=false
 *
 * Pi uses a scoped SDK transcript per Michi session. SQLite remains the
 * authoritative host history; a native checkpoint must match before recovery.
 * MICHI_PI_SESSION_SDK=0 selects the agent-core rollback engine.
 *
 * Provider env bindings are registered with secrets.ts by runtimeFactories,
 * not by this class — keeps registration symmetric across runtimes.
 */
export interface PiRuntimeSdkOptions {
    /** Trusted host factories only; resolved separately for every owner scope. */
    extensionFactories?: (scope: {
        sessionId: string; owner: RuntimeSessionOwner; ownerUserId: string | null;
        workspaceId: string | null;
    }) => PiSessionDeps['sdkExtensionFactories'];
}

export class PiRuntime implements AgentRuntimeWithProviders {
    public readonly id = "pi" as const;
    public readonly label = "Pi (multi-provider)";
    public readonly capabilities: AgentCapabilities = {
        modes: false,
        permissions: true,
        models: true,
        providerModels: true,
        reasoning: true,
        supportedReasoningLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        apiKeys: true,
        warmSessions: false,
        saveContext: true,
        spawnBranches: true,
        // Public bindings use Michi ids and loadSession. Native restoration is
        // an internal checkpointed optimization, not a separate resume-token API.
        nativeResume: false,
    };
    public get descriptor(): RuntimeDescriptor {
        return selectPiSessionKind() === 'sdk' ? PI_RUNTIME_DESCRIPTOR : PI_CORE_RUNTIME_DESCRIPTOR;
    }

    private readonly acquisitions = new PendingSessionAcquisitions<AgentSession>();
    private sessions = new Map<string, AgentSession & { destroy(): void; dispose?(): Promise<void> }>();

    constructor(private readonly bridge: AgentToolBridge, private readonly sdkOptions: PiRuntimeSdkOptions = {}) {}

    private extensionsFor(id: string, owner: RuntimeSessionOwner, opts: NewAgentSessionOptions | LoadAgentSessionOptions): PiSessionDeps['sdkExtensionFactories'] {
        if (isMetaAgentProfile(opts.toolProfile)) return [];
        return this.sdkOptions.extensionFactories?.({ sessionId: id, owner,
            ownerUserId: opts.ownerUserId ?? null, workspaceId: opts.workspaceId ?? null });
    }

    async warm(_cwd: string): Promise<void> {
        // No-op — Pi has no expensive process to spawn.
    }

    async newSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
        const owner = resolveSessionOwner(opts.owner, opts.sessionId);
        const id = publicSessionId(owner, opts.sessionId);
        return this.acquisitions.acquire(id, () => this.createSession({ ...opts, owner, sessionId: id }), (session) => {
            assertCompatibleSession(session, owner, opts.profileHash ?? null);
            if ((session as PiSession).getOwnerUserId && (session as PiSession).getOwnerUserId() !== (opts.ownerUserId ?? null)) throw new Error('session user owner mismatch');
            return session;
        });
    }

    private async createSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
        // Adopt the caller-supplied id when present so chatId === nodeId
        // (Pi runtime convention; Kiro must server-mint per ACP). When
        // absent (legacy callers), fall back to a UUID.
        const owner = resolveSessionOwner(opts.owner, opts.sessionId);
        const id = publicSessionId(owner, opts.sessionId);
        const existing = this.sessions.get(id);
        if (existing) {
            assertCompatibleSession(existing, owner, opts.profileHash ?? null);
            return existing;
        }
        const enableFollowUps = opts.enableFollowUps !== false
            && !isAssistantProfile(opts.toolProfile)
            && !isMaintenanceProfile(opts.toolProfile);

        // Walk the parent's chain (parent's own ancestors + parent itself).
        // Lazy-load any session whose getHistory() is empty — this covers the
        // cold path where the user branches from a parent that hasn't been
        // re-opened since backend restart.
        const ancestorChain: AgentSession[] = [];
        if (!opts.branchContext && !isRunOwner(owner) && opts.parentChatId) {
            sessionRegistry.ensureAncestorChainLoaded(opts.parentChatId);
            const parent = sessionRegistry.getSession(opts.parentChatId);
            if (parent) {
                ancestorChain.push(...sessionRegistry.getAncestors(opts.parentChatId), parent);
            }
        }

        const branchContextText = opts.branchContext
            ? renderBranchContext(opts.branchContext)
            : null;
        const preamble = buildPreamble({
            enableFollowUps,
            // The assistant gets its own short tool note, not the ordinary chat tools.
            ...(isAssistantProfile(opts.toolProfile) ? { toolCapabilities: "assistant" as const } : {}),
            ...(isMaintenanceProfile(opts.toolProfile) ? { toolCapabilities: "maintenance" as const } : {}),
            cwd: opts.cwd,
            contextManifest: opts.contextManifest,
            extraContexts: opts.extraContexts,
            ancestors: ancestorChain,
            mergeContexts: [
                ...(branchContextText ? [branchContextText] : []),
                ...(opts.mergeContexts ?? []),
            ],
        });
        const effectivePreamble = [preamble, opts.bootstrapInstructions].filter(Boolean).join("\n\n");
        const initialMessages = opts.replayHistory
            ? rowsToAgentMessages(opts.replayHistory.map((message) => ({
                role: message.role,
                content: message.content,
                created_at: Date.now(),
            })))
            : undefined;

        void shouldNavigatePiTreeOnMichiBranch();
        const sessionDeps = {
            bridge: this.bridge,
            sdkExtensionFactories: this.extensionsFor(id, owner, opts),
            cwd: opts.cwd,
            enableFollowUps,
            preamble: effectivePreamble,
            firstUserGlue: isAssistantProfile(opts.toolProfile) ? "" : buildFormatReminder(enableFollowUps),
            parentChatId: isRunOwner(owner) ? undefined : opts.parentChatId,
            workspaceId: opts.workspaceId ?? null,
            ownerUserId: opts.ownerUserId ?? null,
            owner,
            profileHash: opts.profileHash ?? null,
            toolProfile: opts.toolProfile,
            permissionBroker: opts.permissionBroker,
            requestedProvider: opts.provider ?? null,
            requestedModel: opts.model ?? null,
            requestedReasoning: opts.reasoning ?? null,
            initialMessages,
            restoreNative: opts.replayHistory !== undefined,
            initialPlan: initialPlanFor(owner, opts, opts.branchContext),
        };
        const session = await createPiSession(id, sessionDeps);
        this.sessions.set(id, session as AgentSession & { destroy(): void; dispose?(): Promise<void> });
        sessionRegistry.registerSession(session, opts.ownerUserId ?? null, owner);
        return session;
    }

    /**
     * Rehydrate a Pi session by reading the node's prior messages from SQLite
     * and seeding them into a fresh PiSession. Tool calls / thinking blocks
     * are not persisted, so the rehydrated transcript is text-only — the
     * model can still continue the conversation, but won't see prior
     * spawn_branches / save_artifact calls in its context.
     *
     * chatId === nodeId for Pi, so opts.sessionId is the row id for both
     * the nodes lookup (parent chain) and the messages lookup (history).
     *
     * The systemPrompt is rebuilt here too — the preamble (role identity,
     * TITLE/FOLLOW-UP sentinel rules, ancestor chain) lives in pi-agent-core's
     * systemPrompt slot, so a reloaded session needs it reconstructed or every
     * resumed turn loses that guidance. ContextManifest / extraContexts /
     * mergeContexts aren't persisted; rehydrated user messages still carry
     * whatever the original turn had glued in.
     */
    async loadSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
        const owner = resolveSessionOwner(opts.owner, opts.sessionId);
        return this.acquisitions.acquire(opts.sessionId, () => this.restoreSession(opts), (session) => {
            assertCompatibleSession(session, owner, opts.profileHash ?? null);
            if ((session as PiSession).getOwnerUserId && (session as PiSession).getOwnerUserId() !== (opts.ownerUserId ?? null)) throw new Error('session user owner mismatch');
            return session;
        });
    }

    private async restoreSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
        const owner = resolveSessionOwner(opts.owner, opts.sessionId);
        const existing = this.sessions.get(opts.sessionId);
        if (existing) {
            assertCompatibleSession(existing, owner, opts.profileHash ?? null);
            return existing;
        }
        let initialMessages: ReturnType<typeof rowsToAgentMessages> = [];
        let parentChatId: string | undefined;
        // Caller-supplied workspaceId wins — covers the cold-start window where the
        // node row hasn't been synced from the frontend yet.
        let workspaceId: string | null = opts.workspaceId ?? null;
        if (isRunOwner(owner)) {
            initialMessages = rowsToAgentMessages((opts.replayHistory ?? []).map((message) => ({
                role: message.role,
                content: message.content,
                created_at: Date.now(),
            })));
        } else try {
            const row = getRuntimeDeps().historyStore.getNode(opts.sessionId);
            parentChatId = row?.parent_node_id ?? undefined;
            if (!workspaceId) workspaceId = row?.workspace_id ?? null;
            const rows = getRuntimeDeps().historyStore.listMessages(opts.sessionId);
            initialMessages = rowsToAgentMessages(rows);
        } catch (err) {
            throw Object.assign(new Error('Pi history could not be restored; original history was retained. Please retry.'), { cause: err });
        }

        const ancestorChain: AgentSession[] = [];
        if (parentChatId) {
            sessionRegistry.ensureAncestorChainLoaded(parentChatId);
            const parent = sessionRegistry.getSession(parentChatId);
            if (parent) {
                ancestorChain.push(...sessionRegistry.getAncestors(parentChatId), parent);
            }
        }

        const enableFollowUps = opts.enableFollowUps !== false
            && !isAssistantProfile(opts.toolProfile)
            && !isMaintenanceProfile(opts.toolProfile);
        const preamble = buildPreamble({
            enableFollowUps,
            ...(isAssistantProfile(opts.toolProfile) ? { toolCapabilities: "assistant" as const } : {}),
            ...(isMaintenanceProfile(opts.toolProfile) ? { toolCapabilities: "maintenance" as const } : {}),
            cwd: opts.cwd,
            ancestors: ancestorChain,
        });
        const effectivePreamble = [preamble, opts.bootstrapInstructions].filter(Boolean).join("\n\n");

        const sessionDeps = {
            bridge: this.bridge,
            sdkExtensionFactories: this.extensionsFor(opts.sessionId, owner, { ...opts, workspaceId }),
            cwd: opts.cwd,
            enableFollowUps,
            preamble: effectivePreamble,
            initialMessages,
            parentChatId,
            workspaceId,
            ownerUserId: opts.ownerUserId ?? null,
            owner,
            profileHash: opts.profileHash ?? null,
            toolProfile: opts.toolProfile,
            permissionBroker: opts.permissionBroker,
            requestedProvider: opts.provider ?? null,
            requestedModel: opts.model ?? null,
            requestedReasoning: opts.reasoning ?? null,
            initialPlan: initialPlanFor(owner, opts),
        };
        const session = await createPiSession(opts.sessionId, { ...sessionDeps, restoreNative: true });
        this.sessions.set(opts.sessionId, session as AgentSession & { destroy(): void; dispose?(): Promise<void> });
        sessionRegistry.registerSession(session, opts.ownerUserId ?? null, owner);
        return session;
    }

    async listModels(opts?: { provider?: string }): Promise<ModelInfo[]> {
        const cfg = getRuntimeDeps().agentConfig.getAgentConfig();
        const provider = opts?.provider ?? cfg.provider;
        try {
            const models = await listPiModels(provider);
            return models.map((m) => ({
                id: m.model_id,
                label: m.model_name,
                description: m.description,
                supportsReasoning: m.supportsReasoning,
                supportedReasoningLevels: m.supportedReasoningLevels,
                defaultReasoning: m.defaultReasoning,
            }));
        } catch (err) {
            console.warn(`[piRuntime] listPiModels(${provider}) failed:`, err);
            return [];
        }
    }

    /** Used by /api/agent/status to surface the multi-provider catalog. */
    async listProviders(): Promise<AgentProviderInfo[]> {
        return listProviderInfos().map((p) => ({
            id: p.id,
            label: p.name,
            keyLabel: p.apiKeyLabel,
            envVars: p.envVars,
            // The UI selects this entry in the model picker, so it has to name
            // the model users actually get (the floating alias when there is one).
            defaultModel: selectDefaultModelId(p),
            keyUrl: p.keyUrl,
            supportsReasoning: p.supportsReasoning,
            requiresUserKey: p.requiresUserKey,
            modelLocked: p.modelLocked,
        }));
    }

    /**
     * Used by /api/agent/provider-key/verify. Falls back to the disk-stored
     * key when the body omits one (e.g. a "verify the key I just saved" flow).
     */
    async verifyProviderKey(body: VerifyProviderKeyOptions): Promise<VerifyProviderKeyResult> {
        const cfg = getRuntimeDeps().agentConfig.getAgentConfig();
        const provider = body.provider ?? cfg.provider;
        const apiKey = body.key ?? getRuntimeDeps().providerKeys.getProviderApiKey(provider) ?? undefined;
        return verifyPiProviderKey({ provider, key: apiKey, model: body.model });
    }

    /** Compatibility alias; release must await provider/MCP retirement. */
    dropSession(id: string): Promise<void> { return this.releaseSession(id); }

    async releaseSession(id: string, expectedOwner?: RuntimeSessionOwner): Promise<void> {
        return this.acquisitions.release(id, () => this.disposeSession(id, expectedOwner));
    }

    private async disposeSession(id: string, expectedOwner?: RuntimeSessionOwner): Promise<void> {
        const session = this.sessions.get(id);
        const actualOwner = session?.owner ?? (session ? chatOwner(session.id) : undefined);
        if (expectedOwner && actualOwner) assertReleaseOwnership(actualOwner, expectedOwner);
        if (session?.dispose) await session.dispose();
        else session?.destroy();
        if (this.sessions.get(id) === session) this.sessions.delete(id);
        sessionRegistry.dropSession(id);
    }

    async shutdown(): Promise<void> {
        await Promise.allSettled([...this.acquisitions.values()]);
        await Promise.allSettled([...this.sessions.keys()].map((id) => this.releaseSession(id)));
    }
}

/**
 * The persisted plan a chat session's todo list starts from. Only ordinary
 * chats get the todo tool; Runs, the assistant and maintenance start empty.
 * A lookup failure starts empty rather than failing the session.
 */
function initialPlanFor(
    owner: RuntimeSessionOwner,
    opts: NewAgentSessionOptions | LoadAgentSessionOptions,
    branch?: NewAgentSessionOptions['branchContext'],
): PlanEntry[] | null {
    const nodeId = chatNodeOf(owner);
    if (nodeId === undefined || opts.toolProfile?.restricted
        || isAssistantProfile(opts.toolProfile) || isMaintenanceProfile(opts.toolProfile)) return null;
    try {
        return getRuntimeDeps().historyStore.getPlanSnapshot?.({
            nodeId,
            userId: opts.ownerUserId ?? null,
            ...(branch ? { branch: {
                parentNodeId: branch.parentNodeId,
                ...(branch.boundaryMessageId === undefined ? {} : { boundaryMessageId: branch.boundaryMessageId }),
            } } : {}),
        }) ?? null;
    } catch (error) {
        console.warn(`[piRuntime] plan snapshot for ${nodeId} unavailable:`, (error as Error).message);
        return null;
    }
}

function resolveSessionOwner(owner: RuntimeSessionOwner | undefined, sessionId?: string): RuntimeSessionOwner {
    if (owner) {
        if (isRunOwner(owner) && sessionId && sessionId !== owner.key) {
            throw new Error("Agent Run public session id must equal attemptId");
        }
        return owner;
    }
    return chatOwner(sessionId ?? randomUUID());
}

/** An Agent Run's session id is its owner's key; a chat adopts the caller's id, else its owner's. */
function publicSessionId(owner: RuntimeSessionOwner, sessionId: string | undefined): string {
    return isRunOwner(owner) ? owner.key : (sessionId ?? owner.key);
}

function assertCompatibleSession(
    session: AgentSession,
    owner: RuntimeSessionOwner,
    profileHash: string | null,
): void {
    (session as PiSession).assertAvailable?.();
    const actualOwner = session.owner ?? chatOwner(session.id);
    if (!sameOwner(actualOwner, owner)) {
        throw new Error(`session ${session.id} is already bound to a different owner`);
    }
    if ((session.runtimeProfileHash ?? null) !== profileHash) {
        throw new Error(`session ${session.id} runtime profile hash mismatch`);
    }
}
