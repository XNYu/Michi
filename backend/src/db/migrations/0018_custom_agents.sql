-- First-class Custom Agent definitions and durable Agent Runs.

CREATE TABLE IF NOT EXISTS agent_definitions (
  id                     TEXT PRIMARY KEY,
  owner_user_id          TEXT NOT NULL,
  scope                  TEXT NOT NULL CHECK (scope IN ('global', 'workspace')),
  workspace_id           TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  instructions           TEXT NOT NULL,
  runtime_profile        TEXT NOT NULL CHECK (json_valid(runtime_profile) AND json_extract(runtime_profile, '$.version') IS NOT NULL),
  fallback_chain         TEXT NOT NULL DEFAULT '{"version":1,"profiles":[]}' CHECK (json_valid(fallback_chain) AND json_extract(fallback_chain, '$.version') IS NOT NULL),
  tool_refs              TEXT NOT NULL DEFAULT '{"version":1,"refs":[]}' CHECK (json_valid(tool_refs) AND json_extract(tool_refs, '$.version') IS NOT NULL),
  skill_refs             TEXT NOT NULL DEFAULT '{"version":1,"refs":[]}' CHECK (json_valid(skill_refs) AND json_extract(skill_refs, '$.version') IS NOT NULL),
  mcp_server_refs        TEXT NOT NULL DEFAULT '{"version":1,"refs":[]}' CHECK (json_valid(mcp_server_refs) AND json_extract(mcp_server_refs, '$.version') IS NOT NULL),
  permission_policy      TEXT CHECK (permission_policy IS NULL OR (json_valid(permission_policy) AND json_extract(permission_policy, '$.version') IS NOT NULL)),
  context_policy         TEXT NOT NULL CHECK (json_valid(context_policy) AND json_extract(context_policy, '$.version') IS NOT NULL),
  default_run_ttl_ms     INTEGER CHECK (default_run_ttl_ms IS NULL OR default_run_ttl_ms >= 0),
  status                 TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'enabled', 'disabled')),
  revision               INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  CHECK (
    (scope = 'global' AND workspace_id IS NULL) OR
    (scope = 'workspace' AND workspace_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_definitions_owner
  ON agent_definitions (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_agent_definitions_workspace
  ON agent_definitions (workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_definitions_owner_status
  ON agent_definitions (owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_definitions_workspace_status
  ON agent_definitions (workspace_id, status);

ALTER TABLE nodes ADD COLUMN agent_definition_id TEXT
  REFERENCES agent_definitions(id) ON DELETE SET NULL;
ALTER TABLE nodes ADD COLUMN agent_definition_revision INTEGER
  CHECK (agent_definition_revision IS NULL OR agent_definition_revision > 0);
ALTER TABLE nodes ADD COLUMN agent_effective_definition TEXT
  CHECK (
    agent_effective_definition IS NULL OR
    (json_valid(agent_effective_definition) AND json_extract(agent_effective_definition, '$.version') IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_nodes_agent_definition
  ON nodes (agent_definition_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id                       TEXT PRIMARY KEY,
  owner_user_id            TEXT NOT NULL,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  definition_id            TEXT REFERENCES agent_definitions(id) ON DELETE SET NULL,
  definition_revision      INTEGER CHECK (definition_revision IS NULL OR definition_revision > 0),
  effective_definition     TEXT NOT NULL CHECK (json_valid(effective_definition) AND json_extract(effective_definition, '$.version') IS NOT NULL),
  invocation_mode          TEXT NOT NULL CHECK (invocation_mode IN ('delegated', 'manual')),
  completion_mode          TEXT NOT NULL CHECK (completion_mode IN ('wait', 'notify', 'wake', 'detach')),
  parent_run_id            TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  parent_attempt_id        TEXT REFERENCES agent_run_attempts(id) ON DELETE SET NULL,
  parent_node_id           TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  parent_turn_id           TEXT REFERENCES turns(turn_id) ON DELETE SET NULL,
  parent_message_id        TEXT REFERENCES messages(id) ON DELETE SET NULL,
  parent_tool_call_id      TEXT,
  task                     TEXT NOT NULL,
  task_search_text         TEXT NOT NULL DEFAULT '',
  agent_name_snapshot      TEXT NOT NULL DEFAULT '',
  handoff_search_text      TEXT NOT NULL DEFAULT '',
  context_manifest         TEXT NOT NULL CHECK (json_valid(context_manifest) AND json_extract(context_manifest, '$.version') IS NOT NULL),
  expected_result          TEXT CHECK (expected_result IS NULL OR (json_valid(expected_result) AND json_extract(expected_result, '$.version') IS NOT NULL)),
  execution_environment    TEXT NOT NULL CHECK (json_valid(execution_environment) AND json_extract(execution_environment, '$.version') IS NOT NULL),
  status                   TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'preparing', 'running', 'waiting', 'recovering', 'completed', 'failed', 'cancelled')),
  waiting_reason           TEXT CHECK (waiting_reason IS NULL OR waiting_reason IN ('permission', 'context', 'user_input', 'parent_input')),
  active_attempt_id        TEXT REFERENCES agent_run_attempts(id) ON DELETE SET NULL,
  result_bundle            TEXT CHECK (result_bundle IS NULL OR (json_valid(result_bundle) AND json_extract(result_bundle, '$.version') IS NOT NULL)),
  latest_event_seq         INTEGER NOT NULL DEFAULT -1 CHECK (latest_event_seq >= -1),
  next_attempt_index       INTEGER NOT NULL DEFAULT 0 CHECK (next_attempt_index >= 0),
  lease_token              TEXT,
  lease_owner              TEXT,
  lease_expires_at         INTEGER,
  heartbeat_at             INTEGER,
  checkpoint_at            INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  started_at               INTEGER,
  completed_at             INTEGER,
  archived_at              INTEGER,
  expires_at               INTEGER,
  CHECK (
    (lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL) OR
    (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (
    (status IN ('completed', 'failed', 'cancelled') AND completed_at IS NOT NULL) OR
    (status NOT IN ('completed', 'failed', 'cancelled') AND completed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_owner
  ON agent_runs (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace
  ON agent_runs (workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_owner_workspace_status
  ON agent_runs (owner_user_id, workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status_lease
  ON agent_runs (status, lease_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_lease_token
  ON agent_runs (lease_token) WHERE lease_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_runs_parent_run
  ON agent_runs (parent_run_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_parent_attempt
  ON agent_runs (parent_attempt_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_parent_node
  ON agent_runs (parent_node_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_definition
  ON agent_runs (definition_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_expires
  ON agent_runs (expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_task_search
  ON agent_runs (task_search_text);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_name_search
  ON agent_runs (agent_name_snapshot);
CREATE INDEX IF NOT EXISTS idx_agent_runs_handoff_search
  ON agent_runs (handoff_search_text);

CREATE TABLE IF NOT EXISTS agent_run_attempts (
  id                   TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  attempt_index        INTEGER NOT NULL CHECK (attempt_index >= 0),
  profile_index        INTEGER NOT NULL CHECK (profile_index >= 0),
  runtime_profile      TEXT NOT NULL CHECK (json_valid(runtime_profile) AND json_extract(runtime_profile, '$.version') IS NOT NULL),
  status               TEXT NOT NULL CHECK (status IN ('preparing', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
  public_session_id    TEXT NOT NULL,
  native_resume_token  TEXT CHECK (native_resume_token IS NULL OR json_valid(native_resume_token)),
  recovery_envelope    TEXT CHECK (recovery_envelope IS NULL OR (json_valid(recovery_envelope) AND json_extract(recovery_envelope, '$.version') IS NOT NULL)),
  started_at           INTEGER NOT NULL,
  checkpoint_at        INTEGER,
  completed_at         INTEGER,
  error                 TEXT CHECK (error IS NULL OR (json_valid(error) AND json_extract(error, '$.version') IS NOT NULL)),
  CHECK (
    (status IN ('completed', 'failed', 'cancelled') AND completed_at IS NOT NULL) OR
    (status NOT IN ('completed', 'failed', 'cancelled') AND completed_at IS NULL)
  ),
  UNIQUE (run_id, attempt_index),
  UNIQUE (public_session_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_attempts_run_status
  ON agent_run_attempts (run_id, status);

CREATE TABLE IF NOT EXISTS agent_run_events (
  run_id       TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL CHECK (seq >= 0),
  attempt_id   TEXT REFERENCES agent_run_attempts(id) ON DELETE SET NULL,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL CHECK (json_valid(payload)),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_events_attempt
  ON agent_run_events (attempt_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_events_created
  ON agent_run_events (run_id, created_at);

CREATE TABLE IF NOT EXISTS agent_run_interactions (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  attempt_id        TEXT REFERENCES agent_run_attempts(id) ON DELETE SET NULL,
  type              TEXT NOT NULL CHECK (type IN ('permission', 'context', 'user_input', 'parent_input')),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'rejected', 'cancelled')),
  request_payload   TEXT NOT NULL CHECK (json_valid(request_payload) AND json_extract(request_payload, '$.version') IS NOT NULL),
  response_payload  TEXT CHECK (response_payload IS NULL OR (json_valid(response_payload) AND json_extract(response_payload, '$.version') IS NOT NULL)),
  created_at        INTEGER NOT NULL,
  resolved_at       INTEGER,
  CHECK (
    (status = 'pending' AND resolved_at IS NULL) OR
    (status != 'pending' AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_run_interactions_run_status
  ON agent_run_interactions (run_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_run_interactions_attempt
  ON agent_run_interactions (attempt_id);

CREATE TABLE IF NOT EXISTS agent_run_watches (
  id                   TEXT PRIMARY KEY,
  owner_user_id        TEXT NOT NULL,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_run_id        TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  parent_node_id       TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  parent_turn_id       TEXT REFERENCES turns(turn_id) ON DELETE SET NULL,
  condition            TEXT NOT NULL CHECK (json_valid(condition) AND json_extract(condition, '$.version') IS NOT NULL),
  completion_behavior  TEXT NOT NULL CHECK (completion_behavior IN ('wait', 'notify', 'wake', 'detach')),
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'fired', 'cancelled', 'expired')),
  delivery_id          TEXT,
  requested_turn_id    TEXT,
  delivery_status      TEXT CHECK (delivery_status IS NULL OR delivery_status IN ('pending', 'delivered', 'undeliverable')),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  fired_at             INTEGER,
  delivered_at         INTEGER,
  CHECK (
    (status = 'fired' AND fired_at IS NOT NULL) OR
    (status != 'fired' AND fired_at IS NULL)
  ),
  CHECK (
    (delivery_id IS NULL AND requested_turn_id IS NULL AND delivery_status IS NULL) OR
    (delivery_id IS NOT NULL AND requested_turn_id IS NOT NULL AND delivery_status IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_run_watches_owner
  ON agent_run_watches (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_watches_workspace_status
  ON agent_run_watches (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_run_watches_parent_run
  ON agent_run_watches (parent_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_watches_delivery
  ON agent_run_watches (delivery_id) WHERE delivery_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_run_watch_members (
  watch_id      TEXT NOT NULL REFERENCES agent_run_watches(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  added_at      INTEGER NOT NULL,
  satisfied_at  INTEGER,
  PRIMARY KEY (watch_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_watch_members_run
  ON agent_run_watch_members (run_id);
