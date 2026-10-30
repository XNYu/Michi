import { readHomeCards, readHomeCustomization, editHomeCustomization } from '../services/homeCards/repository';
import { blockShowsTaskBoard, isSystemWorkspaceSettings, isTaskDb, TASK_COLUMN, TASK_LIST_LIMITS, TASK_STATUSES, TASK_VIEW } from 'michi-shared';
import { getDb } from '../services/db';
import { getAiGlobalContext, getWorkspace } from '../services/dbRepository';
import { workspaceIdKindHint } from '../services/idKindHint';
import { isAssistantWorkspace } from '../assistant/identity';
import { LOCAL_AGENT_OWNER_ID, workspaceOwnerMatches } from '../services/agentOwner';
import { applyAgentDbEdits, configureDatabase, createAgentDatabase, configureDatabaseView } from '../services/pages/databaseWrites';
import { pageComponents } from '../services/pages/components';
import { PageWriteError, requireChatChangeSource, requirePagesWorkspace, type ChatChangeSource } from '../services/pages/core';
import { createPage, getDatabase, getPage, listPages } from '../services/pages/repository';
import { pageLayoutContext } from '../services/pages/layoutRules';
import { applyAgentPageEdits, type AgentPageWriteResult } from '../services/pages/pageWrites';
import { acquirePageEditLease, describeOtherLease, livePageEditLease } from '../services/pages/editLeases';
import { openTaskDatabase } from '../services/pages/taskDatabase';
import { listTasks, type TaskListInput, type TaskListScope } from '../services/pages/taskList';
import type { PageDatabase, PageDto, PageSummaryDto, PageWriteResult } from 'michi-shared';
import type { ActivePageTurnAttribution, PageToolName } from './pageToolNames';

export interface PageToolCaller {
  ownerUserId: string | null;
  workspaceId: string | null;
  nodeId: string | null;
  ownerKind: 'chat_node' | 'agent_run' | null;
  getActivePageTurnAttribution?: () => ActivePageTurnAttribution | null;
  /**
   * The Meta agent's chat window (the assistant's catalog only): reaches the
   * pages of every workspace its owner has, naming the workspace per call.
   */
  metaAgent?: boolean;
}

type ToolTextContent = { type: 'text'; text: string };
export interface PageToolResult {
  [key: string]: unknown;
  content: ToolTextContent[];
  details: unknown;
  structuredContent?: Record<string, unknown>;
  isError?: true;
}

const MAX_LIST_RESULTS = 20;
const MAX_READ_BLOCKS = 40;
const MAX_DATABASE_ROWS = 100;
const MAX_SCAN_PAGES = 2_000;
const MAX_TASK_STATUSES = 20;
const MAX_TASK_WORKSPACES = 100;
const MAX_TASK_CURSOR = 1_000;

function fail(message: string, code = 'invalid'): never {
  throw new PageWriteError(400, code as PageWriteError['code'], message);
}

function trustedOwner(caller: PageToolCaller): { ownerUserId: string; workspaceId: string; nodeId: string } {
  if (caller.ownerKind !== 'chat_node' || !caller.nodeId || !caller.workspaceId) {
    throw new PageWriteError(404, 'not_found', 'Page tools are available only to workspace chat sessions');
  }
  const ownerUserId = caller.ownerUserId ?? (process.env.MICHI_CLOUD === '1' ? '' : LOCAL_AGENT_OWNER_ID);
  if (!ownerUserId || isAssistantWorkspace(caller.workspaceId)) {
    throw new PageWriteError(404, 'not_found', 'Page tools are unavailable for this workspace');
  }
  return { ownerUserId, workspaceId: caller.workspaceId, nodeId: caller.nodeId };
}

