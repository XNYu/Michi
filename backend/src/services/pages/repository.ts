import { getDb } from '../db';
import { workspaceOwnerMatches } from '../agentOwner';
import { PageWriteError, pagesTransaction, invalidatePages, newPageId, requirePagesWorkspace, requireChatChangeSource, type ChatChangeSource } from './core';
import { isAssistantWorkspaceSettings, isSystemWorkspaceSettings } from 'michi-shared';
import type { PagesWorkspace } from './core';
import {
  parsePageBlock, type PageBlock, type PageBlockInput,
  containsTaskView, databaseRoleProblem, TASK_DATABASE_ROLE, type PageDatabaseRole,
  taskThreadIds, TASK_COLUMN, TASK_LIMITS,
  applyPageDatabaseOps, parsePageDatabaseOps, type PageDatabase, type PageDatabaseRow,
  materializePageTemplate, type PageTemplateKey, PAGE_LIMITS, MICHI_DB_LIMITS,
  type PageDto, type PageSummaryDto, type SpaceSummaryDto, type ChangeSource,
} from 'michi-shared';
import { pinHumanDatabaseViews, pinHumanPageComponentBlocks, saveDatabaseComponentReferences, savePageComponentReferences } from './componentReferences';

type PageRow = {
  id: string; owner_user_id: string; workspace_id: string; parent_id: string | null; position: number;
  title: string; color: string | null; blocks: string; revision: number; view_version: number;
  helper_node_id: string | null; updated_at: number; updated_by: 'user' | 'agent'; created_at: number;
  deleted_at: number | null; deletion_group_id: string | null;
  role: 'spaces-home' | 'workspace-home' | null; layout_rules: string; hidden_at: number | null;
};
type DatabaseRow = {
  id: string; owner_user_id: string; workspace_id: string; title: string; columns_json: string; views_json: string;
  revision: number; updated_at: number; created_at: number; deleted_at: number | null; deletion_group_id: string | null;
  role: PageDatabaseRole | null;
};

export type PageRecord = PageRow;
export interface PageListOptions { parentId?: string | null; limit?: number; cursor?: string | null }
export interface SpaceListOptions { workspaceId?: string; limit?: number; cursor?: string | null }
export interface PageTrashOptions { limit?: number; cursor?: string | null }
export interface PageTrashGroup {
  deletionGroupId: string; deletedAt: number; root: PageDto; pages: PageSummaryDto[];
  databases: Array<{ id: string; title: string; deletedAt: number }>;
}
export interface PageTrashResult { items: PageTrashGroup[]; nextCursor: string | null }
export interface PageCreateInput {
  workspaceId: string; ownerUserId: string; parentId?: string | null; title: string;
  template?: PageTemplateKey; now?: number; source?: ChatChangeSource;
}
export interface DatabaseCreateInput {
  workspaceId: string; ownerUserId: string; title: string; columns?: PageDatabase['columns'];
  views?: PageDatabase['views']; rows?: PageDatabaseRow[]; now?: number;
  /** Only the task database (taskDatabase.ts) has one. */
  role?: PageDatabaseRole;
}
export interface PageMetadataPatch {
  title?: string; color?: string | null; parentId?: string | null; position?: number;
}
export interface SavePageContentOptions { source: ChangeSource; now: number; expectedRevision?: number }
export interface SaveDatabaseOptions {
  now?: number;
  actor?: 'user' | 'agent';
  /** Restoring recorded state (change history): links already recorded need not be live conversations of the workspace now. */
  restore?: boolean;
}

const db = () => getDb();
const ownerRequired = (owner: string): void => { if (!owner?.trim()) throw new PageWriteError(404, 'not_found', 'Resource not found'); };
const safeNow = (value?: number): number => {
  const now = value ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new PageWriteError(400, 'invalid', 'Invalid timestamp');
  return now;
};
const json = (value: unknown): string => JSON.stringify(value);
const parseJson = <T>(value: string): T => JSON.parse(value) as T;
const compare = <T>(a: T, b: T): boolean => json(a) === json(b);

function decodeBlocks(raw: string): PageBlock[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new PageWriteError(409, 'invalid', 'Stored page content is invalid'); }
  if (!Array.isArray(value)) throw new PageWriteError(409, 'invalid', 'Stored page content is invalid');
  const blocks: PageBlock[] = [];
  for (const block of value) {
    const parsed = parsePageBlock(block);
    if (!parsed) throw new PageWriteError(409, 'invalid', 'Stored page content is invalid');
    blocks.push(parsed);
  }
  return blocks;
}

function pageDto(row: PageRow): PageDto {
  return {
    id: row.id, workspaceId: row.workspace_id, parentId: row.parent_id, position: row.position,
    title: row.title, color: row.color, updatedAt: row.updated_at, updatedBy: row.updated_by,
    pendingProposals: pendingCount(row.id), helperNodeId: row.helper_node_id,
    revision: row.revision, viewVersion: row.view_version, blocks: decodeBlocks(row.blocks),
  };
}

function summary(row: PageRow): PageSummaryDto {
  return {
    id: row.id, workspaceId: row.workspace_id, parentId: row.parent_id, position: row.position,
    title: row.title, color: row.color, updatedAt: row.updated_at, updatedBy: row.updated_by,
    pendingProposals: pendingCount(row.id), helperNodeId: row.helper_node_id,
  };
}

function pendingCount(pageId: string): number {
  const result = db().prepare(`SELECT COUNT(DISTINCT c.id) AS count FROM page_changes c
    WHERE c.proposal_state='pending' AND (c.page_id=? OR c.database_id IN
      (SELECT database_id FROM page_database_refs WHERE page_id=?))`).get(pageId, pageId) as { count: number } | undefined;
  return result?.count ?? 0;
}

function accessiblePage(pageId: string, ownerUserId: string, includeDeleted = false, write = false): PageRow {
  ownerRequired(ownerUserId);
  const row = db().prepare('SELECT * FROM pages WHERE id=? AND owner_user_id=?').get(pageId, ownerUserId) as PageRow | undefined;
  if (!row || (!includeDeleted && row.deleted_at !== null)) throw new PageWriteError(404, 'not_found', 'Page not found');
  requirePagesWorkspace(row.workspace_id, ownerUserId, write);
  return row;
}

export function pageRecord(pageId: string, ownerUserId: string, options: { includeDeleted?: boolean; write?: boolean } = {}): PageRecord {
  return accessiblePage(pageId, ownerUserId, options.includeDeleted, options.write);
}

export function requirePageRecord(pageId: string, ownerUserId: string, options: { includeDeleted?: boolean; write?: boolean } = {}): PageRecord {
  return pageRecord(pageId, ownerUserId, options);
}

export function getPage(pageId: string, ownerUserId: string, options: { includeDeleted?: boolean; write?: boolean } = {}): PageDto {
  return pageDto(accessiblePage(pageId, ownerUserId, options.includeDeleted, options.write));
}

export function getMaintenancePageBlocks(pageId: string, ownerUserId: string, options: { offset?: number; limit?: number } = {}) {
  const page = getPage(pageId, ownerUserId);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new PageWriteError(400, 'invalid', 'Maintenance page reads require a valid offset and a limit from 1 to 20');
  }
  const blocks = page.blocks.slice(offset, offset + limit);
  const result = { page: { ...page, blocks }, blockCount: page.blocks.length,
    nextOffset: offset + blocks.length < page.blocks.length ? offset + blocks.length : null };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 64 * 1024) {
    throw new PageWriteError(400, 'invalid', 'Requested page block range exceeds the 64 KB maintenance read limit; request a smaller block range');
  }
  return result;
}

