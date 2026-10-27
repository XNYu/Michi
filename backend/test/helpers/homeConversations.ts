import { getDb } from '../../src/services/db';

/** The latest turn of a seeded conversation; the newest `startedAt` is the one the Home reads. */
export interface SeedTurn {
  id?: string;
  status: 'active' | 'completed' | 'error' | 'cancelled';
  startedAt: number;
  completedAt?: number | null;
  updatedAt?: number;
  stopReason?: string | null;
  error?: string | null;
  userText?: string;
  reply?: string;
  /** Marks the turn's user message as a scheduled job's input. */
  scheduledJobId?: string;
}

export interface SeedConversation {
  nodeId: string;
  workspaceId: string;
  title?: string | null;
  turns?: SeedTurn[];
  /** A user message after the last turn ended. */
  userMessageAt?: number;
  nodeStatus?: string;
  maintenanceJobId?: string;
  deletedAt?: number;
  treeArchivedAt?: number;
}

/** A Michi conversation as the durable store holds it: its tree, node, messages and turns. */
export function seedConversation(input: SeedConversation): void {
  const db = getDb();
  const turns = input.turns ?? [];
  const first = turns[0]?.startedAt ?? 1;
  const treeId = `${input.nodeId}-tree`;
  db.prepare('INSERT INTO trees(id,workspace_id,root_node_id,name,archived_at,last_active_at,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(treeId, input.workspaceId, input.nodeId, null, input.treeArchivedAt ?? null, first, first);
  db.prepare(`INSERT INTO nodes(id,workspace_id,tree_id,kind,title,status,deleted_at,maintenance_job_id,created_at)
    VALUES (?,?,?,'chat',?,?,?,?,?)`).run(input.nodeId, input.workspaceId, treeId, input.title === undefined ? `Chat ${input.nodeId}` : input.title,
    input.nodeStatus ?? 'idle', input.deletedAt ?? null, input.maintenanceJobId ?? null, first - 1);
  let seq = 0;
  const message = db.prepare('INSERT INTO messages(id,node_id,role,content,seq,created_at,metadata) VALUES (?,?,?,?,?,?,?)');
  turns.forEach((turn, index) => {
    const id = turn.id ?? `${input.nodeId}-t${index}`;
    const userId = `${id}-u`;
    const replyId = `${id}-a`;
    message.run(userId, input.nodeId, 'user', turn.userText ?? `Question ${index}`, seq++, turn.startedAt,
      turn.scheduledJobId ? JSON.stringify({ scheduledJobId: turn.scheduledJobId }) : null);
    message.run(replyId, input.nodeId, 'assistant', turn.reply ?? '', seq++, turn.startedAt + 1, null);
    const completedAt = turn.status === 'active' ? null : turn.completedAt ?? turn.startedAt + 10;
    db.prepare(`INSERT INTO turns(turn_id,node_id,user_message_id,assistant_message_id,status,stop_reason,error,started_at,completed_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, input.nodeId, userId, replyId, turn.status, turn.stopReason ?? null, turn.error ?? null,
      turn.startedAt, completedAt, turn.updatedAt ?? completedAt ?? turn.startedAt);
  });
  if (input.userMessageAt !== undefined) message.run(`${input.nodeId}-later`, input.nodeId, 'user', 'Later', seq++, input.userMessageAt, null);
}
