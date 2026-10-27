CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  color TEXT,
  blocks TEXT NOT NULL CHECK(json_valid(blocks)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  view_version INTEGER NOT NULL DEFAULT 1 CHECK(view_version >= 1),
  helper_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'user' CHECK(updated_by IN ('user','agent')),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deletion_group_id TEXT
);
CREATE INDEX idx_pages_tree ON pages(workspace_id, parent_id, deleted_at, position);
CREATE INDEX idx_pages_owner ON pages(owner_user_id, workspace_id);

CREATE TABLE page_revisions (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  source TEXT NOT NULL CHECK(json_valid(source)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(page_id, revision)
);

CREATE TABLE page_databases (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  columns_json TEXT NOT NULL CHECK(json_valid(columns_json)),
  views_json TEXT NOT NULL CHECK(json_valid(views_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deletion_group_id TEXT
);
CREATE INDEX idx_page_databases_workspace ON page_databases(workspace_id, deleted_at);
CREATE TABLE page_database_rows (
  database_id TEXT NOT NULL REFERENCES page_databases(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  values_json TEXT NOT NULL CHECK(json_valid(values_json)),
  body TEXT,
  rev INTEGER NOT NULL CHECK(rev >= 1),
  edited TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(edited)),
  body_edited_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(database_id, id)
);
CREATE INDEX idx_page_database_rows_order ON page_database_rows(database_id, position, id);
CREATE TABLE page_database_refs (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  database_id TEXT NOT NULL REFERENCES page_databases(id) ON DELETE CASCADE,
  PRIMARY KEY(page_id, database_id)
);
CREATE INDEX idx_page_database_refs_database ON page_database_refs(database_id, page_id);

CREATE TABLE page_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  database_id TEXT REFERENCES page_databases(id) ON DELETE CASCADE,
  target_key TEXT NOT NULL,
  target TEXT NOT NULL CHECK(json_valid(target)),
  batch_id TEXT NOT NULL,
  op TEXT NOT NULL,
  before_json TEXT CHECK(before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK(after_json IS NULL OR json_valid(after_json)),
  forward_json TEXT NOT NULL CHECK(json_valid(forward_json)),
  inverse_json TEXT NOT NULL CHECK(json_valid(inverse_json)),
  base_rev INTEGER NOT NULL CHECK(base_rev >= 1),
  applied_rev INTEGER,
  previous_head_id TEXT,
  source TEXT NOT NULL CHECK(json_valid(source)),
  source_node_id TEXT,
  proposal_state TEXT CHECK(proposal_state IN ('pending','accepted','dismissed')),
  application_state TEXT CHECK(application_state IN ('applied','reverted')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  CHECK((page_id IS NOT NULL) != (database_id IS NOT NULL)),
  CHECK((proposal_state IS NULL AND application_state IS NOT NULL)
    OR (proposal_state IN ('pending','dismissed') AND application_state IS NULL)
    OR (proposal_state = 'accepted' AND application_state IS NOT NULL))
);
CREATE INDEX idx_page_changes_page ON page_changes(page_id, seq);
CREATE INDEX idx_page_changes_database ON page_changes(database_id, seq);
CREATE INDEX idx_page_changes_batch ON page_changes(workspace_id, batch_id, seq);
CREATE INDEX idx_page_changes_source ON page_changes(workspace_id, source_node_id, seq);
CREATE INDEX idx_page_changes_target ON page_changes(workspace_id, target_key, seq);

CREATE TABLE page_target_heads (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_key TEXT NOT NULL,
  head_id TEXT,
  target_revision INTEGER NOT NULL CHECK(target_revision >= 1),
  PRIMARY KEY(workspace_id, target_key)
);
CREATE TABLE page_activity_seen (
  owner_user_id TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  last_seen_change_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_seen_change_seq >= 0),
  PRIMARY KEY(owner_user_id, page_id)
);
ALTER TABLE nodes ADD COLUMN page_id TEXT REFERENCES pages(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_nodes_active_page_helper ON nodes(page_id)
  WHERE page_id IS NOT NULL AND deleted_at IS NULL AND purged_at IS NULL;
