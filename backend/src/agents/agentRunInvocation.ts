import { createHash } from 'node:crypto';
import type { ParentInvocationAnchorV1 } from 'michi-shared';
import type { AgentRunToolSessionBinding } from 'michi-runtime/internal/contract/tools';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import { hostOwner } from './ownerMapping';

export type AgentRunCaller =
  | {
      kind: 'conversation';
      ownerUserId: string;
      workspaceId: string;
      parentNodeId: string;
      runtimeSessionId?: string | null;
    }
  | {
      kind: 'agent_run';
      ownerUserId: string;
      workspaceId: string;
      parentRunId: string;
      parentAttemptId: string;
    };

/**
 * Who a runtime session's Agent tools act for: the Run Attempt its owner
 * stands for, or its conversation (the bound node, else the owner's). Null
 * without a Workspace. Throws, like hostOwner, for a headless owner that
 * names no Run.
 */
export function agentRunToolsBindingFor(binding: AgentRunToolSessionBinding): AgentRunCaller | null {
  if (!binding.workspaceId) return null;
  const ownerUserId = binding.ownerUserId ?? LOCAL_AGENT_OWNER_ID;
  const owner = hostOwner(binding.owner);
  if (owner.kind === 'agent_run') {
    return {
      kind: 'agent_run',
      ownerUserId,
      workspaceId: binding.workspaceId,
      parentRunId: owner.runId,
      parentAttemptId: owner.attemptId,
    };
  }
  return {
    kind: 'conversation',
    ownerUserId,
    workspaceId: binding.workspaceId,
    parentNodeId: binding.nodeId ?? owner.nodeId,
    runtimeSessionId: binding.sessionId,
  };
}

export interface ActiveTurnAnchor {
  turnId: string;
  messageId: string;
  toolCallId: string | null;
}

/** T16 binds this port to ChatHub/ChatManager. T13 deliberately keeps the
 * runtime-session-to-durable-message lookup outside the generic tool bridge. */
export interface ActiveTurnResolver {
  resolve(input: {
    ownerUserId: string;
    workspaceId: string;
    parentNodeId: string;
    runtimeSessionId: string | null;
    runtimeToolCallId: string | null;
  }): Promise<ActiveTurnAnchor | null> | ActiveTurnAnchor | null;
}

export interface ResolvedAgentRunInvocation {
  anchor: ParentInvocationAnchorV1;
  parentAttemptId: string | null;
  operationId(seed: unknown): string;
}

export async function resolveAgentRunInvocation(
  caller: AgentRunCaller,
  resolver: ActiveTurnResolver,
  runtimeToolCallId: string | null,
): Promise<ResolvedAgentRunInvocation> {
  if (caller.kind === 'agent_run') {
    const anchor: ParentInvocationAnchorV1 = {
      parentRunId: caller.parentRunId,
      parentAttemptId: caller.parentAttemptId,
      parentNodeId: null,
      parentTurnId: null,
      parentMessageId: null,
      parentToolCallId: runtimeToolCallId,
    };
    return invocation(anchor, caller.parentAttemptId);
  }

  const active = await resolver.resolve({
    ownerUserId: caller.ownerUserId,
    workspaceId: caller.workspaceId,
    parentNodeId: caller.parentNodeId,
    runtimeSessionId: caller.runtimeSessionId ?? null,
    runtimeToolCallId,
  });
  if (!active?.turnId || !active.messageId) {
    throw new Error('active Parent turn is not durably anchored');
  }
  const anchor: ParentInvocationAnchorV1 = {
    parentRunId: null,
    parentAttemptId: null,
    parentNodeId: caller.parentNodeId,
    parentTurnId: active.turnId,
    parentMessageId: active.messageId,
    parentToolCallId: runtimeToolCallId ?? active.toolCallId,
  };
  return invocation(anchor, null);
}

function invocation(anchor: ParentInvocationAnchorV1, parentAttemptId: string | null): ResolvedAgentRunInvocation {
  return {
    anchor,
    parentAttemptId,
    operationId(seed: unknown): string {
      // A runtime tool-call id distinguishes sibling calls in one assistant
      // message. Runtimes without one still get a deterministic retry key tied
      // to the durable message/Run anchor and normalized tool payload.
      const digest = createHash('sha256').update(JSON.stringify({
        anchor,
        parentAttemptId,
        seed,
      })).digest('hex').slice(0, 32);
      return `agent-tool-${digest}`;
    },
  };
}
