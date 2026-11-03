import type { AgentCapabilities } from '../../contract/types';
import type { AcpLaunch } from '../kiro/acpClient';
import { AcpAgentRuntime, type KiroRuntimeOptions } from '../kiro/AcpAgentRuntime';
import { ANTIGRAVITY_DESCRIPTOR_OVERRIDE } from './antigravityDescriptor';
import { ANTIGRAVITY_KIRO_FLAVOR } from './antigravityFlavor';
import { antigravityAvailability, resolveAntigravityLaunch, type AntigravityAdapterOptions } from './antigravityLaunch';

/**
 * AcpAgentRuntime's options less those the Antigravity preset pins, and less
 * isolatedSession, which only a v3 runtime reads. kiroCli, spawnEnv and
 * preloadTools do not apply: agy is a custom launch, whose process inherits
 * this process's environment unchanged.
 */
export interface AntigravityRuntimeOptions extends Omit<KiroRuntimeOptions,
    'engine' | 'isolatedSession' | 'id' | 'label' | 'flavor' | 'launch' | 'sidecarTitles'
    | 'descriptorOverride' | 'capabilitiesOverride' | 'checkAvailability'> {
    /**
     * Where agy is. A function is called at each spawn and availability
     * check, so installing agy after start takes effect without a restart.
     * Default {}: nothing resolves.
     */
    antigravity?: AntigravityAdapterOptions | (() => AntigravityAdapterOptions);
}

/** Merged over Kiro's capabilities. */
const ANTIGRAVITY_CAPABILITIES: Partial<AgentCapabilities> = {
    // No ACP route to agy's planning or accept-edits modes.
    modes: false,
    permissions: true,
    // The session's `model` config option.
    models: true,
    // The session's `thought_level` config option; agy rejects anything above high.
    reasoning: true,
    supportedReasoningLevels: ['low', 'medium', 'high'],
    // A session's system prompt is its chat's own.
    warmSessions: false,
    nativeResume: true,
    // Kept: nativeResumeSettings (agy forgets model and reasoning on
    // session/load, so both are applied again), saveContext and
    // spawnBranches (Michi's MCP tools).
};

/**
 * Placeholder when agy does not resolve at spawn time. AcpAgentRuntime never
 * reaches it while antigravityAvailability() is false; if agy vanishes later,
 * the child exits at once with a readable stderr line instead of a spawn ENOENT.
 */
const MISSING_ANTIGRAVITY_LAUNCH: AcpLaunch = {
    bin: process.execPath,
    args: () => ["-e", "process.stderr.write('Antigravity CLI (agy) not found; set MICHI_ANTIGRAVITY_BIN\\n'); process.exit(1)"],
};

/**
 * Resolved at each spawn, not at construction, so installing agy or setting
 * binPath after start takes effect without a restart. AcpClient reads `bin`
 * once in its constructor and calls `args` once per start.
 */
function lazyAntigravityLaunch(locations: () => AntigravityAdapterOptions): AcpLaunch {
    const resolve = () => resolveAntigravityLaunch(locations()) ?? MISSING_ANTIGRAVITY_LAUNCH;
    return {
        standardAcp: true,
        get bin() {
            return resolve().bin;
        },
        // agy takes its model through the session's config option, not argv.
        args: () => resolve().args(),
        cancelTimeoutMs: 10_000,
    };
}

/**
 * Antigravity's `agy acp` as an AcpAgentRuntime with id `antigravity`. The preset
 * pins engine v2 (one agy process per cwd, sessions multiplexed), the
 * standard-ACP launch, Antigravity's flavor, descriptor and capabilities, no
 * sidecar titles (agy titles sessions itself) and an offline check that agy
 * resolves: while it fails, the runtime refuses to spawn agy at all. The
 * pinned members win over the same members of `options`, from untyped
 * callers too. A launch override also keeps the Meta agent off Antigravity.
 */
export function createAntigravityRuntime(options: AntigravityRuntimeOptions): AcpAgentRuntime {
    const { antigravity, ...rest } = options;
    const locations = typeof antigravity === 'function' ? antigravity : () => antigravity ?? {};
    return new AcpAgentRuntime({
        ...rest,
        engine: 'v2',
        id: 'antigravity',
        label: 'Antigravity',
        flavor: ANTIGRAVITY_KIRO_FLAVOR,
        launch: lazyAntigravityLaunch(locations),
        sidecarTitles: false,
        descriptorOverride: ANTIGRAVITY_DESCRIPTOR_OVERRIDE,
        capabilitiesOverride: ANTIGRAVITY_CAPABILITIES,
        checkAvailability: () => antigravityAvailability(locations()),
    });
}
