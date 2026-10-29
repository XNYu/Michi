/**
 * The Michi assistant's home: one hidden system workspace (`settings.system
 * = 'assistant'`) whose current conversation is a single chat node.
 *
 * Provisioning is synchronous end to end (SQLite and mkdir), so concurrent
 * requests in this process cannot interleave and create a second workspace
 * or node. The workspace row holds the current node id of each purpose (the
 * Spaces window, and the Scheduled window's "Create with agent"):
 *
 *   { "system": "assistant", "assistant": { "nodeId": "n-…", "scheduleNodeId": "n-…" } }
 *
 * A Scheduled conversation is recorded as one in `meta` when it is created
 * (assistantPurposeOf); history, activation and Pages Home only know Spaces
 * conversations.
 *
 * The runtime is the global runtime settings, read whenever a session is
 * bound, until the user picks a runtime, model or reasoning in a
 * conversation's composer: from then on that conversation keeps its pick
 * (`meta`, one key per conversation). Workspaces from before the Meta agent
 * record may still carry runtimeId/modelId/reasoning here; that record's
 * first read folds them in once.
 *
 * Only this module writes these keys, with its own UPDATE: every other
 * workspace write keeps the stored ones (mergeServerOwnedSettings), so no
 * client can mark, unmark or retarget the assistant's workspace.
 * Every node in that workspace runs as the assistant (identity.ts, binding.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_WORKSPACE_SYSTEM,
  isAssistantWorkspaceSettings,
  isReasoningLevel,
  type MetaAgentResolvedRuntime,
  type MichiAssistantInfo,
  type MichiAssistantSettings,
  type MichiAssistantConversations,
  type MichiAssistantRuntimeSwitch,
  type MichiAssistantSettingsPatch,
  type RuntimeReasoning,
} from 'michi-shared';
import { getRuntime, listRuntimes } from '../agents/registry';
import { getProviderInfo } from '../agents/pi/piProviders';
import { getAgentConfig, resolveModel, resolveProvider, resolveReasoning } from '../services/agentConfig';
import { getMichiDataDir } from '../services/dataDir';
import { getDb, runInTransaction } from '../services/db';
import { getNode, getWorkspace, listWorkspaces, saveWorkspace, type NodeRow, type WorkspaceRow } from '../services/dbRepository';
import { ensureDurableGraphNode } from '../services/graphCommands';
import { getMetaAgentSettings } from '../services/metaAgent/settings';
import { ASSISTANT_RUNTIMES, isAssistantRuntime, type AssistantPurpose } from './policy';
import { assistantPurposeKey, assistantPurposeOf } from './identity';

export type { AssistantPurpose } from './policy';

export const ASSISTANT_WORKSPACE_NAME = 'Michi assistant';
export const ASSISTANT_CONVERSATION_TITLE = 'Assistant';

export class AssistantSettingsError extends Error {}

/**
 * A model id as runtimes spell them (claude-sonnet-4-5, provider/model, Bedrock
 * ARNs, names[1m]). It reaches CLI argv, so it never starts with `-`.
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]+-]{0,199}$/;

interface StoredAssistant {
  /** The Spaces window's current conversation. */
  nodeId?: unknown;
  /** The Scheduled window's current conversation. */
  scheduleNodeId?: unknown;
}

/** Where each purpose keeps its current conversation in the workspace's `assistant` settings. */
const POINTER: Record<AssistantPurpose, keyof StoredAssistant> = { spaces: 'nodeId', schedule: 'scheduleNodeId' };

function parseObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function storedOf(workspace: WorkspaceRow): StoredAssistant {
  const value = parseObject(workspace.settings).assistant;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as StoredAssistant : {};
}

export { assistantPurposeOf, isAssistantNode, isAssistantWorkspace } from './identity';

// ── Runtimes and settings ───────────────────────────────────────────────────

/**
 * Registered runtimes the assistant policy lists, in preference order. The
 * settings accept any registered runtime; whether one can host the assistant
 * is decided when its session starts.
 */
