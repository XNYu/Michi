import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey, blob, check } from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------
export const meta = sqliteTable('meta', {
  key:   text('key').primaryKey(),
  value: text('value').notNull(),
});

// ---------------------------------------------------------------------------
// workspaces
// ---------------------------------------------------------------------------
export const workspaces = sqliteTable('workspaces', {
  id:           text('id').primaryKey(),
  name:         text('name').notNull(),
  cwd:          text('cwd'),
  model:        text('model'),
  activeTreeId: text('active_tree_id'),
  createdAt:    integer('created_at').notNull(),
  updatedAt:    integer('updated_at').notNull(),
  settings:     text('settings'),
  deletedAt:    integer('deleted_at'),
  archivedAt:   integer('archived_at'),
  backend:      text('backend').notNull().default('kiro'),
  // syncRev: per-workspace monotonic version counter (sync L2). Bumped once per
  // sync txn; every row written by that txn is stamped with the new value.
  syncRev:      integer('sync_rev').notNull().default(0),
  persistenceVersion: integer('persistence_version').notNull().default(1),
  // ownerUserId: nullable in SQLite (NOT NULL enforced in app code only —
  // SQLite cannot add a NOT NULL column via ALTER TABLE ADD COLUMN).
  // Set by the route layer on INSERT; checked by ownership middleware.
  ownerUserId:  text('owner_user_id'),
}, (t) => ({
  ownerIdx: index('idx_workspaces_owner').on(t.ownerUserId),
}));

// ---------------------------------------------------------------------------
// agent_definitions
// ---------------------------------------------------------------------------
export const agentDefinitions = sqliteTable('agent_definitions', {
  id:                 text('id').primaryKey(),
  ownerUserId:        text('owner_user_id').notNull(),
  scope:              text('scope').notNull(),
  workspaceId:        text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  name:               text('name').notNull(),
  description:        text('description').notNull().default(''),
  instructions:       text('instructions').notNull(),
  runtimeProfile:     text('runtime_profile').notNull(),
  fallbackChain:      text('fallback_chain').notNull().default('{"version":1,"profiles":[]}'),
  toolRefs:           text('tool_refs').notNull().default('{"version":1,"refs":[]}'),
  skillRefs:          text('skill_refs').notNull().default('{"version":1,"refs":[]}'),
  mcpServerRefs:      text('mcp_server_refs').notNull().default('{"version":1,"refs":[]}'),
  permissionPolicy:   text('permission_policy'),
  contextPolicy:      text('context_policy').notNull(),
  defaultRunTtlMs:    integer('default_run_ttl_ms'),
  status:             text('status').notNull().default('draft'),
  revision:           integer('revision').notNull().default(1),
  createdAt:          integer('created_at').notNull(),
  updatedAt:          integer('updated_at').notNull(),
}, (t) => ({
  ownerIdx:           index('idx_agent_definitions_owner').on(t.ownerUserId),
  workspaceIdx:       index('idx_agent_definitions_workspace').on(t.workspaceId),
  ownerStatusIdx:     index('idx_agent_definitions_owner_status').on(t.ownerUserId, t.status),
  workspaceStatusIdx: index('idx_agent_definitions_workspace_status').on(t.workspaceId, t.status),
  scopeCheck:         check('agent_definitions_scope_check', sql`${t.scope} IN ('global', 'workspace')`),
  scopeWorkspaceCheck: check('agent_definitions_scope_workspace_check', sql`
    (${t.scope} = 'global' AND ${t.workspaceId} IS NULL) OR
    (${t.scope} = 'workspace' AND ${t.workspaceId} IS NOT NULL)
  `),
  ttlCheck:           check('agent_definitions_ttl_check', sql`${t.defaultRunTtlMs} IS NULL OR ${t.defaultRunTtlMs} >= 0`),
  statusCheck:        check('agent_definitions_status_check', sql`${t.status} IN ('draft', 'enabled', 'disabled')`),
  revisionCheck:      check('agent_definitions_revision_check', sql`${t.revision} > 0`),
  runtimeProfileJsonCheck: check('agent_definitions_runtime_profile_json_check', sql`json_valid(${t.runtimeProfile}) AND json_extract(${t.runtimeProfile}, '$.version') IS NOT NULL`),
  fallbackChainJsonCheck: check('agent_definitions_fallback_chain_json_check', sql`json_valid(${t.fallbackChain}) AND json_extract(${t.fallbackChain}, '$.version') IS NOT NULL`),
  toolRefsJsonCheck:  check('agent_definitions_tool_refs_json_check', sql`json_valid(${t.toolRefs}) AND json_extract(${t.toolRefs}, '$.version') IS NOT NULL`),
  skillRefsJsonCheck: check('agent_definitions_skill_refs_json_check', sql`json_valid(${t.skillRefs}) AND json_extract(${t.skillRefs}, '$.version') IS NOT NULL`),
  mcpRefsJsonCheck:   check('agent_definitions_mcp_refs_json_check', sql`json_valid(${t.mcpServerRefs}) AND json_extract(${t.mcpServerRefs}, '$.version') IS NOT NULL`),
  permissionPolicyJsonCheck: check('agent_definitions_permission_policy_json_check', sql`${t.permissionPolicy} IS NULL OR (json_valid(${t.permissionPolicy}) AND json_extract(${t.permissionPolicy}, '$.version') IS NOT NULL)`),
  contextPolicyJsonCheck: check('agent_definitions_context_policy_json_check', sql`json_valid(${t.contextPolicy}) AND json_extract(${t.contextPolicy}, '$.version') IS NOT NULL`),
}));

