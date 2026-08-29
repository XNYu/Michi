import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  chmod, lstat, mkdir, readFile, realpath, rm, writeFile,
} from 'node:fs/promises';
import type { GitChangeSetRefV1 } from 'michi-shared';
import {
  type ExecutionEnvironmentLease,
  type ExecutionEnvironmentProvenanceV1,
  ExecutionEnvironmentError,
  type GitWorktreeEnvironmentPort,
  type PrepareExecutionEnvironmentInput,
} from './executionEnvironment';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const SENSITIVE_PATH = /(^|\/)(?:\.env(?:\..*)?|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)(?:$|\/)|\.(?:pem|key|p12|pfx)$/i;

export type GitCommandRunner = (cwd: string, args: readonly string[]) => Promise<Buffer>;

export interface GitWorktreeEnvironmentDeps {
  dataRoot: string;
  now?: () => number;
  nextId?: () => string;
  git?: GitCommandRunner;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface CapturedFile { relativePath: string; bytes: Buffer; sha256: string; size: number; mode: number }
interface LeaseMarker { version: 1; leaseId: string; ownerRunId: string; sourceRepositoryRoot: string; worktreePath: string }

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function hash(data: Buffer | string): string { return createHash('sha256').update(data).digest('hex'); }
function splitNull(data: Buffer): string[] { return data.toString('utf8').split('\0').filter(Boolean); }

function defaultGitRunner(timeoutMs: number, maxOutputBytes: number): GitCommandRunner {
  return (cwd, args) => new Promise<Buffer>((resolve, reject) => {
    execFile('git', [...args], {
      cwd,
      encoding: 'buffer',
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      windowsHide: true,
      shell: false,
    }, (error, stdout, stderr) => {
      if (!error) { resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)); return; }
      const wrapped = new Error(`git ${args[0] ?? ''} failed: ${(Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr).slice(0, 4_096)}`);
      Object.assign(wrapped, { cause: error, code: (error as NodeJS.ErrnoException).code });
      reject(wrapped);
    });
  });
}

async function exists(filePath: string): Promise<boolean> {
  try { await lstat(filePath); return true; } catch { return false; }
}

export class GitWorktreeEnvironment implements GitWorktreeEnvironmentPort {
  private readonly now: () => number;
  private readonly nextId: () => string;
  private readonly git: GitCommandRunner;
  private readonly worktreesRoot: string;
  private readonly leasesRoot: string;
  private readonly dataRoot: string;
  private readonly maxSnapshotBytes: number;

  constructor(private readonly deps: GitWorktreeEnvironmentDeps) {
    this.now = deps.now ?? Date.now;
    this.nextId = deps.nextId ?? (() => createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 20));
    this.git = deps.git ?? defaultGitRunner(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    this.maxSnapshotBytes = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.dataRoot = path.resolve(deps.dataRoot);
    this.worktreesRoot = path.join(this.dataRoot, 'agent-runs', 'worktrees');
    this.leasesRoot = path.join(this.dataRoot, 'agent-runs', 'environment-leases');
  }

  async isGitRepository(cwd: string): Promise<boolean> {
    try { return (await this.git(cwd, ['rev-parse', '--is-inside-work-tree'])).toString('utf8').trim() === 'true'; }
    catch { return false; }
  }

  private async repositoryRoot(cwd: string): Promise<string> {
    try {
      const root = (await this.git(cwd, ['rev-parse', '--show-toplevel'])).toString('utf8').trim();
      return await realpath(root);
    } catch {
      throw new ExecutionEnvironmentError('git_required', 'workspace is not a Git repository');
    }
  }

  private async assertNoSymlinkEscape(repositoryRoot: string): Promise<void> {
    const tracked = splitNull(await this.git(repositoryRoot, ['ls-files', '-z']));
    for (const relativePath of tracked) {
      const absolute = path.resolve(repositoryRoot, relativePath);
      if (!isWithin(absolute, repositoryRoot)) throw new ExecutionEnvironmentError('path_escape', `tracked path escapes repository: ${relativePath}`);
      const metadata = await lstat(absolute).catch(() => null);
      if (!metadata?.isSymbolicLink()) continue;
      const target = await realpath(absolute).catch(() => null);
      if (!target || !isWithin(target, repositoryRoot)) {
        throw new ExecutionEnvironmentError('symlink_escape', `tracked symlink escapes repository: ${relativePath}`);
      }
    }
  }

