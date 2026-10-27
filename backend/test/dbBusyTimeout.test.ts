/**
 * busy_timeout regression test (multi-window concurrency prereq, spec §18/D12).
 *
 * Without PRAGMA busy_timeout, a writer that loses the WAL write-lock race
 * gets SQLITE_BUSY immediately (busy_timeout defaults to 0). We set it to
 * 15000ms on both the main data.db and the audit.db so a contended writer
 * waits-and-retries instead of throwing.
 *
 * Mirrors migrationV9.test.ts: a fresh tmp-dir DB per test, singleton reset
 * via closeDb() + a new MICHI_DATA_DIR.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb, getDb, closeAuditDb } from '../src/services/db';

let tmpDir: string;

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-busytimeout-test-'));
}

beforeEach(() => {
  tmpDir = freshTmpDir();
  process.env.MICHI_DATA_DIR = tmpDir;
  closeDb();
  closeAuditDb();
});

afterEach(() => {
  closeDb();
  closeAuditDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('PRAGMA busy_timeout', () => {
  test('WAL and foreign_keys remain set alongside busy_timeout (no regression)', () => {
    initDb();
    const db = getDb();
    const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    assert.equal(journal.journal_mode.toLowerCase(), 'wal', 'journal_mode must stay WAL');
    assert.equal(fk.foreign_keys, 1, 'foreign_keys must stay ON');
  });
});
