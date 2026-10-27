import type {
  PageChangeDto,
  PageDatabase,
  PageDatabaseEditOp,
  PageDto,
  PageEditOp,
  PageActivitySeenRequest,
  PageSummaryDto,
  PageWriteResult,
  SpaceSummaryDto,
} from 'michi-shared';
import { parsePageBlockInput } from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';
import { backendEntityId, backendRequestUrl, connectionIdFromApiUrl, serverEntityId } from '../../config/backendIdentity';
import {
  backendConnectionGeneration,
  backendConnectionUnavailable,
  markBackendConnectionUnavailable,
} from '../../config/backendConnectionState';
import {
  mapDatabaseIdentity,
  mapHelperDescriptorIdentity,
  mapPageBlockIdentity,
  mapPageBlockInputIdentity,
  mapPageChangeIdentity,
  mapPageDatabaseViewIdentity,
  mapPageIdentity,
  mapPageSummaryIdentity,
  mapPageWriteIdentity,
  mapSpaceSummaryIdentity,
} from '../../state/pages/identity';

export class PageApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'PageApiError';
    this.status = status;
    this.code = code;
  }
}

export interface PageApiIdentity {
  backendConnectionId: string;
  workspaceId: string;
}

export interface PageHelperDescriptor {
  workspaceId: string;
  treeId: string;
  nodeId: string;
}

export interface PageApiOptions extends PageApiIdentity {
  signal?: AbortSignal;
}

export interface PageListResult {
  items: PageSummaryDto[];
  nextCursor: string | null;
}

export interface PageChangesResult {
  changes: PageChangeDto[];
  nextAfter: number;
  nextBefore: number | null;
  hasMore: boolean;
}

export interface PageTrashEntry {
  deletionGroupId: string;
  deletedAt: number;
  root: PageDto;
  pages: PageSummaryDto[];
  databases: Array<{ id: string; title: string; deletedAt: number | null }>;
}

export interface PageDatabaseSummary {
  id: string;
  workspaceId: string;
  title: string;
  rowCount: number;
  updatedAt: number;
  /** `tasks`: the workspace's task database, counted on All tasks. */
  role?: 'tasks';
}

function rawId(id: string, connectionId: string): string {
  return serverEntityId(id, connectionId);
}

function pathId(id: string, connectionId: string): string {
  return encodeURIComponent(rawId(id, connectionId));
}

function opaquePathId(id: string): string {
  return encodeURIComponent(id);
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function unwrap<T>(answer: T | object, key: string): T | undefined {
  if (answer && typeof answer === 'object' && key in answer) {
    return (answer as Record<string, T | undefined>)[key];
  }
  return answer as T;
}

async function json<T>(url: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await pagesFetch(url, {
    ...(options.method ? { method: options.method } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options.body),
    }),
  });
  if (!response.ok) {
    const payload: unknown = await readPagesJson(response).catch(() => null);
    const envelope = payload && typeof payload === 'object'
      ? (payload as { error?: unknown }).error
      : undefined;
    const error = envelope && typeof envelope === 'object' ? envelope as { code?: unknown; message?: unknown } : {};
    throw new PageApiError(
      response.status,
      typeof error.code === 'string' ? error.code : 'page_request_failed',
      typeof error.message === 'string' ? error.message : `Pages request failed (${response.status})`,
    );
  }
  return await readPagesJson(response) as T;
}

// Pages block/row/column/view `id` fields are opaque within an owned resource.
// backendFetch's generic body transform interprets every JSON `id` as an
// entity ID, so this API applies its structural DTO mapping itself and avoids
// that second broad conversion.
const responseGeneration = new WeakMap<Response, { connectionId: string; generation: number; signal?: AbortSignal }>();

export async function pagesFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const connectionId = connectionIdFromApiUrl(url);
  const generation = backendConnectionGeneration(connectionId);
  if (backendConnectionUnavailable(connectionId) && options.method && options.method !== 'GET') {
    throw new Error('Remote connection is unavailable');
  }
  let response: Response;
  try {
    response = await globalThis.fetch(backendRequestUrl(url), options);
  } catch (error) {
    if (error instanceof TypeError) markBackendConnectionUnavailable(connectionId);
    throw error;
  }
  if ([502, 503, 504].includes(response.status)) markBackendConnectionUnavailable(connectionId);
  responseGeneration.set(response, { connectionId, generation, signal: options.signal ?? undefined });
  return response;
}

