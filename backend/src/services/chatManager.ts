import type { NormalizedEvent } from "./chatEvents";
import type { KiroRuntime } from "../agents/kiro/KiroRuntime";
import type { AgentReasoning, AgentSession, ChatMessage, ExtraContext, NewAgentSessionOptions } from "../agents/types";
import * as sessionRegistry from "../agents/sessionRegistry";
import { normalizeWorkspaceCwd } from "../agents/tools/pathSandbox";
import { getRuntime } from "../agents/registry";
import { getAgentConfig } from "./agentConfig";
import {
    getNode,
    getWorkspace,
    listMessages,
    updateNodeResumeBinding,
} from "./dbRepository";
import { workspaceOwnerMatches } from "./agentOwner";
import { AgentDefinitionService } from "./agentDefinitionService";
import { getDb } from "./db";
import { acquireSessionRestoreLock, loadNativeSession, NativeResumeFailedError, nativeResumeId } from './nativeResume';
import { buildCompatibleResumeContext, chooseResumeStrategy, normalizeResumeSignature } from './resumeStrategy';
import { chatHub } from '../agents/chatHub';
import { createHash } from "node:crypto";
import {
    AgentPolicyCategory,
    AgentPolicyDecision,
    parseEffectiveAgentDefinitionV1,
    type AgentPermissionPolicyV1,
    type EffectiveAgentDefinitionV1,
} from "michi-shared";

export type { ChatMessage, ExtraContext };

const DEFAULT_PRIMARY_AGENT_POLICY: AgentPermissionPolicyV1 = {
    version: 1,
    preset: "build",
    categories: {
        [AgentPolicyCategory.ExternalAction]: AgentPolicyDecision.Ask,
        [AgentPolicyCategory.SpawnAgent]: AgentPolicyDecision.Allow,
    },
    maxDelegationDepth: 4,
    maxConcurrentRuns: 8,
    maxWallTimeMs: 24 * 60 * 60 * 1_000,
    maxAttempts: 3,
    maxTokens: null,
    maxSpendMicros: null,
};

export interface PrimaryAgentBinding {
    definitionId: string | null;
    definitionRevision: number;
    effectiveDefinition: EffectiveAgentDefinitionV1;
    profileHash: string;
}

type PrimaryAgentNodeRow = ReturnType<typeof getNode> & {
    agent_definition_id?: string | null;
    agent_definition_revision?: number | null;
    agent_effective_definition?: string | null;
};

export class PrimaryAgentBindingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PrimaryAgentBindingError";
    }
}

function primaryProfileHash(effectiveDefinition: EffectiveAgentDefinitionV1): string {
    return createHash("sha256").update(JSON.stringify(effectiveDefinition)).digest("hex");
}

export function primaryAgentSessionOptions(binding: PrimaryAgentBinding | null): Pick<NewAgentSessionOptions, "bootstrapInstructions" | "toolProfile" | "profileHash"> {
    if (!binding) return {};
    const definition = binding.effectiveDefinition;
    return {
        bootstrapInstructions: `You are the primary Agent for this conversation.\n\n${definition.instructions}`,
        toolProfile: {
            allowedToolNames: definition.capabilitySnapshot.entries
                .filter((entry) => entry.kind === "tool")
                .map((entry) => entry.id),
            capabilitySnapshot: JSON.parse(JSON.stringify(definition.capabilitySnapshot)),
        },
        profileHash: binding.profileHash,
    };
}

/**
 * Thin facade that brokers chat-creation requests to KiroRuntime and
 * registers the resulting AgentSession with sessionRegistry. Used by
 * digestGenerator / exportSummary which still take a ChatManager handle —
 * routes/michi.ts now goes through sessionRegistry directly.
 *
 * KiroRuntime is constructed by RUNTIME_FACTORIES in server.ts; ChatManager
 * holds a reference to the registered instance instead of owning its
 * lifecycle. The runtime is optional so Pi-only / Claude-only deployments
 * (where Kiro isn't registered) can still construct a ChatManager — the
 * Kiro-specific methods (warm, modes, setMode) become no-ops in that case.
 */
