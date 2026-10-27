/**
 * All tasks: every task database of the person's live workspaces in one read,
 * for the merged board. Each task stays in its own database; only the views
 * belong to All tasks, saved per person.
 */
import { randomUUID } from 'node:crypto';
import {
  allTasksColumns, applyPageDatabaseOps, ALL_TASKS_DATABASE_ID, parsePageDatabaseOps, taskDatabaseViews, TASK_COLUMN,
  type AllTasksDto, type PageDatabase, type PageDatabaseView,
} from 'michi-shared';
import { getDb } from '../db';
import { PageWriteError, pagesTransaction } from './core';
import { getDatabase } from './repository';
import { taskDatabases } from './taskList';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function savedViews(ownerUserId: string): { views: PageDatabaseView[]; revision: number } {
  const row = getDb().prepare('SELECT views_json,revision FROM all_tasks_views WHERE owner_user_id=?')
    .get(ownerUserId) as { views_json: string; revision: number } | undefined;
  if (!row) return { views: taskDatabaseViews(), revision: 0 };
  try {
    return { views: JSON.parse(row.views_json) as PageDatabaseView[], revision: row.revision };
  } catch {
    throw new PageWriteError(409, 'invalid', 'Stored All tasks views are invalid');
  }
}

export function allTasks(ownerUserId: string): AllTasksDto {
  // The person's own board: workspaces hidden from AI navigation are theirs to see.
  const { use } = taskDatabases({ ownerUserId, scope: { kind: 'across', workspaceIds: null, includeAiHidden: true } });
  const read = use.map((at) => ({ at, database: getDatabase(at.databaseId, ownerUserId) }))
    .sort((a, b) => a.at.workspaceName.localeCompare(b.at.workspaceName) || a.at.workspaceId.localeCompare(b.at.workspaceId));
  const { views, revision } = savedViews(ownerUserId);
  return {
    sources: read.map(({ at, database }) => ({
      workspaceId: at.workspaceId, workspaceName: at.workspaceName, databaseId: database.id, revision: database.revision,
      statuses: (database.columns.find((column) => column.id === TASK_COLUMN.status)?.options ?? []).map((option) => ({ ...option })),
    })),
    rows: read.flatMap(({ database }) => database.rows.map((row) => ({ databaseId: database.id, row }))),
    views,
    viewsRevision: revision,
  };
}

/** Saves a change to the person's All tasks views; refused when the views changed since `revision`. */
export function editAllTasksViews(input: { ownerUserId: string; revision: number; ops: unknown; now?: number }): { views: PageDatabaseView[]; viewsRevision: number } {
  return pagesTransaction(() => {
    const now = input.now ?? Date.now();
    if (Array.isArray(input.ops) && input.ops.some((op) => isRecord(op) && op.op === 'view.save' && isRecord(op.view) && op.view.type === 'custom')) {
      throw new PageWriteError(400, 'invalid', 'All tasks has no custom views');
    }
    const parsed = parsePageDatabaseOps(input.ops, 'user');
    if (!parsed.ok) throw new PageWriteError(400, 'invalid', parsed.error);
    if (!parsed.ops.length) throw new PageWriteError(400, 'invalid', 'No view changes');
    if (parsed.ops.some((op) => op.op !== 'view.save' && op.op !== 'view.delete')) throw new PageWriteError(400, 'invalid', 'All tasks saves only its views');
    const current = savedViews(input.ownerUserId);
    if (!Number.isSafeInteger(input.revision) || input.revision !== current.revision) throw new PageWriteError(409, 'stale_revision', 'All tasks views changed');
    // Its views name All tasks' own columns, as a database's views name its columns.
    const host: PageDatabase = {
      id: ALL_TASKS_DATABASE_ID, workspaceId: '', title: 'All tasks', columns: allTasksColumns([]), views: current.views, rows: [],
      revision: current.revision, updatedAt: now,
    };
    let views: PageDatabaseView[];
    try {
      views = applyPageDatabaseOps(host, parsed.ops, { actor: 'user', revision: current.revision + 1, now, newId: () => `view-${randomUUID()}` }).database.views;
    } catch (error) {
      throw new PageWriteError(400, 'invalid', error instanceof Error ? error.message : 'Invalid view change');
    }
    const revision = current.revision + 1;
    getDb().prepare(`INSERT INTO all_tasks_views(owner_user_id,views_json,revision,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(owner_user_id) DO UPDATE SET views_json=excluded.views_json,revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(input.ownerUserId, JSON.stringify(views), revision, now);
    return { views, viewsRevision: revision };
  });
}
