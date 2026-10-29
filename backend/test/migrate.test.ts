import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../src/services/migrate';
import { initDb, closeDb } from '../src/services/db';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-migrate-test-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  cleanups.push(() => db.close());
  return db;
}

function objectExists(db: DatabaseSync, type: string, name: string): boolean {
  return !!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name);
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function versions(db: DatabaseSync): string[] {
  return (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: string }>)
    .map((r) => r.version);
}

test('a duplicate ADD COLUMN skips only that statement, not the rest of the file', () => {
  const dir = fixture({
    '0001_base.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT);',
    '0002_ensure.sql': `
-- The column may already exist; a comment with a ; must not split anything.
ALTER TABLE t ADD COLUMN a TEXT;
CREATE TABLE after_dup (id INTEGER PRIMARY KEY, note TEXT DEFAULT 'x;y');
/* block comment ; */
CREATE TRIGGER after_dup_ai AFTER INSERT ON after_dup BEGIN
  UPDATE after_dup SET note = note || ';' WHERE id = new.id;
  UPDATE after_dup SET note = CASE WHEN note IS NULL THEN 'none' ELSE note END WHERE id = new.id;
END;
ALTER TABLE t ADD COLUMN b INTEGER;
`,
  });
  const db = memoryDb();

  runMigrations(db, dir);

  assert.ok(objectExists(db, 'table', 'after_dup'), 'statements after the duplicate column must run');
  assert.ok(objectExists(db, 'trigger', 'after_dup_ai'));
  assert.deepEqual(columns(db, 't'), ['id', 'a', 'b']);
  db.exec('INSERT INTO after_dup (id) VALUES (1)');
  assert.equal((db.prepare('SELECT note FROM after_dup').get() as { note: string }).note, 'x;y;');
  assert.deepEqual(versions(db), ['0001_base', '0002_ensure']);
});

test('an existing CREATE target skips only that statement', () => {
  const dir = fixture({
    '0001_base.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);',
    '0002_again.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);\nCREATE TABLE after_exists (id INTEGER PRIMARY KEY);\n',
  });
  const db = memoryDb();

  runMigrations(db, dir);

  assert.ok(objectExists(db, 'table', 'after_exists'));
  assert.deepEqual(versions(db), ['0001_base', '0002_again']);
});

test('non-benign errors fail the migration and leave nothing applied', () => {
  const cases: Record<string, string> = {
    syntax: 'CREATE TABLE partial (id INTEGER);\nTHIS IS NOT SQL;\n',
    'duplicate column outside ADD COLUMN': 'CREATE TABLE partial (id INTEGER);\nCREATE TABLE twice (a TEXT, a TEXT);\n',
    'error after a skipped duplicate': 'CREATE TABLE partial (id INTEGER);\nALTER TABLE t ADD COLUMN a TEXT;\nTHIS IS NOT SQL;\n',
  };
  for (const [name, sql] of Object.entries(cases)) {
    const dir = fixture({ '0001_base.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT);', '0002_bad.sql': sql });
    const db = memoryDb();

    assert.throws(() => runMigrations(db, dir), /Migration "0002_bad" failed/, name);
    assert.equal(objectExists(db, 'table', 'partial'), false, `${name}: the failed file must roll back`);
    assert.deepEqual(versions(db), ['0001_base'], name);
  }
});

test('a version already in the ledger is never rerun', () => {
  const dir = fixture({ '0001_once.sql': 'CREATE TABLE should_not_exist (id INTEGER);\nTHIS IS NOT SQL;\n' });
  const db = memoryDb();
  db.exec(`
    CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations VALUES ('0001_once', 42);
  `);

  runMigrations(db, dir);

  assert.equal(objectExists(db, 'table', 'should_not_exist'), false);
  assert.deepEqual(
    db.prepare('SELECT version, applied_at FROM schema_migrations').all().map((r) => ({ ...r })),
    [{ version: '0001_once', applied_at: 42 }]
  );
});

test('all real migrations apply on a fresh database and a second pass is a no-op', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-migrate-real-'));
  const previous = process.env.MICHI_DATA_DIR;
  process.env.MICHI_DATA_DIR = dataDir;
  closeDb();
  cleanups.push(() => {
    closeDb();
    if (previous === undefined) delete process.env.MICHI_DATA_DIR;
    else process.env.MICHI_DATA_DIR = previous;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const migrationsDir = path.join(__dirname, '../src/db/migrations');
  const expected = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, '')).sort();

  const db = initDb();

  assert.deepEqual(versions(db), expected);
  assert.ok(objectExists(db, 'index', 'idx_turns_node_completion'));
  assert.ok(columns(db, 'scheduled_jobs').includes('conversation_cursor'));
  const ledger = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  runMigrations(db, migrationsDir);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), ledger);

  // The same files also apply on a database the in-process V1..V14 code never touched.
  const bare = memoryDb();
  runMigrations(bare, migrationsDir);
  assert.deepEqual(versions(bare), expected);
});
