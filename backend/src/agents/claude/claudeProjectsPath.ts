import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Returns the directory where Claude stores its project JSONL history files.
 *
 * In cloud mode (MICHI_CLOUD=1) a per-user prefix is inserted so two users
 * sharing the same cwd slug do not collide on each other's history:
 *   ~/.claude/projects/<userId>/<slug>/
 *
 * In desktop mode the path is unchanged:
 *   ~/.claude/projects/<slug>/
 */
export function getClaudeProjectsDir(cwd: string, userId?: string | null): string {
  const slug = cwd.replace(/\//g, '-');
  if (process.env.MICHI_CLOUD === '1' && userId) {
    return path.join(os.homedir(), '.claude', 'projects', userId, slug);
  }
  return path.join(os.homedir(), '.claude', 'projects', slug);
}

export function getClaudeJsonlPath(cwd: string, claudeSessionId: string, userId?: string | null): string {
  return path.join(getClaudeProjectsDir(cwd, userId), `${claudeSessionId}.jsonl`);
}
