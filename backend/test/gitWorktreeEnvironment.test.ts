import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentPolicyCategory, AgentPolicyDecision } from 'michi-shared';
import {
  DefaultExecutionEnvironmentProvider,
  ExecutionEnvironmentError,
  type PrepareExecutionEnvironmentInput,
} from '../src/agents/runs/executionEnvironment';
import { GitWorktreeEnvironment, type GitCommandRunner } from '../src/agents/runs/gitWorktreeEnvironment';

let root: string;
let repo: string;
let dataRoot: string;

function git(cwd: string, ...args: string[]): Buffer {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(relativePath: string, content: string | Buffer): void {
  const absolute = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function initRepository(): void {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'michi-test@example.com');
  git(repo, 'config', 'user.name', 'Michi Test');
  write('.gitignore', 'ignored.txt\n.env\n*.pem\n');
  write('staged.txt', 'base staged\n');
  write('unstaged.txt', 'base unstaged\n');
  write('binary.bin', Buffer.from([0, 1, 2, 3, 4]));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
}

const readPolicy = {
  version: 1 as const, preset: 'research' as const,
  categories: { [AgentPolicyCategory.FilesystemWrite]: AgentPolicyDecision.Deny, [AgentPolicyCategory.ShellExec]: AgentPolicyDecision.Deny },
  maxDelegationDepth: 0, maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1,
};
const writePolicy = {
  ...readPolicy, preset: 'build' as const,
  categories: { [AgentPolicyCategory.FilesystemWrite]: AgentPolicyDecision.Allow, [AgentPolicyCategory.ShellExec]: AgentPolicyDecision.Allow },
};

function input(runId: string, request: PrepareExecutionEnvironmentInput['request'] = { version: 1, kind: 'git_worktree' }): PrepareExecutionEnvironmentInput {
  return { runId, workspaceId: 'workspace-1', workspaceCwd: repo, request, permissionPolicy: writePolicy };
}

function environment(ids = ['lease-1']): { worktrees: GitWorktreeEnvironment; provider: DefaultExecutionEnvironmentProvider } {
  let index = 0;
  const worktrees = new GitWorktreeEnvironment({ dataRoot, now: () => 1234, nextId: () => ids[index++] ?? `lease-${index}` });
  return { worktrees, provider: new DefaultExecutionEnvironmentProvider({ worktrees, now: () => 1234 }) };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof ExecutionEnvironmentError ? error.code : undefined;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'michi-worktree-test-')));
  repo = path.join(root, 'source');
  dataRoot = path.join(root, 'michi-data');
  initRepository();
});

