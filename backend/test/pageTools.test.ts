import { readHomeCards, editHomeCustomization } from '../src/services/homeCards/repository';
import { applyUserPageEdits } from '../src/services/pages/pageWrites';
import { listEligibleMaintenanceManifest } from '../src/services/pages/maintenanceRepository';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_TOOLS } from '../src/agents/builtinTools';
import { PAGE_TOOL_NAMES } from '../src/agents/pageToolNames';
import { runPageTool, type PageToolCaller } from '../src/agents/pageTools';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createDatabase, createPage, getDatabase, getPage, listPages } from '../src/services/pages/repository';
import { pageComponents } from '../src/services/pages/components';
import { applyUserDatabaseEdits } from '../src/services/pages/databaseWrites';
import { ensureWorkspaceHomePageId } from '../src/services/pages/homePages';
import { addLayoutRule, saveLayoutPreferences } from '../src/services/pages/layoutRules';
import type { PageDatabase, PageWriteResult } from 'michi-shared';
import { acceptProposal, revertChange, redoChange } from '../src/services/pages/pageChanges';

const ownerUserId = 'alice';
const workspaceId = 'ws';
const nodeId = 'node';
let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;

function caller(overrides: Partial<PageToolCaller> = {}): PageToolCaller {
  return {
    ownerUserId, workspaceId, nodeId, ownerKind: 'chat_node',
    getActivePageTurnAttribution: () => ({ turnId: 'turn', assistantId: 'assistant' }),
    ...overrides,
  };
}

function pageCount(): number {
  return listPages(workspaceId, ownerUserId, { limit: 100 }).items.length;
}

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-page-tools-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run(workspaceId, 'Workspace', ownerUserId);
  getDb().prepare('INSERT INTO trees(id,workspace_id,root_node_id,last_active_at,created_at) VALUES (?,?,?,?,?)').run('tree', workspaceId, nodeId, 1, 1);
  getDb().prepare("INSERT INTO nodes(id,workspace_id,tree_id,kind,status,created_at) VALUES (?,?,?,'chat','running',1)").run(nodeId, workspaceId, 'tree');
  getDb().prepare('INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES (?,?,?,\'active\',1,1)').run('turn', nodeId, 'assistant');
});

afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the Page tools are in the built-in catalog and page executor enforces owner and workspace scope', () => {
  assert.deepEqual(PAGE_TOOL_NAMES, ['read_home', 'edit_home', 'list_pages', 'read_page', 'edit_page', 'create_page', 'create_database', 'configure_database', 'read_database', 'edit_database', 'list_page_components', 'read_page_component', 'save_page_component', 'configure_database_view', 'open_task_database', 'list_tasks']);
  assert.deepEqual(BUILTIN_TOOLS.filter((tool) => PAGE_TOOL_NAMES.includes(tool.name as (typeof PAGE_TOOL_NAMES)[number])).map((tool) => tool.name).sort(), [...PAGE_TOOL_NAMES].sort());

  const page = createPage({ workspaceId, ownerUserId, title: 'Release' });
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws2', 'Second', ownerUserId);
  const crossWorkspace = createPage({ workspaceId: 'ws2', ownerUserId, title: 'Private to another workspace' });
  assert.ok(crossWorkspace.id);
  const preferences = saveLayoutPreferences({ pageId: page.id, ownerUserId, text: 'Use two columns', expectedRevision: 0, actor: 'user' });
  const rule = addLayoutRule({ pageId: page.id, ownerUserId, text: 'Keep it brief', createdBy: 'user' });
  const result = runPageTool('read_page', caller(), { pageId: page.id });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent?.layoutPreferences, preferences);
  assert.deepEqual(result.structuredContent?.layoutRules, [{ id: rule.id, text: rule.text }]);
  const denied = runPageTool('read_page', caller(), { pageId: crossWorkspace.id });
  assert.equal(denied.isError, true);
  const runDenied = runPageTool('list_pages', caller({ ownerKind: 'agent_run' }), {});
  assert.equal(runDenied.isError, true);
});