function decodeDatabase(row: DatabaseRow): PageDatabase {
  const rows = db().prepare('SELECT id,position,values_json,body,rev,edited,body_edited_at,updated_at FROM page_database_rows WHERE database_id=? ORDER BY position,id').all(row.id) as unknown as Array<{
    id: string; position: number; values_json: string; body: string | null; rev: number; edited: string; body_edited_at: number | null; updated_at: number;
  }>;
  return {
    id: row.id, workspaceId: row.workspace_id, ...(row.role === TASK_DATABASE_ROLE ? { role: TASK_DATABASE_ROLE } : {}), title: row.title,
    columns: parseJson(row.columns_json), views: parseJson(row.views_json), revision: row.revision, updatedAt: row.updated_at,
    rows: rows.map((item) => ({ id: item.id, position: item.position, values: parseJson(item.values_json), ...(item.body === null ? {} : { body: item.body }), rev: item.rev, edited: parseJson(item.edited), bodyEditedAt: item.body_edited_at, updatedAt: item.updated_at })),
  };
}

function accessibleDatabase(databaseId: string, ownerUserId: string, includeDeleted = false, write = false): DatabaseRow {
  ownerRequired(ownerUserId);
  const row = db().prepare('SELECT * FROM page_databases WHERE id=? AND owner_user_id=?').get(databaseId, ownerUserId) as DatabaseRow | undefined;
  if (!row || (!includeDeleted && row.deleted_at !== null)) throw new PageWriteError(404, 'not_found', 'Database not found');
  requirePagesWorkspace(row.workspace_id, ownerUserId, write);
  return row;
}

export function requireDatabaseRecord(databaseId: string, ownerUserId: string, options: { includeDeleted?: boolean; write?: boolean } = {}): DatabaseRow {
  return accessibleDatabase(databaseId, ownerUserId, options.includeDeleted, options.write);
}

export function getDatabase(databaseId: string, ownerUserId: string, options: { includeDeleted?: boolean; write?: boolean } = {}): PageDatabase {
  return decodeDatabase(accessibleDatabase(databaseId, ownerUserId, options.includeDeleted, options.write));
}

export interface MaintenanceDatabaseReadOptions {
  cursor?: string | null;
  limit?: number;
  columnIds?: string[];
  includeBodies?: boolean;
}
const MAINTENANCE_DATABASE_READ_MAX_BYTES = 64 * 1024;
const MAINTENANCE_DATABASE_READ_MAX_ROWS = 5;
const MAINTENANCE_DATABASE_READ_MAX_COLUMNS = 4;

/** Bounded projection for unattended maintenance; never decodes a whole database. */
export function getMaintenanceDatabasePage(databaseId: string, ownerUserId: string, options: MaintenanceDatabaseReadOptions = {}) {
  const database = accessibleDatabase(databaseId, ownerUserId);
  const limit = options.limit ?? 5;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAINTENANCE_DATABASE_READ_MAX_ROWS) {
    throw new PageWriteError(400, 'invalid', `Maintenance database reads are limited to ${MAINTENANCE_DATABASE_READ_MAX_ROWS} rows`);
  }
  if (options.includeBodies !== undefined && typeof options.includeBodies !== 'boolean') throw new PageWriteError(400, 'invalid', 'Invalid includeBodies flag');
  const cursor = options.cursor ? /^([0-9]+):(.{1,200})$/.exec(options.cursor) : null;
  if (options.cursor && (!cursor || !Number.isSafeInteger(Number(cursor[1])))) throw new PageWriteError(400, 'invalid', 'Invalid database row cursor');
  const columns = parseJson<PageDatabase['columns']>(database.columns_json);
  const columnIds = options.columnIds ?? columns.slice(0, MAINTENANCE_DATABASE_READ_MAX_COLUMNS).map((column) => column.id);
  if (!Array.isArray(columnIds) || columnIds.length > MAINTENANCE_DATABASE_READ_MAX_COLUMNS || (columns.length > 0 && columnIds.length < 1) ||
      columnIds.some((id) => typeof id !== 'string' || !columns.some((column) => column.id === id)) || new Set(columnIds).size !== columnIds.length) {
    throw new PageWriteError(400, 'invalid', `Select 1-${MAINTENANCE_DATABASE_READ_MAX_COLUMNS} unique column IDs from this database`);
  }
  const params: Array<string | number> = [database.id];
  const afterClause = cursor ? ' AND (position>? OR (position=? AND id>?))' : '';
  if (cursor) params.push(Number(cursor[1]), Number(cursor[1]), cursor[2]!);
  params.push(limit + 1);
  const rows = db().prepare(`SELECT id,position,values_json,body,rev,edited,body_edited_at,updated_at
    FROM page_database_rows WHERE database_id=?${afterClause} ORDER BY position,id LIMIT ?`).all(...params) as unknown as Array<{
      id: string; position: number; values_json: string; body: string | null; rev: number; edited: string; body_edited_at: number | null; updated_at: number;
    }>;
  const rowCount = (db().prepare('SELECT COUNT(*) AS n FROM page_database_rows WHERE database_id=?').get(database.id) as { n: number }).n;
  const hasMore = rows.length > limit;
  const project = (row: typeof rows[number]) => {
    const values = parseJson<Record<string, unknown>>(row.values_json);
    return { id: row.id, position: row.position,
      values: Object.fromEntries(columnIds.filter((id) => Object.hasOwn(values, id)).map((id) => [id, values[id]])),
      ...(options.includeBodies && row.body !== null ? { body: row.body } : {}),
      rev: row.rev, updatedAt: row.updated_at };
  };
  let selected = rows.slice(0, limit).map(project);
  const metadata = {
    database: { id: database.id, workspaceId: database.workspace_id, title: database.title, revision: database.revision,
      updatedAt: database.updated_at, rowCount,
      columns: columns.map(({ id, name, type, editable }) => ({ id, name, type, ...(editable === undefined ? {} : { editable }) })),
      selectedColumnIds: columnIds },
  };
  const response = () => {
    const last = selected.at(-1);
    return { ...metadata, rows: selected, nextCursor: (hasMore || selected.length < Math.min(rows.length, limit)) && last
      ? `${last.position}:${last.id}` : null };
  };
  while (selected.length && Buffer.byteLength(JSON.stringify(response()), 'utf8') > MAINTENANCE_DATABASE_READ_MAX_BYTES) selected = selected.slice(0, -1);
  if (!selected.length && rows.length) throw new PageWriteError(400, 'invalid', 'Requested database projection exceeds the 64 KB read limit; select fewer columns or omit row bodies');
  const result = response();
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAINTENANCE_DATABASE_READ_MAX_BYTES) throw new PageWriteError(400, 'invalid', 'Database metadata exceeds the 64 KB maintenance read limit');
  return result;
}

function pageCursor(cursor?: string | null): { position: number; id: string } | null {
  if (!cursor) return null;
  const match = /^(\d+):(.{1,200})$/.exec(cursor);
  if (!match) throw new PageWriteError(400, 'invalid', 'Invalid page cursor');
  return { position: Number(match[1]), id: match[2] };
}
function makeCursor(position: number, id: string): string { return `${position}:${id}`; }
function listLimit(value?: number): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new PageWriteError(400, 'invalid', 'Invalid page limit');
  return value;
}

