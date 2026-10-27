import type { RuntimeHost } from 'michi-runtime';
import {
  DEFAULT_CLAUDE_CLI_FLAGS, DEFAULT_CLAUDE_LIMITS, claudeAdapterOptions,
  type ClaudeAdapterOptions, type ClaudeCliFlags, type ClaudeLimits, type ClaudeModelCatalogOptions,
} from 'michi-runtime/internal/adapters/claude/claudeAdapterOptions';
import type { ClaudeProfileOptions } from 'michi-runtime/internal/adapters/claude/claudeProjectsPath';
import * as agentConfig from '../services/agentConfig';
import * as assistantPolicy from '../assistant/policy';
import * as claudeHostText from './hostText/claude';
import { claudeStderrWarning } from './hostText/claude';

/**
 * The Claude adapter's options in Michi, through the package's
 * claudeAdapterOptions: the runtime host's ports, the live model catalog for
 * the runtime the factory registers, Michi's environment settings, read here
 * so the adapter reads none itself (an unset one takes the package's
 * default), and Michi's config directory, assistant tool verdicts and
 * product text. Each setting is read when the adapter used to read it: the
 * limits now, the other functions on every call. Calls go through the module
 * objects, so test stubs of those functions (t.mock.method) still apply.
 * Tests that build a Claude runtime or session directly use this too, so
 * they run with what production passes.
 */
export function michiClaudeAdapterOptions(host: RuntimeHost, modelCatalog?: ClaudeModelCatalogOptions): ClaudeAdapterOptions {
  return claudeAdapterOptions({
    host,
    modelCatalog,
    // The live environment itself: credentials stay in the child's env.
    spawnEnv: () => process.env,
    binaryPath: () => process.env.CLAUDE_CLI_BIN,
    limits: michiClaudeLimits(),
    cli: () => michiClaudeCliFlags(),
    followUpsHookPoc: () => isClaudeFollowUpsHookPocEnabled(),
    stderrWarning: claudeStderrWarning,
    configDir: (userId) => agentConfig.resolveClaudeConfigDir(userId ?? undefined),
    // The assistant's own Michi tools, as assistant/policy.ts allows them (Desk tools only while Desk is on).
    restrictedToolApproval: (hostToolName) => assistantPolicy.claudeAssistantApproval(hostToolName),
    hostText: {
      followUpsHookPocInstruction: (mode) => claudeHostText.buildClaudeFollowUpsHookPocInstruction(mode),
    },
  });
}

/**
 * Michi's Claude profile, for app code that reads Claude's own files (Agent
 * Desk's continue): the factory's options over a new Michi host. The host
 * module loads on first use, so importing this leaves boot order alone.
 */
export function michiClaudeProfile(): ClaudeProfileOptions {
  const { createMichiRuntimeHost } = require('./michiRuntimeHost') as typeof import('./michiRuntimeHost');
  return michiClaudeAdapterOptions(createMichiRuntimeHost());
}

export const CLAUDE_FOLLOW_UPS_HOOK_POC_ENV = 'MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isClaudeFollowUpsHookPocEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ENABLED_VALUES.has((env[CLAUDE_FOLLOW_UPS_HOOK_POC_ENV] ?? '').trim().toLowerCase());
}

/** A switch in the environment: `unset` while the variable is unset, else what `read` makes of its value. */
function envSwitch(name: string, unset: boolean, read: (value: string) => boolean): boolean {
  const value = process.env[name];
  return value === undefined ? unset : read(value);
}

/** MICHI_CLAUDE_* limits, parsed as ClaudeRuntime and ClaudeSession parsed them; unset, the package's defaults. */
function michiClaudeLimits(): ClaudeLimits {
  const defaults = DEFAULT_CLAUDE_LIMITS;
  // Default 60s — claude's SessionStart hooks can take 10-20s on heavily-loaded
  // configs (financial-services, superpowers, etc). 5s was too aggressive in
  // real-world envs. Native restore uses the same deadline. Invalid values
  // fall back to the default.
  const configuredInitTimeoutMs = Number(process.env.MICHI_CLAUDE_INIT_TIMEOUT_MS ?? String(defaults.initTimeoutMs));
  return {
    maxConcurrent: parseInt(process.env.MICHI_CLAUDE_MAX_CONCURRENT ?? String(defaults.maxConcurrent), 10),
    pool: {
      disabled: envSwitch('MICHI_CLAUDE_POOL_DISABLED', defaults.pool.disabled, (value) => value === '1'),
      sessionsPerCwd: parseInt(process.env.MICHI_CLAUDE_POOL_SESSIONS_PER_CWD ?? String(defaults.pool.sessionsPerCwd), 10),
      waitForWarm: envSwitch('MICHI_CLAUDE_WAIT_FOR_WARM', defaults.pool.waitForWarm,
        (value) => !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase())),
    },
    initTimeoutMs: Number.isInteger(configuredInitTimeoutMs)
      && configuredInitTimeoutMs > 0 && configuredInitTimeoutMs <= 2_147_483_647
      ? configuredInitTimeoutMs : defaults.initTimeoutMs,
    approveTimeoutMs: parseInt(process.env.MICHI_APPROVE_TIMEOUT_MS ?? String(defaults.approveTimeoutMs), 10),
    disposeTermTimeoutMs: parseInt(process.env.MICHI_CLAUDE_DISPOSE_TERM_TIMEOUT_MS ?? String(defaults.disposeTermTimeoutMs), 10),
    disposeKillTimeoutMs: parseInt(process.env.MICHI_CLAUDE_DISPOSE_KILL_TIMEOUT_MS ?? String(defaults.disposeKillTimeoutMs), 10),
  };
}

/** MICHI_CLAUDE_* CLI switches, read at each spawn; unset, the package's defaults. */
function michiClaudeCliFlags(): ClaudeCliFlags {
  const defaults = DEFAULT_CLAUDE_CLI_FLAGS;
  return {
    // Bare mode skips SessionStart hooks, plugins, skills, MCP auto-discovery.
    // Without it, configs with many plugins (financial-services, superpowers)
    // take 10-20s to emit system/init. Tests / CI / smoke runs opt in.
    bare: envSwitch('MICHI_CLAUDE_BARE', defaults.bare, (value) => value === '1'),
    // Lock chats to Michi's MCP server alone, e.g. for multi-tenant deploys
    // where host MCP must not leak in. Default: Claude auto-discovers the
    // user's own MCP servers.
    strictMcp: envSwitch('MICHI_CLAUDE_STRICT_MCP', defaults.strictMcp, (value) => value === '1'),
    // On by default; 0 disables it (an older binary that rejects the flag,
    // or to keep the parent stream lean).
    forwardSubagentText: envSwitch('MICHI_CLAUDE_SUBAGENT_TEXT', defaults.forwardSubagentText, (value) => value !== '0'),
    humanOrigin: envSwitch('MICHI_CLAUDE_HUMAN_ORIGIN', defaults.humanOrigin, (value) => value !== '0'),
  };
}