test('component library tools derive creator identity from the active chat turn', () => {
  const listed = runPageTool('list_page_components', caller(), {});
  assert.equal(listed.isError, undefined);
  const initial = listed.details as { revision: number; items: unknown[] };
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.items, []);

  const saved = runPageTool('save_page_component', caller(), {
    expectedLibraryRevision: initial.revision,
    component: { name: 'status-card', description: 'Release status', code: "root.appendChild(document.createTextNode('ok'));", propsSchema: { type: 'object', properties: { label: { type: 'string' } } } },
    source: { kind: 'user', nodeId: 'forged' },
  });
  assert.equal(saved.isError, undefined);
  const savedResult = saved.details as { component: { id: string; activeVersion: number }; version: { source: Record<string, string> }; revision: number; michiPageWrite: Record<string, unknown> };
  assert.equal(savedResult.revision, 1);
  assert.equal(savedResult.component.activeVersion, 1);
  assert.deepEqual(savedResult.version.source, { kind: 'chat', nodeId, turnId: 'turn', assistantId: 'assistant' });
  assert.equal(savedResult.michiPageWrite.kind, 'michiPageWrite');

  const read = runPageTool('read_page_component', caller(), { componentId: savedResult.component.id });
  assert.equal(read.isError, undefined);
  assert.equal((read.details as { code: string }).code, "root.appendChild(document.createTextNode('ok'));");
  const noTurn = runPageTool('save_page_component', caller({ getActivePageTurnAttribution: () => null }), {
    expectedLibraryRevision: 1, component: { name: 'second-card', description: 'Second', code: "root.appendChild(document.createTextNode('second'));" },
  });
  assert.equal(noTurn.isError, true);
  const runDenied = runPageTool('list_page_components', caller({ ownerKind: 'agent_run' }), {});
  assert.equal(runDenied.isError, true);
});

test('custom database view tool uses database revision checks and respects protected view ownership', () => {
  const component = runPageTool('save_page_component', caller(), {
    expectedLibraryRevision: 0,
    component: { name: 'view-card', description: 'Custom view', code: "root.appendChild(document.createTextNode('custom'));" },
  }).details as { component: { id: string } };
  const createdDatabase = createDatabase({ workspaceId, ownerUserId, title: 'Tasks' });
  const databaseId = createdDatabase.id;
  const database = applyUserDatabaseEdits({ databaseId, ownerUserId, revision: createdDatabase.revision,
    ops: [{ op: 'view.save', view: { id: 'view-main', name: 'Main', type: 'table', config: { filters: [], match: 'all', sorts: [] } } }] });
  const configured = runPageTool('configure_database_view', caller(), {
    databaseId, revision: database.revision, viewId: 'view-main',
    config: { componentId: component.component.id, props: {} },
  });
  assert.equal(configured.isError, undefined, JSON.stringify(configured.details));
  const toolPayload = configured.details as { result: { revision: number; applied: unknown[]; proposed: unknown[] } };
  assert.equal(toolPayload.result.applied.length, 0);
  assert.equal(toolPayload.result.proposed.length, 1, 'a user-edited view produces a proposal');
  const saved = getDatabase(databaseId, ownerUserId);
  assert.equal(saved.revision, database.revision);
  assert.notEqual(saved.views[0]?.type, 'custom');

  pageComponents.replaceReferences(ownerUserId, workspaceId, 'database_view', databaseId, [{
    componentId: component.component.id, viewId: 'view-main', pinnedVersion: 1,
    protected: true, hostRevision: saved.revision,
  }], Date.now(), 'user');
  const protectedResult = runPageTool('configure_database_view', caller(), {
    databaseId, revision: saved.revision, viewId: 'view-main',
    config: { componentId: component.component.id, props: { label: 'new' } },
  });
  assert.equal(protectedResult.isError, undefined);
  assert.equal(((protectedResult.details as { result: { proposed: unknown[] } }).result.proposed).length, 1);

  const createTarget = createDatabase({ workspaceId, ownerUserId, title: 'New View Database' });
  const createdView = runPageTool('configure_database_view', caller(), {
    databaseId: createTarget.id, revision: createTarget.revision,
    config: { componentId: component.component.id, props: {} },
  });
  assert.equal(createdView.isError, undefined, JSON.stringify(createdView.details));
  const createdPayload = createdView.details as { viewId: string; result: { revision: number; applied: unknown[] } };
  assert.match(createdPayload.viewId, /^view-/);
  assert.equal(createdPayload.result.applied.length, 1);
  const afterCreate = getDatabase(createTarget.id, ownerUserId);
  const customView = afterCreate.views.find((view) => view.id === createdPayload.viewId);
  assert.equal(afterCreate.revision, createTarget.revision + 1);
  assert.equal(customView?.type, 'custom');
  assert.equal(customView?.name, 'view-card');
  assert.equal(customView?.config.componentId, component.component.id);
  assert.equal(customView?.config.pinnedVersion, undefined, 'an omitted version follows the active version');

  const staleResult = runPageTool('configure_database_view', caller(), {
    databaseId, revision: createdDatabase.revision, viewId: 'view-main',
    config: { componentId: component.component.id, props: {} },
  });
  assert.equal(staleResult.isError, true);
  assert.match(String((staleResult.details as { error: string }).error), /revision changed/);
});

