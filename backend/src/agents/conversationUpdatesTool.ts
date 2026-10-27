import { isSystemWorkspaceSettings, type ConversationUpdates } from 'michi-shared';
import { readConversationUpdates } from '../services/conversationUpdates';
import { getWorkspace } from '../services/dbRepository';
import { workspaceIdKindHint } from '../services/idKindHint';
import { buildPaneInspectionCaller, type PaneInspectionToolBinding } from './paneInspectionTools';

export interface ConversationUpdatesToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  details?: ConversationUpdates;
  isError?: true;
}

function failure(code: string, message: string): ConversationUpdatesToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message }) }] };
}

/** Both Pi and MCP use session-derived identity and the same read service. */
export function readConversationUpdatesTool(binding: PaneInspectionToolBinding, args: unknown): ConversationUpdatesToolResult {
  try {
    const result = readConversationUpdates(buildPaneInspectionCaller(binding), args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
  } catch (error) {
    return failure((error as { code?: string }).code ?? 'internal_error', error instanceof Error ? error.message : 'Read failed');
  }
}

/**
 * The Meta agent's chat window reads any of its owner's workspaces, named by
 * `workspaceId`; the read then runs exactly as a chat in that workspace would
 * (its cursor, its "Let AI navigate this workspace" setting). System
 * workspaces, the assistant's own included, are never readable.
 */
export function readMetaAgentConversationUpdatesTool(binding: PaneInspectionToolBinding, args: unknown): ConversationUpdatesToolResult {
  const raw = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const { workspaceId, ...input } = raw;
  if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 160) {
    return failure('invalid_argument', 'workspaceId is required; get one from list_workspaces');
  }
  const workspace = getWorkspace(workspaceId.trim(), binding.ownerUserId ?? undefined);
  if (!workspace || workspace.deleted_at != null || isSystemWorkspaceSettings(workspace.settings)) {
    return failure('not_found', `Workspace not found.${workspaceIdKindHint(workspaceId)} Get workspace ids from list_workspaces.`);
  }
  return readConversationUpdatesTool({ ...binding, workspaceId: workspace.id, assistant: false, runOwnerRunId: null }, input);
}
