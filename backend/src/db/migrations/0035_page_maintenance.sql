-- Durable workspace maintenance configuration, source routing, and immutable
-- per-resource receipts. Migration 0036 is reserved for native components.
CREATE TABLE page_maintenance_configs (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  completion_cursor INTEGER NOT NULL CHECK(completion_cursor >= 0),
  runtime_id TEXT,
  provider_id TEXT,
  model_id TEXT,
  reasoning TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, owner_user_id)
);
CREATE INDEX idx_page_maintenance_job ON page_maintenance_configs(job_id);

CREATE TABLE page_maintenance_exclusions (
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  space_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  excluded_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, owner_user_id, space_id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE page_maintenance_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES scheduled_job_runs(id) ON DELETE SET NULL,
  config_revision INTEGER NOT NULL CHECK(config_revision >= 1),
  generation INTEGER NOT NULL CHECK(generation >= 1),
  scope_space_id TEXT,
  reconsider_of_plan_id TEXT REFERENCES page_maintenance_plans(id) ON DELETE SET NULL,
  after_seq INTEGER NOT NULL CHECK(after_seq >= 0),
  through_seq INTEGER NOT NULL CHECK(through_seq >= after_seq),
  state TEXT NOT NULL CHECK(state IN ('routing','processing','terminal','attention','cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(job_id, run_id),
  FOREIGN KEY(workspace_id, owner_user_id) REFERENCES page_maintenance_configs(workspace_id, owner_user_id) ON DELETE CASCADE
);
CREATE INDEX idx_page_maintenance_plans_backlog ON page_maintenance_plans(job_id,state,created_at);

CREATE TABLE page_maintenance_sources (
  plan_id TEXT NOT NULL REFERENCES page_maintenance_plans(id) ON DELETE CASCADE,
  source_turn_id TEXT NOT NULL,
  completion_seq INTEGER NOT NULL CHECK(completion_seq >= 1),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  manifest_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(manifest_json)),
  state TEXT NOT NULL CHECK(state IN ('routing','processing','terminal','attention','skipped')),
  routing_complete INTEGER NOT NULL DEFAULT 0 CHECK(routing_complete IN (0,1)),
  candidates_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(candidates_json)),
  terminal_reason TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(plan_id, source_turn_id),
  UNIQUE(plan_id, completion_seq)
);
CREATE INDEX idx_page_maintenance_source_turn ON page_maintenance_sources(source_turn_id,completion_seq);

CREATE TABLE page_maintenance_source_messages (
  plan_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  part_count INTEGER NOT NULL CHECK(part_count >= 1),
  PRIMARY KEY(plan_id,source_turn_id,message_id),
  FOREIGN KEY(plan_id,source_turn_id) REFERENCES page_maintenance_sources(plan_id,source_turn_id) ON DELETE CASCADE
);
CREATE TABLE page_maintenance_source_parts (
  plan_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  part_index INTEGER NOT NULL CHECK(part_index >= 0),
  byte_start INTEGER NOT NULL CHECK(byte_start >= 0),
  byte_end INTEGER NOT NULL CHECK(byte_end >= byte_start),
  part_hash TEXT NOT NULL CHECK(length(part_hash)=64),
  offered_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  PRIMARY KEY(plan_id,source_turn_id,message_id,part_index),
  FOREIGN KEY(plan_id,source_turn_id,message_id) REFERENCES page_maintenance_source_messages(plan_id,source_turn_id,message_id) ON DELETE CASCADE
);
CREATE INDEX idx_page_maintenance_source_parts_progress ON page_maintenance_source_parts(plan_id,source_turn_id,acknowledged_at);

