import { getDb } from '../db';
import { workspaceOwnerMatches } from '../agentOwner';
import { PageWriteError } from './core';

/** Longest message text a source preview carries. */
export const SOURCE_TEXT_MAX = 1_200;

export interface HomeSourceMessage {
  id: string;
  role: string;
  text: string;
  truncated: boolean;
  turnId: string | null;
  at: number;
}

/** A conversation message a page or Home item points at, as the source popover and the jump read it. */
export interface HomeSourceDto {
  nodeId: string;
  workspaceId: string;
  workspaceName: string;
  title: string;
  runtimeId: string | null;
  /** `archived`: its workspace or thread is archived. `deleted`: it or its workspace is in the trash. */
  state: 'live' | 'archived' | 'deleted';
  /** Null when the message cannot be found in the native conversation. */
  message: HomeSourceMessage | null;
}

export interface HomeSourceQuery {
  ownerUserId: string;
  /** A native Michi conversation node ID. */
  nodeId?: string;
  /** A Michi message ID or a native runtime anchor recorded for that node. */
  messageId?: string;
}

type NodeRow = {
  id: string; workspace_id: string; title: string | null; runtime_id: string | null; deleted_at: number | null;
  tree_archived_at: number | null; workspace_name: string; owner_user_id: string | null; settings: string | null;
  workspace_deleted_at: number | null; workspace_archived_at: number | null;
};

const NODE_SQL = `SELECT n.id,n.workspace_id,n.title,n.runtime_id,n.deleted_at,t.archived_at AS tree_archived_at,
    w.name AS workspace_name,w.owner_user_id,w.settings,w.deleted_at AS workspace_deleted_at,w.archived_at AS workspace_archived_at
  FROM nodes n JOIN workspaces w ON w.id=n.workspace_id LEFT JOIN trees t ON t.id=n.tree_id
  WHERE n.purged_at IS NULL AND w.purged_at IS NULL`;

function nodeById(nodeId: string, ownerUserId: string): NodeRow | null {
  const row = getDb().prepare(`${NODE_SQL} AND n.id=?`).get(nodeId) as unknown as NodeRow | undefined;
  return row && workspaceOwnerMatches(row.owner_user_id, ownerUserId) ? row : null;
}

type MessageRow = { id: string; role: string; content: string; created_at: number };

function messageFor(nodeId: string, messageId: string): MessageRow | null {
  const db = getDb();
  const select = 'SELECT id,role,content,created_at FROM messages WHERE node_id=? AND id=?';
  const direct = db.prepare(select).get(nodeId, messageId) as unknown as MessageRow | undefined;
  if (direct) return direct;
  // Runtime message ids Michi recorded for its own messages (Claude and Kiro fork anchors).
  const anchored = (db.prepare(`SELECT message_id AS id FROM claude_fork_anchors WHERE node_id=? AND native_message_id=?
      UNION ALL SELECT assistant_message_id AS id FROM kiro_fork_anchors WHERE node_id=? AND native_message_id=? LIMIT 1`)
    .get(nodeId, messageId, nodeId, messageId) as { id: string } | undefined)?.id;
  return anchored ? db.prepare(select).get(nodeId, anchored) as unknown as MessageRow | undefined ?? null : null;
}

function turnFor(nodeId: string, messageId: string): string | null {
  return (getDb().prepare('SELECT turn_id FROM turns WHERE node_id=? AND assistant_message_id=? ORDER BY started_at DESC LIMIT 1')
    .get(nodeId, messageId) as { turn_id: string } | undefined)?.turn_id ?? null;
}

export function homeSource(query: HomeSourceQuery): HomeSourceDto {
  if (!query.nodeId) throw new PageWriteError(400, 'invalid', 'Give nodeId');
  const node = nodeById(query.nodeId, query.ownerUserId);
  if (!node) throw new PageWriteError(404, 'not_found', 'Conversation not found');
  const row = query.messageId ? messageFor(node.id, query.messageId) : null;
  const text = row ? row.content.trim() : '';
  return {
    nodeId: node.id,
    workspaceId: node.workspace_id,
    workspaceName: node.workspace_name,
    title: node.title ?? '',
    runtimeId: node.runtime_id,
    state: node.deleted_at !== null || node.workspace_deleted_at !== null ? 'deleted'
      : node.workspace_archived_at !== null || node.tree_archived_at !== null ? 'archived' : 'live',
    message: row ? {
      id: row.id, role: row.role,
      text: text.length > SOURCE_TEXT_MAX ? `${text.slice(0, SOURCE_TEXT_MAX - 1)}…` : text,
      truncated: text.length > SOURCE_TEXT_MAX,
      turnId: turnFor(node.id, row.id),
      at: row.created_at,
    } : null,
  };
}
