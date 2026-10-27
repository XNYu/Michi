import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The POC's turn instruction is the host's (CodexAdapterOptions.hostText
// .followUpsHookPocInstruction; Michi: hostText/codex.ts).

export interface CodexFollowUpsHookConfigOptions {
  runnerPath?: string;
  nodePath?: string;
}

/**
 * Build a per-thread App Server config overlay. Nothing here is written to
 * config.toml: Codex reports the hook source as `sessionFlags`. `endpoint` is
 * the slot's Stop hook URL as the host serves it (McpSlotProvider.hookEndpoint).
 */
export function buildCodexFollowUpsHookPocConfig(
  slotId: string,
  endpoint: string,
  options: CodexFollowUpsHookConfigOptions = {},
): Record<string, unknown> {
  if (!slotId) throw new Error('Codex follow-ups Hook POC requires an MCP slot id');
  if (!endpoint) throw new Error('Codex follow-ups Hook POC requires a Stop hook endpoint');

  const runnerPath = path.resolve(options.runnerPath ?? defaultStopHookRunnerPath());
  const nodePath = options.nodePath ?? process.execPath;

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
 * Run the opt-in POC App Server under a host-owned CODEX_HOME (`isolatedHome`)
 * so `bypass_hook_trust` cannot accidentally enable the user's personal hooks.
 * Only auth.json is shared with `codexHome` (the user's, ~/.codex when unset);
 * config.toml, hooks.json, plugins, and project hook trust state are
 * deliberately not copied. Returns `env` with CODEX_HOME pointing there.
 */
export function prepareCodexFollowUpsHookPocEnv(
  env: NodeJS.ProcessEnv,
  homes: { codexHome?: string; isolatedHome: string },
): NodeJS.ProcessEnv {
  const sourceHome = homes.codexHome || path.join(os.homedir(), '.codex');
  const isolatedHome = path.resolve(homes.isolatedHome);

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

/**
 * The adapter's own Stop hook runner. A bundle has it beside the bundle
 * (Michi's build copies it to dist/, where __dirname points); from source it
 * is this adapter's assets/codexStopHookRunner.cjs. A host that bundles the
 * package itself copies assets/codexStopHookRunner.cjs beside its bundle or
 * passes followUpsHook.runnerPath; otherwise neither candidate exists.
 */
function defaultStopHookRunnerPath(): string {
  const bundled = path.join(__dirname, 'codexStopHookRunner.cjs');
  return fs.existsSync(bundled) ? bundled : path.join(__dirname, 'assets', 'codexStopHookRunner.cjs');
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quoteWindows(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
