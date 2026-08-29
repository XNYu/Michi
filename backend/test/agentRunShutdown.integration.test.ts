import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentRunAssembly, FileSystemRunCleaner } from '../src/agents/agentRunAssembly';
import { closeDb, getDb, initDb } from '../src/services/db';

class FakeClock {
  next = 0;
  timers = new Map<number, () => void>();
  now = () => 10_000;
  setTimeout = (callback: () => void) => { const id = ++this.next; this.timers.set(id, callback); return id; };
  clearTimeout = (handle: unknown) => { this.timers.delete(handle as number); };
}

describe('Agent Run shutdown integration', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-run-shutdown-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb(); initDb();
  });
  afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('shutdown is idempotent, rejects new work, and leaves no timers or live sessions', async () => {
    const clock = new FakeClock();
    let shutdowns = 0;
    let liveSessions = 1;
    const coordinator = {
      events: { subscribeAll: () => () => {} },
      start: async () => null,
      shutdown: async () => { shutdowns += 1; liveSessions = 0; },
    } as any;
    const assembly = createAgentRunAssembly({ enabled: true, dataDir: tmpDir, clock, coordinator,
      watches: { recoverStartupWatches: async () => ({ activeEvaluated: 0, deliveriesRetried: 0, failures: [] }) } as any,
      recoverySource: { list: () => [], reclaimExpired: () => false },
      retention: { cleanupExpired: async () => ({ archived: 0, deleted: 0, deferred: 0, failures: [] }) } as any,
      heartbeatIntervalMs: 10, maintenanceIntervalMs: 20 });
    await assembly.start();
    assert.equal(assembly.activeTimerCount(), 2);
    assert.equal(clock.timers.size, 2);
    await assembly.shutdown();
    await assembly.shutdown();
    assert.equal(shutdowns, 1);
    assert.equal(liveSessions, 0);
    assert.equal(assembly.activeTimerCount(), 0);
    assert.equal(clock.timers.size, 0);
    assert.throws(() => assembly.createToolInvoker({ kind: 'conversation', ownerUserId: 'owner-1', workspaceId: 'workspace-1', parentNodeId: 'node-1' }), /shutting down/);
    await assert.rejects(() => assembly.routeService.spawn('owner-1', {} as any, 'after-shutdown'), /unavailable/);
  });

  test('TTL cleanup failure preserves the Run and succeeds on the next maintenance pass', async () => {
    getDb().prepare(`INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at)
      VALUES ('workspace-1', 'Workspace', 'owner-1', 1, 1)`).run();
    getDb().prepare(`INSERT INTO agent_runs (
      id, owner_user_id, workspace_id, effective_definition, invocation_mode, completion_mode,
      task, task_search_text, agent_name_snapshot, handoff_search_text, context_manifest,
      execution_environment, status, latest_event_seq, created_at, updated_at, completed_at, expires_at
    ) VALUES (
      'expired-run', 'owner-1', 'workspace-1', '{"version":1}', 'manual', 'detach',
      'expired', 'expired', 'worker', '', '{"version":1,"entries":[]}',
      '{"version":1,"kind":"shared_workspace"}', 'completed', -1, 1, 1, 2, 3
    )`).run();
    let attempts = 0;
    const retention = {
      cleanupExpired: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('filesystem cleanup failed');
        getDb().prepare("DELETE FROM agent_runs WHERE id = 'expired-run'").run();
        return { archived: 0, deleted: 1, deferred: 0, failures: [] };
      },
    };
    const assembly = createAgentRunAssembly({ enabled: true, dataDir: tmpDir, clock: new FakeClock(),
      coordinator: { events: { subscribeAll: () => () => {} } } as any,
      watches: { recoverStartupWatches: async () => ({ activeEvaluated: 0, deliveriesRetried: 0, failures: [] }) } as any,
      recoverySource: { list: () => [], reclaimExpired: () => false }, retention: retention as any,
      heartbeatIntervalMs: 0, maintenanceIntervalMs: 0 });
    await assert.rejects(() => assembly.runMaintenance(), /filesystem cleanup failed/);
    assert.ok(getDb().prepare("SELECT 1 FROM agent_runs WHERE id = 'expired-run'").get(), 'failed cleanup must retain the Run for retry');
    await assembly.runMaintenance();
    assert.equal(attempts, 2);
    assert.equal(getDb().prepare("SELECT 1 FROM agent_runs WHERE id = 'expired-run'").get(), undefined);
  });

  test('filesystem cleanup propagates context-store failures for retention retry', async () => {
    getDb().prepare(`INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at)
      VALUES ('workspace-1', 'Workspace', 'owner-1', 1, 1)`).run();
    getDb().prepare(`INSERT INTO agent_runs (
      id, owner_user_id, workspace_id, effective_definition, invocation_mode, completion_mode,
      task, task_search_text, agent_name_snapshot, handoff_search_text, context_manifest,
      execution_environment, status, latest_event_seq, created_at, updated_at, completed_at
    ) VALUES (
      'cleanup-run', 'owner-1', 'workspace-1', '{"version":1}', 'manual', 'detach',
      'cleanup', 'cleanup', 'worker', '', '{"version":1,"entries":[]}',
      '{"version":1,"kind":"shared_workspace"}', 'completed', -1, 1, 1, 2
    )`).run();
    const cleaner = new FileSystemRunCleaner(tmpDir, {
      snapshot: async ({ manifest }: any) => manifest,
      cleanup: async () => { throw new Error('context cleanup failed'); },
    });
    await assert.rejects(() => cleaner.cleanup('cleanup-run'), /context cleanup failed/);
  });

  test('filesystem cleanup uses captured resources after the Run row is deleted', async () => {
    const snapshotRoot = path.join(tmpDir, 'agent-runs', 'context-snapshots', 'deleted-run');
    const snapshotPath = path.join(snapshotRoot, 'files', 'note.txt');
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, 'snapshot');
    let contextCleanupRunId: string | null = null;
    const cleaner = new FileSystemRunCleaner(tmpDir, {
      snapshot: async ({ manifest }: any) => manifest,
      cleanup: async (runId) => { contextCleanupRunId = runId; },
    });
    await cleaner.cleanupResources('deleted-run', {
      contextManifest: {
        version: 1,
        entries: [{
          kind: 'file',
          workspacePath: 'note.txt',
          snapshotPath,
          size: 8,
          sha256: 'a'.repeat(64),
        }],
        assembledAt: 1,
        estimatedChars: 8,
      },
      executionEnvironment: {
        version: 1,
        kind: 'shared_workspace',
        cwd: tmpDir,
        sourceWorkspaceId: 'workspace-1',
        snapshotHash: 'b'.repeat(64),
        createdAt: 1,
      },
    });
    assert.equal(fs.existsSync(snapshotRoot), false);
    assert.equal(contextCleanupRunId, 'deleted-run');
  });
});
