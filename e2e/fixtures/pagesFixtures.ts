import type { Route } from '@playwright/test';
import type { AllTasksDto, HomeConversationItem, PageBlock, PageChangeDto, PageDatabase, PageDatabaseEditOp, PageDatabaseView, PageDto, PageLayoutPreferences, PageSummaryDto, SpaceSummaryDto, TaskActivity, TaskOrigin, ThreadCardItem } from 'michi-shared';
import { allTasksColumns, applyPageDatabaseOps, applyPageOps, parseUserPageOps, TASK_DATABASE_TITLE, taskDatabaseColumns, taskDatabaseViews } from 'michi-shared';

/** Small stateful native Pages API for browser-only acceptance. It models only
 * the public HTTP shapes used by the page editor; no backend, SQLite or agent
 * runtime is involved. Each test gets a fresh controller. */
export interface PagesMockController {
  handle(route: Route): Promise<boolean>;
  readonly writes: Array<{ path: string; body: Record<string, unknown> }>;
  readonly rawPaths: string[];
  readonly pages: Map<string, PageDto>;
  readonly databases: Map<string, PageDatabase>;
  readonly preferences: Map<string, PageLayoutPreferences>;
  /** Where conversations stand: task boards' live states, and each workspace's conversations for Link. */
  readonly threadStates: Map<string, ThreadCardItem>;
  /** Each workspace's task database id. */
  readonly taskDatabases: Map<string, string>;
  /** What the Meta agent's upkeep did to each task database, as task-activity reads it. */
  readonly taskActivity: Map<string, TaskActivity>;
  /** Who made each task, by `${databaseId}/${rowId}`. */
  readonly taskOrigins: Map<string, TaskOrigin>;
  /** Each workspace's name, for All tasks. */
  readonly workspaceNames: Map<string, string>;
  /** A database as it was before a batch, so Undo of the batch puts it back; a test seeds one for an upkeep batch. */
  readonly batchSnapshots: Map<string, { databaseId: string; before: PageDatabase }>;
  /** Make the next page read fail with a gateway response, then recover. */
  failNextPageRead(pageId: string): void;
  /** Keep page reads unavailable until the test explicitly restores them. */
  setPageReadUnavailable(pageId: string, unavailable: boolean): void;
  /** Seed a real human-edit marker and pending rewrite for the given block. */
  seedProposal(pageId: string, blockId: string, content: Record<string, unknown>): void;
  /** Make the next database write return a stale-revision conflict after server data changes. */
  failNextDatabaseEdit(databaseId: string): void;
}

const now = 1_800_000_000_000;
const json = (route: Route, value: unknown, status = 200) => route.fulfill({
  status, contentType: 'application/json', body: JSON.stringify(value),
});

function apiPath(route: Route): { path: string; connectionId: string } {
  const url = new URL(route.request().url());
  const full = url.pathname.replace(/^.*\/api/, '');
  const remote = full.match(/^\/backend-connections\/([^/]+)\/proxy(\/.*)?$/);
  return remote
    ? { path: remote[2] || '/', connectionId: decodeURIComponent(remote[1]) }
    : { path: full, connectionId: 'local' };
}

function summary(page: PageDto, pages: Map<string, PageDto>): SpaceSummaryDto {
  const descendants = [...pages.values()].filter((candidate) => candidate.id === page.id || candidate.parentId === page.id);
  return {
    id: page.id, workspaceId: page.workspaceId, parentId: page.parentId, position: page.position,
    title: page.title, color: page.color, updatedAt: page.updatedAt, updatedBy: page.updatedBy,
    pendingProposals: descendants.reduce((n, item) => n + item.pendingProposals, 0),
    helperNodeId: page.helperNodeId, workspaceName: 'E2E Workspace',
    childTitles: descendants.filter((item) => item.id !== page.id).map((item) => item.title),
    pageCount: descendants.length, databaseCount: 0, contributorNodeIds: [],
  };
}