test('writes require active server attribution and ignore identity fields supplied in tool arguments', () => {
  const page = createPage({ workspaceId, ownerUserId, title: 'Target' });
  const countBefore = pageCount();
  const forged = {
    ownerUserId, workspaceId, nodeId, turnId: 'turn', assistantId: 'assistant', source: { kind: 'chat' },
    title: 'Forged page',
  };
  const noTurn = caller({ getActivePageTurnAttribution: () => null });
  const createDenied = runPageTool('create_page', noTurn, forged);
  assert.equal(createDenied.isError, true);
  assert.equal(pageCount(), countBefore);

  const editDenied = runPageTool('edit_page', noTurn, {
    ...forged, pageId: page.id,
    ops: [{ op: 'insert', block: { type: 'heading', text: 'Forged' }, after: null }],
  });
  assert.equal(editDenied.isError, true);
  assert.equal(getPage(page.id, ownerUserId).revision, 1);
});

test('agent writes return a structured receipt and create initial blocks with the trusted source', () => {
  const page = createPage({ workspaceId, ownerUserId, title: 'Working page' });
  const edit = runPageTool('edit_page', caller(), {
    pageId: page.id,
    ops: [{ op: 'insert', block: { type: 'heading', text: 'Progress' }, after: null }],
  });
  assert.equal(edit.isError, undefined);
  const receipt = (edit.details as { michiPageWrite?: Record<string, unknown> }).michiPageWrite;
  assert.equal(receipt?.kind, 'michiPageWrite');
  assert.equal(receipt?.resourceId, page.id);
  assert.equal(receipt?.appliedCount, 1);
  assert.ok(Array.isArray(receipt?.affectedTargetIds));
  // Runtimes cut tool output at 16 KB: the receipt must come before the long change records.
  assert.deepEqual(Object.keys(edit.details as object).slice(0, 2), ['michiPageWrite', 'result']);
  assert.ok(edit.content[0]!.text.startsWith('{"michiPageWrite":'));
  assert.equal(receipt?.taskBoard, undefined);

  const board = runPageTool('edit_page', caller(), {
    pageId: page.id,
    ops: [{ op: 'insert', block: { type: 'task-view' }, after: null }],
  });
  assert.equal((board.details as { michiPageWrite?: Record<string, unknown> }).michiPageWrite?.taskBoard, true);

  const created = runPageTool('create_page', caller(), { title: 'Agent-created', template: 'research' });
  assert.equal(created.isError, undefined);
  const createdPayload = created.details as { page: { id: string }; michiPageWrite: { created?: boolean; appliedCount?: number } };
  assert.equal(createdPayload.michiPageWrite.created, true);
  assert.equal(createdPayload.michiPageWrite.appliedCount, 0);
  const createdPage = getPage(createdPayload.page.id, ownerUserId);
  assert.equal(createdPage.updatedBy, 'agent');
  assert.ok(createdPage.blocks.every((block) => block.sources?.some((source) => source.nodeId === nodeId && source.turnId === 'turn' && source.assistantId === 'assistant')));
});

test('a container update that newly adds a task board marks the receipt', () => {
  const page = createPage({ workspaceId, ownerUserId, title: 'Container page' });
  const grid = (blocks: unknown[]) => ({ type: 'grid', regions: [{ id: 'main', span: 12, blocks }] });
  const inserted = runPageTool('edit_page', caller(), { pageId: page.id, ops: [{ op: 'insert', block: grid([]), after: null }] });
  const receiptOf = (result: { details?: unknown }) => (result.details as { michiPageWrite?: Record<string, unknown> }).michiPageWrite;
  assert.equal(receiptOf(inserted)?.taskBoard, undefined);
  const gridBlock = getPage(page.id, ownerUserId).blocks[0]!;
  const updated = runPageTool('edit_page', caller(), { pageId: page.id, ops: [{ op: 'update', id: gridBlock.id, expectRev: gridBlock.rev, block: grid([{ type: 'task-view' }]) }] });
  assert.equal(receiptOf(updated)?.appliedCount, 1);
  assert.equal(receiptOf(updated)?.taskBoard, true);
});

test('helper attribution is derived from nodes.page_id and is validated against the active turn', () => {
  const page = createPage({ workspaceId, ownerUserId, title: 'Helper source' });
  getDb().prepare("INSERT INTO nodes(id,workspace_id,tree_id,kind,status,page_id,created_at) VALUES ('helper',?,'tree','chat','running',?,1)").run(workspaceId, page.id);
  getDb().prepare('INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES (?,?,?,\'active\',1,1)').run('helper-turn', 'helper', 'helper-assistant');
  const helper = caller({ nodeId: 'helper', getActivePageTurnAttribution: () => ({ turnId: 'helper-turn', assistantId: 'helper-assistant' }) });
  const result = runPageTool('edit_page', helper, { pageId: page.id, ops: [{ op: 'insert', block: { type: 'callout', text: 'Helper note' }, after: null }] });
  assert.equal(result.isError, undefined);
  const changed = getPage(page.id, ownerUserId);
  assert.ok(changed.blocks.some((block) => block.sources?.some((source) => source.nodeId === 'helper')));
});

