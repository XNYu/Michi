/**
 * `start_conversation`: the Meta agent's chat window opens an ordinary
 * conversation in one of the user's workspaces and sends its first message.
 * The conversation runs on the user's global runtime settings, exactly as one
 * the user started; the Meta agent's own settings never reach it, and the
 * Meta agent does not do the work itself. The user approves every start.
 */

import { randomUUID } from 'node:crypto';
import {
  THREAD_MESSAGE_MAX_CHARS,
  isSystemWorkspaceSettings,
  type ProgressCardDto,
} from 'michi-shared';
import type { AgentReasoning, AgentSession } from '../../agents/types';
import type { StartedRequestedSelfTurn } from '../../agents/chatHub';
import { getModelReasoningOptions } from '../../agents/modelReasoning';
import { getRuntime } from '../../agents/registry';
import { threadMessagingDeps, type ThreadMessageApprover, type ThreadMessagingDeps } from '../../agents/threadMessageTool';
import { isAssistantWorkspace } from '../../assistant/identity';
import { getAgentConfig, resolveModel, resolveProvider, resolveReasoning } from '../agentConfig';
import { LOCAL_AGENT_OWNER_ID, workspaceOwnerMatches } from '../agentOwner';
import { getDb, runInTransaction } from '../db';
import { getWorkspace, type WorkspaceRow } from '../dbRepository';
import { ensureDurableGraphNode } from '../graphCommands';
import { log } from '../logger';
import { getPage } from '../pages/repository';
import { createProgressCard } from '../pages/progressCards';

export const START_CONVERSATION_TITLE_MAX_CHARS = 80;

/** The Meta agent chat's session-bound identity. Never from tool arguments. */
export interface StartConversationCaller {
  ownerUserId: string | null;
  workspaceId: string | null;
  nodeId: string | null;
}

export interface StartConversationArgs {
  workspaceId?: unknown;
  text?: unknown;
  title?: unknown;
  pageId?: unknown;
}

export interface StartConversationResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}

/** What the chat window's conversation card shows. */
export interface MichiConversationStart {
  kind: 'michiConversationStart';
  nodeId: string;
  treeId: string;
  workspaceId: string;
  workspaceName: string;
  title: string;
  runtimeId: string;
  modelId: string | null;
  startedFromPageId: string | null;
}

class StartConversationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function errorResult(code: string, message: string): StartConversationResult {
  return { content: [{ type: 'text', text: `${code}: ${message}` }], isError: true };
}

function jsonResult(value: Record<string, unknown>): StartConversationResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clipTitle(value: string): string {
  const glyphs = Array.from(oneLine(value));
  return glyphs.length <= START_CONVERSATION_TITLE_MAX_CHARS ? glyphs.join('')
    : `${glyphs.slice(0, START_CONVERSATION_TITLE_MAX_CHARS - 1).join('').trimEnd()}…`;
}

function parseArgs(args: StartConversationArgs): { workspaceId: string; text: string; title: string; pageId: string | null } {
  const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : '';
  if (!workspaceId || workspaceId.length > 160) throw new StartConversationError('INVALID_ARGUMENT', 'workspaceId is required; get one from list_workspaces');
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!text) throw new StartConversationError('INVALID_ARGUMENT', 'text is required');
  if (text.length > THREAD_MESSAGE_MAX_CHARS) throw new StartConversationError('INVALID_ARGUMENT', `text exceeds ${THREAD_MESSAGE_MAX_CHARS} characters`);
  if (args.title !== undefined && typeof args.title !== 'string') throw new StartConversationError('INVALID_ARGUMENT', 'title must be a string');
  const title = clipTitle(typeof args.title === 'string' && args.title.trim() ? args.title : text.split('\n').find((line) => line.trim()) ?? text);
  if (args.pageId !== undefined && (typeof args.pageId !== 'string' || !args.pageId || args.pageId.length > 200)) {
    throw new StartConversationError('INVALID_ARGUMENT', 'pageId must be a page id');
  }
  return { workspaceId, text, title, pageId: typeof args.pageId === 'string' ? args.pageId : null };
}

function callerOwner(caller: StartConversationCaller): string {
  if (!caller.nodeId || !isAssistantWorkspace(caller.workspaceId)) {
    throw new StartConversationError('UNSUPPORTED', 'start_conversation is only available in the Meta agent chat');
  }
  const ownerUserId = caller.ownerUserId ?? (process.env.MICHI_CLOUD === '1' ? null : LOCAL_AGENT_OWNER_ID);
  if (!ownerUserId) throw new StartConversationError('UNSUPPORTED', 'start_conversation needs a signed-in owner');
  return ownerUserId;
}

