-- Each immutable revision is both the saved document and its history. Reads
-- select the latest revision only after checking the owning page/workspace.
CREATE TABLE IF NOT EXISTS page_layout_preferences (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  text TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL CHECK (updated_by IN ('user', 'agent')),
  PRIMARY KEY (page_id, revision)
);