// ---------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------
export const trees = sqliteTable('trees', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull().references(() => workspaces.id),
  rootNodeId:   text('root_node_id').notNull(),
  name:         text('name'),
  archivedAt:   integer('archived_at'),
  pinnedAt:     integer('pinned_at'),
  lastActiveAt: integer('last_active_at').notNull(),
  createdAt:    integer('created_at').notNull(),
  // rev: per-row sync version (sync L2). Nullable — NULL = predates versioning.
  rev:          integer('rev'),
}, (t) => ({
  workspaceIdx: index('idx_trees_workspace').on(t.workspaceId),
}));

// ---------------------------------------------------------------------------
// nodes
// ---------------------------------------------------------------------------
export const nodes = sqliteTable('nodes', {
  id:                 text('id').primaryKey(),
  workspaceId:        text('workspace_id').notNull().references(() => workspaces.id),
  treeId:             text('tree_id').references(() => trees.id),
  parentNodeId:       text('parent_node_id'),  // self-ref; drizzle doesn't support inline self-ref
  kind:               text('kind').notNull().default('chat'),
  title:              text('title'),
  branchOverview:     text('branch_overview'),
  status:             text('status').notNull().default('idle'),
  positionX:          real('position_x'),
  positionY:          real('position_y'),
  minimized:          integer('minimized').notNull().default(0),
  deletedAt:          integer('deleted_at'),
  deletionGroupId:    text('deletion_group_id'),
  spawnedByAgent:     integer('spawned_by_agent').notNull().default(0),
  currentModeId:      text('current_mode_id'),
  paneWidth:          real('pane_width'),
  digest:             text('digest'),
  followUps:          text('follow_ups'),
  composerDraft:      text('composer_draft'),
  acpSessionId:       text('acp_session_id'),
  externalSessionId:  text('external_session_id'),
  runtimeId:          text('runtime_id'),
  providerId:         text('provider_id'),
  modelId:            text('model_id'),
  reasoning:          text('reasoning'),
  resumeFingerprint:  text('resume_fingerprint'),
  agentDefinitionId:  text('agent_definition_id').references(() => agentDefinitions.id, { onDelete: 'set null' }),
  agentDefinitionRevision: integer('agent_definition_revision'),
  agentEffectiveDefinition: text('agent_effective_definition'),
  createdAt:          integer('created_at').notNull(),
  // rev: per-row sync version (sync L2). Nullable — NULL = predates versioning.
  rev:                integer('rev'),
}, (t) => ({
  workspaceIdx: index('idx_nodes_workspace').on(t.workspaceId),
  treeIdx:      index('idx_nodes_tree').on(t.treeId),
  agentDefinitionIdx: index('idx_nodes_agent_definition').on(t.agentDefinitionId),
  agentDefinitionRevisionCheck: check('nodes_agent_definition_revision_check', sql`${t.agentDefinitionRevision} IS NULL OR ${t.agentDefinitionRevision} > 0`),
  agentEffectiveDefinitionJsonCheck: check('nodes_agent_effective_definition_json_check', sql`${t.agentEffectiveDefinition} IS NULL OR (json_valid(${t.agentEffectiveDefinition}) AND json_extract(${t.agentEffectiveDefinition}, '$.version') IS NOT NULL)`),
}));

