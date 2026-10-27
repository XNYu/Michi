import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveNamedBinary } from '../../core/executableLookup';
import { spawnAgentProcess } from '../../core/processTree';
import { resolveClaudeCliModelId } from './claudeModelCatalog';

export class ClaudeBinaryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeBinaryNotFoundError';
  }
}

export class ClaudeAuthMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeAuthMissingError';
  }
}

export class ClaudeInitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeInitTimeoutError';
  }
}

export interface SpawnClaudeArgs {
  cwd: string;
  sessionId?: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  model?: string;
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  /**
   * Built-in tools the session has (--tools). An empty list removes every
   * built-in tool and keeps MCP tools; undefined keeps the CLI default.
   */
  tools?: readonly string[];
  /** Tools denied outright (--disallowedTools). Deny rules hold in every permission mode. */
  disallowedTools?: readonly string[];
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  mcpConfigInline: string;
  strictMcpConfig?: boolean;
  permissionPromptTool?: string;
  /** Inline Claude settings JSON, used by Michi-owned lifecycle hooks. */
  settingsInline?: string;
  /** Include hook_started/progress/response envelopes in stream-json output. */
  includeHookEvents?: boolean;
  /**
   * Forward each in-session subagent's text and thinking blocks as top-level
   * assistant/user envelopes tagged with `parent_tool_use_id` = the parent
   * `Task` tool_use id. Lets the translator reconstruct a live subagent roster
   * (who is running, on what, still working vs. done) instead of an opaque
   * final Task result. Requires a recent claude binary (2.1.x+). Widens the
   * main stream — every subagent token flows through the parent stream.
   */
  forwardSubagentText?: boolean;
  systemPromptAppend?: string;
  addDirs?: string[];
  /**
   * Skip claude auto-discovery (hooks, skills, plugins, MCP auto-detect,
   * CLAUDE.md). Anthropic recommends bare mode for scripted/SDK calls and
   * plans to make it the default for `-p` in a future release. Cuts startup
   * time from 10-20s (with plugins) to <1s. Required if SessionStart hooks
   * are slow enough to blow past the session init timeout.
   */
  bare?: boolean;
  /**
   * Claude config dir override — injected as CLAUDE_CONFIG_DIR into the child
   * env and used by the auth preflight. Unset = leave the env untouched so
   * claude uses its own default (~/.claude, or whatever the launch shell
   * exported). This moves claude's whole identity (OAuth, settings, plugins,
   * session storage), not just one setting.
   */
  configDir?: string;
  /**
   * The environment the child starts from (ClaudeAdapterOptions.spawnEnv).
   * The auth preflight reads its credentials for presence only.
   */
  spawnEnv: NodeJS.ProcessEnv;
  /** An explicit claude executable (ClaudeAdapterOptions.binaryPath). */
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

let _cached: string | null = null;

/** Clear the cached binary path. Call this between tests to avoid state leaking. */
export function resetClaudeBinaryCacheForTest(): void {
  _cached = null;
}

/** The claude executable: `binaryPath` when it exists, else PATH and the usual install locations. Cached once found. */
export function findClaudeBinary(binaryPath?: string): string {
  if (_cached !== null) return _cached;

  const { found, tried } = resolveNamedBinary('claude', {
    envValue: binaryPath,
  });
  if (found) {
    _cached = found;
    return _cached;
  }

  throw new ClaudeBinaryNotFoundError(
    `claude binary not found. Tried: ${tried.join(', ')}. ` +
      'Install with: npm install -g @anthropic-ai/claude-code, irm https://claude.ai/install.ps1 | iex, or set CLAUDE_CLI_BIN.',
  );
}

/**
 * Best-effort pre-flight: fast-fail when there is OBVIOUSLY no usable auth,
 * so we don't leave a headless claude process hanging on a stdin auth prompt.
 *
 * Authoritative auth lives inside the claude binary itself (OAuth, keychain,
 * Bedrock auto-detect on AWS_PROFILE, Vertex, etc). We don't try to mirror
 * that detection — we just look for a credible signal that SOMETHING is set
 * in `env`, the environment the child will get, and let claude make the
 * final call. Values are only tested for presence, never read out.
 */
export function preflightClaudeAuth(configDir: string | undefined, env: NodeJS.ProcessEnv): void {
  // Direct Anthropic API key — non-empty.
  if (env.ANTHROPIC_API_KEY) return;

  // Explicit Bedrock opt-in, must come with creds.
  if (env.CLAUDE_CODE_USE_BEDROCK === '1') {
    if (!env.AWS_ACCESS_KEY_ID && !env.AWS_PROFILE) {
      throw new ClaudeAuthMissingError(
        'CLAUDE_CODE_USE_BEDROCK=1 but neither AWS_ACCESS_KEY_ID nor AWS_PROFILE is set',
      );
    }
    return;
  }

  // Explicit Vertex opt-in, must come with creds.
  if (env.CLAUDE_CODE_USE_VERTEX === '1') {
    if (!env.GOOGLE_APPLICATION_CREDENTIALS && !env.GCP_PROJECT) {
      throw new ClaudeAuthMissingError(
        'CLAUDE_CODE_USE_VERTEX=1 but neither GOOGLE_APPLICATION_CREDENTIALS nor GCP_PROJECT is set',
      );
    }
    return;
  }

  // Some Claude distributions auto-detect
  // Bedrock from AWS_PROFILE / AWS_ACCESS_KEY_ID without requiring
  // CLAUDE_CODE_USE_BEDROCK=1. Accept that signal as evidence of credible auth.
  if (env.AWS_PROFILE || env.AWS_ACCESS_KEY_ID) return;

  // GCP equivalent (some Vertex-internal distros auto-detect).
  if (env.GOOGLE_APPLICATION_CREDENTIALS || env.GCP_PROJECT) return;

  // OAuth path — claude stores creds under its config dir after `claude /login`.
  // Different versions use different filenames; presence of the directory
  // plus a settings.json or session-env is a reasonable proxy. Must check the
  // SAME dir the spawned process will use: an explicit override first, then an
  // inherited CLAUDE_CONFIG_DIR, then claude's default ~/.claude.
  const claudeDir =
    configDir || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  if (fs.existsSync(claudeDir)) {
    const candidates = ['auth.json', 'settings.json', 'session-env'];
    for (const f of candidates) {
      if (fs.existsSync(path.join(claudeDir, f))) return;
    }
  }

  throw new ClaudeAuthMissingError(
    'No claude auth found. Set ANTHROPIC_API_KEY, or run `claude /login`, or set CLAUDE_CODE_USE_BEDROCK=1 with AWS creds, or CLAUDE_CODE_USE_VERTEX=1 with GCP creds.',
  );
}

export function buildClaudeArgv(args: Omit<SpawnClaudeArgs, 'spawnEnv' | 'binaryPath'>): string[] {
  const argv: string[] = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--print',
    '--permission-mode', args.permissionMode ?? 'acceptEdits',
  ];