/** One of the owner's own workspaces that takes new conversations: not deleted, archived or a system one. */
function targetWorkspace(ownerUserId: string, workspaceId: string): WorkspaceRow {
  const workspace = getWorkspace(workspaceId, ownerUserId);
  if (!workspace || workspace.deleted_at != null || isSystemWorkspaceSettings(workspace.settings)
    || !workspaceOwnerMatches(workspace.owner_user_id ?? null, ownerUserId)) {
    throw new StartConversationError('NOT_FOUND', `workspace not found: ${workspaceId}. Get ids from list_workspaces.`);
  }
  if (workspace.archived_at != null) {
    throw new StartConversationError('READ_ONLY', `${workspace.name} is archived; ask the user to restore it first`);
  }
  return workspace;
}

function checkPage(ownerUserId: string, pageId: string | null): void {
  if (!pageId) return;
  try {
    getPage(pageId, ownerUserId);
  } catch {
    throw new StartConversationError('INVALID_ARGUMENT', `page not found: ${pageId}`);
  }
}

/** The user's global runtime profile, as a conversation they started now would get it. */
async function globalProfile(ownerUserId: string) {
  const userId = process.env.MICHI_CLOUD === '1' ? ownerUserId : undefined;
  const runtimeId = getAgentConfig(userId).runtime;
  const runtime = getRuntime(runtimeId);
  if (!runtime) throw new StartConversationError('UNAVAILABLE', `the ${runtimeId} runtime is not available`);
  const providerId = runtime.capabilities.providerModels ? resolveProvider(runtimeId, userId) || null : null;
  const requestedModel = resolveModel(runtimeId, userId) || null;
  const requestedReasoning = (resolveReasoning(runtimeId, userId) ?? null) as AgentReasoning | null;
  const effort = await getModelReasoningOptions(runtime, requestedModel, providerId, requestedReasoning);
  return { runtimeId, providerId, modelId: effort.modelId ?? requestedModel, reasoning: effort.value ?? null };
}

/** Removes a conversation whose session never opened. */
function rollback(nodeId: string, workspaceId: string, treeId: string): void {
  try {
    runInTransaction(() => {
      const row = getDb().prepare(`
        SELECT n.acp_session_id, (SELECT COUNT(*) FROM messages m WHERE m.node_id = n.id) AS message_count
          FROM nodes n WHERE n.id = ? AND n.workspace_id = ? AND n.tree_id = ?
      `).get(nodeId, workspaceId, treeId) as { acp_session_id: string | null; message_count: number } | undefined;
      if (!row || row.acp_session_id || row.message_count > 0) return;
      getDb().prepare('DELETE FROM trees WHERE id = ? AND workspace_id = ? AND root_node_id = ?').run(treeId, workspaceId, nodeId);
    });
  } catch {
    // An empty thread left behind is harmless; the tool still reports the failure.
  }
}

type StartOutcome = { kind: 'started' } | { kind: 'queued' } | { kind: 'failed'; error: unknown };

function waitForStart(start: Promise<StartedRequestedSelfTurn>, waitMs: number): Promise<StartOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'queued' }), waitMs);
    timer.unref?.();
    start.then(
      () => { clearTimeout(timer); resolve({ kind: 'started' }); },
      (error) => { clearTimeout(timer); resolve({ kind: 'failed', error }); },
    );
  });
}

function errorOf(error: unknown): StartConversationResult {
  if (error instanceof StartConversationError) return errorResult(error.code, error.message);
  throw error;
}

