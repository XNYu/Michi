import { randomUUID } from "crypto";
import type {
    AgentCapabilities,
    AgentProviderInfo,
    AgentRuntimeWithProviders,
    AgentSession,
    LoadAgentSessionOptions,
    ModelInfo,
    NewAgentSessionOptions,
    VerifyProviderKeyOptions,
    VerifyProviderKeyResult,
} from "../types";
import type { AgentToolBridge } from "../toolBridge";
import { PiSession } from "./PiSession";
import * as sessionRegistry from "../sessionRegistry";
import { buildPreamble } from "../preamble";
import {
    listPiModels,
    listProviderInfos,
    verifyPiProviderKey,
} from "./piProviders";
import { getAgentConfig } from "../../services/agentConfig";
import { getProviderApiKey } from "../../services/secrets";
import { getNode, listMessages } from "../../services/dbRepository";
import { rowsToAgentMessages } from "./historyAdapter";

/**
 * AgentRuntime adapter for the @earendil-works/pi-ai package.
 *
 * Capabilities:
 *   - providerModels=true (a single binary catalog of providers/models is
 *     advertised; the active one is read from agentConfig)
     *   - reasoning=true / apiKeys=true / saveContext=true / spawnBranches=true
     *     (saveContext covers both save_context and update_context tools)
 *   - modes=false / permissions=false / warmSessions=false
 *
 * Pi sessions are in-memory only. There is no persistent ACP process or MCP
 * slot pool — newSession() and loadSession() both produce a fresh PiSession
 * (loadSession just reuses the caller's id rather than minting a new one).
 *
 * Provider env bindings are registered with secrets.ts by runtimeFactories,
 * not by this class — keeps registration symmetric across runtimes.
 */
export class PiRuntime implements AgentRuntimeWithProviders {
    public readonly id = "pi" as const;
    public readonly label = "Pi (multi-provider)";
    public readonly capabilities: AgentCapabilities = {
        modes: false,
        permissions: true,
        models: true,
        providerModels: true,
        reasoning: true,
        // Pi thinkingLevel: minimal | low | medium | high | xhigh
        supportedReasoningLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        apiKeys: true,
        warmSessions: false,
        saveContext: true,
        spawnBranches: true,
        // Pi rehydrates from SQLite messages — "exact" resume produces a
        // session indistinguishable from "compatible" replay, so it has no
        // native-resume advantage and shouldn't pay the extra round-trip.
        nativeResume: false,
    };

    private sessions = new Map<string, PiSession>();

    constructor(private readonly bridge: AgentToolBridge) {}

    async warm(_cwd: string): Promise<void> {
        // No-op — Pi has no expensive process to spawn.
    }

    async newSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
        // Adopt the caller-supplied id when present so chatId === nodeId
        // (Pi runtime convention; Kiro must server-mint per ACP). When
        // absent (legacy callers), fall back to a UUID.
        const id = opts.sessionId ?? randomUUID();
        const enableFollowUps = opts.enableFollowUps !== false;

        // Walk the parent's chain (parent's own ancestors + parent itself).
        // Lazy-load any session whose getHistory() is empty — this covers the
        // cold path where the user branches from a parent that hasn't been
        // re-opened since backend restart.
        const ancestorChain: AgentSession[] = [];
        if (opts.parentChatId) {
            await this.ensureChainLoaded(opts.parentChatId, opts.cwd);
            const parent = sessionRegistry.getSession(opts.parentChatId);
            if (parent) {
                ancestorChain.push(...sessionRegistry.getAncestors(opts.parentChatId), parent);
            }
        }

        const preamble = buildPreamble({
            enableFollowUps,
            cwd: opts.cwd,
            contextManifest: opts.contextManifest,
            extraContexts: opts.extraContexts,
            ancestors: ancestorChain,
            mergeContexts: opts.mergeContexts,
        });