export async function readPagesJson(response: Response): Promise<unknown> {
  const captured = responseGeneration.get(response);
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    if (error instanceof TypeError && !captured?.signal?.aborted && captured) {
      markBackendConnectionUnavailable(captured.connectionId);
    }
    throw error;
  }
  if (captured && captured.generation !== backendConnectionGeneration(captured.connectionId)) {
    throw new DOMException('Remote connection changed while reading data', 'AbortError');
  }
  return value;
}

function base(connectionId: string): string {
  return `${backendApiBase(connectionId)}`;
}

export async function fetchSpaces(connectionId: string, signal?: AbortSignal): Promise<SpaceSummaryDto[]> {
  const spaces: SpaceSummaryDto[] = [];
  let cursor: string | undefined;
  do {
    const answer = await json<{ items?: SpaceSummaryDto[]; nextCursor?: string | null }>(
      `${base(connectionId)}/spaces${query({ cursor })}`,
      { signal },
    );
    spaces.push(...(answer.items ?? []).map((space) => mapSpaceSummaryIdentity(space, connectionId, 'renderer')));
    cursor = answer.nextCursor ?? undefined;
  } while (cursor);
  return spaces;
}

export async function listPages(
  workspaceId: string,
  options: PageApiOptions & { cursor?: string } ,
): Promise<PageListResult> {
  const { backendConnectionId: connectionId, signal } = options;
  const answer = await json<{ items?: PageSummaryDto[]; nextCursor?: string | null }>(
    `${base(connectionId)}/workspaces/${pathId(workspaceId, connectionId)}/pages${query({ cursor: options.cursor })}`,
    { signal },
  );
  return {
    items: (answer.items ?? []).map((page) => mapPageSummaryIdentity(page, connectionId, 'renderer')),
    nextCursor: answer.nextCursor ?? null,
  };
}

export async function createPage(body: {
  workspaceId: string;
  title: string;
  parentId?: string | null;
  template?: string;
}, options: PageApiOptions): Promise<PageSummaryDto> {
  const connectionId = options.backendConnectionId;
  const pathWorkspaceId = body.workspaceId || options.workspaceId;
  const serverBody = {
    title: body.title,
    ...(body.template === undefined ? {} : { template: body.template }),
    ...(body.parentId === undefined ? {} : {
      parentId: body.parentId === null ? null : rawId(body.parentId, connectionId),
    }),
  };
  const answer = await json<{ page?: PageSummaryDto } | PageSummaryDto>(
    `${base(connectionId)}/workspaces/${pathId(pathWorkspaceId, connectionId)}/pages`,
    { method: 'POST', body: serverBody, signal: options.signal },
  );
  const page = unwrap<PageSummaryDto>(answer, 'page');
  if (!page) throw new Error('Pages returned an empty page creation result');
  return mapPageSummaryIdentity(page, connectionId, 'renderer');
}

export async function fetchPage(
  pageId: string,
  options: PageApiOptions & { since?: number },
): Promise<PageDto | null> {
  const { backendConnectionId: connectionId, signal } = options;
  const response = await pagesFetch(`${base(connectionId)}/pages/${pathId(pageId, connectionId)}${query({ since: options.since })}`, { signal });
  if (response.status === 204) return null;
  if (!response.ok) return await throwPageError(response);
  const answer = await readPagesJson(response) as { page?: PageDto } | PageDto;
  const page = unwrap<PageDto>(answer, 'page');
  if (!page) throw new Error('Pages returned an empty page response');
  return mapPageIdentity(page, connectionId, 'renderer');
}

export async function patchPage(pageId: string, body: {
  revision: number; title?: string; color?: string | null; parentId?: string | null; position?: number;
}, options: PageApiOptions): Promise<PageSummaryDto> {
  const connectionId = options.backendConnectionId;
  const serverBody = { ...body, ...(body.parentId === undefined ? {} : { parentId: body.parentId === null ? null : rawId(body.parentId, connectionId) }) };
  const answer = await json<{ page?: PageSummaryDto } | PageSummaryDto>(
    `${base(connectionId)}/pages/${pathId(pageId, connectionId)}`,
    { method: 'PATCH', body: serverBody, signal: options.signal },
  );
  const page = unwrap<PageSummaryDto>(answer, 'page');
  if (!page) throw new Error('Pages returned an empty page update');
  return mapPageSummaryIdentity(page, connectionId, 'renderer');
}

