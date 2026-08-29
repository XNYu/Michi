import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { closeDb, getDb, initDb } from '../src/services/db';
import { runMigrations } from '../src/services/migrate';

let tmpDir: string;

function migrationsDir(): string {
  return path.join(__dirname, '../src/db/migrations');
}

function tableColumns(db: DatabaseSync, table: string): Array<{
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }>;
}

function foreignKeys(db: DatabaseSync, table: string): Array<{
  table: string;
  from: string;
  to: string;
  on_delete: string;
}> {
  return db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
}

function insertWorkspace(db: DatabaseSync, id = 'ws-1'): void {
  const now = Date.now();
  db.prepare(
    'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run(id, 'Workspace', now, now);
}

function insertNode(db: DatabaseSync, id = 'node-1', workspaceId = 'ws-1'): void {
  db.prepare(
    `INSERT INTO nodes
       (id, workspace_id, kind, status, minimized, spawned_by_agent, created_at)
     VALUES (?, ?, 'chat', 'idle', 0, 0, ?)`,
  ).run(id, workspaceId, Date.now());
}

function insertDefinition(db: DatabaseSync, id = 'def-1', workspaceId: string | null = 'ws-1'): void {
  const scope = workspaceId === null ? 'global' : 'workspace';
  const now = Date.now();
  db.prepare(
    `INSERT INTO agent_definitions (
       id, owner_user_id, scope, workspace_id, name, description, instructions,
       runtime_profile, context_policy, status, revision, created_at, updated_at
     ) VALUES (?, 'owner-1', ?, ?, 'Researcher', '', 'Research carefully',
       '{"version":1,"runtimeId":"pi"}', '{"version":1}', 'enabled', 1, ?, ?)`,
  ).run(id, scope, workspaceId, now, now);
}

function insertRun(
  db: DatabaseSync,
  id = 'run-1',
  definitionId: string | null = 'def-1',
  parentNodeId: string | null = 'node-1',
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agent_runs (
       id, owner_user_id, workspace_id, definition_id, definition_revision,
       effective_definition, invocation_mode, completion_mode, parent_node_id, task,
       task_search_text, agent_name_snapshot, handoff_search_text,
       context_manifest, execution_environment, status, created_at, updated_at
     ) VALUES (?, 'owner-1', 'ws-1', ?, 1, '{"version":1}', 'delegated', 'wake', ?,
       'Research SQLite', 'research sqlite', 'researcher', '',
       '{"version":1,"entries":[]}', '{"version":1,"kind":"shared_workspace"}',
       'queued', ?, ?)`,
  ).run(id, definitionId, parentNodeId, now, now);
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
  test('fresh DB contains every Custom Agent table and primary-Agent node column', () => {
    initDb();
    const db = getDb();

    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    for (const table of [
      'agent_definitions',
      'agent_runs',
      'agent_run_attempts',
      'agent_run_events',
      'agent_run_interactions',
      'agent_run_watches',
      'agent_run_watch_members',
      'agent_owner_deletions',
      'agent_run_cleanup_jobs',
    ]) {
      assert.ok(tables.has(table), `${table} must exist`);
    }

    const expectedColumns: Record<string, string[]> = {
      agent_definitions: [
        'id', 'owner_user_id', 'scope', 'workspace_id', 'name', 'description',
        'instructions', 'runtime_profile', 'fallback_chain', 'tool_refs',
        'skill_refs', 'mcp_server_refs', 'permission_policy', 'context_policy',
        'default_run_ttl_ms', 'status', 'revision', 'created_at', 'updated_at',
      ],
      agent_runs: [
        'id', 'owner_user_id', 'workspace_id', 'definition_id',
        'definition_revision', 'effective_definition', 'invocation_mode', 'completion_mode',
        'parent_run_id', 'parent_attempt_id', 'parent_node_id', 'parent_turn_id', 'parent_message_id',
        'parent_tool_call_id', 'task', 'task_search_text', 'agent_name_snapshot',
        'handoff_search_text', 'context_manifest', 'expected_result',
        'execution_environment', 'status', 'waiting_reason', 'active_attempt_id',
        'result_bundle', 'latest_event_seq', 'next_attempt_index', 'lease_token',
        'lease_owner', 'lease_expires_at', 'heartbeat_at', 'checkpoint_at',
        'created_at', 'updated_at', 'started_at', 'completed_at', 'archived_at',
        'expires_at',
      ],
      agent_run_attempts: [
        'id', 'run_id', 'attempt_index', 'profile_index', 'runtime_profile',
        'status', 'public_session_id', 'native_resume_token', 'recovery_envelope',
        'started_at', 'checkpoint_at', 'completed_at', 'error',
      ],
      agent_run_events: ['run_id', 'seq', 'attempt_id', 'type', 'payload', 'created_at'],
      agent_run_interactions: [
        'id', 'run_id', 'attempt_id', 'type', 'status', 'request_payload',
        'response_payload', 'created_at', 'resolved_at',
      ],
      agent_run_watches: [
        'id', 'owner_user_id', 'workspace_id', 'parent_run_id', 'parent_node_id',
        'parent_turn_id', 'condition', 'completion_behavior', 'status',
        'delivery_id', 'requested_turn_id', 'delivery_status', 'created_at',
        'updated_at', 'fired_at', 'delivered_at',
      ],
      agent_run_watch_members: ['watch_id', 'run_id', 'added_at', 'satisfied_at'],
      agent_owner_deletions: [
        'owner_user_id', 'deletion_token', 'lease_owner', 'started_at', 'expires_at',
      ],
      agent_run_cleanup_jobs: [
        'run_id', 'owner_user_id', 'context_manifest', 'execution_environment',
        'attempts', 'last_error', 'created_at', 'updated_at',
      ],
    };
    for (const [table, expected] of Object.entries(expectedColumns)) {
      const actual = tableColumns(db, table).map((column) => column.name);
      assert.deepEqual(actual, expected, `${table} columns must match the migration contract`);
    }

    const nodeColumns = tableColumns(db, 'nodes');
    for (const name of [
      'agent_definition_id',
      'agent_definition_revision',
      'agent_effective_definition',
    ]) {
      const column = nodeColumns.find((candidate) => candidate.name === name);
      assert.ok(column, `nodes.${name} must exist`);
      assert.equal(column.notnull, 0, `nodes.${name} must be nullable`);
    }
  });

  test('fresh DB has required defaults and search, lease, event, and ownership indexes', () => {
    initDb();
    const db = getDb();

    const definitionColumns = tableColumns(db, 'agent_definitions');
    assert.equal(definitionColumns.find((c) => c.name === 'status')?.dflt_value, "'draft'");
    assert.equal(definitionColumns.find((c) => c.name === 'revision')?.dflt_value, '1');

    const runColumns = tableColumns(db, 'agent_runs');
    assert.equal(runColumns.find((c) => c.name === 'status')?.dflt_value, "'queued'");
    assert.equal(runColumns.find((c) => c.name === 'latest_event_seq')?.dflt_value, '-1');
    assert.equal(runColumns.find((c) => c.name === 'next_attempt_index')?.dflt_value, '0');
    for (const name of ['task_search_text', 'agent_name_snapshot', 'handoff_search_text']) {
      assert.ok(runColumns.some((column) => column.name === name), `agent_runs.${name} must exist`);
    }

    const indexes = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    for (const name of [
      'idx_agent_definitions_owner_status',
      'idx_agent_definitions_workspace_status',
      'idx_agent_runs_owner_workspace_status',
      'idx_agent_runs_status_lease',
      'idx_agent_runs_lease_token',
      'idx_agent_runs_task_search',
      'idx_agent_runs_agent_name_search',
      'idx_agent_runs_handoff_search',
      'idx_agent_runs_parent_attempt',
      'idx_agent_run_events_created',
      'idx_agent_run_watches_workspace_status',
      'idx_agent_run_watch_members_run',
    ]) {
      assert.ok(indexes.has(name), `${name} must exist`);
    }
  });

  test('scope/workspace, versioned JSON, lease, and terminal timestamp checks are enforced', () => {
    initDb();
    const db = getDb();
    insertWorkspace(db);
    insertNode(db);

    assert.throws(
      () => db.prepare(
        `INSERT INTO agent_definitions (
           id, owner_user_id, scope, workspace_id, name, instructions,
           runtime_profile, context_policy, created_at, updated_at
         ) VALUES ('bad-global', 'owner-1', 'global', 'ws-1', 'Bad', 'Bad',
           '{"version":1}', '{"version":1}', 1, 1)`,
      ).run(),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => db.prepare(
        `INSERT INTO agent_definitions (
           id, owner_user_id, scope, name, instructions, runtime_profile,
           context_policy, created_at, updated_at
         ) VALUES ('bad-json', 'owner-1', 'global', 'Bad', 'Bad', '{}',
           '{"version":1}', 1, 1)`,
      ).run(),
      /CHECK constraint failed/,
    );

    insertDefinition(db);
    insertRun(db);
    assert.throws(
      () => db.prepare(
        "UPDATE agent_runs SET lease_token = 'claim-only' WHERE id = 'run-1'",
      ).run(),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => db.prepare(
        "UPDATE agent_runs SET status = 'completed' WHERE id = 'run-1'",
      ).run(),
      /CHECK constraint failed/,
    );
    assert.doesNotThrow(() => db.prepare(
      "UPDATE agent_runs SET status = 'completed', completed_at = 2 WHERE id = 'run-1'",
    ).run());
  });

  test('foreign keys preserve Runs when Definition or Parent node is deleted', () => {
    initDb();
    const db = getDb();
    insertWorkspace(db);
    insertNode(db);
    insertDefinition(db);
    insertRun(db);

    const runFks = foreignKeys(db, 'agent_runs');
    assert.ok(runFks.some((fk) => fk.from === 'definition_id' && fk.on_delete === 'SET NULL'));
    assert.ok(runFks.some((fk) => fk.from === 'parent_node_id' && fk.on_delete === 'SET NULL'));
    assert.ok(runFks.some((fk) => fk.from === 'parent_run_id' && fk.on_delete === 'SET NULL'));
    assert.ok(runFks.some((fk) => fk.from === 'parent_attempt_id' && fk.on_delete === 'SET NULL'));
    assert.ok(runFks.some((fk) => fk.from === 'active_attempt_id' && fk.on_delete === 'SET NULL'));

    for (const table of ['agent_run_attempts', 'agent_run_events', 'agent_run_interactions']) {
      assert.ok(
        foreignKeys(db, table).some((fk) => fk.from === 'run_id' && fk.on_delete === 'CASCADE'),
        `${table}.run_id must cascade on hard Run deletion`,
      );
    }
    const memberFks = foreignKeys(db, 'agent_run_watch_members');
    assert.ok(memberFks.some((fk) => fk.from === 'run_id' && fk.on_delete === 'CASCADE'));
    assert.ok(memberFks.some((fk) => fk.from === 'watch_id' && fk.on_delete === 'CASCADE'));

    db.prepare("DELETE FROM agent_definitions WHERE id = 'def-1'").run();
    let row = db.prepare("SELECT definition_id, definition_revision, parent_node_id FROM agent_runs WHERE id = 'run-1'").get() as {
      definition_id: string | null;
      definition_revision: number | null;
      parent_node_id: string | null;
    };
    assert.equal(row.definition_id, null);
    assert.equal(row.definition_revision, 1);
    assert.equal(row.parent_node_id, 'node-1');

    db.prepare("DELETE FROM nodes WHERE id = 'node-1'").run();
    row = db.prepare("SELECT definition_id, definition_revision, parent_node_id FROM agent_runs WHERE id = 'run-1'").get() as {
      definition_id: string | null;
      definition_revision: number | null;
      parent_node_id: string | null;
    };
    assert.equal(row.parent_node_id, null);
  });

  test('hard Run deletion cascades attempts, events, interactions, and watch membership', () => {
    initDb();
    const db = getDb();
    insertWorkspace(db);
    insertNode(db);
    insertDefinition(db);
    insertRun(db);
    const now = Date.now();

    db.prepare(
      `INSERT INTO agent_run_attempts (
         id, run_id, attempt_index, profile_index, runtime_profile, status,
         public_session_id, started_at
       ) VALUES ('attempt-1', 'run-1', 0, 0, '{"version":1}', 'running', 'session-1', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO agent_run_events (run_id, seq, attempt_id, type, payload, created_at)
       VALUES ('run-1', 0, 'attempt-1', 'attempt_started', '{}', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO agent_run_interactions (
         id, run_id, attempt_id, type, request_payload, created_at
       ) VALUES ('interaction-1', 'run-1', 'attempt-1', 'permission', '{"version":1}', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO agent_run_watches (
         id, owner_user_id, workspace_id, condition, completion_behavior,
         status, created_at, updated_at
       ) VALUES ('watch-1', 'owner-1', 'ws-1', '{"version":1,"kind":"all"}',
         'notify', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO agent_run_watch_members (watch_id, run_id, added_at)
       VALUES ('watch-1', 'run-1', ?)`,
    ).run(now);

    db.prepare("DELETE FROM agent_runs WHERE id = 'run-1'").run();
    for (const table of [
      'agent_run_attempts',
      'agent_run_events',
      'agent_run_interactions',
      'agent_run_watch_members',
    ]) {
      const count = (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
      assert.equal(count, 0, `${table} rows must cascade`);
    }
    const watchCount = (db.prepare('SELECT COUNT(*) AS count FROM agent_run_watches').get() as { count: number }).count;
    assert.equal(watchCount, 1, 'the workspace-owned Watch itself must survive member Run deletion');
  });

  test('event sequences and watch memberships are unique per parent', () => {
    initDb();
    const db = getDb();
    insertWorkspace(db);
    insertDefinition(db);
    insertRun(db, 'run-1', 'def-1', null);
    const now = Date.now();

    db.prepare(
      "INSERT INTO agent_run_events (run_id, seq, type, payload, created_at) VALUES ('run-1', 0, 'queued', '{}', ?)",
    ).run(now);
    assert.throws(
      () => db.prepare(
        "INSERT INTO agent_run_events (run_id, seq, type, payload, created_at) VALUES ('run-1', 0, 'duplicate', '{}', ?)",
      ).run(now),
      /UNIQUE constraint failed/,
    );

    db.prepare(
      `INSERT INTO agent_run_watches (
         id, owner_user_id, workspace_id, condition, completion_behavior,
         status, created_at, updated_at
       ) VALUES ('watch-1', 'owner-1', 'ws-1', '{"version":1,"kind":"all"}',
         'notify', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      "INSERT INTO agent_run_watch_members (watch_id, run_id, added_at) VALUES ('watch-1', 'run-1', ?)",
    ).run(now);
    assert.throws(
      () => db.prepare(
        "INSERT INTO agent_run_watch_members (watch_id, run_id, added_at) VALUES ('watch-1', 'run-1', ?)",
      ).run(now),
      /UNIQUE constraint failed/,
    );
  });

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

  test('re-running migrations is a ledger no-op', () => {
    initDb();
    const db = getDb();
    insertWorkspace(db);
    const before = (db.prepare(
      "SELECT applied_at FROM schema_migrations WHERE version = '0018_custom_agents'",
    ).get() as { applied_at: number }).applied_at;

    assert.doesNotThrow(() => runMigrations(db, migrationsDir()));

    const rows = db.prepare(
      "SELECT applied_at FROM schema_migrations WHERE version = '0018_custom_agents'",
    ).all() as Array<{ applied_at: number }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].applied_at, before);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count, 1);
  });
});