export class ChatManager {
    constructor(
        private readonly runtime: KiroRuntime | undefined,
        private readonly defaultCwd: string = process.cwd(),
    ) {}

    getRuntime(): KiroRuntime | undefined {
        return this.runtime;
    }

    /** Resolve once, persist once, and thereafter use only the node's immutable snapshot. */
    async resolvePrimaryAgentBinding(input: {
        ownerUserId: string;
        workspaceId: string | null;
        nodeId: string;
        definitionId?: string | null;
    }): Promise<PrimaryAgentBinding | null> {
        const readStored = (): PrimaryAgentBinding | null => {
            const row = getNode(input.nodeId) as PrimaryAgentNodeRow;
            if (!row?.agent_definition_revision || !row.agent_effective_definition) return null;
            if (input.definitionId && input.definitionId !== row.agent_definition_id) {
                throw new PrimaryAgentBindingError("node is already bound to a different primary Agent Definition");
            }
            const effectiveDefinition = parseEffectiveAgentDefinitionV1(JSON.parse(row.agent_effective_definition));
            return {
                definitionId: row.agent_definition_id ?? null,
                definitionRevision: row.agent_definition_revision,
                effectiveDefinition,
                profileHash: primaryProfileHash(effectiveDefinition),
            };
        };

        const stored = readStored();
        if (stored) return stored;
        if (!input.definitionId) return null;
        if (!input.workspaceId) throw new PrimaryAgentBindingError("workspaceId is required for a primary Agent Definition");
        const row = getNode(input.nodeId) as PrimaryAgentNodeRow;
        if (!row || row.workspace_id !== input.workspaceId) {
            throw new PrimaryAgentBindingError("primary Agent Definition must belong to the node's Workspace");
        }
        if (row.agent_effective_definition || row.acp_session_id || row.external_session_id || listMessages(input.nodeId).length > 0) {
            throw new PrimaryAgentBindingError("an existing conversation cannot switch its primary Agent in place");
        }

        const service = new AgentDefinitionService();
        const definition = await service.getSpawnable(input.ownerUserId, input.definitionId, input.workspaceId);
        if (!definition) throw new PrimaryAgentBindingError("enabled Agent Definition not found for this owner and Workspace");
        const capabilitySnapshot = service.capabilityCatalog.resolve({
            ownerUserId: input.ownerUserId,
            workspaceId: input.workspaceId,
            definitionScope: definition.scope,
            toolRefs: definition.toolRefs,
            skillRefs: definition.skillRefs,
            mcpServerRefs: definition.mcpServerRefs,
        });
        const effectiveDefinition = parseEffectiveAgentDefinitionV1({
            version: 1,
            name: definition.name,
            description: definition.description,
            instructions: definition.instructions,
            runtimeProfile: definition.runtimeProfile,
            fallbackChain: definition.fallbackChain,
            capabilitySnapshot,
            permissionPolicy: definition.permissionPolicy ?? DEFAULT_PRIMARY_AGENT_POLICY,
            contextPolicy: definition.contextPolicy,
        });
        getDb().prepare(`UPDATE nodes SET
            agent_definition_id = ?, agent_definition_revision = ?, agent_effective_definition = ?
            WHERE id = ? AND agent_effective_definition IS NULL`).run(
            definition.id,
            definition.revision,
            JSON.stringify(effectiveDefinition),
            input.nodeId,
        );
        return readStored() ?? {
            definitionId: definition.id,
            definitionRevision: definition.revision,
            effectiveDefinition,
            profileHash: primaryProfileHash(effectiveDefinition),
        };
    }

    async newChat(
        parentChatId?: string,
        cwd?: string,
        mergeContexts?: string[],
        model?: string,
        extraContexts?: ExtraContext[],
        enableFollowUps: boolean = true,
        contextManifest?: ExtraContext[],
    ): Promise<string> {
        if (!this.runtime) {
            throw new Error("ChatManager.newChat: Kiro runtime not registered");
        }
        const session = await this.runtime.newSession({
            cwd: normalizeWorkspaceCwd(cwd ?? this.defaultCwd),
            parentChatId,
            mergeContexts,
            extraContexts,
            contextManifest,
            enableFollowUps,
            model,
        });
        sessionRegistry.registerSession(session);
        return session.id;
    }

