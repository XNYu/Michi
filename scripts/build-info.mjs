import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function michiBuildInfo(repoRoot) {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  try {
    const ancestors = execFileSync('git', ['rev-list', '--max-count=20000', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 2_000_000,
    }).trim().split(/\r?\n/);
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', 'backend', 'frontend', 'shared', 'runtime', 'scripts', 'electron', 'package.json'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().length > 0;
    return { version, revision: ancestors[0], ancestors, dirty };
  } catch { return { version, revision: null, ancestors: [] }; }
}
