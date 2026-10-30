-- One chat turn at a time edits a page. A lease is live only while it has not
-- expired and its turn is still active, so a cancelled, failed or interrupted
-- turn releases it without a release step. Dead rows are pruned on acquire.
CREATE TABLE IF NOT EXISTS page_edit_leases (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  touched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at >= touched_at)
);
CREATE INDEX IF NOT EXISTS idx_page_edit_leases_expires ON page_edit_leases(expires_at);
