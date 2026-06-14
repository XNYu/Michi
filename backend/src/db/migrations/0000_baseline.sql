-- 0000_baseline: captures all DDL from db.ts initDb (v1–v14) verbatim.
-- Every CREATE uses IF NOT EXISTS so this is a safe no-op on existing prod data.

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
  archived_at    INTEGER,
  backend        TEXT NOT NULL DEFAULT 'kiro'
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
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tree_id              TEXT REFERENCES trees(id) ON DELETE CASCADE,
  parent_node_id       TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  kind                 TEXT NOT NULL DEFAULT 'chat',
  title                TEXT,
  status               TEXT NOT NULL DEFAULT 'idle',
  position_x           REAL,
  position_y           REAL,
  minimized            INTEGER NOT NULL DEFAULT 0,
  deleted_at           INTEGER,
  deletion_group_id    TEXT,
  spawned_by_agent     INTEGER NOT NULL DEFAULT 0,
  current_mode_id      TEXT,
  pane_width           REAL,
  digest               TEXT,
  follow_ups           TEXT,
  composer_draft       TEXT,
  acp_session_id       TEXT,
  external_session_id  TEXT,
  runtime_id           TEXT,
  provider_id          TEXT,
  model_id             TEXT,
  reasoning            TEXT,
  resume_fingerprint   TEXT,
  created_at           INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);
CREATE INDEX IF NOT EXISTS idx_nodes_workspace ON nodes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_nodes_tree ON nodes(tree_id);

CREATE TABLE IF NOT EXISTS edges (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'branch'
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

-- FTS5 virtual table: not modeled in drizzle schema (see schema.ts comment).
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

CREATE TABLE IF NOT EXISTS workspace_permission_grants (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tool_name    TEXT NOT NULL,
  granted_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, tool_name)
);
CREATE INDEX IF NOT EXISTS idx_grants_workspace ON workspace_permission_grants(workspace_id);

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
