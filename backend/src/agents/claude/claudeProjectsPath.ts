import * as os from 'node:os';
import * as path from 'node:path';
import { resolveClaudeConfigDir } from '../../services/agentConfig';

/**
 * Base config dir of the claude processes Michi spawns. Must mirror the
 * resolution in spawnClaude: explicit agent.claudeConfigDir override, then an
 * inherited CLAUDE_CONFIG_DIR, then claude's default ~/.claude. If this
 * diverges from the spawn env, JSONL transcript reads point at the wrong
 * profile's history.
 */
function claudeConfigBase(): string {
  return (
    resolveClaudeConfigDir() ??
    process.env.CLAUDE_CONFIG_DIR ??
    path.join(os.homedir(), '.claude')
  );
}

/**
 * Returns the directory where Claude stores its project JSONL history files.
 *
 * In cloud mode (MICHI_CLOUD=1) a per-user prefix is inserted so two users
 * sharing the same cwd slug do not collide on each other's history:
 *   <configDir>/projects/<userId>/<slug>/
 *
 * In desktop mode the path is unchanged:
 *   <configDir>/projects/<slug>/
 */
export function getClaudeProjectsDir(cwd: string, userId?: string | null): string {
  const slug = cwd.replace(/\//g, '-');
  if (process.env.MICHI_CLOUD === '1' && userId) {
    return path.join(claudeConfigBase(), 'projects', userId, slug);
  }
  return path.join(claudeConfigBase(), 'projects', slug);
}

export function getClaudeJsonlPath(cwd: string, claudeSessionId: string, userId?: string | null): string {
  return path.join(getClaudeProjectsDir(cwd, userId), `${claudeSessionId}.jsonl`);
}
