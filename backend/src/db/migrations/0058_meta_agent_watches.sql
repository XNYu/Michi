-- Per-workspace Meta agent instructions, and watches: timed checks of outside
-- sources (tickets, tasks) that the workspace's maintenance execution runs.
-- Kept apart from page_maintenance_configs, whose revision is run authority:
-- editing these must not stop a run that is in progress.
CREATE TABLE IF NOT EXISTS meta_agent_workspace_instructions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, owner_user_id)
);

CREATE TABLE IF NOT EXISTS meta_agent_watches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL CHECK(interval_seconds >= 900),
  enabled INTEGER NOT NULL DEFAULT 1,
  paused_reason TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  run_requested_at INTEGER,
  last_started_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_agent_watches_workspace ON meta_agent_watches(workspace_id, owner_user_id);

-- One row per check, bound to the scheduler's job and run; with its decisions it is the check's receipt.
CREATE TABLE IF NOT EXISTS meta_agent_watch_runs (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL REFERENCES meta_agent_watches(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','succeeded','failed')),
  summary TEXT,
  report TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE(job_id, run_id)
);
CREATE INDEX IF NOT EXISTS idx_meta_agent_watch_runs_watch ON meta_agent_watch_runs(watch_id, started_at);

-- The revision a check read of each page or database, and its one final decision for it.
CREATE TABLE IF NOT EXISTS meta_agent_watch_decisions (
  watch_run_id TEXT NOT NULL REFERENCES meta_agent_watch_runs(id) ON DELETE CASCADE,
  resource_kind TEXT NOT NULL CHECK(resource_kind IN ('page','database')),
  resource_id TEXT NOT NULL,
  observed_revision INTEGER,
  outcome TEXT CHECK(outcome IN ('written','proposed','no_change','deferred')),
  payload_hash TEXT,
  result_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(watch_run_id, resource_kind, resource_id)
);
