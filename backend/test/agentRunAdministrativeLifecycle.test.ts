import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { closeDb, getDb, initDb } from '../src/services/db';
import { AgentRunAdministrativeLifecycle } from '../src/services/agentRunAdministrativeLifecycle';
import { AgentRunsRepository } from '../src/services/agentRunsRepository';

let dataDir: string;

function seedRun(id: string, status: 'queued' | 'running' | 'completed', lease = false): void {
  const completedAt = status === 'completed' ? 2 : null;
  getDb().prepare(`INSERT INTO agent_runs (
    id, owner_user_id, workspace_id, effective_definition, invocation_mode, completion_mode,
    task, context_manifest, execution_environment, status, lease_token, lease_owner,
    lease_expires_at, created_at, updated_at, completed_at
  ) VALUES (?, 'owner-a', 'ws-a', ?, 'manual', 'detach', 'task', ?, ?, ?, ?, ?, ?, 1, 1, ?)`)
    .run(
      id,
      JSON.stringify({ version: 1 }),
      JSON.stringify({ version: 1 }),
      JSON.stringify({ version: 1 }),
      status,
      lease ? `lease-${id}` : null,
      lease ? 'instance-a' : null,
      lease ? 99 : null,
      completedAt,
    );
}

describe('AgentRunAdministrativeLifecycle', () => {
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-agent-admin-'));
    process.env.MICHI_DATA_DIR = dataDir;
    closeDb();
    initDb();
    getDb().prepare("INSERT INTO workspaces (id,name,owner_user_id,created_at,updated_at) VALUES ('ws-a','Workspace','owner-a',1,1)").run();
    getDb().prepare(`INSERT INTO agent_definitions (
      id, owner_user_id, scope, workspace_id, name, description, instructions, runtime_profile,
      context_policy, status, revision, created_at, updated_at
    ) VALUES ('definition-a','owner-a','workspace','ws-a','Worker','','Work',?,?,'draft',1,1,1)`)
      .run(JSON.stringify({ version: 1, runtimeId: 'pi' }), JSON.stringify({ version: 1 }));
  });

  afterEach(() => {
    closeDb();
    delete process.env.MICHI_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('quiesces active leases before deletion and reports retryable cleanup failures', async () => {
    seedRun('run-active', 'running', true);
    seedRun('run-done', 'completed');
    const quiesced: string[] = [];
    const audited: string[] = [];
    const lifecycle = new AgentRunAdministrativeLifecycle({
      quiesceRun: async (_owner, runId) => {
        quiesced.push(runId);
        getDb().prepare(`UPDATE agent_runs SET status = 'cancelled', completed_at = 3,
          lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE id = ?`).run(runId);
      },
      cleanupRun: async (runId, resources) => {
        assert.deepEqual(resources.executionEnvironment, { version: 1 });
        if (runId === 'run-done') throw new Error('filesystem busy');
      },
      auditCleanupFailure: ({ runId }) => audited.push(runId),
    });

    const prepared = await lifecycle.prepareOwnerDeletion('owner-a');
    assert.deepEqual(quiesced, ['run-active']);
    assert.deepEqual(prepared.runIds, ['run-active', 'run-done']);
    lifecycle.deleteOwnerAgentRows(prepared);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM agent_runs').get() as { count: number }).count, 0);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM agent_definitions').get() as { count: number }).count, 0);
    const cleanup = await lifecycle.cleanupPreparedDeletion(prepared);
    assert.deepEqual(cleanup.cleanedRunIds, ['run-active']);
    assert.deepEqual(cleanup.failed, [{ runId: 'run-done', message: 'filesystem busy' }]);
    assert.deepEqual(audited, ['run-done']);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM agent_run_cleanup_jobs').get() as { count: number }).count, 1);
    lifecycle.finishOwnerDeletion(prepared);
  });

  test('aborts destructive deletion when a Run remains active or leased', async () => {
    seedRun('run-stuck', 'running', true);
    const lifecycle = new AgentRunAdministrativeLifecycle({
      quiesceRun: async () => {},
      cleanupRun: async () => {},
    });
    await assert.rejects(() => lifecycle.prepareOwnerDeletion('owner-a'), /could not be quiesced.*run-stuck/);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM agent_runs').get() as { count: number }).count, 1);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM agent_owner_deletions').get() as { count: number }).count, 0);
  });

  test('rechecks the deletion barrier inside the delete transaction', async () => {
    seedRun('run-done', 'completed');
    const lifecycle = new AgentRunAdministrativeLifecycle({
      quiesceRun: async () => {},
      cleanupRun: async () => {},
    });
    const prepared = await lifecycle.prepareOwnerDeletion('owner-a');
    seedRun('run-late', 'queued');
    assert.throws(() => new AgentRunsRepository().claimRun(
      'owner-a', 'run-late', 'other-instance', 'late-lease', Date.now() + 30_000, -1,
    ), /being deleted/);
    assert.throws(() => lifecycle.deleteOwnerAgentRows(prepared), /could not be quiesced.*run-late/);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM agent_runs').get() as { count: number }).count, 2);
    lifecycle.abortOwnerDeletion(prepared);
  });

  test('persists failed cleanup and removes the durable job on a later retry', async () => {
    seedRun('run-done', 'completed');
    let fail = true;
    const lifecycle = new AgentRunAdministrativeLifecycle({
      quiesceRun: async () => {},
      cleanupRun: async () => {
        if (fail) throw new Error('filesystem busy');
      },
    });
    const prepared = await lifecycle.prepareOwnerDeletion('owner-a');
    getDb().exec('BEGIN');
    try {
      lifecycle.deleteOwnerAgentRows(prepared);
      getDb().exec('COMMIT');
    } catch (error) {
      getDb().exec('ROLLBACK');
      throw error;
    }
    const first = await lifecycle.cleanupPreparedDeletion(prepared);
    assert.deepEqual(first.failed, [{ runId: 'run-done', message: 'filesystem busy' }]);
    fail = false;
    const retried = await lifecycle.retryPendingCleanup();
    assert.deepEqual(retried.cleanedRunIds, ['run-done']);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM agent_run_cleanup_jobs').get() as { count: number }).count, 0);
    lifecycle.finishOwnerDeletion(prepared);
  });
});
