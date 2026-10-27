import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { applyUserPageEdits } from '../src/services/pages/pageWrites';
import { createDatabase, createPage, getDatabase } from '../src/services/pages/repository';
import {
  createMaintenanceConfig, createMaintenancePlan, listEligibleMaintenanceManifest, listEligibleMaintenanceManifestForSpace,
  setInitialSpaceMaintenanceExcluded,
} from '../src/services/pages/maintenanceRepository';
import { maintenanceContextPrompt, META_AGENT_MAINTENANCE_TOOL_NAMES } from '../src/agents/maintenancePolicy';
import { applyAgentDbEdits, applyUserDatabaseEdits } from '../src/services/pages/databaseWrites';
import { createMaintenanceTools } from '../src/services/pages/maintenanceTools';
import type { MaintenanceExecutionContext } from '../src/services/pages/maintenanceWriter';
import { openTaskDatabase } from '../src/services/pages/taskDatabase';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { TASK_ACTIVITY_WINDOW_MS } from 'michi-shared';
import { setupPagesRoutes } from '../src/routes/pages';
import { PageWriteError } from '../src/services/pages/core';
import { revertBatch } from '../src/services/pages/pageChanges';
import { taskActivity, taskOrigin } from '../src/services/pages/taskActivity';

const OWNER = 'alice';
let dir: string;
let priorData: string | undefined;
let priorCloud: string | undefined;

beforeEach(() => {
  priorData = process.env.MICHI_DATA_DIR;
  priorCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-task-upkeep-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  const db = getDb();
  db.prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws', 'Workspace', OWNER);
  // The source conversation maintenance reads, its own run, a chat that wrote tasks, and one deleted later.
  db.prepare(`INSERT INTO nodes(id,workspace_id,kind,status,title,created_at) VALUES
    ('source-node','ws','chat','idle','Release check',1),('maintenance-node','ws','chat','idle','Upkeep',1),
    ('writer-node','ws','chat','idle','Planning',1),('old-node','ws','chat','idle','Old notes',1)`).run();
  db.prepare(`INSERT INTO messages(id,node_id,role,content,seq,created_at,metadata) VALUES
    ('u-source','source-node','user','Is the release out?',1,2,'{}'),
    ('a-source','source-node','assistant','It shipped. The docs still need a review.',2,3,'{}'),
    ('u-maint','maintenance-node','user','maint',1,4,'{"scheduledJobId":"job"}'),
    ('a-maint','maintenance-node','assistant','done',2,5,'{}')`).run();
  db.prepare(`INSERT INTO turns(turn_id,node_id,user_message_id,assistant_message_id,status,last_seq,started_at,completed_at,updated_at,completion_seq)
    VALUES('turn-source','source-node','u-source','a-source','completed',2,1,3,3,1),('turn-maint','maintenance-node','u-maint','a-maint','active',1,4,NULL,5,NULL)`).run();
  db.prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES ('turn-writer','writer-node','a-writer','active',1,1)").run();
  db.prepare("INSERT INTO meta(key,value) VALUES('conversation_completion_seq:ws','0')").run();
});