-- Owner-requested reconsiderations wait durably for the next authorized scheduler run.
CREATE TABLE page_maintenance_reconsider_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  previous_plan_id TEXT NOT NULL REFERENCES page_maintenance_plans(id) ON DELETE CASCADE,
  source_turn_ids_json TEXT NOT NULL CHECK(json_valid(source_turn_ids_json)),
  config_revision INTEGER NOT NULL CHECK(config_revision >= 1),
  state TEXT NOT NULL CHECK(state IN ('queued','claimed','completed','cancelled')),
  claimed_plan_id TEXT REFERENCES page_maintenance_plans(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(workspace_id,owner_user_id) REFERENCES page_maintenance_configs(workspace_id,owner_user_id) ON DELETE CASCADE
);
CREATE INDEX idx_page_maintenance_reconsider_queue ON page_maintenance_reconsider_requests(workspace_id,owner_user_id,state,created_at);

CREATE TABLE page_maintenance_exclusion_periods (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  space_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  after_seq INTEGER NOT NULL CHECK(after_seq >= 0),
  through_seq INTEGER CHECK(through_seq IS NULL OR through_seq >= after_seq),
  excluded_at INTEGER NOT NULL,
  reenabled_at INTEGER
);
CREATE INDEX idx_page_maintenance_exclusion_history ON page_maintenance_exclusion_periods(workspace_id,owner_user_id,space_id,after_seq,through_seq);
CREATE UNIQUE INDEX idx_page_maintenance_open_exclusion_period ON page_maintenance_exclusion_periods(workspace_id,owner_user_id,space_id) WHERE through_seq IS NULL;

CREATE TABLE page_maintenance_catchup_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  after_seq INTEGER NOT NULL CHECK(after_seq >= 0),
  through_seq INTEGER NOT NULL CHECK(through_seq > after_seq AND through_seq - after_seq <= 1000),
  space_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  config_revision INTEGER NOT NULL CHECK(config_revision >= 1),
  state TEXT NOT NULL CHECK(state IN ('queued','completed','cancelled')),
  claimed_plan_id TEXT REFERENCES page_maintenance_plans(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(workspace_id,owner_user_id) REFERENCES page_maintenance_configs(workspace_id,owner_user_id) ON DELETE CASCADE
);
CREATE INDEX idx_page_maintenance_catchup_queue ON page_maintenance_catchup_requests(workspace_id,owner_user_id,state,created_at);

CREATE TABLE page_maintenance_resources (
  plan_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK(resource_kind IN ('page','database')),
  resource_id TEXT NOT NULL,
  observed_revision INTEGER NOT NULL CHECK(observed_revision >= 1),
  generation INTEGER NOT NULL CHECK(generation >= 1),
  page_ids_json TEXT NOT NULL CHECK(json_valid(page_ids_json)),
  state TEXT NOT NULL CHECK(state IN ('pending','written','proposed','no_change','skipped','attention')),
  payload_hash TEXT,
  payload_json TEXT CHECK(payload_json IS NULL OR json_valid(payload_json)),
  assigned_ids_json TEXT CHECK(assigned_ids_json IS NULL OR json_valid(assigned_ids_json)),
  receipt_key TEXT NOT NULL UNIQUE,
  terminal_reason TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(plan_id, source_turn_id, resource_kind, resource_id),
  FOREIGN KEY(plan_id, source_turn_id) REFERENCES page_maintenance_sources(plan_id,source_turn_id) ON DELETE CASCADE
);
CREATE INDEX idx_page_maintenance_resource_state ON page_maintenance_resources(plan_id,state);

CREATE TABLE page_maintenance_receipts (
  receipt_key TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES page_maintenance_plans(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  source_turn_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK(resource_kind IN ('page','database')),
  resource_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  assigned_ids_json TEXT NOT NULL CHECK(json_valid(assigned_ids_json)),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  outcome TEXT NOT NULL CHECK(outcome IN ('written','proposed','no_change')),
  execution_json TEXT NOT NULL CHECK(json_valid(execution_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  committed_at INTEGER NOT NULL,
  UNIQUE(job_id,source_turn_id,resource_kind,resource_id,generation)
);
CREATE INDEX idx_page_maintenance_receipt_source ON page_maintenance_receipts(job_id,source_turn_id,generation);
