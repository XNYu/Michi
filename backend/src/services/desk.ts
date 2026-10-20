import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import {
  assembleDeskNow,
  assembleDeskProject,
  assembleDeskProjects,
  classifyDeskThread,
  deskContinuation,
  visibleDeskThreads,
  type ClassifiedDeskThread,
  type DeskMark,
  type DeskNow,
  type DeskPeek,
  type DeskPeekMessage,
  type DeskProject,
  type DeskProjectView,
  type DeskResume,
  type DeskThread,
  type DeskThreadFacts,
  type DeskWrite,
} from 'michi-shared';
import { getDb, runInTransaction } from './db';

export interface DeskScope {
  /** Set in cloud mode. Desktop leaves this empty and sees every local workspace. */
  userId?: string;
  /** Isolates looked-at timestamps and undo receipts. */
  ownerKey: string;
}

export type DeskMutation = 'archive' | 'ignore' | 'unarchive' | 'unignore' | 'done';

export class DeskAuthError extends Error {
  constructor() {
    super('unauthenticated');
    this.name = 'DeskAuthError';
  }
}

interface FactRow {
  tree_id: string;
  workspace_id: string;
  workspace_name: string;
  workspace_cwd: string | null;
  tree_name: string | null;
  tree_archived_at: number | null;
  last_active_at: number | null;
  root_node_id: string;
  root_title: string | null;
  streaming_nodes: number | null;
  active_turns: number | null;
  user_messages: number | null;
  assistant_messages: number | null;
  last_role: string | null;
  last_content: string | null;
  last_message_at: number | null;
  last_message_id: string | null;
  last_node_id: string | null;
  last_follow_ups: string | null;
  disposition: string | null;
  done_by: string | null;
  marked_at: number | null;
  activity_at_mark: number | null;
}

const LIST_FACTS_SQL = `
WITH scoped_trees AS (
  SELECT
    t.id,
    t.workspace_id,
    t.name,
    t.archived_at,
    t.last_active_at,
    t.root_node_id,
    w.name AS workspace_name,
    w.cwd AS workspace_cwd
  FROM trees t
  JOIN workspaces w ON w.id = t.workspace_id
  WHERE w.deleted_at IS NULL
    AND w.purged_at IS NULL
    AND w.archived_at IS NULL
    AND (? IS NULL OR w.owner_user_id = ?)
    AND EXISTS (
      SELECT 1 FROM nodes n
      WHERE n.tree_id = t.id
        AND n.deleted_at IS NULL
        AND n.purged_at IS NULL
        AND n.kind = 'chat'
    )
),
live_nodes AS (
  SELECT n.id, n.tree_id, n.status, n.follow_ups, n.title
  FROM nodes n
  JOIN scoped_trees t ON t.id = n.tree_id
  WHERE n.deleted_at IS NULL
    AND n.purged_at IS NULL
    AND n.kind = 'chat'
),
msg_ranked AS (
  SELECT
    n.tree_id,
    m.id AS message_id,
    m.role,
    SUBSTR(m.content, 1, 400) AS content,
    m.created_at,
    n.follow_ups,
    n.id AS node_id,
    ROW_NUMBER() OVER (
      PARTITION BY n.tree_id
      ORDER BY m.created_at DESC, m.seq DESC, m.id DESC
    ) AS rn
  FROM messages m
  JOIN live_nodes n ON n.id = m.node_id
  WHERE m.role IN ('user', 'assistant')
),
msg_counts AS (
  SELECT
    n.tree_id AS tree_id,
    SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) AS user_messages,
    SUM(CASE WHEN m.role = 'assistant' THEN 1 ELSE 0 END) AS assistant_messages
  FROM messages m
  JOIN live_nodes n ON n.id = m.node_id
  WHERE m.role IN ('user', 'assistant')
  GROUP BY n.tree_id
),
node_flags AS (
  SELECT
    tree_id,
    SUM(CASE WHEN status = 'streaming' THEN 1 ELSE 0 END) AS streaming_nodes
  FROM live_nodes
  GROUP BY tree_id
),
active_turns AS (
  SELECT n.tree_id AS tree_id, COUNT(*) AS active_turns
  FROM turns tu
  JOIN live_nodes n ON n.id = tu.node_id
  WHERE tu.status = 'active'
  GROUP BY n.tree_id
)
SELECT
  t.id AS tree_id,
  t.workspace_id,
  t.workspace_name,
  t.workspace_cwd,
  t.name AS tree_name,
  t.archived_at AS tree_archived_at,
  t.last_active_at,
  t.root_node_id,
  root.title AS root_title,
  nf.streaming_nodes,
  at.active_turns,
  mc.user_messages,
  mc.assistant_messages,
  mr.role AS last_role,
  mr.content AS last_content,
  mr.created_at AS last_message_at,
  mr.message_id AS last_message_id,
  mr.node_id AS last_node_id,
  mr.follow_ups AS last_follow_ups,
  dm.disposition,
  dm.done_by,
  dm.marked_at,
  dm.activity_at_mark
FROM scoped_trees t
LEFT JOIN nodes root ON root.id = t.root_node_id
LEFT JOIN node_flags nf ON nf.tree_id = t.id
LEFT JOIN active_turns at ON at.tree_id = t.id
LEFT JOIN msg_counts mc ON mc.tree_id = t.id
LEFT JOIN msg_ranked mr ON mr.tree_id = t.id AND mr.rn = 1
LEFT JOIN desk_thread_marks dm ON dm.tree_id = t.id
`;

