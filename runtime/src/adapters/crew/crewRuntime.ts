import type { AgentCapabilities } from '../../contract/types';
import type { AcpLaunch } from '../kiro/acpClient';
import { KiroRuntime, type KiroRuntimeOptions } from '../kiro/KiroRuntime';
import { CREW_DESCRIPTOR_OVERRIDE } from './crewDescriptor';
import { CREW_KIRO_FLAVOR } from './crewFlavor';
import { crewAvailability, resolveCrewAcpLaunch, type CrewAdapterOptions } from './crewLaunch';

/**
 * KiroRuntime's options less those the Crew preset pins, and less
 * isolatedSession, which the preset leaves alone: only a v3 runtime reads it,
 * and the preset pins v2. kiroCli, spawnEnv and preloadTools do not apply:
 * the Crew adapter is a custom launch, whose process inherits this process's
 * environment unchanged.
 */
export interface CrewRuntimeOptions extends Omit<KiroRuntimeOptions,
    'engine' | 'isolatedSession' | 'id' | 'label' | 'flavor' | 'launch' | 'sidecarTitles'
    | 'descriptorOverride' | 'capabilitiesOverride' | 'checkAvailability'> {
    /**
     * Where the Crew adapter and App are. A function is called at each spawn
     * and availability check, so an adapter built or an App installed after
     * start takes effect without a restart. Default {}: the adapter bundled
     * next to this module, Kiro Crew's home ~/.kiro/crew and its App
     * michi-crew-runtime.
     */
    crew?: CrewAdapterOptions | (() => CrewAdapterOptions);
}

/** Merged over Kiro's capabilities. */
const CREW_CAPABILITIES: Partial<AgentCapabilities> = {
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
};

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
 * Resolved at each spawn, not at construction, so building the adapter
 * bundle or setting acpBinOverride after start takes effect without a
 * restart. AcpClient reads `bin` once in its constructor and calls `args`
 * once per start.
 */
function lazyCrewLaunch(locations: () => CrewAdapterOptions): AcpLaunch {
    const resolve = () => resolveCrewAcpLaunch(locations()) ?? MISSING_CREW_LAUNCH;
    return {
        standardFork: true,
        get bin() {
            return resolve().bin;
        },
        args: (model) => resolve().args(model),
        // Gateway can keep a stopped slot draining for several seconds (6.8s in
        // the live probe); give the adapter's 10s idle wait room to finish.
        cancelTimeoutMs: 15_000,
    };
}

/**
 * Kiro Crew through its ACP adapter, as a KiroRuntime with id `crew`. The
 * preset pins engine v2 (one adapter process per cwd, sessions multiplexed;
 * a v3 setting elsewhere must not flip Crew to per-session workers), Crew's
 * flavor, descriptor and capabilities, no sidecar titles (the sidecar would
 * open an extra Crew session per chat title), the adapter as the agent
 * process, and Crew's offline availability check: while it fails, the
 * runtime refuses to spawn the adapter at all. The pinned members win over
 * the same members of `options`, from untyped callers too.
 *
 * mcpSlots' endpoints must have the one shape the Crew App's relay accepts,
 * http://127.0.0.1:<port>/api/mcp/<slot> with no headers. That is not
 * checked here: the adapter refuses any other endpoint when it binds a
 * session's slot.
 */
export function createCrewRuntime(options: CrewRuntimeOptions): KiroRuntime {
    const { crew, ...rest } = options;
    const locations = typeof crew === 'function' ? crew : () => crew ?? {};
    return new KiroRuntime({
        ...rest,
        engine: 'v2',
        id: 'crew',
        label: 'Kiro Crew',
        flavor: CREW_KIRO_FLAVOR,
        launch: lazyCrewLaunch(locations),
        sidecarTitles: false,
        descriptorOverride: CREW_DESCRIPTOR_OVERRIDE,
        capabilitiesOverride: CREW_CAPABILITIES,
        checkAvailability: () => crewAvailability(locations()),
    });
}
