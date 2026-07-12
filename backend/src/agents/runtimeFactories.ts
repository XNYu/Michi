import type { AgentRuntime, AgentSession, ProviderEnvBinding } from "./types";
import type { AgentToolBridge } from "./toolBridge";
import type { McpSlotRegistry } from "../services/mcpServer";
import { PiRuntime } from "./pi/PiRuntime";
import { ClaudeRuntime } from "./claude/ClaudeRuntime";
import { KiroRuntime } from "./kiro/KiroRuntime";
import { CodexRuntime } from "./codex";
import { getProviderEnvBindings } from "./pi/piProviders";
import type { RuntimeModelCache } from "./runtimeModelCache";

/**
 * Dependencies passed to a RuntimeFactory.create. Adding a new runtime
 * means appending an entry to RUNTIMES — server.ts then registers it via
 * a single uniform loop.
 */
export interface RuntimeFactoryDeps {
    /** A tool bridge whose createChild creates a new session in this runtime
     *  and registers it with sessionRegistry. */
    bridge: AgentToolBridge;
    /**
     * The shared McpSlotRegistry used to allocate per-session MCP slots.
     * Required by Claude/Kiro; ignored by runtimes that don't use MCP slots.
     */
    mcpRegistry?: McpSlotRegistry;
    /**
     * The HTTP port the MCP server is listening on (same as the backend port).
     * Required by Claude/Kiro to build the slot URL.
     */
    mcpPort?: number;
    /**
     * Default project cwd used for boot-time warmup and runtime metadata
     * fallback probes. In the monorepo dev loop the backend process cwd is
     * backend/, while user workspaces usually live at the repo root.
     */
    defaultCwd?: string;
    /** Shared persistent catalog cache for dynamic CLI runtimes. */
    modelCache?: RuntimeModelCache;
}

export interface RuntimeFactory {
    id: string;
    label: string;
    /** Provider env-var bindings collected by secrets.ts at startup. */
    envBindings?: ProviderEnvBinding[];
    create(deps: RuntimeFactoryDeps): AgentRuntime;
}

export const RUNTIME_FACTORIES: readonly RuntimeFactory[] = [
    {
        id: "kiro",
        label: "Kiro",
        create: (deps) => new KiroRuntime(
            deps.bridge,
            deps.mcpRegistry,
            deps.mcpPort ?? 3000,
            deps.defaultCwd,
            deps.modelCache,
        ),
    },
    {
        id: "pi",
        label: "Pi (multi-provider)",
        envBindings: getProviderEnvBindings(),
        create: (deps) => new PiRuntime(deps.bridge),
    },
    {
        id: "claude",
        label: "Claude (CLI)",
        create: (deps) => new ClaudeRuntime(
            deps.bridge,
            deps.mcpRegistry!,
            deps.mcpPort ?? 3000,
        ),
    },
    {
        id: "codex",
        label: "Codex",
        create: (deps) => new CodexRuntime(
            deps.bridge,
            deps.mcpRegistry!,
            deps.mcpPort ?? 3000,
            { modelCache: deps.modelCache },
        ),
    },
];

/**
 * Filter RUNTIME_FACTORIES by the MICHI_ENABLED_RUNTIMES env var (comma
 * separated runtime ids). Unset → every factory (current default; local
 * dev keeps its kiro+pi+claude lineup). Set → only listed runtimes are
 * instantiated, which is what Pi-only / Claude-only containers want so
 * we don't even construct KiroRuntime (whose ensureClient would later
 * try to spawn kiro-cli, fatally on hosts without the binary).
 *
 * Unknown ids are logged but skipped — typos go to stderr instead of
 * crashing the boot.
 */
export function getEnabledFactories(): readonly RuntimeFactory[] {
    const env = process.env.MICHI_ENABLED_RUNTIMES?.trim();
    if (!env) return RUNTIME_FACTORIES;
    const requested = env.split(",").map((s) => s.trim()).filter(Boolean);
    const known = new Set(RUNTIME_FACTORIES.map((f) => f.id));
    const unknown = requested.filter((id) => !known.has(id));
    if (unknown.length) {
        console.warn(
            `[runtimeFactories] MICHI_ENABLED_RUNTIMES contains unknown ids: ${unknown.join(", ")} (known: ${[...known].join(", ")}) — ignoring`,
        );
    }
    const enabled = new Set(requested.filter((id) => known.has(id)));
    const filtered = RUNTIME_FACTORIES.filter((f) => enabled.has(f.id));
    if (filtered.length === 0) {
        throw new Error(
            `MICHI_ENABLED_RUNTIMES='${env}' matched no known runtimes (available: ${[...known].join(", ")})`,
        );
    }
    return filtered;
}

// Re-export for convenience to server.ts
export type { AgentSession };