function requireCloudUser(scope: DeskScope): void {
  if (process.env.MICHI_CLOUD === '1' && !scope.userId) throw new DeskAuthError();
}

function ownerParams(scope: DeskScope): SQLInputValue[] {
  const userId = scope.userId ?? null;
  return [userId, userId];
}

function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

function parseFollowUps(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .slice(0, 3);
  } catch {
    return [];
  }
}

function parseMark(row: FactRow): DeskMark | null {
  if (row.disposition !== 'active' && row.disposition !== 'archived' && row.disposition !== 'ignored') return null;
  if (row.marked_at == null) return null;
  const doneBy = row.done_by === 'user' || row.done_by === 'agent' ? row.done_by : null;
  return {
    disposition: row.disposition,
    doneBy,
    markedAt: row.marked_at,
    activityAtMark: row.activity_at_mark,
  };
}

function rowToFacts(row: FactRow): DeskThreadFacts {
  const lastActivityCandidates = [row.last_message_at, row.last_active_at].filter((value): value is number => value != null);
  const lastActivityAt = lastActivityCandidates.length > 0 ? Math.max(...lastActivityCandidates) : null;
  const stoppedAt = clip(row.last_content ?? '');
  const title = (row.tree_name ?? '').trim() || (row.root_title ?? '').trim() || stoppedAt || 'Untitled';
  const lastRole = row.last_role === 'user' || row.last_role === 'assistant' ? row.last_role : null;
  return {
    id: row.tree_id,
    projectId: row.workspace_id,
    projectTitle: row.workspace_name,
    rootNodeId: row.root_node_id,
    focusNodeId: row.last_node_id || row.root_node_id,
    title,
    lastActivityAt,
    lastRole,
    userMessages: Number(row.user_messages ?? 0),
    assistantMessages: Number(row.assistant_messages ?? 0),
    streaming: Number(row.streaming_nodes ?? 0) > 0,
    activeTurn: Number(row.active_turns ?? 0) > 0,
    followUps: parseFollowUps(row.last_follow_ups),
    stoppedAt,
    lastMessageId: row.last_message_id,
    treeArchivedAt: row.tree_archived_at,
    mark: parseMark(row),
  };
}

function listRows(scope: DeskScope): FactRow[] {
  requireCloudUser(scope);
  return getDb().prepare(LIST_FACTS_SQL).all(...ownerParams(scope)) as unknown as FactRow[];
}

export function listClassified(scope: DeskScope, now = Date.now()): ClassifiedDeskThread[] {
  return listRows(scope).map((row) => classifyDeskThread(rowToFacts(row), now));
}

