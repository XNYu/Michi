import type {
  AllTasksDto, MichiDatabase, MichiDbCellValue, MichiDbEditOp, MichiDbRow, PageDatabase, PageDatabaseEditOp, ThreadCardItem,
} from 'michi-shared';
import { allTasksColumns, ALL_TASKS_COLUMN, ALL_TASKS_DATABASE_ID, taskThreadIds, TASK_COLUMN } from 'michi-shared';

const CORE = [TASK_COLUMN.task, TASK_COLUMN.status, TASK_COLUMN.threads, TASK_COLUMN.next] as const;
// Safe to split on: database ids are server-generated `db-<uuid>` and never contain "/"; the row id may.
const SEPARATOR = '/';

/** A task's id on All tasks: its database's id, then its own. */
export const allTasksRowId = (databaseId: string, rowId: string): string => `${databaseId}${SEPARATOR}${rowId}`;

/** Which database a task on All tasks is in, and its id there; null for an id All tasks did not make. */
export function splitAllTasksRowId(id: string): { databaseId: string; rowId: string } | null {
  const at = id.indexOf(SEPARATOR);
  return at > 0 && at < id.length - 1 ? { databaseId: id.slice(0, at), rowId: id.slice(at + 1) } : null;
}

/**
 * All tasks as one database: every task of every workspace, newest change
 * first, with the workspace it belongs to. Its columns are built in, so they
 * keep their names and types and take no new options; the workspace cannot be
 * changed. Columns a person added to one workspace's tasks are not shown.
 */
export function allTasksBoard(dto: AllTasksDto): MichiDatabase {
  const workspaceOf = new Map(dto.sources.map((source) => [source.databaseId, source.workspaceId]));
  const rows = dto.rows
    .filter(({ databaseId }) => workspaceOf.has(databaseId))
    .sort((a, b) => b.row.updatedAt - a.row.updatedAt || a.databaseId.localeCompare(b.databaseId) || a.row.id.localeCompare(b.row.id))
    .map(({ databaseId, row }, position): MichiDbRow => ({
      id: allTasksRowId(databaseId, row.id),
      values: {
        ...Object.fromEntries(CORE.filter((id) => row.values[id] !== undefined).map((id) => [id, row.values[id] as MichiDbCellValue])),
        [ALL_TASKS_COLUMN.workspace]: workspaceOf.get(databaseId)!,
      },
      ...(row.body === undefined ? {} : { body: row.body }),
      position,
      updatedAt: row.updatedAt,
      edited: { ...row.edited },
    }));
  return {
    id: ALL_TASKS_DATABASE_ID,
    title: 'All tasks',
    kind: 'user',
    role: 'tasks',
    merged: true,
    columns: allTasksColumns(dto.sources).map((column) => ({ ...column, builtin: true as const, editable: column.id !== ALL_TASKS_COLUMN.workspace })),
    views: dto.views.map((view) => ({ ...view, config: { ...view.config } })),
    rows,
    updatedAt: rows.reduce((at, row) => Math.max(at, row.updatedAt), 0),
  };
}

export type AllTasksPlan =
  | { ok: true; views: MichiDbEditOp[]; rows: Map<string, PageDatabaseEditOp[]> }
  | { ok: false; reason: string };

/**
 * Where an edit made on All tasks goes: view changes to All tasks' own views,
 * task changes to each task's own database (with the row's revision), split
 * by database. Adding a task, putting tasks in order and changing columns
 * happen on a workspace's own board.
 */
export function planAllTasksEdit(dto: AllTasksDto, ops: readonly MichiDbEditOp[]): AllTasksPlan {
  const refuse = (reason: string): AllTasksPlan => ({ ok: false, reason });
  const views: MichiDbEditOp[] = [];
  const rows = new Map<string, PageDatabaseEditOp[]>();
  for (const op of ops) {
    if (op.op === 'view.save') {
      if (op.view.type === 'custom') return refuse('All tasks has no custom views');
      views.push(op);
      continue;
    }
    if (op.op === 'view.delete') {
      views.push(op);
      continue;
    }
    if (op.op === 'row.add') return refuse("Add a task on its workspace's own board");
    if (op.op === 'row.move') return refuse("Put tasks in order on their workspace's own board");
    if (op.op !== 'row.update' && op.op !== 'row.delete') return refuse("Change columns in a workspace's own Tasks database");
    const at = splitAllTasksRowId(op.id);
    const found = at && dto.rows.find((entry) => entry.databaseId === at.databaseId && entry.row.id === at.rowId);
    const source = at && dto.sources.find((item) => item.databaseId === at.databaseId);
    if (!at || !found || !source) return refuse('This task changed. Refresh All tasks and try again.');
    const list = rows.get(at.databaseId) ?? [];
    if (op.op === 'row.delete') {
      list.push({ op: 'row.delete', id: at.rowId, expectRev: found.row.rev });
    } else {
      if (op.values && ALL_TASKS_COLUMN.workspace in op.values) return refuse('A task stays in its own workspace');
      const status = op.values?.[TASK_COLUMN.status];
      if (typeof status === 'string' && !source.statuses.some((option) => option.value === status)) {
        const label = dto.sources.flatMap((item) => item.statuses).find((option) => option.value === status)?.label ?? status;
        return refuse(`Tasks in ${source.workspaceName} have no “${label}” status`);
      }
      list.push({ ...op, id: at.rowId, expectRev: found.row.rev });
    }
    rows.set(at.databaseId, list);
  }
  return { ok: true, views, rows };
}

/** All tasks after one task database's write answered: its revision, statuses and tasks as they are now. */
export function replaceSource(dto: AllTasksDto, database: PageDatabase): AllTasksDto {
  if (!dto.sources.some((source) => source.databaseId === database.id)) return dto;
  return {
    ...dto,
    sources: dto.sources.map((source) => (source.databaseId === database.id ? {
      ...source,
      revision: database.revision,
      statuses: (database.columns.find((column) => column.id === TASK_COLUMN.status)?.options ?? []).map((option) => ({ ...option })),
    } : source)),
    rows: [...dto.rows.filter((entry) => entry.databaseId !== database.id), ...database.rows.map((row) => ({ databaseId: database.id, row }))],
  };
}

/**
 * The linked conversations still in the workspace of a task that links them.
 * All tasks spans workspaces, so its cells cannot check that themselves: one
 * moved away reads as no longer here.
 */
export function conversationsInTaskWorkspaces(dto: AllTasksDto, states: ReadonlyMap<string, ThreadCardItem>): Map<string, ThreadCardItem> {
  const workspaceOf = new Map(dto.sources.map((source) => [source.databaseId, source.workspaceId]));
  const wanted = new Map<string, Set<string>>();
  for (const { databaseId, row } of dto.rows) {
    const workspaceId = workspaceOf.get(databaseId);
    if (!workspaceId) continue;
    for (const nodeId of taskThreadIds(row.values[TASK_COLUMN.threads])) {
      wanted.set(nodeId, (wanted.get(nodeId) ?? new Set()).add(workspaceId));
    }
  }
  const kept = new Map<string, ThreadCardItem>();
  for (const [nodeId, card] of states) if (wanted.get(nodeId)?.has(card.workspaceId)) kept.set(nodeId, card);
  return kept;
}
