import { randomUUID } from 'node:crypto';
import type { AgentRunCleanupResources } from '../agents/runs/ports';
import { getDb, runInTransaction } from './db';
import {
  AGENT_OWNER_DELETION_LEASE_MS,
  acquireAgentOwnerDeletion,
  releaseAgentOwnerDeletion,
  requireAgentOwnerDeletion,
} from './agentOwnerDeletionGate';

export interface AgentRunAdministrativeLifecycleDeps {
  /** Stop/checkpoint one active Run and wait until its lease is no longer live. */
  quiesceRun: (ownerUserId: string, runId: string) => Promise<void>;
  /** Remove Run-owned context snapshots and execution environments. Idempotent. */
  cleanupRun: (runId: string, resources: AgentRunCleanupResources) => Promise<void>;
  auditCleanupFailure?: (input: { ownerUserId: string; runId: string; message: string }) => void;
  now?: () => number;
  createDeletionToken?: () => string;
  instanceId?: string;
}

export interface PreparedAgentOwnerDeletion {
  ownerUserId: string;
  deletionToken: string;
  runIds: string[];
  resourcesByRunId: ReadonlyMap<string, AgentRunCleanupResources>;
}

export interface AgentOwnerCleanupResult {
  cleanedRunIds: string[];
  failed: Array<{ runId: string; message: string }>;
}

/** Coordinates destructive owner deletion with durable Run leases.
 *
 * Database deletion deliberately remains in the route's existing transaction,
 * while this service owns the two side-effect boundaries around it:
 * quiesce before commit and auditable filesystem cleanup after commit.
 */