export function listPages(workspaceId: string, ownerUserId: string, options: PageListOptions = {}): { items: PageSummaryDto[]; nextCursor: string | null } {
  const workspace = requirePagesWorkspace(workspaceId, ownerUserId);
  const limit = listLimit(options.limit);
  if (options.parentId !== undefined && options.parentId !== null) {
    const parent = accessiblePage(options.parentId, ownerUserId);
    if (parent.workspace_id !== workspace.id) throw new PageWriteError(404, 'not_found', 'Page not found');
  }
  const cursor = pageCursor(options.cursor);
  const parentClause = options.parentId === undefined ? '' : ' AND parent_id IS ?';
  const cursorClause = cursor ? ' AND (position>? OR (position=? AND id>?))' : '';
  const params: Array<string | number | null> = [workspace.id, ...(options.parentId === undefined ? [] : [options.parentId]), ...(cursor ? [cursor.position, cursor.position, cursor.id] : []), limit + 1];
  const rows = db().prepare(`SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NULL${parentClause}${cursorClause} ORDER BY position,id LIMIT ?`).all(...params) as unknown as PageRow[];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(summary);
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? makeCursor(last.position, last.id) : null };
}

function pageDescendants(pageId: string, workspaceId: string): PageRow[] {
  return db().prepare(`WITH RECURSIVE tree(id) AS (
    SELECT id FROM pages WHERE id=? AND workspace_id=? AND deleted_at IS NULL
    UNION ALL SELECT p.id FROM pages p JOIN tree t ON p.parent_id=t.id WHERE p.deleted_at IS NULL AND p.workspace_id=?
  ) SELECT p.* FROM pages p JOIN tree t ON t.id=p.id ORDER BY p.position,p.id`).all(pageId, workspaceId, workspaceId) as unknown as PageRow[];
}

function contributors(pageIds: readonly string[]): string[] {
  if (!pageIds.length) return [];
  const placeholders = pageIds.map(() => '?').join(',');
  // Maintenance rows written before source_node_id named the conversation still hold the run's node; their evidence names the conversation.
  const rows = db().prepare(`SELECT DISTINCT COALESCE(json_extract(c.source,'$.evidence[0].nodeId'),c.source_node_id) AS nodeId FROM page_changes c
    WHERE c.source_node_id IS NOT NULL AND
    (c.page_id IN (${placeholders}) OR c.database_id IN (SELECT database_id FROM page_database_refs WHERE page_id IN (${placeholders})))
    ORDER BY nodeId`).all(...pageIds, ...pageIds) as unknown as Array<{ nodeId: string }>;
  return rows.map((row) => row.nodeId);
}

/** Suggestions waiting for review on these pages, or on a database they show. */
export function pendingProposalCount(pageIds: readonly string[]): number {
  if (!pageIds.length) return 0;
  const marks = pageIds.map(() => '?').join(',');
  const row = db().prepare(`SELECT COUNT(DISTINCT c.id) AS count FROM page_changes c WHERE c.proposal_state='pending' AND
    (c.page_id IN (${marks}) OR c.database_id IN (SELECT r.database_id FROM page_database_refs r WHERE r.page_id IN (${marks})))`).get(...pageIds, ...pageIds) as { count: number };
  return row.count;
}

/**
 * Who made a page: its first revision records the source that created it. A
 * conversation in the Meta agent's own workspace is the Meta agent's chat.
 */
function pageCreator(pageId: string): NonNullable<SpaceSummaryDto['createdBy']> {
  const row = db().prepare('SELECT source FROM page_revisions WHERE page_id=? AND revision=1').get(pageId) as { source: string } | undefined;
  const source = row ? parseJson<{ kind?: unknown; nodeId?: unknown }>(row.source) : null;
  if (!source || source.kind === 'user' || typeof source.nodeId !== 'string') return 'user';
  const node = db().prepare('SELECT w.settings FROM nodes n JOIN workspaces w ON w.id=n.workspace_id WHERE n.id=?').get(source.nodeId) as { settings: string | null } | undefined;
  return node && isAssistantWorkspaceSettings(node.settings) ? 'meta-agent' : 'agent';
}

function spaceSummary(root: PageRow, workspace: PagesWorkspace): SpaceSummaryDto {
  const subtree = pageDescendants(root.id, root.workspace_id);
  const ids = subtree.map((page) => page.id);
  const refCount = ids.length ? db().prepare(`SELECT COUNT(DISTINCT r.database_id) AS count FROM page_database_refs r JOIN page_databases d ON d.id=r.database_id
    WHERE r.page_id IN (${ids.map(() => '?').join(',')}) AND d.deleted_at IS NULL`).get(...ids) as { count: number } : { count: 0 };
  const childTitles = db().prepare('SELECT title FROM pages WHERE parent_id=? AND deleted_at IS NULL ORDER BY position,id').all(root.id) as unknown as Array<{ title: string }>;
  return { ...summary(root), pendingProposals: pendingProposalCount(ids), workspaceName: workspace.name, childTitles: childTitles.map((page) => page.title), pageCount: subtree.length,
    databaseCount: refCount.count, contributorNodeIds: contributors(ids), createdBy: pageCreator(root.id) };
}

export function listSpaces(ownerUserId: string, options: SpaceListOptions = {}): { items: SpaceSummaryDto[]; nextCursor: string | null } {
  ownerRequired(ownerUserId);
  if (options.workspaceId) requirePagesWorkspace(options.workspaceId, ownerUserId);
  const limit = listLimit(options.limit);
  const cursor = pageCursor(options.cursor);
  const workspaceClause = options.workspaceId ? ' AND p.workspace_id=?' : '';
  const cursorClause = cursor ? ' AND (p.position>? OR (p.position=? AND p.id>?))' : '';
  const params: Array<string | number> = [ownerUserId, ...(options.workspaceId ? [options.workspaceId] : []), ...(cursor ? [cursor.position, cursor.position, cursor.id] : []), limit + 1];
  const rows = db().prepare(`SELECT p.*,w.owner_user_id AS workspace_owner_user_id,w.settings AS workspace_settings FROM pages p JOIN workspaces w ON w.id=p.workspace_id WHERE p.owner_user_id=? AND p.parent_id IS NULL AND p.role IS NULL AND p.deleted_at IS NULL AND w.deleted_at IS NULL AND w.purged_at IS NULL${workspaceClause}${cursorClause} ORDER BY p.position,p.id`).all(...params.slice(0, -1)) as unknown as Array<PageRow & { workspace_owner_user_id: string | null; workspace_settings: string | null }>;
  const visible = rows.filter((row) => workspaceOwnerMatches(row.workspace_owner_user_id, ownerUserId) && !isSystemWorkspaceSettings(row.workspace_settings));
  const hasMore = visible.length > limit;
  const items = visible.slice(0, limit).map((row) => spaceSummary(row, requirePagesWorkspace(row.workspace_id, ownerUserId)));
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? makeCursor(last.position, last.id) : null };
}

