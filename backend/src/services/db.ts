import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { runMigrations as runSqlMigrations } from './migrate';
import { getMichiDataDir } from './dataDir';

declare const __MICHIBUNDLE__: boolean | undefined;

let _db: DatabaseSync | null = null;
let _auditDb: DatabaseSync | null = null;

/**
 * Resolve a migration directory.
 *
 * Dev mode (ts-node): __dirname is .../backend/src/services, SQL lives at
 * .../backend/src/db/migrations, so '../db/...' is correct.
 *
 * Bundled mode: esbuild flattens everything into dist/server.js so __dirname
 * is .../backend/dist, and scripts/build.mjs copies SQL to .../backend/dist/db.
 * The relative offset is then 'db/...' (no '..').
 *
 * The __MICHIBUNDLE__ flag is defined in scripts/build.mjs.
 */
function resolveMigrationsDir(rel: 'migrations' | 'auditMigrations'): string {
  const bundled = typeof __MICHIBUNDLE__ !== 'undefined' && __MICHIBUNDLE__;
  return bundled
    ? path.join(__dirname, 'db', rel)
    : path.join(__dirname, '../db', rel);
}

export function getDbPath(): string {
  return path.join(getMichiDataDir(), 'data.db');
}

export function initDb(): DatabaseSync {
  if (_db) return _db;
  _db = new DatabaseSync(getDbPath());
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  // Multi-window prereq (spec §18/D12): a writer that loses the WAL write-lock
  // race waits up to 5s for the lock instead of throwing SQLITE_BUSY at once.
  _db.exec('PRAGMA busy_timeout = 5000');
  runMigrations(_db);
  // File-based SQL migration runner — records applied files in schema_migrations.
  // Runs after the in-process DDL block so behaviour is identical on fresh installs.
  runSqlMigrations(_db, resolveMigrationsDir('migrations'));
  return _db;
}

export function getDb(): DatabaseSync {
  if (!_db) return initDb();
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function getAuditDbPath(): string {
  return path.join(getMichiDataDir(), 'audit.db');
}

/**
 * Lazy-init audit DB. Opens audit.db in the same data dir as data.db,
 * but deliberately separate so cascade deletes on user rows in data.db
 * do NOT wipe audit history. The audit DB has its own schema_migrations
 * ledger pointing at src/db/auditMigrations/.
 */
export function getAuditDb(): DatabaseSync {
  if (_auditDb) return _auditDb;
  _auditDb = new DatabaseSync(getAuditDbPath());
  _auditDb.exec('PRAGMA journal_mode = WAL');
  _auditDb.exec('PRAGMA foreign_keys = ON');
  // Same multi-window prereq as initDb: audit rows are written on the hot path
  // (every turn / permission), so a second window writing concurrently would
  // otherwise hit SQLITE_BUSY here too.
  _auditDb.exec('PRAGMA busy_timeout = 5000');
  runSqlMigrations(_auditDb, resolveMigrationsDir('auditMigrations'));
  return _auditDb;
}

export function closeAuditDb(): void {
  if (_auditDb) {
    _auditDb.close();
    _auditDb = null;
  }
}

export function runInTransaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getSchemaVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}

function runMigrations(db: DatabaseSync): void {
  const version = getSchemaVersion(db);
  if (version < 1) migrateV1(db);
  if (version < 2 || !columnExists(db, 'contexts', 'size')) migrateV2(db);
  if (version < 3 || !columnExists(db, 'nodes', 'digest')) migrateV3(db);
  if (version < 4 || !columnExists(db, 'nodes', 'follow_ups')) migrateV4(db);
  if (version < 5 || !columnExists(db, 'nodes', 'acp_session_id')) migrateV5(db);
  if (version < 6 || !columnExists(db, 'nodes', 'composer_draft')) migrateV6(db);
  if (version < 7 || !tableExists(db, 'workspace_permission_grants')) migrateV7(db);
  if (version < 8 || !columnExists(db, 'workspaces', 'deleted_at')) migrateV8(db);
  if (version < 9 || !columnExists(db, 'workspaces', 'backend')) migrateV9(db);
  if (version < 10 || !columnExists(db, 'nodes', 'runtime_id')) migrateV10(db);
  if (version < 11 || !columnExists(db, 'nodes', 'resume_fingerprint')) migrateV11(db);
  if (version < 12 || !columnExists(db, 'messages', 'blocks')) migrateV12(db);
  if (version < 13 || !tableExists(db, 'user_provider_keys')) migrateV13(db);
  if (version < 14 || !columnExists(db, 'trees', 'pinned_at')) migrateV14(db);
  // V15+ live in src/db/migrations/*.sql, applied by services/migrate.ts at
  // boot. The SQL ledger lives in `schema_migrations` (separate from the
  // V1..V14 `meta.schema_version` ledger). The runner's benign-error swallow
  // makes the SQL files idempotent across DBs whose V15/V16 columns landed
  // via the retired inline migrateVN code path.
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return !!row;
}

