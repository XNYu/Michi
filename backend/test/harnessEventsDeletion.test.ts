/**
 * harness_events payloads carry conversation text, keyed by node_id with no
 * foreign key. Every path that deletes or purges a workspace or node must
 * remove that node's harness_events rows in the same transaction.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, test } from 'node:test';
import express from 'express';
import { setupAdminRoutes } from '../src/routes/admin';
import { replaceWorkspaceInTransaction } from '../src/routes/backup';
import { closeAuditDb, closeDb, getDb, initDb, runInTransaction } from '../src/services/db';
import {
  deleteTree, deleteWorkspace, emptyWorkspaceTrash, purgeWorkspaceNodes, runTombstoneGc,
  saveNode, saveTree, saveWorkspace, TOMBSTONE_TTL_MS,
} from '../src/services/dbRepository';
import { createSqliteHarnessJournal } from '../src/services/harnessJournal';

let dataDir: string;

function seedWorkspace(id: string, owner: string | null = null): void {
  saveWorkspace({ id, name: id, cwd: null, created_at: 1, updated_at: 1, settings: null, owner_user_id: owner });
}

function seedNode(workspaceId: string, id: string, opts: { tree?: boolean; deletedAt?: number } = {}): void {
  if (opts.tree) {
    saveTree({ id: `t-${id}`, workspace_id: workspaceId, root_node_id: id, last_active_at: 1, created_at: 1 });
  }
  saveNode({
    id, workspace_id: workspaceId, tree_id: opts.tree ? `t-${id}` : null, kind: 'chat', title: id,
    status: 'idle', minimized: 0, spawned_by_agent: 0, deleted_at: opts.deletedAt ?? null, created_at: 1,
  });
  const journal = createSqliteHarnessJournal();
  for (let seq = 0; seq < 2; seq++) {
    journal.append({ nodeId: id, turnId: 'turn-1', seq, event: 'chunk', payload: JSON.stringify({ text: `secret of ${id}` }), createdAt: 1 });
  }
}

function harnessNodes(): string[] {
  return (getDb().prepare('SELECT DISTINCT node_id FROM harness_events ORDER BY node_id').all() as Array<{ node_id: string }>)
    .map((row) => row.node_id);
}

function createAuthUser(id: string): void {
  const db = new DatabaseSync(path.join(dataDir, 'auth.sqlite'));
  db.exec(`
    CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE "session" (id TEXT PRIMARY KEY, "userId" TEXT NOT NULL);
    CREATE TABLE "account" (id TEXT PRIMARY KEY, "userId" TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO "user" (id,email,name,created_at) VALUES (?,?,?,1)').run(id, `${id}@example.com`, id);
  db.close();
}

describe('harness_events follow workspace and node deletion', () => {
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-harness-deletion-'));
    process.env.MICHI_DATA_DIR = dataDir;
    delete process.env.MICHI_CLOUD;
    closeDb(); closeAuditDb(); initDb();
    seedWorkspace('ws-keep');
    seedNode('ws-keep', 'n-keep', { tree: true });
  });

  afterEach(() => {
    closeDb(); closeAuditDb();
    delete process.env.MICHI_DATA_DIR;
    delete process.env.MICHI_CLOUD;
    delete process.env.MICHI_REQUIRE_AUTH;
    delete process.env.MICHI_ADMIN_EMAILS;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('deleteWorkspace removes events of every node, in or out of a Tree', () => {
    seedWorkspace('ws-gone');
    seedNode('ws-gone', 'n-tree', { tree: true });
    seedNode('ws-gone', 'n-loose');
    deleteWorkspace('ws-gone');
    assert.deepEqual(harnessNodes(), ['n-keep']);
  });

  test('purgeWorkspaceNodes removes events of the purged nodes only', () => {
    seedNode('ws-keep', 'n-purge', { deletedAt: 5 });
    seedNode('ws-keep', 'n-trash', { deletedAt: 5 });
    purgeWorkspaceNodes('ws-keep', ['n-purge']);
    assert.deepEqual(harnessNodes(), ['n-keep', 'n-trash']);
  });

  test('emptyWorkspaceTrash removes events of the purged trash', () => {
    seedNode('ws-keep', 'n-trash', { tree: true, deletedAt: 5 });
    emptyWorkspaceTrash('ws-keep');
    assert.deepEqual(harnessNodes(), ['n-keep']);
  });

  test('runTombstoneGc removes events of expired tombstones', () => {
    seedNode('ws-keep', 'n-old');
    getDb().prepare('UPDATE nodes SET purged_at = ? WHERE id = ?').run(Date.now() - TOMBSTONE_TTL_MS - 1, 'n-old');
    runTombstoneGc();
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM nodes WHERE id = ?').get('n-old') as { count: number }).count, 0);
    assert.deepEqual(harnessNodes(), ['n-keep']);
  });

  test('deleteTree removes events of the nodes its cascade deletes, scoped to the owner', () => {
    seedNode('ws-keep', 'n-tree', { tree: true });
    process.env.MICHI_CLOUD = '1';
    getDb().prepare('UPDATE workspaces SET owner_user_id = ? WHERE id = ?').run('owner-a', 'ws-keep');
    deleteTree('t-n-tree', 'owner-b');
    assert.deepEqual(harnessNodes(), ['n-keep', 'n-tree']);
    deleteTree('t-n-tree', 'owner-a');
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM nodes WHERE id = ?').get('n-tree') as { count: number }).count, 0);
    assert.deepEqual(harnessNodes(), ['n-keep']);
    delete process.env.MICHI_CLOUD;
    seedNode('ws-keep', 'n-local', { tree: true });
    deleteTree('t-n-local');
    assert.deepEqual(harnessNodes(), ['n-keep']);
  });

  test('backup replace removes events of the replaced workspace', () => {
    seedWorkspace('ws-replaced');
    seedNode('ws-replaced', 'n-replaced', { tree: true });
    runInTransaction(() => replaceWorkspaceInTransaction('ws-replaced'));
    assert.deepEqual(harnessNodes(), ['n-keep']);
  });

  test('admin user deletion removes events of the user\'s nodes', async () => {
    process.env.MICHI_CLOUD = '1';
    process.env.MICHI_REQUIRE_AUTH = 'true';
    process.env.MICHI_ADMIN_EMAILS = 'admin@example.com';
    createAuthUser('owner-a');
    seedWorkspace('ws-owned', 'owner-a');
    seedNode('ws-owned', 'n-owned', { tree: true });
    const app = express();
    app.use((req: any, _res, next) => { req.user = { id: 'admin', email: 'admin@example.com', emailVerified: true }; next(); });
    app.use('/api/admin', setupAdminRoutes());
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/users/owner-a`, { method: 'DELETE' });
      assert.equal(response.status, 200, await response.text());
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    assert.deepEqual(harnessNodes(), ['n-keep']);
  });
});