export function listDatabases(workspaceId: string, ownerUserId: string, options: { includeDeleted?: boolean } = {}): PageDatabase[] {
  requirePagesWorkspace(workspaceId, ownerUserId);
  const rows = db().prepare(`SELECT * FROM page_databases WHERE workspace_id=? AND owner_user_id=?${options.includeDeleted ? '' : ' AND deleted_at IS NULL'} ORDER BY created_at,id`).all(workspaceId, ownerUserId) as unknown as DatabaseRow[];
  return rows.map(decodeDatabase);
}

/** The workspace's live task database, if it has one. Callers check workspace access. */
export function liveTaskDatabaseId(workspaceId: string, ownerUserId: string): string | null {
  const row = db().prepare("SELECT id FROM page_databases WHERE workspace_id=? AND owner_user_id=? AND role='tasks' AND deleted_at IS NULL")
    .get(workspaceId, ownerUserId) as { id: string } | undefined;
  return row?.id ?? null;
}

/** A system workspace holds only its Spaces Home page: no other page or database is created there. */
function requireContentWorkspace(workspaceId: string, ownerUserId: string): PagesWorkspace {
  const workspace = requirePagesWorkspace(workspaceId, ownerUserId, true);
  if (isSystemWorkspaceSettings(workspace.settings)) throw new PageWriteError(404, 'not_found', 'Workspace not found');
  return workspace;
}

function assertTitle(title: string): void {
  if (typeof title !== 'string' || !title.trim() || title.length > PAGE_LIMITS.title) throw new PageWriteError(400, 'invalid', 'Page title must contain 1 to 200 characters');
}

function nextPosition(workspaceId: string, parentId: string | null): number {
  const row = db().prepare('SELECT COALESCE(MAX(position),-1)+1 AS value FROM pages WHERE workspace_id=? AND parent_id IS ? AND deleted_at IS NULL').get(workspaceId, parentId) as { value: number };
  return row.value;
}

