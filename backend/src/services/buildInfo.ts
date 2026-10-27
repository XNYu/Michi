import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { MichiBuildInfo, RemoteUpdateStatus } from 'michi-shared';

export interface BuildInfo extends MichiBuildInfo { ancestors: string[] }
declare const __MICHI_BUILD_INFO__: BuildInfo | undefined;

function sourceBuildInfo(): BuildInfo {
  const root = [path.resolve(__dirname, '../..'), path.resolve(__dirname, '../../..')]
    .find(candidate => existsSync(path.join(candidate, '.git')));
  try {
    if (!root) throw new Error('No source checkout');
    const ancestors = execFileSync('git', ['rev-list', '--max-count=20000', 'HEAD'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 2_000_000,
    }).trim().split(/\r?\n/);
    const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', 'backend', 'frontend', 'shared', 'runtime', 'scripts', 'electron', 'package.json'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().length > 0;
    return { version, revision: ancestors[0], ancestors, dirty };
  } catch { return { version: 'unknown', revision: null, ancestors: [] }; }
}

// Captured at build time, so moving a checkout after launch cannot change the
// identity of the running server. Packaged apps do not need Git installed.
export const runningBuild: BuildInfo = typeof __MICHI_BUILD_INFO__ !== 'undefined'
  ? __MICHI_BUILD_INFO__! : sourceBuildInfo();
export const publicBuildInfo = ({ version, revision, dirty }: MichiBuildInfo): MichiBuildInfo => ({ version, revision, ...(dirty ? { dirty } : {}) });

export function compareRemoteBuild(local: BuildInfo, remote: MichiBuildInfo | null, ssh: boolean): RemoteUpdateStatus {
  const revision = remote?.revision;
  const valid = typeof revision === 'string' && /^[a-f0-9]{7,40}$/i.test(revision);
  const matches = valid ? local.ancestors.filter(hash => hash.startsWith(revision.toLowerCase())) : [];
  const state = !valid || !local.revision ? 'unknown'
    : matches.length === 1 && local.revision.startsWith(revision.toLowerCase()) ? 'current'
      : matches.length === 1 ? 'older' : 'different';
  return { local: publicBuildInfo(local), remote, state, canUpdate: state === 'older' && ssh && !local.dirty,
    ...(state === 'older' && (!ssh || local.dirty) ? { message: local.dirty
      ? 'This app was built with unpublished source changes. Build from a published commit before updating this machine.'
      : 'Update this machine over SSH, or update its installation manually.' } : {}),
  };
}
