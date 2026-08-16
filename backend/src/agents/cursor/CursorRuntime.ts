import { createCursorProfile } from "../../services/acp/profiles/cursor";
import type { McpSlotRegistry } from "../../services/mcpServer";
import type { AgentToolBridge } from "../toolBridge";
import type { RuntimeModelCache } from "../runtimeModelCache";
import { AcpAgentRuntime, CURSOR_GROK_ACP_CAPABILITIES } from "../acp/AcpRuntime";

/**
 * Cursor CLI ACP runtime. Thin profile on the shared client:
 * spawn `agent acp` (~/.local/bin/agent, never Grok's ~/.grok/bin/agent),
 * protocolVersion 1, authenticate cursor_login. Official ACP modes are
 * agent/plan/ask. HTTP MCP is attached always — live probe (2026-08-17)
 * confirmed session/new with mcpServers connects. Does not write
 * .cursor/mcp.json.
 */
export class CursorRuntime extends AcpAgentRuntime {
    constructor(
        bridge: AgentToolBridge,
        mcpRegistry: McpSlotRegistry | undefined,
        mcpPort: number,
        defaultCwd: string = process.cwd(),
        modelCache?: RuntimeModelCache,
    ) {
        super(
            {
                id: "cursor",
                label: "Cursor",
                concurrencyEnv: "MICHI_CURSOR_MAX_CONCURRENT",
                defaultConcurrency: 100,
                capabilities: { ...CURSOR_GROK_ACP_CAPABILITIES, modes: true },
                mcpAttach: "always",
                branchOverviewReminder: false,
                createProfile: (cwd, model) => createCursorProfile({ cwd, model }),
            },
            bridge,
            mcpRegistry,
            mcpPort,
            defaultCwd,
            modelCache,
        );
    }
}