    async *sendMessage(chatId: string, userText: string): AsyncIterableIterator<NormalizedEvent> {
        const session = sessionRegistry.getSession(chatId);
        if (!session) throw new Error(`unknown chat: ${chatId}`);
        yield* session.send(userText);
    }

    async cancel(chatId: string): Promise<void> {
        const session = sessionRegistry.getSession(chatId);
        if (!session) return;
        await Promise.resolve(session.cancel());
    }

    respondToPermission(chatId: string, requestId: number, optionId: string): void {
        const session = sessionRegistry.getSession(chatId);
        session?.respondToPermission?.(requestId, optionId);
    }

    cancelPermission(chatId: string, requestId: number): void {
        const session = sessionRegistry.getSession(chatId);
        session?.cancelPermission?.(requestId);
    }

    getCurrentMode(chatId: string): string | undefined {
        return this.runtime?.getCurrentMode(chatId);
    }

    async getAvailableModes(): Promise<any[]> {
        if (!this.runtime) return [];
        return this.runtime.getAvailableModes();
    }

    /**
     * Resolve the mode catalog and the fresh-session default for one cwd.
     * Warming supplies both values from the same session/new response.
     */
    async getModeCatalog(cwd: string = this.defaultCwd): Promise<{ availableModes: any[]; defaultModeId: string | null }> {
        if (!this.runtime) return { availableModes: [], defaultModeId: null };
        await this.runtime.warm(cwd);
        return {
            availableModes: await this.runtime.getAvailableModes(),
            defaultModeId: this.runtime.getDefaultModeId(cwd),
        };
    }

    getDefaultModeId(cwd: string = this.defaultCwd): string | null {
        return this.runtime?.getDefaultModeId(cwd) ?? null;
    }

    async setMode(chatId: string, modeId: string): Promise<void> {
        if (!this.runtime) return;
        await this.runtime.setMode(chatId, modeId);
    }

    async warm(): Promise<void> {
        if (!this.runtime) return;
        await this.runtime.warm(this.defaultCwd);
    }

    /** AgentSession lookup (used by ChatManager-using callers; new code should use sessionRegistry directly). */
    getSession(chatId: string): AgentSession | undefined {
        return sessionRegistry.getSession(chatId);
    }

    /**
     * Resolve or rebuild the runtime session that owns a durable Parent node.
     * This is the backend-only counterpart of the HTTP ensure-session route:
     * Watch delivery can wake a Parent even when every UI window is closed.
     */
    async ensureParentSession(input: {
        ownerUserId: string;
        workspaceId: string;
        nodeId: string;
    }): Promise<AgentSession | null> {
        const release = await acquireSessionRestoreLock(input.nodeId);
        try {
            return await this.restoreParentSession(input);
        } finally {
            release();
        }
    }