export function assistantSupportedRuntimes(): string[] {
  return ASSISTANT_RUNTIMES.filter((id) => !!getRuntime(id));
}

/**
 * Runtime (global), or, when that runtime cannot host the assistant (Crew),
 * the first one that can.
 */
function globalAssistantRuntimeId(): string {
  const configured = getAgentConfig().runtime;
  if (isAssistantRuntime(configured) && getRuntime(configured)) return configured;
  return assistantSupportedRuntimes()[0] ?? configured;
}

/** The global settings for `runtimeId`, each field as a new conversation there would use it. */
function globalSettingsFor(runtimeId: string): Required<MichiAssistantSettings> {
  const usesProviders = getRuntime(runtimeId)?.capabilities.providerModels === true;
  return {
    runtimeId,
    providerId: usesProviders ? resolveProvider(runtimeId) || null : null,
    modelId: resolveModel(runtimeId) || null,
    reasoning: (resolveReasoning(runtimeId) as RuntimeReasoning | undefined) ?? null,
  };
}

/** A provider's model: the global one for the global provider, else that provider's own default. */
function providerModel(runtimeId: string, providerId: string | null): string | null {
  if (!providerId) return null;
  if (providerId === (resolveProvider(runtimeId) || null)) return resolveModel(runtimeId) || null;
  return getProviderInfo(providerId)?.defaultModel || null;
}

const choiceKey = (nodeId: string) => `assistant_conversation_runtime:${nodeId}`;

/** What the user picked in one conversation's composer; null while it follows the global settings. */
function readConversationChoice(nodeId: string): Required<MichiAssistantSettings> | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(choiceKey(nodeId)) as { value: string } | undefined;
  if (!row) return null;
  let stored: unknown;
  try { stored = JSON.parse(row.value); } catch { return null; }
  if (!stored || typeof stored !== 'object') return null;
  const { runtimeId, providerId, modelId, reasoning } = stored as Record<string, unknown>;
  if (typeof runtimeId !== 'string' || !getRuntime(runtimeId)) return null;
  const id = (value: unknown) => (typeof value === 'string' && MODEL_ID.test(value) ? value : null);
  return { runtimeId, providerId: id(providerId), modelId: id(modelId), reasoning: isReasoningLevel(reasoning) ? reasoning : null };
}

/**
 * The workspace's settings with one purpose's pointer moved. The other
 * purpose's pointer is kept; nothing else is (older keys such as the
 * runtime fields the Meta agent record took over are dropped).
 */
function settingsJson(workspace: WorkspaceRow | null, pointer: Partial<Record<keyof StoredAssistant, string>>): Record<string, unknown> {
  const current = workspace ? parseObject(workspace.settings) : {};
  const stored = workspace ? storedOf(workspace) : {};
  const kept = Object.fromEntries(Object.values(POINTER)
    .filter((key) => typeof stored[key] === 'string')
    .map((key) => [key, stored[key]]));
  return { ...current, system: ASSISTANT_WORKSPACE_SYSTEM, assistant: { ...kept, ...pointer } };
}