// ---------------------------------------------------------------------------
// edges
// ---------------------------------------------------------------------------
export const edges = sqliteTable('edges', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull().references(() => workspaces.id),
  sourceNodeId: text('source_node_id').notNull().references(() => nodes.id),
  targetNodeId: text('target_node_id').notNull().references(() => nodes.id),
  kind:         text('kind').notNull().default('branch'),
  // rev: per-row sync version (sync L2). Nullable — NULL = predates versioning.
  rev:          integer('rev'),
}, (t) => ({
  workspaceIdx: index('idx_edges_workspace').on(t.workspaceId),
  sourceIdx:    index('idx_edges_source').on(t.sourceNodeId),
  targetIdx:    index('idx_edges_target').on(t.targetNodeId),
}));

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------
export const messages = sqliteTable('messages', {
  id:        text('id').primaryKey(),
  nodeId:    text('node_id').notNull().references(() => nodes.id),
  role:      text('role').notNull(),
  content:   text('content').notNull().default(''),
  blocks:    text('blocks'),
  toolCalls: text('tool_calls'),
  metadata:  text('metadata'),
  seq:       integer('seq').notNull(),
  createdAt: integer('created_at').notNull(),
  // rev: per-row sync version (sync L2). Nullable — NULL = predates versioning.
  rev:       integer('rev'),
}, (t) => ({
  nodeIdx: index('idx_messages_node').on(t.nodeId),
}));

// ---------------------------------------------------------------------------
// turns
// ---------------------------------------------------------------------------
export const turns = sqliteTable('turns', {
  turnId:             text('turn_id').primaryKey(),
  nodeId:             text('node_id').notNull().references(() => nodes.id),
  userMessageId:      text('user_message_id'),
  assistantMessageId: text('assistant_message_id').notNull(),
  status:             text('status').notNull(),
  lastSeq:            integer('last_seq').notNull().default(-1),
  stopReason:         text('stop_reason'),
  error:              text('error'),
  startedAt:          integer('started_at').notNull(),
  checkpointAt:       integer('checkpoint_at'),
  completedAt:        integer('completed_at'),
  updatedAt:          integer('updated_at').notNull(),
}, (t) => ({
  nodeIdx: index('idx_turns_node').on(t.nodeId),
  assistantMessageUq: uniqueIndex('idx_turns_assistant_message').on(t.assistantMessageId),
}));

export const commandReceipts = sqliteTable('command_receipts', {
  workspaceId: text('workspace_id').notNull(),
  operationId: text('operation_id').notNull(),
  payloadHash: text('payload_hash').notNull(),
  resultJson:  text('result_json').notNull(),
  createdAt:   integer('created_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.workspaceId, t.operationId] }),
  createdIdx: index('idx_command_receipts_created').on(t.createdAt),
}));

// NOTE: messages_fts (FTS5 virtual table) exists in the database but is NOT
// modeled here. Drizzle-orm does not support FTS5 virtual tables directly.
// The table is created by 0000_baseline.sql and maintained via SQL triggers.
// Use raw db.prepare() when querying messages_fts.

// ---------------------------------------------------------------------------
// contexts
// ---------------------------------------------------------------------------
export const contexts = sqliteTable('contexts', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  name:        text('name').notNull(),
  // '' for link artifacts (which carry `url`). NOT NULL retained from baseline.
  filePath:    text('file_path').notNull(),
  size:        integer('size'),
  // Retired UI flag; column kept for back-compat, always written 0.
  autoInject:  integer('auto_inject').notNull().default(0),
  source:      text('source').notNull().default('user'),
  // Artifact fields (migration 0008). All nullable so legacy rows migrate cleanly.
  type:            text('type'),
  url:             text('url'),
  originNodeId:    text('origin_node_id'),
  originMessageId: text('origin_message_id'),
  kind:            text('kind'),
  pinnedAt:        integer('pinned_at'),
  createdAt:   integer('created_at').notNull(),
  updatedAt:   integer('updated_at').notNull(),
  // rev: per-row sync version (sync L2). Nullable — NULL = predates versioning.
  rev:         integer('rev'),
}, (t) => ({
  workspaceIdx:    index('idx_contexts_workspace').on(t.workspaceId),
  workspaceNameUq: uniqueIndex('contexts_workspace_name_uq').on(t.workspaceId, t.name),
}));

