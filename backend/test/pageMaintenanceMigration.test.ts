import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../src/services/migrate';

for (const existing of ['legacy', 'catchup-only', 'scope-only', 'current'] as const) {
  test(`page maintenance upgrades ${existing} databases without losing history or widening catch-up`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'michi-maintenance-migration-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = join(__dirname, '../src/db/migrations');
    const files = readdirSync(source).filter((name) => /^005[123]_page_maintenance_.*\.sql$/.test(name));
    assert.equal(files.length, 3);
    for (const file of files) copyFileSync(join(source, file), join(dir, file));
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES ('0035_page_maintenance', 1);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY);
      CREATE TABLE pages (id TEXT PRIMARY KEY);
      CREATE TABLE scheduled_jobs (id TEXT PRIMARY KEY);
      CREATE TABLE scheduled_job_runs (id TEXT PRIMARY KEY);
      INSERT INTO workspaces VALUES ('ws');
      INSERT INTO pages VALUES ('space');
      INSERT INTO scheduled_jobs VALUES ('job');
    `);
    db.exec(readFileSync(join(source, '0035_page_maintenance.sql'), 'utf8'));
    const hasCatchupSpace = existing === 'catchup-only' || existing === 'current';
    const hasPlanScope = existing === 'scope-only' || existing === 'current';
    if (!hasCatchupSpace) db.exec('ALTER TABLE page_maintenance_catchup_requests DROP COLUMN space_id');
    if (!hasPlanScope) db.exec('ALTER TABLE page_maintenance_plans DROP COLUMN scope_space_id');
    if (existing !== 'current') db.exec('DROP TABLE page_maintenance_exclusion_periods');
    db.exec(`
      INSERT INTO page_maintenance_configs
        (workspace_id,owner_user_id,job_id,enabled,paused,completion_cursor,updated_at)
        VALUES ('ws','alice','job',1,0,42,100);
      INSERT INTO page_maintenance_plans
        (id,workspace_id,owner_user_id,job_id,config_revision,generation,after_seq,through_seq,state,created_at,updated_at)
        VALUES ('plan','ws','alice','job',1,1,40,42,'terminal',100,101);
      INSERT INTO page_maintenance_exclusions VALUES ('ws','alice','space',99);
    `);
    for (const state of ['queued', 'completed', 'cancelled']) {
      db.exec(`INSERT INTO page_maintenance_catchup_requests
        (id,workspace_id,owner_user_id,after_seq,through_seq,config_revision,state,created_at,updated_at${hasCatchupSpace ? ',space_id' : ''})
        VALUES ('${state}','ws','alice',1,2,1,'${state}',50,51${hasCatchupSpace ? ",'space'" : ''})`);
    }
    if (existing === 'current') {
      db.exec(`INSERT INTO page_maintenance_exclusion_periods VALUES ('period','ws','alice','space',40,NULL,99,NULL)`);
      db.exec("UPDATE page_maintenance_plans SET scope_space_id='space'");
    }
    const configs = db.prepare('SELECT * FROM page_maintenance_configs').all();
    const exclusions = db.prepare('SELECT * FROM page_maintenance_exclusions').all();
    if (!hasCatchupSpace) {
      assert.throws(() => db.prepare('SELECT space_id FROM page_maintenance_catchup_requests'), /no such column: space_id/);
    }

    runMigrations(db, dir);
    const requests = db.prepare('SELECT id,space_id,state,after_seq,through_seq,created_at,updated_at FROM page_maintenance_catchup_requests ORDER BY id').all();
    assert.equal(requests.length, 3);
    for (const row of requests) {
      assert.equal(row.space_id, hasCatchupSpace ? 'space' : null);
      assert.equal(row.state, row.id === 'queued' && !hasCatchupSpace ? 'cancelled' : row.id);
      assert.deepEqual([row.after_seq, row.through_seq, row.created_at, row.updated_at], [1, 2, 50, 51]);
    }
    assert.deepEqual(db.prepare('SELECT * FROM page_maintenance_configs').all(), configs);
    assert.deepEqual(db.prepare('SELECT * FROM page_maintenance_exclusions').all(), exclusions);
    const plan = db.prepare('SELECT scope_space_id,after_seq,through_seq,state FROM page_maintenance_plans').get()!;
    assert.deepEqual({ ...plan }, { scope_space_id: existing === 'current' ? 'space' : null, after_seq: 40, through_seq: 42, state: 'terminal' });
    const periods = db.prepare('SELECT * FROM page_maintenance_exclusion_periods').all();
    assert.equal(periods.length, existing === 'current' ? 1 : 0);
    db.exec("INSERT INTO page_maintenance_exclusion_periods VALUES ('new','ws','alice','space',43,44,102,103)");
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const ledger = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    assert.equal(ledger.length, 4);
    runMigrations(db, dir);
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), ledger);
    assert.deepEqual(db.prepare('SELECT id,space_id,state,after_seq,through_seq,created_at,updated_at FROM page_maintenance_catchup_requests ORDER BY id').all(), requests);
  });
}
