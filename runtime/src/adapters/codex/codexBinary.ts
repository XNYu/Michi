import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveNamedBinary } from '../../core/executableLookup';

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
/** The host's persistent cache file (CodexAdapterOptions.binaryCacheFile); null keeps the path in memory only. */
let _cacheFile: string | null = null;

const APP_BUNDLE_NAMES = ['ChatGPT.app', 'Codex.app'] as const;
const APP_BUNDLE_IDS = ['com.openai.chat', 'com.openai.codex'] as const;
const MAX_BUNDLE_SEARCH_DEPTH = 4;

/**
 * Remember the resolved CLI path in `cacheFilePath` across restarts, or only
 * in memory when null. The adapter reads no environment itself, so the host
 * picks the file (CodexRuntime applies CodexAdapterOptions.binaryCacheFile).
 */
export function configureCodexBinaryCache(cacheFilePath: string | null): void {
  _cacheFile = cacheFilePath;
}

function getCacheFilePath(): string | null {
  return _cacheFile;
}

/**
 * Clear the in-memory cached binary path (and optionally point the persistent
 * disk cache at `cacheFilePath`, or `null` to disable disk cache in unit tests).
 */
export function resetCodexBinaryCacheForTest(cacheFilePath: string | null = null): void {
  _cached = null;
  _cacheFile = cacheFilePath;
}

/**
 * Invalidate both the in-memory cache and the persisted disk cache so the next
 * `findCodexBinary` call performs a fresh lookup (e.g. when a cached binary
 * was moved or deleted after an app update).
 */
export function invalidateCodexBinaryCache(): void {
  _cached = null;
  const cacheFile = getCacheFilePath();
  if (!cacheFile) return;
  try {
    fs.rmSync(cacheFile, { force: true });
  } catch {
    // Best-effort cleanup.
  }
}

function readPersistedCodexBinary(): string | null {
  const cacheFile = getCacheFilePath();
  if (!cacheFile) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { binaryPath?: unknown };
    if (typeof raw?.binaryPath === 'string' && raw.binaryPath.length > 0) {
      return raw.binaryPath;
    }
  } catch {
    // Cache file does not exist yet (first startup) or is unreadable.
  }
  return null;
}

