import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveNamedBinary } from '../executableLookup';

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
 *   2. PATH lookup (`.exe` / `.cmd` on Windows)
 *   3. Standard installation paths, including macOS app bundles
 */
export function findCodexBinary(): string {
  if (_cached !== null) return _cached;

  const { found, tried } = resolveNamedBinary('codex', {
    envValue: process.env.CODEX_CLI_BIN,
    extraFiles: [
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
    ],
  });
  if (found) {
    _cached = found;
    return _cached;
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
