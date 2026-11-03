import { AntigravityRuntime } from "./antigravity";
import { CursorRuntime } from "./cursor/CursorRuntime";
import { GrokRuntime } from "./grok/GrokRuntime";
import { michiKiroRestrictedAgent } from './kiro/kiroMetaAgent';
import os from "node:os";
import path from "node:path";
import type { AgentRuntime, ProviderEnvBinding } from "./types";
import type { AgentToolBridge } from "./toolBridge";
import type { McpSlotRegistry } from "../services/mcpServer";
import { PiRuntime } from "./pi/PiRuntime";
import { ClaudeRuntime } from "michi-runtime/internal/adapters/claude/ClaudeRuntime";
import { michiClaudeAdapterOptions } from "./michiClaudeOptions";
import { AcpAgentRuntime } from "michi-runtime/internal/adapters/kiro/AcpAgentRuntime";
import { resolveKiroEngine } from "michi-runtime/internal/adapters/kiro/kiroProtocol";
import { createCrewRuntime } from "michi-runtime/internal/adapters/crew/crewRuntime";
import { crewEnvOptions, kiroEnvOptions } from "./michiKiroOptions";
import { CodexRuntime, type CodexAdapterOptions } from "michi-runtime/internal/adapters/codex/index";
import { michiCodexHostText } from "./michiCodexOptions";
import { probeKiroCli } from 'michi-runtime/internal/adapters/kiro/kiroCli';
import { kiroAuth } from './kiro/kiroAuth';
import { getProviderEnvBindings } from "./pi/piProviders";
import type { RuntimeModelCache } from "./runtimeModelCache";
import type { RuntimeDescriptor } from "michi-runtime/internal/contract/descriptor";
import type { RuntimeHost } from "michi-runtime/internal/contract/host";
import { STATIC_RUNTIME_DESCRIPTORS } from "./runtimeStaticDescriptors";

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
     * No built-in runtime reads it: Kiro, Crew, Claude and Codex take their
     * URLs from mcpRegistry.
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
    /**
     * The runtime host ports (server.ts: createMichiRuntimeHost(), created
     * once). Kiro, Crew, Claude and Codex read Michi through it; Pi does not
     * take it.
     */
    host: RuntimeHost;
}

export interface RuntimeFactory {
    id: string;
    label: string;
    /** Provider env-var bindings collected by secrets.ts at startup. */
    envBindings?: ProviderEnvBinding[];
    /**
     * The runtime's description without an instance, independent of
     * availability, for a runtime that is configured but not registered.
     * It is the shape under default configuration (Kiro: engine v2); once an
     * instance exists, read the instance's `descriptor` instead. Taken from
     * STATIC_RUNTIME_DESCRIPTORS, the table routes read without a factory.
     */
    staticDescriptor: RuntimeDescriptor;
    create(deps: RuntimeFactoryDeps): AgentRuntime;
}

