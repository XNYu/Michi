/**
 * harness_events was a write-only event journal. Migration 0058 drops it on
 * fresh and existing databases, and every path that deletes or purges a
 * workspace or node must still work once the table is gone.
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

const DROP_MIGRATION = '0058_drop_harness_events';
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
}

function nodeIds(): string[] {
  return (getDb().prepare('SELECT id FROM nodes WHERE purged_at IS NULL ORDER BY id').all() as Array<{ id: string }>)
    .map((row) => row.id);
}

function schemaObjects(db: DatabaseSync): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE '%harness_events%' ORDER BY name`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function ledgerHasDrop(db: DatabaseSync): boolean {
  return Boolean(db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(DROP_MIGRATION));
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

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-harness-drop-'));
  process.env.MICHI_DATA_DIR = dataDir;
  delete process.env.MICHI_CLOUD;
  closeDb(); closeAuditDb(); initDb();
});

afterEach(() => {
  closeDb(); closeAuditDb();
  delete process.env.MICHI_DATA_DIR;
  delete process.env.MICHI_CLOUD;
  delete process.env.MICHI_REQUIRE_AUTH;
  delete process.env.MICHI_ADMIN_EMAILS;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('migration 0058 drops harness_events', () => {
  test('a fresh database has neither the table nor its index', () => {
    assert.deepEqual(schemaObjects(getDb()), []);
    assert.equal(ledgerHasDrop(getDb()), true);
  });

  test('an existing database loses the journal and keeps its other data', () => {
    seedWorkspace('ws-keep');
    seedNode('ws-keep', 'n-keep', { tree: true });
    const db = getDb();
    // The state of an install that last ran before 0058: table, index and rows present.
    db.exec(fs.readFileSync(path.join(__dirname, '../src/db/migrations/0017_harness_events.sql'), 'utf8'));
    db.prepare(`INSERT INTO harness_events (node_id, turn_id, seq, event, payload, created_at)
      VALUES ('n-keep', 'turn-1', 0, 'chunk', '{"text":"secret"}', 1)`).run();
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(DROP_MIGRATION);
    assert.deepEqual(schemaObjects(db), ['harness_events', 'idx_harness_events_node_turn', 'sqlite_autoindex_harness_events_1']);
    closeDb();

    const upgraded = initDb();
    assert.deepEqual(schemaObjects(upgraded), []);
    assert.equal(ledgerHasDrop(upgraded), true);
    assert.deepEqual(nodeIds(), ['n-keep']);
  });

  test('an existing database without the table upgrades cleanly', () => {
    getDb().prepare('DELETE FROM schema_migrations WHERE version = ?').run(DROP_MIGRATION);
    closeDb();
    const upgraded = initDb();
    assert.deepEqual(schemaObjects(upgraded), []);
    assert.equal(ledgerHasDrop(upgraded), true);
  });
});

describe('deletion paths work without harness_events', () => {
  beforeEach(() => {
    seedWorkspace('ws-keep');
    seedNode('ws-keep', 'n-keep', { tree: true });
  });

  test('deleteWorkspace removes every node, in or out of a Tree', () => {
    seedWorkspace('ws-gone');
    seedNode('ws-gone', 'n-tree', { tree: true });
    seedNode('ws-gone', 'n-loose');
    deleteWorkspace('ws-gone');
    assert.deepEqual(nodeIds(), ['n-keep']);
  });

  test('purgeWorkspaceNodes purges only the named nodes', () => {
    seedNode('ws-keep', 'n-purge', { deletedAt: 5 });
    seedNode('ws-keep', 'n-trash', { deletedAt: 5 });
    purgeWorkspaceNodes('ws-keep', ['n-purge']);
    assert.deepEqual(nodeIds(), ['n-keep', 'n-trash']);
  });

  test('emptyWorkspaceTrash purges the trash', () => {
    seedNode('ws-keep', 'n-trash', { tree: true, deletedAt: 5 });
    emptyWorkspaceTrash('ws-keep');
    assert.deepEqual(nodeIds(), ['n-keep']);
  });

  test('runTombstoneGc removes expired tombstones', () => {
    seedNode('ws-keep', 'n-old');
    getDb().prepare('UPDATE nodes SET purged_at = ? WHERE id = ?').run(Date.now() - TOMBSTONE_TTL_MS - 1, 'n-old');
    runTombstoneGc();
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM nodes WHERE id = ?').get('n-old') as { count: number }).count, 0);
  });

  test('deleteTree removes the nodes its cascade deletes, scoped to the owner', () => {
    seedNode('ws-keep', 'n-tree', { tree: true });
    process.env.MICHI_CLOUD = '1';
    getDb().prepare('UPDATE workspaces SET owner_user_id = ? WHERE id = ?').run('owner-a', 'ws-keep');
    deleteTree('t-n-tree', 'owner-b');
    assert.deepEqual(nodeIds(), ['n-keep', 'n-tree']);
    deleteTree('t-n-tree', 'owner-a');
    assert.deepEqual(nodeIds(), ['n-keep']);
    delete process.env.MICHI_CLOUD;
    seedNode('ws-keep', 'n-local', { tree: true });
    deleteTree('t-n-local');
    assert.deepEqual(nodeIds(), ['n-keep']);
  });

  test('backup replace removes the replaced workspace', () => {
    seedWorkspace('ws-replaced');
    seedNode('ws-replaced', 'n-replaced', { tree: true });
    runInTransaction(() => replaceWorkspaceInTransaction('ws-replaced'));
    assert.deepEqual(nodeIds(), ['n-keep']);
  });

  test('admin user deletion removes the user\'s nodes', async () => {
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
    assert.deepEqual(nodeIds(), ['n-keep']);
  });
});