function changeSource(caller: PageToolCaller): ChatChangeSource {
  const { ownerUserId, workspaceId, nodeId } = trustedOwner(caller);
  const attribution = caller.getActivePageTurnAttribution?.();
  if (!attribution?.turnId || !attribution.assistantId) {
    throw new PageWriteError(404, 'not_found', 'There is no active owning chat turn for this page write');
  }
  const node = getDb().prepare('SELECT workspace_id,page_id,kind FROM nodes WHERE id=?').get(nodeId) as
    { workspace_id: string; page_id: string | null; kind: string } | undefined;
  if (!node || node.workspace_id !== workspaceId || node.kind !== 'chat') {
    throw new PageWriteError(404, 'not_found', 'Active chat source not found');
  }
  // Helper attribution is server-derived from the bound node, never accepted from tool input.
  const source: ChatChangeSource = {
    kind: node.page_id === null ? 'chat' : 'helper',
    nodeId,
    turnId: attribution.turnId,
    assistantId: attribution.assistantId,
  };
  requireChatChangeSource(workspaceId, ownerUserId, source);
  return source;
}

/** Where a call may act: one workspace for an ordinary chat, every one of the owner's for the Meta agent (null). */
interface PageScope { ownerUserId: string; workspaceId: string | null }

function metaAgentOwner(caller: PageToolCaller): PageScope {
  if (caller.ownerKind !== 'chat_node' || !caller.nodeId || !isAssistantWorkspace(caller.workspaceId)) {
    throw new PageWriteError(404, 'not_found', 'Page tools are available only to workspace chat sessions');
  }
  const ownerUserId = caller.ownerUserId ?? (process.env.MICHI_CLOUD === '1' ? '' : LOCAL_AGENT_OWNER_ID);
  if (!ownerUserId) throw new PageWriteError(404, 'not_found', 'Page tools are unavailable for this workspace');
  return { ownerUserId, workspaceId: null };
}

function pageScope(caller: PageToolCaller): PageScope {
  return caller.metaAgent ? metaAgentOwner(caller) : trustedOwner(caller);
}

/** Only the owner's explicitly selected Chat Home Page is shared across chat workspaces. */
function isChatHomePage(scope: PageScope, pageId: string): boolean {
  const preferences = readHomeCustomization(scope.ownerUserId).preferences;
  return preferences.pageId === pageId;
}

function inScope(scope: PageScope, workspaceId: string): boolean {
  return scope.workspaceId === null || scope.workspaceId === workspaceId;
}

/** A workspace the Meta agent names for listing, creating or the component library: one of the owner's own, never a system one. */
function namedWorkspace(scope: PageScope, raw: unknown): string {
  if (scope.workspaceId !== null) return scope.workspaceId;
  const workspaceId = parseString(raw, 'workspaceId')!;
  const workspace = getWorkspace(workspaceId, scope.ownerUserId);
  if (!workspace || workspace.deleted_at != null || isSystemWorkspaceSettings(workspace.settings)) {
    throw new PageWriteError(404, 'not_found', `Workspace not found.${workspaceIdKindHint(workspaceId)} Get workspace ids from list_workspaces.`);
  }
  requirePagesWorkspace(workspaceId, scope.ownerUserId);
  return workspaceId;
}

/** The Meta agent's writes come from its own chat-window turn, wherever the page is. */
function metaAgentChangeSource(caller: PageToolCaller, scope: PageScope, workspaceId: string): ChatChangeSource {
  const attribution = caller.getActivePageTurnAttribution?.();
  if (!attribution?.turnId || !attribution.assistantId) {
    throw new PageWriteError(404, 'not_found', 'There is no active owning chat turn for this page write');
  }
  const source: ChatChangeSource = { kind: 'chat', nodeId: caller.nodeId!, turnId: attribution.turnId, assistantId: attribution.assistantId };
  requireChatChangeSource(workspaceId, scope.ownerUserId, source);
  return source;
}

function writeSource(caller: PageToolCaller, scope: PageScope, workspaceId: string): ChatChangeSource {
  return scope.workspaceId === null ? metaAgentChangeSource(caller, scope, workspaceId) : changeSource(caller);
}

/** The Meta agent's receipts name the resource's workspace: its own chat is in none of them. */
function scopedResult(scope: PageScope, workspaceId: string, value: Record<string, unknown>): PageToolResult {
  if (scope.workspaceId !== null || !value.michiPageWrite || typeof value.michiPageWrite !== 'object') return toolResult(value);
  return toolResult({ ...value, michiPageWrite: { ...(value.michiPageWrite as Record<string, unknown>), workspaceId } });
}