test("an ordinary chat opens its workspace's task database once and lists its tasks", () => {
  const opened = runPageTool('open_task_database', caller(), { workspaceId: 'ws2' });
  assert.equal(opened.isError, undefined, JSON.stringify(opened.details));
  const answer = opened.details as {
    kind: string; created: boolean; databaseId: string; workspaceId: string; taskCount: number;
    columns: Array<{ id: string }>; statuses: Array<{ value: string; core: boolean }>; views: Array<{ id: string }>;
  };
  assert.equal(answer.kind, 'taskDatabase');
  assert.equal(answer.created, true);
  assert.equal(answer.workspaceId, workspaceId, 'a named workspace never moves an ordinary chat');
  assert.equal(answer.taskCount, 0);
  assert.deepEqual(answer.columns.map((column) => column.id), ['task', 'status', 'threads', 'next']);
  assert.deepEqual(answer.statuses.map((status) => [status.value, status.core]), [['todo', true], ['doing', true], ['waiting', true], ['done', true]]);
  assert.deepEqual(answer.views.map((view) => view.id), ['tasks-board', 'tasks-table', 'tasks-needs-you']);
  const again = runPageTool('open_task_database', caller(), {}).details as { created: boolean; databaseId: string };
  assert.deepEqual([again.created, again.databaseId], [false, answer.databaseId]);
  assert.equal(runPageTool('open_task_database', caller({ getActivePageTurnAttribution: () => null }), {}).isError, true, 'opening it is a write');

  applyUserDatabaseEdits({ databaseId: answer.databaseId, ownerUserId, revision: getDatabase(answer.databaseId, ownerUserId).revision,
    ops: [{ op: 'row.add', id: 'r1', values: { task: 'Ship', status: 'waiting', threads: [nodeId] } }] });
  const listed = runPageTool('list_tasks', caller(), { needsYou: true, workspaceIds: ['ws2'] });
  assert.equal(listed.isError, undefined, JSON.stringify(listed.details));
  const items = (listed.details as { items: Array<{ rowId: string; workspaceId: string; needsYou: boolean }> }).items;
  assert.deepEqual(items.map((item) => [item.rowId, item.workspaceId, item.needsYou]), [['r1', workspaceId, true]]);
  for (const args of [{ limit: 0 }, { limit: 201 }, { statuses: 'todo' }, { needsYou: 'yes' }, { updatedSince: -1 }, { cursor: '' }, { query: '' }]) {
    assert.equal(runPageTool('list_tasks', caller(), args).isError, true, JSON.stringify(args));
  }
  assert.equal(runPageTool('list_tasks', caller({ ownerKind: 'agent_run' }), {}).isError, true);
});

test('a task database write counts the tasks it added, updated and removed; a status the person set only gets a suggestion', () => {
  const opened = runPageTool('open_task_database', caller(), {}).details as { databaseId: string };
  const added = runPageTool('edit_database', caller(), { databaseId: opened.databaseId, ops: [
    { op: 'row.add', values: { task: 'Ship', status: 'doing', threads: [nodeId] } },
    { op: 'row.add', values: { task: 'Docs', status: 'todo' } },
  ] });
  assert.equal(added.isError, undefined, JSON.stringify(added.details));
  assert.deepEqual((added.details as { michiPageWrite: { tasks: unknown } }).michiPageWrite.tasks, { added: 2, updated: 0, removed: 0 });
  const [ship, docs] = getDatabase(opened.databaseId, ownerUserId).rows;
  const changed = runPageTool('edit_database', caller(), { databaseId: opened.databaseId, ops: [
    { op: 'row.update', id: ship!.id, expectRev: ship!.rev, values: { next: 'Tag v2' } },
    { op: 'row.delete', id: docs!.id, expectRev: docs!.rev },
  ] }).details as { michiPageWrite: { tasks: unknown } };
  assert.deepEqual(changed.michiPageWrite.tasks, { added: 0, updated: 1, removed: 1 });

  applyUserDatabaseEdits({ databaseId: opened.databaseId, ownerUserId, revision: getDatabase(opened.databaseId, ownerUserId).revision,
    ops: [{ op: 'row.update', id: ship!.id, values: { status: 'done' } }] });
  const row = getDatabase(opened.databaseId, ownerUserId).rows[0]!;
  const suggested = runPageTool('edit_database', caller(), { databaseId: opened.databaseId, ops: [
    { op: 'row.update', id: row.id, expectRev: row.rev, values: { status: 'doing' } },
  ] }).details as { michiPageWrite: { tasks: unknown; appliedCount: number; proposedCount: number } };
  assert.deepEqual([suggested.michiPageWrite.tasks, suggested.michiPageWrite.appliedCount, suggested.michiPageWrite.proposedCount],
    [{ added: 0, updated: 0, removed: 0 }, 0, 1]);
  assert.equal(getDatabase(opened.databaseId, ownerUserId).rows[0]!.values.status, 'done', 'the status the person set stays');

  const plain = createDatabase({ workspaceId, ownerUserId, title: 'Plain', columns: [{ id: 'name', name: 'Name', type: 'text' }], views: [] });
  const other = runPageTool('edit_database', caller(), { databaseId: plain.id, ops: [{ op: 'row.add', values: { name: 'x' } }] })
    .details as { michiPageWrite: Record<string, unknown> };
  assert.equal('tasks' in other.michiPageWrite, false, 'other databases keep their receipt');
});

