import { createKiroProfile } from "../../services/acp/profiles/kiro";
import type { McpSlotRegistry } from "../../services/mcpServer";
import type { AgentToolBridge } from "../toolBridge";
import type { RuntimeModelCache } from "../runtimeModelCache";
import {
    AcpAgentRuntime,
    KiroConcurrencyError,
} from "../acp/AcpRuntime";

export { KiroConcurrencyError, AcpConcurrencyError } from "../acp/AcpRuntime";
export type { OpenSessionResult, LoadSessionResult, McpSlotCallbacksFactory } from "../acp/AcpRuntime";

/**
 * Kiro ACP runtime. Behavior is bit-identical to the pre-extraction
 * implementation: spawn `kiro-cli acp -a`, protocolVersion "2025-01-01",
 * no authenticate, `_kiro.dev/*` extensions, HTTP MCP slot on session/new.
 */
export class KiroRuntime extends AcpAgentRuntime {
    constructor(
        bridge: AgentToolBridge,
        mcpRegistry: McpSlotRegistry | undefined,
        mcpPort: number,
        defaultCwd: string = process.cwd(),
        modelCache?: RuntimeModelCache,
    ) {
        super(
            {
                id: "kiro",
                label: "Kiro",
                concurrencyEnv: "MICHI_KIRO_MAX_CONCURRENT",
                defaultConcurrency: 100,
                concurrencyError: KiroConcurrencyError,
                createProfile: (cwd, model) => createKiroProfile({ cwd, model }),
            },
            bridge,
            mcpRegistry,
            mcpPort,
            defaultCwd,
            modelCache,
        );
    }
}
