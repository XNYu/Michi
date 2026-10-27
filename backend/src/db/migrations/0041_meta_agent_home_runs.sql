-- Managed maintenance runs that write a home page instead of an incremental
-- batch: a workspace's first-time generation, or the Spaces Home summary.
-- Bound to the scheduler's job and run; the row is the run's receipt.
CREATE TABLE meta_agent_home_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('first-run','home-summary')),
  owner_user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  target_page_id TEXT NOT NULL,
  fingerprint TEXT,
  state TEXT NOT NULL CHECK(state IN ('active','written','no_change','failed','superseded')),
  payload_hash TEXT,
  result_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(job_id, run_id)
);
CREATE INDEX idx_meta_agent_home_runs_owner ON meta_agent_home_runs(owner_user_id, kind, state);

-- Conversations a first run has shown the model, so progress survives a restart.
CREATE TABLE meta_agent_first_run_reads (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, owner_user_id, node_id)
);

-- One row per owner once Spaces was opened: the last summarised home input,
-- the card templates and what was last stored, and a guard stop.
CREATE TABLE meta_agent_home_state (
  owner_user_id TEXT PRIMARY KEY,
  requested_at INTEGER NOT NULL,
  summary_fingerprint TEXT,
  summarized_at INTEGER,
  summary_failed_fingerprint TEXT,
  summary_failures INTEGER NOT NULL DEFAULT 0,
  summary_failed_at INTEGER,
  cards_json TEXT,
  cards_fingerprint TEXT,
  cards_rendered TEXT,
  halted_reason TEXT,
  halted_at INTEGER,
  updated_at INTEGER NOT NULL
);