  if (args.includeHookEvents) {
    argv.push('--include-hook-events');
  }

  if (args.forwardSubagentText) {
    argv.push('--forward-subagent-text');
  }

  if (args.bare) {
    argv.push('--bare');
  }

  if (args.strictMcpConfig) {
    argv.push('--strict-mcp-config');
  }

  if (args.permissionPromptTool) {
    argv.push('--permission-prompt-tool', args.permissionPromptTool);
  }

  // Both flags are variadic; one comma-separated value keeps each a single
  // argument. `--tools ""` is the CLI's spelling of "no built-in tools".
  if (args.tools) {
    argv.push('--tools', args.tools.join(','));
  }

  if (args.disallowedTools && args.disallowedTools.length > 0) {
    argv.push('--disallowedTools', args.disallowedTools.join(','));
  }

  if (args.sessionId) {
    argv.push('--session-id', args.sessionId);
  }

  if (args.resumeSessionId) {
    argv.push('--resume', args.resumeSessionId);
  }

  if (args.forkSession) {
    argv.push('--fork-session');
  }

  if (args.model) {
    argv.push('--model', resolveClaudeCliModelId(args.model));
  }

  if (args.effort) {
    argv.push('--effort', args.effort);
  }

  if (args.systemPromptAppend) {
    argv.push('--append-system-prompt', args.systemPromptAppend);
  }

  if (args.settingsInline) {
    argv.push('--settings', args.settingsInline);
  }

  if (args.addDirs) {
    for (const dir of args.addDirs) {
      argv.push('--add-dir', dir);
    }
  }

  // D2: --mcp-config pushed last so its variadic consumption never eats positionals
  if (args.mcpConfigInline) {
    argv.push('--mcp-config', args.mcpConfigInline);
  }

  return argv;
}

export function spawnClaude(args: SpawnClaudeArgs): ChildProcessWithoutNullStreams {
  preflightClaudeAuth(args.configDir, args.spawnEnv);
  const binary = findClaudeBinary(args.binaryPath);
  const argv = buildClaudeArgv(args);
  return spawnAgentProcess(binary, argv, {
    cwd: args.cwd,
    env: {
      ...args.spawnEnv,
      ...(args.configDir ? { CLAUDE_CONFIG_DIR: args.configDir } : {}),
      ...args.env,
    },
    signal: args.signal,
  });
}
