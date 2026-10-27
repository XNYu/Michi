import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { closeDb, getDb, initDb } from '../src/services/db';

let tmpDir: string;

function migrationsDir(): string {
  return path.join(__dirname, '../src/db/migrations');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-custom-agents-migration-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  closeDb();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Custom Agent migrations', () => {
  test('pre-0018 rows survive unchanged and no Branch is backfilled into a Run', () => {
    const dbPath = path.join(tmpDir, 'data.db');
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec(fs.readFileSync(path.join(migrationsDir(), '0000_baseline.sql'), 'utf8'));
    raw.exec(`
      CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations (version, applied_at)
      SELECT replace(name, '.sql', ''), 1
      FROM pragma_table_info('schema_migrations')
      WHERE 0;
    `);
    const migrationFiles = fs.readdirSync(migrationsDir()).filter((name) => name.endsWith('.sql')).sort();
    for (const file of migrationFiles.slice(1, migrationFiles.indexOf('0018_custom_agents.sql'))) {
      raw.exec(fs.readFileSync(path.join(migrationsDir(), file), 'utf8'));
      raw.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, 1)').run(file.replace(/\.sql$/, ''));
    }
    const now = Date.now();
    raw.prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('legacy-ws', 'Legacy', now, now);
    raw.prepare(
      `INSERT INTO nodes (id, workspace_id, kind, status, minimized, spawned_by_agent, created_at)
       VALUES ('legacy-node', 'legacy-ws', 'chat', 'idle', 0, 1, ?)`,
    ).run(now);
    raw.prepare(
      `INSERT INTO messages (id, node_id, role, content, seq, created_at)
       VALUES ('legacy-message', 'legacy-node', 'user', 'keep me', 0, ?)`,
    ).run(now);
    raw.close();

    initDb();
    const db = getDb();
    const node = db.prepare(
      "SELECT spawned_by_agent, agent_definition_id FROM nodes WHERE id = 'legacy-node'",
    ).get() as { spawned_by_agent: number; agent_definition_id: string | null };
    assert.equal(node.spawned_by_agent, 1);
    assert.equal(node.agent_definition_id, null);
    const message = db.prepare("SELECT content FROM messages WHERE id = 'legacy-message'").get() as { content: string };
    assert.equal(message.content, 'keep me');
    const runCount = (db.prepare('SELECT COUNT(*) AS count FROM agent_runs').get() as { count: number }).count;
    assert.equal(runCount, 0);
  });
});
