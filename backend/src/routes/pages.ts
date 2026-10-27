import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import { getDb } from '../services/db';
import { PageWriteError, requirePagesWorkspace, assertPageRequestSize } from '../services/pages/core';
import {
  createDatabase, createPage, deletePage, getDatabase, getPage, listDatabases, listPageTrash,
  listPages, listSpaces, pageRecord, purgePageDeletionGroup, restorePageDeletionGroup,
  updatePageMetadata,
} from '../services/pages/repository';
import { applyUserPageEdits } from '../services/pages/pageWrites';
import {
  acknowledgePageActivity, getChange, getPageActivitySeen, listChangeBatch, listRelevantChanges,
} from '../services/pages/historyRepository';
import { applyUserDatabaseEdits } from '../services/pages/databaseWrites';
import {
  acceptProposal, dismissProposal, redoBatch, redoChange, reopenProposal, revertBatch, revertChange,
} from '../services/pages/pageChanges';
import { findTaskDatabaseId, openTaskDatabase } from '../services/pages/taskDatabase';
import { taskActivity, taskOrigin } from '../services/pages/taskActivity';
import { parsePageDatabaseOps, PAGE_TEMPLATES } from 'michi-shared';
import type { PageActivitySeenRequest, PageChangeDto, PageDatabase } from 'michi-shared';

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const ownKeys = (value: Obj, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));
const owner = (req: Request): string => (req as Request & { user?: { id?: string } }).user?.id ?? LOCAL_AGENT_OWNER_ID;
const id = (value: unknown, name = 'id'): string => {
  if (typeof value !== 'string' || !value || value.length > 200) throw new PageWriteError(400, 'invalid', `Invalid ${name}`);
  return value;
};
const integer = (value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || (n as number) < min || (n as number) > max) throw new PageWriteError(400, 'invalid', `Invalid ${name}`);
  return n as number;
};
function body(req: Request, keys: readonly string[]): Obj {
  if (req.body === undefined && keys.length === 0) return {};
  if (!isObject(req.body) || !ownKeys(req.body, keys)) throw new PageWriteError(400, 'invalid', 'Invalid request body');
  assertPageRequestSize(req.body);
  return req.body;
}
function query(req: Request, allowed: readonly string[]): void {
  if (!ownKeys(req.query as Obj, allowed)) throw new PageWriteError(400, 'invalid', 'Unknown query parameter');
}
function optionalString(value: unknown, name: string, max = 200): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) throw new PageWriteError(400, 'invalid', `Invalid ${name}`);
  return value;
}
function route(fn: (req: Request, res: Response) => unknown) {
  return (req: Request, res: Response, next: NextFunction) => {
    try { fn(req, res); } catch (error) { next(error); }
  };
}
function errors(_error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const error = _error instanceof PageWriteError ? _error : null;
  if (error) { res.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
  res.status(500).json({ error: { code: 'internal_error', message: 'Unable to complete Pages request' } });
}
function requireRequired<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new PageWriteError(400, 'invalid', `${name} is required`);
  return value;
}

