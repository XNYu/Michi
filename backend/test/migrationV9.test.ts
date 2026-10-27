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
import { setWorkspaceBackend, getWorkspaceBackend } from '../src/services/dbRepository';

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

// ─── test suite ─────────────────────────────────────────────────────────────

describe('agent runtime schema migrations', () => {

  test('getWorkspaceBackend returns null for non-existent workspace', () => {
    initDb();
    assert.equal(getWorkspaceBackend('does-not-exist'), null);
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
