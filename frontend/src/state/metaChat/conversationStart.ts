import type { ToolCallState } from '../chatTypes';
import { normalizeToolResultEnvelope, normalizeTurnToolName } from '../../lib/turnPageReceipt';

/** The conversation `start_conversation` opened, as its result names it. */
export interface StartedConversation {
  nodeId: string;
  treeId: string;
  workspaceId: string;
  workspaceName: string;
  title: string;
  runtimeId: string;
  modelId: string | null;
  startedFromPageId: string | null;
}

export interface ConversationStartCard {
  status: 'started' | 'queued' | 'declined';
  /** Absent when declined. */
  conversation: StartedConversation | null;
}

const str = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function conversationOf(value: unknown): StartedConversation | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (c.kind !== 'michiConversationStart' || !str(c.nodeId) || !str(c.workspaceId) || !str(c.title) || !str(c.runtimeId)) return null;
  return {
    nodeId: c.nodeId, treeId: str(c.treeId) ? c.treeId : '', workspaceId: c.workspaceId,
    workspaceName: str(c.workspaceName) ? c.workspaceName : '', title: c.title, runtimeId: c.runtimeId,
    modelId: str(c.modelId) ? c.modelId : null, startedFromPageId: str(c.startedFromPageId) ? c.startedFromPageId : null,
  };
}

/** The card for a completed `start_conversation` call, or null for any other tool or a failed start. */
export function parseConversationStart(tool: Pick<ToolCallState, 'title' | 'status' | 'output'>): ConversationStartCard | null {
  if (tool.status !== 'completed' || !normalizeTurnToolName(tool.title, ['start_conversation'])) return null;
  for (const value of normalizeToolResultEnvelope(tool.output)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (row.status === 'declined') return { status: 'declined', conversation: null };
    if (row.status !== 'started' && row.status !== 'queued') continue;
    const conversation = conversationOf(row.conversation);
    if (conversation) return { status: row.status, conversation };
  }
  return null;
}