function writePersistedCodexBinary(resolvedPath: string): void {
  const cacheFile = getCacheFilePath();
  if (!cacheFile) return;
  const dir = path.dirname(cacheFile);
  const tmpFile = `${cacheFile}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({ binaryPath: resolvedPath, updatedAt: Date.now() }, null, 2),
      { mode: 0o600 },
    );
    fs.renameSync(tmpFile, cacheFile);
  } catch {
    try {
      fs.rmSync(tmpFile, { force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }
}

function isRunnableExecutable(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform !== 'win32') {
      fs.accessSync(filePath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively search up to `maxDepth` levels under `rootDir` for an executable
 * file named `targetName`.
 */
export function findExecutableInDirBounded(
  rootDir: string,
  targetName: string,
  maxDepth = MAX_BUNDLE_SEARCH_DEPTH,
): string | null {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name === targetName && (entry.isFile() || entry.isSymbolicLink())) {
        const candidate = path.join(current.dir, entry.name);
        if (isRunnableExecutable(candidate)) {
          return candidate;
        }
      }
    }

    if (current.depth < maxDepth) {
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
        }
      }
    }
  }

  return null;
}

function candidateAppBundleRoots(homeDir: string): string[] {
  const roots: string[] = [];
  for (const appName of APP_BUNDLE_NAMES) {
    roots.push(path.join('/Applications', appName));
    roots.push(path.join(homeDir, 'Applications', appName));
  }
  return roots;
}

function discoverAppBundlesViaSpotlight(): string[] {
  if (process.platform !== 'darwin') return [];
  const query = APP_BUNDLE_IDS.map((id) => `kMDItemCFBundleIdentifier == '${id}'`).join(' || ');
  try {
    const out = execSync(`mdfind "${query}"`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 1500,
    }).trim();
    if (!out) return [];
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function versionManagerBinDirs(homeDir: string): string[] {
  const dirs: string[] = [
    path.join(homeDir, '.volta', 'bin'),
    path.join(homeDir, '.bun', 'bin'),
    path.join(homeDir, '.local', 'share', 'mise', 'shims'),
    path.join(homeDir, '.asdf', 'shims'),
  ];

  const versionedRoots: Array<{ root: string; suffix: string[] }> = [
    { root: path.join(homeDir, '.nvm', 'versions', 'node'), suffix: ['bin'] },
    { root: path.join(homeDir, '.local', 'share', 'fnm', 'node-versions'), suffix: ['installation', 'bin'] },
  ];

  for (const { root, suffix } of versionedRoots) {
    try {
      const versions = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const ver of versions) {
        dirs.push(path.join(root, ver, ...suffix));
      }
    } catch {
      // Directory not present; skip.
    }
  }

  return dirs;
}

function discoverCodexInAppBundles(homeDir: string, tried: string[]): string | null {
  const seenApps = new Set<string>();
  const appRoots = [...candidateAppBundleRoots(homeDir), ...discoverAppBundlesViaSpotlight()];

  for (const appRoot of appRoots) {
    if (seenApps.has(appRoot)) continue;
    seenApps.add(appRoot);

    const contentsDir = path.join(appRoot, 'Contents');
    if (!fs.existsSync(contentsDir)) continue;

    tried.push(`${contentsDir}/**/codex (depth<=${MAX_BUNDLE_SEARCH_DEPTH})`);
    const hit = findExecutableInDirBounded(contentsDir, 'codex', MAX_BUNDLE_SEARCH_DEPTH);
    if (hit) return hit;
  }

  return null;
}

/**
 * Locate the Codex CLI binary.
 *
 * Fast path (normal startups):
 *   1. In-memory `_cached` hit (zero filesystem I/O after first resolution in process)
 *   2. Persisted path from previous startup (`~/.michi/cache/codex-binary.json`), verified with `fs.existsSync`
 *
 * Full discovery (only on first startup, or when the previously cached binary is missing):
 *   3. `binaryPath`, the host's override (Michi: CODEX_CLI_BIN), if the file exists
 *   4. PATH lookup + well-known `.app` bundle locations + version manager dirs + standard install dirs
 *   5. Bounded recursive scan (`maxDepth <= 4`) inside `ChatGPT.app` / `Codex.app` (including Spotlight `mdfind` fallback)
 */
export function findCodexBinary(binaryPath?: string): string {
  if (_cached !== null) return _cached;

  if (!binaryPath) {
    const persisted = readPersistedCodexBinary();
    if (persisted && fs.existsSync(persisted)) {
      _cached = persisted;
      return _cached;
    }
  }

  const homeDir = os.homedir();
  const { found, tried } = resolveNamedBinary('codex', {
    envValue: binaryPath,
    extraFiles: [
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      // Newer ChatGPT desktop builds bundle the CLI as a package directory.
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
      '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
      path.join(homeDir, 'Applications/ChatGPT.app/Contents/Resources/codex'),
      path.join(homeDir, 'Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'),
      path.join(homeDir, 'Applications/Codex.app/Contents/Resources/codex'),
      path.join(homeDir, 'Applications/Codex.app/Contents/Resources/codex-cli/bin/codex'),
    ],
    extraDirs: versionManagerBinDirs(homeDir),
  });
  if (found) {
    _cached = found;
    writePersistedCodexBinary(found);
    return _cached;
  }

  const bundleHit = discoverCodexInAppBundles(homeDir, tried);
  if (bundleHit) {
    _cached = bundleHit;
    writePersistedCodexBinary(bundleHit);
    return _cached;
  }

  throw new CodexBinaryNotFoundError(
    `codex binary not found. Tried: ${tried.join(', ')}. ` +
      'Install with: npm install -g @openai/codex, or set CODEX_CLI_BIN.',
  );
}

/**
 * Return the Codex home directory: `override`, the host's CODEX_HOME, when
 * set; otherwise `~/.codex`.
 */
export function codexHome(override?: string): string {
  return override ?? path.join(os.homedir(), '.codex');
}

/**
 * Local auth hint: whether `<codexHome>/auth.json`, the file `codex login`
 * writes, exists. Its absence does not prove Codex lacks credentials: a
 * provider can manage its own (Amazon Bedrock) or read an API key from the
 * environment. CodexRuntime therefore only treats a missing file as a reason
 * to ask app-server (`account/read`) before the first thread.
 */
export function preflightCodexAuth(codexHomeOverride?: string): void {
  const authFile = path.join(codexHome(codexHomeOverride), 'auth.json');
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
export function warnIfCodexVersionBelowMinimum(binaryPath?: string): void {
  try {
    const binary = findCodexBinary(binaryPath);
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