export async function startConversationTool(
  caller: StartConversationCaller,
  args: StartConversationArgs,
  approve: ThreadMessageApprover,
  deps: ThreadMessagingDeps | null = threadMessagingDeps(),
): Promise<StartConversationResult> {
  let request: ReturnType<typeof parseArgs>;
  let ownerUserId: string;
  let workspace: WorkspaceRow;
  try {
    request = parseArgs(args);
    ownerUserId = callerOwner(caller);
    workspace = targetWorkspace(ownerUserId, request.workspaceId);
    checkPage(ownerUserId, request.pageId);
  } catch (error) {
    return errorOf(error);
  }
  if (!deps) return errorResult('UNAVAILABLE', 'starting conversations is not configured on this backend');

  const nodeId = `n-${randomUUID()}`;
  const approval = await approve({
    targetNodeId: nodeId,
    targetTitle: `New conversation · ${request.title}`,
    text: request.text,
    targetWorkspaceName: oneLine(workspace.name) || 'Untitled',
    exact: true,
  });
  if (!approval.approved) {
    if (approval.reason === 'unavailable') {
      return errorResult('APPROVAL_UNAVAILABLE', 'this runtime cannot ask the user for approval; no conversation was started');
    }
    return jsonResult({
      status: 'declined',
      ...(approval.note ? { userNote: approval.note } : {}),
      next: approval.reason === 'no_answer'
        ? 'The user did not answer; nothing was started. Do not retry unless the user asks.'
        : 'The user declined; nothing was started. Do not retry unless the user asks.',
    });
  }

  // The approval may have waited minutes: check the workspace and page again.
  let profile: Awaited<ReturnType<typeof globalProfile>>;
  try {
    workspace = targetWorkspace(ownerUserId, request.workspaceId);
    checkPage(ownerUserId, request.pageId);
    profile = await globalProfile(ownerUserId);
  } catch (error) {
    return errorOf(error);
  }

  const now = Date.now();
  const treeId = `t-${now}-${randomUUID().slice(0, 8)}`;
  ensureDurableGraphNode({
    workspace: {
      id: workspace.id, name: workspace.name, cwd: workspace.cwd ?? null,
      createdAt: workspace.created_at, activeTreeId: workspace.active_tree_id ?? null,
    },
    tree: { id: treeId, rootNodeId: nodeId, name: null, lastActiveAt: now, createdAt: now },
    node: { id: nodeId, treeId, parentNodeId: null, kind: 'chat', title: request.title, createdAt: now },
    edges: [],
    ownerUserId: workspace.owner_user_id ?? null,
  });
  // ensure-session opens a new conversation with the profile stored on its node.
  getDb().prepare('UPDATE nodes SET runtime_id = ?, provider_id = ?, model_id = ?, reasoning = ? WHERE id = ? AND acp_session_id IS NULL')
    .run(profile.runtimeId, profile.providerId, profile.modelId, profile.reasoning, nodeId);

  let session: AgentSession | null;
  try {
    session = await deps.ensureSession({ ownerUserId, workspaceId: workspace.id, nodeId });
  } catch (error) {
    rollback(nodeId, workspace.id, treeId);
    return errorResult('UNAVAILABLE', error instanceof Error ? error.message : String(error));
  }
  if (!session) {
    rollback(nodeId, workspace.id, treeId);
    return errorResult('UNAVAILABLE', 'could not open a session for the new conversation');
  }

  const turnId = deps.newTurnId();
  let start: Promise<StartedRequestedSelfTurn>;
  const release = await deps.acquireRestoreLock(nodeId);
  try {
    start = deps.startTurn({
      chatId: session.id, nodeId, ownerUserId, turnId, text: request.text, displayText: request.text, session,
    });
  } finally {
    release();
  }
  start.then((started) => { void started.done.catch(() => {}); }, (error) => {
    log.warn('chat', 'Meta agent conversation failed to begin', { nodeId, turnId, error: error instanceof Error ? error.message : String(error) });
  });
  const outcome = await waitForStart(start, deps.startWaitMs);
  if (outcome.kind === 'failed') {
    return errorResult('UNAVAILABLE', outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
  }

  let progressCard: ProgressCardDto | null = null;
  if (request.pageId) {
    try {
      progressCard = createProgressCard({ ownerUserId, threadNodeId: nodeId, startedFromPageId: request.pageId });
    } catch (error) {
      log.warn('chat', 'Meta agent conversation has no progress card', { nodeId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const conversation: MichiConversationStart = {
    kind: 'michiConversationStart',
    nodeId, treeId, workspaceId: workspace.id, workspaceName: workspace.name, title: request.title,
    runtimeId: session.runtimeId, modelId: profile.modelId, startedFromPageId: progressCard ? request.pageId : null,
  };
  return jsonResult({
    status: outcome.kind,
    conversation,
    ...(progressCard ? { progressCard } : {}),
    next: `The conversation runs on its own. Tell the user it started and link it as [${request.title.replace(/[[\]]/g, '')}](michi://node/${nodeId}); `
      + 'they follow it from its progress card or the conversation page. Do not do its work yourself or message it.',
  });
}