/**
 * The Meta agent reads a workspace's tasks only while "Let AI navigate this
 * workspace" is on there: tasks retell its conversations. A chat in the
 * workspace reads them either way.
 */
function navigableTasks(scope: PageScope, workspaceId: string): void {
  if (scope.workspaceId !== null || getAiGlobalContext(workspaceId, scope.ownerUserId)) return;
  const name = getWorkspace(workspaceId, scope.ownerUserId)?.name ?? 'this workspace';
  fail(`NAVIGATION_DISABLED: "Let AI navigate this workspace" is off in ${name}, so its tasks cannot be read or changed. If the user needs them, ask them to turn it on in that workspace's Settings.`);
}

/** The workspaces the Meta agent names for list_tasks; null reads every one. */
function taskWorkspaceIds(scope: PageScope, raw: unknown): string[] | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TASK_WORKSPACES) fail(`workspaceIds must list 1 to ${MAX_TASK_WORKSPACES} workspaces`);
  return [...new Set(raw.map((value) => namedWorkspace(scope, value)))];
}

type TaskListFilters = Pick<TaskListInput, 'statuses' | 'nodeId' | 'needsYou' | 'query' | 'updatedSince' | 'limit' | 'cursor'>;

/** list_tasks filters, checked before anything is read. */
function taskListFilters(args: Record<string, unknown>): TaskListFilters {
  const filters: TaskListFilters = {};
  if (args.statuses !== undefined) {
    if (!Array.isArray(args.statuses) || args.statuses.length > MAX_TASK_STATUSES
      || args.statuses.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 200)) {
      fail(`statuses must list at most ${MAX_TASK_STATUSES} status values`);
    }
    filters.statuses = args.statuses as string[];
  }
  const nodeId = parseString(args.nodeId, 'nodeId', true);
  if (nodeId !== undefined) filters.nodeId = nodeId;
  if (args.needsYou !== undefined) {
    if (typeof args.needsYou !== 'boolean') fail('needsYou must be a boolean');
    filters.needsYou = args.needsYou;
  }
  const query = parseString(args.query, 'query', true);
  if (query !== undefined) filters.query = query;
  if (args.updatedSince !== undefined) {
    if (!Number.isSafeInteger(args.updatedSince) || (args.updatedSince as number) < 0) fail('updatedSince must be a time in milliseconds');
    filters.updatedSince = args.updatedSince as number;
  }
  if (args.limit !== undefined) {
    if (!Number.isSafeInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > TASK_LIST_LIMITS.max) {
      fail(`limit must be between 1 and ${TASK_LIST_LIMITS.max}`);
    }
    filters.limit = args.limit as number;
  }
  if (args.cursor !== undefined) {
    if (typeof args.cursor !== 'string' || args.cursor.length === 0 || args.cursor.length > MAX_TASK_CURSOR) fail('Invalid cursor');
    filters.cursor = args.cursor;
  }
  return filters;
}

/** What open_task_database answers: what an agent writes tasks with. list_tasks reads the tasks themselves. */
function taskDatabaseAnswer(database: PageDatabase, created: boolean) {
  const status = database.columns.find((column) => column.id === TASK_COLUMN.status);
  return {
    kind: 'taskDatabase', created,
    databaseId: database.id, workspaceId: database.workspaceId, title: database.title, revision: database.revision,
    taskCount: database.rows.length,
    columns: database.columns.map((column) => ({ id: column.id, name: column.name, type: column.type })),
    statuses: (status?.options ?? []).map((option) => ({
      value: option.value, label: option.label ?? option.value, core: (TASK_STATUSES as readonly string[]).includes(option.value),
    })),
    views: database.views.map((view) => ({ id: view.id, name: view.name, type: view.type })),
  };
}

type PageListToolItem = PageSummaryDto & { revision: number; home?: true };

function pageListingResult(pages: PageListToolItem[], truncated: boolean, query?: string, remaining?: number | null) {
  const marker = truncated ? `and ${remaining === null || remaining === undefined ? 'possibly' : remaining} more — use list_pages with a narrower query` : '';
  return {
    items: pages,
    query: query ?? null,
    truncated,
    ...(marker ? { more: marker } : {}),
  };
}

