import type { SQLInputValue } from 'node:sqlite';
import { getDb } from './db';

const BUCKET_MS = 15 * 60 * 1000;
const PROFILE_WINDOW_DAYS = 53 * 7;
const RANGE_PADDING_DAYS = 2;

interface CountBucketRow {
  bucket: number;
  count: number;
}

interface CountRow {
  count: number;
}

export interface ProfileActivityDay {
  dateKey: string;
  nodes: number;
  branches: number;
  messages: number;
}

export interface ProfileActivitySnapshot {
  totalNodes: number;
  totalThreads: number;
  totalBranches: number;
  totalMessages: number;
  days: ProfileActivityDay[];
}

export interface LoadProfileActivityInput {
  userId?: string;
  timeZone: string;
  nowMs?: number;
}

export function loadProfileActivity({
  userId,
  timeZone,
  nowMs = Date.now(),
}: LoadProfileActivityInput): ProfileActivitySnapshot {
  const dateFormatter = createDateFormatter(timeZone);
  const cloudMode = process.env.MICHI_CLOUD === '1';
  const ownerScoped = typeof userId === 'string' && userId.length > 0;
  if (cloudMode && !ownerScoped) {
    throw new Error('Authenticated user is required for profile activity');
  }

  const ownerClause = ownerScoped ? ' AND w.owner_user_id = ?' : '';
  const ownerParams: SQLInputValue[] = ownerScoped ? [userId as string] : [];
  const rangeStart = nowMs - ((PROFILE_WINDOW_DAYS + RANGE_PADDING_DAYS) * 24 * 60 * 60 * 1000);
  const bucketExpression = (column: 'n.created_at' | 'm.created_at') =>
    `CAST(${column} / ${BUCKET_MS} AS INTEGER) * ${BUCKET_MS}`;
  const liveWorkspace = 'w.deleted_at IS NULL AND w.purged_at IS NULL';
  const liveNode = "n.deleted_at IS NULL AND n.purged_at IS NULL AND n.kind = 'chat'";

  const totalNodes = scalarCount(
    `SELECT COUNT(*) AS count
       FROM nodes n
       JOIN workspaces w ON w.id = n.workspace_id
      WHERE ${liveWorkspace} AND ${liveNode}${ownerClause}`,
    ownerParams,
  );
  const totalThreads = scalarCount(
    `SELECT COUNT(*) AS count
       FROM trees t
       JOIN workspaces w ON w.id = t.workspace_id
      WHERE ${liveWorkspace}${ownerClause}`,
    ownerParams,
  );
  const totalBranches = scalarCount(
    `SELECT COUNT(*) AS count
       FROM edges e
       JOIN nodes n ON n.id = e.target_node_id
       JOIN workspaces w ON w.id = e.workspace_id
      WHERE ${liveWorkspace} AND ${liveNode}
        AND COALESCE(e.kind, 'branch') = 'branch'${ownerClause}`,
    ownerParams,
  );
  const totalMessages = scalarCount(
    `SELECT COUNT(*) AS count
       FROM messages m
       JOIN nodes n ON n.id = m.node_id
       JOIN workspaces w ON w.id = n.workspace_id
      WHERE ${liveWorkspace} AND ${liveNode} AND m.role = 'user'${ownerClause}`,
    ownerParams,
  );

  const nodeBuckets = countBuckets(
    `SELECT ${bucketExpression('n.created_at')} AS bucket, COUNT(*) AS count
       FROM nodes n
       JOIN workspaces w ON w.id = n.workspace_id
      WHERE ${liveWorkspace} AND ${liveNode} AND n.created_at >= ?${ownerClause}
      GROUP BY bucket`,
    [rangeStart, ...ownerParams],
  );
  const branchBuckets = countBuckets(
    `SELECT ${bucketExpression('n.created_at')} AS bucket, COUNT(*) AS count
       FROM edges e
       JOIN nodes n ON n.id = e.target_node_id
       JOIN workspaces w ON w.id = e.workspace_id
      WHERE ${liveWorkspace} AND ${liveNode}
        AND COALESCE(e.kind, 'branch') = 'branch'
        AND n.created_at >= ?${ownerClause}
      GROUP BY bucket`,
    [rangeStart, ...ownerParams],
  );
  const messageBuckets = countBuckets(
    `SELECT ${bucketExpression('m.created_at')} AS bucket, COUNT(*) AS count
       FROM messages m
       JOIN nodes n ON n.id = m.node_id
       JOIN workspaces w ON w.id = n.workspace_id
      WHERE ${liveWorkspace} AND ${liveNode} AND m.role = 'user'
        AND m.created_at >= ?${ownerClause}
      GROUP BY bucket`,
    [rangeStart, ...ownerParams],
  );

  const days = new Map<string, ProfileActivityDay>();
  addBuckets(days, nodeBuckets, 'nodes', dateFormatter);
  addBuckets(days, branchBuckets, 'branches', dateFormatter);
  addBuckets(days, messageBuckets, 'messages', dateFormatter);

  return {
    totalNodes,
    totalThreads,
    totalBranches,
    totalMessages,
    days: [...days.values()].sort((a, b) => a.dateKey.localeCompare(b.dateKey)),
  };
}

function scalarCount(sql: string, params: SQLInputValue[]): number {
  const row = getDb().prepare(sql).get(...params) as unknown as CountRow | undefined;
  return Number(row?.count ?? 0);
}

function countBuckets(sql: string, params: SQLInputValue[]): CountBucketRow[] {
  return getDb().prepare(sql).all(...params) as unknown as CountBucketRow[];
}

function createDateFormatter(timeZone: string): Intl.DateTimeFormat {
  if (!timeZone || timeZone.length > 100) {
    throw new RangeError('Invalid time zone');
  }
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatter.format(0);
    return formatter;
  } catch {
    throw new RangeError(`Invalid time zone: ${timeZone}`);
  }
}

function dateKey(timestamp: number, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addBuckets(
  days: Map<string, ProfileActivityDay>,
  buckets: CountBucketRow[],
  metric: 'nodes' | 'branches' | 'messages',
  formatter: Intl.DateTimeFormat,
): void {
  for (const bucket of buckets) {
    const key = dateKey(Number(bucket.bucket), formatter);
    const current = days.get(key) ?? { dateKey: key, nodes: 0, branches: 0, messages: 0 };
    days.set(key, { ...current, [metric]: current[metric] + Number(bucket.count) });
  }
}