afterEach(() => {
  try { git(repo, 'worktree', 'prune'); } catch { /* repository may be intentionally conflicted or absent */ }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('GitWorktreeEnvironment', () => {
  test('reproduces staged, unstaged, binary, and safe untracked state outside the Parent repository', async () => {
    write('staged.txt', 'staged change\n');
    git(repo, 'add', 'staged.txt');
    write('unstaged.txt', 'unstaged change\n');
    write('binary.bin', Buffer.from([9, 8, 0, 7, 6, 5]));
    write('nested/untracked.txt', 'untracked\n');
    write('ignored.txt', 'ignored\n');
    write('.env', 'TOKEN=secret\n');
    write('id_rsa', 'also secret\n');
    const parentStatus = git(repo, 'status', '--porcelain=v1', '-z').toString('hex');
    const { provider } = environment();

    const lease = await provider.prepare(input('run-1'));
    assert.equal(lease.snapshot.kind, 'git_worktree');
    assert.ok(path.relative(repo, lease.snapshot.cwd).startsWith('..'));
    assert.equal(fs.readFileSync(path.join(lease.snapshot.cwd, 'staged.txt'), 'utf8'), 'staged change\n');
    assert.equal(fs.readFileSync(path.join(lease.snapshot.cwd, 'unstaged.txt'), 'utf8'), 'unstaged change\n');
    assert.deepEqual(fs.readFileSync(path.join(lease.snapshot.cwd, 'binary.bin')), Buffer.from([9, 8, 0, 7, 6, 5]));
    assert.equal(fs.readFileSync(path.join(lease.snapshot.cwd, 'nested/untracked.txt'), 'utf8'), 'untracked\n');
    assert.equal(fs.existsSync(path.join(lease.snapshot.cwd, 'ignored.txt')), false);
    assert.equal(fs.existsSync(path.join(lease.snapshot.cwd, '.env')), false);
    assert.equal(fs.existsSync(path.join(lease.snapshot.cwd, 'id_rsa')), false);
    assert.ok(lease.provenance.skippedSensitivePaths.includes('id_rsa'));
    assert.match(lease.provenance.stagedPatchHash!, /^[a-f0-9]{64}$/);
    assert.match(lease.provenance.unstagedPatchHash!, /^[a-f0-9]{64}$/);
    assert.match(lease.snapshot.snapshotHash, /^[a-f0-9]{64}$/);
    assert.ok(split(git(lease.snapshot.cwd, 'diff', '--cached', '--name-only', '-z')).includes('staged.txt'));
    assert.ok(split(git(lease.snapshot.cwd, 'diff', '--name-only', '-z')).includes('unstaged.txt'));
    assert.equal(git(repo, 'status', '--porcelain=v1', '-z').toString('hex'), parentStatus);

    writeIn(lease.snapshot.cwd, 'agent-output.txt', 'result\n');
    const changeSet = await lease.buildChangeSet();
    assert.ok(changeSet?.changedFiles.includes('agent-output.txt'));
    assert.equal(changeSet?.worktreeId, lease.leaseId);
    assert.match(changeSet?.snapshotHash ?? '', /^[a-f0-9]{64}$/);
    assert.deepEqual(await lease.cleanup('run-1'), { removed: true });
    assert.deepEqual(await lease.cleanup('run-1'), { removed: false });
    assert.equal(git(repo, 'status', '--porcelain=v1', '-z').toString('hex'), parentStatus);
  });

  test('creates unique concurrent leases and ownership-checked cleanup', async () => {
    const { provider } = environment(['lease-a', 'lease-b']);
    const [first, second] = await Promise.all([provider.prepare(input('run-a')), provider.prepare(input('run-b'))]);
    assert.notEqual(first.snapshot.cwd, second.snapshot.cwd);
    writeIn(first.snapshot.cwd, 'only-a.txt', 'a');
    assert.equal(fs.existsSync(path.join(second.snapshot.cwd, 'only-a.txt')), false);
    await assert.rejects(first.cleanup('run-b'), (error) => errorCode(error) === 'lease_owner_mismatch');
    assert.equal(fs.existsSync(first.snapshot.cwd), true);
    await first.cleanup('run-a');
    await second.cleanup('run-b');
  });

  test('resolves auto policy without ever falling back to shared writes', async () => {
    const { provider } = environment(['lease-auto']);
    const readLease = await provider.prepare({ ...input('read-run', { version: 1, kind: 'auto' }), permissionPolicy: readPolicy });
    assert.equal(readLease.snapshot.kind, 'shared_workspace');
    assert.equal(readLease.access, 'read_only');
    const writeLease = await provider.prepare(input('write-run', { version: 1, kind: 'auto' }));
    assert.equal(writeLease.snapshot.kind, 'git_worktree');
    await writeLease.cleanup('write-run');

    const nonGit = path.join(root, 'plain');
    fs.mkdirSync(nonGit);
    await assert.rejects(provider.prepare({ ...input('non-git', { version: 1, kind: 'auto' }), workspaceCwd: nonGit }), (error) => errorCode(error) === 'git_required');
    await assert.rejects(provider.prepare({ ...input('denied', { version: 1, kind: 'shared_workspace', access: 'read_write' }), permissionPolicy: readPolicy }), (error) => errorCode(error) === 'permission_denied');
    const explicit = await provider.prepare(input('explicit', { version: 1, kind: 'shared_workspace', access: 'read_write' }));
    assert.equal(explicit.snapshot.kind, 'shared_workspace');
    assert.equal(explicit.access, 'read_write');
  });

  test('rejects unresolved merges, path IDs, and symlink escapes', async () => {
    git(repo, 'checkout', '-q', '-b', 'side');
    write('staged.txt', 'side\n'); git(repo, 'add', 'staged.txt'); git(repo, 'commit', '-q', '-m', 'side');
    git(repo, 'checkout', '-q', 'main');
    write('staged.txt', 'main\n'); git(repo, 'add', 'staged.txt'); git(repo, 'commit', '-q', '-m', 'main');
    assert.throws(() => git(repo, 'merge', 'side'), /Command failed/);
    const { provider } = environment();
    await assert.rejects(provider.prepare(input('conflict')), (error) => errorCode(error) === 'unresolved_merge');
    git(repo, 'merge', '--abort');

    const outside = path.join(root, 'outside.txt'); fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, path.join(repo, 'escape-link'));
    await assert.rejects(provider.prepare(input('symlink')), (error) => errorCode(error) === 'symlink_escape');
    fs.unlinkSync(path.join(repo, 'escape-link'));
    const bad = new GitWorktreeEnvironment({ dataRoot, nextId: () => '../escape' });
    await assert.rejects(bad.prepareWorktree(input('safe-run')), (error) => errorCode(error) === 'path_escape');
    const inRepository = new GitWorktreeEnvironment({ dataRoot: path.join(repo, '.michi'), nextId: () => 'lease-inside' });
    await assert.rejects(inRepository.prepareWorktree(input('inside-run')), (error) => errorCode(error) === 'path_escape');
    assert.equal(fs.existsSync(path.join(repo, '.michi')), false);
  });

  test('turns patch application failure into a structured error and removes partial resources', async () => {
    write('unstaged.txt', 'will fail\n');
    const runner: GitCommandRunner = async (cwd, args) => {
      if (args[0] === 'apply') throw new Error('synthetic patch failure');
      return git(cwd, ...args);
    };
    const worktrees = new GitWorktreeEnvironment({ dataRoot, nextId: () => 'lease-fail', git: runner });
    const provider = new DefaultExecutionEnvironmentProvider({ worktrees });
    const parentStatus = git(repo, 'status', '--porcelain=v1', '-z').toString('hex');
    await assert.rejects(provider.prepare(input('run-fail')), (error) => errorCode(error) === 'patch_failed');
    assert.equal(fs.existsSync(path.join(dataRoot, 'agent-runs', 'worktrees', 'run-fail-lease-fail')), false);
    assert.equal(fs.existsSync(path.join(dataRoot, 'agent-runs', 'environment-leases', 'lease-fail')), false);
    assert.equal(git(repo, 'status', '--porcelain=v1', '-z').toString('hex'), parentStatus);
    const bounded = new GitWorktreeEnvironment({ dataRoot, nextId: () => 'lease-bounded', git: runner, maxOutputBytes: 8 });
    await assert.rejects(bounded.prepareWorktree(input('run-bounded')), (error) => errorCode(error) === 'snapshot_failed');
  });
});

function split(buffer: Buffer): string[] { return buffer.toString('utf8').split('\0').filter(Boolean); }
function writeIn(cwd: string, relativePath: string, content: string): void {
  const absolute = path.join(cwd, relativePath); fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, content);
}