        const session = new PiSession(id, {
            bridge: this.bridge,
            cwd: opts.cwd,
            enableFollowUps,
            preamble,
            parentChatId: opts.parentChatId,
            workspaceId: opts.workspaceId ?? null,
            ownerUserId: opts.ownerUserId ?? null,
        });
        this.sessions.set(id, session);
        return session;
    }

    /**
     * Rehydrate a Pi session by reading the node's prior messages from SQLite
     * and seeding them into a fresh PiSession. Tool calls / thinking blocks
     * are not persisted, so the rehydrated transcript is text-only — the
     * model can still continue the conversation, but won't see prior
     * spawn_branches / save_context calls in its context.
     *
     * chatId === nodeId for Pi, so opts.sessionId is the row id for both
     * the nodes lookup (parent chain) and the messages lookup (history).
     */
    async loadSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
        let initialMessages: ReturnType<typeof rowsToAgentMessages> = [];
        let parentChatId: string | undefined;
        // Caller-supplied workspaceId wins — covers the cold-start window where the
        // node row hasn't been synced from the frontend yet.
        let workspaceId: string | null = opts.workspaceId ?? null;
        try {
            const row = getNode(opts.sessionId);
            parentChatId = row?.parent_node_id ?? undefined;
            if (!workspaceId) workspaceId = row?.workspace_id ?? null;
            const rows = listMessages(opts.sessionId);
            initialMessages = rowsToAgentMessages(rows);
        } catch (err) {
            console.warn(`[piRuntime] loadSession: failed reading state for ${opts.sessionId}:`, err);
        }

        const session = new PiSession(opts.sessionId, {
            bridge: this.bridge,
            cwd: opts.cwd,
            enableFollowUps: true,
            preamble: "",
            initialMessages,
            parentChatId,
            workspaceId,
            ownerUserId: opts.ownerUserId ?? null,
        });
        this.sessions.set(opts.sessionId, session);
        return session;
    }

    /**
     * Walk a chatId's parent chain, lazy-loading any session whose history
     * isn't already in memory. Called by newSession() before building the
     * preamble so cold-restart branches still inherit ancestor transcripts.
     *
     * Stops at the first chain link with no in-memory session and no DB row
     * (root or unsynced node), or on cycle.
     */
    private async ensureChainLoaded(chatId: string, cwd: string): Promise<void> {
        const visited = new Set<string>();
        let cursor: string | undefined = chatId;
        while (cursor && !visited.has(cursor)) {
            visited.add(cursor);
            let session = sessionRegistry.getSession(cursor);
            if (!session) {
                try {
                    session = await this.loadSession({ sessionId: cursor, cwd });
                    sessionRegistry.registerSession(session);
                } catch (err) {
                    console.warn(`[piRuntime] ensureChainLoaded: failed loading ${cursor}:`, err);
                    return;
                }
            }
            cursor = session.parentChatId;
        }
    }

    async listModels(opts?: { provider?: string }): Promise<ModelInfo[]> {
        const cfg = getAgentConfig();
        const provider = opts?.provider ?? cfg.provider;
        try {
            const models = await listPiModels(provider);
            return models.map((m) => ({
                id: m.model_id,
                label: m.model_name,
                description: m.description,
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
            defaultModel: p.defaultModel,
            keyUrl: p.keyUrl,
            supportsReasoning: p.supportsReasoning,
        }));
    }

    /**
     * Used by /api/agent/provider-key/verify. Falls back to the disk-stored
     * key when the body omits one (e.g. a "verify the key I just saved" flow).
     */
    async verifyProviderKey(body: VerifyProviderKeyOptions): Promise<VerifyProviderKeyResult> {
        const cfg = getAgentConfig();
        const provider = body.provider ?? cfg.provider;
        const apiKey = body.key ?? getProviderApiKey(provider) ?? undefined;
        return verifyPiProviderKey({ provider, key: apiKey, model: body.model });
    }

    /** Drop a session (used by the route layer when a chat ends). */
    dropSession(id: string): void {
        const s = this.sessions.get(id);
        if (s) {
            s.destroy();
            this.sessions.delete(id);
        }
    }

    releaseSession(id: string): void {
        this.dropSession(id);
        sessionRegistry.dropSession(id);
    }

    async shutdown(): Promise<void> {
        for (const s of this.sessions.values()) {
            try {
                s.destroy();
            } catch {
                /* ignore */
            }
        }
        this.sessions.clear();
    }
}
