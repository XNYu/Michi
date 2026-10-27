/**
 * Meta agent maintenance transcripts are background runs, not the user's
 * conversations: every ordinary search leaves them out, while workspace
 * snapshots keep them (with their marker) so the renderer can hide them.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { closeDb, initDb } from '../src/services/db';
import { loadAllWorkspacesMeta, loadFullWorkspace, markNodeMaintenanceJob, saveMessage, saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';
import { keywordSearch, nodeGroupedSearch, setupSearchRoutes } from '../src/routes/search';

function seedChat(id: string, title: string, content: string): void {
  saveTree({ id: `t-${id}`, workspace_id: 'ws-a', root_node_id: id, last_active_at: 1, created_at: 1 });
  saveNode({ id, workspace_id: 'ws-a', tree_id: `t-${id}`, kind: 'chat', title, status: 'idle', minimized: 0, spawned_by_agent: 0, runtime_id: 'claude', created_at: 1 });
  saveMessage({ id: `m-${id}`, node_id: id, role: 'user', content, seq: 1, created_at: 1 });
}

describe('maintenance transcripts and search', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-search-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    saveWorkspace({ id: 'ws-a', name: 'A', cwd: '/tmp/a', created_at: 1, updated_at: 1, settings: null });
    seedChat('n-user', 'Heron rollout', 'heron rollout checklist');
    seedChat('n-run', 'Space maintenance · Heron', 'heron maintenance batch');
    markNodeMaintenanceJob('n-run', 'job-maint');
    // A branch from a maintenance transcript inherits its marker from the stored parent.
    saveNode({ id: 'n-run-child', workspace_id: 'ws-a', tree_id: 't-n-run', parent_node_id: 'n-run', kind: 'chat', title: 'Heron follow-up', status: 'idle', minimized: 0, spawned_by_agent: 0, runtime_id: 'claude', created_at: 2 });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('keyword, grouped and title search return only the user conversation', async () => {
    assert.deepEqual(keywordSearch('heron').map((row) => row.node_id), ['n-user']);
    assert.deepEqual(keywordSearch('heron', 'ws-a').map((row) => row.node_id), ['n-user']);
    assert.deepEqual(nodeGroupedSearch('heron').map((row) => row.nodeId), ['n-user']);
    assert.deepEqual(nodeGroupedSearch('maintenance').map((row) => row.nodeId), []);
    assert.deepEqual(nodeGroupedSearch('follow-up').map((row) => row.nodeId), []);

    const app = express();
    app.use('/api', setupSearchRoutes());
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/search?q=heron`;
      for (const mode of ['', '&mode=grouped', '&mode=semantic']) {
        const body = await (await fetch(base + mode)).json() as { results: Array<{ node_id?: string; nodeId?: string }> };
        assert.deepEqual(body.results.map((row) => row.node_id ?? row.nodeId), ['n-user'], `mode "${mode}"`);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('workspace snapshots keep the transcripts with their marker', () => {
    const full = loadFullWorkspace('ws-a')!;
    assert.equal(full.nodes.find((node) => node.id === 'n-run')?.maintenance_job_id, 'job-maint');
    assert.equal(full.nodes.find((node) => node.id === 'n-run-child')?.maintenance_job_id, 'job-maint');
    assert.equal(full.nodes.find((node) => node.id === 'n-user')?.maintenance_job_id ?? null, null);
    const meta = loadAllWorkspacesMeta().find((workspace) => workspace.workspace.id === 'ws-a')!;
    assert.deepEqual(meta.nodes.map((node) => [node.id, node.maintenance_job_id ?? null]).sort(),
      [['n-run', 'job-maint'], ['n-run-child', 'job-maint'], ['n-user', null]]);
  });
});
