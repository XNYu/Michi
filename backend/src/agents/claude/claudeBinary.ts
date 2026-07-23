import { spawn, execSync, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

let _cached: string | null = null;

export function findClaudeBinary(): string {
  if (_cached !== null) return _cached;

  const tried: string[] = [];

  // 1. Env override
  const envBin = process.env.CLAUDE_CLI_BIN;
  if (envBin) {
    tried.push(envBin);
    if (fs.existsSync(envBin)) {
      _cached = envBin;
      return _cached;
    }
  }

  // 2. which claude
  try {
    tried.push('<PATH lookup via which>');
    const result = execSync('which claude', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const trimmed = result.trim();
    if (trimmed && fs.existsSync(trimmed)) {
      _cached = trimmed;
      return _cached;
    }
  } catch {
    // not on PATH
  }

  // 3. Standard paths
  const standardPaths = [
    path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.toolbox', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];

  for (const candidate of standardPaths) {
    tried.push(candidate);
    if (fs.existsSync(candidate)) {
      _cached = candidate;
      return _cached;
    }
  }

  throw new ClaudeBinaryNotFoundError(
    `claude binary not found. Tried: ${tried.join(', ')}. ` +
      'Install with: npm install -g @anthropic-ai/claude-code, or set CLAUDE_CLI_BIN.',
  );
}

/**
 * Best-effort pre-flight: fast-fail when there is OBVIOUSLY no usable auth,
 * so we don't leave a headless claude process hanging on a stdin auth prompt.
 *
 * Authoritative auth lives inside the claude binary itself (OAuth, keychain,
 * Bedrock auto-detect on AWS_PROFILE, Vertex, etc). We don't try to mirror
 * that detection — we just look for a credible signal that SOMETHING is set
 * and let claude make the final call.
 */
export function preflightClaudeAuth(configDir?: string): void {
  // Direct Anthropic API key — non-empty.
  if (process.env.ANTHROPIC_API_KEY) return;

  // Explicit Bedrock opt-in, must come with creds.
  if (process.env.CLAUDE_CODE_USE_BEDROCK === '1') {
    if (!process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE) {
      throw new ClaudeAuthMissingError(
        'CLAUDE_CODE_USE_BEDROCK=1 but neither AWS_ACCESS_KEY_ID nor AWS_PROFILE is set',
      );
    }
    return;
  }

  // Explicit Vertex opt-in, must come with creds.
  if (process.env.CLAUDE_CODE_USE_VERTEX === '1') {
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.GCP_PROJECT) {
      throw new ClaudeAuthMissingError(
        'CLAUDE_CODE_USE_VERTEX=1 but neither GOOGLE_APPLICATION_CREDENTIALS nor GCP_PROJECT is set',
      );
    }
    return;
  }

  // Amazon-internal / toolbox-distributed claude binaries often auto-detect
  // Bedrock from AWS_PROFILE / AWS_ACCESS_KEY_ID without requiring
  // CLAUDE_CODE_USE_BEDROCK=1. Accept that signal as evidence of credible auth.
  if (process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID) return;

  // GCP equivalent (some Vertex-internal distros auto-detect).
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GCP_PROJECT) return;

  // OAuth path — claude stores creds under its config dir after `claude /login`.
  // Different versions use different filenames; presence of the directory
  // plus a settings.json or session-env is a reasonable proxy. Must check the
  // SAME dir the spawned process will use: an explicit override first, then an
  // inherited CLAUDE_CONFIG_DIR, then claude's default ~/.claude.
  const claudeDir =
    configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
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

export function buildClaudeArgv(args: SpawnClaudeArgs): string[] {
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
  preflightClaudeAuth(args.configDir);
  const binary = findClaudeBinary();
  const argv = buildClaudeArgv(args);
  const child = spawn(binary, argv, {
    cwd: args.cwd,
    env: {
      ...process.env,
      ...(args.configDir ? { CLAUDE_CONFIG_DIR: args.configDir } : {}),
      ...args.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: args.signal,
  });
  return child;
}