function writeSettings(workspaceId: string, settings: Record<string, unknown>): void {
  getDb().prepare('UPDATE workspaces SET settings = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(settings), Date.now(), workspaceId);
}

// ── Provisioning ────────────────────────────────────────────────────────────

/** Private working directory; retain its existing path so bound sessions can resume. */
export function assistantCwdFor(dataDir: string): string {
  const dir = path.join(path.resolve(dataDir), 'assistant');
  return dir.split(path.sep).includes('.michi') ? dir : path.join(dir, '.michi');
}

/** The assistant's working directory: empty, private, per Michi data directory, never a project. */
export function assistantCwd(): string {
  const dataDir = getMichiDataDir();
  const dir = assistantCwdFor(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // `<data>/assistant` and the leaf inside it; the data directory keeps its own mode.
  for (const each of new Set([path.join(path.resolve(dataDir), 'assistant'), dir])) {
    try { fs.chmodSync(each, 0o700); } catch { /* best effort on filesystems without modes */ }
  }
  return dir;
}

/** The newest live assistant workspace. */
export function findAssistantWorkspace(): WorkspaceRow | null {
  const candidates = listWorkspaces()
    .filter((ws) => ws.deleted_at == null && isAssistantWorkspaceSettings(ws.settings))
    .sort((a, b) => b.created_at - a.created_at);
  return candidates[0] ?? null;
}

function treeArchived(treeId: string | null | undefined): boolean {
  if (!treeId) return true;
  const row = getDb().prepare('SELECT archived_at FROM trees WHERE id = ?').get(treeId) as { archived_at: number | null } | undefined;
  return !row || row.archived_at != null;
}

function usableConversation(node: NodeRow | null, workspaceId: string): node is NodeRow {
  return !!node
    && node.workspace_id === workspaceId
    && node.kind === 'chat'
    && node.deleted_at == null
    && node.status !== 'archived'
    && !treeArchived(node.tree_id);
}

function newConversation(workspace: WorkspaceRow | null, cwd: string, purpose: AssistantPurpose = 'spaces'): { workspace: WorkspaceRow; node: NodeRow } {
  const now = Date.now();
  const workspaceId = workspace?.id ?? `p-assistant-${randomUUID()}`;
  const treeId = `t-${randomUUID()}`;
  const nodeId = `n-${randomUUID()}`;
  // Recorded before the node exists, so the node never binds without it.
  if (purpose !== 'spaces') {
    getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(assistantPurposeKey(nodeId), purpose);
  }
  if (!workspace) {
    // Workspace writes never carry the server-owned marker (saveWorkspace),
    // so it goes on here, before the conversation exists: an interrupted
    // provisioning leaves an assistant workspace the next call completes,
    // never an ordinary workspace in the user's list.
    runInTransaction(() => {
      saveWorkspace({ id: workspaceId, name: ASSISTANT_WORKSPACE_NAME, cwd, created_at: now, updated_at: now, settings: null });
      writeSettings(workspaceId, { system: ASSISTANT_WORKSPACE_SYSTEM, assistant: { nodeId: null } });
    });
  }
  const result = ensureDurableGraphNode({
    // settings omitted: the stored blob, marker included, is kept.
    workspace: {
      id: workspaceId,
      name: workspace?.name ?? ASSISTANT_WORKSPACE_NAME,
      cwd: workspace?.cwd ?? cwd,
      createdAt: workspace?.created_at ?? now,
      // The workspace's active tree stays the Spaces conversation's.
      activeTreeId: purpose === 'spaces' ? treeId : getWorkspace(workspaceId)?.active_tree_id ?? null,
    },
    tree: { id: treeId, rootNodeId: nodeId, name: ASSISTANT_CONVERSATION_TITLE, lastActiveAt: now, createdAt: now },
    node: { id: nodeId, treeId, kind: 'chat', title: ASSISTANT_CONVERSATION_TITLE, createdAt: now },
    edges: [],
    ownerUserId: null,
  });
  writeSettings(workspaceId, settingsJson(getWorkspace(workspaceId), { [POINTER[purpose]]: nodeId }));
  return { workspace: getWorkspace(workspaceId) ?? result.workspace, node: result.node };
}

/**
 * What an assistant conversation's next message runs on: what the user picked
 * in it, else the global settings resolved now (`followsGlobal`). A
 * conversation is not pinned to the runtime it ran on; when this names
 * another runtime than its bound session, the session paths open a new native
 * session there and pass the visible history as prior context
 * (assistant_runtime_switches records where that happened).
 */
export function assistantConversationRuntime(nodeId?: string | null): MetaAgentResolvedRuntime {
  const choice = nodeId ? readConversationChoice(nodeId) : null;
  return choice
    ? { ...choice, followsGlobal: false }
    : { ...globalSettingsFor(globalAssistantRuntimeId()), followsGlobal: true };
}

/** Where the conversation moved to another runtime; a switch undone before the next message is not shown. */
function runtimeSwitchesOf(nodeId: string): MichiAssistantRuntimeSwitch[] {
  const rows = getDb().prepare(`
    SELECT s.after_message_id, s.previous_runtime_id, s.runtime_id, s.switched_at
      FROM assistant_runtime_switches s
      JOIN messages m ON m.id = s.after_message_id AND m.node_id = s.node_id
     WHERE s.node_id = ?
     ORDER BY m.seq, s.id
  `).all(nodeId) as Array<{ after_message_id: string; previous_runtime_id: string; runtime_id: string; switched_at: number }>;
  const byAnchor = new Map<string, MichiAssistantRuntimeSwitch>();
  for (const row of rows) {
    const earlier = byAnchor.get(row.after_message_id);
    byAnchor.set(row.after_message_id, {
      afterMessageId: row.after_message_id,
      previousRuntimeId: earlier?.previousRuntimeId ?? row.previous_runtime_id,
      runtimeId: row.runtime_id,
      switchedAt: row.switched_at,
    });
  }
  return [...byAnchor.values()].filter((change) => change.runtimeId !== change.previousRuntimeId);
}

function info(workspace: WorkspaceRow, node: NodeRow, supported: string[]): MichiAssistantInfo {
  const { followsGlobal: _global, ...global } = assistantConversationRuntime();
  const { followsGlobal, ...runs } = assistantConversationRuntime(node.id);
  return {
    nodeId: node.id,
    workspaceId: workspace.id,
    treeId: node.tree_id as string,
    settings: global,
    conversation: runs,
    conversationFollowsGlobal: followsGlobal,
    supportedRuntimes: supported,
    runtimeSwitches: runtimeSwitchesOf(node.id),
  };
}

/** The current conversation's node id, without creating anything; null before the assistant first exists. */
export function currentAssistantNodeId(): string | null {
  const workspace = findAssistantWorkspace();
  const stored = workspace ? storedOf(workspace) : {};
  const node = workspace && typeof stored.nodeId === 'string' ? getNode(stored.nodeId) : null;
  return workspace && usableConversation(node, workspace.id) ? node.id : null;
}

/** One purpose's current conversation, creating the workspace and conversation on first use. Idempotent. */
function ensureConversation(purpose: AssistantPurpose): MichiAssistantInfo {
  // Its native sessions are recorded as they are bound (db/migrations/0032_assistant_sessions.sql).
  // The settings are read before this rewrites the workspace's stored keys: the first read folds them in.
  getMetaAgentSettings();
  const supported = assistantSupportedRuntimes();
  const cwd = assistantCwd();
  const workspace = findAssistantWorkspace();
  const stored = workspace ? storedOf(workspace)[POINTER[purpose]] : undefined;
  const current = workspace && typeof stored === 'string' ? getNode(stored) : null;
  if (workspace && usableConversation(current, workspace.id) && assistantPurposeOf(current.id) === purpose) {
    return info(workspace, current, supported);
  }
  const created = newConversation(workspace, cwd, purpose);
  return info(created.workspace, created.node, supported);
}

/** Returns the assistant (the Spaces window's conversation), creating its workspace and conversation on first use. Idempotent. */
export function ensureAssistant(): MichiAssistantInfo {
  return ensureConversation('spaces');
}

/**
 * One purpose's current conversation. The Scheduled window's lives in the
 * same hidden workspace as the Spaces one and is never shown there. Idempotent.
 */
export function ensureAssistantFor(purpose: AssistantPurpose): MichiAssistantInfo {
  return ensureConversation(purpose);
}

function patchId(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !MODEL_ID.test(value.trim())) {
    throw new AssistantSettingsError(`${field} must be an id (letters, digits and . _ : / @ [ ] + -, starting with a letter or digit) or null`);
  }
  return value.trim();
}

/**
 * What the user picked in a conversation's composer (the current one unless
 * `nodeId` names another of the assistant's conversations). From then on that
 * conversation keeps all of runtime, provider, model and reasoning as they
 * resolve now with the patch applied; a new conversation follows the global
 * settings again. A patch naming a runtime (the composer's runtime pick)
 * starts from the global settings for that runtime, except for the non-null
 * fields it names, whatever the conversation ran on; without one, null is the
 * runtime's own default. Another provider without a model named starts on
 * its own model.
 */
export function updateAssistantSettings(patch: MichiAssistantSettingsPatch): MichiAssistantInfo {
  if (patch.runtimeId !== undefined && (typeof patch.runtimeId !== 'string' || !getRuntime(patch.runtimeId))) {
    const registered = listRuntimes().map((runtime) => runtime.id);
    throw new AssistantSettingsError(`runtimeId must be one of: ${registered.join(', ') || '(none available)'}`);
  }
  const providerId = patch.providerId === undefined ? undefined : patchId(patch.providerId, 'providerId');
  const modelId = patch.modelId === undefined ? undefined : patchId(patch.modelId, 'modelId');
  if (patch.reasoning !== undefined && patch.reasoning !== null && !isReasoningLevel(patch.reasoning)) {
    throw new AssistantSettingsError('reasoning must be minimal, low, medium, high, xhigh, max or null');
  }
  // The answer is the conversation's own window: the Spaces assistant, or the Scheduled one.
  const purpose = assistantPurposeOf(patch.nodeId);
  const current = ensureConversation(purpose);
  const nodeId = patch.nodeId ?? current.nodeId;
  const node = getNode(nodeId);
  if (!node || node.workspace_id !== current.workspaceId || node.kind !== 'chat' || node.deleted_at != null) {
    throw new AssistantSettingsError('Assistant conversation not found');
  }
  if (patch.runtimeId === undefined && providerId === undefined && modelId === undefined && patch.reasoning === undefined) return current;
  // The composer's chips can trail the global settings, so a runtime pick
  // never depends on what the conversation resolves to now.
  const runtimePicked = patch.runtimeId !== undefined;
  const { followsGlobal: _global, ...now } = assistantConversationRuntime(nodeId);
  const base = runtimePicked ? globalSettingsFor(patch.runtimeId as string) : now;
  const next: Required<MichiAssistantSettings> = {
    runtimeId: base.runtimeId,
    providerId: base.providerId,
    modelId: base.modelId,
    reasoning: base.reasoning,
  };
  const usesProviders = getRuntime(next.runtimeId)?.capabilities.providerModels === true;
  if (providerId !== undefined && (!runtimePicked || providerId !== null)) next.providerId = usesProviders ? providerId : null;
  if (modelId !== undefined && (!runtimePicked || modelId !== null)) next.modelId = modelId;
  if (next.providerId !== base.providerId && !modelId) next.modelId = providerModel(next.runtimeId, next.providerId);
  if (patch.reasoning !== undefined && (!runtimePicked || patch.reasoning !== null)) next.reasoning = patch.reasoning;
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(choiceKey(nodeId), JSON.stringify(next));
  return ensureConversation(purpose);
}

/**
 * Archives one purpose's current conversation and starts a fresh one with the
 * current settings; the other purpose's conversation is untouched.
 */
export function resetAssistant(purpose: AssistantPurpose = 'spaces'): { info: MichiAssistantInfo; previousNodeId: string } {
  const current = ensureConversation(purpose);
  const now = Date.now();
  getDb().prepare('UPDATE trees SET archived_at = ?, last_active_at = ? WHERE id = ? AND archived_at IS NULL')
    .run(now, now, current.treeId);
  const workspace = getWorkspace(current.workspaceId);
  const created = newConversation(workspace, assistantCwd(), purpose);
  return {
    info: info(created.workspace, created.node, current.supportedRuntimes),
    previousNodeId: current.nodeId,
  };
}

/**
 * The Spaces window's history. Includes conversations archived by New
 * conversation, but never deleted nodes, another workspace or the Scheduled
 * window's conversations.
 */
export function listAssistantConversations(limit = 5, cursor?: string): MichiAssistantConversations {
  const workspace = findAssistantWorkspace();
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AssistantSettingsError('limit must be between 1 and 50');
  let before: { updatedAt: number; nodeId: string } | null = null;
  if (cursor) {
    try {
      before = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (!before || !Number.isSafeInteger(before.updatedAt) || typeof before.nodeId !== 'string' || before.nodeId.length > 160) throw new Error();
    } catch { throw new AssistantSettingsError('Invalid conversation cursor'); }
  }
  if (!workspace) return { items: [], nextCursor: null };
  const rows = getDb().prepare(`
    WITH history AS (
      SELECT n.id AS nodeId,
        COALESCE(NULLIF(n.title, 'Assistant'),
          (SELECT substr(m.content, 1, 160) FROM messages m WHERE m.node_id = n.id AND m.role = 'user' ORDER BY m.seq LIMIT 1),
          n.title, 'Assistant') AS title,
        COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.node_id = n.id), n.created_at) AS updatedAt
      FROM nodes n JOIN trees t ON t.id = n.tree_id AND t.workspace_id = n.workspace_id AND t.root_node_id = n.id
      WHERE n.workspace_id = ? AND n.kind = 'chat' AND n.deleted_at IS NULL AND n.purged_at IS NULL
        AND EXISTS (SELECT 1 FROM messages m WHERE m.node_id = n.id)
        AND NOT EXISTS (SELECT 1 FROM meta p WHERE p.key = 'assistant:purpose:' || n.id AND p.value <> 'spaces')
    )
    SELECT * FROM history WHERE (? IS NULL OR updatedAt < ? OR (updatedAt = ? AND nodeId < ?))
    ORDER BY updatedAt DESC, nodeId DESC LIMIT ?
  `).all(workspace.id, before?.updatedAt ?? null, before?.updatedAt ?? null, before?.updatedAt ?? null, before?.nodeId ?? null, limit + 1) as Array<{ nodeId: string; title: string; updatedAt: number }>;
  const items = rows.slice(0, limit).map(row => ({ ...row, title: row.title.replace(/\s+/g, ' ').trim().slice(0, 100) || 'Assistant' }));
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, nodeId: last.nodeId })).toString('base64url') : null };
}

