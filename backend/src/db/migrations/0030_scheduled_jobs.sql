-- Scheduled Jobs: prompts the backend runs on a schedule, plus their run history.
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id                   TEXT PRIMARY KEY,
  owner_user_id        TEXT,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  prompt               TEXT NOT NULL,
  schedule             TEXT NOT NULL CHECK (json_valid(schedule) AND json_extract(schedule, '$.kind') IN ('every', 'cron', 'at')),
  runtime_id           TEXT,
  provider_id          TEXT,
  model_id             TEXT,
  reasoning            TEXT,
  permission_mode      TEXT NOT NULL DEFAULT 'trust' CHECK (permission_mode IN ('ask', 'trust', 'yolo')),
  session_mode         TEXT NOT NULL DEFAULT 'fresh' CHECK (session_mode IN ('fresh', 'persistent')),
  persistent_node_id   TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  notify               INTEGER NOT NULL DEFAULT 1,
  enabled              INTEGER NOT NULL DEFAULT 1,
  auto_paused          INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  timeout_seconds      INTEGER NOT NULL DEFAULT 1800,
  next_run_at          INTEGER,
  last_run_at          INTEGER,
  last_status          TEXT,
  last_error           TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due ON scheduled_jobs(enabled, auto_paused, next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_workspace ON scheduled_jobs(workspace_id);

CREATE TABLE IF NOT EXISTS scheduled_job_runs (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL,
  node_id       TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  tree_id       TEXT,
  turn_id       TEXT,
  trigger       TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  status        TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')),
  scheduled_for INTEGER,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  summary       TEXT,
  error         TEXT,
  -- Desktop notification delivery: none | pending | delivered.
  notify_state  TEXT NOT NULL DEFAULT 'none' CHECK (notify_state IN ('none', 'pending', 'delivered')),
  notify_kind   TEXT CHECK (notify_kind IS NULL OR notify_kind IN ('finished', 'attention')),
  attention     TEXT CHECK (attention IS NULL OR attention IN ('approval', 'input')),
  claimed_by    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_job ON scheduled_job_runs(job_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_status ON scheduled_job_runs(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_notify ON scheduled_job_runs(notify_state, finished_at);

-- One scheduler per data directory. A process only runs jobs while it holds
-- this lease, so a dev backend and the background service never double-run.
CREATE TABLE IF NOT EXISTS scheduler_lease (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  holder     TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
