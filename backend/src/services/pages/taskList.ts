/**
 * Tasks across the owner's task databases, as compact rows: newest change
 * first, filtered on their cells, then on whether a linked conversation waits
 * on the person now. A chat reads its own workspace's tasks as they are. A
 * read across workspaces leaves out archived workspaces, and those whose
 * "Let AI navigate this workspace" is off unless the person is the reader,
 * and says which of them it left out.
 */
import {
  conversationWaitsOnYou, isSystemWorkspaceSettings, taskThreadIds, TASK_COLUMN, TASK_LIST_LIMITS, THREAD_STATE_LIMITS,
  type PageDatabaseRow, type TaskListItem, type TaskListResult, type TaskListSkip,
} from 'michi-shared';
import { workspaceOwnerMatches } from '../agentOwner';
import { getDb } from '../db';
import { getAiGlobalContext } from '../dbRepository';
import { PageWriteError } from './core';
import { serverLiveWait, threadStates, type HomeLiveWaitReader } from './homeSections';
import { getDatabase } from './repository';

/**
 * Where a read looks: one workspace (its own chat reads it whatever the
 * workspace's settings), or across workspaces (every one, or the named ones).
 */
export type TaskListScope =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'across'; workspaceIds: readonly string[] | null; includeAiHidden: boolean };

export interface TaskListInput {
  ownerUserId: string;
  scope: TaskListScope;
  /** Only tasks with one of these status values. */
  statuses?: readonly string[];
  /** Only tasks that link this conversation. */
  nodeId?: string;
  /** Only tasks waiting on you, or linking a conversation that waits on you now. */
  needsYou?: boolean;
  /** Case-insensitive words in the task, its next step or its notes. */
  query?: string;
  /** Only tasks changed at or after this time (ms). */
  updatedSince?: number;
  limit?: number;
  cursor?: string;
  now?: number;
  /** Pending approvals and questions of running turns; the server's own by default. */
  live?: HomeLiveWaitReader;
}

export interface TaskDatabaseAt { databaseId: string; workspaceId: string; workspaceName: string }
interface Entry { at: TaskDatabaseAt; row: PageDatabaseRow }
type TaskKey = readonly [updatedAt: number, databaseId: string, rowId: string];

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const keyOf = (entry: Entry): TaskKey => [entry.row.updatedAt, entry.at.databaseId, entry.row.id];
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Newest change first; ties by database, then row, so a cursor names one place. */
const order = (a: TaskKey, b: TaskKey): number => b[0] - a[0] || byText(a[1], b[1]) || byText(a[2], b[2]);

const encodeCursor = (key: TaskKey): string => Buffer.from(JSON.stringify(key)).toString('base64url');

function decodeCursor(cursor: string): TaskKey {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(value) && value.length === 3 && Number.isSafeInteger(value[0]) && typeof value[1] === 'string' && typeof value[2] === 'string') {
      return [value[0] as number, value[1], value[2]];
    }
  } catch {
    // Not a cursor this read made.
  }
  throw new PageWriteError(400, 'invalid', 'Invalid cursor');
}

type DatabaseRow = {
  database_id: string; workspace_id: string; workspace_name: string;
  owner_user_id: string | null; archived_at: number | null; settings: string | null;
};

/** The task databases a read looks at, and the workspaces with one it leaves out. All tasks reads them across workspaces too. */
export function taskDatabases(input: TaskListInput): { use: TaskDatabaseAt[]; skipped: TaskListSkip[] } {
  const rows = getDb().prepare(`SELECT d.id AS database_id,d.workspace_id,w.name AS workspace_name,w.owner_user_id,w.archived_at,w.settings
    FROM page_databases d JOIN workspaces w ON w.id=d.workspace_id
    WHERE d.role='tasks' AND d.deleted_at IS NULL AND d.owner_user_id=? AND w.deleted_at IS NULL AND w.purged_at IS NULL
    ORDER BY d.workspace_id`).all(input.ownerUserId) as unknown as DatabaseRow[];
  const use: TaskDatabaseAt[] = [];
  const skipped: TaskListSkip[] = [];
  const { scope } = input;
  for (const row of rows) {
    if (!workspaceOwnerMatches(row.owner_user_id, input.ownerUserId)) continue;
    const at = { databaseId: row.database_id, workspaceId: row.workspace_id, workspaceName: row.workspace_name };
    if (scope.kind === 'workspace') {
      if (row.workspace_id === scope.workspaceId) use.push(at);
      continue;
    }
    if ((scope.workspaceIds && !scope.workspaceIds.includes(row.workspace_id)) || isSystemWorkspaceSettings(row.settings)) continue;
    // An archived workspace is out of view unless the read named it.
    if (row.archived_at !== null) {
      if (scope.workspaceIds) skipped.push({ workspaceId: at.workspaceId, workspaceName: at.workspaceName, reason: 'archived' });
      continue;
    }
    if (!scope.includeAiHidden && !getAiGlobalContext(row.workspace_id, input.ownerUserId)) {
      skipped.push({ workspaceId: at.workspaceId, workspaceName: at.workspaceName, reason: 'navigation-off' });
      continue;
    }
    use.push(at);
  }
  return { use, skipped };
}

