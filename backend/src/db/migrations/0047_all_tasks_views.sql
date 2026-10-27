-- All tasks' views, one list per person. The tasks themselves stay in each
-- workspace's task database.
CREATE TABLE IF NOT EXISTS all_tasks_views (
  owner_user_id TEXT PRIMARY KEY,
  views_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at INTEGER NOT NULL
);