function listMatchingPages(workspaceId: string, ownerUserId: string, query?: string): { items: PageListToolItem[]; truncated: boolean; remaining: number | null } {
  const needle = query?.trim().toLocaleLowerCase();
  const matches: PageSummaryDto[] = [];
  let cursor: string | null = null;
  let scanned = 0;
  let hasMore = false;
  do {
    const result = listPages(workspaceId, ownerUserId, { limit: 100, ...(cursor ? { cursor } : {}) });
    for (const item of result.items) {
      scanned++;
      if (!needle || item.title.toLocaleLowerCase().includes(needle)) matches.push(item);
      if (scanned >= MAX_SCAN_PAGES) {
        hasMore = result.nextCursor !== null;
        break;
      }
    }
    if (scanned >= MAX_SCAN_PAGES) break;
    cursor = result.nextCursor;
  } while (cursor);
  const truncated = hasMore || matches.length > MAX_LIST_RESULTS;
  const home = getDb().prepare("SELECT id FROM pages WHERE workspace_id=? AND owner_user_id=? AND role='workspace-home' AND deleted_at IS NULL").get(workspaceId, ownerUserId) as { id: string } | undefined;
  return {
    items: matches.slice(0, MAX_LIST_RESULTS).map((item) => ({ ...item, revision: getPage(item.id, ownerUserId).revision, ...(item.id === home?.id ? { home: true as const } : {}) })),
    truncated,
    remaining: hasMore ? null : Math.max(0, matches.length - MAX_LIST_RESULTS),
  };
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function pageRead(page: PageDto, blockIds?: string[]) {
  const selected = blockIds ? page.blocks.filter((block) => blockIds.includes(block.id)) : page.blocks;
  const blocks = selected.slice(0, MAX_READ_BLOCKS).map((block) => ({
    ...block,
    ownership: { humanEdited: block.edit !== undefined, editedAt: block.edit?.at ?? null },
  }));
  return {
    id: page.id, title: page.title, workspaceId: page.workspaceId, parentId: page.parentId,
    revision: page.revision, viewVersion: page.viewVersion, updatedAt: page.updatedAt, updatedBy: page.updatedBy,
    blocks, truncated: selected.length > blocks.length,
    missingBlockIds: blockIds ? blockIds.filter((id) => !page.blocks.some((block) => block.id === id)) : [],
  };
}

/**
 * read_page's editLease: forEdit takes or renews this turn's lease, so a
 * maintenance run or another conversation does not change the page between
 * this read and the edit. Any read reports another conversation's live lease.
 */
function readEditLease(caller: PageToolCaller, scope: PageScope, page: PageDto, forEdit: boolean): { editLease?: Record<string, unknown> } {
  const now = Date.now();
  if (!forEdit) {
    const other = livePageEditLease(page.id, now);
    const mine = caller.getActivePageTurnAttribution?.()?.turnId;
    return other && other.turnId !== mine ? { editLease: describeOtherLease(other, now) } : {};
  }
  const source = writeSource(caller, scope, page.workspaceId);
  const result = acquirePageEditLease({ pageId: page.id, ownerUserId: scope.ownerUserId, workspaceId: page.workspaceId,
    holder: { nodeId: source.nodeId, turnId: source.turnId }, now });
  if (!result.acquired) {
    return { editLease: { ...describeOtherLease(result.lease, now),
      note: 'Another conversation is editing this page; edit_page is refused until its lease ends.' } };
  }
  return { editLease: { status: 'held', expiresAt: result.lease.expiresAt,
    note: 'This turn holds the page until it ends; each read with forEdit or edit_page renews it.' } };
}

function databaseRead(database: PageDatabase, limit: number) {
  const rows = database.rows.slice(0, limit).map((row) => ({
    ...row,
    ownership: {
      humanEditedCells: Object.keys(row.edited),
      humanEditedBody: row.bodyEditedAt !== null,
      bodyEditedAt: row.bodyEditedAt,
    },
  }));
  return {
    id: database.id, title: database.title, workspaceId: database.workspaceId,
    revision: database.revision, updatedAt: database.updatedAt, columns: database.columns, views: database.views,
    rows, truncated: database.rows.length > rows.length, totalRows: database.rows.length,
  };
}

/** Whether a change snapshot's block shows a task board (alone or inside a container). */
function snapshotShowsTaskBoard(snapshot: unknown): boolean {
  const block = (snapshot as { block?: Record<string, unknown> } | undefined)?.block;
  return !!block && typeof block === 'object' && blockShowsTaskBoard(block);
}

/**
 * The receipt leads with michiPageWrite: runtimes cut tool output at 16 KB, and
 * a long write must lose its change records, not the receipt the cards read.
 */
function writeReceipt(result: PageWriteResult & Partial<Pick<AgentPageWriteResult, 'viewVersion' | 'atomic' | 'commitStatus'>>, title: string, originatingPageId?: string, created = false, originatingPageIds?: string[]) {
  const changes = [...result.applied, ...result.proposed];
  const affectedTargetIds = [...new Set(changes.flatMap((change) => {
    const target = change.target;
    if (target.kind === 'block') return [target.blockId];
    if (target.kind === 'row') return [target.rowId];
    return [target.databaseId];
  }))];
  const michiPageWrite = {
    kind: 'michiPageWrite',
    resourceKind: result.resource.kind,
    resourceId: result.resource.id,
    ...(originatingPageId ? { originatingPageId } : {}),
    ...(originatingPageIds ? { originatingPageIds } : {}),
    title,
    ...(created ? { created: true } : {}),
    revision: result.revision,
    ...(result.viewVersion === undefined ? {} : { viewVersion: result.viewVersion }),
    ...(result.atomic === undefined ? {} : { atomic: result.atomic, commitStatus: result.commitStatus }),
    appliedCount: result.applied.length,
    proposedCount: result.proposed.length,
    rejectedCount: result.rejected.length,
    affectedTargetIds,
    batchId: changes[0]?.batchId ?? null,
    ...(result.applied.some((change) => snapshotShowsTaskBoard(change.after) && !snapshotShowsTaskBoard(change.before)) ? { taskBoard: true } : {}),
  };
  return { michiPageWrite, result };
}

/** A write to a task database also counts the tasks it added, updated and removed, for its receipt card. */
function withTaskCounts(receipt: ReturnType<typeof writeReceipt>, database: PageDatabase): Record<string, unknown> {
  if (!isTaskDb(database)) return receipt;
  const tasks = { added: 0, updated: 0, removed: 0 };
  for (const change of receipt.result.applied) {
    if (change.target.kind !== 'row') continue;
    if (!change.before?.exists) tasks.added += 1;
    else if (!change.after?.exists) tasks.removed += 1;
    else tasks.updated += 1;
  }
  return { ...receipt, michiPageWrite: { ...receipt.michiPageWrite, tasks } };
}

function toolResult(value: unknown): PageToolResult {
  const payload = value as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    details: value,
    structuredContent: payload,
  };
}