function writeDatabase(database: PageDatabase, ownerUserId: string, createdAt: number): void {
  db().prepare(`INSERT INTO page_databases(id,owner_user_id,workspace_id,title,columns_json,views_json,revision,updated_at,created_at,role)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(database.id, ownerUserId, database.workspaceId, database.title, json(database.columns), json(database.views), database.revision, database.updatedAt, createdAt, database.role ?? null);
  const insert = db().prepare(`INSERT INTO page_database_rows(database_id,id,position,values_json,body,rev,edited,body_edited_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const row of database.rows) insert.run(database.id, row.id, row.position, json(row.values), row.body ?? null, row.rev, json(row.edited), row.bodyEditedAt, row.updatedAt);
}

function saveRevision(page: PageDto, source: ChangeSource, now: number): void {
  const snapshot = { id: page.id, workspaceId: page.workspaceId, parentId: page.parentId, position: page.position, title: page.title, color: page.color,
    blocks: page.blocks, revision: page.revision, viewVersion: page.viewVersion, helperNodeId: page.helperNodeId, updatedAt: page.updatedAt, updatedBy: page.updatedBy };
  db().prepare('INSERT OR REPLACE INTO page_revisions(page_id,revision,snapshot,source,created_at) VALUES(?,?,?,?,?)').run(page.id, page.revision, json(snapshot), json(source), now);
}

function validateBlockList(blocks: unknown): PageBlock[] {
  if (!Array.isArray(blocks) || blocks.length > 40) throw new PageWriteError(400, 'invalid', 'Invalid page blocks');
  const result: PageBlock[] = [];
  const ids = new Set<string>();
  for (const value of blocks) {
    const block = parsePageBlock(value);
    if (!block || ids.has(block.id)) throw new PageWriteError(400, 'invalid', 'Invalid or duplicate page block');
    ids.add(block.id); result.push(block);
  }
  if (json(result).length > 1_000_000) throw new PageWriteError(400, 'invalid', 'Page content exceeds the size limit');
  return result;
}

export function replacePageDatabaseRefs(pageId: string, ownerUserId: string, blocks: readonly PageBlockInput[] | readonly PageBlock[], now = Date.now()): string[] {
  const page = accessiblePage(pageId, ownerUserId, false, true);
  const valid = validateBlockList(blocks);
  validatePageReferences(page.workspace_id, ownerUserId, valid);
  // A task board names no database: it shows the workspace's task database, wherever it sits on the page.
  const taskDatabaseId = containsTaskView(valid) ? liveTaskDatabaseId(page.workspace_id, ownerUserId) : null;
  const databaseIds = [...new Set([
    ...valid.filter((block) => block.type === 'database-ref').map((block) => block.databaseId),
    ...(taskDatabaseId ? [taskDatabaseId] : []),
  ])];
  const oldRows = db().prepare('SELECT database_id FROM page_database_refs WHERE page_id=? ORDER BY database_id').all(pageId) as unknown as Array<{ database_id: string }>;
  const oldIds = oldRows.map((row) => row.database_id);
  if (compare(oldIds, databaseIds)) return oldIds;
  db().prepare('DELETE FROM page_database_refs WHERE page_id=?').run(pageId);
  const insert = db().prepare('INSERT INTO page_database_refs(page_id,database_id) VALUES(?,?)');
  for (const id of databaseIds) insert.run(pageId, id);
  safeNow(now);
  return databaseIds;
}

/** Validate prospective page/database references without mutating the reference index. */
export function validatePageReferences(workspaceId: string, ownerUserId: string, blocks: readonly PageBlock[]): void {
  const workspace = requirePagesWorkspace(workspaceId, ownerUserId);
  for (const block of blocks) {
    if (block.type === 'database-ref') {
      const target = accessibleDatabase(block.databaseId, ownerUserId);
      if (target.workspace_id !== workspace.id) throw new PageWriteError(400, 'invalid', 'Database references must stay in the page workspace');
      if (block.viewId && !decodeDatabase(target).views.some((view) => view.id === block.viewId)) throw new PageWriteError(400, 'invalid', 'Database view does not exist');
    } else if (block.type === 'page-link') {
      const target = accessiblePage(block.pageId, ownerUserId);
      if (target.workspace_id !== workspace.id) throw new PageWriteError(400, 'invalid', 'Page links must stay in the page workspace');
    }
  }
}

/** The conversations a block names: thread cards, and the versions of a conflict. */
export function blockConversationIds(block: PageBlock | PageBlockInput): string[] {
  if (block.type === 'threads') return block.nodeIds;
  if (block.type === 'conflict') return block.options.flatMap((option) => (option.nodeId ? [option.nodeId] : []));
  return [];
}

/** Every conversation a page's blocks name. */
export function pageConversationIds(blocks: readonly PageBlock[]): Set<string> {
  return new Set(blocks.flatMap(blockConversationIds));
}

/**
 * A write may name, for the first time, only a conversation of the page's
 * workspace; with `live`, only one that is still a chat there. One the page
 * named already stays named wherever it went since (deleted, or moved to
 * another workspace): its card says it is no longer here, and the page stays
 * writable.
 */
export function validateConversationReferences(workspaceId: string, blocks: readonly PageBlock[], named: ReadonlySet<string>, live = false): void {
  const find = db().prepare('SELECT workspace_id,kind,deleted_at,purged_at FROM nodes WHERE id=?');
  for (const block of blocks) {
    for (const nodeId of blockConversationIds(block)) {
      if (named.has(nodeId)) continue;
      const node = find.get(nodeId) as { workspace_id: string; kind: string; deleted_at: number | null; purged_at: number | null } | undefined;
      if (node && node.workspace_id !== workspaceId) throw new PageWriteError(400, 'invalid', `Conversation ${nodeId} is in another workspace; a block names only conversations of its page's workspace`);
      if (live && (!node || node.kind !== 'chat' || node.deleted_at !== null || node.purged_at !== null)) {
        throw new PageWriteError(400, 'invalid', `Conversation ${nodeId} is not a conversation of this workspace`);
      }
    }
  }
}

export function createPage(input: PageCreateInput): PageDto {
  ownerRequired(input.ownerUserId);
  assertTitle(input.title);
  const now = safeNow(input.now);
  const workspace = requireContentWorkspace(input.workspaceId, input.ownerUserId);
  const source = input.source ?? { kind: 'user' as const };
  if (input.source) requireChatChangeSource(workspace.id, input.ownerUserId, input.source);
  const currentCount = db().prepare('SELECT COUNT(*) AS count FROM pages WHERE workspace_id=?').get(workspace.id) as { count: number };
  if (currentCount.count >= PAGE_LIMITS.pagesPerWorkspace) throw new PageWriteError(409, 'invalid', 'Workspace page limit reached');
  if (input.parentId !== undefined && input.parentId !== null) {
    const parent = accessiblePage(input.parentId, input.ownerUserId, false, true);
    if (parent.workspace_id !== workspace.id) throw new PageWriteError(404, 'not_found', 'Parent page not found');
  }
  return pagesTransaction(() => {
  const id = newPageId('pg');
  const template = materializePageTemplate(input.template ?? 'blank', {
    workspaceId: workspace.id, now,
    idFactory: (kind) => kind === 'database' ? newPageId('db') : kind === 'block' ? newPageId('block') : kind === 'row' ? newPageId('row') : kind === 'column' ? newPageId('column') : newPageId('view'),
  });
  if (input.source) template.blocks = template.blocks.map((block) => ({ ...block, sources: [{ nodeId: input.source!.nodeId, turnId: input.source!.turnId, assistantId: input.source!.assistantId }] }));
  for (const database of template.databases) writeDatabase(database, input.ownerUserId, now);
  const position = nextPosition(workspace.id, input.parentId ?? null);
  db().prepare(`INSERT INTO pages(id,owner_user_id,workspace_id,parent_id,position,title,color,blocks,revision,view_version,updated_at,updated_by,created_at)
    VALUES(?,?,?,?,?,?,NULL,?,1,1,?,?,?)`).run(id, input.ownerUserId, workspace.id, input.parentId ?? null, position, input.title, json(template.blocks), now, input.source ? 'agent' : 'user', now);
  const page = getPage(id, input.ownerUserId);
  saveRevision(page, source, now);
  replacePageDatabaseRefs(id, input.ownerUserId, template.blocks, now);
  if (input.parentId) invalidatePages([input.parentId], now, input.source ? 'agent' : 'user');
  return getPage(id, input.ownerUserId);
  });
}

/**
 * Inserts an empty top-level home page and its first revision snapshot.
 * Callers own the access checks, the transaction and the unique-role race.
 */
export function insertHomePage(input: { ownerUserId: string; workspaceId: string; title: string; role: 'spaces-home' | 'workspace-home'; now: number }): string {
  ownerRequired(input.ownerUserId);
  assertTitle(input.title);
  const now = safeNow(input.now);
  const id = newPageId('pg');
  db().prepare(`INSERT INTO pages(id,owner_user_id,workspace_id,parent_id,position,title,color,blocks,revision,view_version,updated_at,updated_by,created_at,role)
    VALUES(?,?,?,NULL,?,?,NULL,'[]',1,1,?,'user',?,?)`).run(id, input.ownerUserId, input.workspaceId, nextPosition(input.workspaceId, null), input.title, now, now, input.role);
  saveRevision(pageDto(db().prepare('SELECT * FROM pages WHERE id=?').get(id) as PageRow), { kind: 'user' }, now);
  return id;
}

export function createDatabase(input: DatabaseCreateInput): PageDatabase {
  ownerRequired(input.ownerUserId);
  if (!input.title?.trim() || input.title.length > PAGE_LIMITS.title) throw new PageWriteError(400, 'invalid', 'Invalid database title');
  const workspace = requireContentWorkspace(input.workspaceId, input.ownerUserId);
  const now = safeNow(input.now);
  return pagesTransaction(() => {
    const id = newPageId('db');
    const columns = (input.columns ?? []).map((column) => ({ ...column, id: column.id || newPageId('column') }));
    const views = (input.views ?? []).map((view) => ({ ...view, id: view.id || newPageId('view') }));
    const rows = (input.rows ?? []).map((row) => ({ ...row, id: row.id || newPageId('row') }));
    const candidate: PageDatabase = { id, workspaceId: workspace.id, ...(input.role ? { role: input.role } : {}), title: input.title.trim(), columns, views, rows, revision: 1, updatedAt: now };
    const parsed = parsePageDatabaseOps([
      ...columns.map((column) => ({ op: 'column.add', column })),
      ...views.map(({ id: viewId, name, type, config }) => ({ op: 'view.save', view: { id: viewId, name, type, config } })),
    ], 'user');
    if (!parsed.ok) throw new PageWriteError(400, 'invalid', parsed.error);
    assertDatabaseShape(candidate);
    const roleProblem = databaseRoleProblem(candidate, input.role ?? null);
    if (roleProblem) throw new PageWriteError(400, 'invalid', roleProblem);
    writeDatabase(candidate, input.ownerUserId, now);
    return candidate;
  });
}

function assertDatabaseShape(database: PageDatabase): void {
  try {
    if (!database || !Array.isArray(database.columns) || !Array.isArray(database.views) || !Array.isArray(database.rows)) throw new Error('invalid database shape');
    // Reuse the shared model's final structural checks without applying an edit.
    applyPageDatabaseOps(database, [], { actor: 'user', revision: database.revision + 1, now: database.updatedAt });
  } catch {
    throw new PageWriteError(400, 'invalid', 'Invalid database shape');
  }
  const ids = [...database.columns.map((x) => x.id), ...database.views.map((x) => x.id), ...database.rows.map((x) => x.id)];
  if (ids.some((id) => !id || typeof id !== 'string' || id.length > 200) || new Set(ids).size !== ids.length) throw new PageWriteError(400, 'invalid', 'Invalid or duplicate database resource ID');
  const columns = new Set(database.columns.map((column) => column.id));
  if (database.columns.length > MICHI_DB_LIMITS.columns || database.views.length > MICHI_DB_LIMITS.views || database.rows.length > MICHI_DB_LIMITS.rows) throw new PageWriteError(400, 'invalid', 'Database resource limit exceeded');
  for (const row of database.rows) if (Object.keys(row.values).some((id) => !columns.has(id))) throw new PageWriteError(400, 'invalid', 'Database row references an unknown column');
  for (const view of database.views) {
    const config = view.config;
    const refs = [config.group, config.date, config.planDate, config.cover, ...(config.visible ?? []), ...config.filters.map((f) => f.column), ...config.sorts.map((s) => s.column)].filter((id): id is string => !!id);
    if (refs.some((id) => !columns.has(id))) throw new PageWriteError(400, 'invalid', 'Database view references an unknown column');
  }
}

function updatePageMetadataUnsafe(pageId: string, ownerUserId: string, patch: PageMetadataPatch, options: { expectedRevision: number; now?: number }): PageDto {
  const page = accessiblePage(pageId, ownerUserId, false, true);
  const now = safeNow(options.now);
  if (options.expectedRevision !== page.revision) throw new PageWriteError(409, 'stale_revision', 'Page revision changed');
  if (page.role !== null && patch.parentId !== undefined && patch.parentId !== page.parent_id) throw new PageWriteError(400, 'invalid', 'Home pages cannot move');
  if (patch.title !== undefined) assertTitle(patch.title);
  if (patch.position !== undefined && (!Number.isSafeInteger(patch.position) || patch.position < 0)) throw new PageWriteError(400, 'invalid', 'Invalid page position');
  if (patch.parentId !== undefined && patch.parentId !== null) {
    const parent = accessiblePage(patch.parentId, ownerUserId, false, true);
    if (parent.workspace_id !== page.workspace_id || parent.id === pageId) throw new PageWriteError(400, 'invalid', 'Invalid parent page');
    if (pageDescendants(pageId, page.workspace_id).some((candidate) => candidate.id === parent.id)) throw new PageWriteError(400, 'invalid', 'A page cannot move into its own subtree');
  }
  const parentId = patch.parentId === undefined ? page.parent_id : patch.parentId;
  const position = patch.position === undefined ? (parentId === page.parent_id ? page.position : nextPosition(page.workspace_id, parentId)) : patch.position;
  const next = { ...page, title: patch.title ?? page.title, color: patch.color === undefined ? page.color : patch.color, parent_id: parentId, position };
  const changed = next.title !== page.title || next.color !== page.color || next.parent_id !== page.parent_id || next.position !== page.position;
  if (!changed) return pageDto(page);
  const oldParent = page.parent_id;
  const siblings = db().prepare(`SELECT id FROM pages WHERE workspace_id=? AND parent_id IS ? AND deleted_at IS NULL AND id<>? ORDER BY position,id`).all(page.workspace_id, parentId, pageId) as unknown as Array<{ id: string }>;
  const targetPosition = Math.min(position, siblings.length);
  siblings.splice(targetPosition, 0, { id: pageId });
  db().prepare(`UPDATE pages SET title=?,color=?,parent_id=?,position=?,revision=revision+1,updated_at=?,updated_by='user' WHERE id=? AND owner_user_id=?`).run(next.title, next.color, next.parent_id, targetPosition, now, pageId, ownerUserId);
  const updatePosition = db().prepare('UPDATE pages SET position=?,view_version=view_version+1,updated_at=?,updated_by=\'user\' WHERE id=? AND position<>?');
  siblings.forEach((sibling, index) => { if (sibling.id !== pageId) updatePosition.run(index, now, sibling.id, index); });
  const updated = getPage(pageId, ownerUserId);
  saveRevision(updated, { kind: 'user' }, now);
  invalidatePages([pageId, ...(oldParent ? [oldParent] : []), ...(parentId ? [parentId] : [])], now, 'user');
  return getPage(pageId, ownerUserId);
}

export function updatePageMetadata(pageId: string, ownerUserId: string, patch: PageMetadataPatch, options: { expectedRevision: number; now?: number }): PageDto {
  return pagesTransaction(() => updatePageMetadataUnsafe(pageId, ownerUserId, patch, options));
}

/**
 * A task board shows its workspace's tasks, which the Pages Home's system workspace has none of.
 * Content that somehow holds one already stays writable; only a board this write adds is refused.
 * Every path that persists or proposes content calls this, so a proposal can't be created that could never be accepted.
 */
export function assertNoNewTaskBoardOnHome(workspaceId: string, ownerUserId: string, next: readonly PageBlock[], prior: readonly PageBlock[]): void {
  if (isSystemWorkspaceSettings(requirePagesWorkspace(workspaceId, ownerUserId).settings) && containsTaskView(next) && !containsTaskView(prior)) {
    throw new PageWriteError(400, 'task_board_needs_workspace', 'Task boards can\'t go on the Pages Home. Put it on a page of the workspace whose tasks it shows.');
  }
}

/** Internal content persistence. Caller owns the encompassing pagesTransaction and view invalidation. */
export function savePageContent(pageId: string, ownerUserId: string, snapshot: PageDto, options: SavePageContentOptions & { source: ChangeSource; now: number }): PageDto {
  const page = accessiblePage(pageId, ownerUserId, false, true);
  if (options.source.kind === 'maintenance' && db().prepare("SELECT 1 FROM home_customization WHERE owner_user_id=? AND json_extract(preferences,'$.pageId')=?").get(ownerUserId, pageId)) {
    throw new PageWriteError(409, 'invalid', 'Chat Home layout is customized by the user; automatic maintenance cannot replace it');
  }
  if (options.expectedRevision !== undefined && options.expectedRevision !== page.revision) throw new PageWriteError(409, 'stale_revision', 'Page revision changed');
  if (snapshot.id !== page.id || snapshot.workspaceId !== page.workspace_id || snapshot.parentId !== page.parent_id) throw new PageWriteError(400, 'invalid', 'Page snapshot identity or location changed');
  assertTitle(snapshot.title);
  const parsedBlocks = validateBlockList(snapshot.blocks);
  const blocks = options.source.kind === 'user' ? pinHumanPageComponentBlocks(parsedBlocks, page.workspace_id, ownerUserId) : parsedBlocks;
  const metadataUnchanged = snapshot.title === page.title && snapshot.color === page.color && snapshot.position === page.position;
  const stored = decodeBlocks(page.blocks);
  if (compare(blocks, stored) && metadataUnchanged) return pageDto(page);
  const now = safeNow(options.now);
  const revision = snapshot.revision;
  if (!Number.isSafeInteger(revision) || revision <= page.revision) throw new PageWriteError(400, 'invalid', 'New page revision must increase');
  assertNoNewTaskBoardOnHome(page.workspace_id, ownerUserId, blocks, stored);
  validatePageReferences(page.workspace_id, ownerUserId, blocks);
  // Edits and agent writes check what they name as they make it; an accepted, reverted or redone version is checked here.
  validateConversationReferences(page.workspace_id, blocks, pageConversationIds(stored));
  const actor = options.source.kind === 'user' ? 'user' : 'agent';
  db().prepare('UPDATE pages SET title=?,color=?,position=?,blocks=?,revision=?,updated_at=?,updated_by=? WHERE id=? AND owner_user_id=?')
    .run(snapshot.title, snapshot.color, snapshot.position, json(blocks), revision, now, actor, pageId, ownerUserId);
  const updated = getPage(pageId, ownerUserId);
  saveRevision(updated, options.source ?? { kind: 'user' }, now);
  replacePageDatabaseRefs(pageId, ownerUserId, blocks, now);
  savePageComponentReferences({ pageId, workspaceId: page.workspace_id, ownerUserId, revision, now, source: options.source, blocks });
  return getPage(pageId, ownerUserId);
}

/**
 * A task links at most 20 conversations, each once. One it links for the first
 * time has to be a conversation of the database's workspace; one linked
 * already stays linked wherever it went since (its card says it is no longer
 * here, and the person unlinks it), as thread cards do. A restore from change
 * history skips that check: the links it brings back were valid when recorded.
 */
function assertTaskThreads(next: PageDatabase, prior: PageDatabase, restore = false): void {
  const before = new Map(prior.rows.map((row) => [row.id, new Set(taskThreadIds(row.values[TASK_COLUMN.threads]))]));
  const find = db().prepare('SELECT workspace_id,kind,deleted_at,purged_at FROM nodes WHERE id=?');
  for (const row of next.rows) {
    const value = row.values[TASK_COLUMN.threads];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) throw new PageWriteError(400, 'invalid', 'Conversations holds conversation ids');
    const ids = taskThreadIds(value);
    if (ids.length !== value.length) throw new PageWriteError(400, 'invalid', 'Conversations holds conversation ids');
    if (new Set(ids).size !== ids.length) throw new PageWriteError(400, 'invalid', 'A task links each conversation once');
    if (ids.length > TASK_LIMITS.threads) throw new PageWriteError(400, 'invalid', `A task links at most ${TASK_LIMITS.threads} conversations`);
    if (restore) continue;
    const known = before.get(row.id);
    for (const nodeId of ids) {
      if (known?.has(nodeId)) continue;
      const node = find.get(nodeId) as { workspace_id: string; kind: string; deleted_at: number | null; purged_at: number | null } | undefined;
      if (!node || node.workspace_id !== next.workspaceId || node.kind !== 'chat' || node.deleted_at !== null || node.purged_at !== null) {
        throw new PageWriteError(400, 'invalid', `Conversation ${nodeId} is not a conversation of this workspace`);
      }
    }
  }
}

