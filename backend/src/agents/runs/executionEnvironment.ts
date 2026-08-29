import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type {
  AgentPermissionPolicyV1,
  ExecutionEnvironmentRequestV1,
  ExecutionEnvironmentSnapshotV1,
  GitChangeSetRefV1,
  JsonValue,
} from 'michi-shared';
import { AgentPolicyCategory, AgentPolicyDecision } from 'michi-shared';

export type ExecutionEnvironmentAccess = 'read_only' | 'read_write';

export interface ExecutionEnvironmentProvenanceV1 {
  version: 1;
  sourceRepositoryRoot: string | null;
  baseCommit: string | null;
  stagedPatchHash: string | null;
  unstagedPatchHash: string | null;
  untrackedFiles: Array<{ path: string; sha256: string; size: number; mode: number }>;
  skippedSensitivePaths: string[];
}

export interface ExecutionEnvironmentLease {
  readonly leaseId: string;
  readonly ownerRunId: string;
  readonly access: ExecutionEnvironmentAccess;
  readonly snapshot: ExecutionEnvironmentSnapshotV1;
  readonly provenance: ExecutionEnvironmentProvenanceV1;
  buildChangeSet(): Promise<GitChangeSetRefV1 | null>;
  cleanup(requestingRunId: string): Promise<{ removed: boolean }>;
}

export interface PrepareExecutionEnvironmentInput {
  runId: string;
  workspaceId: string;
  workspaceCwd: string;
  request: ExecutionEnvironmentRequestV1;
  permissionPolicy: AgentPermissionPolicyV1;
}

export interface ExecutionEnvironmentProvider {
  prepare(input: PrepareExecutionEnvironmentInput): Promise<ExecutionEnvironmentLease>;
}

export interface GitWorktreeEnvironmentPort {
  isGitRepository(cwd: string): Promise<boolean>;
  prepareWorktree(input: PrepareExecutionEnvironmentInput): Promise<ExecutionEnvironmentLease>;
}

export class ExecutionEnvironmentError extends Error {
  constructor(
    public readonly code:
      | 'invalid_workspace'
      | 'permission_denied'
      | 'git_required'
      | 'unresolved_merge'
      | 'path_escape'
      | 'symlink_escape'
      | 'snapshot_failed'
      | 'patch_failed'
      | 'lease_owner_mismatch'
      | 'cleanup_failed',
    message: string,
    public readonly details: JsonValue | undefined = undefined,
  ) {
    super(message);
    this.name = 'ExecutionEnvironmentError';
  }
}

function decision(policy: AgentPermissionPolicyV1, category: AgentPolicyCategory): AgentPolicyDecision | undefined {
  return policy.categories[category];
}

/** Whether the effective policy can mutate or execute against workspace files. */
export function policyNeedsFilesystemWrite(policy: AgentPermissionPolicyV1): boolean {
  const fileWrite = decision(policy, AgentPolicyCategory.FilesystemWrite);
  const shell = decision(policy, AgentPolicyCategory.ShellExec);
  if (fileWrite === AgentPolicyDecision.Allow || fileWrite === AgentPolicyDecision.Ask) return true;
  if (shell === AgentPolicyDecision.Allow || shell === AgentPolicyDecision.Ask) return true;
  return policy.preset === 'build'
    && fileWrite !== AgentPolicyDecision.Deny
    && shell !== AgentPolicyDecision.Deny;
}

class SharedWorkspaceLease implements ExecutionEnvironmentLease {
  readonly leaseId: string;
  readonly provenance: ExecutionEnvironmentProvenanceV1;

  constructor(
    readonly ownerRunId: string,
    readonly access: ExecutionEnvironmentAccess,
    readonly snapshot: ExecutionEnvironmentSnapshotV1,
  ) {
    this.leaseId = `shared:${ownerRunId}`;
    this.provenance = {
      version: 1,
      sourceRepositoryRoot: null,
      baseCommit: null,
      stagedPatchHash: null,
      unstagedPatchHash: null,
      untrackedFiles: [],
      skippedSensitivePaths: [],
    };
  }

  async buildChangeSet(): Promise<null> { return null; }

  async cleanup(requestingRunId: string): Promise<{ removed: boolean }> {
    if (requestingRunId !== this.ownerRunId) {
      throw new ExecutionEnvironmentError('lease_owner_mismatch', 'shared environment lease belongs to another Run');
    }
    return { removed: false };
  }
}

export interface DefaultExecutionEnvironmentProviderDeps {
  worktrees: GitWorktreeEnvironmentPort;
  now?: () => number;
}

export class DefaultExecutionEnvironmentProvider implements ExecutionEnvironmentProvider {
  private readonly now: () => number;

  constructor(private readonly deps: DefaultExecutionEnvironmentProviderDeps) {
    this.now = deps.now ?? Date.now;
  }

  async prepare(input: PrepareExecutionEnvironmentInput): Promise<ExecutionEnvironmentLease> {
    let cwd: string;
    try {
      cwd = await realpath(input.workspaceCwd);
    } catch {
      throw new ExecutionEnvironmentError('invalid_workspace', 'workspace cwd does not exist');
    }
    const normalized = { ...input, workspaceCwd: cwd };
    const needsWrite = policyNeedsFilesystemWrite(input.permissionPolicy);

    if (input.request.kind === 'shared_workspace') {
      if (input.request.access === 'read_write' && !needsWrite) {
        throw new ExecutionEnvironmentError('permission_denied', 'shared read-write requires an effective write permission');
      }
      const access = input.request.access;
      const snapshotHash = createHash('sha256').update(`shared\0${cwd}\0${access}`).digest('hex');
      return new SharedWorkspaceLease(input.runId, access, {
        version: 1,
        kind: 'shared_workspace',
        cwd,
        sourceWorkspaceId: input.workspaceId,
        snapshotHash,
        createdAt: this.now(),
      });
    }

    if (input.request.kind === 'git_worktree') {
      if (!await this.deps.worktrees.isGitRepository(cwd)) {
        throw new ExecutionEnvironmentError('git_required', 'git_worktree requires a Git repository');
      }
      return this.deps.worktrees.prepareWorktree(normalized);
    }

    if (!needsWrite) {
      const snapshotHash = createHash('sha256').update(`shared\0${cwd}\0read_only`).digest('hex');
      return new SharedWorkspaceLease(input.runId, 'read_only', {
        version: 1,
        kind: 'shared_workspace',
        cwd,
        sourceWorkspaceId: input.workspaceId,
        snapshotHash,
        createdAt: this.now(),
      });
    }

    if (!await this.deps.worktrees.isGitRepository(cwd)) {
      throw new ExecutionEnvironmentError('git_required', 'automatic write-capable Runs require a Git worktree');
    }
    return this.deps.worktrees.prepareWorktree(normalized);
  }
}