export async function deletePage(pageId: string, options: PageApiOptions): Promise<unknown> {
  return json(`${base(options.backendConnectionId)}/pages/${pathId(pageId, options.backendConnectionId)}`, { method: 'DELETE', signal: options.signal });
}

export async function restorePage(pageId: string, options: PageApiOptions): Promise<unknown> {
  return json(`${base(options.backendConnectionId)}/pages/${pathId(pageId, options.backendConnectionId)}/restore`, { method: 'POST', body: {}, signal: options.signal });
}

export async function purgePage(pageId: string, options: PageApiOptions): Promise<unknown> {
  return json(`${base(options.backendConnectionId)}/pages/${pathId(pageId, options.backendConnectionId)}/permanent`, { method: 'DELETE', signal: options.signal });
}

export async function listPageTrash(workspaceId: string, options: PageApiOptions): Promise<PageTrashEntry[]> {
  const groups: Array<Omit<PageTrashEntry, 'root' | 'pages' | 'deletionGroupId'> & { deletionGroupId: string; root: PageDto; pages: PageSummaryDto[] }> = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const answer = await json<{ items?: typeof groups; nextCursor?: string | null }>(
      `${base(options.backendConnectionId)}/workspaces/${pathId(workspaceId, options.backendConnectionId)}/pages/trash${query({ cursor })}`,
      { signal: options.signal },
    );
    groups.push(...(answer.items ?? []));
    cursor = answer.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error('Pages trash pagination did not advance');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return groups.map((group) => ({
    ...group,
    deletionGroupId: backendEntityId(options.backendConnectionId, group.deletionGroupId),
    root: mapPageIdentity(group.root, options.backendConnectionId, 'renderer'),
    pages: group.pages.map((page) => mapPageSummaryIdentity(page, options.backendConnectionId, 'renderer')),
    databases: group.databases.map((database) => ({
      ...database,
      id: backendEntityId(options.backendConnectionId, database.id),
    })),
  }));
}

export async function editPage(pageId: string, body: { revision: number; ops: PageEditOp[] }, options: PageApiOptions): Promise<{ page: PageDto; changes: PageWriteResult }> {
  const connectionId = options.backendConnectionId;
  const serverOps = body.ops.map((op) => op.op === 'update' || op.op === 'insert'
    ? { ...op, block: mapPageBlockInputIdentity(op.block, connectionId, 'server') }
    : op);
  const answer = await json<{ page: PageDto; changes: PageWriteResult }>(
    `${base(connectionId)}/pages/${pathId(pageId, connectionId)}/edits`,
    { method: 'POST', body: { ...body, ops: serverOps }, signal: options.signal },
  );
  return {
    page: mapPageIdentity(answer.page, connectionId, 'renderer'),
    changes: mapPageWriteIdentity(answer.changes, connectionId, 'renderer'),
  };
}

export async function listPageChanges(
  pageId: string,
  options: PageApiOptions & { afterSeq?: number; beforeSeq?: number; direction?: 'forward' | 'backward'; limit?: number; proposalState?: string; applicationState?: string },
): Promise<PageChangesResult> {
  const connectionId = options.backendConnectionId;
  const answer = await json<{ changes?: PageChangeDto[]; nextAfter?: number | null; nextBefore?: number | null; hasMore?: boolean }>(
    `${base(connectionId)}/pages/${pathId(pageId, connectionId)}/changes${query({
      afterSeq: options.afterSeq,
      beforeSeq: options.beforeSeq,
      direction: options.direction,
      limit: options.limit,
      proposalState: options.proposalState,
      applicationState: options.applicationState,
    })}`,
    { signal: options.signal },
  );
  return {
    changes: (answer.changes ?? []).map((change) => mapPageChangeIdentity(change, connectionId, 'renderer')),
    nextAfter: answer.nextAfter ?? options.afterSeq ?? 0,
    nextBefore: answer.nextBefore ?? null,
    hasMore: answer.hasMore === true,
  };
}

export async function fetchPageActivitySeen(pageId: string, options: PageApiOptions): Promise<{ lastSeenChangeSeq: number }> {
  return json(`${base(options.backendConnectionId)}/pages/${pathId(pageId, options.backendConnectionId)}/activity-seen`, { signal: options.signal });
}

export async function acknowledgePageActivity(pageId: string, throughSeq: number, options: PageApiOptions): Promise<{ lastSeenChangeSeq: number }> {
  return json(`${base(options.backendConnectionId)}/pages/${pathId(pageId, options.backendConnectionId)}/activity-seen`, {
    method: 'POST', body: { lastSeenChangeSeq: throughSeq } satisfies PageActivitySeenRequest, signal: options.signal,
  });
}

