import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../src/services/migrate';

for (const existing of ['legacy', 'partial', 'current'] as const) {
  test(`scheduler claim upgrade preserves ${existing} reservations and is idempotent`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'michi-claims-migration-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = join(__dirname, '../src/db/migrations');
    const migrations = readdirSync(source).filter((name) => /^004[34]_scheduler_claims.*\.sql$/.test(name));
    assert.equal(migrations.length, 5);
    for (const file of migrations) copyFileSync(join(source, file), join(dir, file));
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec(`
      CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES ('0034_scheduler_execution_claims', 1);
      CREATE TABLE scheduled_jobs (id TEXT PRIMARY KEY, workspace_id TEXT);
      CREATE TABLE scheduled_job_runs (id TEXT PRIMARY KEY, job_id TEXT, workspace_id TEXT);
      INSERT INTO scheduled_jobs VALUES ('job', 'workspace'), ('job-only', 'job-workspace');
      INSERT INTO scheduled_job_runs VALUES ('run', 'job', 'run-workspace');
      CREATE TABLE scheduler_execution_claims (
        run_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, holder TEXT NOT NULL,
        generation INTEGER NOT NULL, process_id INTEGER, acquired_at INTEGER NOT NULL
      );
      INSERT INTO scheduler_execution_claims VALUES
        ('run', 'job', 'holder', 7, 123, 100),
        ('job-fallback', 'job-only', 'holder', 7, 124, 102),
        ('orphan', 'deleted', 'holder', 8, NULL, 101);
    `);
    if (existing !== 'legacy') {
      db.exec(`
        ALTER TABLE scheduler_execution_claims ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
        UPDATE scheduler_execution_claims SET workspace_id = 'run-workspace' WHERE run_id = 'run';
      `);
    }
    if (existing === 'current') {
      db.exec(`
        ALTER TABLE scheduler_execution_claims ADD COLUMN process_exit_safe INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE scheduler_execution_claims ADD COLUMN quarantined_at INTEGER;
        ALTER TABLE scheduler_execution_claims ADD COLUMN reason TEXT;
        UPDATE scheduler_execution_claims
        SET process_exit_safe = 1, quarantined_at = 88, reason = 'Keep existing evidence'
        WHERE run_id = 'run';
      `);
    }

    runMigrations(db, dir);
    const rows = db.prepare('SELECT * FROM scheduler_execution_claims ORDER BY run_id').all();
    assert.equal(rows.length, 3, 'upgrade must retain all admission reservations');
    const run = rows.find((row) => row.run_id === 'run')!;
    assert.equal(run.workspace_id, 'run-workspace');
    assert.equal(run.process_id, 123);
    assert.equal(run.generation, 7);
    assert.equal(run.process_exit_safe, existing === 'current' ? 1 : 0);
    if (existing === 'current') {
      assert.equal(run.reason, 'Keep existing evidence');
      assert.equal(run.quarantined_at, 88);
    }
    const fallback = rows.find((row) => row.run_id === 'job-fallback')!;
    assert.equal(fallback.workspace_id, 'job-workspace');
    assert.equal(fallback.quarantined_at, 102);
    const orphan = rows.find((row) => row.run_id === 'orphan')!;
    assert.equal(orphan.workspace_id, '');
    assert.equal(orphan.quarantined_at, 101);
    assert.match(String(orphan.reason), /did not confirm/);
    const ledger = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    assert.equal(ledger.length, 6);
    runMigrations(db, dir);
    assert.deepEqual(db.prepare('SELECT * FROM scheduler_execution_claims ORDER BY run_id').all(), rows);
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), ledger);
  });
}
