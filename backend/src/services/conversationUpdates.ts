import {
  CONVERSATION_UPDATES_LIMITS,
  ConversationUpdatesError,
  PaneInspectionError,
  parseReadConversationUpdatesInput,
  type ConversationUpdate,
  type ConversationUpdateMessage,
  type ConversationUpdates,
} from 'michi-shared';
import { getDb, runInTransaction } from './db';
import { getWorkspace } from './dbRepository';
import { assertPaneInspectionCaller, type PaneInspectionCaller } from './paneInspection';

export function conversationCompletionCounter(workspaceId: string): number {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?')
    .get(`conversation_completion_seq:${workspaceId}`) as { value: string } | undefined;
  const value = row ? Number(row.value) : 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new ConversationUpdatesError('cursor_invalid', 'Invalid workspace counter');
  return value;
}

// Archive has two representations: a status, or the trim engine's arch-* deletion group.
// Both, Trash, purged nodes and archived trees are excluded. Keep stats/list on this predicate.
const READABLE = `FROM turns t JOIN nodes n ON n.id = t.node_id
  JOIN workspaces w ON w.id = n.workspace_id LEFT JOIN trees tr ON tr.id = n.tree_id
  WHERE n.workspace_id = ? AND w.deleted_at IS NULL AND w.purged_at IS NULL
    AND (? = 0 OR w.owner_user_id = ?) AND n.kind = 'chat' AND n.purged_at IS NULL
    AND n.deleted_at IS NULL AND n.status <> 'archived' AND tr.archived_at IS NULL
    AND t.status = 'completed' AND t.user_message_id IS NOT NULL
    AND t.completion_seq > ? AND t.completion_seq <= ?`;

interface UpdateRow {
  completion_seq: number; turn_id: string; node_id: string; tree_id: string | null;
  user_message_id: string; assistant_message_id: string; completed_at: number; preview: string;
}

interface TextRow { id: string; role: string; content: string; metadata: string | null; seq: number }

function turnMessages(turn: ConversationUpdate): ConversationUpdateMessage[] | 'large' | 'missing' {
  const db = getDb();
  const bounds = db.prepare(`SELECT u.seq AS first, a.seq AS last FROM messages u JOIN messages a ON a.node_id = u.node_id
    WHERE u.id = ? AND a.id = ? AND u.node_id = ? AND u.role = 'user' AND a.role = 'assistant'`)
    .get(turn.userMessageId, turn.assistantMessageId, turn.nodeId) as { first: number; last: number } | undefined;
  if (!bounds || bounds.first >= bounds.last) return 'missing';
  // Check size before loading text, so a giant single input cannot allocate an unbounded body.
  const size = db.prepare(`SELECT SUM(length(CAST(content AS BLOB)) + COALESCE(length(CAST(metadata AS BLOB)), 0)) AS bytes
    FROM messages WHERE node_id = ? AND seq BETWEEN ? AND ? AND role IN ('user', 'assistant')`)
    .get(turn.nodeId, bounds.first, bounds.last) as { bytes: number };
  if (size.bytes > CONVERSATION_UPDATES_LIMITS.messageBytes) return 'large';
  const rows = db.prepare(`SELECT id, role, content, metadata, seq FROM messages
    WHERE node_id = ? AND seq BETWEEN ? AND ? AND role IN ('user', 'assistant') ORDER BY seq, id`)
    .all(turn.nodeId, bounds.first, bounds.last) as unknown as TextRow[];
  const messages: ConversationUpdateMessage[] = [];
  for (const row of rows) {
    let metadata: Record<string, unknown> = {};
    try { metadata = row.metadata ? JSON.parse(row.metadata) : {}; } catch { /* legacy metadata */ }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {};
    const initial = row.id === turn.userMessageId;
    const assistant = row.id === turn.assistantMessageId;
    // Unexpected intervening input/reply means these boundaries cannot safely identify a turn.
    if (!initial && !assistant && (row.role !== 'user' || metadata.steered !== true)) return 'missing';
    const safeMetadata: Record<string, unknown> = {};
    if (row.role === 'user') {
      for (const key of ['steered', 'quotedText', 'quoteSource', 'comments', 'attachments']) {
        if (metadata[key] !== undefined) safeMetadata[key] = metadata[key];
      }
    }
    messages.push({ id: row.id, role: row.role as 'user' | 'assistant', content: row.content,
      ...(Object.keys(safeMetadata).length ? { metadata: safeMetadata } : {}) });
  }
  return messages;
}

