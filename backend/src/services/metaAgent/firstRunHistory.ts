import { META_AGENT_DEFAULT_FIRST_RUN_DAYS, META_AGENT_FIRST_RUN_DAYS, parseBranchOverviewEntries } from 'michi-shared';
import { getDb } from '../db';

const DAY_MS = 24 * 3_600_000;
export const FIRST_RUN_MAX_CONVERSATIONS = 1_000;
export const FIRST_RUN_LIST_PAGE = { default: 20, max: 50 } as const;
const LIST_BYTES = 64 * 1024;
const OVERVIEW_ENTRIES = 3;
const OVERVIEW_TEXT = 300;

export interface HistoryConversation {
  nodeId: string;
  treeId: string | null;
  title: string | null;
  lastActiveAt: number;
  messageCount: number;
  branchOverview: string | null;
}

type Row = { node_id: string; tree_id: string | null; title: string | null; branch_overview: string | null; last_at: number; message_count: number };

const windowKey = (workspaceId: string, ownerUserId: string) => `meta_agent_first_run_days:${ownerUserId}:${workspaceId}`;

/** Fixes a first run's range when it is queued, so the list holds still while the run pages it. */
export function setFirstRunWindowDays(workspaceId: string, ownerUserId: string, days: number): void {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(windowKey(workspaceId, ownerUserId), String(days));
}

/** The range a workspace's first run was queued with; runs queued before the range was a setting read 30 days. */
export function firstRunWindowDays(workspaceId: string, ownerUserId: string): number {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(windowKey(workspaceId, ownerUserId)) as { value: string } | undefined;
  const days = Number(row?.value);
  return (META_AGENT_FIRST_RUN_DAYS as readonly number[]).includes(days) ? days : META_AGENT_DEFAULT_FIRST_RUN_DAYS;
}

/**
 * The conversations a first run reads: chats with a message in the `days`
 * before `asOf`, newest first, at most 1,000. Messages after `asOf` are left
 * to the incremental reader so the list holds still while it is paged.
 * Maintenance runs' own chats are not conversations.
 */
export function listHistoryConversations(workspaceId: string, asOf: number, days: number, limit = FIRST_RUN_MAX_CONVERSATIONS): HistoryConversation[] {
  const rows = getDb().prepare(`SELECT n.id AS node_id,n.tree_id,n.title,n.branch_overview,MAX(m.created_at) AS last_at,COUNT(*) AS message_count
    FROM nodes n JOIN messages m ON m.node_id=n.id AND m.role IN ('user','assistant') AND m.created_at<=?
    LEFT JOIN trees tr ON tr.id=n.tree_id
    WHERE n.workspace_id=? AND n.kind='chat' AND n.deleted_at IS NULL AND n.purged_at IS NULL AND n.status<>'archived'
      AND tr.archived_at IS NULL AND n.maintenance_job_id IS NULL
    GROUP BY n.id HAVING MAX(m.created_at)>=? ORDER BY last_at DESC,n.id LIMIT ?`)
    .all(asOf, workspaceId, asOf - days * DAY_MS, Math.min(limit, FIRST_RUN_MAX_CONVERSATIONS)) as unknown as Row[];
  return rows.map((row) => ({ nodeId: row.node_id, treeId: row.tree_id, title: row.title, lastActiveAt: row.last_at,
    messageCount: row.message_count, branchOverview: row.branch_overview }));
}

export interface HistoryListPage {
  total: number;
  offset: number;
  nextOffset: number | null;
  conversations: Array<{ nodeId: string; treeId: string | null; title: string; lastActiveAt: string; messages: number; overview: string[] }>;
}

export function historyListPage(all: HistoryConversation[], offset: number, limit: number): HistoryListPage {
  let items = all.slice(offset, offset + limit).map((entry) => ({
    nodeId: entry.nodeId, treeId: entry.treeId, title: entry.title ?? '(untitled)',
    lastActiveAt: new Date(entry.lastActiveAt).toISOString(), messages: entry.messageCount,
    overview: parseBranchOverviewEntries(entry.branchOverview).slice(-OVERVIEW_ENTRIES).map((item) => item.text.slice(0, OVERVIEW_TEXT)),
  }));
  const page = () => ({ total: all.length, offset, nextOffset: offset + items.length < all.length ? offset + items.length : null, conversations: items });
  while (items.length > 1 && Buffer.byteLength(JSON.stringify(page()), 'utf8') > LIST_BYTES) items = items.slice(0, -1);
  return page();
}

/** Whether a workspace has a finished conversation of its own (not a maintenance run's). */
export function hasCompletedConversation(workspaceId: string): boolean {
  return !!getDb().prepare(`SELECT 1 FROM turns t JOIN nodes n ON n.id=t.node_id WHERE n.workspace_id=? AND n.kind='chat'
    AND n.deleted_at IS NULL AND n.maintenance_job_id IS NULL AND t.status='completed' LIMIT 1`).get(workspaceId);
}
