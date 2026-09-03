/**
 * Platform-aware CLI discovery shared by Claude / Codex / Kiro / Cursor / Grok / AGY.
 *
 * Windows differences this module owns:
 *   - PATH is `;`-separated (`path.delimiter`)
 *   - binaries usually have `.exe` / `.cmd` / `.bat` suffixes
 *   - Toolbox / npm / `~/.local/bin` live under LOCALAPPDATA and APPDATA
 *
 * Callers keep their own env-override names and error types; this module
 * only answers "where is `name`?"
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface LookupFs {
  exists: (filePath: string) => boolean;
  isRunnable: (filePath: string) => boolean;
}

export interface LookupContext {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  fs?: LookupFs;
}

export function lookupPlatform(ctx: LookupContext = {}): NodeJS.Platform {
  return ctx.platform ?? process.platform;
}

export function lookupEnv(ctx: LookupContext = {}): NodeJS.ProcessEnv {
  return ctx.env ?? process.env;
}

export function lookupHome(ctx: LookupContext = {}): string {
  return ctx.home ?? os.homedir();
}

export function pathDirs(pathVar: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
  const delimiter = platform === "win32" ? ";" : ":";
  return (pathVar ?? "").split(delimiter).map((dir) => dir.trim()).filter(Boolean);
}

export function candidateNames(base: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "win32") return [base];
  if (path.extname(base)) return [base];
  return [`${base}.exe`, `${base}.cmd`, `${base}.bat`, base];
}

export function isRunnableFile(filePath: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!fs.existsSync(filePath)) return false;
  if (platform === "win32") return true;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultFs(platform: NodeJS.Platform): LookupFs {
  return {
    exists: (filePath) => fs.existsSync(filePath),
    isRunnable: (filePath) => isRunnableFile(filePath, platform),
  };
}

function fsFor(ctx: LookupContext): LookupFs {
  return ctx.fs ?? defaultFs(lookupPlatform(ctx));
}

export function findInDir(dir: string, name: string, ctx: LookupContext = {}): string | null {
  if (!dir) return null;
  const platform = lookupPlatform(ctx);
  const io = fsFor(ctx);
  for (const fileName of candidateNames(name, platform)) {
    const candidate = path.join(dir, fileName);
    if (io.exists(candidate) && io.isRunnable(candidate)) return candidate;
  }
  return null;
}

export function findOnPath(name: string, ctx: LookupContext = {}): string | null {
  const env = lookupEnv(ctx);
  for (const dir of pathDirs(env.PATH, lookupPlatform(ctx))) {
    const found = findInDir(dir, name, ctx);
    if (found) return found;
  }
  return null;
}

/** User-level install prefixes shared by every runtime. */
export function standardInstallDirs(ctx: LookupContext = {}): string[] {
  const platform = lookupPlatform(ctx);
  const env = lookupEnv(ctx);
  const home = lookupHome(ctx);
  const dirs = [
    path.join(home, ".local", "bin"),
    path.join(home, ".toolbox", "bin"),
    path.join(home, ".npm-global", "bin"),
  ];
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    dirs.unshift(path.join(localAppData, "Toolbox", "bin"));
    dirs.push(path.join(appData, "npm"));
    return dirs;
  }
  dirs.push("/usr/local/bin", "/opt/homebrew/bin");
  return dirs;
}

export interface ResolveNamedBinaryOptions extends LookupContext {
  /** Absolute override (CLAUDE_CLI_BIN / CODEX_CLI_BIN / …). Existence-only, matching historical behavior. */
  envValue?: string;
  /** Extra absolute files to try after PATH (macOS .app bundles, etc.). */
  extraFiles?: string[];
  /** Extra directories searched with `candidateNames(name)`. */
  extraDirs?: string[];
  /** Skip the shared standard-install directory list (caller supplies a complete extraDirs). */
  skipStandardDirs?: boolean;
}

export interface ResolveNamedBinaryResult {
  found: string | null;
  tried: string[];
}

/**
 * Shared search order:
 *   1. env override (exists)
 *   2. PATH
 *   3. extraFiles
 *   4. extraDirs + standard install dirs
 */
export function resolveNamedBinary(name: string, opts: ResolveNamedBinaryOptions = {}): ResolveNamedBinaryResult {
  const tried: string[] = [];
  const io = fsFor(opts);

  if (opts.envValue) {
    tried.push(opts.envValue);
    if (io.exists(opts.envValue)) return { found: opts.envValue, tried };
  }

  tried.push(`<PATH lookup for ${name}>`);
  const onPath = findOnPath(name, opts);
  if (onPath) return { found: onPath, tried };

  for (const file of opts.extraFiles ?? []) {
    tried.push(file);
    // Extra files keep the historical existsSync-only check so tests can stub
    // existence for macOS app-bundle paths that are not actually on disk.
    if (io.exists(file)) return { found: file, tried };
  }

  const dirs = [
    ...(opts.extraDirs ?? []),
    ...(opts.skipStandardDirs ? [] : standardInstallDirs(opts)),
  ];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    for (const fileName of candidateNames(name, lookupPlatform(opts))) {
      tried.push(path.join(dir, fileName));
    }
    const found = findInDir(dir, name, opts);
    if (found) return { found, tried };
  }

  return { found: null, tried };
}

export function exeName(base: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32" || path.extname(base)) return base;
  return `${base}.exe`;
}