export async function ensurePageHelper(pageId: string, options: PageApiOptions): Promise<PageHelperDescriptor> {
  const answer = await json<PageHelperDescriptor | { helper: PageHelperDescriptor }>(
    `${base(options.backendConnectionId)}/pages/${pathId(pageId, options.backendConnectionId)}/helper`,
    { method: 'POST', body: {}, signal: options.signal },
  );
  const descriptor = unwrap<PageHelperDescriptor>(answer, 'helper');
  if (!descriptor) throw new Error('Pages returned an empty helper descriptor');
  return mapHelperDescriptorIdentity(descriptor, options.backendConnectionId, 'renderer');
}

export async function promotePageHelper(pageId: string, options: PageApiOptions): Promise<PageHelperDescriptor> {
  const answer = await json<PageHelperDescriptor | { helper: PageHelperDescriptor }>(
    `${base(options.backendConnectionId)}/pages/${pathId(pageId, options.backendConnectionId)}/helper/promote`,
    { method: 'POST', body: {}, signal: options.signal },
  );
  const descriptor = unwrap<PageHelperDescriptor>(answer, 'helper');
  if (!descriptor) throw new Error('Pages returned an empty helper descriptor');
  return mapHelperDescriptorIdentity(descriptor, options.backendConnectionId, 'renderer');
}

export type PageChangeAction = 'revert' | 'redo' | 'accept' | 'dismiss' | 'reopen';
/** An edited block goes to its backend with that backend's own ids for the pages, databases, components and conversations it names. */
function serverEditedContent(edited: unknown, connectionId: string): unknown {
  if (!edited || typeof edited !== 'object' || (edited as { kind?: unknown }).kind !== 'block') return edited;
  const { block } = edited as { block?: unknown };
  const parsed = parsePageBlockInput(block);
  return parsed ? { ...edited, block: mapPageBlockInputIdentity(parsed, connectionId, 'server') } : edited;
}

export async function changePageChange(changeId: string, action: PageChangeAction, options: PageApiOptions, body?: { editedContent?: unknown }): Promise<PageChangeDto> {
  const sent = body && body.editedContent !== undefined
    ? { ...body, editedContent: serverEditedContent(body.editedContent, options.backendConnectionId) } : body;
  const answer = await json<{ change?: PageChangeDto } | PageChangeDto>(
    `${base(options.backendConnectionId)}/page-changes/${opaquePathId(changeId)}/${action}`,
    { method: 'POST', body: sent ?? {}, signal: options.signal },
  );
  const change = unwrap<PageChangeDto>(answer, 'change');
  if (!change) throw new Error('Pages returned an empty change response');
  return mapPageChangeIdentity(change, options.backendConnectionId, 'renderer');
}

async function postPageBatch(action: 'revert' | 'redo', batchId: string, options: PageApiOptions): Promise<{ done: string[]; conflicts: Array<{ changeId: string; message: string }> }> {
  const answer = await json<{ reverted?: unknown[]; redone?: unknown[]; conflicts?: unknown[] }>(
    `${base(options.backendConnectionId)}/page-batches/${opaquePathId(batchId)}/${action}`,
    { method: 'POST', body: {}, signal: options.signal },
  );
  const done = ((action === 'revert' ? answer.reverted : answer.redone) ?? []).filter((id): id is string => typeof id === 'string');
  const conflicts = (answer.conflicts ?? []).flatMap((item) => {
    const row = item && typeof item === 'object' ? item as { changeId?: unknown; message?: unknown } : null;
    return row && typeof row.changeId === 'string' ? [{ changeId: row.changeId, message: typeof row.message === 'string' ? row.message : '' }] : [];
  });
  return { done, conflicts };
}

/** The backend answers with the ids it reverted and the changes it could not revert cleanly. */
export async function revertPageBatch(batchId: string, options: PageApiOptions): Promise<{ reverted: string[]; conflicts: Array<{ changeId: string; message: string }> }> {
  const { done, conflicts } = await postPageBatch('revert', batchId, options);
  return { reverted: done, conflicts };
}

/** How many of a batch's changes are applied and how many are reverted now. */
export async function fetchPageBatchState(batchId: string, options: PageApiOptions): Promise<{ applied: number; reverted: number }> {
  const answer = await json<{ applied?: unknown; reverted?: unknown }>(
    `${base(options.backendConnectionId)}/page-batches/${opaquePathId(batchId)}`,
    { signal: options.signal },
  );
  return {
    applied: typeof answer.applied === 'number' ? answer.applied : 0,
    reverted: typeof answer.reverted === 'number' ? answer.reverted : 0,
  };
}

