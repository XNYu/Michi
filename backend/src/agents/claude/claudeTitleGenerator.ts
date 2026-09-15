import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { findClaudeBinary, preflightClaudeAuth } from './claudeBinary';
import { resolveClaudeCliModelId } from './claudeModelCatalog';
import { spawnAgentProcess, killProcessTree } from '../processTree';
import { resolveClaudeConfigDir } from '../../services/agentConfig';
import { getMichiDataDir } from '../../services/dataDir';
import {
  TITLE_INSTRUCTIONS,
  MAX_TITLE_INPUT_CHARS,
  cleanGeneratedTitle,
  truncateChars,
  withTitleTimeout,
} from '../../services/titleGeneration';

export interface ClaudeTitleGeneratorOptions {
  /** Michi alias or concrete id; `haiku` resolves through the model catalog. */
  model: string;
  timeoutMs: number;
  /** Override the neutral cwd (tests). Defaults to an empty folder under the Michi data dir. */
  cwd?: string;
  /** Test seam. */
  spawn?: (binary: string, argv: string[], cwd: string) => ChildProcessWithoutNullStreams;
}

/**
 * The title process runs in an empty, stable folder: no CLAUDE.md or project
 * settings leak in, and the CLI's per-project bookkeeping stays in one place.
 * (The OS temp dir is deliberately not used — the toolbox-distributed CLI
 * stalled for well over a minute when launched there.)
 */
export function defaultClaudeTitleCwd(): string {
  const dir = path.join(getMichiDataDir(), 'title-cwd');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Argv for a stateless `claude --print` call that only returns text.
 * `--bare` skips hooks/plugins/CLAUDE.md discovery, `--tools ""` removes
 * every built-in tool so the model cannot wander off into the filesystem,
 * and `--no-session-persistence` keeps the title turn out of `~/.claude`.
 * The prompt itself is written to stdin so it never hits argv length limits.
 */
export function buildClaudeTitleArgv(model: string): string[] {
  return [
    '--print',
    '--output-format', 'text',
    '--bare',
    '--no-session-persistence',
    '--permission-mode', 'plan',
    '--tools', '',
    '--effort', 'low',
    '--model', resolveClaudeCliModelId(model),
    '--append-system-prompt', TITLE_INSTRUCTIONS,
  ];
}

function defaultSpawn(binary: string, argv: string[], cwd: string): ChildProcessWithoutNullStreams {
  const configDir = resolveClaudeConfigDir();
  return spawnAgentProcess(binary, argv, {
    cwd,
    env: {
      ...process.env,
      ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
    },
  });
}

/**
 * One-shot title generation on a cheap Claude model. A fresh process per
 * title costs a few seconds of CLI start-up but avoids the history growth and
 * busy-session races that a long-lived title session would need to manage.
 */
export async function generateClaudeTitle(userText: string, opts: ClaudeTitleGeneratorOptions): Promise<string> {
  preflightClaudeAuth(resolveClaudeConfigDir());
  const binary = findClaudeBinary();
  const spawn = opts.spawn ?? defaultSpawn;
  const cwd = opts.cwd ?? defaultClaudeTitleCwd();

  return withTitleTimeout(async (signal) => {
    const child = spawn(binary, buildClaudeTitleArgv(opts.model), cwd);
    const kill = () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { killProcessTree(child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    };
    signal.addEventListener('abort', kill, { once: true });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });

    child.stdin.on('error', () => { /* child exited before reading stdin */ });
    child.stdin.end(`USER MESSAGE:\n${truncateChars(userText, MAX_TITLE_INPUT_CHARS)}`);

    try {
      const code = await exited;
      const title = cleanGeneratedTitle(stdout);
      if (code !== 0 && !title) {
        throw new Error(`claude exited with code ${code}: ${stderr.trim().split('\n').pop() ?? ''}`);
      }
      return title;
    } finally {
      signal.removeEventListener('abort', kill);
    }
  }, opts.timeoutMs, 'claude title generation');
}