afterEach(() => {
  closeDb();
  if (priorData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = priorData;
  if (priorCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = priorCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

type Tools = ReturnType<typeof createMaintenanceTools>;
type ToolResult = ReturnType<Tools[number]['execute']>;

/**
 * A scheduled maintenance run over the one finished source turn, after
 * `before` set up the workspace's pages and tasks: the Meta agent's tools for it.
 */
function upkeep(before: () => void = () => {}, scope?: () => string): Tools {
  const db = getDb();
  db.prepare(`INSERT INTO scheduled_jobs(id,owner_user_id,workspace_id,name,prompt,schedule,permission_mode,session_mode,notify,enabled,auto_paused,consecutive_failures,timeout_seconds,created_at,updated_at)
    VALUES('job','alice','ws','Maintenance','prompt','{"kind":"every","everySeconds":3600}','trust','fresh',0,1,0,0,1800,1,1)`).run();
  db.prepare("INSERT INTO scheduler_lease(id,holder,expires_at) VALUES(1,'worker',9007199254740000)").run();
  db.prepare(`INSERT INTO scheduled_job_runs(id,job_id,workspace_id,node_id,tree_id,turn_id,trigger,status,scheduled_for,started_at,finished_at,summary,error,notify_state,notify_kind,attention,claimed_by)
    VALUES('run','job','ws','maintenance-node',NULL,'turn-maint','scheduled','running',NULL,5,NULL,NULL,NULL,'none',NULL,NULL,'worker')`).run();
  db.prepare(`INSERT OR IGNORE INTO scheduler_execution_claims(run_id,job_id,holder,generation,acquired_at,workspace_id)
    SELECT r.id,r.job_id,r.claimed_by,l.generation,r.started_at,r.workspace_id FROM scheduled_job_runs r JOIN scheduler_lease l ON l.id=1`).run();
  before();
  const config = createMaintenanceConfig({ workspaceId: 'ws', ownerUserId: OWNER, jobId: 'job', enabled: true, now: 20 });
  db.prepare("UPDATE meta SET value='1' WHERE key='conversation_completion_seq:ws'").run();
  const authority = { workspaceId: 'ws', ownerUserId: OWNER, jobId: 'job', runId: 'run', claimedBy: 'worker', configRevision: config.revision };
  const plan = createMaintenancePlan({ ...authority, after: 0, through: 1, now: 30,
    ...(scope ? { scopeSpaceId: scope(), historicalCatchup: true } : {}) });
  const source = plan.sources[0]!;
  const context: MaintenanceExecutionContext = { ...authority, planId: plan.id,
    sources: [{ sourceTurnId: source.sourceTurnId, evidence: source.evidence }],
    execution: { nodeId: 'maintenance-node', turnId: 'turn-maint', assistantId: 'a-maint', runId: 'run' } };
  return createMaintenanceTools(context, { now: () => 40 });
}

const call = (tools: Tools, name: string, args: unknown): ToolResult => tools.find((tool) => tool.name === name)!.execute(args);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ok = (result: ToolResult): any => {
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.details;
};

/** Maintenance reads the whole source turn before it routes anything. */
function readSource(tools: Tools): void {
  const offered = ok(call(tools, 'maintenance_read_source', { sourceTurnId: 'turn-source' }));
  ok(call(tools, 'maintenance_read_source', { sourceTurnId: 'turn-source',
    acknowledgeParts: offered.parts.map((part: { partId: string; partHash: string }) => ({ partId: part.partId, partHash: part.partHash })) }));
}

test('the task database stays a maintenance candidate with no board, and with a board on an excluded page tree', () => {
  const { database } = openTaskDatabase({ workspaceId: 'ws', ownerUserId: OWNER, now: 2 });
  const tasks = () => listEligibleMaintenanceManifest('ws', OWNER).databases.find((item) => item.id === database.id);
  assert.deepEqual(tasks(), { id: database.id, title: 'Tasks', revision: database.revision, pageIds: [], role: 'tasks' });
  assert.deepEqual(listEligibleMaintenanceManifest('ws', OWNER).resources.find((item) => item.id === database.id),
    { kind: 'database', id: database.id, revision: database.revision, pageIds: [] });

  const board = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Board', now: 3 });
  const plain = createDatabase({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Plain', columns: [{ id: 'name', name: 'Name', type: 'text' }], views: [] });
  applyUserPageEdits({ pageId: board.id, ownerUserId: OWNER, revision: board.revision, ops: [
    { op: 'insert', after: null, block: { type: 'task-view' } },
    { op: 'insert', after: null, block: { type: 'database-ref', databaseId: plain.id } },
  ] });
  const hidden = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Private', now: 4 });
  applyUserPageEdits({ pageId: hidden.id, ownerUserId: OWNER, revision: hidden.revision, ops: [{ op: 'insert', after: null, block: { type: 'task-view' } }] });
  assert.deepEqual(tasks()?.pageIds, [board.id, hidden.id].sort());
  assert.deepEqual(listEligibleMaintenanceManifest('ws', OWNER).databases.find((item) => item.id === plain.id),
    { id: plain.id, title: 'Plain', revision: getDatabase(plain.id, OWNER).revision, pageIds: [board.id] }, 'other databases carry no role');

  setInitialSpaceMaintenanceExcluded({ workspaceId: 'ws', ownerUserId: OWNER, spaceId: hidden.id, excluded: true, now: 5 });
  assert.deepEqual(tasks()?.pageIds, [board.id], 'an excluded page tree keeps its board out, not the tasks');
  assert.deepEqual(listEligibleMaintenanceManifestForSpace('ws', OWNER, board.id).databases.map((item) => item.id), [plain.id],
    'a Space catch-up leaves the tasks to the regular feed');
});

test('a source routes the task database though no page shows it, and the resource list names its role', () => {
  let databaseId = '';
  const tools = upkeep(() => { databaseId = openTaskDatabase({ workspaceId: 'ws', ownerUserId: OWNER, now: 2 }).database.id; });
  readSource(tools);
  const listed = ok(call(tools, 'maintenance_list_resources', { sourceTurnId: 'turn-source' }));
  assert.deepEqual(listed.resources, [{ kind: 'database', id: databaseId, revision: getDatabase(databaseId, OWNER).revision, title: 'Tasks', role: 'tasks' }]);
  const routed = ok(call(tools, 'maintenance_route_source', { sourceTurnId: 'turn-source', candidates: [{ kind: 'database', id: databaseId }] }));
  assert.deepEqual(routed.sources[0].candidates.map((item: { kind: string; id: string; pageIds: string[] }) => [item.kind, item.id, item.pageIds]),
    [['database', databaseId, []]]);
});

test('a source routed without the task database gets a final answer from maintenance_list_tasks, not a route hint', () => {
  const tools = upkeep(() => {
    openTaskDatabase({ workspaceId: 'ws', ownerUserId: OWNER, now: 2 });
    createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Notes', now: 3 });
  });
  readSource(tools);
  const page = ok(call(tools, 'maintenance_list_resources', { sourceTurnId: 'turn-source' })).resources.find((item: { kind: string }) => item.kind === 'page');
  ok(call(tools, 'maintenance_route_source', { sourceTurnId: 'turn-source', candidates: [{ kind: 'page', id: page.id }] }));
  const result = call(tools, 'maintenance_list_tasks', { sourceTurnId: 'turn-source' });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /routing is final/);
  assert.doesNotMatch(result.content[0]!.text, /maintenance_route_source/);
});

test('a Space catch-up run leaves the task database out, and maintenance_list_tasks says so', () => {
  let databaseId = ''; let spaceId = '';
  const tools = upkeep(() => { databaseId = seedTasks(); spaceId = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Space', now: 6 }).id; }, () => spaceId);
  readSource(tools);
  const result = call(tools, 'maintenance_list_tasks', { sourceTurnId: 'turn-source' });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /does not include the task database/);
  assert.ok(!result.content[0]!.text.includes(databaseId), 'no route hint for a database that cannot be routed');
});

const WRITER = { kind: 'chat' as const, nodeId: 'writer-node', turnId: 'turn-writer', assistantId: 'a-writer' };

/**
 * The workspace's tasks, written by an agent in a chat: two link the source
 * conversation, and the person then set the status of one of those; the
 * third links a conversation deleted since.
 */
function seedTasks(): string {
  const { database } = openTaskDatabase({ workspaceId: 'ws', ownerUserId: OWNER, now: 2 });
  applyAgentDbEdits({ databaseId: database.id, workspaceId: 'ws', ownerUserId: OWNER, source: WRITER, now: 3, ops: [
    { op: 'row.add', values: { task: 'Ship the release', status: 'doing', threads: ['source-node'], next: 'Tag v2' } },
    { op: 'row.add', values: { task: 'Review the docs', status: 'todo', threads: ['source-node'] } },
    { op: 'row.add', values: { task: 'Plan the launch', status: 'todo', threads: ['old-node'] } },
  ] });
  const current = getDatabase(database.id, OWNER);
  const docs = current.rows.find((row) => row.values.task === 'Review the docs')!;
  applyUserDatabaseEdits({ databaseId: database.id, ownerUserId: OWNER, revision: current.revision, now: 4,
    ops: [{ op: 'row.update', id: docs.id, values: { status: 'doing' } }] });
  getDb().prepare("UPDATE nodes SET deleted_at=5 WHERE id='old-node'").run();
  return database.id;
}

const taskNamed = (databaseId: string, task: string) => getDatabase(databaseId, OWNER).rows.find((row) => row.values.task === task)!;

test("maintenance_list_tasks finds the routed task database's tasks, and a write leaves a status the person set as a suggestion", () => {
  let databaseId = '';
  const tools = upkeep(() => { databaseId = seedTasks(); });
  readSource(tools);
  const list = (args: Record<string, unknown> = {}) => call(tools, 'maintenance_list_tasks', { sourceTurnId: 'turn-source', ...args });
  const early = list().content[0]!.text;
  assert.match(early, /not routed/, 'like a database read, it needs the route first');
  assert.match(early, new RegExp(`maintenance_route_source.*${databaseId}`), 'the error names the call to make and the database to route');
  assert.match(early, /once with every resource/, 'routing is final, so the hint asks for the whole set');
  assert.match(call(tools, 'maintenance_list_tasks', { sourceTurnId: 'turn-other' }).content[0]!.text, /Source turn is not in the active maintenance batch/,
    'a wrong source turn keeps its own error');
  ok(call(tools, 'maintenance_route_source', { sourceTurnId: 'turn-source', candidates: [{ kind: 'database', id: databaseId }] }));

  const linked = ok(list({ nodeId: 'source-node' }));
  assert.deepEqual([linked.databaseId, linked.revision, linked.columns], [databaseId, getDatabase(databaseId, OWNER).revision,
    { task: 'task', status: 'status', threads: 'threads', next: 'next' }]);
  assert.deepEqual(linked.tasks.map((item: { task: string; status: string; statusSetBy: string }) => [item.task, item.status, item.statusSetBy]).sort(),
    [['Review the docs', 'doing', 'user'], ['Ship the release', 'doing', 'agent']]);
  assert.equal(linked.more, false);
  const ship = linked.tasks.find((item: { task: string }) => item.task === 'Ship the release');
  const saved = taskNamed(databaseId, 'Ship the release');
  assert.deepEqual([ship.id, ship.rev, ship.next, ship.conversationIds, ship.goneConversationIds], [saved.id, saved.rev, 'Tag v2', ['source-node'], []]);
  const launch = ok(list({ query: 'LAUNCH' }));
  assert.deepEqual(launch.tasks.map((item: { task: string; goneConversationIds: string[] }) => [item.task, item.goneConversationIds]),
    [['Plan the launch', ['old-node']]], 'a deleted conversation is named, to be unlinked');
  assert.deepEqual(ok(list({ statuses: ['todo'] })).tasks.map((item: { task: string }) => item.task), ['Plan the launch']);
  const one = ok(list({ limit: 1 }));
  assert.deepEqual([one.tasks.length, one.more], [1, true]);
  for (const bad of [{ limit: 21 }, { limit: 0 }, { statuses: 'todo' }, { nodeId: 7 }, { other: true }]) {
    assert.equal(list(bad).isError, true, JSON.stringify(bad));
  }

  const docs = linked.tasks.find((item: { task: string }) => item.task === 'Review the docs');
  const written = ok(call(tools, 'maintenance_write_database', { sourceTurnId: 'turn-source', databaseId, ops: [
    { op: 'row.update', id: ship.id, expectRev: ship.rev, values: { status: 'done', next: '' } },
    { op: 'row.update', id: docs.id, expectRev: docs.rev, values: { status: 'waiting' } },
    { op: 'row.add', values: { task: 'Write the release notes', status: 'todo', threads: ['source-node'] } },
  ] }));
  assert.deepEqual([written.applied.length, written.proposed.length], [2, 1]);
  assert.equal(taskNamed(databaseId, 'Ship the release').values.status, 'done');
  assert.equal(taskNamed(databaseId, 'Review the docs').values.status, 'doing', 'the status the person set stays until they accept');
});

test('the maintenance prompt and toolset carry the task rules', () => {
  const prompt = maintenanceContextPrompt({ sources: [{ sourceTurnId: 'turn-source', evidence: [] }] } as never);
  assert.match(prompt, /maintenance_list_tasks/);
  assert.match(prompt, /call maintenance_route_source once with every resource the source should change, including the task database .*then call maintenance_list_tasks/);
  assert.match(prompt, /A finished turn does not make a task done/);
  assert.match(prompt, /goneConversationIds/);
  assert.ok(META_AGENT_MAINTENANCE_TOOL_NAMES.includes('maintenance_list_tasks'));
});

/**
 * The run reads the source, routes the tasks, finds the ones linking the
 * source and writes them: Ship is done, Docs waits on the person (they set
 * its status, so that is a suggestion), and a new task. Returns the batch.
 */
function writeUpkeep(tools: Tools, databaseId: string): string {
  readSource(tools);
  ok(call(tools, 'maintenance_route_source', { sourceTurnId: 'turn-source', candidates: [{ kind: 'database', id: databaseId }] }));
  const linked = ok(call(tools, 'maintenance_list_tasks', { sourceTurnId: 'turn-source', nodeId: 'source-node' }));
  const find = (task: string) => linked.tasks.find((item: { task: string }) => item.task === task);
  const ship = find('Ship the release');
  const docs = find('Review the docs');
  const written = ok(call(tools, 'maintenance_write_database', { sourceTurnId: 'turn-source', databaseId, ops: [
    { op: 'row.update', id: ship.id, expectRev: ship.rev, values: { status: 'done', next: '' } },
    { op: 'row.update', id: docs.id, expectRev: docs.rev, values: { status: 'waiting' } },
    { op: 'row.add', values: { task: 'Write the release notes', status: 'todo', threads: ['source-node'] } },
  ] }));
  return written.applied[0].batchId;
}

const rowOf = (change: { target: { kind: string; rowId?: string } }) => change.target.rowId;

test("task activity marks what upkeep added and changed, keeps its suggestions, and names its latest update until it is undone", () => {
  let databaseId = '';
  const tools = upkeep(() => { databaseId = seedTasks(); });
  // The maintenance writer stamps its change records with the real clock; the `now` given to the tools does not reach it.
  const started = Date.now();
  const batchId = writeUpkeep(tools, databaseId);
  const finished = Date.now();
  const ship = taskNamed(databaseId, 'Ship the release');
  const docs = taskNamed(databaseId, 'Review the docs');
  const notes = taskNamed(databaseId, 'Write the release notes');

  const activity = taskActivity(databaseId, OWNER, finished);
  const at = activity.latestUpkeep!.at;
  assert.ok(at >= started && at <= finished);
  assert.deepEqual(activity.suggestions.map(rowOf), [docs.id]);
  assert.deepEqual(activity.marks.map((mark) => [mark.rowId, mark.kind]).sort(), [[notes.id, 'new'], [ship.id, 'updated']].sort());
  assert.ok(activity.marks.every((mark) => mark.at >= started && mark.at <= finished));
  assert.equal(activity.marks.some((mark) => mark.rowId === taskNamed(databaseId, 'Plan the launch').id), false, "a chat's writes are not upkeep");
  assert.deepEqual(activity.latestUpkeep, { batchId, at, added: 1, updated: 1, removed: 0, suggested: 1,
    source: { nodeId: 'source-node', turnId: 'turn-source', assistantId: 'a-source', title: 'Release check' } });

  const dayLater = taskActivity(databaseId, OWNER, at + TASK_ACTIVITY_WINDOW_MS + 1);
  assert.deepEqual([dayLater.marks, dayLater.latestUpkeep, dayLater.suggestions.map(rowOf)], [[], null, [docs.id]], 'after a day only the suggestion stays');

  assert.deepEqual(revertBatch(batchId, OWNER, 'ws', finished + 1).conflicts, []);
  const undone = taskActivity(databaseId, OWNER, finished + 2);
  assert.deepEqual([undone.marks, undone.latestUpkeep, undone.suggestions.map(rowOf)], [[], null, [docs.id]], 'Undo leaves the suggestion to the card');
});

test("a task's origin says who made it and from how many conversations", () => {
  let databaseId = '';
  const tools = upkeep(() => { databaseId = seedTasks(); });
  const started = Date.now();
  writeUpkeep(tools, databaseId);
  const finished = Date.now();
  assert.deepEqual(taskOrigin(databaseId, taskNamed(databaseId, 'Ship the release').id, OWNER), { by: 'agent', conversations: 1, at: 3 });
  const made = taskOrigin(databaseId, taskNamed(databaseId, 'Write the release notes').id, OWNER)!;
  assert.deepEqual([made.by, made.conversations], ['meta-agent', 1]);
  assert.ok(made.at >= started && made.at <= finished);

  // The Pages Assistant writes from the assistant's own workspace: that is the Meta agent too.
  const db = getDb();
  db.prepare("INSERT INTO workspaces(id,name,owner_user_id,settings,created_at,updated_at) VALUES ('meta','Michi assistant',?,'{\"system\":\"assistant\"}',1,1)").run(OWNER);
  db.prepare("INSERT INTO nodes(id,workspace_id,kind,status,title,created_at) VALUES ('meta-node','meta','chat','idle','Pages Assistant',1)").run();
  db.prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES ('turn-meta','meta-node','a-meta','active',1,1)").run();
  applyAgentDbEdits({ databaseId, workspaceId: 'ws', ownerUserId: OWNER, now: 50,
    source: { kind: 'chat', nodeId: 'meta-node', turnId: 'turn-meta', assistantId: 'a-meta' },
    ops: [{ op: 'row.add', values: { task: 'Book the launch room', status: 'todo' } }] });
  assert.deepEqual(taskOrigin(databaseId, taskNamed(databaseId, 'Book the launch room').id, OWNER), { by: 'meta-agent', conversations: 0, at: 50 });

  applyUserDatabaseEdits({ databaseId, ownerUserId: OWNER, revision: getDatabase(databaseId, OWNER).revision, now: 60,
    ops: [{ op: 'row.add', values: { task: 'Mine' } }] });
  assert.deepEqual(taskOrigin(databaseId, taskNamed(databaseId, 'Mine').id, OWNER), { by: 'you', conversations: 0, at: 60 });
  assert.throws(() => taskOrigin(databaseId, 'nope', OWNER), (error: unknown) => error instanceof PageWriteError && error.status === 404);
  const plain = createDatabase({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Plain', columns: [{ id: 'name', name: 'Name', type: 'text' }], views: [] });
  assert.throws(() => taskActivity(plain.id, OWNER, 70), /Only a task database/);
});

test('the task activity and origin routes answer for a task database, as of now', async () => {
  let databaseId = '';
  const tools = upkeep(() => { databaseId = seedTasks(); });
  writeUpkeep(tools, databaseId);
  const app = express();
  app.use((req, _res, next) => { req.user = { id: OWNER, email: 'alice@example.com' }; next(); });
  app.use('/api', setupPagesRoutes());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/databases/${databaseId}`;
  try {
    const activity = await (await fetch(`${base}/task-activity`)).json() as { suggestions: unknown[]; marks: unknown[]; latestUpkeep: unknown };
    // The route reads as of now, and the upkeep just ran (at the real clock).
    assert.deepEqual([activity.suggestions.length, activity.marks.length, (activity.latestUpkeep as { suggested: number }).suggested], [1, 2, 1]);
    const ship = taskNamed(databaseId, 'Ship the release');
    assert.deepEqual(await (await fetch(`${base}/rows/${ship.id}/origin`)).json(), { origin: { by: 'agent', conversations: 1, at: 3 } });
    assert.equal((await fetch(`${base}/rows/nope/origin`)).status, 404);
    assert.equal((await fetch(`${base}/task-activity?x=1`)).status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