/** Native Pages API. Mount at /api; authorization is always resolved from persisted ownership. */
export function setupPagesRoutes(): Router {
  const router = Router();

  router.get('/spaces', route((req, res) => {
    query(req, ['workspaceId', 'limit', 'cursor']);
    const workspaceId = optionalString(req.query.workspaceId, 'workspaceId');
    const limit = req.query.limit === undefined ? undefined : integer(req.query.limit, 'limit', 1, 100);
    const cursor = optionalString(req.query.cursor, 'cursor', 500);
    res.json(listSpaces(owner(req), { workspaceId, limit, cursor }));
  }));

  router.get('/workspaces/:workspaceId/pages', route((req, res) => {
    query(req, ['parentId', 'limit', 'cursor']);
    const parentId = req.query.parentId === undefined ? undefined : req.query.parentId === 'null' ? null : id(req.query.parentId, 'parentId');
    const limit = req.query.limit === undefined ? undefined : integer(req.query.limit, 'limit', 1, 100);
    const cursor = optionalString(req.query.cursor, 'cursor', 500);
    res.json(listPages(id(req.params.workspaceId, 'workspaceId'), owner(req), { parentId, limit, cursor }));
  }));
  router.post('/workspaces/:workspaceId/pages', route((req, res) => {
    query(req, []);
    const data = body(req, ['parentId', 'title', 'template']);
    if (typeof data.title !== 'string') throw new PageWriteError(400, 'invalid', 'Invalid title');
    const parentId = data.parentId === undefined || data.parentId === null ? data.parentId as null | undefined : id(data.parentId, 'parentId');
    const template = data.template === undefined ? undefined : id(data.template, 'template');
    if (template !== undefined && !Object.hasOwn(PAGE_TEMPLATES, template)) throw new PageWriteError(400, 'invalid', 'Invalid template');
    res.status(201).json(createPage({ workspaceId: id(req.params.workspaceId, 'workspaceId'), ownerUserId: owner(req), parentId, title: data.title, template: template as keyof typeof PAGE_TEMPLATES | undefined }));
  }));

  // More specific workspace routes precede /pages/:pageId to keep trash paths unambiguous.
  router.get('/workspaces/:workspaceId/pages/trash', route((req, res) => {
    query(req, ['limit', 'cursor']);
    requirePagesWorkspace(id(req.params.workspaceId, 'workspaceId'), owner(req));
    const limit = req.query.limit === undefined ? 50 : integer(req.query.limit, 'limit', 1, 100);
    const cursor = optionalString(req.query.cursor, 'cursor', 500);
    res.json(listPageTrash(id(req.params.workspaceId, 'workspaceId'), owner(req), { limit, cursor }));
  }));

  router.get('/workspaces/:workspaceId/databases', route((req, res) => {
    query(req, []);
    res.json({ items: listDatabases(id(req.params.workspaceId, 'workspaceId'), owner(req)).map((database) => ({ ...database, rowCount: database.rows.length })) });
  }));
  router.post('/workspaces/:workspaceId/databases', route((req, res) => {
    query(req, []);
    const data = body(req, ['title', 'columns', 'views']);
    if (typeof data.title !== 'string' || (data.columns !== undefined && !Array.isArray(data.columns)) || (data.views !== undefined && !Array.isArray(data.views))) {
      throw new PageWriteError(400, 'invalid', 'Invalid database shape');
    }
    const createOps = [
      ...(data.columns as unknown[] | undefined ?? []).map((column) => ({ op: 'column.add', column })),
      ...(data.views as unknown[] | undefined ?? []).map((view) => ({ op: 'view.save', view })),
    ];
    const parsed = parsePageDatabaseOps(createOps, 'user');
    if (!parsed.ok) throw new PageWriteError(400, 'invalid', parsed.error);
    for (const item of [...(data.columns as Obj[] | undefined ?? []), ...(data.views as Obj[] | undefined ?? [])]) {
      if ('id' in item) throw new PageWriteError(400, 'invalid', 'Database resource IDs are assigned by the server');
    }
    const database = createDatabase({ workspaceId: id(req.params.workspaceId, 'workspaceId'), ownerUserId: owner(req), title: data.title,
      columns: (data.columns ?? []) as PageDatabase['columns'], views: (data.views ?? []) as PageDatabase['views'] });
    res.status(201).json(database);
  }));
  router.get('/workspaces/:workspaceId/task-database', route((req, res) => {
    query(req, []);
    res.json({ databaseId: findTaskDatabaseId(id(req.params.workspaceId, 'workspaceId'), owner(req)) });
  }));
  router.post('/workspaces/:workspaceId/task-database', route((req, res) => {
    query(req, []);
    body(req, []);
    const opened = openTaskDatabase({ workspaceId: id(req.params.workspaceId, 'workspaceId'), ownerUserId: owner(req) });
    res.status(opened.created ? 201 : 200).json(opened);
  }));

  router.get('/pages/:pageId/changes', route((req, res) => {
    query(req, ['afterSeq', 'beforeSeq', 'direction', 'limit', 'proposalState', 'applicationState']);
    const afterSeq = req.query.afterSeq === undefined ? undefined : integer(req.query.afterSeq, 'afterSeq');
    const beforeSeq = req.query.beforeSeq === undefined ? undefined : integer(req.query.beforeSeq, 'beforeSeq');
    const direction = req.query.direction;
    if (direction !== undefined && direction !== 'forward' && direction !== 'backward') throw new PageWriteError(400, 'invalid', 'Invalid history direction');
    const limit = req.query.limit === undefined ? undefined : integer(req.query.limit, 'limit', 1, 100);
    const proposalState = req.query.proposalState;
    if (proposalState !== undefined && !['pending', 'accepted', 'dismissed', 'null'].includes(String(proposalState))) throw new PageWriteError(400, 'invalid', 'Invalid proposalState');
    const applicationState = req.query.applicationState;
    if (applicationState !== undefined && !['applied', 'reverted', 'null'].includes(String(applicationState))) throw new PageWriteError(400, 'invalid', 'Invalid applicationState');
    const result = listRelevantChanges(id(req.params.pageId, 'pageId'), owner(req), {
      afterSeq, beforeSeq, direction: direction as 'forward' | 'backward' | undefined, limit, proposalState: proposalState === undefined ? undefined : proposalState === 'null' ? null : proposalState as 'pending' | 'accepted' | 'dismissed',
      applicationState: applicationState === undefined ? undefined : applicationState === 'null' ? null : applicationState as 'applied' | 'reverted',
    });
    res.json({ ...result, nextAfter: direction === 'backward' || !result.hasMore ? null : result.nextAfter,
      nextBefore: direction === 'backward' && result.hasMore ? result.nextBefore : null });
  }));

  router.get('/pages/:pageId/activity-seen', route((req, res) => {
    query(req, []);
    res.json({ lastSeenChangeSeq: getPageActivitySeen(id(req.params.pageId, 'pageId'), owner(req)) });
  }));
  router.post('/pages/:pageId/activity-seen', route((req, res) => {
    query(req, []);
    const data = body(req, ['lastSeenChangeSeq']) as Partial<PageActivitySeenRequest>;
    const sequence = integer(requireRequired(data.lastSeenChangeSeq, 'lastSeenChangeSeq'), 'lastSeenChangeSeq');
    res.json({ lastSeenChangeSeq: acknowledgePageActivity(id(req.params.pageId, 'pageId'), owner(req), sequence) });
  }));

  router.post('/pages/:pageId/edits', route((req, res) => {
    query(req, []);
    const data = body(req, ['revision', 'ops']);
    const pageId = id(req.params.pageId, 'pageId');
    const changes = applyUserPageEdits({ pageId, ownerUserId: owner(req), revision: integer(requireRequired(data.revision as number | undefined, 'revision'), 'revision', 1), ops: data.ops });
    res.json({ page: getPage(pageId, owner(req)), changes });
  }));
  router.get('/pages/:pageId', route((req, res) => {
    query(req, ['since']);
    const page = getPage(id(req.params.pageId, 'pageId'), owner(req));
    if (req.query.since !== undefined && integer(req.query.since, 'since') === page.viewVersion) { res.status(204).end(); return; }
    res.json(page);
  }));
  router.patch('/pages/:pageId', route((req, res) => {
    query(req, []);
    const data = body(req, ['revision', 'title', 'color', 'parentId', 'position']);
    const revision = integer(requireRequired(data.revision as number | undefined, 'revision'), 'revision', 1);
    const patch: { title?: string; color?: string | null; parentId?: string | null; position?: number } = {};
    if (data.title !== undefined) { if (typeof data.title !== 'string') throw new PageWriteError(400, 'invalid', 'Invalid title'); patch.title = data.title; }
    if (data.color !== undefined) { if (data.color !== null && (typeof data.color !== 'string' || data.color.length > 100)) throw new PageWriteError(400, 'invalid', 'Invalid color'); patch.color = data.color as string | null; }
    if (data.parentId !== undefined) patch.parentId = data.parentId === null ? null : id(data.parentId, 'parentId');
    if (data.position !== undefined) patch.position = integer(data.position, 'position');
    res.json(updatePageMetadata(id(req.params.pageId, 'pageId'), owner(req), patch, { expectedRevision: revision }));
  }));
  router.delete('/pages/:pageId', route((req, res) => {
    query(req, []);
    body(req, []);
    res.json({ deletionGroupId: deletePage(id(req.params.pageId, 'pageId'), owner(req)) });
  }));
  router.post('/pages/:pageId/restore', route((req, res) => {
    query(req, []);
    body(req, []);
    const page = pageRecord(id(req.params.pageId, 'pageId'), owner(req), { includeDeleted: true });
    if (!page.deletion_group_id) throw new PageWriteError(404, 'not_found', 'Deleted page not found');
    requirePagesWorkspace(page.workspace_id, owner(req), true);
    res.json({ restored: restorePageDeletionGroup(page.deletion_group_id, owner(req)) });
  }));
  router.delete('/pages/:pageId/permanent', route((req, res) => {
    query(req, []);
    body(req, []);
    const page = pageRecord(id(req.params.pageId, 'pageId'), owner(req), { includeDeleted: true });
    if (page.deleted_at === null || !page.deletion_group_id) throw new PageWriteError(404, 'not_found', 'Deleted page not found');
    requirePagesWorkspace(page.workspace_id, owner(req), true);
    res.json({ purged: purgePageDeletionGroup(page.deletion_group_id, owner(req)) });
  }));

  router.get('/databases/:databaseId', route((req, res) => {
    query(req, ['since']);
    const database = getDatabase(id(req.params.databaseId, 'databaseId'), owner(req));
    if (req.query.since !== undefined && integer(req.query.since, 'since') === database.revision) { res.status(204).end(); return; }
    res.json(database);
  }));
  router.post('/databases/:databaseId/edits', route((req, res) => {
    query(req, []);
    const data = body(req, ['revision', 'ops']);
    const databaseId = id(req.params.databaseId, 'databaseId');
    const changes = applyUserDatabaseEdits({ databaseId, ownerUserId: owner(req), revision: integer(requireRequired(data.revision as number | undefined, 'revision'), 'revision', 1), ops: data.ops });
    res.json({ database: getDatabase(databaseId, owner(req)), changes });
  }));
  router.get('/databases/:databaseId/task-activity', route((req, res) => {
    query(req, []);
    res.json(taskActivity(id(req.params.databaseId, 'databaseId'), owner(req), Date.now()));
  }));
  router.get('/databases/:databaseId/rows/:rowId/origin', route((req, res) => {
    query(req, []);
    res.json({ origin: taskOrigin(id(req.params.databaseId, 'databaseId'), id(req.params.rowId, 'rowId'), owner(req)) });
  }));

  router.post('/page-changes/:changeId/revert', route((req, res) => { query(req, []); body(req, []); res.json(revertChange(id(req.params.changeId), owner(req))); }));
  router.post('/page-changes/:changeId/redo', route((req, res) => { query(req, []); body(req, []); res.json(redoChange(id(req.params.changeId), owner(req))); }));
  router.post('/page-changes/:changeId/accept', route((req, res) => {
    query(req, []);
    const data = body(req, ['editedContent']);
    const change = getChange(id(req.params.changeId), owner(req), { write: true });
    res.json(acceptProposal(change.id, owner(req), Date.now(), data.editedContent));
  }));
  router.post('/page-changes/:changeId/dismiss', route((req, res) => { query(req, []); body(req, []); res.json(dismissProposal(id(req.params.changeId), owner(req))); }));
  router.post('/page-changes/:changeId/reopen', route((req, res) => { query(req, []); body(req, []); res.json(reopenProposal(id(req.params.changeId), owner(req))); }));
  /** The batch's workspace, 404 for a batch the caller does not own (or that does not exist). */
  const batchWorkspace = (req: Request, write: boolean): { batchId: string; workspaceId: string; records: PageChangeDto[] } => {
    const batchId = id(req.params.batchId, 'batchId');
    const rows = getDb().prepare('SELECT DISTINCT workspace_id FROM page_changes WHERE batch_id=? AND owner_user_id=?').all(batchId, owner(req)) as unknown as Array<{ workspace_id: string }>;
    if (rows.length !== 1) throw new PageWriteError(404, 'not_found', 'Page change batch not found');
    const workspaceId = rows[0]!.workspace_id;
    requirePagesWorkspace(workspaceId, owner(req), write);
    const records = listChangeBatch(batchId, owner(req), workspaceId);
    if (!records.length) throw new PageWriteError(404, 'not_found', 'Page change batch not found');
    return { batchId, workspaceId, records };
  };
  const batchRoute = (action: 'revert' | 'redo') => route((req, res) => {
    query(req, []);
    body(req, []);
    const { batchId, workspaceId } = batchWorkspace(req, true);
    res.json(action === 'revert' ? revertBatch(batchId, owner(req), workspaceId) : redoBatch(batchId, owner(req), workspaceId));
  });
  /** How much of a batch is applied or reverted now, so a card recovered after a reload shows Undo or Restore. */
  router.get('/page-batches/:batchId', route((req, res) => {
    query(req, []);
    const { batchId, records } = batchWorkspace(req, false);
    res.json({
      batchId,
      applied: records.filter((record) => record.applicationState === 'applied').length,
      reverted: records.filter((record) => record.applicationState === 'reverted').length,
    });
  }));
  router.post('/page-batches/:batchId/revert', batchRoute('revert'));
  router.post('/page-batches/:batchId/redo', batchRoute('redo'));

  router.use(errors);
  return router;
}
