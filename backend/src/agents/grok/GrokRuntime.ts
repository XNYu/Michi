import { createGrokProfile } from "../../services/acp/profiles/grok";
import type { McpSlotRegistry } from "../../services/mcpServer";
import type { AgentToolBridge } from "../toolBridge";
import type { RuntimeModelCache } from "../runtimeModelCache";
import { AcpAgentRuntime, CURSOR_GROK_ACP_CAPABILITIES } from "../acp/AcpRuntime";

/**
 * Official xAI Grok CLI ACP runtime. Thin profile on the shared client:
 * spawn `grok --no-auto-update agent stdio`, protocolVersion 1,
 * authenticate cached_token (after `grok login`), then xai.api_key if
 * XAI_API_KEY is set, then grok.com. Default model grok-4.6.
 * HTTP MCP is attached always — live probe (2026-08-17) confirmed
 * session/new with mcpServers connects. Does not write ~/.grok/config.toml.
 * Does not register XAI_API_KEY as a factory envBinding (that key already
 * belongs to Pi's xai provider).
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
}
