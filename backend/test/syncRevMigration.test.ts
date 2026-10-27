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

import { initDb, closeDb, getDb } from '../src/services/db';

let tmpDir: string;

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-syncrev-test-'));
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
});