function migrateV1(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      cwd            TEXT,
      model          TEXT,
      active_tree_id TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      settings       TEXT,
      deleted_at     INTEGER,
      archived_at    INTEGER
    );

    CREATE TABLE IF NOT EXISTS trees (
      id             TEXT PRIMARY KEY,
      workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      root_node_id   TEXT NOT NULL,
      name           TEXT,
      archived_at    INTEGER,
      pinned_at      INTEGER,
      last_active_at INTEGER NOT NULL,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trees_workspace ON trees(workspace_id);

    CREATE TABLE IF NOT EXISTS nodes (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      tree_id           TEXT REFERENCES trees(id) ON DELETE CASCADE,
      parent_node_id    TEXT REFERENCES nodes(id) ON DELETE SET NULL,
      kind              TEXT NOT NULL DEFAULT 'chat',
      title             TEXT,
      status            TEXT NOT NULL DEFAULT 'idle',
      position_x        REAL,
      position_y        REAL,
      minimized         INTEGER NOT NULL DEFAULT 0,
      deleted_at        INTEGER,
      deletion_group_id TEXT,
      spawned_by_agent  INTEGER NOT NULL DEFAULT 0,
      current_mode_id   TEXT,
      pane_width        REAL,
      digest            TEXT,
      follow_ups        TEXT,
      follow_ups_source_message_id TEXT,
      composer_draft    TEXT,
      created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_workspace ON nodes(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_tree ON nodes(tree_id);

    CREATE TABLE IF NOT EXISTS edges (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      source_node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target_node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      kind              TEXT NOT NULL DEFAULT 'branch',
      anchor_message_id TEXT,
      created_at        INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_edges_workspace ON edges(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_node_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_node_id);

    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL DEFAULT '',
      blocks     TEXT,
      tool_calls TEXT,
      seq        INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_node ON messages(node_id);

	    CREATE TABLE IF NOT EXISTS contexts (
	      id           TEXT PRIMARY KEY,
	      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	      name         TEXT NOT NULL,
	      file_path    TEXT NOT NULL,
	      size         INTEGER,
	      auto_inject  INTEGER NOT NULL DEFAULT 0,
	      source       TEXT NOT NULL DEFAULT 'user',
	      created_at   INTEGER NOT NULL,
	      updated_at   INTEGER NOT NULL,
	      UNIQUE(workspace_id, name)
	    );
    CREATE INDEX IF NOT EXISTS idx_contexts_workspace ON contexts(workspace_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content=messages,
      content_rowid=rowid
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

	    INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1');
	  `);
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function migrateV2(db: DatabaseSync): void {
  if (!columnExists(db, 'contexts', 'size')) {
    db.prepare('ALTER TABLE contexts ADD COLUMN size INTEGER').run();
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2')").run();
}

function migrateV3(db: DatabaseSync): void {
  if (!columnExists(db, 'nodes', 'digest')) {
    db.prepare('ALTER TABLE nodes ADD COLUMN digest TEXT').run();
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3')").run();
}

function migrateV4(db: DatabaseSync): void {
  if (!columnExists(db, 'nodes', 'follow_ups')) {
    db.prepare('ALTER TABLE nodes ADD COLUMN follow_ups TEXT').run();
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '4')").run();
}

function migrateV5(db: DatabaseSync): void {
  if (!columnExists(db, 'nodes', 'acp_session_id')) {
    db.prepare('ALTER TABLE nodes ADD COLUMN acp_session_id TEXT').run();
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '5')").run();
}

function migrateV6(db: DatabaseSync): void {
  if (!columnExists(db, 'nodes', 'composer_draft')) {
    db.prepare('ALTER TABLE nodes ADD COLUMN composer_draft TEXT').run();
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '6')").run();
}

function migrateV7(db: DatabaseSync): void {
  // Per-workspace, per-tool always-allow grants. Written when the user
  // selects "Allow always" on a permission prompt; read by the policy
  // resolver to short-circuit ask → allow.
  //
  // Cleanup is intentionally hard-delete-only: soft-delete (deleted_at) and
  // tombstoning (purged_at, set by deleteWorkspace) leave grants in place —
  // harmless, since the policy resolver never runs for a hidden workspace. The
  // grant is reaped automatically by ON DELETE CASCADE when runTombstoneGc()
  // finally drops the workspace row (purged_at past TTL). That cascade only
  // fires because the connection sets `PRAGMA foreign_keys = ON` above.
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_permission_grants (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      tool_name    TEXT NOT NULL,
      granted_at   INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, tool_name)
    );
    CREATE INDEX IF NOT EXISTS idx_grants_workspace ON workspace_permission_grants(workspace_id);
  `);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '7')").run();
}

function migrateV8(db: DatabaseSync): void {
  if (!columnExists(db, 'workspaces', 'deleted_at')) {
    db.prepare('ALTER TABLE workspaces ADD COLUMN deleted_at INTEGER').run();
  }
  if (!columnExists(db, 'workspaces', 'archived_at')) {
    db.prepare('ALTER TABLE workspaces ADD COLUMN archived_at INTEGER').run();
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '8')").run();
}

function migrateV9(db: DatabaseSync): void {
  if (!columnExists(db, 'workspaces', 'backend')) {
    db.prepare("ALTER TABLE workspaces ADD COLUMN backend TEXT NOT NULL DEFAULT 'kiro'").run();
  }
  if (!columnExists(db, 'nodes', 'external_session_id')) {
    db.prepare('ALTER TABLE nodes ADD COLUMN external_session_id TEXT').run();
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '9')").run();
}

function migrateV10(db: DatabaseSync): void {
  if (!columnExists(db, 'nodes', 'runtime_id')) {
    db.prepare('ALTER TABLE nodes ADD COLUMN runtime_id TEXT').run();
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '10')").run();
}

function migrateV11(db: DatabaseSync): void {
  if (!columnExists(db, 'nodes', 'provider_id')) {
    db.prepare('ALTER TABLE nodes ADD COLUMN provider_id TEXT').run();
  }
  if (!columnExists(db, 'nodes', 'model_id')) {
    db.prepare('ALTER TABLE nodes ADD COLUMN model_id TEXT').run();
  }
  if (!columnExists(db, 'nodes', 'reasoning')) {
    db.prepare('ALTER TABLE nodes ADD COLUMN reasoning TEXT').run();
  }
  if (!columnExists(db, 'nodes', 'resume_fingerprint')) {
    db.prepare('ALTER TABLE nodes ADD COLUMN resume_fingerprint TEXT').run();
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '11')").run();
}

function migrateV12(db: DatabaseSync): void {
  if (!columnExists(db, 'messages', 'blocks')) {
    db.prepare('ALTER TABLE messages ADD COLUMN blocks TEXT').run();
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '12')").run();
}

/**
 * BYOK provider keys, scoped per user. Plaintext keys are encrypted at
 * rest with AES-256-GCM using MICHI_ENCRYPTION_KEY (see services/userKeys.ts).
 *
 * No FK on user_id because Better-Auth's `user` table lives in a
 * separate sqlite file (auth.sqlite) and SQLite can't enforce FKs across
 * databases. Application code is the single writer.
 */
function migrateV13(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_provider_keys (
      user_id    TEXT NOT NULL,
      provider   TEXT NOT NULL,
      ciphertext BLOB NOT NULL,
      iv         BLOB NOT NULL,
      tag        BLOB NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      PRIMARY KEY (user_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_user_provider_keys_user ON user_provider_keys(user_id);
  `);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '13')").run();
}

function migrateV14(db: DatabaseSync): void {
  if (!columnExists(db, 'trees', 'pinned_at')) {
    db.prepare('ALTER TABLE trees ADD COLUMN pinned_at INTEGER').run();
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '14')").run();
}
