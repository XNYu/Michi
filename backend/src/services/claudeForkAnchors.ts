import { getDb } from './db';
import { LOCAL_AGENT_OWNER_ID, workspaceOwnerMatches } from './agentOwner';

export interface SaveClaudeForkAnchorInput {
  nodeId: string;
  nativeSessionId: string;
  assistantMessageId: string;
  nativeMessageId: string;
  userMessageId?: string;
  /** The UUID supplied on the SDK's original user envelope, never a tool result. */
  nativeUserMessageId?: string;
}

/** Save only identities owned by the current server-side node binding. A user
 * cut ends at the prompt itself; aliasing it to the assistant would copy the
 * very answer the user cut away. Missing user UUIDs therefore stay unmapped. */
export function saveClaudeForkAnchor(input: SaveClaudeForkAnchorInput): void {
  if (!input.nativeMessageId || !input.assistantMessageId) return;
  const insert = getDb().prepare(`INSERT OR REPLACE INTO claude_fork_anchors
    (node_id, native_session_id, message_id, message_role, native_message_id)
    SELECT n.id, ?, m.id, m.role, ? FROM nodes n JOIN messages m ON m.node_id = n.id
    WHERE n.id = ? AND n.kind = 'chat' AND n.runtime_id = 'claude'
      AND COALESCE(n.external_session_id, n.acp_session_id) = ?
      AND n.deleted_at IS NULL AND n.purged_at IS NULL AND m.id = ? AND m.role = ?`);
  insert.run(input.nativeSessionId, input.nativeMessageId, input.nodeId,
    input.nativeSessionId, input.assistantMessageId, 'assistant');
  if (input.userMessageId && input.nativeUserMessageId) {
    insert.run(input.nativeSessionId, input.nativeUserMessageId, input.nodeId,
      input.nativeSessionId, input.userMessageId, 'user');
  }
}

export function readClaudeForkAnchor(input: {
  nodeId: string;
  nativeSessionId: string;
  messageId: string;
  workspaceId?: string | null;
  ownerUserId?: string | null;
}): string | null {
  const row = getDb().prepare(`SELECT a.native_message_id, n.workspace_id, w.owner_user_id
    FROM claude_fork_anchors a JOIN nodes n ON n.id = a.node_id
    JOIN workspaces w ON w.id = n.workspace_id
    JOIN messages m ON m.node_id = n.id AND m.id = a.message_id AND m.role = a.message_role
    WHERE a.node_id = ? AND a.native_session_id = ? AND a.message_id = ?
      AND n.kind = 'chat' AND n.runtime_id = 'claude'
      AND COALESCE(n.external_session_id, n.acp_session_id) = a.native_session_id
      AND n.deleted_at IS NULL AND n.purged_at IS NULL
      AND w.deleted_at IS NULL AND w.archived_at IS NULL`).get(
    input.nodeId, input.nativeSessionId, input.messageId,
  ) as { native_message_id: string; workspace_id: string; owner_user_id: string | null } | undefined;
  if (!row || (input.workspaceId != null && row.workspace_id !== input.workspaceId)
    || !workspaceOwnerMatches(row.owner_user_id, input.ownerUserId ?? LOCAL_AGENT_OWNER_ID)) return null;
  return row.native_message_id;
}
