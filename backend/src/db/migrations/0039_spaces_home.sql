-- Spaces Home and workspace home pages, page layout rules, per-workspace
-- first-run progress and progress cards for conversations started from a page.
ALTER TABLE pages ADD COLUMN role TEXT CHECK(role IS NULL OR role IN ('spaces-home','workspace-home'));
ALTER TABLE pages ADD COLUMN layout_rules TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(layout_rules) AND json_type(layout_rules)='array');
ALTER TABLE pages ADD COLUMN hidden_at INTEGER;
-- Home pages are never soft-deleted, so the indexes ignore deleted_at: a
-- stray tombstoned home is restored by the ensure path instead of duplicated.
CREATE UNIQUE INDEX idx_pages_spaces_home ON pages(owner_user_id) WHERE role='spaces-home';
CREATE UNIQUE INDEX idx_pages_workspace_home ON pages(workspace_id) WHERE role='workspace-home';

CREATE TABLE page_first_runs (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  start_seq INTEGER NOT NULL CHECK(start_seq >= 0),
  read_count INTEGER NOT NULL DEFAULT 0 CHECK(read_count >= 0),
  total INTEGER NOT NULL CHECK(total >= 0 AND read_count <= total),
  state TEXT NOT NULL CHECK(state IN ('queued','reading','writing','done','failed')),
  error TEXT CHECK((state = 'failed') = (error IS NOT NULL)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, owner_user_id)
);
CREATE INDEX idx_page_first_runs_owner ON page_first_runs(owner_user_id, started_at);

CREATE TABLE page_progress_cards (
  owner_user_id TEXT NOT NULL,
  thread_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  started_from_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  seen_at INTEGER,
  dismissed_at INTEGER,
  PRIMARY KEY(owner_user_id, thread_node_id)
);
CREATE INDEX idx_page_progress_cards_page ON page_progress_cards(started_from_page_id, created_at);
CREATE INDEX idx_page_progress_cards_owner ON page_progress_cards(owner_user_id, created_at);
