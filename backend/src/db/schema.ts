import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey, blob } from 'drizzle-orm/sqlite-core';

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
  createdAt:          integer('created_at').notNull(),
  // rev: per-row sync version (sync L2). Nullable — NULL = predates versioning.
  rev:                integer('rev'),
}, (t) => ({
  workspaceIdx: index('idx_nodes_workspace').on(t.workspaceId),
  treeIdx:      index('idx_nodes_tree').on(t.treeId),
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
  filePath:    text('file_path').notNull(),
  size:        integer('size'),
  autoInject:  integer('auto_inject').notNull().default(0),
  source:      text('source').notNull().default('user'),
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