test("chat tools leave the task database's Board, Table and Needs you views alone, and can still add a custom view", () => {
  const opened = runPageTool('open_task_database', caller(), {}).details as { databaseId: string };
  const component = runPageTool('save_page_component', caller(), {
    expectedLibraryRevision: 0,
    component: { name: 'task-cards', description: 'Tasks as cards', code: "root.appendChild(document.createTextNode('tasks'));" },
  }).details as { component: { id: string } };
  const revision = () => getDatabase(opened.databaseId, ownerUserId).revision;
  const refused = runPageTool('configure_database_view', caller(), {
    databaseId: opened.databaseId, revision: revision(), viewId: 'tasks-board', config: { componentId: component.component.id },
  });
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.details), /Board, Table and Needs you/);
  const made = runPageTool('configure_database_view', caller(), { databaseId: opened.databaseId, revision: revision(), config: { componentId: component.component.id } });
  assert.equal(made.isError, undefined, JSON.stringify(made.details));
  assert.equal(getDatabase(opened.databaseId, ownerUserId).views.length, 4, 'Custom… still adds a view of the tasks');
});

test('the Meta agent cannot put a task board on the Pages Home: edit_page returns a tool error and the page is unchanged', () => {
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at,settings) VALUES (?,?,?,1,1,?)').run('sys', 'System', ownerUserId, JSON.stringify({ system: 'assistant' }));
  getDb().prepare("INSERT INTO pages(id,owner_user_id,workspace_id,title,blocks,updated_at,created_at,role) VALUES ('home',?,'sys','Home','[]',1,1,'spaces-home')").run(ownerUserId);
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES ('snode','sys','chat','running',1)").run();
  getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES ('sturn','snode','sassistant','active',1,1)").run();
  const meta = caller({ metaAgent: true, workspaceId: 'sys', nodeId: 'snode', getActivePageTurnAttribution: () => ({ turnId: 'sturn', assistantId: 'sassistant' }) });
  for (const block of [{ type: 'task-view' }, { type: 'grid', regions: [{ id: 'main', span: 12, blocks: [{ type: 'task-view' }] }] }]) {
    const result = runPageTool('edit_page', meta, { pageId: 'home', ops: [{ op: 'insert', block, after: null }] });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /Task boards can't go on the Pages Home/);
  }
  assert.equal(getPage('home', ownerUserId).blocks.length, 0);
});

test('list_pages marks only this workspace\'s home page', () => {
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws-other', 'Other', ownerUserId);
  const home = ensureWorkspaceHomePageId(workspaceId, ownerUserId);
  const otherHome = ensureWorkspaceHomePageId('ws-other', ownerUserId);
  createPage({ ownerUserId, workspaceId, title: 'Plain page' });
  const listed = runPageTool('list_pages', caller(), {});
  const items = (listed.details as { items: Array<{ id: string; home?: boolean }> }).items;
  assert.deepEqual(items.filter((item) => item.home).map((item) => item.id), [home]);
  assert.ok(items.length >= 2 && !items.some((item) => item.id === otherHome));
});


test('Home tools persist user choices, reject stale revisions and untrusted callers', () => {
  const first = runPageTool('read_home', caller(), {});
  assert.equal(first.isError, undefined);
  assert.equal(first.structuredContent?.revision, 0);
  const changed = runPageTool('edit_home', caller(), { expectedRevision: 0, greetingMode: 'custom', greetingText: '今天只做一件事', cardsMode: 'hidden' });
  assert.equal(changed.isError, undefined);
  assert.equal(changed.structuredContent?.revision, 1);
  assert.equal(runPageTool('edit_home', caller(), { expectedRevision: 0, greetingMode: 'hidden' }).isError, true);
  for (const overrides of [{ ownerUserId: 'bob' }, { ownerKind: 'agent_run' as const }, { getActivePageTurnAttribution: () => null }]) {
    assert.equal(runPageTool('read_home', caller(overrides), {}).isError, true);
    assert.equal(runPageTool('edit_home', caller(overrides), { expectedRevision: 1, greetingMode: 'hidden' }).isError, true);
  }
});