/** Resume a saved assistant conversation without cloning or losing its transcript. */
export function activateAssistantConversation(nodeId: string): MichiAssistantInfo {
  const workspace = findAssistantWorkspace();
  const node = getNode(nodeId);
  if (!workspace || !node || node.workspace_id !== workspace.id || node.kind !== 'chat' || node.deleted_at != null || node.purged_at != null || !node.tree_id
    || assistantPurposeOf(node.id) !== 'spaces') {
    throw new AssistantSettingsError('Assistant conversation not found');
  }
  const tree = getDb().prepare('SELECT root_node_id FROM trees WHERE id = ? AND workspace_id = ?').get(node.tree_id, workspace.id) as { root_node_id: string } | undefined;
  if (tree?.root_node_id !== node.id) throw new AssistantSettingsError('Assistant conversation not found');
  const treeId = node.tree_id;
  const current = currentAssistantNodeId();
  if (current === nodeId) return ensureAssistant();
  runInTransaction(() => {
    const now = Date.now();
    const previous = current ? getNode(current) : null;
    if (previous?.tree_id) getDb().prepare('UPDATE trees SET archived_at = ? WHERE id = ?').run(now, previous.tree_id);
    getDb().prepare('UPDATE trees SET archived_at = NULL, last_active_at = ? WHERE id = ?').run(now, treeId);
    getDb().prepare("UPDATE nodes SET status = 'idle' WHERE id = ? AND status = 'archived'").run(node.id);
    getDb().prepare('UPDATE workspaces SET active_tree_id = ? WHERE id = ?').run(treeId, workspace.id);
    writeSettings(workspace.id, settingsJson(workspace, { nodeId }));
  });
  return ensureAssistant();
}