export const RUNTIME_FACTORIES: readonly RuntimeFactory[] = [
    {
        id: "kiro",
        label: "Kiro",
        staticDescriptor: STATIC_RUNTIME_DESCRIPTORS.kiro,
        create: (deps) => new AcpAgentRuntime({
            ...kiroEnvOptions(),
            restrictedAgent: michiKiroRestrictedAgent,
            startClient: (launch) => {
                const cli = probeKiroCli();
                if (!cli.installed) throw new Error('kiro-cli not found. Install Kiro CLI before starting a session.');
                return kiroAuth.start(cli.path!, launch);
            },
            onSignedOut: (binary) => kiroAuth.signedOut(binary),
            engine: resolveKiroEngine(process.env.MICHI_KIRO_ENGINE),
            host: deps.host,
            bridge: deps.bridge,
            mcpSlots: deps.mcpRegistry,
            defaultCwd: deps.defaultCwd,
            modelCache: deps.modelCache,
        }),
    },
    {
        id: "crew",
        label: "Kiro Crew",
        staticDescriptor: STATIC_RUNTIME_DESCRIPTORS.crew,
        // The preset pins engine v2, so MICHI_KIRO_ENGINE=v3 does not flip Crew
        // to per-session workers. It reads the adapter and App locations from
        // Michi's environment at each spawn and availability check.
        create: (deps) => createCrewRuntime({
            ...kiroEnvOptions(),
            restrictedAgent: michiKiroRestrictedAgent,
            host: deps.host,
            bridge: deps.bridge,
            mcpSlots: deps.mcpRegistry,
            defaultCwd: deps.defaultCwd,
            modelCache: deps.modelCache,
            crew: crewEnvOptions,
        }),
    },
    {
        id: "pi",
        label: "Pi (multi-provider)",
        envBindings: getProviderEnvBindings(),
        staticDescriptor: STATIC_RUNTIME_DESCRIPTORS.pi,
        create: (deps) => new PiRuntime(deps.bridge),
    },
    {
        id: "claude",
        label: "Claude",
        staticDescriptor: STATIC_RUNTIME_DESCRIPTORS.claude,
        create: (deps) => new ClaudeRuntime({
            ...michiClaudeAdapterOptions(deps.host, { cache: deps.modelCache }),
            bridge: deps.bridge,
            mcpSlots: deps.mcpRegistry!,
        }),
    },
    {
        id: "codex",
        label: "Codex",
        staticDescriptor: STATIC_RUNTIME_DESCRIPTORS.codex,
        create: (deps) => new CodexRuntime({
            ...codexAdapterOptions(deps),
            bridge: deps.bridge,
            mcpSlots: deps.mcpRegistry!,
        }),
    },
    {
        id: "antigravity",
        label: "Antigravity",
        staticDescriptor: STATIC_RUNTIME_DESCRIPTORS.antigravity,
        create: (deps) => new AntigravityRuntime({ modelCache: deps.modelCache }),
    },
    {
        id: "cursor",
        label: "Cursor",
        staticDescriptor: STATIC_RUNTIME_DESCRIPTORS.cursor,
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
        staticDescriptor: STATIC_RUNTIME_DESCRIPTORS.grok,
        create: (deps) => new GrokRuntime(
            deps.bridge,
            deps.mcpRegistry,
            deps.mcpPort ?? 3000,
            deps.defaultCwd,
            deps.modelCache,
        ),
    },
];

const CODEX_FOLLOW_UPS_HOOK_POC_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * The Codex adapter's options from `env`, parsed as the adapter itself did
 * before it took options. The app-server child gets `env` itself; the title
 * deadline is read at each title, the rest once, here.
 */
export function codexAdapterOptions(
    deps: Pick<RuntimeFactoryDeps, "host" | "modelCache">,
    env: NodeJS.ProcessEnv = process.env,
): CodexAdapterOptions {
    const followUpsHookPoc = CODEX_FOLLOW_UPS_HOOK_POC_VALUES.has(
        (env.MICHI_CODEX_FOLLOW_UPS_HOOK_POC ?? "").trim().toLowerCase(),
    );
    return {
        host: deps.host,
        modelCache: deps.modelCache,
        binaryPath: env.CODEX_CLI_BIN,
        binaryCacheFile: path.join(env.MICHI_DATA_DIR || path.join(os.homedir(), ".michi"), "cache", "codex-binary.json"),
        codexHome: env.CODEX_HOME,
        spawnEnv: () => env,
        rpcTimeoutMs: parseInt(env.MICHI_CODEX_RPC_TIMEOUT_MS ?? "30000", 10),
        initTimeoutMs: parseInt(env.MICHI_CODEX_INIT_TIMEOUT_MS ?? "30000", 10),
        approveTimeoutMs: parseInt(env.MICHI_APPROVE_TIMEOUT_MS ?? "300000", 10),
        titleTimeoutMs: () => parseInt(env.MICHI_CODEX_TITLE_TIMEOUT_MS ?? "10000", 10),
        maxConcurrent: Number(env.MICHI_CODEX_MAX_CONCURRENT),
        hostText: michiCodexHostText(),
        ...(followUpsHookPoc ? {
            followUpsHook: {
                // The POC's own CODEX_HOME, so bypass_hook_trust never sees the user's hooks.
                isolatedCodexHome: path.resolve(env.MICHI_CODEX_FOLLOW_UPS_HOOK_HOME
                    || path.join(env.MICHI_DATA_DIR || path.join(os.homedir(), ".michi"), "codex-follow-ups-hook-poc")),
            },
        } : {}),
    };
}

/**
 * Filter RUNTIME_FACTORIES by the MICHI_ENABLED_RUNTIMES env var (comma
 * separated runtime ids). Unset → every factory (current default; local
 * dev keeps its kiro+pi+claude lineup). Set → only listed runtimes are
 * instantiated, which is what Pi-only / Claude-only containers want so
 * we don't even construct AcpAgentRuntime (whose ensureClient would later
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
