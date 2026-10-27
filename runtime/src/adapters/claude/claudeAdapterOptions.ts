import type { RuntimeWarning } from 'michi-shared';
import type { FollowUpsExperimentMode, RuntimeHost } from '../../contract/host';
import type { ModelInfo } from '../../contract/types';
import type { RuntimeModelCache } from '../../core/runtimeModelCache';

/**
 * Lists the models the current account can use. Declared here rather than
 * beside the default probe (claudeModelProbe), whose module uses the SDK's
 * types, so that the declarations of ./adapters/claude reach none of them.
 */
export type ClaudeModelProbe = () => Promise<ModelInfo[]>;

/**
 * Live model catalog wiring. Omitted (tests, legacy callers) → listModels()
 * serves the static CLAUDE_MODEL_CATALOG and never spawns the CLI.
 */
export interface ClaudeModelCatalogOptions {
  /** Persistent snapshot store shared with the other CLI runtimes. */
  cache?: RuntimeModelCache;
  /** Defaults to asking the installed CLI via `initialize`. */
  probe?: ClaudeModelProbe;
}

/** Process and pool limits, read when the runtime and its sessions are created. */
export interface ClaudeLimits {
  /** Claude processes at most, active, warm and starting together (Michi: 15). */
  maxConcurrent: number;
  pool: {
    /** No warm processes: every chat cold-spawns. */
    disabled: boolean;
    /** Warm processes kept per (cwd, model) (Michi: 2). */
    sessionsPerCwd: number;
    /** A chat waits for a warm process still starting instead of cold-spawning (Michi: true). */
    waitForWarm: boolean;
  };
  /** Deadline for system/init after a native restore, in ms: a positive integer up to 2^31 - 1 (Michi: 60000). */
  initTimeoutMs: number;
  /** How long a permission request or question waits for its answer, in ms (Michi: 300000). */
  approveTimeoutMs: number;
  /** Wait for the process to exit after SIGINT before SIGKILL, and for its MCP slot cleanup, in ms (Michi: 2000). */
  disposeTermTimeoutMs: number;
  /** Wait for the exit after SIGKILL, in ms (Michi: 1000). */
  disposeKillTimeoutMs: number;
}

/** Claude Code CLI switches, read at each spawn (humanOrigin at each prompt). */
export interface ClaudeCliFlags {
  /** --bare for chats (Agent Runs always run bare, the Stop-hook POC never does). */
  bare: boolean;
  /** --strict-mcp-config for chats too: only the host's MCP server (Agent Runs always have it). */
  strictMcp: boolean;
  /** --forward-subagent-text, for the live subagent roster. */
  forwardSubagentText: boolean;
  /** Mark prompts a person typed as human-origin, which gates the CLI's prompt keywords. */
  humanOrigin: boolean;
}

/** Wording the Claude adapter adds for the host. Each absent member adds nothing. */
export interface ClaudeHostText {
  /**
   * Turn-metadata rules appended to the system prompt under the Stop-hook POC.
   * @experimental Follow-ups Stop-hook POC; outside the v1 compatibility guarantee.
   */
  followUpsHookPocInstruction?(mode: FollowUpsExperimentMode): string;
}

/** What the Claude adapter takes from the application that embeds it. */
export interface ClaudeAdapterOptions {
  /**
   * The host's ports. ClaudeRuntime requires backgroundTurns, workflows and
   * backgroundSubagents besides the mandatory ones.
   */
  host: RuntimeHost;
  /**
   * Live model catalog. Any object turns it on, an empty one included; when
   * absent, listModels serves the static catalog and never probes the CLI.
   */
  modelCatalog?: ClaudeModelCatalogOptions;
  /**
   * The environment every claude process starts from, read at each spawn,
   * auth preflight and model probe. The adapter only checks its credentials
   * (ANTHROPIC_API_KEY, the Bedrock and Vertex switches, AWS and Google
   * credentials) for presence and hands them to the child, and takes its
   * CLAUDE_CONFIG_DIR as the profile when configDir sets none.
   */
  spawnEnv: () => NodeJS.ProcessEnv;
  /**
   * Claude's config directory override; undefined keeps the environment's
   * CLAUDE_CONFIG_DIR, then ~/.claude. Auth preflight, spawn, the model probe
   * and the projects path all read this one function, or transcript reads
   * point at another profile's history. Default: no override.
   */
  configDir?: (userId?: string | null) => string | undefined;
  /** An explicit claude executable, read at the first lookup; else PATH and the usual install locations. */
  binaryPath: () => string | undefined;
  limits: ClaudeLimits;
  cli: () => ClaudeCliFlags;
  /**
   * Run the Stop-hook POC for turn metadata. Read when the session manager and each session are created.
   * @experimental Follow-ups Stop-hook POC; outside the v1 compatibility guarantee.
   */
  followUpsHookPoc: () => boolean;
  /**
   * A warning for what a claude process wrote to stderr, or undefined. A
   * session shows each warning message once.
   */
  stderrWarning?: (stderr: string) => RuntimeWarning | undefined;
  /**
   * Verdict on a tool call of a restricted session (SessionProfilePort.isRestricted);
   * `hostToolName` is the bare name of a host tool, or null for any other tool.
   * Default: deny every call.
   */
  restrictedToolApproval?: (hostToolName: string | null) => 'allow' | 'deny';
  hostText?: ClaudeHostText;
}

