/**
 * Integration tests for migration 0006_sync_rev (sync L2.1):
 *   workspaces.sync_rev INTEGER NOT NULL DEFAULT 0
 *   nodes.rev / edges.rev / messages.rev / trees.rev / contexts.rev  INTEGER (nullable)
 *
 * L2.1 is purely additive: the columns are created (and leaf save* learns to
 * stamp them) but nothing reads or guards on them yet. These tests assert the
 * column shape (notnull / default), that existing workspace rows read
 * sync_rev = 0, that a pre-existing node row reads rev = NULL, and that the
 * migration is idempotent on a second runMigrations pass.
 *
 * Mirrors migrationV9.test.ts: a unique tmp MICHI_DATA_DIR per test so the
 * db.ts singleton re-creates against a fresh file each time.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { initDb, closeDb, getDb } from '../src/services/db';
import { runMigrations } from '../src/services/migrate';

let tmpDir: string;

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-syncrev-test-'));
}

/** Resolve the on-disk migrations dir the same way db.ts does in ts-node mode. */
function migrationsDir(): string {
  return path.join(__dirname, '../src/db/migrations');
}

beforeEach(() => {
  tmpDir = freshTmpDir();
  process.env.MICHI_DATA_DIR = tmpDir;
  closeDb(); // clear singleton so next initDb() opens tmpDir/data.db
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('migration 0006_sync_rev', () => {
  // 1. Column shape on workspaces
  test('fresh DB has sync_rev column on workspaces (NOT NULL, default 0)', () => {
    initDb();
    const db = getDb();

    const cols = db.prepare('PRAGMA table_info(workspaces)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;

    const syncRev = cols.find((c) => c.name === 'sync_rev');
    assert.ok(syncRev, 'sync_rev column must exist on workspaces');
    assert.equal(syncRev.type.toUpperCase(), 'INTEGER');
    assert.equal(syncRev.notnull, 1, 'sync_rev must be NOT NULL');
    assert.equal(syncRev.dflt_value, '0', 'sync_rev default must be 0');
  });

  // 2. Column shape on the five per-row tables (nullable rev)
  test('fresh DB has nullable rev column on nodes/edges/messages/trees/contexts', () => {
    initDb();
    const db = getDb();

    for (const table of ['nodes', 'edges', 'messages', 'trees', 'contexts']) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const rev = cols.find((c) => c.name === 'rev');
      assert.ok(rev, `rev column must exist on ${table}`);
      assert.equal(rev.type.toUpperCase(), 'INTEGER', `${table}.rev must be INTEGER`);
      assert.equal(rev.notnull, 0, `${table}.rev must be nullable`);
      assert.equal(rev.dflt_value, null, `${table}.rev must have no default`);
    }
  });

  // 3. Existing workspace row reads sync_rev = 0
  test('existing workspace row reads sync_rev = 0 after migration', () => {
    initDb();
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('ws-sr', 'SyncRevTest', now, now);

    const row = db
      .prepare('SELECT sync_rev FROM workspaces WHERE id = ?')
      .get('ws-sr') as { sync_rev: number };
    assert.equal(row.sync_rev, 0, 'existing workspace must default to sync_rev = 0');
  });

  // 4. Pre-existing node row reads rev = NULL
  test('pre-existing node row reads rev = NULL after migration', () => {
    initDb();
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('ws-rn', 'RevNullWs', now, now);
    db.prepare(
      `INSERT INTO nodes (id, workspace_id, kind, status, minimized, spawned_by_agent, created_at)
       VALUES (?, ?, 'chat', 'idle', 0, 0, ?)`,
    ).run('nd-rn', 'ws-rn', now);

    const row = db
      .prepare('SELECT rev FROM nodes WHERE id = ?')
      .get('nd-rn') as { rev: number | null };
    assert.equal(row.rev, null, 'node predating versioning must read rev = NULL');
  });

  // 5. Migrating from a pre-0006 DB adds the columns and preserves rows.
  test('migrating from a pre-0006 DB adds columns; existing rows survive with sync_rev=0 / rev=NULL', () => {
    // Build a DB at the 0005 schema (no rev columns), insert a workspace + node.
    const dbPath = path.join(tmpDir, 'data.db');
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA foreign_keys = ON');
    // Build the full set of tables the inline runMigrations (db.ts) touches so
    // the V1..V14 idempotent re-checks (e.g. migrateV2's ALTER TABLE contexts)
    // don't trip on a missing table. schema_version=14 means the file
    // migrations (0004+) supply purged_at / anchor / rev.
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT, model TEXT,
        active_tree_id TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        settings TEXT, deleted_at INTEGER, archived_at INTEGER,
        backend TEXT NOT NULL DEFAULT 'kiro', owner_user_id TEXT, purged_at INTEGER
      );
      CREATE TABLE trees (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, root_node_id TEXT NOT NULL,
        name TEXT, archived_at INTEGER, pinned_at INTEGER,
        last_active_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, tree_id TEXT,
        parent_node_id TEXT, kind TEXT NOT NULL DEFAULT 'chat', title TEXT,
        status TEXT NOT NULL DEFAULT 'idle', position_x REAL, position_y REAL,
        minimized INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER,
        deletion_group_id TEXT, spawned_by_agent INTEGER NOT NULL DEFAULT 0,
        current_mode_id TEXT, pane_width REAL, digest TEXT, follow_ups TEXT,
        acp_session_id TEXT, composer_draft TEXT, purged_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );
      CREATE TABLE edges (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        source_node_id TEXT NOT NULL, target_node_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'branch'
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, node_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '', tool_calls TEXT,
        seq INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );
      CREATE TABLE contexts (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
        file_path TEXT NOT NULL, size INTEGER, auto_inject INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, UNIQUE(workspace_id, name)
      );
      CREATE TABLE workspace_permission_grants (
        workspace_id TEXT NOT NULL, tool_name TEXT NOT NULL,
        granted_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, tool_name)
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '14');
    `);
    const now = Date.now();
    raw.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('ws-old', 'Legacy', now, now);
    raw.prepare(
      `INSERT INTO nodes (id, workspace_id, kind, status, minimized, spawned_by_agent, created_at)
       VALUES (?, ?, 'chat', 'idle', 0, 0, ?)`,
    ).run('nd-old', 'ws-old', now);
    raw.close();

    // Let initDb() run the file migrations (0006 included).
    initDb();
    const db = getDb();

    const wsCols = db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>;
    assert.ok(wsCols.some((c) => c.name === 'sync_rev'), 'sync_rev column must be added');
    const nodeCols = db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
    assert.ok(nodeCols.some((c) => c.name === 'rev'), 'nodes.rev column must be added');

    const ws = db
      .prepare('SELECT name, sync_rev FROM workspaces WHERE id = ?')
      .get('ws-old') as { name: string; sync_rev: number };
    assert.equal(ws.name, 'Legacy', 'legacy workspace row must survive migration');
    assert.equal(ws.sync_rev, 0, 'legacy workspace must read sync_rev = 0');

    const nd = db
      .prepare('SELECT rev FROM nodes WHERE id = ?')
      .get('nd-old') as { rev: number | null };
    assert.equal(nd.rev, null, 'legacy node must read rev = NULL');
  });

  // 6. Idempotent — a second runMigrations pass is a no-op (benign duplicate-column swallow).
  test('re-running runMigrations after initDb is a no-op', () => {
    initDb();
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('ws-idem', 'Idem', now, now);

    // Second pass over the same on-disk migrations dir against the same db.
    assert.doesNotThrow(() => runMigrations(db, migrationsDir()));

    // Row survives, columns still present, no duplication.
    const cnt = (db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n;
    assert.equal(cnt, 1, 'no rows duplicated on a second migration pass');
    const cols = db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>;
    assert.equal(
      cols.filter((c) => c.name === 'sync_rev').length,
      1,
      'sync_rev must appear exactly once after a second migration pass',
    );
  });
});
