-- Automatic memory extraction (services/memory/extraction*.ts owns every query).
-- A background Meta agent run reads newly completed turns of one workspace and
-- proposes pending memories. None of these tables keeps a deleted memory's
-- text: tombstones hold a source turn id and a hash of the normalized body.
-- Workspace and owner purges delete their rows (purgeWorkspaceMemories /
-- purgeOwnerMemories); there are no foreign keys to workspaces, which are
-- tombstoned rather than deleted.

-- Owner-wide switches. enabled_at: when auto mode was first switched on; a
-- workspace created later starts its cursor at 0, an older one at the
-- completion position it had when it was enrolled (no backfill).
CREATE TABLE IF NOT EXISTS memory_extraction_state (
  owner_user_id TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  enabled_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- One completion-feed consumer per workspace. job_id is its execution
-- identity in the scheduler ledger (scheduled_jobs, execution_kind
-- 'maintenance'); NULL until the scheduler creates it. Pausing or leaving
-- auto mode keeps the row and its cursor.
CREATE TABLE IF NOT EXISTS memory_extraction_cursors (
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  job_id TEXT UNIQUE,
  completion_cursor INTEGER NOT NULL CHECK (completion_cursor >= 0),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, owner_user_id)
);

-- One execution: the batch a scheduler run claimed. Its id ('mxr-…') is the
-- planId the closed extraction tools are bound to.
CREATE TABLE IF NOT EXISTS memory_extraction_runs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  config_revision INTEGER NOT NULL,
  after_seq INTEGER NOT NULL,
  through_seq INTEGER NOT NULL,
  -- memoryVersion(owner, workspace) and the newest tombstone when it started.
  memory_version INTEGER NOT NULL,
  tombstone_mark INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'succeeded', 'failed', 'cancelled')),
  invalid_calls INTEGER NOT NULL DEFAULT 0,
  -- 'invalid_limit' | 'budget' | NULL: why the tools stopped serving this run.
  stopped_reason TEXT,
  token_budget INTEGER NOT NULL,
  -- Michi's estimate: context_tokens is what the model holds now, estimated_tokens
  -- what it has read and written so far (the context is re-read on every call).
  context_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  reported_tokens INTEGER,
  proposed_count INTEGER NOT NULL DEFAULT 0,
  dropped_count INTEGER NOT NULL DEFAULT 0,
  no_change_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memory_extraction_runs_workspace ON memory_extraction_runs(workspace_id, owner_user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_memory_extraction_runs_owner ON memory_extraction_runs(owner_user_id, started_at);

-- The source turns of an execution and the receipt each one got.
CREATE TABLE IF NOT EXISTS memory_extraction_sources (
  run_id TEXT NOT NULL REFERENCES memory_extraction_runs(id) ON DELETE CASCADE,
  source_turn_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  user_message_id TEXT NOT NULL,
  assistant_message_id TEXT NOT NULL,
  completion_seq INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  untrusted INTEGER NOT NULL DEFAULT 0 CHECK (untrusted IN (0, 1)),
  correction_pattern TEXT,
  read_at INTEGER,
  decision TEXT CHECK (decision IS NULL OR decision IN ('proposed', 'no_change')),
  reason TEXT,
  decided_at INTEGER,
  PRIMARY KEY (run_id, source_turn_id)
);

-- Candidates memory_propose staged; the settling execution commits or drops
-- them. body is cleared once a candidate is committed or dropped.
CREATE TABLE IF NOT EXISTS memory_extraction_candidates (
  run_id TEXT NOT NULL REFERENCES memory_extraction_runs(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  body TEXT,
  body_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact', 'decision', 'convention')),
  scope_hint TEXT NOT NULL CHECK (scope_hint IN ('workspace', 'maybe_global')),
  supersedes_id TEXT,
  source_risk TEXT CHECK (source_risk IS NULL OR source_risk = 'untrusted'),
  state TEXT NOT NULL CHECK (state IN ('staged', 'committed', 'dropped')),
  drop_reason TEXT,
  memory_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, idempotency_key)
);

-- Every committed proposal by idempotency key (owner, workspace, source turn
-- and normalized body), so a source turn never yields the same memory twice.
CREATE TABLE IF NOT EXISTS memory_extraction_proposals (
  idempotency_key TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  scope_hint TEXT NOT NULL CHECK (scope_hint IN ('workspace', 'maybe_global')),
  run_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_extraction_proposals_workspace ON memory_extraction_proposals(workspace_id, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_memory_extraction_proposals_memory ON memory_extraction_proposals(memory_id);

-- Written when a memory is deleted or rejected (onMemoryRemoved). A later
-- proposal from the same source turn, or with the same body hash from a turn
-- that completed before the removal, is dropped. workspace_id NULL: a
-- user-scope memory, which covers every workspace of its owner.
CREATE TABLE IF NOT EXISTS memory_extraction_tombstones (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id TEXT NOT NULL,
  workspace_id TEXT,
  source_turn_id TEXT,
  body_hash TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('deleted', 'rejected')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_extraction_tombstones_turn ON memory_extraction_tombstones(owner_user_id, source_turn_id);
CREATE INDEX IF NOT EXISTS idx_memory_extraction_tombstones_hash ON memory_extraction_tombstones(owner_user_id, body_hash);
CREATE INDEX IF NOT EXISTS idx_memory_extraction_tombstones_workspace ON memory_extraction_tombstones(workspace_id);

-- Tokens per owner and local day (reported by the runtime, or estimated when
-- it reports none). exhausted_at: when the daily limit stopped extraction.
CREATE TABLE IF NOT EXISTS memory_extraction_usage (
  owner_user_id TEXT NOT NULL,
  day_start INTEGER NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  executions INTEGER NOT NULL DEFAULT 0,
  exhausted_at INTEGER,
  PRIMARY KEY (owner_user_id, day_start)
);
