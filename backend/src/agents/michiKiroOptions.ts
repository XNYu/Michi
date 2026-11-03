import type { KiroAdapterOptions } from "michi-runtime/internal/adapters/kiro/AcpAgentRuntime";
import type { CrewAdapterOptions } from "michi-runtime/internal/adapters/crew/crewLaunch";

// Michi's environment settings for the Kiro and Crew adapters, read here so
// the adapters read none themselves, each when the adapter used to read it.
// Type imports only: loading this module loads no adapter.

// These four were module constants of AcpAgentRuntime and AcpClient, read when
// those modules loaded, before server.ts loads backend/.env. They stay module
// constants: this module loads at the same point (runtimeFactories and
// routes/crew import it statically), so backend/.env still does not set them.
const KIRO_PROCESS_CAP = parseInt(process.env.MICHI_KIRO_MAX_PROCESSES ?? "20", 10);
const KIRO_IDLE_TTL_MS = parseInt(process.env.MICHI_KIRO_IDLE_TTL_MS ?? "300000", 10);
const KIRO_WARM_POOL_SIZE = parseInt(process.env.MICHI_KIRO_WARM_POOL_SIZE ?? "3", 10);
const KIRO_ACP_IDLE_TIMEOUT_MS = (() => {
    const raw = process.env.ACP_TIMEOUT_MS;
    if (raw === undefined) return 180_000;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return 180_000;
    return n; // 0 is allowed and means "no timeout"
})();

/**
 * The KiroAdapterOptions Michi takes from its environment, for Kiro and Crew
 * (Crew pins its own engine). Besides the module constants above, the
 * concurrency cap is read when the runtime is created, as AcpAgentRuntime's
 * constructor read it; the functions are called where the adapter read the
 * variable (each question, catalog, kiro-cli lookup and spawn, where the
 * tool-preload switch was read off the spawn environment).
 */
export function kiroEnvOptions(): Omit<KiroAdapterOptions, "host" | "engine"> {
    return {
        processCap: KIRO_PROCESS_CAP,
        idleTtlMs: KIRO_IDLE_TTL_MS,
        warmPoolSize: KIRO_WARM_POOL_SIZE,
        acpIdleTimeoutMs: KIRO_ACP_IDLE_TIMEOUT_MS,
        concurrencyCap: parseInt(process.env.MICHI_KIRO_MAX_CONCURRENT ?? "100", 10),
        approveTimeoutMs: () => parseInt(process.env.MICHI_APPROVE_TIMEOUT_MS ?? "300000", 10),
        customAgents: () => process.env.MICHI_CUSTOM_AGENTS === "1",
        kiroCli: () => ({ kiroCliBin: process.env.KIRO_CLI_BIN, localAppData: process.env.LOCALAPPDATA }),
        spawnEnv: () => process.env,
        preloadTools: () => process.env.MICHI_KIRO_PRELOAD_TOOLS !== "false",
    };
}

/**
 * Where Michi's environment puts the Crew adapter and App. Read on every
 * call, as crewLaunch read it: setting MICHI_CREW_ACP_BIN or installing the
 * App after Michi started takes effect without a restart.
 */
export function crewEnvOptions(): CrewAdapterOptions {
    return {
        acpBinOverride: process.env.MICHI_CREW_ACP_BIN,
        kirocrewHome: process.env.KIROCREW_HOME,
        appName: process.env.MICHI_CREW_APP,
    };
}
