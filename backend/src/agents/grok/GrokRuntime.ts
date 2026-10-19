import { createGrokProfile } from "../../services/acp/profiles/grok";
import { getWorkspaceInstructions } from "../../services/dbRepository";
import { ACPError } from "../../services/acp/errors";
import { NativeResumeUnavailableError } from "../../services/nativeResume";
import type { McpSlotRegistry } from "../../services/mcpServer";
import type { AgentToolBridge } from "../toolBridge";
import type { RuntimeModelCache } from "../runtimeModelCache";
import type { AgentSession, ForkAgentSessionOptions } from "../types";
import { buildPreamble } from "../preamble";
import { AcpSession } from "../acp/AcpSession";
import { AcpAgentRuntime, CURSOR_GROK_ACP_CAPABILITIES } from "../acp/AcpRuntime";

/** Grok 1.0.62 does not implement standard session/fork. This extension copies the latest conversation. */
export const GROK_FORK_METHOD = "_x.ai/session/fork";

export function grokForkChildId(result: unknown, sourceSessionId: string): string {
    const id = result && typeof result === "object" && typeof (result as { newSessionId?: unknown }).newSessionId === "string"
        ? (result as { newSessionId: string }).newSessionId
        : "";
    if (!id || id === sourceSessionId) {
        throw new Error("Grok fork did not return an independent session");
    }
    return id;
}

function grokForkUnavailable(error: unknown): boolean {
    return error instanceof ACPError && (error.rpcCode === -32601 || error.rpcCode === -32603);
}

/**
 * Official xAI Grok CLI ACP runtime. Thin profile on the shared client:
 * spawn `grok --no-auto-update agent stdio`, protocolVersion 1,
 * authenticate cached_token (after `grok login`), then xai.api_key if
 * XAI_API_KEY is set, then grok.com. Default model grok-4.6.
 * HTTP MCP is attached always — live probe (2026-08-17) confirmed
 * session/new with mcpServers connects. Does not write ~/.grok/config.toml.
 * Does not register XAI_API_KEY as a factory envBinding (that key already
 * belongs to Pi's xai provider).
 * Native fork uses `_x.ai/session/fork` and copies the parent's latest
 * conversation. A historical branch anchor falls back to Michi's text prefix.
 */
export class GrokRuntime extends AcpAgentRuntime {
    constructor(
        bridge: AgentToolBridge,
        mcpRegistry: McpSlotRegistry | undefined,
        mcpPort: number,
        defaultCwd: string = process.cwd(),
        modelCache?: RuntimeModelCache,
    ) {
        super(
            {
                id: "grok",
                label: "Grok",
                concurrencyEnv: "MICHI_GROK_MAX_CONCURRENT",
                defaultConcurrency: 100,
                capabilities: { ...CURSOR_GROK_ACP_CAPABILITIES, apiKeys: false },
                mcpAttach: "always",
                branchOverviewReminder: false,
                createProfile: (cwd, model) => createGrokProfile({ cwd, model }),
            },
            bridge,
            mcpRegistry,
            mcpPort,
            defaultCwd,
            modelCache,
        );
    }

    async forkSession(opts: ForkAgentSessionOptions): Promise<AgentSession> {
        if (opts.anchorMessageId) {
            throw new NativeResumeUnavailableError("Grok native fork cannot stop at a historical branch anchor");
        }
        if (!opts.sessionId || opts.owner?.kind === "agent_run") {
            throw new NativeResumeUnavailableError("Only chat nodes can inherit a native Grok conversation");
        }
        const client = await this.ensureClient(opts.cwd, opts.model ?? undefined);
        let childId: string;
        try {
            const result = await client.extensionRequest(GROK_FORK_METHOD, {
                sourceSessionId: opts.sourceNativeSessionId,
                sourceCwd: opts.cwd,
                newCwd: opts.cwd,
            });
            childId = grokForkChildId(result, opts.sourceNativeSessionId);
        } catch (error) {
            if (error instanceof NativeResumeUnavailableError || grokForkUnavailable(error)) {
                throw new NativeResumeUnavailableError("Grok parent session is unavailable");
            }
            throw error;
        }
        const session = await this.loadSession({
            ...opts,
            sessionId: childId,
            nodeId: opts.sessionId,
        });
        session.parentChatId = opts.parentChatId;
        if (opts.model) {
            try {
                await this.setModel(childId, opts.model);
            } catch {
                // session/set_model is optional; the copied session keeps its model.
            }
        }
        if (session instanceof AcpSession) {
            session.primeFirstMessage(buildPreamble({
                enableFollowUps: opts.enableFollowUps !== false,
                cwd: opts.cwd,
                contextManifest: opts.contextManifest,
                extraContexts: opts.extraContexts,
                ancestors: [],
                mergeContexts: opts.mergeContexts,
                workspaceInstructions: opts.workspaceId ? getWorkspaceInstructions(opts.workspaceId) : null,
            }));
        }
        return session;
    }
}
