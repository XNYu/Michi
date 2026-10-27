import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ClaudeAdapterOptions } from './claudeAdapterOptions';

/**
 * What locates the profile of the claude processes the adapter spawns: the
 * adapter's options (its configDir, the environment children inherit, and
 * whether the host keeps each user's history apart).
 */
export type ClaudeProfileOptions = Pick<ClaudeAdapterOptions, 'host' | 'spawnEnv' | 'configDir'>;

/**
 * Base config dir of the claude processes the adapter spawns. Must mirror
 * the resolution in spawnClaude: the configDir override, then an inherited
 * CLAUDE_CONFIG_DIR, then claude's default ~/.claude. If this diverges from
 * the spawn env, JSONL transcript reads point at the wrong profile's history.
 */
function claudeConfigBase(options: ClaudeProfileOptions): string {
  return (
    options.configDir?.() ??
    options.spawnEnv().CLAUDE_CONFIG_DIR ??
    path.join(os.homedir(), '.claude')
  );
}

/** Longest project directory name the CLI writes before it cuts the name and adds a hash. */
const MAX_SLUG = 200;

/** The CLI's hash of a long path (Java's String.hashCode). */
function pathHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return hash;
}

/**
 * Claude's project directory name for a cwd. It encodes punctuation too,
 * including underscores in macOS temp paths; past 200 characters the CLI
 * keeps the first 200 and adds a base-36 hash of the whole path.
 */
export function claudeProjectSlug(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= MAX_SLUG) return slug;
  return `${slug.slice(0, MAX_SLUG)}-${Math.abs(pathHash(cwd)).toString(36)}`;
}

/**
 * Returns the directory where Claude stores its project JSONL history files.
 *
 * When the host enforces user ownership (Michi: cloud mode) a per-user
 * prefix is inserted so two users sharing the same cwd slug do not collide
 * on each other's history:
 *   <configDir>/projects/<userId>/<slug>/
 *
 * Otherwise (Michi's desktop) the path is unchanged:
 *   <configDir>/projects/<slug>/
 */
export function getClaudeProjectsDir(options: ClaudeProfileOptions, cwd: string, userId?: string | null): string {
  const slug = claudeProjectSlug(cwd);
  if (options.host.principal.enforceUserOwnership() && userId) {
    return path.join(claudeConfigBase(options), 'projects', userId, slug);
  }
  return path.join(claudeConfigBase(options), 'projects', slug);
}

export function getClaudeJsonlPath(options: ClaudeProfileOptions, cwd: string, claudeSessionId: string, userId?: string | null): string {
  return path.join(getClaudeProjectsDir(options, cwd, userId), `${claudeSessionId}.jsonl`);
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether `claude --resume <id>` from `cwd` can find the session's
 * transcript: in the cwd's project directory (the cwd as given, or with its
 * symlinks resolved, which is how the CLI sees it), or else in another
 * project directory, which the CLI's own fallback scan finds (Claude Code
 * 2.1: a session moved with its cwd still resumes). False, no transcript in
 * any project directory, is positive evidence that the native session is gone.
 *
 * Both layouts are searched: Michi's (with cloud mode's per-user segment,
 * getClaudeProjectsDir) and the CLI's own `<config>/projects`, which is where
 * the CLI writes whatever Michi's layout says (spawnClaude sets only
 * CLAUDE_CONFIG_DIR).
 */
export async function claudeTranscriptFindable(options: ClaudeProfileOptions, cwd: string, claudeSessionId: string, userId?: string | null): Promise<boolean> {
  const file = `${claudeSessionId}.jsonl`;
  const cwds = new Set([cwd]);
  try {
    cwds.add(await fs.promises.realpath(cwd));
  } catch { /* a cwd that no longer exists still names its project directory */ }
  const roots = [...new Set([path.dirname(getClaudeProjectsDir(options, cwd, userId)), path.join(claudeConfigBase(options), 'projects')])];
  for (const root of roots) {
    for (const dir of cwds) {
      if (await isFile(path.join(root, claudeProjectSlug(dir), file))) return true;
    }
  }
  for (const root of roots) {
    let names: string[];
    try {
      names = (await fs.promises.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const name of names) {
      if (await isFile(path.join(root, name, file))) return true;
    }
  }
  return false;
}