    private async restoreParentSession(input: { ownerUserId: string; workspaceId: string; nodeId: string }): Promise<AgentSession | null> {
        const owner = { kind: "chat_node" as const, nodeId: input.nodeId };
        const node = getNode(input.nodeId);
        if (!node || node.workspace_id !== input.workspaceId) return null;
        const workspace = getWorkspace(input.workspaceId);
        if (!workspace || !workspaceOwnerMatches(workspace.owner_user_id ?? null, input.ownerUserId)) return null;
        const cwd = normalizeWorkspaceCwd(workspace.cwd ?? this.defaultCwd);
        const configured = getAgentConfig(process.env.MICHI_CLOUD === "1" ? input.ownerUserId : undefined);
        const primaryAgent = await this.resolvePrimaryAgentBinding({
            ownerUserId: input.ownerUserId,
            workspaceId: input.workspaceId,
            nodeId: input.nodeId,
        });
        const primaryProfile = primaryAgent?.effectiveDefinition.runtimeProfile;
        const runtimeId = primaryProfile?.runtimeId ?? node.runtime_id ?? configured.runtime;
        const runtime = getRuntime(runtimeId);
        if (!runtime) return null;
        const model = primaryProfile?.modelId ?? node.model_id ?? null;
        const provider = primaryProfile?.providerId ?? node.provider_id ?? null;
        const reasoning = (primaryProfile?.reasoning ?? node.reasoning ?? null) as AgentReasoning | null;
        const bootstrap = primaryAgentSessionOptions(primaryAgent);
        const live = sessionRegistry.getSessionForOwner(input.nodeId, owner, input.ownerUserId);
        const nativeId = nativeResumeId(runtimeId, node);
        const targetSignature = { runtimeId, runtimeEngine: runtime.nativeEngine, modelId: model, providerId: provider, reasoning };
        const existingSignature = normalizeResumeSignature({
            runtimeId: node.runtime_id ?? (node.acp_session_id && node.acp_session_id !== node.id ? 'kiro' : null),
            runtimeEngine: node.runtime_engine,
            modelId: node.model_id, providerId: node.provider_id, reasoning: node.reasoning,
        });
        const decision = chooseResumeStrategy({
            existingChatId: nativeId ? input.nodeId : null,
            existingSignature,
            targetSignature,
            nativeResumeAvailable: !!runtime.loadSession && runtime.capabilities.nativeResume && !!nativeId,
            nativeResumeSettings: runtime.capabilities.nativeResumeSettings,
            liveSessionMatches: !!live && live.runtimeId === runtimeId
                && (live.nativeSessionId ?? live.id) === nativeId
                && (live.runtimeProfileHash ?? null) === (primaryAgent?.profileHash ?? null)
                && (!existingSignature || (existingSignature.reasoning === reasoning && existingSignature.modelId === model)),
        });
        if (decision.strategy === 'live' && live) return live;
        if (chatHub.isActive(input.nodeId)) throw new NativeResumeFailedError(new Error('Cannot reload an active parent turn'));
        if (live) {
            await getRuntime(live.runtimeId)?.releaseSession(live.id);
            sessionRegistry.dropSession(live.id);
        }

        let session: AgentSession | null = null;
        if (decision.strategy === 'exact') {
            session = await loadNativeSession(runtime, {
                sessionId: input.nodeId,
                nodeId: input.nodeId,
                cwd,
                workspaceId: input.workspaceId,
                ownerUserId: input.ownerUserId,
                model,
                provider,
                reasoning,
                ...bootstrap,
            }, nativeId);
        }
        if (!session) {
            const replayHistory = listMessages(input.nodeId, process.env.MICHI_CLOUD === "1" ? input.ownerUserId : undefined)
                .filter((message) => message.role === "user" || message.role === "assistant")
                .map((message) => ({
                    role: message.role as "user" | "assistant",
                    content: message.content,
                }));
            session = await runtime.newSession({
                sessionId: input.nodeId,
                cwd,
                workspaceId: input.workspaceId,
                ownerUserId: input.ownerUserId,
                model,
                provider,
                reasoning,
                replayHistory,
                mergeContexts: runtime.id !== 'pi'
                    ? [buildCompatibleResumeContext(replayHistory, { nodeId: input.nodeId, title: node.title })].filter((value): value is string => !!value)
                    : undefined,
                ...bootstrap,
            });
        }
        sessionRegistry.registerSession(session, input.ownerUserId, owner);
        try {
            updateNodeResumeBinding(input.nodeId, {
                acp_session_id: session.nativeSessionId ?? session.id,
                runtime_id: session.runtimeId,
                runtime_engine: session.nativeEngine ?? null,
                provider_id: provider,
                model_id: session.currentModelId ?? model,
                reasoning,
                current_mode_id: session.currentModeId ?? null,
            });
        } catch (error) {
            await runtime.releaseSession(session.id);
            sessionRegistry.dropSession(session.id);
            throw error;
        }
        return session;
    }
}
