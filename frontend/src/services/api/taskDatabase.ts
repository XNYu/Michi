import type { AllTasksDto, PageDatabase, PageDatabaseEditOp, PageDatabaseView, TaskActivity, TaskOrigin } from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';
import { backendEntityId, serverEntityId } from '../../config/backendIdentity';
import { mapDatabaseIdentity, mapPageChangeIdentity } from '../../state/pages/identity';
import { PageApiError, pagesFetch, readPagesJson, type PageApiOptions } from './pages';

// A workspace's task database: its id to draw a task board with, and the one
// call that makes it the first time. Kept apart from pages.ts so the page
// views that mock that module keep working.

const path = (options: PageApiOptions) =>
  `${backendApiBase(options.backendConnectionId)}/workspaces/${encodeURIComponent(serverEntityId(options.workspaceId, options.backendConnectionId))}/task-database`;

async function answer<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload: unknown = await readPagesJson(response).catch(() => null);
    const envelope = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined;
    const error = envelope && typeof envelope === 'object' ? envelope as { code?: unknown; message?: unknown } : {};
    throw new PageApiError(
      response.status,
      typeof error.code === 'string' ? error.code : 'task_database_request_failed',
      typeof error.message === 'string' ? error.message : `Task database request failed (${response.status})`,
    );
  }
  return await readPagesJson(response) as T;
}

/** The workspace's task database id, or null before it has one. */
export async function fetchTaskDatabaseId(options: PageApiOptions): Promise<string | null> {
  const body = await answer<{ databaseId?: string | null }>(await pagesFetch(path(options), options.signal ? { signal: options.signal } : {}));
  return typeof body.databaseId === 'string' ? backendEntityId(options.backendConnectionId, body.databaseId) : null;
}

/** The workspace's task database, made with its core columns and views the first time. */
export async function openTaskDatabase(options: PageApiOptions): Promise<{ database: PageDatabase; created: boolean }> {
  const body = await answer<{ database: PageDatabase; created?: boolean }>(await pagesFetch(path(options), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    ...(options.signal ? { signal: options.signal } : {}),
  }));
  return { database: mapDatabaseIdentity(body.database, options.backendConnectionId, 'renderer'), created: body.created === true };
}

const databasePath = (options: PageApiOptions, databaseId: string) =>
  `${backendApiBase(options.backendConnectionId)}/databases/${encodeURIComponent(serverEntityId(databaseId, options.backendConnectionId))}`;
const init = (signal?: AbortSignal): RequestInit => (signal ? { signal } : {});

/**
 * What the Meta agent's upkeep did to a task database lately. Row ids stay as
 * the database's cells hold them; the suggestions and the conversation an
 * update read are mapped for this backend.
 */
export async function fetchTaskActivity(options: PageApiOptions & { databaseId: string }): Promise<TaskActivity> {
  const connection = options.backendConnectionId;
  const body = await answer<Partial<TaskActivity>>(await pagesFetch(`${databasePath(options, options.databaseId)}/task-activity`, init(options.signal)));
  const upkeep = body.latestUpkeep ?? null;
  return {
    suggestions: (body.suggestions ?? []).map((change) => mapPageChangeIdentity(change, connection, 'renderer')),
    marks: body.marks ?? [],
    latestUpkeep: upkeep && { ...upkeep, source: upkeep.source && { ...upkeep.source, nodeId: backendEntityId(connection, upkeep.source.nodeId) } },
  };
}

/** Who made a task and when; null when Michi has no record of it. */
export async function fetchTaskOrigin(options: PageApiOptions & { databaseId: string; rowId: string }): Promise<TaskOrigin | null> {
  const body = await answer<{ origin?: TaskOrigin | null }>(await pagesFetch(
    `${databasePath(options, options.databaseId)}/rows/${encodeURIComponent(options.rowId)}/origin`, init(options.signal)));
  return body.origin ?? null;
}

/** Every task database on this computer, for All tasks. */
export async function fetchAllTasks(signal?: AbortSignal): Promise<AllTasksDto> {
  return answer<AllTasksDto>(await pagesFetch(`${backendApiBase('local')}/spaces-home/all-tasks`, init(signal)));
}

/** Saves a change to the person's All tasks views; refused (409) when they changed since `revision`. */
export async function saveAllTasksViews(input: { revision: number; ops: PageDatabaseEditOp[] }, signal?: AbortSignal): Promise<{ views: PageDatabaseView[]; viewsRevision: number }> {
  return answer(await pagesFetch(`${backendApiBase('local')}/spaces-home/all-tasks/views`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    ...init(signal),
  }));
}