function parseString(value: unknown, field: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) fail(`Invalid ${field}`);
  return value;
}

/** Shared executor for MCP and Pi; caller identity and attribution are supplied only by runtime closures. */
export function runPageTool(name: PageToolName, caller: PageToolCaller, rawArgs: unknown): PageToolResult {
  try {
    const args = requireRecord(rawArgs ?? {}, 'Tool arguments');
    const scope = pageScope(caller);
    const { ownerUserId } = scope;
    switch (name) {
      case 'read_home':
      case 'edit_home': {
        // Home is owner-wide, including when called from the Assistant's system workspace.
        // Validate the bound conversation and active turn without treating it as a Page.
        const workspace = getWorkspace(caller.workspaceId!, ownerUserId);
        const turn = caller.getActivePageTurnAttribution?.();
        const node = getDb().prepare(`SELECT n.page_id FROM nodes n JOIN turns t ON t.node_id=n.id
          LEFT JOIN trees tr ON tr.id=n.tree_id
          WHERE n.id=? AND n.workspace_id=? AND n.kind='chat' AND n.deleted_at IS NULL
          AND n.purged_at IS NULL AND n.status!='archived' AND tr.archived_at IS NULL
          AND t.turn_id=? AND t.assistant_message_id=? AND t.status='active'`)
          .get(caller.nodeId!, caller.workspaceId!, turn?.turnId ?? '', turn?.assistantId ?? '');
        if (!workspace || !workspaceOwnerMatches(workspace.owner_user_id ?? null, ownerUserId) || workspace.deleted_at != null || workspace.archived_at != null || workspace.purged_at != null || !node) {
          fail('Active Home chat source not found');
        }
        return toolResult(name === 'read_home'
          ? { ...readHomeCustomization(ownerUserId), content: readHomeCards(ownerUserId) }
          : editHomeCustomization(ownerUserId, args));
      }
      case 'list_pages': {
        const workspaceId = namedWorkspace(scope, args.workspaceId);
        const query = parseString(args.query, 'query', true);
        if (query && query.length > 200) fail('query must be at most 200 characters');
        const found = listMatchingPages(workspaceId, ownerUserId, query);
        return toolResult(pageListingResult(found.items, found.truncated, query, found.remaining));
      }
      case 'read_page': {
        const pageId = parseString(args.pageId, 'pageId')!;
        let blockIds: string[] | undefined;
        if (args.blockIds !== undefined) {
          if (!Array.isArray(args.blockIds) || args.blockIds.length > MAX_READ_BLOCKS || args.blockIds.some((id) => typeof id !== 'string' || id.length > 200)) fail('blockIds must contain at most 40 block IDs');
          blockIds = args.blockIds as string[];
        }
        if (args.forEdit !== undefined && typeof args.forEdit !== 'boolean') fail('forEdit must be a boolean');
        const page = getPage(pageId, ownerUserId);
        if (!inScope(scope, page.workspaceId) && !isChatHomePage(scope, page.id)) throw new PageWriteError(404, 'not_found', 'Page not found');
        return toolResult({ ...pageRead(page, blockIds), ...pageLayoutContext(page.id, ownerUserId),
          ...readEditLease(caller, scope, page, args.forEdit === true) });
      }
      case 'edit_page': {
        const pageId = parseString(args.pageId, 'pageId')!;
        if (!Array.isArray(args.ops) || args.ops.length > 50) fail('ops must contain at most 50 operations');
        if (args.atomic !== undefined && typeof args.atomic !== 'boolean') fail('atomic must be a boolean');
        const page = getPage(pageId, ownerUserId);
        if (!inScope(scope, page.workspaceId) && !isChatHomePage(scope, page.id)) throw new PageWriteError(404, 'not_found', 'Page not found');
        const source = writeSource(caller, scope, page.workspaceId);
        // Scope is server-validated; a Meta agent cannot opt out through tool input.
        const atomic = scope.workspaceId === null || args.atomic === true;
        const result = applyAgentPageEdits({ pageId, ownerUserId, workspaceId: page.workspaceId, source, ops: args.ops, atomic });
        return scopedResult(scope, page.workspaceId, writeReceipt(result, page.title, pageId));
      }
      case 'create_page': {
        const title = parseString(args.title, 'title')!;
        const parentId = parseString(args.parentId, 'parentId', true) ?? null;
        const template = parseString(args.template, 'template', true) as 'blank' | 'release' | 'research' | 'travel' | undefined;
        if (template && !['blank', 'release', 'research', 'travel'].includes(template)) fail('Invalid template');
        let workspaceId: string;
        if (scope.workspaceId === null && parentId) {
          workspaceId = getPage(parentId, ownerUserId).workspaceId;
          if (args.workspaceId !== undefined && args.workspaceId !== workspaceId) fail('parentId is in another workspace');
          namedWorkspace(scope, workspaceId);
        } else {
          workspaceId = namedWorkspace(scope, args.workspaceId);
        }
        const source = writeSource(caller, scope, workspaceId);
        const page = createPage({ workspaceId, ownerUserId, parentId, title, template, source });
        const createdTargetIds = [
          ...page.blocks.map((block) => block.id),
          ...page.blocks.flatMap((block) => block.type === 'database-ref' ? [block.databaseId] : []),
        ];
        const michiPageWrite = {
          kind: 'michiPageWrite', resourceKind: 'page', resourceId: page.id,
          ...(parentId ? { originatingPageId: parentId } : {}),
          title, created: true, revision: page.revision, appliedCount: 0, proposedCount: 0, rejectedCount: 0,
          affectedTargetIds: createdTargetIds, batchId: null,
        };
        return scopedResult(scope, workspaceId, {
          kind: 'createdPage',
          page: { id: page.id, title: page.title, workspaceId: page.workspaceId, parentId: page.parentId, revision: page.revision, viewVersion: page.viewVersion },
          michiPageWrite,
        });
      }
      case 'create_database': {
        const workspaceId = namedWorkspace(scope, args.workspaceId);
        const source = writeSource(caller, scope, workspaceId);
        const { database, result } = createAgentDatabase({ workspaceId, ownerUserId, source,
          title: parseString(args.title, 'title')!, columns: args.columns });
        return scopedResult(scope, workspaceId, { ...writeReceipt(result, database.title, undefined, true), database: databaseRead(database, 1) });
      }
      case 'configure_database': {
        const databaseId = parseString(args.databaseId, 'databaseId')!;
        const database = getDatabase(databaseId, ownerUserId);
        if (!inScope(scope, database.workspaceId)) throw new PageWriteError(404, 'not_found', 'Database not found');
        const source = writeSource(caller, scope, database.workspaceId);
        const result = configureDatabase({ databaseId, ownerUserId, workspaceId: database.workspaceId,
          revision: args.revision as number, ops: args.ops, source });
        const refs = getDb().prepare('SELECT page_id FROM page_database_refs WHERE database_id=? ORDER BY page_id').all(databaseId) as Array<{ page_id: string }>;
        const updated = getDatabase(databaseId, ownerUserId);
        return scopedResult(scope, database.workspaceId, { ...writeReceipt(result, database.title, undefined, false, refs.map((ref) => ref.page_id)),
          database: { id: updated.id, revision: updated.revision, columns: updated.columns, views: updated.views } });
      }
      case 'read_database': {
        const databaseId = parseString(args.databaseId, 'databaseId')!;
        const limit = args.limit === undefined ? 50 : args.limit;
        if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_DATABASE_ROWS) fail('limit must be between 1 and 100');
        const database = getDatabase(databaseId, ownerUserId);
        if (!inScope(scope, database.workspaceId)) throw new PageWriteError(404, 'not_found', 'Database not found');
        if (isTaskDb(database)) navigableTasks(scope, database.workspaceId);
        return toolResult(databaseRead(database, limit as number));
      }
      case 'edit_database': {
        const databaseId = parseString(args.databaseId, 'databaseId')!;
        const selectedPageId = parseString(args.pageId, 'pageId', true);
        if (!Array.isArray(args.ops) || args.ops.length > 50) fail('ops must contain at most 50 operations');
        const database = getDatabase(databaseId, ownerUserId);
        if (!inScope(scope, database.workspaceId)) throw new PageWriteError(404, 'not_found', 'Database not found');
        if (isTaskDb(database)) navigableTasks(scope, database.workspaceId);
        const workspaceId = database.workspaceId;
        const source = writeSource(caller, scope, workspaceId);
        const refs = getDb().prepare('SELECT page_id FROM page_database_refs WHERE database_id=? ORDER BY page_id').all(databaseId) as unknown as Array<{ page_id: string }>;
        if (selectedPageId && !refs.some((ref) => ref.page_id === selectedPageId)) throw new PageWriteError(404, 'not_found', 'Selected page does not reference this database');
        const selectedPage = selectedPageId ? getPage(selectedPageId, ownerUserId) : undefined;
        const result = applyAgentDbEdits({ databaseId, workspaceId, ownerUserId, source, ops: args.ops });
        return scopedResult(scope, workspaceId, withTaskCounts(writeReceipt(result, database.title, selectedPage?.id, false, refs.map((ref) => ref.page_id)), database));
      }
      case 'list_page_components': {
        return toolResult(pageComponents.list(namedWorkspace(scope, args.workspaceId), ownerUserId));
      }
      case 'read_page_component': {
        const workspaceId = namedWorkspace(scope, args.workspaceId);
        const componentId = parseString(args.componentId, 'componentId')!;
        const version = args.version;
        if (version !== undefined && (!Number.isSafeInteger(version) || (version as number) < 1)) fail('version must be a positive integer');
        return toolResult(pageComponents.read(workspaceId, ownerUserId, componentId, version as number | undefined));
      }
      case 'save_page_component': {
        const workspaceId = namedWorkspace(scope, args.workspaceId);
        const expectedLibraryRevision = args.expectedLibraryRevision;
        if (!Number.isSafeInteger(expectedLibraryRevision) || (expectedLibraryRevision as number) < 0) fail('expectedLibraryRevision must be a non-negative integer');
        const component = requireRecord(args.component, 'component');
        const result = pageComponents.save(workspaceId, ownerUserId, {
          expectedLibraryRevision: expectedLibraryRevision as number,
          input: component,
          source: writeSource(caller, scope, workspaceId),
        });
        const receipt = {
          kind: 'michiPageWrite', resourceKind: 'component', resourceId: result.component.id,
          title: result.component.name, revision: result.revision, version: result.version.version,
          appliedCount: 1, proposedCount: 0, rejectedCount: 0, affectedTargetIds: [result.component.id], batchId: null,
        };
        return scopedResult(scope, workspaceId, { ...result, michiPageWrite: receipt });
      }
      case 'configure_database_view': {
        const databaseId = parseString(args.databaseId, 'databaseId')!;
        const revision = args.revision;
        const viewId = parseString(args.viewId, 'viewId', true);
        if (!Number.isSafeInteger(revision) || (revision as number) < 1) fail('revision must be a positive integer');
        const config = requireRecord(args.config, 'config');
        const componentId = parseString(config.componentId, 'config.componentId')!;
        const props = config.props === undefined ? {} : requireRecord(config.props, 'config.props');
        const pinnedVersion = config.pinnedVersion;
        if (pinnedVersion !== undefined && (!Number.isSafeInteger(pinnedVersion) || (pinnedVersion as number) < 1)) fail('config.pinnedVersion must be a positive integer');
        const database = getDatabase(databaseId, ownerUserId);
        if (!inScope(scope, database.workspaceId)) throw new PageWriteError(404, 'not_found', 'Database not found');
        if (isTaskDb(database) && viewId && (Object.values(TASK_VIEW) as string[]).includes(viewId)) {
          fail('A task database keeps its Board, Table and Needs you views: create another view instead');
        }
        const workspaceId = database.workspaceId;
        const refs = getDb().prepare('SELECT page_id FROM page_database_refs WHERE database_id=? ORDER BY page_id').all(databaseId) as unknown as Array<{ page_id: string }>;
        const source = writeSource(caller, scope, workspaceId);
        const result = configureDatabaseView({
          databaseId, workspaceId, ownerUserId, revision: revision as number, ...(viewId ? { viewId } : {}), componentId,
          props, ...(pinnedVersion === undefined ? {} : { pinnedVersion: pinnedVersion as number }), source,
        });
        return scopedResult(scope, workspaceId, { ...writeReceipt(result, database.title, undefined, false, refs.map((ref) => ref.page_id)), viewId: result.viewId });
      }
      case 'open_task_database': {
        const workspaceId = namedWorkspace(scope, args.workspaceId);
        navigableTasks(scope, workspaceId);
        // Making it is a write: it needs the chat's active turn, as page writes do.
        writeSource(caller, scope, workspaceId);
        const opened = openTaskDatabase({ workspaceId, ownerUserId });
        return toolResult(taskDatabaseAnswer(opened.database, opened.created));
      }
      case 'list_tasks': {
        const filters = taskListFilters(args);
        const taskScope: TaskListScope = scope.workspaceId === null
          ? { kind: 'across', workspaceIds: taskWorkspaceIds(scope, args.workspaceIds), includeAiHidden: false }
          : { kind: 'workspace', workspaceId: scope.workspaceId };
        return toolResult(listTasks({ ownerUserId, scope: taskScope, ...filters }));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Page tool failed';
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], details: { error: message }, isError: true };
  }
}