test('Chat Home embeds a native page and narrowly grants cross-workspace editing with protected history', () => {
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws-home', 'Home content', ownerUserId);
  const home = createPage({ workspaceId: 'ws-home', ownerUserId, title: 'My Home' });
  const neighbor = createPage({ workspaceId: 'ws-home', ownerUserId, title: 'Unrelated' });
  const selected = runPageTool('edit_home', caller(), { expectedRevision: 0, contentMode: 'page', pageId: home.id });
  assert.equal(selected.isError, undefined);
  assert.equal(readHomeCards(ownerUserId).contentPage?.id, home.id);
  const manifest = listEligibleMaintenanceManifest('ws-home', ownerUserId);
  assert.equal(manifest.pages.some(page => page.id === home.id), false);
  assert.equal(manifest.pages.some(page => page.id === neighbor.id), true);
  assert.equal(runPageTool('read_page', caller(), { pageId: home.id }).isError, undefined);
  assert.equal(runPageTool('read_page', caller(), { pageId: neighbor.id }).isError, true);
  assert.equal(runPageTool('edit_page', caller(), { pageId: neighbor.id, ops: [{ op: 'insert', after: null, block: { type: 'markdown', text: 'No' } }] }).isError, true);
  const inserted = runPageTool('edit_page', caller(), { pageId: home.id, atomic: true, ops: [
    { op: 'insert', after: null, block: { type: 'markdown', text: 'My favorite links' } },
  ] });
  assert.equal(inserted.isError, undefined, JSON.stringify(inserted));
  const after = getPage(home.id, ownerUserId);
  assert.equal(after.blocks.length, home.blocks.length + 1);
  applyUserPageEdits({ pageId: home.id, ownerUserId, revision: after.revision, ops: [{ op: 'update', id: after.blocks[0].id, block: { type: 'markdown', text: 'Human wording' } }] });
  const human = getPage(home.id, ownerUserId);
  const proposed = runPageTool('edit_page', caller(), { pageId: home.id, atomic: true, ops: [{ op: 'update', id: human.blocks[0].id, expectRev: human.blocks[0].rev, block: { type: 'markdown', text: 'Agent wording' } }] });
  assert.equal(proposed.isError, undefined);
  assert.equal((proposed.structuredContent?.michiPageWrite as { proposedCount: number }).proposedCount, 1);
  assert.equal((getPage(home.id, ownerUserId).blocks[0] as { text: string }).text, 'Human wording');
  const change = getDb().prepare("SELECT source FROM page_changes WHERE page_id=? AND proposal_state IS NULL ORDER BY seq LIMIT 1").get(home.id) as { source: string };
  assert.equal(JSON.parse(change.source).nodeId, nodeId);
  editHomeCustomization(ownerUserId, { expectedRevision: 1, contentMode: 'hidden' });
  assert.equal(readHomeCards(ownerUserId).contentMode, 'hidden');
  editHomeCustomization(ownerUserId, { expectedRevision: 2, contentMode: 'default' });
  assert.equal(getPage(home.id, ownerUserId).blocks.length, after.blocks.length);
  editHomeCustomization(ownerUserId, { expectedRevision: 3, contentMode: 'page' });
  assert.equal(readHomeCards(ownerUserId).contentPage?.id, home.id);
  assert.throws(() => editHomeCustomization('bob', { expectedRevision: 0, contentMode: 'page', pageId: home.id }));
  getDb().prepare('UPDATE pages SET deleted_at=1 WHERE id=?').run(home.id);
  assert.equal(readHomeCards(ownerUserId).contentMode, 'page');
  assert.equal(readHomeCards(ownerUserId).contentPage, null);
});


function createdTracker() {
  const result = runPageTool('create_database', caller(), { title: 'Tickets and CRs', columns: [
    { name: 'Number', type: 'text' }, { name: 'Status', type: 'select', options: [{ value: 'open' }, { value: 'done' }] },
  ], source: { kind: 'user' } });
  assert.equal(result.isError, undefined, JSON.stringify(result.details));
  const payload = result.details as { database: PageDatabase; result: PageWriteResult; michiPageWrite: Record<string, unknown> };
  return { ...payload, database: getDatabase(payload.database.id, ownerUserId) };
}