export class AgentRunAdministrativeLifecycle {
  private readonly now: () => number;
  private readonly createDeletionToken: () => string;
  private readonly instanceId: string;
  private readonly cleanupInFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: AgentRunAdministrativeLifecycleDeps) {
    this.now = deps.now ?? Date.now;
    this.createDeletionToken = deps.createDeletionToken ?? (() => `owner-delete-${randomUUID()}`);
    this.instanceId = deps.instanceId ?? `admin-${process.pid}`;
  }

  async prepareOwnerDeletion(ownerUserId: string): Promise<PreparedAgentOwnerDeletion> {
    const deletionToken = this.createDeletionToken();
    const acquiredAt = this.now();
    const acquired = runInTransaction(() => acquireAgentOwnerDeletion({
      ownerUserId,
      deletionToken,
      leaseOwner: this.instanceId,
      now: acquiredAt,
      expiresAt: acquiredAt + AGENT_OWNER_DELETION_LEASE_MS,
    }));
    if (!acquired) throw new Error('Agent owner deletion is already in progress');

    try {
      const rows = getDb().prepare(`SELECT id, status, lease_token FROM agent_runs
        WHERE owner_user_id = ? ORDER BY id`).all(ownerUserId) as Array<{
          id: string;
          status: string;
          lease_token: string | null;
        }>;
      const terminal = new Set(['completed', 'failed', 'cancelled']);
      for (const row of rows) {
        if (!terminal.has(row.status) || row.lease_token !== null) {
          await this.deps.quiesceRun(ownerUserId, row.id);
        }
      }

      const remaining = this.activeOwnerRuns(ownerUserId);
      if (remaining.length) {
        const detail = remaining.map((row) => `${row.id}:${row.status}${row.lease_token ? ':leased' : ''}`).join(', ');
        throw new Error(`Agent Runs could not be quiesced: ${detail}`);
      }
      const preparedRows = getDb().prepare(`SELECT id, context_manifest, execution_environment FROM agent_runs
        WHERE owner_user_id = ? ORDER BY id`).all(ownerUserId) as Array<{
          id: string;
          context_manifest: string;
          execution_environment: string;
        }>;
      return {
        ownerUserId,
        deletionToken,
        runIds: preparedRows.map((row) => row.id),
        resourcesByRunId: new Map(preparedRows.map((row) => [row.id, {
          contextManifest: JSON.parse(row.context_manifest),
          executionEnvironment: JSON.parse(row.execution_environment),
        }])),
      };
    } catch (error) {
      releaseAgentOwnerDeletion(ownerUserId, deletionToken);
      throw error;
    }
  }

  /** Must be called inside the caller's business-data transaction. */
  deleteOwnerAgentRows(prepared: PreparedAgentOwnerDeletion): void {
    const db = getDb();
    requireAgentOwnerDeletion(prepared.ownerUserId, prepared.deletionToken, this.now());
    const remaining = this.activeOwnerRuns(prepared.ownerUserId);
    if (remaining.length) {
      const detail = remaining.map((row) => `${row.id}:${row.status}${row.lease_token ? ':leased' : ''}`).join(', ');
      throw new Error(`Agent Runs could not be quiesced: ${detail}`);
    }
    const actualRunIds = (db.prepare(`SELECT id FROM agent_runs WHERE owner_user_id = ? ORDER BY id`)
      .all(prepared.ownerUserId) as Array<{ id: string }>).map((row) => row.id);
    for (const runId of actualRunIds) {
      const resources = prepared.resourcesByRunId.get(runId);
      if (!resources) throw new Error(`Run ${runId} appeared after owner quiescence`);
      const now = this.now();
      db.prepare(`INSERT INTO agent_run_cleanup_jobs
        (run_id, owner_user_id, context_manifest, execution_environment, attempts, last_error, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, NULL, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          owner_user_id = excluded.owner_user_id,
          context_manifest = excluded.context_manifest,
          execution_environment = excluded.execution_environment,
          updated_at = excluded.updated_at`).run(
        runId,
        prepared.ownerUserId,
        JSON.stringify(resources.contextManifest),
        JSON.stringify(resources.executionEnvironment),
        now,
        now,
      );
    }
    db.prepare('DELETE FROM agent_run_watches WHERE owner_user_id = ?').run(prepared.ownerUserId);
    db.prepare('DELETE FROM agent_runs WHERE owner_user_id = ?').run(prepared.ownerUserId);
    db.prepare('DELETE FROM agent_definitions WHERE owner_user_id = ?').run(prepared.ownerUserId);
  }

  async cleanupPreparedDeletion(prepared: PreparedAgentOwnerDeletion): Promise<AgentOwnerCleanupResult> {
    const cleanedRunIds: string[] = [];
    const failed: AgentOwnerCleanupResult['failed'] = [];
    for (const runId of prepared.runIds) {
      try {
        const resources = prepared.resourcesByRunId.get(runId);
        if (!resources) throw new Error('Run cleanup metadata is missing');
        await this.cleanupRunResources(runId, resources);
        getDb().prepare('DELETE FROM agent_run_cleanup_jobs WHERE run_id = ?').run(runId);
        cleanedRunIds.push(runId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ runId, message });
        getDb().prepare(`UPDATE agent_run_cleanup_jobs SET
          attempts = attempts + 1, last_error = ?, updated_at = ? WHERE run_id = ?`).run(
          message,
          this.now(),
          runId,
        );
        try {
          this.deps.auditCleanupFailure?.({ ownerUserId: prepared.ownerUserId, runId, message });
        } catch {
          // Cleanup remains retryable even if the optional audit sink is unavailable.
        }
      }
    }
    return { cleanedRunIds, failed };
  }

  async retryPendingCleanup(limit = 50): Promise<AgentOwnerCleanupResult> {
    const rows = getDb().prepare(`SELECT run_id, owner_user_id, context_manifest, execution_environment
      FROM agent_run_cleanup_jobs ORDER BY updated_at, run_id LIMIT ?`).all(
      Math.max(1, Math.min(limit, 200)),
    ) as Array<{
      run_id: string;
      owner_user_id: string;
      context_manifest: string;
      execution_environment: string;
    }>;
    const cleanedRunIds: string[] = [];
    const failed: AgentOwnerCleanupResult['failed'] = [];
    for (const row of rows) {
      try {
        await this.cleanupRunResources(row.run_id, {
          contextManifest: JSON.parse(row.context_manifest),
          executionEnvironment: JSON.parse(row.execution_environment),
        });
        getDb().prepare('DELETE FROM agent_run_cleanup_jobs WHERE run_id = ?').run(row.run_id);
        cleanedRunIds.push(row.run_id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ runId: row.run_id, message });
        getDb().prepare(`UPDATE agent_run_cleanup_jobs SET
          attempts = attempts + 1, last_error = ?, updated_at = ? WHERE run_id = ?`).run(
          message,
          this.now(),
          row.run_id,
        );
        try {
          this.deps.auditCleanupFailure?.({ ownerUserId: row.owner_user_id, runId: row.run_id, message });
        } catch {
          // The durable job remains available even when the audit sink fails.
        }
      }
    }
    return { cleanedRunIds, failed };
  }

  finishOwnerDeletion(prepared: PreparedAgentOwnerDeletion): void {
    releaseAgentOwnerDeletion(prepared.ownerUserId, prepared.deletionToken);
  }

  abortOwnerDeletion(prepared: PreparedAgentOwnerDeletion): void {
    releaseAgentOwnerDeletion(prepared.ownerUserId, prepared.deletionToken);
  }

  private activeOwnerRuns(ownerUserId: string): Array<{ id: string; status: string; lease_token: string | null }> {
    return getDb().prepare(`SELECT id, status, lease_token FROM agent_runs
      WHERE owner_user_id = ? AND (status NOT IN ('completed','failed','cancelled') OR lease_token IS NOT NULL)
      ORDER BY id`).all(ownerUserId) as Array<{ id: string; status: string; lease_token: string | null }>;
  }

  private cleanupRunResources(runId: string, resources: AgentRunCleanupResources): Promise<void> {
    const existing = this.cleanupInFlight.get(runId);
    if (existing) return existing;
    const task = this.deps.cleanupRun(runId, resources).finally(() => {
      this.cleanupInFlight.delete(runId);
    });
    this.cleanupInFlight.set(runId, task);
    return task;
  }
}