  private async captureUntracked(repositoryRoot: string): Promise<{ files: CapturedFile[]; skippedSensitivePaths: string[] }> {
    const relativePaths = splitNull(await this.git(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z']));
    const files: CapturedFile[] = [];
    const skippedSensitivePaths: string[] = [];
    let totalBytes = 0;
    for (const relativePath of relativePaths) {
      if (SENSITIVE_PATH.test(relativePath)) { skippedSensitivePaths.push(relativePath); continue; }
      if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
        throw new ExecutionEnvironmentError('path_escape', `untracked path escapes repository: ${relativePath}`);
      }
      const absolute = path.resolve(repositoryRoot, relativePath);
      if (!isWithin(absolute, repositoryRoot)) throw new ExecutionEnvironmentError('path_escape', `untracked path escapes repository: ${relativePath}`);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new ExecutionEnvironmentError('symlink_escape', `untracked symlinks are not snapshotted: ${relativePath}`);
      if (!metadata.isFile()) continue;
      const canonical = await realpath(absolute);
      if (!isWithin(canonical, repositoryRoot)) throw new ExecutionEnvironmentError('symlink_escape', `untracked file resolves outside repository: ${relativePath}`);
      const bytes = await readFile(canonical);
      totalBytes += bytes.byteLength;
      if (totalBytes > this.maxSnapshotBytes) throw new ExecutionEnvironmentError('snapshot_failed', 'untracked snapshot exceeds the configured byte limit');
      files.push({ relativePath, bytes, sha256: hash(bytes), size: bytes.byteLength, mode: metadata.mode & 0o777 });
    }
    return { files, skippedSensitivePaths };
  }

  private async assertSafeDestination(worktreeRoot: string, relativePath: string): Promise<string> {
    const destination = path.resolve(worktreeRoot, relativePath);
    if (!isWithin(destination, worktreeRoot)) throw new ExecutionEnvironmentError('path_escape', `destination escapes worktree: ${relativePath}`);
    let cursor = path.dirname(destination);
    while (cursor !== worktreeRoot) {
      if (await exists(cursor)) {
        const metadata = await lstat(cursor);
        if (metadata.isSymbolicLink()) throw new ExecutionEnvironmentError('symlink_escape', `destination parent is a symlink: ${relativePath}`);
      }
      const parent = path.dirname(cursor);
      if (parent === cursor || !isWithin(parent, worktreeRoot)) throw new ExecutionEnvironmentError('path_escape', `destination parent escapes worktree: ${relativePath}`);
      cursor = parent;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    const canonicalParent = await realpath(path.dirname(destination));
    if (!isWithin(canonicalParent, worktreeRoot)) throw new ExecutionEnvironmentError('symlink_escape', `destination parent resolves outside worktree: ${relativePath}`);
    return destination;
  }

  async prepareWorktree(input: PrepareExecutionEnvironmentInput): Promise<ExecutionEnvironmentLease> {
    const repositoryRoot = await this.repositoryRoot(input.workspaceCwd);
    if (isWithin(this.dataRoot, repositoryRoot)) throw new ExecutionEnvironmentError('path_escape', 'Michi data root must be outside the source repository');
    await mkdir(this.dataRoot, { recursive: true });
    const realDataRoot = await realpath(this.dataRoot);
    if (isWithin(realDataRoot, repositoryRoot)) throw new ExecutionEnvironmentError('path_escape', 'Michi data root resolves inside the source repository');
    await mkdir(this.worktreesRoot, { recursive: true });
    await mkdir(this.leasesRoot, { recursive: true });
    const realWorktreesRoot = await realpath(this.worktreesRoot);
    const realLeasesRoot = await realpath(this.leasesRoot);
    if (isWithin(realWorktreesRoot, repositoryRoot) || isWithin(realLeasesRoot, repositoryRoot)) {
      throw new ExecutionEnvironmentError('path_escape', 'Michi data root must be outside the source repository');
    }

    const unresolved = splitNull(await this.git(repositoryRoot, ['diff', '--name-only', '--diff-filter=U', '-z']));
    if (unresolved.length > 0) throw new ExecutionEnvironmentError('unresolved_merge', 'cannot snapshot a repository with unresolved merges', unresolved);
    await this.assertNoSymlinkEscape(repositoryRoot);

    const sourceStatusBefore = await this.git(repositoryRoot, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
    const baseCommit = (await this.git(repositoryRoot, ['rev-parse', 'HEAD'])).toString('utf8').trim();
    const stagedPatch = await this.git(repositoryRoot, ['diff', '--cached', '--binary', '--full-index', 'HEAD']);
    const unstagedPatch = await this.git(repositoryRoot, ['diff', '--binary', '--full-index']);
    if (stagedPatch.byteLength + unstagedPatch.byteLength > this.maxSnapshotBytes) throw new ExecutionEnvironmentError('snapshot_failed', 'tracked snapshot exceeds the configured byte limit');
    const untracked = await this.captureUntracked(repositoryRoot);
    const sourceStatusAfter = await this.git(repositoryRoot, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
    if (!sourceStatusBefore.equals(sourceStatusAfter)) throw new ExecutionEnvironmentError('snapshot_failed', 'source repository changed while its snapshot was being captured');
    const leaseId = this.nextId();
    if (!SAFE_ID.test(leaseId) || !SAFE_ID.test(input.runId)) throw new ExecutionEnvironmentError('path_escape', 'Run and lease IDs must be path-safe');
    const worktreePath = path.join(realWorktreesRoot, `${input.runId}-${leaseId}`);
    const metadataPath = path.join(realLeasesRoot, leaseId);
    if (!isWithin(worktreePath, realWorktreesRoot) || !isWithin(metadataPath, realLeasesRoot)) throw new ExecutionEnvironmentError('path_escape', 'generated worktree path escaped its root');
    if (await exists(worktreePath) || await exists(metadataPath)) throw new ExecutionEnvironmentError('snapshot_failed', 'generated worktree lease already exists');
    await mkdir(metadataPath, { recursive: false });

    const stagedPath = path.join(metadataPath, 'staged.patch');
    const unstagedPath = path.join(metadataPath, 'unstaged.patch');
    await writeFile(stagedPath, stagedPatch);
    await writeFile(unstagedPath, unstagedPatch);
    let worktreeAdded = false;
    try {
      await this.git(repositoryRoot, ['worktree', 'add', '--detach', worktreePath, baseCommit]);
      worktreeAdded = true;
      const canonicalWorktree = await realpath(worktreePath);
      if (!isWithin(canonicalWorktree, realWorktreesRoot) || isWithin(canonicalWorktree, repositoryRoot)) {
        throw new ExecutionEnvironmentError('path_escape', 'created worktree is not under the configured data root');
      }
      try {
        if (stagedPatch.byteLength > 0) await this.git(canonicalWorktree, ['apply', '--binary', '--index', stagedPath]);
        if (unstagedPatch.byteLength > 0) await this.git(canonicalWorktree, ['apply', '--binary', unstagedPath]);
      } catch (error) {
        throw new ExecutionEnvironmentError('patch_failed', 'failed to apply the captured Git patch', { message: error instanceof Error ? error.message : String(error) });
      }
      for (const file of untracked.files) {
        const destination = await this.assertSafeDestination(canonicalWorktree, file.relativePath);
        await writeFile(destination, file.bytes, { flag: 'wx' });
        await chmod(destination, file.mode);
      }

      const snapshotHash = createHash('sha256')
        .update(baseCommit).update('\0').update(hash(stagedPatch)).update('\0').update(hash(unstagedPatch))
        .update('\0').update(JSON.stringify(untracked.files.map(({ relativePath, sha256, size, mode }) => ({ relativePath, sha256, size, mode }))))
        .digest('hex');
      const marker: LeaseMarker = { version: 1, leaseId, ownerRunId: input.runId, sourceRepositoryRoot: repositoryRoot, worktreePath: canonicalWorktree };
      await writeFile(path.join(metadataPath, 'lease.json'), JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
      const provenance: ExecutionEnvironmentProvenanceV1 = {
        version: 1,
        sourceRepositoryRoot: repositoryRoot,
        baseCommit,
        stagedPatchHash: hash(stagedPatch),
        unstagedPatchHash: hash(unstagedPatch),
        untrackedFiles: untracked.files.map(({ relativePath: filePath, sha256, size, mode }) => ({ path: filePath, sha256, size, mode })),
        skippedSensitivePaths: untracked.skippedSensitivePaths,
      };
      return new GitWorktreeLease(this.git, marker, metadataPath, realWorktreesRoot, realLeasesRoot, snapshotHash, input.workspaceId, this.now(), provenance);
    } catch (error) {
      if (worktreeAdded) await this.git(repositoryRoot, ['worktree', 'remove', '--force', worktreePath]).catch(() => undefined);
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
      await rm(metadataPath, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof ExecutionEnvironmentError) throw error;
      throw new ExecutionEnvironmentError('snapshot_failed', 'failed to create isolated Git worktree', { message: error instanceof Error ? error.message : String(error) });
    }
  }
}

class GitWorktreeLease implements ExecutionEnvironmentLease {
  readonly access = 'read_write' as const;
  readonly snapshot;

  constructor(
    private readonly git: GitCommandRunner,
    private readonly marker: LeaseMarker,
    private readonly metadataPath: string,
    private readonly worktreesRoot: string,
    private readonly leasesRoot: string,
    snapshotHash: string,
    workspaceId: string,
    createdAt: number,
    readonly provenance: ExecutionEnvironmentProvenanceV1,
  ) {
    this.snapshot = { version: 1 as const, kind: 'git_worktree' as const, cwd: marker.worktreePath, sourceWorkspaceId: workspaceId, baseCommit: provenance.baseCommit!, snapshotHash, createdAt };
  }

  get leaseId(): string { return this.marker.leaseId; }
  get ownerRunId(): string { return this.marker.ownerRunId; }

  async buildChangeSet(): Promise<GitChangeSetRefV1> {
    const tracked = splitNull(await this.git(this.snapshot.cwd, ['diff', '--name-only', '-z', 'HEAD']));
    const untracked = splitNull(await this.git(this.snapshot.cwd, ['ls-files', '--others', '--exclude-standard', '-z']));
    const changedFiles = [...new Set([...tracked, ...untracked])].sort();
    const diff = await this.git(this.snapshot.cwd, ['diff', '--binary', '--full-index', 'HEAD']);
    const current = createHash('sha256').update(diff);
    for (const relativePath of untracked.sort()) {
      const absolute = await this.safeExistingFile(relativePath);
      current.update('\0').update(relativePath).update('\0').update(await readFile(absolute));
    }
    return {
      baseCommit: this.snapshot.baseCommit!,
      snapshotHash: current.digest('hex'),
      worktreeId: this.leaseId,
      changedFiles,
      summary: changedFiles.length === 1 ? '1 file changed' : `${changedFiles.length} files changed`,
      diffArtifactId: null,
    };
  }

  private async safeExistingFile(relativePath: string): Promise<string> {
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) throw new ExecutionEnvironmentError('path_escape', `change path escapes worktree: ${relativePath}`);
    const absolute = path.resolve(this.snapshot.cwd, relativePath);
    if (!isWithin(absolute, this.snapshot.cwd)) throw new ExecutionEnvironmentError('path_escape', `change path escapes worktree: ${relativePath}`);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new ExecutionEnvironmentError('symlink_escape', `changed file is a symlink: ${relativePath}`);
    const canonical = await realpath(absolute);
    if (!isWithin(canonical, this.snapshot.cwd)) throw new ExecutionEnvironmentError('symlink_escape', `changed file resolves outside worktree: ${relativePath}`);
    return canonical;
  }

  async cleanup(requestingRunId: string): Promise<{ removed: boolean }> {
    if (requestingRunId !== this.ownerRunId) throw new ExecutionEnvironmentError('lease_owner_mismatch', 'worktree lease belongs to another Run');
    const metadataCanonicalParent = await realpath(path.dirname(this.metadataPath));
    if (!isWithin(metadataCanonicalParent, this.leasesRoot) || !isWithin(this.marker.worktreePath, this.worktreesRoot)) throw new ExecutionEnvironmentError('path_escape', 'lease cleanup path escaped its configured root');
    const markerPath = path.join(this.metadataPath, 'lease.json');
    if (!await exists(markerPath)) {
      if (!await exists(this.marker.worktreePath)) return { removed: false };
      throw new ExecutionEnvironmentError('lease_owner_mismatch', 'worktree exists without its ownership marker');
    }
    let persisted: LeaseMarker;
    try { persisted = JSON.parse(await readFile(markerPath, 'utf8')) as LeaseMarker; }
    catch { throw new ExecutionEnvironmentError('lease_owner_mismatch', 'worktree ownership marker is invalid'); }
    if (persisted.version !== 1 || persisted.leaseId !== this.leaseId || persisted.ownerRunId !== requestingRunId || persisted.worktreePath !== this.marker.worktreePath) {
      throw new ExecutionEnvironmentError('lease_owner_mismatch', 'worktree ownership marker does not match the cleanup request');
    }
    try {
      if (await exists(this.marker.worktreePath)) {
        await this.git(this.marker.sourceRepositoryRoot, ['worktree', 'remove', '--force', this.marker.worktreePath]);
        await rm(this.marker.worktreePath, { recursive: true, force: true });
      }
      await rm(this.metadataPath, { recursive: true, force: true });
      return { removed: true };
    } catch (error) {
      throw new ExecutionEnvironmentError('cleanup_failed', 'failed to clean up Git worktree', { message: error instanceof Error ? error.message : String(error) });
    }
  }
}
