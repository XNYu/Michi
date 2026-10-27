import { containsTaskView, isSystemWorkspaceSettings, parsePageBlock, taskDatabaseColumns, taskDatabaseViews, TASK_DATABASE_ROLE, TASK_DATABASE_TITLE, type PageBlock, type PageDatabase } from 'michi-shared';
import { getDb } from '../db';
import { PageWriteError, pagesTransaction, requirePagesWorkspace } from './core';
import { createDatabase, getDatabase, liveTaskDatabaseId } from './repository';

/** The workspace's task database id, or null before it has one. */
export function findTaskDatabaseId(workspaceId: string, ownerUserId: string): string | null {
  requirePagesWorkspace(workspaceId, ownerUserId);
  return liveTaskDatabaseId(workspaceId, ownerUserId);
}

/**
 * The workspace's task database, made empty with its core columns and default
 * views the first time; asking again changes nothing. Pages that already show
 * a task board start referring to it, so its changes reach them.
 */
export function openTaskDatabase(input: { workspaceId: string; ownerUserId: string; now?: number }): { database: PageDatabase; created: boolean } {
  return pagesTransaction(() => {
    const workspace = requirePagesWorkspace(input.workspaceId, input.ownerUserId, true);
    // The Pages Home's system workspace is a Pages workspace, but list_tasks never reads it: a database made there would be invisible.
    if (isSystemWorkspaceSettings(workspace.settings)) {
      throw new PageWriteError(400, 'tasks_need_workspace', 'Task boards belong to a workspace; the Pages Home has no task database.');
    }
    const existing = liveTaskDatabaseId(input.workspaceId, input.ownerUserId);
    if (existing) return { database: getDatabase(existing, input.ownerUserId), created: false };
    const made = createDatabase({
      workspaceId: input.workspaceId, ownerUserId: input.ownerUserId, title: TASK_DATABASE_TITLE, role: TASK_DATABASE_ROLE,
      columns: taskDatabaseColumns(), views: taskDatabaseViews(), ...(input.now === undefined ? {} : { now: input.now }),
    });
    referTaskBoards(input.workspaceId, input.ownerUserId, made.id);
    return { database: getDatabase(made.id, input.ownerUserId), created: true };
  });
}

/** Pages of the workspace whose blocks show a task board refer to its database; trashed ones too, so a restore keeps its board working. */
function referTaskBoards(workspaceId: string, ownerUserId: string, databaseId: string): void {
  const pages = getDb().prepare(`SELECT id,blocks FROM pages WHERE workspace_id=? AND owner_user_id=? AND blocks LIKE '%"task-view"%'`)
    .all(workspaceId, ownerUserId) as unknown as Array<{ id: string; blocks: string }>;
  const insert = getDb().prepare('INSERT OR IGNORE INTO page_database_refs(page_id,database_id) VALUES(?,?)');
  for (const page of pages) {
    let blocks: PageBlock[];
    try {
      blocks = (JSON.parse(page.blocks) as unknown[]).flatMap((value) => {
        const block = parsePageBlock(value);
        return block ? [block] : [];
      });
    } catch {
      continue;
    }
    if (containsTaskView(blocks)) insert.run(page.id, databaseId);
  }
}