/** The linked conversations that wait on the person now, with the workspace each is in. */
function waitingConversations(entries: readonly Entry[], input: TaskListInput): Map<string, string> {
  const nodeIds = [...new Set(entries.flatMap((entry) => taskThreadIds(entry.row.values[TASK_COLUMN.threads])))];
  const waiting = new Map<string, string>();
  const now = input.now ?? Date.now();
  const live = input.live ?? serverLiveWait;
  for (let start = 0; start < nodeIds.length; start += THREAD_STATE_LIMITS.nodeIds) {
    const chunk = nodeIds.slice(start, start + THREAD_STATE_LIMITS.nodeIds);
    for (const card of threadStates({ ownerUserId: input.ownerUserId, nodeIds: chunk, now, live })) {
      if (conversationWaitsOnYou(card.state)) waiting.set(card.nodeId, card.workspaceId);
    }
  }
  return waiting;
}

/** A conversation that moved to another workspace no longer speaks for this task. */
const waitingIn = (entry: Entry, waiting: ReadonlyMap<string, string>): string[] =>
  taskThreadIds(entry.row.values[TASK_COLUMN.threads]).filter((nodeId) => waiting.get(nodeId) === entry.at.workspaceId);

const needsYou = (entry: Entry, waiting: ReadonlyMap<string, string>): boolean =>
  text(entry.row.values[TASK_COLUMN.status]) === 'waiting' || waitingIn(entry, waiting).length > 0;

function taskListItem(entry: Entry, waiting: ReadonlyMap<string, string>): TaskListItem {
  const { at, row } = entry;
  const status = text(row.values[TASK_COLUMN.status]) || null;
  const waitingConversationIds = waitingIn(entry, waiting);
  return {
    workspaceId: at.workspaceId, workspaceName: at.workspaceName, databaseId: at.databaseId, rowId: row.id, rev: row.rev,
    task: text(row.values[TASK_COLUMN.task]), status,
    statusSetBy: row.edited[TASK_COLUMN.status] !== undefined ? 'user' : status ? 'agent' : null,
    next: text(row.values[TASK_COLUMN.next]),
    conversationIds: taskThreadIds(row.values[TASK_COLUMN.threads]), waitingConversationIds,
    needsYou: status === 'waiting' || waitingConversationIds.length > 0,
    hasNotes: !!row.body?.trim(), updatedAt: row.updatedAt,
  };
}

export function listTasks(input: TaskListInput): TaskListResult {
  const limit = input.limit ?? TASK_LIST_LIMITS.default;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TASK_LIST_LIMITS.max) {
    throw new PageWriteError(400, 'invalid', `limit must be between 1 and ${TASK_LIST_LIMITS.max}`);
  }
  const after = input.cursor === undefined ? null : decodeCursor(input.cursor);
  const statuses = input.statuses?.length ? new Set(input.statuses) : null;
  const needle = input.query?.trim().toLocaleLowerCase() || null;
  const { use, skipped } = taskDatabases(input);
  const entries = use
    .flatMap((at) => getDatabase(at.databaseId, input.ownerUserId).rows.map((row): Entry => ({ at, row })))
    .filter(({ row }) => (!statuses || statuses.has(text(row.values[TASK_COLUMN.status])))
      && (input.nodeId === undefined || taskThreadIds(row.values[TASK_COLUMN.threads]).includes(input.nodeId))
      && (input.updatedSince === undefined || row.updatedAt >= input.updatedSince)
      && (!needle || [row.values[TASK_COLUMN.task], row.values[TASK_COLUMN.next], row.body]
        .some((value) => text(value).toLocaleLowerCase().includes(needle))))
    .filter((entry) => !after || order(keyOf(entry), after) > 0)
    .sort((a, b) => order(keyOf(a), keyOf(b)));
  // Conversation states are read only for the tasks they decide: all of them for needsYou, else the page returned.
  const everyWait = input.needsYou ? waitingConversations(entries, input) : null;
  const matching = everyWait ? entries.filter((entry) => needsYou(entry, everyWait)) : entries;
  const page = matching.slice(0, limit);
  const waiting = everyWait ?? waitingConversations(page, input);
  const last = page[page.length - 1];
  return {
    items: page.map((entry) => taskListItem(entry, waiting)),
    nextCursor: matching.length > limit && last ? encodeCursor(keyOf(last)) : null,
    skippedWorkspaces: skipped,
  };
}
