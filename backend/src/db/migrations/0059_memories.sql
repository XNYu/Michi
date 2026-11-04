-- Michi Memory: durable notes an owner's agents can save, search and correct
-- across runtimes (services/memory/memoryRepository.ts owns every query).
--
-- row_id is an INTEGER PRIMARY KEY so the FTS index has a stable rowid: an
-- implicit rowid of a table keyed by TEXT may be renumbered by VACUUM, which
-- would silently detach an external-content FTS index from its rows.
CREATE TABLE IF NOT EXISTS memories (
  row_id INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'workspace')),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact', 'decision', 'convention')),
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'superseded')),
  origin TEXT NOT NULL CHECK (origin IN ('explicit', 'extracted')),
  source_node_id TEXT,
  source_message_id TEXT,
  source_turn_id TEXT,
  source_artifact_id TEXT,
  source_risk TEXT CHECK (source_risk IS NULL OR source_risk = 'untrusted'),
  supersedes_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((scope = 'user' AND workspace_id IS NULL) OR (scope = 'workspace' AND workspace_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_memories_owner_scope_status ON memories(owner_user_id, scope, status);
-- Leading workspace_id also serves the ON DELETE CASCADE lookup from workspaces.
CREATE INDEX IF NOT EXISTS idx_memories_workspace_owner_status ON memories(workspace_id, owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_supersedes ON memories(supersedes_id) WHERE supersedes_id IS NOT NULL;

-- Trigram tokenizer: substring recall for CJK and code-like text. Queries
-- shorter than three characters cannot MATCH; the repository uses LIKE then.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  body,
  content='memories',
  content_rowid='row_id',
  tokenize='trigram'
);

-- body is NOT NULL, so every row has exactly one index entry and each
-- 'delete' below hands FTS5 the value it indexed (see 0021_nodes_fts_trigger_fix).
CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, body) VALUES (new.row_id, new.body);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, body) VALUES ('delete', old.row_id, old.body);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF body ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, body) VALUES ('delete', old.row_id, old.body);
  INSERT INTO memories_fts(rowid, body) VALUES (new.row_id, new.body);
END;

-- Monotonic change counter per owner and scope, read by prompt injection to
-- tell when its pinned block is stale. workspace_id '' is the user scope.
CREATE TABLE IF NOT EXISTS memory_scope_versions (
  owner_user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL CHECK (version >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, workspace_id)
);

-- Per-owner memory mode; an owner without a row uses 'explicit'.
CREATE TABLE IF NOT EXISTS memory_settings (
  owner_user_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('off', 'explicit', 'auto')),
  updated_at INTEGER NOT NULL
);
