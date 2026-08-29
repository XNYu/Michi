-- Durable coordination for destructive Custom Agent owner deletion and
-- retryable post-commit filesystem cleanup.

CREATE TABLE IF NOT EXISTS agent_owner_deletions (
  owner_user_id  TEXT PRIMARY KEY,
  deletion_token TEXT NOT NULL UNIQUE,
  lease_owner    TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_owner_deletions_expires
  ON agent_owner_deletions (expires_at);

CREATE TABLE IF NOT EXISTS agent_run_cleanup_jobs (
  run_id                 TEXT PRIMARY KEY,
  owner_user_id          TEXT NOT NULL,
  context_manifest       TEXT NOT NULL CHECK (json_valid(context_manifest)),
  execution_environment  TEXT NOT NULL CHECK (json_valid(execution_environment)),
  attempts               INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error             TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_run_cleanup_jobs_owner
  ON agent_run_cleanup_jobs (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_cleanup_jobs_updated
  ON agent_run_cleanup_jobs (updated_at);