/** Puts back what `revertPageBatch` undid: the ids it redid and the changes that no longer apply. */
export async function redoPageBatch(batchId: string, options: PageApiOptions): Promise<{ redone: string[]; conflicts: Array<{ changeId: string; message: string }> }> {
  const { done, conflicts } = await postPageBatch('redo', batchId, options);
  return { redone: done, conflicts };
}

export async function listWorkspaceDatabases(workspaceId: string, options: PageApiOptions): Promise<PageDatabaseSummary[]> {
  const answer = await json<{ items?: PageDatabaseSummary[] }>(
    `${base(options.backendConnectionId)}/workspaces/${pathId(workspaceId, options.backendConnectionId)}/databases`,
    { signal: options.signal },
  );
  return (answer.items ?? []).map((db) => ({
    ...db,
    id: mapDatabaseIdentity({ ...db, columns: [], rows: [], views: [], revision: 0 } as PageDatabase, options.backendConnectionId, 'renderer').id,
    workspaceId: mapDatabaseIdentity({ ...db, columns: [], rows: [], views: [], revision: 0 } as PageDatabase, options.backendConnectionId, 'renderer').workspaceId,
  }));
}

export async function createWorkspaceDatabase(workspaceId: string, body: { title: string; columns?: PageDatabase['columns']; views?: PageDatabase['views'] }, options: PageApiOptions): Promise<{ database: PageDatabase; changes: PageWriteResult | null }> {
  const serverBody = {
    ...body,
    ...(body.views ? { views: body.views.map((view) => mapPageDatabaseViewIdentity(view, options.backendConnectionId, 'server')) } : {}),
  };
  const answer = await json<{ database: PageDatabase; changes?: PageWriteResult }>(
    `${base(options.backendConnectionId)}/workspaces/${pathId(workspaceId, options.backendConnectionId)}/databases`,
    { method: 'POST', body: serverBody, signal: options.signal },
  );
  return {
    database: mapDatabaseIdentity(answer.database, options.backendConnectionId, 'renderer'),
    changes: answer.changes ? mapPageWriteIdentity(answer.changes, options.backendConnectionId, 'renderer') : null,
  };
}

export async function fetchPageDatabase(databaseId: string, options: PageApiOptions & { since?: number }): Promise<PageDatabase | null> {
  const connectionId = options.backendConnectionId;
  const response = await pagesFetch(`${base(connectionId)}/databases/${pathId(databaseId, connectionId)}${query({ since: options.since })}`, { signal: options.signal });
  if (response.status === 204) return null;
  if (!response.ok) return await throwPageError(response);
  const answer = await readPagesJson(response) as { database?: PageDatabase } | PageDatabase;
  const database = unwrap<PageDatabase>(answer, 'database');
  return database ? mapDatabaseIdentity(database, connectionId, 'renderer') : null;
}

export async function editPageDatabase(databaseId: string, body: { revision: number; ops: PageDatabaseEditOp[] }, options: PageApiOptions): Promise<{ database: PageDatabase; changes: PageWriteResult }> {
  const connectionId = options.backendConnectionId;
  const serverOps = body.ops.map((op) => op.op === 'view.save'
    ? { ...op, view: mapPageDatabaseViewIdentity(op.view as PageDatabase['views'][number], connectionId, 'server') }
    : op);
  const answer = await json<{ database: PageDatabase; changes: PageWriteResult }>(
    `${base(connectionId)}/databases/${pathId(databaseId, connectionId)}/edits`,
    { method: 'POST', body: { ...body, ops: serverOps }, signal: options.signal },
  );
  return {
    database: mapDatabaseIdentity(answer.database, connectionId, 'renderer'),
    changes: mapPageWriteIdentity(answer.changes, connectionId, 'renderer'),
  };
}

async function throwPageError(response: Response): Promise<never> {
  const payload: unknown = await response.json().catch(() => null);
  const envelope = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined;
  const error = envelope && typeof envelope === 'object' ? envelope as { code?: unknown; message?: unknown } : {};
  throw new PageApiError(
    response.status,
    typeof error.code === 'string' ? error.code : 'page_request_failed',
    typeof error.message === 'string' ? error.message : `Pages request failed (${response.status})`,
  );
}