export function loadDeskNow(scope: DeskScope, since: number | undefined, now = Date.now()): DeskNow {
  const looked = since ?? readLooked(scope, 'now') ?? 0;
  return assembleDeskNow(listClassified(scope, now), looked, now);
}

export function loadDeskProjects(scope: DeskScope, now = Date.now()): DeskProject[] {
  return assembleDeskProjects(listClassified(scope, now), now);
}

export function loadDeskProject(scope: DeskScope, projectId: string, since: number | undefined, now = Date.now()): DeskProjectView | null {
  const looked = since ?? readLooked(scope, projectScope(projectId)) ?? 0;
  return assembleDeskProject(listClassified(scope, now), projectId, looked, now);
}

export function loadDeskThreads(scope: DeskScope, now = Date.now()): DeskThread[] {
  return visibleDeskThreads(listClassified(scope, now));
}

export function loadDeskPeek(scope: DeskScope, threadId: string, now = Date.now()): DeskPeek | null {
  const thread = listClassified(scope, now).find((item) => item.id === threadId && item.visibility !== 'hidden');
  if (!thread) return null;
  const rows = getDb().prepare(
    `SELECT m.role AS role, SUBSTR(m.content, 1, 280) AS content, m.created_at AS created_at
       FROM messages m
       JOIN nodes n ON n.id = m.node_id
      WHERE n.tree_id = ?
        AND n.deleted_at IS NULL
        AND n.purged_at IS NULL
        AND m.role IN ('user', 'assistant')
      ORDER BY m.created_at DESC, m.seq DESC, m.id DESC
      LIMIT 8`,
  ).all(threadId) as unknown as Array<{ role: string; content: string; created_at: number | null }>;
  const recent: DeskPeekMessage[] = rows.reverse().map((row) => ({
    role: row.role === 'user' ? 'user' : 'assistant',
    text: clip(row.content ?? '', 240),
    at: row.created_at,
  }));
  const { visibility: _visibility, ...publicThread } = thread;
  return { thread: publicThread, recent };
}

export function loadDeskResume(scope: DeskScope, threadId: string, now = Date.now()): DeskResume | null {
  const row = listRows(scope).find((item) => item.tree_id === threadId);
  if (!row) {
    return {
      app: 'Michi',
      command: null,
      cwd: null,
      shell: null,
      continuation: '',
      reason: 'bad-id',
    };
  }
  const thread = classifyDeskThread(rowToFacts(row), now);
  return {
    app: 'Michi',
    command: null,
    cwd: row.workspace_cwd,
    shell: null,
    continuation: deskContinuation(thread),
    reason: null,
    workspaceId: thread.projectId,
    treeId: thread.id,
    rootNodeId: thread.rootNodeId,
    focusNodeId: thread.focusNodeId,
  };
}

export function searchDeskThreads(scope: DeskScope, query: string, now = Date.now()): DeskThread[] {
  requireCloudUser(scope);
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const contentHits = new Set(searchContent(scope, query.trim()));
  return visibleDeskThreads(listClassified(scope, now))
    .filter((thread) => (
      contentHits.has(thread.id)
      || thread.title.toLowerCase().includes(needle)
      || thread.projectTitle.toLowerCase().includes(needle)
      || thread.stoppedAt.toLowerCase().includes(needle)
      || (thread.next ?? '').toLowerCase().includes(needle)
    ))
    .slice(0, 40);
}