/** The limits claudeAdapterOptions gives a host that sets none, Michi's own. Frozen, pool included. */
export const DEFAULT_CLAUDE_LIMITS: Readonly<Omit<ClaudeLimits, 'pool'>> & { readonly pool: Readonly<ClaudeLimits['pool']> } = Object.freeze({
  maxConcurrent: 15,
  pool: Object.freeze({ disabled: false, sessionsPerCwd: 2, waitForWarm: true }),
  initTimeoutMs: 60_000,
  approveTimeoutMs: 300_000,
  disposeTermTimeoutMs: 2000,
  disposeKillTimeoutMs: 1000,
});

/**
 * The CLI switches claudeAdapterOptions gives a host that sets none, Michi's
 * own: chats neither bare nor strict, so Claude also loads the user's MCP
 * servers (a restricted session is strict whatever this says); subagent text
 * and human-origin prompts on. Frozen.
 */
export const DEFAULT_CLAUDE_CLI_FLAGS: Readonly<ClaudeCliFlags> = Object.freeze({
  bare: false,
  strictMcp: false,
  forwardSubagentText: true,
  humanOrigin: true,
});

/** ClaudeAdapterOptions with only the host and the child's environment required. */
export type ClaudeAdapterOptionsInput =
  Pick<ClaudeAdapterOptions, 'host' | 'spawnEnv'> & Partial<Omit<ClaudeAdapterOptions, 'host' | 'spawnEnv'>>;

/**
 * The adapter's options with every required member defaulted, for
 * `new ClaudeRuntime({ ...claudeAdapterOptions({ host, spawnEnv }), bridge, mcpSlots })`.
 * A required member left out or given as undefined takes its default: limits
 * a copy of DEFAULT_CLAUDE_LIMITS, cli a copy of DEFAULT_CLAUDE_CLI_FLAGS at
 * each call, no explicit binary, the Stop-hook POC off. An optional member
 * left out or given as undefined stays absent, so the adapter's own default
 * applies. spawnEnv is passed on as given: it decides which credentials the
 * agent sees.
 */
export function claudeAdapterOptions(input: ClaudeAdapterOptionsInput): ClaudeAdapterOptions {
  return {
    host: input.host,
    ...(input.modelCatalog !== undefined ? { modelCatalog: input.modelCatalog } : {}),
    spawnEnv: input.spawnEnv,
    binaryPath: input.binaryPath ?? (() => undefined),
    limits: input.limits ?? { ...DEFAULT_CLAUDE_LIMITS, pool: { ...DEFAULT_CLAUDE_LIMITS.pool } },
    cli: input.cli ?? (() => ({ ...DEFAULT_CLAUDE_CLI_FLAGS })),
    followUpsHookPoc: input.followUpsHookPoc ?? (() => false),
    ...(input.stderrWarning !== undefined ? { stderrWarning: input.stderrWarning } : {}),
    ...(input.configDir !== undefined ? { configDir: input.configDir } : {}),
    ...(input.restrictedToolApproval !== undefined ? { restrictedToolApproval: input.restrictedToolApproval } : {}),
    ...(input.hostText !== undefined ? { hostText: input.hostText } : {}),
  };
}
