import type { AgentRuntime, AgentSession, NewAgentSessionOptions } from '../agents/types';
import { chatHub } from '../agents/chatHub';
import { getSessionForOwner } from '../agents/sessionRegistry';
import { getNode, getWorkspace, listMessages } from './dbRepository';
import { LOCAL_AGENT_OWNER_ID, workspaceOwnerMatches } from './agentOwner';
import { nativeResumeId, NativeResumeUnavailableError } from './nativeResume';
import { normalizeWorkspaceCwd } from '../agents/tools/pathSandbox';
import { isNativeForkEnabled } from './agentConfig';

/** Only new, ordinary chat children may inherit a native parent. Persisted graph
 * ownership, not a client-supplied native token, determines the fork source. */
export async function tryForkChatSession(
  runtime: AgentRuntime,
  opts: NewAgentSessionOptions,
): Promise<AgentSession | null> {
  if (!runtime.forkSession || !isNativeForkEnabled(runtime.id, opts.ownerUserId)
    || !opts.sessionId || opts.owner?.kind === 'agent_run'
    || opts.profileHash || opts.replayHistory?.length) return null;
  const child = getNode(opts.sessionId);
  if (!child?.parent_node_id || child.acp_session_id || child.external_session_id
    || child.deleted_at || child.purged_at || child.kind !== 'chat'
    || child.workspace_id !== opts.workspaceId) return null;
  // The renderer may have persisted the first pending user message already.
  const childMessages = listMessages(child.id);
  if (childMessages.filter((message) => message.role === 'user').length > 1
    || childMessages.some((message) => message.role === 'assistant' && message.content.trim())) return null;
  const parent = getNode(child.parent_node_id);
  if (!parent || parent.id === child.id || parent.runtime_id !== runtime.id
    || parent.workspace_id !== child.workspace_id || parent.tree_id !== child.tree_id
    || parent.kind !== 'chat' || parent.deleted_at || parent.purged_at
    || ('agent_effective_definition' in parent && parent.agent_effective_definition)
    || ('agent_effective_definition' in child && child.agent_effective_definition)) return null;
  const workspace = getWorkspace(child.workspace_id);
  if (!workspace || workspace.deleted_at || workspace.archived_at
    || !workspaceOwnerMatches(workspace.owner_user_id ?? null, opts.ownerUserId ?? LOCAL_AGENT_OWNER_ID)
    || normalizeWorkspaceCwd(workspace.cwd ?? process.cwd()) !== normalizeWorkspaceCwd(opts.cwd)) return null;
  const nativeId = nativeResumeId(runtime.id, parent);
  if (!nativeId || nativeId === parent.id || parent.status === 'streaming' || chatHub.isActive(parent.id)) return null;
  const live = getSessionForOwner(parent.id, { kind: 'chat_node', nodeId: parent.id }, opts.ownerUserId ?? null);
  if (live?.getPendingAssistant() !== undefined) return null;
  // A never-sent session has no stored history for the runtime to fork.
  const parentMessages = listMessages(parent.id);
  if (!parentMessages.some((message) => message.role === 'assistant')) return null;
  // A branch cut before the parent's tail must not silently inherit later
  // turns. Ask the runtime for an anchored fork; runtimes that can only fork
  // their latest state reject it and the caller falls back to the exact text
  // prefix. A tail cut is equivalent to a latest-state fork.
  const boundaryMessageId = opts.branchContext?.boundaryMessageId;
  // An empty prefix with a non-empty parent is a real cut (the branch was
  // created before the parent had any messages); a latest-state fork would
  // wrongly inherit everything, so decline and use the text path.
  if (opts.branchContext && boundaryMessageId === undefined && parentMessages.length > 0) return null;
  const anchorMessageId = boundaryMessageId !== undefined
    && parentMessages.at(-1)?.id !== boundaryMessageId
    ? boundaryMessageId
    : undefined;
  try {
    const session = await runtime.forkSession({
      ...opts,
      parentChatId: parent.id,
      sourceNativeSessionId: nativeId,
      ...(anchorMessageId === undefined ? {} : { anchorMessageId }),
    });
    if (session.id !== child.id || !session.nativeSessionId || session.nativeSessionId === nativeId) {
      if (session.id === child.id) await runtime.releaseSession(session.id);
      throw new Error('Native fork did not create an independent child session');
    }
    return session;
  } catch (error) {
    if (error instanceof NativeResumeUnavailableError) return null;
    throw error;
  }
}