function searchContent(scope: DeskScope, query: string): string[] {
  const like = `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const rows = getDb().prepare(
    `SELECT DISTINCT n.tree_id AS tree_id
       FROM messages m
       JOIN nodes n ON n.id = m.node_id
       JOIN trees t ON t.id = n.tree_id
       JOIN workspaces w ON w.id = t.workspace_id
      WHERE w.deleted_at IS NULL
        AND w.purged_at IS NULL
        AND w.archived_at IS NULL
        AND n.deleted_at IS NULL
        AND n.purged_at IS NULL
        AND m.content LIKE ? ESCAPE '\\'
        AND (? IS NULL OR w.owner_user_id = ?)
      LIMIT 80`,
  ).all(like, ...ownerParams(scope)) as unknown as Array<{ tree_id: string }>;
  return rows.map((row) => row.tree_id);
}

interface ReceiptEntry {
  treeId: string;
  previous: DeskMark | null;
}

export function mutateDeskThreads(scope: DeskScope, action: DeskMutation, ids: string[], now = Date.now()): DeskWrite | null {
  const unique = [...new Set(ids)];
  const rows = listRows(scope);
  const byId = new Map(rows.map((row) => [row.tree_id, row]));
  if (unique.some((id) => !byId.has(id))) return null;
  const entries: ReceiptEntry[] = unique.map((id) => ({
    treeId: id,
    previous: parseMark(byId.get(id)!),
  }));
  const receiptId = randomUUID();
  runInTransaction(() => {
    for (const entry of entries) {
      const row = byId.get(entry.treeId)!;
      const facts = rowToFacts(row);
      writeMark(entry.treeId, nextMark(entry.previous, action, now, facts.lastActivityAt));
    }
    getDb().prepare(
      `INSERT INTO desk_receipts (id, owner_key, action, payload, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(receiptId, scope.ownerKey, action, JSON.stringify({ entries }), now);
  });
  return { receipt: { id: receiptId, action } };
}

function nextMark(previous: DeskMark | null, action: DeskMutation, now: number, lastActivityAt: number | null): DeskMark {
  const disposition = action === 'archive' ? 'archived' : action === 'ignore' ? 'ignored' : 'active';
  const doneBy = action === 'done' ? 'user' : (previous?.doneBy ?? null);
  return {
    disposition,
    doneBy,
    markedAt: now,
    activityAtMark: lastActivityAt,
  };
}

function writeMark(treeId: string, mark: DeskMark): void {
  getDb().prepare(
    `INSERT INTO desk_thread_marks (tree_id, disposition, done_by, marked_at, activity_at_mark)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tree_id) DO UPDATE SET
       disposition = excluded.disposition,
       done_by = excluded.done_by,
       marked_at = excluded.marked_at,
       activity_at_mark = excluded.activity_at_mark`,
  ).run(treeId, mark.disposition, mark.doneBy, mark.markedAt, mark.activityAtMark);
}

function deleteMark(treeId: string): void {
  getDb().prepare('DELETE FROM desk_thread_marks WHERE tree_id = ?').run(treeId);
}

export function undoDeskReceipt(scope: DeskScope, receiptId: string, now = Date.now()): boolean {
  requireCloudUser(scope);
  const row = getDb().prepare(
    `SELECT payload FROM desk_receipts WHERE id = ? AND owner_key = ? AND undone_at IS NULL`,
  ).get(receiptId, scope.ownerKey) as unknown as { payload: string } | undefined;
  if (!row) return false;
  let entries: ReceiptEntry[] = [];
  try {
    const parsed = JSON.parse(row.payload) as { entries?: ReceiptEntry[] };
    entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return false;
  }
  runInTransaction(() => {
    for (const entry of entries) {
      if (!entry || typeof entry.treeId !== 'string') continue;
      if (entry.previous == null) deleteMark(entry.treeId);
      else writeMark(entry.treeId, entry.previous);
    }
    getDb().prepare('UPDATE desk_receipts SET undone_at = ? WHERE id = ?').run(now, receiptId);
  });
  return true;
}

export function markDeskLooked(scope: DeskScope, scopeName: string, now = Date.now()): void {
  requireCloudUser(scope);
  getDb().prepare(
    `INSERT INTO desk_looks (owner_key, scope, looked_at) VALUES (?, ?, ?)
     ON CONFLICT(owner_key, scope) DO UPDATE SET looked_at = excluded.looked_at`,
  ).run(scope.ownerKey, scopeName, now);
}

export function projectScope(projectId: string): string {
  return `project:${projectId}`;
}

function readLooked(scope: DeskScope, scopeName: string): number | null {
  const row = getDb().prepare(
    'SELECT looked_at FROM desk_looks WHERE owner_key = ? AND scope = ?',
  ).get(scope.ownerKey, scopeName) as unknown as { looked_at: number } | undefined;
  return row ? Number(row.looked_at) : null;
}
