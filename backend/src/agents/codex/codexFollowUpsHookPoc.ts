import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FollowUpsExperimentMode } from '../followUpsExperiment';
import { resolveFollowUpsExperimentMode } from '../followUpsExperiment';

export const CODEX_FOLLOW_UPS_HOOK_POC_ENV = 'MICHI_CODEX_FOLLOW_UPS_HOOK_POC';
export const CODEX_FOLLOW_UPS_HOOK_HOME_ENV = 'MICHI_CODEX_FOLLOW_UPS_HOOK_HOME';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isCodexFollowUpsHookPocEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ENABLED_VALUES.has(
    (env[CODEX_FOLLOW_UPS_HOOK_POC_ENV] ?? '').trim().toLowerCase(),
  );
}

export function buildCodexFollowUpsHookPocInstruction(
  mode: FollowUpsExperimentMode = resolveFollowUpsExperimentMode(),
): string {
  const followUpsInstruction = mode === 'hook-tool'
    ? `- Before ending every real user turn, call mcp____michi_internal____set_follow_ups exactly once.
- Pass {"follow_ups":["...","...","..."]}: exactly three concise questions written in the user's voice and language.
- Keep emitting the existing [FOLLOW-UP n/3: ...] sentinel lines as a fallback during this control mode.`
    : `- Do not call set_follow_ups. Follow-ups are delivered only through the three [FOLLOW-UP n/3: ...] sentinel lines.
- A strict sentinel reminder is appended to every real user turn.`;

  return `

Codex Stop-hook POC — structured turn metadata:
- Before ending every real user turn, call mcp____michi_internal____set_branch_overview exactly once.
- Pass {"overview":"..."}: 1-3 concise sentences describing what this branch is about and where it currently stands, matching the user's language.
- Keep emitting the existing [BRANCH-OVERVIEW: ...] sentinel as a fallback.
${followUpsInstruction}
- Do not call the Stop-hook validator yourself; Michi invokes it automatically.`;
}

export const CODEX_FOLLOW_UPS_HOOK_POC_INSTRUCTION =
  buildCodexFollowUpsHookPocInstruction('sentinel');

export interface CodexFollowUpsHookConfigOptions {
  runnerPath?: string;
  nodePath?: string;
}

/**
 * Build a per-thread App Server config overlay. Nothing here is written to
 * config.toml: Codex reports the hook source as `sessionFlags`.
 */
export function buildCodexFollowUpsHookPocConfig(
  slotId: string,
  port: number,
  options: CodexFollowUpsHookConfigOptions = {},
): Record<string, unknown> {
  if (!slotId) throw new Error('Codex follow-ups Hook POC requires an MCP slot id');
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid Codex follow-ups Hook POC port: ${port}`);
  }

  const runnerPath = path.resolve(
    options.runnerPath ?? path.join(__dirname, 'codexStopHookRunner.cjs'),
  );
  const nodePath = options.nodePath ?? process.execPath;
  const endpoint = `http://127.0.0.1:${port}/api/codex-hooks/${slotId}/stop`;

  const command = [
    'ELECTRON_RUN_AS_NODE=1',
    quotePosix(nodePath),
    quotePosix(runnerPath),
    quotePosix(endpoint),
  ].join(' ');
  const commandWindows = [
    'set "ELECTRON_RUN_AS_NODE=1"&&',
    quoteWindows(nodePath),
    quoteWindows(runnerPath),
    quoteWindows(endpoint),
  ].join(' ');

  return {
    features: { hooks: true },
    hooks: {
      Stop: [{
        hooks: [{
          type: 'command',
          command,
          commandWindows,
          timeout: 15,
          statusMessage: 'Validating structured follow-ups',
        }],
      }],
    },
    bypass_hook_trust: true,
  };
}

/**
 * Run the opt-in POC App Server under a Michi-owned CODEX_HOME so
 * `bypass_hook_trust` cannot accidentally enable the user's personal hooks.
 * Only auth.json is shared; config.toml, hooks.json, plugins, and project hook
 * trust state are deliberately not copied.
 */
export function prepareCodexFollowUpsHookPocEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sourceHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const michiDataDir = env.MICHI_DATA_DIR || path.join(os.homedir(), '.michi');
  const isolatedHome = path.resolve(
    env[CODEX_FOLLOW_UPS_HOOK_HOME_ENV]
      || path.join(michiDataDir, 'codex-follow-ups-hook-poc'),
  );

  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  shareAuthFile(sourceHome, isolatedHome);

  return {
    ...env,
    CODEX_HOME: isolatedHome,
  };
}

function shareAuthFile(sourceHome: string, isolatedHome: string): void {
  const sourceAuth = path.join(path.resolve(sourceHome), 'auth.json');
  const isolatedAuth = path.join(isolatedHome, 'auth.json');
  if (!fs.existsSync(sourceAuth) || path.resolve(sourceAuth) === path.resolve(isolatedAuth)) {
    return;
  }

  if (process.platform === 'win32') {
    fs.copyFileSync(sourceAuth, isolatedAuth);
    return;
  }

  try {
    const current = fs.lstatSync(isolatedAuth);
    if (current.isSymbolicLink() && fs.readlinkSync(isolatedAuth) === sourceAuth) return;
    fs.unlinkSync(isolatedAuth);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  fs.symlinkSync(sourceAuth, isolatedAuth);
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quoteWindows(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