test('create, populate, configure and embed a general database with server IDs and chat source history', () => {
  const made = createdTracker(), db = made.database;
  assert.equal(made.michiPageWrite.created, true);
  assert.equal(made.result.applied.length, 1);
  assert.deepEqual(made.result.applied[0]!.source, { kind: 'chat', nodeId, turnId: 'turn', assistantId: 'assistant' });
  assert.deepEqual(db.columns.map((column) => column.name), ['Number', 'Status']);
  assert.equal(db.views[0]!.type, 'table');
  assert.equal(db.views[0]!.edit, undefined);
  const added = runPageTool('edit_database', caller(), { databaseId: db.id,
    ops: [{ op: 'row.add', values: { [db.columns[0]!.id]: 'CR-123', [db.columns[1]!.id]: 'open' } }] });
  assert.equal(added.isError, undefined);
  const current = getDatabase(db.id, ownerUserId);
  const configured = runPageTool('configure_database', caller(), { databaseId: db.id, revision: current.revision, ops: [
    { op: 'column.add', column: { name: 'Next step', type: 'text' } },
    { op: 'view.save', view: { name: 'By status', type: 'board', config: { filters: [], match: 'all', sorts: [], group: db.columns[1]!.id } } },
  ] });
  assert.equal(configured.isError, undefined, JSON.stringify(configured.details));
  const final = getDatabase(db.id, ownerUserId);
  assert.equal(final.columns.length, 3);
  assert.equal(final.views[1]!.edit, undefined);
  assert.deepEqual(final.rows, current.rows);
  const page = createPage({ workspaceId, ownerUserId, title: 'Dashboard' });
  const embed = runPageTool('edit_page', caller(), { pageId: page.id, ops: [{ op: 'insert', after: null,
    block: { type: 'database-ref', databaseId: db.id, viewId: final.views[1]!.id } }] });
  assert.equal(embed.isError, undefined, JSON.stringify(embed.details));
  assert.equal(getPage(page.id, ownerUserId).blocks[0]!.type, 'database-ref');
  assert.equal(getDb().prepare('SELECT database_id FROM page_database_refs WHERE page_id=?').get(page.id)?.database_id, db.id);
});

test('schema additions undo and redo, existing columns propose atomically and acceptance preserves human cells', () => {
  const db = createdTracker().database;
  const add = runPageTool('configure_database', caller(), { databaseId: db.id, revision: db.revision,
    ops: [{ op: 'column.add', column: { name: 'Notes', type: 'text' } }] }).details as { result: PageWriteResult };
  revertChange(add.result.applied[0]!.id, ownerUserId);
  assert.equal(getDatabase(db.id, ownerUserId).columns.length, 2);
  redoChange(add.result.applied[0]!.id, ownerUserId);
  assert.equal(getDatabase(db.id, ownerUserId).columns.length, 3);
  const revision = () => getDatabase(db.id, ownerUserId).revision;
  applyUserDatabaseEdits({ databaseId: db.id, ownerUserId, revision: revision(), ops: [{ op: 'row.add', values: { [db.columns[0]!.id]: 'Human text' } }] });
  const originalRows = getDatabase(db.id, ownerUserId).rows;
  const proposed = runPageTool('configure_database', caller(), { databaseId: db.id, revision: revision(), ops: [
    { op: 'column.update', id: db.columns[0]!.id, patch: { name: 'Ticket / CR' } },
    { op: 'column.add', column: { name: 'Owner', type: 'text' } },
  ] }).details as { result: PageWriteResult };
  assert.equal(proposed.result.applied.length, 0);
  assert.equal(proposed.result.proposed.length, 1);
  assert.equal(getDatabase(db.id, ownerUserId).columns.length, 3, 'no partial addition while the batch is proposed');
  const proposal = proposed.result.proposed[0]!;
  acceptProposal(proposal.id, ownerUserId);
  assert.equal(getDatabase(db.id, ownerUserId).columns[0]!.name, 'Ticket / CR');
  assert.equal(getDatabase(db.id, ownerUserId).columns.length, 4);
  assert.deepEqual(getDatabase(db.id, ownerUserId).rows, originalRows);
  revertChange(proposal.id, ownerUserId);
  assert.equal(getDatabase(db.id, ownerUserId).columns[0]!.name, 'Number');
  redoChange(proposal.id, ownerUserId);
  assert.equal(getDatabase(db.id, ownerUserId).columns[0]!.name, 'Ticket / CR');
  const stale = runPageTool('configure_database', caller(), { databaseId: db.id, revision: revision(),
    ops: [{ op: 'option.add', id: db.columns[1]!.id, option: { value: 'waiting' } }] }).details as { result: PageWriteResult };
  applyUserDatabaseEdits({ databaseId: db.id, ownerUserId, revision: revision(), ops: [{ op: 'column.update', id: db.columns[0]!.id, patch: { name: 'Human name' } }] });
  assert.throws(() => acceptProposal(stale.result.proposed[0]!.id, ownerUserId), /target has changed/);
});

test('human native views propose and accept without changing other views, columns or rows', () => {
  const db = createdTracker().database, original = db.views[0]!;
  const view = { id: original.id, name: 'My table', type: 'table', config: original.config };
  applyUserDatabaseEdits({ databaseId: db.id, ownerUserId, revision: db.revision, ops: [{ op: 'view.save', view }] });
  const current = getDatabase(db.id, ownerUserId);
  const result = runPageTool('configure_database', caller(), { databaseId: db.id, revision: current.revision,
    ops: [{ op: 'view.save', view: { ...view, name: 'Open tickets', config: { ...view.config, filters: [{ column: db.columns[1]!.id, op: 'is', value: 'open' }] } } }] }).details as { result: PageWriteResult };
  assert.equal(result.result.proposed.length, 1);
  assert.deepEqual(getDatabase(db.id, ownerUserId), current);
  acceptProposal(result.result.proposed[0]!.id, ownerUserId);
  assert.equal(getDatabase(db.id, ownerUserId).views[0]!.name, 'Open tickets');
  assert.deepEqual(getDatabase(db.id, ownerUserId).columns, current.columns);
  assert.ok(getDatabase(db.id, ownerUserId).views[0]!.edit);
});

