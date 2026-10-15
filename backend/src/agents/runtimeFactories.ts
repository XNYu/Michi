import type { AgentRuntime, AgentSession, ProviderEnvBinding } from "./types";
import type { AgentToolBridge } from "./toolBridge";
import type { McpSlotRegistry } from "../services/mcpServer";
import { PiRuntime } from "./pi/PiRuntime";
import { ClaudeRuntime } from "./claude/ClaudeRuntime";
import { KiroRuntime } from "./kiro/KiroRuntime";
import { CREW_DESCRIPTOR } from "./capabilityDescriptors";
import { crewAvailability, resolveCrewAcpLaunch } from "./crew/crewLaunch";
import type { AcpLaunch } from "../services/acpClient";
import { CodexRuntime } from "./codex";
import { AntigravityRuntime } from "./antigravity";
import { CursorRuntime } from "./cursor/CursorRuntime";
import { GrokRuntime } from "./grok/GrokRuntime";
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
        id: "crew",
        label: "Kiro Crew",
        create: (deps) => new KiroRuntime(
            deps.bridge,
            deps.mcpRegistry,
            deps.mcpPort ?? 3000,
            deps.defaultCwd,
            deps.modelCache,
            {
                // Pinned: one adapter process per cwd, sessions multiplexed.
                // MICHI_KIRO_ENGINE=v3 must not flip Crew to per-session workers.
                engine: "v2",
                id: "crew",
                label: "Kiro Crew",
                launch: CREW_LAUNCH,
                // The sidecar would open an extra Crew session per chat title.
                sidecarTitles: false,
                descriptorOverride: CREW_DESCRIPTOR,
                capabilitiesOverride: {
                    // ACP modes select Crew templates; member identities and
                    // approval policy are deliberately not agent modes.
                    modes: true,
                    // Official sessionApproval consent gates the adapter at each turn.
                    permissions: true,
                    // Only drives boot warm, /warm and the per-cwd warm pool. Off keeps the
                    // adapter from spawning at boot; it creates Crew slots lazily anyway.
                    warmSessions: false,
                    // Available through the optional official App stdio relay.
                    saveContext: true,
                    spawnBranches: true,
                    // Kept: nativeResume (session/load), models (adapter's models block),
                    // reasoning (v2 sends `effort`; errors remain visible).
                },
                // Offline: adapter resolves and the app secret file exists. When this
                // fails, KiroRuntime refuses to spawn the adapter at all.
                checkAvailability: () => crewAvailability(),
            },
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
        label: "Claude",
        create: (deps) => new ClaudeRuntime(
            deps.bridge,
            deps.mcpRegistry!,
            deps.mcpPort ?? 3000,
            { cache: deps.modelCache },
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
    {
        id: "antigravity",
        label: "Antigravity",
        create: (deps) => new AntigravityRuntime({ modelCache: deps.modelCache }),
    },
    {
        id: "cursor",
        label: "Cursor",
        create: (deps) => new CursorRuntime(
            deps.bridge,
            deps.mcpRegistry,
            deps.mcpPort ?? 3000,
            deps.defaultCwd,
            deps.modelCache,
        ),
    },
    {
        id: "grok",
        label: "Grok",
        create: (deps) => new GrokRuntime(
            deps.bridge,
            deps.mcpRegistry,
            deps.mcpPort ?? 3000,
            deps.defaultCwd,
            deps.modelCache,
        ),
    },
];

/**
 * Placeholder when no adapter resolves at spawn time. KiroRuntime never reaches it
 * while crewAvailability() is false; if the adapter vanishes later, the child
 * exits at once with a readable stderr line instead of a spawn ENOENT.
 */
const MISSING_CREW_LAUNCH: AcpLaunch = {
    bin: process.execPath,
    args: () => ["-e", "process.stderr.write('Kiro Crew ACP adapter not found; set MICHI_CREW_ACP_BIN\\n'); process.exit(1)"],
};

/**
 * Resolved at each spawn, not at boot, so building the adapter bundle or
 * setting MICHI_CREW_ACP_BIN after Michi started takes effect without a
 * restart. AcpClient reads `bin` once in its constructor and calls `args`
 * once per start.
 */
const CREW_LAUNCH: AcpLaunch = {
    standardFork: true,
    get bin() {
        return (resolveCrewAcpLaunch() ?? MISSING_CREW_LAUNCH).bin;
    },
    args: (model) => (resolveCrewAcpLaunch() ?? MISSING_CREW_LAUNCH).args(model),
    // Gateway can keep a stopped slot draining for several seconds (6.8s in
    // the live probe); give the adapter's 10s idle wait room to finish.
    cancelTimeoutMs: 15_000,
};

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
    const requested = env
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        // One-release compatibility: the removed Gemini ACP runtime occupied
        // this slot before Google moved AI Pro users to Antigravity.
        .map((id) => id === "gemini" ? "antigravity" : id);
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