/** All authorization, upper bound, counts and this page use one short SQLite snapshot. */
export function readConversationUpdates(caller: PaneInspectionCaller, raw: unknown): ConversationUpdates {
  const input = parseReadConversationUpdatesInput(raw);
  return runInTransaction(() => {
    const cloud = process.env.MICHI_CLOUD === '1';
    const workspace = getWorkspace(caller.workspaceId, caller.ownerUserId);
    if (!workspace || workspace.deleted_at !== null || (cloud && (!caller.ownerUserId || workspace.owner_user_id !== caller.ownerUserId))) {
      throw new ConversationUpdatesError('not_found', 'Workspace not found');
    }
    try { assertPaneInspectionCaller(caller, 'conversation-updates'); }
    catch (error) {
      if (error instanceof PaneInspectionError) {
        throw new ConversationUpdatesError(error.code === 'NAVIGATION_DISABLED' ? 'navigation_disabled' : 'not_found', error.message);
      }
      throw error;
    }
    const current = conversationCompletionCounter(caller.workspaceId);
    const through = input.through ?? current;
    if (input.after > through || through > current) {
      throw new ConversationUpdatesError('cursor_invalid', 'Expected after <= through <= current workspace counter');
    }
    const args = [caller.workspaceId, cloud ? 1 : 0, caller.ownerUserId, input.after, through];
    const db = getDb();
    const byNode = db.prepare(`SELECT n.id AS nodeId, n.tree_id AS treeId, COUNT(*) AS newTurnCount ${READABLE} GROUP BY n.id ORDER BY n.id`)
      .all(...args) as unknown as ConversationUpdates['byNode'];
    const totalTurns = byNode.reduce((sum, node) => sum + node.newTurnCount, 0);
    const rows = db.prepare(`SELECT t.completion_seq, t.turn_id, t.node_id, n.tree_id, t.user_message_id,
      t.assistant_message_id, t.completed_at,
      COALESCE((SELECT substr(m.content, 1, 280) FROM messages m WHERE m.id = t.assistant_message_id AND m.node_id = n.id), '') AS preview
      ${READABLE} ORDER BY t.completion_seq LIMIT ?`).all(...args, input.limit) as unknown as UpdateRow[];
    const turns: ConversationUpdate[] = [];
    let bytes = 0;
    let delivered = 0;
    let nextAfter = input.after;
    for (const row of rows) {
      const turn: ConversationUpdate = {
        completionSeq: row.completion_seq, turnId: row.turn_id, nodeId: row.node_id, treeId: row.tree_id,
        userMessageId: row.user_message_id, assistantMessageId: row.assistant_message_id,
        completedAt: row.completed_at, preview: row.preview,
      };
      if (input.includeMessages) {
        const messages = turnMessages(turn);
        if (messages === 'large' || messages === 'missing') {
          if (delivered === 0) turns.push({ ...turn, ...(messages === 'large' ? { contentTooLarge: true as const } : { contentUnavailable: true as const }) });
          break;
        }
        const size = Buffer.byteLength(JSON.stringify(messages));
        if (bytes + size > CONVERSATION_UPDATES_LIMITS.messageBytes) {
          if (delivered === 0) turns.push({ ...turn, contentTooLarge: true });
          break;
        }
        bytes += size;
        turn.messages = messages;
      }
      turns.push(turn);
      delivered += 1;
      nextAfter = turn.completionSeq;
    }
    const hasMore = delivered < totalTurns;
    return { after: input.after, through, totalTurns, byNode: byNode.map(row => ({ ...row })), turns, nextAfter: hasMore ? nextAfter : through, hasMore };
  });
}
