-- Workflow runs launched by an agent (Claude Code Workflows, Kiro CLI
-- workflows). One row per run holds its latest snapshot; the runtime folds
-- native events into it outside the chat turn queue.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id              TEXT PRIMARY KEY,
  owner_user_id   TEXT NOT NULL,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_id         TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  runtime         TEXT NOT NULL CHECK (runtime IN ('claude', 'kiro')),
  native_id       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'failed', 'cancelled')),
  run_json        TEXT NOT NULL CHECK (json_valid(run_json) AND json_extract(run_json, '$.version') = 1),
  started_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (owner_user_id, runtime, native_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workspace ON workflow_runs(owner_user_id, workspace_id, updated_at DESC);

-- Per-runtime opt-in for runtime workflow features (Kiro CLI workflows).
ALTER TABLE user_agent_configs ADD COLUMN workflows_by_runtime TEXT NOT NULL DEFAULT '{}';