test('invalid creation rolls back; configuration rejects stale revisions, spoofed IDs, destructive ops and task databases', () => {
  const count = () => getDb().prepare('SELECT COUNT(*) AS count FROM page_databases').get()!.count;
  for (const columns of [[], [{ name: 'Bad', type: 'unknown' }], [{ name: 'Forged', type: 'text', id: 'chosen' }], [{ name: 'Threads', type: 'threads' }]]) {
    const before = count();
    assert.equal(runPageTool('create_database', caller(), { title: 'Invalid', columns }).isError, true);
    assert.equal(count(), before);
  }
  const db = createdTracker().database;
  for (const ops of [
    [{ op: 'column.add', column: { name: 'New', type: 'text' } }, { op: 'column.delete', id: db.columns[0]!.id }],
    [{ op: 'view.save', view: { id: 'forged', name: 'Forged', type: 'table', config: { filters: [], match: 'all', sorts: [] } } }],
    [{ op: 'view.save', view: { name: 'Bad', type: 'board', config: { filters: [], match: 'all', sorts: [], group: 'unknown' } } }],
    [{ op: 'row.add', values: {} }],
  ]) {
    assert.equal(runPageTool('configure_database', caller(), { databaseId: db.id, revision: db.revision, ops }).isError, true);
    assert.deepEqual(getDatabase(db.id, ownerUserId), db);
  }
  assert.equal(runPageTool('configure_database', caller(), { databaseId: db.id, revision: db.revision - 1,
    ops: [{ op: 'column.add', column: { name: 'Stale', type: 'text' } }] }).isError, true);
  const task = runPageTool('open_task_database', caller(), {}).details as { databaseId: string; revision: number };
  assert.equal(runPageTool('configure_database', caller(), { databaseId: task.databaseId, revision: task.revision,
    ops: [{ op: 'column.add', column: { name: 'Extra', type: 'text' } }] }).isError, true);
  const denied = runPageTool('edit_database', caller(), { databaseId: db.id, ops: [{ op: 'column.add', column: { name: 'Bypass', type: 'text' } }] }).details as { result: PageWriteResult };
  assert.equal(denied.result.rejected.length, 1, 'row-only parser stays closed');
});

test('new tools require an owning active turn and isolate workspace and owner scope', () => {
  const args = { title: 'Tracker', columns: [{ name: 'Title', type: 'text' }] };
  for (const c of [caller({ getActivePageTurnAttribution: () => null }), caller({ ownerKind: 'agent_run' }), caller({ ownerUserId: 'other' })]) {
    assert.equal(runPageTool('create_database', c, args).isError, true);
  }
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('other-ws', 'Other', ownerUserId);
  const outside = createDatabase({ workspaceId: 'other-ws', ownerUserId, title: 'Other' });
  const config = { databaseId: outside.id, revision: outside.revision, ops: [{ op: 'column.add', column: { name: 'Title', type: 'text' } }] };
  assert.equal(runPageTool('configure_database', caller(), config).isError, true);
  const db = createdTracker().database;
  assert.equal(runPageTool('configure_database', caller({ getActivePageTurnAttribution: () => null }), { ...config, databaseId: db.id, revision: db.revision }).isError, true);
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at,settings) VALUES (?,?,?,1,1,?)').run('sys', 'System', ownerUserId, JSON.stringify({ system: 'assistant' }));
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES ('snode','sys','chat','running',1)").run();
  getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES ('sturn','snode','sassistant','active',1,1)").run();
  const meta = caller({ metaAgent: true, workspaceId: 'sys', nodeId: 'snode', getActivePageTurnAttribution: () => ({ turnId: 'sturn', assistantId: 'sassistant' }) });
  const made = runPageTool('create_database', meta, { ...args, workspaceId: 'other-ws' });
  assert.equal(made.isError, undefined, JSON.stringify(made.details));
  assert.equal(made.structuredContent?.michiPageWrite && (made.structuredContent.michiPageWrite as Record<string, unknown>).workspaceId, 'other-ws');
  assert.equal(runPageTool('configure_database', meta, config).isError, undefined);
  assert.equal(runPageTool('create_database', meta, { ...args, workspaceId: 'sys' }).isError, true);
  getDb().prepare("UPDATE workspaces SET owner_user_id='bob' WHERE id='other-ws'").run();
  assert.equal(runPageTool('create_database', meta, { ...args, workspaceId: 'other-ws' }).isError, true);
  assert.equal(runPageTool('configure_database', meta, config).isError, true);
});
