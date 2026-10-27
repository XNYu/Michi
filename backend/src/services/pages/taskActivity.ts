/**
 * What the Meta agent's upkeep did to a workspace's tasks, worked out from the
 * task database's change records: the suggestions waiting on the person, the
 * tasks it added or changed in the last day, and its latest update (the one a
 * board's note offers to undo). Also who made a task.
 */
import {
  isSystemWorkspaceSettings, isTaskDb, taskThreadIds, TASK_ACTIVITY_LIMITS, TASK_ACTIVITY_WINDOW_MS, TASK_COLUMN,
  type PageChangeDto, type PageDatabase, type TaskActivity, type TaskMark, type TaskOrigin, type TaskUpkeep,
} from 'michi-shared';
import { getDb } from '../db';
import { PageWriteError } from './core';
import { firstRowChange, pendingRowProposals, upkeepRowChanges } from './historyRepository';
import { threadStates } from './homeSections';
import { getDatabase } from './repository';

type RowChange = PageChangeDto & { target: Extract<PageChangeDto['target'], { kind: 'row' }> };
const isRow = (change: PageChangeDto): change is RowChange => change.target.kind === 'row';
const existed = (snapshot: PageChangeDto['before']): boolean => snapshot?.kind === 'row' && snapshot.exists;

function taskDatabase(databaseId: string, ownerUserId: string): PageDatabase {
  const database = getDatabase(databaseId, ownerUserId);
  if (!isTaskDb(database)) throw new PageWriteError(400, 'invalid', 'Only a task database has task activity');
  return database;
}

export function taskActivity(databaseId: string, ownerUserId: string, now = Date.now()): TaskActivity {
  const database = taskDatabase(databaseId, ownerUserId);
  const live = new Set(database.rows.map((row) => row.id));
  const suggestions = pendingRowProposals(databaseId, ownerUserId, TASK_ACTIVITY_LIMITS.suggestions)
    .filter((change) => isRow(change) && live.has(change.target.rowId));
  const recent = upkeepRowChanges(databaseId, ownerUserId, now - TASK_ACTIVITY_WINDOW_MS, TASK_ACTIVITY_LIMITS.upkeepChanges).filter(isRow);
  const marks = new Map<string, TaskMark>();
  for (const change of recent) {
    const rowId = change.target.rowId;
    if (change.applicationState !== 'applied' || !live.has(rowId) || !existed(change.after)) continue;
    const prior = marks.get(rowId);
    marks.set(rowId, { rowId, kind: prior?.kind === 'new' || !existed(change.before) ? 'new' : 'updated', at: change.createdAt });
  }
  return {
    suggestions,
    marks: [...marks.values()].sort((a, b) => b.at - a.at),
    latestUpkeep: latestUpkeep(recent, ownerUserId, now),
  };
}

function latestUpkeep(recent: readonly RowChange[], ownerUserId: string, now: number): TaskUpkeep | null {
  const newest = recent.at(-1);
  if (!newest) return null;
  const batch = recent.filter((change) => change.batchId === newest.batchId);
  if (batch.some((change) => change.applicationState === 'reverted')) return null;
  // Written straight away, not suggested first and accepted since.
  const written = batch.filter((change) => change.applicationState === 'applied' && change.proposalState === null);
  const counts = {
    added: written.filter((change) => !existed(change.before) && existed(change.after)).length,
    updated: written.filter((change) => existed(change.before) && existed(change.after)).length,
    removed: written.filter((change) => existed(change.before) && !existed(change.after)).length,
    suggested: batch.filter((change) => change.proposalState === 'pending').length,
  };
  if (!counts.added && !counts.updated && !counts.removed && !counts.suggested) return null;
  return { batchId: newest.batchId, at: newest.createdAt, ...counts, source: upkeepSource(newest, ownerUserId, now) };
}

/** The one conversation an upkeep batch read, while it is still there. */
function upkeepSource(change: PageChangeDto, ownerUserId: string, now: number): TaskUpkeep['source'] {
  if (change.source.kind !== 'maintenance') return null;
  const cited = [...new Map(change.source.evidence.map((entry) => [entry.nodeId, entry])).values()];
  if (cited.length !== 1) return null;
  const entry = cited[0]!;
  const card = threadStates({ ownerUserId, nodeIds: [entry.nodeId], now })[0];
  return card ? { nodeId: entry.nodeId, turnId: entry.turnId, assistantId: entry.messageId ?? entry.assistantId, title: card.title } : null;
}

/** Who made a task, from its first change record; null when that is not its creation (a task the database was made with). */
export function taskOrigin(databaseId: string, rowId: string, ownerUserId: string): TaskOrigin | null {
  const database = taskDatabase(databaseId, ownerUserId);
  if (!database.rows.some((row) => row.id === rowId)) throw new PageWriteError(404, 'not_found', 'Task not found');
  const first = firstRowChange(databaseId, rowId, ownerUserId, database.workspaceId);
  if (!first || existed(first.before) || first.after?.kind !== 'row' || !first.after.exists) return null;
  const linked = taskThreadIds(first.after.row.values[TASK_COLUMN.threads]).length;
  const source = first.source;
  if (source.kind === 'user') return { by: 'you', conversations: linked, at: first.createdAt };
  const read = source.kind === 'maintenance' ? new Set(source.evidence.map((entry) => entry.nodeId)).size : 0;
  return { by: metaAgentSource(source) ? 'meta-agent' : 'agent', conversations: linked || read, at: first.createdAt };
}

/** Background maintenance is the Meta agent's; so is a chat in the assistant's own workspace (the Pages Assistant). */
function metaAgentSource(source: PageChangeDto['source']): boolean {
  if (source.kind === 'maintenance') return true;
  if (source.kind !== 'chat') return false;
  const row = getDb().prepare('SELECT w.settings FROM nodes n JOIN workspaces w ON w.id=n.workspace_id WHERE n.id=?')
    .get(source.nodeId) as { settings: string | null } | undefined;
  return !!row && isSystemWorkspaceSettings(row.settings);
}