/** Internal database snapshot persistence. Caller owns the encompassing transaction. */
export function saveDatabase(database: PageDatabase, ownerUserId: string, options: SaveDatabaseOptions = {}): PageDatabase {
  const prior = accessibleDatabase(database.id, ownerUserId, false, true);
  if (database.workspaceId !== prior.workspace_id) throw new PageWriteError(400, 'invalid', 'Database workspace cannot change');
  const working = (options.actor ?? 'user') === 'user' ? pinHumanDatabaseViews(database, ownerUserId) : database;
  assertDatabaseShape(working);
  const roleProblem = databaseRoleProblem(working, prior.role);
  if (roleProblem) throw new PageWriteError(400, 'invalid', roleProblem);
  if (prior.role === TASK_DATABASE_ROLE) assertTaskThreads(working, decodeDatabase(prior), options.restore);
  const now = safeNow(options.now ?? working.updatedAt);
  if (!Number.isSafeInteger(working.revision) || working.revision <= prior.revision) throw new PageWriteError(400, 'invalid', 'Database revision must increase');
  db().prepare('UPDATE page_databases SET title=?,columns_json=?,views_json=?,revision=?,updated_at=? WHERE id=? AND owner_user_id=?')
    .run(working.title, json(working.columns), json(working.views), working.revision, now, working.id, ownerUserId);
  db().prepare('DELETE FROM page_database_rows WHERE database_id=?').run(working.id);
  const insert = db().prepare(`INSERT INTO page_database_rows(database_id,id,position,values_json,body,rev,edited,body_edited_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const row of working.rows) insert.run(working.id, row.id, row.position, json(row.values), row.body ?? null, row.rev, json(row.edited), row.bodyEditedAt, row.updatedAt);
  saveDatabaseComponentReferences({ database: working, ownerUserId, now, actor: options.actor ?? 'user' });
  return getDatabase(working.id, ownerUserId);
}

/** Return deletion groups with their still-deleted page members and databases. */
export function listPageTrash(workspaceId: string, ownerUserId: string, options: PageTrashOptions = {}): PageTrashResult {
  ownerRequired(ownerUserId);
  requirePagesWorkspace(workspaceId, ownerUserId);
  const limit = listLimit(options.limit);
  const cursor = pageCursor(options.cursor);
  const rows = db().prepare(`SELECT p.* FROM pages p WHERE p.workspace_id=? AND p.owner_user_id=? AND p.deleted_at IS NOT NULL AND p.deletion_group_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pages parent WHERE parent.id=p.parent_id AND parent.deletion_group_id=p.deletion_group_id AND parent.deleted_at IS NOT NULL)
    ${cursor ? ' AND (p.position>? OR (p.position=? AND p.id>?))' : ''}
    ORDER BY p.position,p.id LIMIT ?`).all(workspaceId, ownerUserId, ...(cursor ? [cursor.position, cursor.position, cursor.id] : []), limit + 1) as unknown as PageRow[];
  const hasMore = rows.length > limit;
  const items: PageTrashGroup[] = rows.slice(0, limit).map((root) => {
    const groupId = root.deletion_group_id!;
    const members = db().prepare('SELECT * FROM pages WHERE owner_user_id=? AND deletion_group_id=? AND deleted_at IS NOT NULL ORDER BY position,id')
      .all(ownerUserId, groupId) as unknown as PageRow[];
    const pageIds = members.map((page) => page.id);
    const databases = db().prepare('SELECT id,title,deleted_at AS deletedAt FROM page_databases WHERE owner_user_id=? AND deletion_group_id=? AND deleted_at IS NOT NULL ORDER BY created_at,id')
      .all(ownerUserId, groupId) as unknown as PageTrashGroup['databases'];
    return { deletionGroupId: groupId, deletedAt: root.deleted_at!, root: pageDto(root), pages: members.map(summary), databases };
  });
  const last = items.at(-1)?.root;
  return { items, nextCursor: hasMore && last ? makeCursor(last.position, last.id) : null };
}

/** Soft-delete the active page subtree as one reversible operation. */
export function deletePage(pageId: string, ownerUserId: string, options: { now?: number } = {}): string {
  const root = accessiblePage(pageId, ownerUserId, false, true);
  if (root.role !== null) throw new PageWriteError(409, 'invalid', 'Home pages cannot be deleted; hide them instead');
  const now = safeNow(options.now);
  const groupId = newPageId('del');
  pagesTransaction(() => {
    const members = pageDescendants(pageId, root.workspace_id);
    const ids = members.map((page) => page.id);
    const placeholders = ids.map(() => '?').join(',');
    db().prepare(`UPDATE pages SET deleted_at=?,deletion_group_id=? WHERE id IN (${placeholders})`).run(now, groupId, ...ids);
    // Keep the binding for undo while placing the helper chat in the same trash group.
    db().prepare(`UPDATE nodes SET deleted_at=?,deletion_group_id=? WHERE page_id IN (${placeholders}) AND deleted_at IS NULL AND purged_at IS NULL`).run(now, groupId, ...ids);
    // Only trash a database when no active page outside this subtree still references it.
    // The task database belongs to the workspace, not to the pages that show it.
    const candidates = db().prepare(`SELECT DISTINCT r.database_id FROM page_database_refs r WHERE r.page_id IN (${placeholders})
      AND NOT EXISTS (SELECT 1 FROM page_database_refs x WHERE x.database_id=r.database_id AND x.page_id NOT IN (${placeholders}))
      AND NOT EXISTS (SELECT 1 FROM page_databases d WHERE d.id=r.database_id AND d.role='tasks')`).all(...ids, ...ids) as unknown as Array<{ database_id: string }>;
    if (candidates.length) {
      const dbIds = candidates.map((candidate) => candidate.database_id);
      db().prepare(`UPDATE page_databases SET deleted_at=?,deletion_group_id=? WHERE id IN (${dbIds.map(() => '?').join(',')}) AND deleted_at IS NULL`)
        .run(now, groupId, ...dbIds);
    }
    if (root.parent_id) invalidatePages([root.parent_id], now, 'user');
  });
  return groupId;
}

/** Restore only records carrying this deletion group, preserving independently trashed descendants. */
export function restorePageDeletionGroup(deletionGroupId: string, ownerUserId: string, options: { now?: number } = {}): number {
  ownerRequired(ownerUserId);
  const now = safeNow(options.now);
  return pagesTransaction(() => {
    const members = db().prepare('SELECT id,parent_id FROM pages WHERE owner_user_id=? AND deletion_group_id=? AND deleted_at IS NOT NULL')
      .all(ownerUserId, deletionGroupId) as unknown as Array<{ id: string; parent_id: string | null }>;
    if (!members.length) throw new PageWriteError(404, 'not_found', 'Deleted page group not found');
    const ids = members.map((page) => page.id);
    // Parent groups may have been purged; detach those pages safely instead of violating tree invariants.
    const memberSet = new Set(ids);
    for (const page of members) {
      if (!page.parent_id || memberSet.has(page.parent_id)) continue;
      const parent = db().prepare('SELECT deleted_at,owner_user_id,workspace_id FROM pages WHERE id=?').get(page.parent_id) as
        { deleted_at: number | null; owner_user_id: string; workspace_id: string } | undefined;
      const child = db().prepare('SELECT workspace_id FROM pages WHERE id=?').get(page.id) as { workspace_id: string };
      if (!parent || parent.deleted_at !== null || parent.owner_user_id !== ownerUserId || parent.workspace_id !== child.workspace_id) {
        db().prepare('UPDATE pages SET parent_id=NULL WHERE id=?').run(page.id);
      }
    }
    db().prepare('UPDATE pages SET deleted_at=NULL,deletion_group_id=NULL,updated_at=? WHERE owner_user_id=? AND deletion_group_id=? AND deleted_at IS NOT NULL')
      .run(now, ownerUserId, deletionGroupId);
    db().prepare('UPDATE page_databases SET deleted_at=NULL,deletion_group_id=NULL,updated_at=? WHERE owner_user_id=? AND deletion_group_id=? AND deleted_at IS NOT NULL')
      .run(now, ownerUserId, deletionGroupId);
    db().prepare(`UPDATE nodes SET deleted_at=NULL,deletion_group_id=NULL WHERE page_id IN (${ids.map(() => '?').join(',')}) AND deletion_group_id=? AND deleted_at IS NOT NULL`)
      .run(...ids, deletionGroupId);
    invalidatePages(ids, now, 'user');
    return ids.length;
  });
}

/** Permanently remove one deletion group and its exclusively-owned databases. */
export function purgePageDeletionGroup(deletionGroupId: string, ownerUserId: string): number {
  ownerRequired(ownerUserId);
  return pagesTransaction(() => {
    const members = db().prepare('SELECT id FROM pages WHERE owner_user_id=? AND deletion_group_id=? AND deleted_at IS NOT NULL')
      .all(ownerUserId, deletionGroupId) as unknown as Array<{ id: string }>;
    if (!members.length) throw new PageWriteError(404, 'not_found', 'Deleted page group not found');
    const ids = members.map((page) => page.id);
    const placeholders = ids.map(() => '?').join(',');
    // Delete grouped databases only when no surviving page, including a deleted page from another group, uses them.
    const databases = db().prepare(`SELECT d.id FROM page_databases d WHERE d.owner_user_id=? AND d.deletion_group_id=? AND d.deleted_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM page_database_refs r WHERE r.database_id=d.id AND r.page_id NOT IN (${placeholders}))`)
      .all(ownerUserId, deletionGroupId, ...ids) as unknown as Array<{ id: string }>;
    if (databases.length) db().prepare(`DELETE FROM page_databases WHERE id IN (${databases.map(() => '?').join(',')})`).run(...databases.map((item) => item.id));
    const helperIds = db().prepare(`SELECT id,workspace_id FROM nodes WHERE deletion_group_id=? AND deleted_at IS NOT NULL AND purged_at IS NULL AND page_id IN (${placeholders})`)
      .all(deletionGroupId, ...ids) as unknown as Array<{ id: string; workspace_id: string }>;
    if (helperIds.length) {
      const nodeIds = helperIds.map((node) => node.id);
      const nodePlaceholders = nodeIds.map(() => '?').join(',');
      const now = Date.now();
      db().prepare(`UPDATE nodes SET purged_at=?,page_id=NULL WHERE id IN (${nodePlaceholders}) AND purged_at IS NULL`).run(now, ...nodeIds);
      db().prepare(`DELETE FROM messages WHERE node_id IN (${nodePlaceholders})`).run(...nodeIds);
      db().prepare(`DELETE FROM edges WHERE source_node_id IN (${nodePlaceholders}) OR target_node_id IN (${nodePlaceholders})`).run(...nodeIds, ...nodeIds);
    }
    db().prepare(`UPDATE nodes SET page_id=NULL WHERE page_id IN (${placeholders})`).run(...ids);
    const count = Number(db().prepare(`DELETE FROM pages WHERE owner_user_id=? AND deletion_group_id=? AND deleted_at IS NOT NULL`).run(ownerUserId, deletionGroupId).changes);
    return count;
  });
}

/** Remove every Page/Space record before a workspace is physically purged. */
export function purgeWorkspacePages(workspaceId: string, ownerUserId: string): number {
  ownerRequired(ownerUserId);
  const workspace = db().prepare('SELECT id,owner_user_id,deleted_at,purged_at,settings FROM workspaces WHERE id=?').get(workspaceId) as
    { id: string; owner_user_id: string | null; deleted_at: number | null; purged_at: number | null; settings: string | null } | undefined;
  if (!workspace || workspace.purged_at !== null || !workspaceOwnerMatches(workspace.owner_user_id, ownerUserId) || isSystemWorkspaceSettings(workspace.settings)) {
    throw new PageWriteError(404, 'not_found', 'Workspace not found');
  }
  return pagesTransaction(() => {
    const count = db().prepare('SELECT COUNT(*) AS count FROM pages WHERE workspace_id=?').get(workspace.id) as { count: number };
    // Remove workspace-scoped jobs' page state first. Scheduled job cancellation and
    // lease release are owned by the scheduler integration at the call site.
    db().prepare('DELETE FROM page_maintenance_configs WHERE workspace_id=? AND owner_user_id=?').run(workspace.id, ownerUserId);
    db().prepare('DELETE FROM page_maintenance_plans WHERE workspace_id=? AND owner_user_id=?').run(workspace.id, ownerUserId);
    db().prepare('DELETE FROM page_maintenance_receipts WHERE job_id IN (SELECT id FROM scheduled_jobs WHERE workspace_id=?)').run(workspace.id);
    db().prepare('DELETE FROM page_components WHERE workspace_id=? AND owner_user_id=?').run(workspace.id, ownerUserId);
    db().prepare('DELETE FROM page_component_libraries WHERE workspace_id=? AND owner_user_id=?').run(workspace.id, ownerUserId);
    db().prepare('UPDATE nodes SET page_id=NULL WHERE workspace_id=? AND page_id IS NOT NULL').run(workspace.id);
    db().prepare('DELETE FROM pages WHERE workspace_id=?').run(workspace.id);
    db().prepare('DELETE FROM page_databases WHERE workspace_id=?').run(workspace.id);
    return count.count;
  });
}