// ---------------------------------------------------------------------------
// workspace_permission_grants
// ---------------------------------------------------------------------------
export const workspacePermissionGrants = sqliteTable('workspace_permission_grants', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  toolName:    text('tool_name').notNull(),
  grantedAt:   integer('granted_at').notNull(),
}, (t) => ({
  pk:           primaryKey({ columns: [t.workspaceId, t.toolName] }),
  workspaceIdx: index('idx_grants_workspace').on(t.workspaceId),
}));

// ---------------------------------------------------------------------------
// user_agent_configs
// ---------------------------------------------------------------------------
export const userAgentConfigs = sqliteTable('user_agent_configs', {
  userId:              text('user_id').primaryKey(),
  runtime:             text('runtime').notNull(),
  provider:            text('provider').notNull(),
  modelByRuntime:      text('model_by_runtime').notNull().default('{}'),
  reasoningByRuntime:  text('reasoning_by_runtime').notNull().default('{}'),
  updatedAt:           integer('updated_at').notNull(),
});

// ---------------------------------------------------------------------------
// user_provider_keys
// ---------------------------------------------------------------------------
export const userProviderKeys = sqliteTable('user_provider_keys', {
  userId:    text('user_id').notNull(),
  provider:  text('provider').notNull(),
  ciphertext: blob('ciphertext').notNull(),
  iv:        blob('iv').notNull(),
  tag:       blob('tag').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({
  pk:      primaryKey({ columns: [t.userId, t.provider] }),
  userIdx: index('idx_user_provider_keys_user').on(t.userId),
}));

// ---------------------------------------------------------------------------
// Custom Agent Runs
// JSON columns hold versioned contract payloads; repositories validate their
// full shape while the migration enforces valid JSON and required versions.
// ---------------------------------------------------------------------------
export const agentRuns = sqliteTable('agent_runs', {
  id:                   text('id').primaryKey(),
  ownerUserId:          text('owner_user_id').notNull(),
  workspaceId:          text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  definitionId:         text('definition_id').references(() => agentDefinitions.id, { onDelete: 'set null' }),
  definitionRevision:   integer('definition_revision'),
  effectiveDefinition:  text('effective_definition').notNull(),
  invocationMode:       text('invocation_mode').notNull(),
  completionMode:       text('completion_mode').notNull(),
  parentRunId:          text('parent_run_id'), // self-reference is enforced by SQL migration
  parentAttemptId:      text('parent_attempt_id'), // references agent_run_attempts in SQL migration
  parentNodeId:         text('parent_node_id').references(() => nodes.id, { onDelete: 'set null' }),
  parentTurnId:         text('parent_turn_id').references(() => turns.turnId, { onDelete: 'set null' }),
  parentMessageId:      text('parent_message_id').references(() => messages.id, { onDelete: 'set null' }),
  parentToolCallId:     text('parent_tool_call_id'),
  task:                 text('task').notNull(),
  taskSearchText:       text('task_search_text').notNull().default(''),
  agentNameSnapshot:    text('agent_name_snapshot').notNull().default(''),
  handoffSearchText:    text('handoff_search_text').notNull().default(''),
  contextManifest:      text('context_manifest').notNull(),
  expectedResult:       text('expected_result'),
  executionEnvironment: text('execution_environment').notNull(),
  status:               text('status').notNull().default('queued'),
  waitingReason:        text('waiting_reason'),
  activeAttemptId:      text('active_attempt_id'),
  resultBundle:         text('result_bundle'),
  latestEventSeq:       integer('latest_event_seq').notNull().default(-1),
  nextAttemptIndex:     integer('next_attempt_index').notNull().default(0),
  leaseToken:           text('lease_token'),
  leaseOwner:           text('lease_owner'),
  leaseExpiresAt:       integer('lease_expires_at'),
  heartbeatAt:          integer('heartbeat_at'),
  checkpointAt:         integer('checkpoint_at'),
  createdAt:            integer('created_at').notNull(),
  updatedAt:            integer('updated_at').notNull(),
  startedAt:            integer('started_at'),
  completedAt:          integer('completed_at'),
  archivedAt:           integer('archived_at'),
  expiresAt:            integer('expires_at'),
}, (t) => ({
  ownerIdx:             index('idx_agent_runs_owner').on(t.ownerUserId),
  workspaceIdx:         index('idx_agent_runs_workspace').on(t.workspaceId),
  ownerWorkspaceStatusIdx: index('idx_agent_runs_owner_workspace_status').on(t.ownerUserId, t.workspaceId, t.status),
  statusLeaseIdx:       index('idx_agent_runs_status_lease').on(t.status, t.leaseExpiresAt),
  leaseTokenUq:         uniqueIndex('idx_agent_runs_lease_token').on(t.leaseToken).where(sql`${t.leaseToken} IS NOT NULL`),
  parentRunIdx:         index('idx_agent_runs_parent_run').on(t.parentRunId),
  parentAttemptIdx:     index('idx_agent_runs_parent_attempt').on(t.parentAttemptId),
  parentNodeIdx:        index('idx_agent_runs_parent_node').on(t.parentNodeId),
  definitionIdx:        index('idx_agent_runs_definition').on(t.definitionId),
  expiresIdx:           index('idx_agent_runs_expires').on(t.expiresAt),
  taskSearchIdx:        index('idx_agent_runs_task_search').on(t.taskSearchText),
  agentNameSearchIdx:   index('idx_agent_runs_agent_name_search').on(t.agentNameSnapshot),
  handoffSearchIdx:     index('idx_agent_runs_handoff_search').on(t.handoffSearchText),
  definitionRevisionCheck: check('agent_runs_definition_revision_check', sql`${t.definitionRevision} IS NULL OR ${t.definitionRevision} > 0`),
  invocationModeCheck: check('agent_runs_invocation_mode_check', sql`${t.invocationMode} IN ('delegated', 'manual')`),
  completionModeCheck: check('agent_runs_completion_mode_check', sql`${t.completionMode} IN ('wait', 'notify', 'wake', 'detach')`),
  statusCheck: check('agent_runs_status_check', sql`${t.status} IN ('queued', 'preparing', 'running', 'waiting', 'recovering', 'completed', 'failed', 'cancelled')`),
  waitingReasonCheck: check('agent_runs_waiting_reason_check', sql`${t.waitingReason} IS NULL OR ${t.waitingReason} IN ('permission', 'context', 'user_input', 'parent_input')`),
  latestEventSeqCheck: check('agent_runs_latest_event_seq_check', sql`${t.latestEventSeq} >= -1`),
  nextAttemptIndexCheck: check('agent_runs_next_attempt_index_check', sql`${t.nextAttemptIndex} >= 0`),
  leaseCheck: check('agent_runs_lease_check', sql`
    (${t.leaseToken} IS NULL AND ${t.leaseOwner} IS NULL AND ${t.leaseExpiresAt} IS NULL) OR
    (${t.leaseToken} IS NOT NULL AND ${t.leaseOwner} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)
  `),
  terminalTimestampCheck: check('agent_runs_terminal_timestamp_check', sql`
    (${t.status} IN ('completed', 'failed', 'cancelled') AND ${t.completedAt} IS NOT NULL) OR
    (${t.status} NOT IN ('completed', 'failed', 'cancelled') AND ${t.completedAt} IS NULL)
  `),
  effectiveDefinitionJsonCheck: check('agent_runs_effective_definition_json_check', sql`json_valid(${t.effectiveDefinition}) AND json_extract(${t.effectiveDefinition}, '$.version') IS NOT NULL`),
  contextManifestJsonCheck: check('agent_runs_context_manifest_json_check', sql`json_valid(${t.contextManifest}) AND json_extract(${t.contextManifest}, '$.version') IS NOT NULL`),
  expectedResultJsonCheck: check('agent_runs_expected_result_json_check', sql`${t.expectedResult} IS NULL OR (json_valid(${t.expectedResult}) AND json_extract(${t.expectedResult}, '$.version') IS NOT NULL)`),
  executionEnvironmentJsonCheck: check('agent_runs_execution_environment_json_check', sql`json_valid(${t.executionEnvironment}) AND json_extract(${t.executionEnvironment}, '$.version') IS NOT NULL`),
  resultBundleJsonCheck: check('agent_runs_result_bundle_json_check', sql`${t.resultBundle} IS NULL OR (json_valid(${t.resultBundle}) AND json_extract(${t.resultBundle}, '$.version') IS NOT NULL)`),
}));

export const agentRunAttempts = sqliteTable('agent_run_attempts', {
  id:                text('id').primaryKey(),
  runId:             text('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  attemptIndex:      integer('attempt_index').notNull(),
  profileIndex:      integer('profile_index').notNull(),
  runtimeProfile:    text('runtime_profile').notNull(),
  status:            text('status').notNull(),
  publicSessionId:   text('public_session_id').notNull(),
  nativeResumeToken: text('native_resume_token'),
  recoveryEnvelope:  text('recovery_envelope'),
  startedAt:         integer('started_at').notNull(),
  checkpointAt:      integer('checkpoint_at'),
  completedAt:       integer('completed_at'),
  error:             text('error'),
}, (t) => ({
  runAttemptUq:      uniqueIndex('agent_run_attempts_run_attempt_uq').on(t.runId, t.attemptIndex),
  publicSessionUq:   uniqueIndex('agent_run_attempts_public_session_uq').on(t.publicSessionId),
  runStatusIdx:      index('idx_agent_run_attempts_run_status').on(t.runId, t.status),
  attemptIndexCheck: check('agent_run_attempts_attempt_index_check', sql`${t.attemptIndex} >= 0`),
  profileIndexCheck: check('agent_run_attempts_profile_index_check', sql`${t.profileIndex} >= 0`),
  statusCheck:       check('agent_run_attempts_status_check', sql`${t.status} IN ('preparing', 'running', 'waiting', 'completed', 'failed', 'cancelled')`),
  terminalTimestampCheck: check('agent_run_attempts_terminal_timestamp_check', sql`
    (${t.status} IN ('completed', 'failed', 'cancelled') AND ${t.completedAt} IS NOT NULL) OR
    (${t.status} NOT IN ('completed', 'failed', 'cancelled') AND ${t.completedAt} IS NULL)
  `),
  runtimeProfileJsonCheck: check('agent_run_attempts_runtime_profile_json_check', sql`json_valid(${t.runtimeProfile}) AND json_extract(${t.runtimeProfile}, '$.version') IS NOT NULL`),
  nativeResumeTokenJsonCheck: check('agent_run_attempts_native_resume_token_json_check', sql`${t.nativeResumeToken} IS NULL OR json_valid(${t.nativeResumeToken})`),
  recoveryEnvelopeJsonCheck: check('agent_run_attempts_recovery_envelope_json_check', sql`${t.recoveryEnvelope} IS NULL OR (json_valid(${t.recoveryEnvelope}) AND json_extract(${t.recoveryEnvelope}, '$.version') IS NOT NULL)`),
  errorJsonCheck: check('agent_run_attempts_error_json_check', sql`${t.error} IS NULL OR (json_valid(${t.error}) AND json_extract(${t.error}, '$.version') IS NOT NULL)`),
}));

export const agentRunEvents = sqliteTable('agent_run_events', {
  runId:     text('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  seq:       integer('seq').notNull(),
  attemptId: text('attempt_id').references(() => agentRunAttempts.id, { onDelete: 'set null' }),
  type:      text('type').notNull(),
  payload:   text('payload').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  pk:          primaryKey({ columns: [t.runId, t.seq] }),
  attemptIdx:  index('idx_agent_run_events_attempt').on(t.attemptId),
  createdIdx:  index('idx_agent_run_events_created').on(t.runId, t.createdAt),
  seqCheck:    check('agent_run_events_seq_check', sql`${t.seq} >= 0`),
  payloadJsonCheck: check('agent_run_events_payload_json_check', sql`json_valid(${t.payload})`),
}));

export const agentRunInteractions = sqliteTable('agent_run_interactions', {
  id:              text('id').primaryKey(),
  runId:           text('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  attemptId:       text('attempt_id').references(() => agentRunAttempts.id, { onDelete: 'set null' }),
  type:            text('type').notNull(),
  status:          text('status').notNull().default('pending'),
  requestPayload:  text('request_payload').notNull(),
  responsePayload: text('response_payload'),
  createdAt:       integer('created_at').notNull(),
  resolvedAt:      integer('resolved_at'),
}, (t) => ({
  runStatusIdx:   index('idx_agent_run_interactions_run_status').on(t.runId, t.status),
  attemptIdx:     index('idx_agent_run_interactions_attempt').on(t.attemptId),
  typeCheck:      check('agent_run_interactions_type_check', sql`${t.type} IN ('permission', 'context', 'user_input', 'parent_input')`),
  statusCheck:    check('agent_run_interactions_status_check', sql`${t.status} IN ('pending', 'resolved', 'rejected', 'cancelled')`),
  resolutionCheck: check('agent_run_interactions_resolution_check', sql`
    (${t.status} = 'pending' AND ${t.resolvedAt} IS NULL) OR
    (${t.status} != 'pending' AND ${t.resolvedAt} IS NOT NULL)
  `),
  requestPayloadJsonCheck: check('agent_run_interactions_request_payload_json_check', sql`json_valid(${t.requestPayload}) AND json_extract(${t.requestPayload}, '$.version') IS NOT NULL`),
  responsePayloadJsonCheck: check('agent_run_interactions_response_payload_json_check', sql`${t.responsePayload} IS NULL OR (json_valid(${t.responsePayload}) AND json_extract(${t.responsePayload}, '$.version') IS NOT NULL)`),
}));

export const agentRunWatches = sqliteTable('agent_run_watches', {
  id:                 text('id').primaryKey(),
  ownerUserId:        text('owner_user_id').notNull(),
  workspaceId:        text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  parentRunId:        text('parent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  parentNodeId:       text('parent_node_id').references(() => nodes.id, { onDelete: 'set null' }),
  parentTurnId:       text('parent_turn_id').references(() => turns.turnId, { onDelete: 'set null' }),
  condition:          text('condition').notNull(),
  completionBehavior: text('completion_behavior').notNull(),
  status:             text('status').notNull().default('active'),
  deliveryId:         text('delivery_id'),
  requestedTurnId:    text('requested_turn_id'),
  deliveryStatus:     text('delivery_status'),
  createdAt:          integer('created_at').notNull(),
  updatedAt:          integer('updated_at').notNull(),
  firedAt:            integer('fired_at'),
  deliveredAt:        integer('delivered_at'),
}, (t) => ({
  ownerIdx:          index('idx_agent_run_watches_owner').on(t.ownerUserId),
  workspaceStatusIdx: index('idx_agent_run_watches_workspace_status').on(t.workspaceId, t.status),
  parentRunIdx:      index('idx_agent_run_watches_parent_run').on(t.parentRunId),
  deliveryUq:        uniqueIndex('idx_agent_run_watches_delivery').on(t.deliveryId).where(sql`${t.deliveryId} IS NOT NULL`),
  completionBehaviorCheck: check('agent_run_watches_completion_behavior_check', sql`${t.completionBehavior} IN ('wait', 'notify', 'wake', 'detach')`),
  statusCheck:       check('agent_run_watches_status_check', sql`${t.status} IN ('active', 'fired', 'cancelled', 'expired')`),
  deliveryStatusCheck: check('agent_run_watches_delivery_status_check', sql`${t.deliveryStatus} IS NULL OR ${t.deliveryStatus} IN ('pending', 'delivered', 'undeliverable')`),
  firedTimestampCheck: check('agent_run_watches_fired_timestamp_check', sql`
    (${t.status} = 'fired' AND ${t.firedAt} IS NOT NULL) OR
    (${t.status} != 'fired' AND ${t.firedAt} IS NULL)
  `),
  conditionJsonCheck: check('agent_run_watches_condition_json_check', sql`json_valid(${t.condition}) AND json_extract(${t.condition}, '$.version') IS NOT NULL`),
  deliveryIdentityCheck: check('agent_run_watches_delivery_identity_check', sql`
    (${t.deliveryId} IS NULL AND ${t.requestedTurnId} IS NULL AND ${t.deliveryStatus} IS NULL) OR
    (${t.deliveryId} IS NOT NULL AND ${t.requestedTurnId} IS NOT NULL AND ${t.deliveryStatus} IS NOT NULL)
  `),
}));

export const agentRunWatchMembers = sqliteTable('agent_run_watch_members', {
  watchId:     text('watch_id').notNull().references(() => agentRunWatches.id, { onDelete: 'cascade' }),
  runId:       text('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  addedAt:     integer('added_at').notNull(),
  satisfiedAt: integer('satisfied_at'),
}, (t) => ({
  pk:     primaryKey({ columns: [t.watchId, t.runId] }),
  runIdx: index('idx_agent_run_watch_members_run').on(t.runId),
}));
