/**
 * Integration tests for schema migrations around AgentRuntime persistence:
 *   workspaces.backend TEXT NOT NULL DEFAULT 'kiro'
 *   nodes.external_session_id TEXT
 *   nodes.runtime_id TEXT
 *   nodes.provider_id/model_id/reasoning/resume_fingerprint TEXT
 *
 * Uses node:test (built-in, Node 22+) + node:sqlite (built-in).
 * MICHI_DATA_DIR is set to a unique tmp path per test so the singleton
 * is re-created against a fresh file each time.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// --- helpers to reset the db.ts singleton between tests ---
// We import via require so we can reload the module cleanly by manipulating
// the module cache, but it's simpler to just call closeDb() and rely on
// MICHI_DATA_DIR pointing to a different file each test.

let tmpDir: string;

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-test-'));
}

// We must import the module AFTER setting MICHI_DATA_DIR so getDbPath() picks
// up the right directory.  Because Node caches modules we use a workaround:
// call closeDb() before each test so the singleton is cleared, then change
// MICHI_DATA_DIR so the next initDb() opens a new file.

import { initDb, closeDb, getDb } from '../src/services/db';
import {
  setWorkspaceBackend,
  getWorkspaceBackend,
  setNodeExternalSessionId,
  getNodeExternalSessionId,
} from '../src/services/dbRepository';

const CURRENT_INLINE_SCHEMA_VERSION = '14';

// ─── shared setup / teardown ────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = freshTmpDir();
  process.env.MICHI_DATA_DIR = tmpDir;
  closeDb(); // clear singleton so next initDb() opens tmpDir/data.db
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── helpers ────────────────────────────────────────────────────────────────

/** Insert a workspace row using raw SQL (bypasses saveWorkspace column list). */
function insertWorkspace(db: DatabaseSync, id: string, name = 'ws'): void {
  const now = Date.now();
  db.prepare(
    'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run(id, name, now, now);
}

/** Insert a node row using raw SQL. */
function insertNode(
  db: DatabaseSync,
  id: string,
  workspaceId: string,
  acpSessionId: string | null = null,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO nodes
       (id, workspace_id, kind, status, minimized, spawned_by_agent, created_at, acp_session_id)
     VALUES (?, ?, 'chat', 'idle', 0, 0, ?, ?)`,
  ).run(id, workspaceId, now, acpSessionId);
}

// ─── test suite ─────────────────────────────────────────────────────────────

describe('agent runtime schema migrations', () => {
  // 1. Fresh DB -> current columns present
  test('fresh DB has backend column on workspaces with correct constraints', () => {
    initDb();
    const db = getDb();

    const cols = db.prepare('PRAGMA table_info(workspaces)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;

    const backend = cols.find((c) => c.name === 'backend');
    assert.ok(backend, 'backend column must exist on workspaces');
    assert.equal(backend.type.toUpperCase(), 'TEXT');
    assert.equal(backend.notnull, 1, 'backend must be NOT NULL');
    assert.equal(backend.dflt_value, "'kiro'", "backend default must be 'kiro'");
  });

  test('fresh DB has external_session_id column on nodes with correct constraints', () => {
    initDb();
    const db = getDb();

    const cols = db.prepare('PRAGMA table_info(nodes)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;

    const extSid = cols.find((c) => c.name === 'external_session_id');
    assert.ok(extSid, 'external_session_id column must exist on nodes');
    assert.equal(extSid.type.toUpperCase(), 'TEXT');
    assert.equal(extSid.notnull, 0, 'external_session_id must be nullable');
  });

  test('fresh DB has runtime_id column on nodes with correct constraints', () => {
    initDb();
    const db = getDb();

    const cols = db.prepare('PRAGMA table_info(nodes)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;

    const runtimeId = cols.find((c) => c.name === 'runtime_id');
    assert.ok(runtimeId, 'runtime_id column must exist on nodes');
    assert.equal(runtimeId.type.toUpperCase(), 'TEXT');
    assert.equal(runtimeId.notnull, 0, 'runtime_id must be nullable for unbound nodes');
  });

  test('fresh DB has resume signature columns on nodes with correct constraints', () => {
    initDb();
    const db = getDb();

    const cols = db.prepare('PRAGMA table_info(nodes)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;

    for (const name of ['provider_id', 'model_id', 'reasoning', 'resume_fingerprint']) {
      const col = cols.find((c) => c.name === name);
      assert.ok(col, `${name} column must exist on nodes`);
      assert.equal(col.type.toUpperCase(), 'TEXT');
      assert.equal(col.notnull, 0, `${name} must be nullable`);
    }
  });

  test('fresh DB schema_version is current', () => {
    initDb();
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    assert.equal(row?.value, CURRENT_INLINE_SCHEMA_VERSION);

    const msgCols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string; type: string; notnull: number }>;
    const blocks = msgCols.find((c) => c.name === 'blocks');
    assert.ok(blocks, 'blocks column must exist on messages');
    assert.equal(blocks.type.toUpperCase(), 'TEXT');
    assert.equal(blocks.notnull, 0, 'blocks must be nullable');

    const userProviderKeys = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_provider_keys'")
      .get() as { name: string } | undefined;
    assert.equal(userProviderKeys?.name, 'user_provider_keys');

    const treeCols = db.prepare('PRAGMA table_info(trees)').all() as Array<{ name: string; type: string; notnull: number }>;
    const pinnedAt = treeCols.find((c) => c.name === 'pinned_at');
    assert.ok(pinnedAt, 'pinned_at column must exist on trees');
    assert.equal(pinnedAt.type.toUpperCase(), 'INTEGER');
    assert.equal(pinnedAt.notnull, 0, 'pinned_at must be nullable');
  });

  // 2. v8-state DB -> v9/v10 columns added, no data loss
  test('migrating from v8-state DB preserves existing rows and adds runtime columns', () => {
    // Build a v8-state DB manually before initDb() runs migrations
    const dbPath = path.join(tmpDir, 'data.db');
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA foreign_keys = ON');

    // Create the v1 schema (minimal tables needed)
    raw.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT, model TEXT,
        active_tree_id TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        settings TEXT, deleted_at INTEGER, archived_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS trees (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, root_node_id TEXT NOT NULL,
        name TEXT, archived_at INTEGER, last_active_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, tree_id TEXT,
        parent_node_id TEXT, kind TEXT NOT NULL DEFAULT 'chat', title TEXT,
        status TEXT NOT NULL DEFAULT 'idle', position_x REAL, position_y REAL,
        minimized INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER,
        deletion_group_id TEXT, spawned_by_agent INTEGER NOT NULL DEFAULT 0,
        current_mode_id TEXT, pane_width REAL, digest TEXT, follow_ups TEXT,
        acp_session_id TEXT, composer_draft TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );
      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        source_node_id TEXT NOT NULL, target_node_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'branch'
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, node_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '', tool_calls TEXT,
        seq INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );
      CREATE TABLE IF NOT EXISTS contexts (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
        file_path TEXT NOT NULL, size INTEGER, auto_inject INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, UNIQUE(workspace_id, name)
      );
      CREATE TABLE IF NOT EXISTS workspace_permission_grants (
        workspace_id TEXT NOT NULL, tool_name TEXT NOT NULL,
        granted_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, tool_name)
      );
      INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '8');
    `);

    const now = Date.now();
    raw.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('ws-1', 'Alpha', now, now);
    raw.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('ws-2', 'Beta', now, now);
    raw.prepare(
      `INSERT INTO nodes (id, workspace_id, kind, status, minimized, spawned_by_agent, created_at)
       VALUES (?, ?, 'chat', 'idle', 0, 0, ?)`,
    ).run('node-1', 'ws-1', now);
    raw.close();

    // Now let initDb() run migrations
    initDb();
    const db = getDb();

    // Existing rows survived
    const wsCnt = (db.prepare('SELECT COUNT(*) as n FROM workspaces').get() as { n: number }).n;
    assert.equal(wsCnt, 2, 'both workspaces must survive migration');

    const nodeCnt = (db.prepare('SELECT COUNT(*) as n FROM nodes').get() as { n: number }).n;
    assert.equal(nodeCnt, 1, 'existing node must survive migration');

    const ws1 = db.prepare('SELECT name FROM workspaces WHERE id = ?').get('ws-1') as { name: string } | undefined;
    assert.equal(ws1?.name, 'Alpha');

    // New columns exist
    const wsCols = db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>;
    assert.ok(wsCols.some((c) => c.name === 'backend'), 'backend column must be added');

    const nodeCols = db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
    assert.ok(nodeCols.some((c) => c.name === 'external_session_id'), 'external_session_id column must be added');
    assert.ok(nodeCols.some((c) => c.name === 'runtime_id'), 'runtime_id column must be added');
    for (const name of ['provider_id', 'model_id', 'reasoning', 'resume_fingerprint']) {
      assert.ok(nodeCols.some((c) => c.name === name), `${name} column must be added`);
    }

    // Existing workspaces get the DEFAULT value for backend
    const ws1Backend = db
      .prepare('SELECT backend FROM workspaces WHERE id = ?')
      .get('ws-1') as { backend: string } | undefined;
    assert.equal(ws1Backend?.backend, 'kiro', 'existing workspace must have backend=kiro after migration');

    const msgCols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    assert.ok(msgCols.some((c) => c.name === 'blocks'), 'blocks column must be added');

    const userProviderKeys = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_provider_keys'")
      .get() as { name: string } | undefined;
    assert.equal(userProviderKeys?.name, 'user_provider_keys');

    const treeCols = db.prepare('PRAGMA table_info(trees)').all() as Array<{ name: string }>;
    assert.ok(treeCols.some((c) => c.name === 'pinned_at'), 'pinned_at column must be added');

    // schema_version bumped to the latest inline migration
    const ver = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    assert.equal(ver.value, CURRENT_INLINE_SCHEMA_VERSION);
  });

  // 3. Current-state DB -> idempotent
  test('running initDb on an already-current DB is idempotent', () => {
    // First init
    initDb();
    const db = getDb();
    insertWorkspace(db, 'ws-a');
    insertNode(db, 'nd-a', 'ws-a');
    closeDb();

    // Second init (same file)
    process.env.MICHI_DATA_DIR = tmpDir; // same dir
    assert.doesNotThrow(() => initDb());

    const db2 = getDb();
    const wsCnt = (db2.prepare('SELECT COUNT(*) as n FROM workspaces').get() as { n: number }).n;
    assert.equal(wsCnt, 1, 'no rows should be duplicated on re-init');
  });

  // 4. Helper round-trips
  test('setWorkspaceBackend / getWorkspaceBackend round-trip', () => {
    initDb();
    const db = getDb();
    insertWorkspace(db, 'ws-rt');

    setWorkspaceBackend('ws-rt', 'claude');
    assert.equal(getWorkspaceBackend('ws-rt'), 'claude');
  });

  test('setNodeExternalSessionId / getNodeExternalSessionId round-trip', () => {
    initDb();
    const db = getDb();
    insertWorkspace(db, 'ws-rt2');
    insertNode(db, 'nd-rt2', 'ws-rt2');

    setNodeExternalSessionId('nd-rt2', 'some-uuid-123');
    assert.equal(getNodeExternalSessionId('nd-rt2'), 'some-uuid-123');
  });

  test('getWorkspaceBackend returns null for non-existent workspace', () => {
    initDb();
    assert.equal(getWorkspaceBackend('does-not-exist'), null);
  });

  test('getNodeExternalSessionId returns null for non-existent node', () => {
    initDb();
    assert.equal(getNodeExternalSessionId('does-not-exist'), null);
  });

  // 5. setWorkspaceBackend bumps updated_at
  test('setWorkspaceBackend bumps updated_at to a value greater than before', () => {
    initDb();
    const db = getDb();
    const pastTs = Date.now() - 10_000;
    const now = Date.now();
    db.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('ws-bump', 'BumpTest', now, pastTs);

    setWorkspaceBackend('ws-bump', 'claude');

    const row = db
      .prepare('SELECT updated_at FROM workspaces WHERE id = ?')
      .get('ws-bump') as { updated_at: number };
    assert.ok(
      row.updated_at > pastTs,
      `updated_at (${row.updated_at}) should be greater than pastTs (${pastTs})`,
    );
  });

  // 6. No acp_session_id → external_session_id data copy on migration
  test('migration does NOT copy acp_session_id into external_session_id', () => {
    // Build a v8-state DB with a node that has acp_session_id set
    const dbPath = path.join(tmpDir, 'data.db');
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT, model TEXT,
        active_tree_id TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        settings TEXT, deleted_at INTEGER, archived_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS trees (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, root_node_id TEXT NOT NULL,
        name TEXT, archived_at INTEGER, last_active_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, tree_id TEXT,
        parent_node_id TEXT, kind TEXT NOT NULL DEFAULT 'chat', title TEXT,
        status TEXT NOT NULL DEFAULT 'idle', position_x REAL, position_y REAL,
        minimized INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER,
        deletion_group_id TEXT, spawned_by_agent INTEGER NOT NULL DEFAULT 0,
        current_mode_id TEXT, pane_width REAL, digest TEXT, follow_ups TEXT,
        acp_session_id TEXT, composer_draft TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );
      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        source_node_id TEXT NOT NULL, target_node_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'branch'
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, node_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '', tool_calls TEXT,
        seq INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );
      CREATE TABLE IF NOT EXISTS contexts (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
        file_path TEXT NOT NULL, size INTEGER, auto_inject INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, UNIQUE(workspace_id, name)
      );
      CREATE TABLE IF NOT EXISTS workspace_permission_grants (
        workspace_id TEXT NOT NULL, tool_name TEXT NOT NULL,
        granted_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, tool_name)
      );
      INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '8');
    `);

    const now2 = Date.now();
    raw.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('ws-acp', 'AcpTest', now2, now2);
    raw.prepare(
      `INSERT INTO nodes (id, workspace_id, kind, status, minimized, spawned_by_agent, acp_session_id, created_at)
       VALUES (?, ?, 'chat', 'idle', 0, 0, ?, ?)`,
    ).run('nd-acp', 'ws-acp', 'kiro-sid-123', now2);
    raw.close();

    initDb();
    const db = getDb();

    const row = db
      .prepare('SELECT acp_session_id, external_session_id FROM nodes WHERE id = ?')
      .get('nd-acp') as { acp_session_id: string | null; external_session_id: string | null };

    assert.equal(row.acp_session_id, 'kiro-sid-123', 'acp_session_id must be preserved');
    assert.equal(row.external_session_id, null, 'external_session_id must remain NULL — not copied from acp_session_id');
  });
});
