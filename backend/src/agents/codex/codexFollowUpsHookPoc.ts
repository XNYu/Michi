import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FollowUpsExperimentMode } from '../followUpsExperiment';
import { resolveFollowUpsExperimentMode } from '../followUpsExperiment';
import { buildCodexTurnMetadataInstruction } from './codexTurnMetadata';

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
  enableFollowUps: boolean = true,
): string {
  return `${buildCodexTurnMetadataInstruction(mode, enableFollowUps)}
- Do not call the Stop-hook validator yourself; Michi invokes it automatically.`;
}

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
