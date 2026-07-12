import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export class CodexBinaryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexBinaryNotFoundError';
  }
}

export class CodexAuthMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAuthMissingError';
  }
}

/**
 * Oldest Codex CLI release known to work with the Michi runtime protocol.
 * Emit a console.warn (never throw) when the installed version is older.
 */
export const MIN_TESTED_CODEX_VERSION = '0.138.0';

let _cached: string | null = null;

/** Clear the cached binary path. Call this between tests to avoid state leaking. */
export function resetCodexBinaryCacheForTest(): void {
  _cached = null;
}

/**
 * Locate the Codex CLI binary.
 *
 * Search order:
 *   1. `CODEX_CLI_BIN` env override (if the file exists)
 *   2. `which codex` (PATH lookup)
 *   3. Standard installation paths
 */
export function findCodexBinary(): string {
  if (_cached !== null) return _cached;

  const tried: string[] = [];

  // 1. Env override
  const envBin = process.env.CODEX_CLI_BIN;
  if (envBin) {
    tried.push(envBin);
    if (fs.existsSync(envBin)) {
      _cached = envBin;
      return _cached;
    }
  }

  // 2. which codex
  try {
    tried.push('<PATH lookup via which>');
    const result = execSync('which codex', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
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
    path.join(os.homedir(), '.npm-global', 'bin', 'codex'),
    path.join(os.homedir(), '.local', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
  ];

  for (const candidate of standardPaths) {
    tried.push(candidate);
    if (fs.existsSync(candidate)) {
      _cached = candidate;
      return _cached;
    }
  }

  throw new CodexBinaryNotFoundError(
    `codex binary not found. Tried: ${tried.join(', ')}. ` +
      'Install with: npm install -g @openai/codex, or set CODEX_CLI_BIN.',
  );
}

/**
 * Return the Codex home directory.
 * Respects the `CODEX_HOME` env override; falls back to `~/.codex`.
 */
export function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

/**
 * Fast-fail pre-flight: verify that Codex auth credentials are present before
 * spawning a headless codex process that would otherwise hang on a login prompt.
 *
 * Codex stores its credentials in `<codexHome>/auth.json` after `codex login`.
 */
export function preflightCodexAuth(): void {
  const authFile = path.join(codexHome(), 'auth.json');
  if (!fs.existsSync(authFile)) {
    throw new CodexAuthMissingError(
      `No Codex auth found. Expected ${authFile}. Run \`codex login\` to authenticate, or set CODEX_HOME if your credentials are stored elsewhere.`,
    );
  }
}

/**
 * Run `codex --version`, parse the semver output, and emit a console.warn if
 * the installed version is older than MIN_TESTED_CODEX_VERSION.
 *
 * Never throws — version checks are advisory only.
 */
export function warnIfCodexVersionBelowMinimum(): void {
  try {
    const binary = findCodexBinary();
    const output = execSync(`"${binary}" --version`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();

    // Accept formats like "0.138.0" or "codex 0.138.0" or "v0.138.0"
    const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return;

    const [, maj, min, patch] = match.map(Number);
    const [minMaj, minMin, minPatch] = MIN_TESTED_CODEX_VERSION.split('.').map(Number);

    const below =
      maj < minMaj ||
      (maj === minMaj && min < minMin) ||
      (maj === minMaj && min === minMin && patch < minPatch);

    if (below) {
      console.warn(
        `[michi] Codex CLI version ${maj}.${min}.${patch} is below the minimum tested version ` +
          `${MIN_TESTED_CODEX_VERSION}. Consider upgrading: npm install -g @openai/codex`,
      );
    }
  } catch {
    // Version check is advisory; never fail the caller.
  }
}