function makeChange(page: PageDto, block: PageBlock, proposed: PageBlock, id: string): PageChangeDto {
  const location = { parentId: null, slot: null, previousId: null, nextId: null };
  const snapshot = { kind: 'block' as const, exists: true as const, block: { ...block }, location };
  return {
    id, seq: 1, batchId: `batch-${id}`, target: { kind: 'block', pageId: page.id, blockId: block.id }, op: 'update',
    before: snapshot, after: null,
    forward: { kind: 'block', op: 'upsert', block: proposed, location },
    inverse: { kind: 'block', op: 'upsert', block: { ...block }, location },
    baseRev: block.rev, appliedRev: null, previousHeadId: null,
    source: { kind: 'chat', nodeId: 'node-source', turnId: 'turn-source', assistantId: 'assistant-source' },
    proposalState: 'pending', applicationState: null, createdAt: now, resolvedAt: null,
  };
}

export function createPagesMockController(): PagesMockController {
  const pages = new Map<string, PageDto>();
  const databases = new Map<string, PageDatabase>();
  const preferences = new Map<string, PageLayoutPreferences>();
  const threadStates = new Map<string, ThreadCardItem>();
  const taskDatabases = new Map<string, string>();
  /** A task database as each edit found it, by the batch the edit made, for Undo. */
  const batches = new Map<string, { databaseId: string; before: PageDatabase }>();
  /** A task database as a batch Undo found it, so redoing the batch puts it back. */
  const undone = new Map<string, { databaseId: string; before: PageDatabase; after: PageDatabase }>();
  let databaseCounter = 0;
  const taskActivity = new Map<string, TaskActivity>();
  const taskOrigins = new Map<string, TaskOrigin>();
  const workspaceNames = new Map<string, string>();
  let allTasksViews: { views: PageDatabaseView[]; revision: number } = { views: taskDatabaseViews(), revision: 0 };
  const changes = new Map<string, PageChangeDto[]>();
  const writes: PagesMockController['writes'] = [];
  const rawPaths: string[] = [];
  const failedPageReads = new Set<string>();
  const unavailablePageReads = new Set<string>();
  const conflictedDatabaseEdits = new Set<string>();
  let pageCounter = 0;
  let blockCounter = 0;
  let changeCounter = 0;

  const recordWrite = (path: string, route: Route) => {
    let body: Record<string, unknown> = {};
    try { body = route.request().postDataJSON() as Record<string, unknown>; } catch { /* no body */ }
    writes.push({ path, body });
    return body;
  };
  const getPage = (id: string) => pages.get(id);

  return {
    pages, databases, preferences, writes, rawPaths, threadStates, taskDatabases, taskActivity, taskOrigins, workspaceNames, batchSnapshots: batches,
    failNextPageRead(pageId) { failedPageReads.add(pageId); },
    setPageReadUnavailable(pageId, unavailable) {
      if (unavailable) unavailablePageReads.add(pageId);
      else unavailablePageReads.delete(pageId);
    },
    seedProposal(pageId, blockId, content) {
      const page = getPage(pageId);
      const block = page?.blocks.find((item) => item.id === blockId);
      if (!page || !block) throw new Error(`Cannot seed proposal for missing block ${pageId}/${blockId}`);
      block.edit = { at: now - 1000 };
      const proposal = { ...block, ...content, rev: block.rev + 1 } as PageBlock;
      const id = `change-${++changeCounter}`;
      changes.set(pageId, [makeChange(page, block, proposal, id)]);
    },
    failNextDatabaseEdit(databaseId) { conflictedDatabaseEdits.add(databaseId); },
    async handle(route) {
      const request = route.request();
      const method = request.method();
      const { path, connectionId } = apiPath(route);
      rawPaths.push(new URL(request.url()).pathname);
      const pieces = path.split('/').filter(Boolean).map(decodeURIComponent);

      if (pieces[0] === 'pages' && pieces[2] === 'layout-preferences') {
        const previous = preferences.get(pieces[1]) ?? { text: '', revision: 0, updatedAt: null, updatedBy: null };
        if (method === 'GET') return json(route, previous).then(() => true);
        if (method === 'PUT') {
          const body = recordWrite(path, route);
          if (body.expectedRevision !== previous.revision) return json(route, { error: { code: 'stale_revision', message: 'Layout preferences changed elsewhere. Review the latest version before saving your draft.' } }, 409).then(() => true);
          const text = String(body.text).trim();
          const saved: PageLayoutPreferences = text === previous.text ? previous : { text, revision: previous.revision + 1, updatedAt: now, updatedBy: 'user' };
          preferences.set(pieces[1], saved);
          return json(route, saved).then(() => true);
        }
      }
      if (pieces[0] === 'pages' && pieces[2] === 'layout-rules' && method === 'GET') return json(route, { items: [] }).then(() => true);

      const activity = path.match(/^\/databases\/([^/]+)\/task-activity$/);
      if (activity && method === 'GET') {
        return json(route, taskActivity.get(decodeURIComponent(activity[1])) ?? { suggestions: [], marks: [], latestUpkeep: null }).then(() => true);
      }
      const origin = path.match(/^\/databases\/([^/]+)\/rows\/([^/]+)\/origin$/);
      if (origin && method === 'GET') {
        return json(route, { origin: taskOrigins.get(`${decodeURIComponent(origin[1])}/${decodeURIComponent(origin[2])}`) ?? null }).then(() => true);
      }
      const workspaceDatabases = path.match(/^\/workspaces\/([^/]+)\/databases$/);
      if (workspaceDatabases && method === 'GET') {
        const workspaceId = decodeURIComponent(workspaceDatabases[1]);
        const items = [...databases.values()].filter((database) => database.workspaceId === workspaceId).map((database) => ({ ...database, rowCount: database.rows.length }));
        return json(route, { items }).then(() => true);
      }
      if (path === '/spaces-home/all-tasks' && method === 'GET') {
        const taskDbs = [...databases.values()].filter((database) => database.role === 'tasks');
        const body: AllTasksDto = {
          sources: taskDbs.map((database) => ({
            workspaceId: database.workspaceId, workspaceName: workspaceNames.get(database.workspaceId) ?? 'E2E Workspace',
            databaseId: database.id, revision: database.revision,
            statuses: database.columns.find((column) => column.id === 'status')?.options ?? [],
          })),
          rows: taskDbs.flatMap((database) => database.rows.map((row) => ({ databaseId: database.id, row }))),
          views: allTasksViews.views,
          viewsRevision: allTasksViews.revision,
        };
        return json(route, body).then(() => true);
      }
      if (path === '/spaces-home/all-tasks/views' && method === 'POST') {
        const body = recordWrite(path, route);
        if (body.revision !== allTasksViews.revision) return json(route, { error: { code: 'stale_revision', message: 'All tasks views changed' } }, 409).then(() => true);
        const host: PageDatabase = { id: 'all-tasks', workspaceId: '', title: 'All tasks', revision: 1, updatedAt: now, columns: allTasksColumns([]), views: allTasksViews.views, rows: [] };
        const result = applyPageDatabaseOps(host, body.ops as PageDatabaseEditOp[], { actor: 'user', revision: 2, now, newId: (prefix) => `${prefix}-${++databaseCounter}` });
        allTasksViews = { views: result.database.views, revision: allTasksViews.revision + 1 };
        return json(route, { views: allTasksViews.views, viewsRevision: allTasksViews.revision }).then(() => true);
      }
      const taskDatabase = path.match(/^\/workspaces\/([^/]+)\/task-database$/);
      if (taskDatabase) {
        const workspaceId = decodeURIComponent(taskDatabase[1]);
        const existing = taskDatabases.get(workspaceId);
        if (method === 'GET') return json(route, { databaseId: existing ?? null }).then(() => true);
        if (method === 'POST') {
          recordWrite(path, route);
          if (existing) return json(route, { database: databases.get(existing), created: false }).then(() => true);
          const id = `tasks-${++databaseCounter}`;
          const database: PageDatabase = { id, workspaceId, title: TASK_DATABASE_TITLE, role: 'tasks', revision: 1, updatedAt: now,
            columns: taskDatabaseColumns(), views: taskDatabaseViews(), rows: [] };
          databases.set(id, database);
          taskDatabases.set(workspaceId, id);
          return json(route, { database, created: true }, 201).then(() => true);
        }
      }
      if (method === 'POST' && path === '/spaces-home/thread-states') {
        const body = recordWrite(path, route);
        const ids = Array.isArray(body.nodeIds) ? body.nodeIds as string[] : [];
        return json(route, { items: ids.flatMap((id) => threadStates.get(id) ?? []) }).then(() => true);
      }
      const query = new URL(request.url()).searchParams;
      if (method === 'GET' && path === '/spaces-home/conversations' && query.has('workspaceId')) {
        const workspaceId = query.get('workspaceId');
        const items: HomeConversationItem[] = [...threadStates.values()].filter((card) => card.workspaceId === workspaceId).map((card) => ({
          id: `conversation:${card.nodeId}`, kind: 'conversation', workspaceId: card.workspaceId, workspaceName: 'E2E Workspace',
          title: card.title, at: card.at, summary: card.summary, agentClaim: false,
          state: card.state === 'waiting' || card.state === 'stalled' || card.state === 'done' ? card.state : null,
          target: { kind: 'conversation', nodeId: card.nodeId, workspaceId: card.workspaceId, messageId: card.messageId },
        }));
        return json(route, { items, total: items.length }).then(() => true);
      }
      const batchState = path.match(/^\/page-batches\/([^/]+)$/);
      if (batchState && method === 'GET') {
        const batchId = decodeURIComponent(batchState[1]);
        if (!batches.has(batchId) && !undone.has(batchId)) return json(route, { error: { code: 'not_found', message: 'Page change batch not found' } }, 404).then(() => true);
        return json(route, { batchId, applied: batches.has(batchId) ? 1 : 0, reverted: undone.has(batchId) ? 1 : 0 }).then(() => true);
      }
      const revert = path.match(/^\/page-batches\/([^/]+)\/revert$/);
      if (revert && method === 'POST') {
        recordWrite(path, route);
        const batchId = decodeURIComponent(revert[1]);
        const saved = batches.get(batchId);
        if (!saved) return json(route, { error: { code: 'not_found', message: 'Page change batch not found' } }, 404).then(() => true);
        const current = databases.get(saved.databaseId);
        if (current) undone.set(batchId, { databaseId: saved.databaseId, before: saved.before, after: current });
        databases.set(saved.databaseId, { ...saved.before, revision: (current?.revision ?? saved.before.revision) + 1, updatedAt: now });
        batches.delete(batchId);
        // Undoing the Meta agent's latest update takes its line and marks off the board; its suggestions stay.
        const upkept = taskActivity.get(saved.databaseId);
        if (upkept?.latestUpkeep?.batchId === batchId) taskActivity.set(saved.databaseId, { ...upkept, marks: [], latestUpkeep: null });
        return json(route, { reverted: [`change-${batchId}`], conflicts: [] }).then(() => true);
      }
      const redo = path.match(/^\/page-batches\/([^/]+)\/redo$/);
      if (redo && method === 'POST') {
        recordWrite(path, route);
        const saved = undone.get(decodeURIComponent(redo[1]));
        if (!saved) return json(route, { error: { code: 'not_found', message: 'Page change batch not found' } }, 404).then(() => true);
        const current = databases.get(saved.databaseId);
        batches.set(decodeURIComponent(redo[1]), { databaseId: saved.databaseId, before: saved.before });
        databases.set(saved.databaseId, { ...saved.after, revision: (current?.revision ?? saved.after.revision) + 1, updatedAt: now });
        undone.delete(decodeURIComponent(redo[1]));
        return json(route, { redone: [`change-${decodeURIComponent(redo[1])}`], conflicts: [] }).then(() => true);
      }
      if (method === 'GET' && path === '/spaces') {
        const roots = [...pages.values()].filter((page) => page.parentId === null);
        return json(route, { items: roots.map((page) => summary(page, pages)), nextCursor: null }).then(() => true);
      }
      const workspacePages = path.match(/^\/workspaces\/([^/]+)\/pages$/);
      if (workspacePages && method === 'GET') {
        const workspaceId = decodeURIComponent(workspacePages[1]);
        return json(route, { items: [...pages.values()].filter((item) => item.workspaceId === workspaceId), nextCursor: null }).then(() => true);
      }
      if (workspacePages && method === 'POST') {
        const workspaceId = decodeURIComponent(workspacePages[1]);
        const body = recordWrite(path, route);
        const id = `page-${++pageCounter}`;
        const blocks: PageBlock[] = body.template === 'release'
          ? [
            { id: `block-${++blockCounter}`, rev: 1, type: 'heading', text: 'Goal' },
            { id: `block-${++blockCounter}`, rev: 1, type: 'markdown', text: 'Ship a clear release.' },
            { id: `block-${++blockCounter}`, rev: 1, type: 'heading', text: 'Progress' },
            { id: `block-${++blockCounter}`, rev: 1, type: 'callout', title: 'Progress', text: 'The release is in review.', tone: 'info' },
            { id: `block-${++blockCounter}`, rev: 1, type: 'heading', text: 'Risks' },
            { id: `block-${++blockCounter}`, rev: 1, type: 'markdown', text: 'Confirm the launch date.' },
            { id: `block-${++blockCounter}`, rev: 1, type: 'heading', text: 'Release checklist' },
          ]
          : [{ id: `block-${++blockCounter}`, rev: 1, type: 'markdown', text: '' }];
        const page: PageDto = {
          id, workspaceId, parentId: typeof body.parentId === 'string' ? body.parentId : null,
          position: pageCounter, title: String(body.title ?? 'Untitled page'), color: null,
          updatedAt: now + pageCounter, updatedBy: 'user', pendingProposals: 0,
          helperNodeId: null, revision: 1, viewVersion: 1,
          blocks,
        };
        if (body.template === 'release') {
          const databaseId = `database-${pageCounter}`;
          const taskColumn = `column-task-${pageCounter}`;
          const statusColumn = `column-status-${pageCounter}`;
          const ownerColumn = `column-owner-${pageCounter}`;
          const tableView = `view-table-${pageCounter}`;
          const boardView = `view-board-${pageCounter}`;
          page.blocks.push({ id: `block-${++blockCounter}`, rev: 1, type: 'database-ref', databaseId, viewId: boardView });
          page.revision++;
          page.viewVersion++;
          databases.set(databaseId, {
            id: databaseId, workspaceId, title: 'Release checklist', revision: 1, updatedAt: now,
            columns: [
              { id: taskColumn, name: 'Task', type: 'text', editable: true, width: 220 },
              { id: statusColumn, name: 'Status', type: 'select', editable: true, options: [
                { value: 'todo', label: 'To do', color: 'gray' }, { value: 'doing', label: 'In progress', color: 'blue' }, { value: 'done', label: 'Done', color: 'green' },
              ] },
              { id: ownerColumn, name: 'Owner', type: 'text', editable: true, width: 140 },
            ],
            views: [
              { id: tableView, name: 'Table', type: 'table', position: 0, config: { filters: [], match: 'all', sorts: [] } },
              { id: boardView, name: 'Board', type: 'board', position: 1, config: { filters: [], match: 'all', sorts: [], group: statusColumn } },
            ],
            rows: [{ id: `row-${pageCounter}`, values: { [taskColumn]: 'Draft launch checklist', [statusColumn]: 'todo', [ownerColumn]: 'Alex' }, position: 0, updatedAt: now, rev: 1, edited: {}, bodyEditedAt: null }],
          });
        }
        pages.set(id, page);
        return json(route, { page: summary(page, pages) }).then(() => true);
      }
      if (pieces[0] === 'pages' && pieces.length >= 2) {
        const id = pieces[1];
        const page = getPage(id);
        if (pieces.length === 2 && method === 'GET') {
          if (failedPageReads.delete(id) || unavailablePageReads.has(id)) return json(route, { error: { code: 'remote_unavailable', message: 'Backend unavailable' } }, 503).then(() => true);
          return (page ? json(route, { page }) : route.fulfill({ status: 204 })).then(() => true);
        }
        if (pieces.length === 2 && method === 'PATCH') {
          const body = recordWrite(path, route);
          if (!page) return json(route, { error: { code: 'page_not_found', message: 'Page not found' } }, 404).then(() => true);
          if (body.revision !== page.revision) return json(route, { error: { code: 'stale', message: 'Page changed' } }, 409).then(() => true);
          if (typeof body.title === 'string') page.title = body.title;
          if (body.parentId === null || typeof body.parentId === 'string') page.parentId = body.parentId;
          page.revision++;
          page.updatedAt++;
          return json(route, { page: summary(page, pages) }).then(() => true);
        }
        if (pieces.length === 2 && method === 'DELETE') {
          recordWrite(path, route);
          const removed = new Set([id]);
          let added = true;
          while (added) {
            added = false;
            for (const candidate of pages.values()) {
              if (candidate.parentId && removed.has(candidate.parentId) && !removed.has(candidate.id)) {
                removed.add(candidate.id);
                added = true;
              }
            }
          }
          for (const removedId of removed) pages.delete(removedId);
          return json(route, { ok: true }).then(() => true);
        }
        if (pieces[2] === 'edits' && method === 'POST') {
          const body = recordWrite(path, route);
          if (!page) return json(route, { error: { code: 'page_not_found', message: 'Page not found' } }, 404).then(() => true);
          if (body.revision !== page.revision) return json(route, { error: { code: 'stale', message: 'Page changed' } }, 409).then(() => true);
          const ops = Array.isArray(body.ops) ? body.ops as Array<Record<string, unknown>> : [];
          for (const op of ops) {
            if (op.op === 'insert' && op.block && typeof op.block === 'object') {
              const parsed = parseUserPageOps([op]);
              if (!parsed) throw new Error('Invalid mock page insertion');
              page.blocks = applyPageOps(page.blocks, parsed, { actor: 'user', revision: page.revision + 1, now, newId: () => `block-${++blockCounter}` }).blocks;
            } else if (op.op === 'move' || op.op === 'delete') {
              const parsed = parseUserPageOps([op]);
              if (!parsed) throw new Error('Invalid mock page operation');
              page.blocks = applyPageOps(page.blocks, parsed, { actor: 'user', revision: page.revision + 1, now }).blocks;
            } else if (op.op === 'update' && typeof op.id === 'string') {
              const block = page.blocks.find((item) => item.id === op.id);
              if (block && op.block && typeof op.block === 'object') {
                Object.assign(block, op.block, { rev: block.rev + 1, edit: { at: now } });
                const proposed = { ...block, ...(block.type === 'markdown' ? { text: `${String(block.text ?? '')} (reviewed)` } : {}) } as PageBlock;
                changes.set(id, [makeChange(page, block, proposed, `change-${++changeCounter}`)]);
              }
            }
          }
          page.revision++;
          page.viewVersion++;
          page.updatedAt++;
          page.updatedBy = 'user';
          return json(route, { page, changes: { resource: { kind: 'page', id }, revision: page.revision, applied: [], proposed: [], rejected: [] } }).then(() => true);
        }
        if (pieces[2] === 'changes' && method === 'GET') {
          const query = new URL(request.url()).searchParams;
          const limit = Math.min(100, Math.max(1, Number(query.get('limit') ?? 50)));
          const direction = query.get('direction') === 'backward' ? 'backward' : 'forward';
          const after = Number(query.get('afterSeq') ?? 0);
          const before = Number(query.get('beforeSeq') ?? Number.MAX_SAFE_INTEGER);
          const ordered = [...(changes.get(id) ?? [])].sort((a, b) => direction === 'backward' ? b.seq - a.seq : a.seq - b.seq);
          const filtered = ordered.filter((item) => direction === 'backward' ? item.seq < before : item.seq > after);
          const items = filtered.slice(0, limit);
          return json(route, { changes: items, nextAfter: direction === 'forward' ? items.at(-1)?.seq ?? after : after,
            nextBefore: direction === 'backward' && filtered.length > limit ? items.at(-1)?.seq ?? null : null, hasMore: filtered.length > limit }).then(() => true);
        }
        if (pieces[2] === 'activity-seen' && method === 'GET') return json(route, { lastSeenChangeSeq: 0 }).then(() => true);
      }
      // A suggestion on a task: accepting writes it to the row; either way it stops waiting on the card.
      const suggestion = pieces[0] === 'page-changes' && method === 'POST'
        ? [...taskActivity.entries()].flatMap(([databaseId, item]) => item.suggestions.map((change) => ({ databaseId, change })))
          .find((entry) => entry.change.id === pieces[1])
        : undefined;
      if (suggestion) {
        recordWrite(path, route);
        const action = pieces[2];
        const { databaseId, change } = suggestion;
        const database = databases.get(databaseId);
        const forward = change.forward;
        if (action === 'accept' && database && forward.kind === 'row' && forward.op === 'patch') {
          databases.set(databaseId, { ...database, revision: database.revision + 1, updatedAt: now + database.revision,
            rows: database.rows.map((row) => (row.id === forward.id ? { ...row, values: { ...row.values, ...forward.values }, rev: row.rev + 1 } : row)) });
        }
        const waiting = taskActivity.get(databaseId)!;
        taskActivity.set(databaseId, { ...waiting, suggestions: waiting.suggestions.filter((item) => item.id !== change.id) });
        const resolved: PageChangeDto = { ...change, proposalState: action === 'accept' ? 'accepted' : 'dismissed', applicationState: action === 'accept' ? 'applied' : null, resolvedAt: now };
        return json(route, resolved).then(() => true);
      }
      if (pieces[0] === 'page-changes' && method === 'POST') {
        const id = pieces[1];
        const action = pieces[2];
        const change = [...changes.values()].flat().find((item) => item.id === id);
        if (change) {
          const mutation = action === 'revert' ? change.inverse : change.forward;
          if ((action === 'accept' || action === 'revert' || action === 'redo') && change.target.kind === 'block'
            && mutation.kind === 'block' && mutation.op === 'upsert') {
            const target = getPage(change.target.pageId);
            const block = target?.blocks.find((item) => item.id === change.target.blockId);
            if (block) Object.assign(block, mutation.block);
            if (target) { target.revision++; target.viewVersion++; target.updatedAt++; }
          }
          if (action === 'accept') { change.proposalState = 'accepted'; change.applicationState = 'applied'; change.appliedRev = 2; }
          else if (action === 'revert') change.applicationState = 'reverted';
          else if (action === 'redo') change.applicationState = 'applied';
        }
        recordWrite(path, route);
        return json(route, { change }).then(() => true);
      }
      if (pieces[0] === 'databases' && pieces.length >= 2 && method === 'GET') {
        const database = databases.get(pieces[1]);
        return (database ? json(route, { database }) : route.fulfill({ status: 204 })).then(() => true);
      }
      if (pieces[0] === 'databases' && pieces[2] === 'edits' && method === 'POST') {
        const body = recordWrite(path, route);
        const database = databases.get(pieces[1]);
        if (!database) return json(route, { error: { code: 'database_not_found', message: 'Database not found' } }, 404).then(() => true);
        if (conflictedDatabaseEdits.delete(database.id)) {
          const taskColumn = database.columns.find((column) => column.name === 'Task');
          if (taskColumn && database.rows[0]) database.rows[0].values[taskColumn.id] = 'Server edit from another pane';
          database.revision++;
          return json(route, { error: { code: 'stale_revision', message: 'Database revision changed' } }, 409).then(() => true);
        }
        const ops = Array.isArray(body.ops) ? body.ops as Array<Record<string, unknown>> : [];
        // A task database is edited as Michi does it: every op, row revisions, and a batch Undo can put back.
        if (database.role === 'tasks') {
          const result = applyPageDatabaseOps(database, ops as unknown as PageDatabaseEditOp[], {
            actor: 'user', revision: database.revision + 1, now: now + database.revision, newId: (prefix) => `${prefix}-${++databaseCounter}`,
          });
          databases.set(database.id, result.database);
          const batchId = `batch-db-${++changeCounter}`;
          batches.set(batchId, { databaseId: database.id, before: database });
          const applied = [{ id: `change-${batchId}`, seq: changeCounter, batchId, target: { kind: 'database', databaseId: database.id }, source: { kind: 'user' } }];
          return json(route, { database: result.database, changes: { resource: { kind: 'database', id: database.id }, revision: result.database.revision, applied, proposed: [], rejected: [] } }).then(() => true);
        }
        for (const op of ops) {
          if (op.op === 'row.update' && typeof op.id === 'string') {
            const row = database.rows.find((item) => item.id === op.id);
            if (row && op.values && typeof op.values === 'object') Object.assign(row.values, op.values);
          }
        }
        database.revision++;
        return json(route, { database, changes: { resource: { kind: 'database', id: database.id }, revision: database.revision, applied: [], proposed: [], rejected: [] } }).then(() => true);
      }
      // These requests are outside the seam's surface and should continue into
      // installMockApi's standard browser-only responses.
      void connectionId;
      return false;
    },
  };
}
