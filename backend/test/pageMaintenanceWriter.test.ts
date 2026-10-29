import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createDatabase, createPage, getDatabase, getMaintenanceDatabasePage, getMaintenancePageBlocks, getPage } from '../src/services/pages/repository';
import { applyUserPageEdits, planAgentEdits } from '../src/services/pages/pageWrites';
import {
  createMaintenanceConfig, createMaintenancePlan, getMaintenanceReceipt,
  readMaintenanceSourceMessages, recordMaintenanceRouting,
} from '../src/services/pages/maintenanceRepository';
import { createMaintenanceTools } from '../src/services/pages/maintenanceTools';
import { listMaintenanceSourceResources, refreshMaintenanceSource, type MaintenanceExecutionContext } from '../src/services/pages/maintenanceWriter';
import { addLayoutRule, saveLayoutPreferences } from '../src/services/pages/layoutRules';
import { maintenanceContextPrompt } from '../src/agents/maintenancePolicy';
import { PAGE_BLOCK_CATALOG, PAGE_BLOCK_TYPES } from 'michi-shared';

let dir: string;
let priorData: string | undefined;
let priorCloud: string | undefined;

beforeEach(() => {
  priorData = process.env.MICHI_DATA_DIR;
  priorCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-page-maintenance-writer-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws', 'Workspace', 'alice');
});

afterEach(() => {
  closeDb();
  if (priorData === undefined) delete process.env.MICHI_DATA_DIR;
  else process.env.MICHI_DATA_DIR = priorData;
  if (priorCloud === undefined) delete process.env.MICHI_CLOUD;
  else process.env.MICHI_CLOUD = priorCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(extraPages = 0, includeDatabase = false) {
  const db = getDb();
  db.prepare(`INSERT INTO scheduled_jobs(id,owner_user_id,workspace_id,name,prompt,schedule,permission_mode,session_mode,notify,enabled,auto_paused,consecutive_failures,timeout_seconds,created_at,updated_at)
    VALUES('job','alice','ws','Maintenance','prompt','{"kind":"every","everySeconds":3600}','trust','fresh',0,1,0,0,1800,1,1)`).run();
  db.prepare("INSERT INTO scheduler_lease(id,holder,expires_at) VALUES(1,'worker',9007199254740000)").run();
  db.prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES('source-node','ws','chat','idle',1),('maintenance-node','ws','chat','idle',1)").run();
  db.prepare("INSERT INTO messages(id,node_id,role,content,seq,created_at,metadata) VALUES('u-source','source-node','user','Release is ready.',1,2,'{}'),('a-source','source-node','assistant','Update the release status.',2,3,'{}'),('u-maint','maintenance-node','user','maint',1,4,'{\"scheduledJobId\":\"job\"}'),('a-maint','maintenance-node','assistant','done',2,5,'{}')").run();
  db.prepare(`INSERT INTO turns(turn_id,node_id,user_message_id,assistant_message_id,status,last_seq,started_at,completed_at,updated_at,completion_seq)
    VALUES('turn-source','source-node','u-source','a-source','completed',2,1,3,3,1),('turn-maint','maintenance-node','u-maint','a-maint','active',1,4,NULL,5,NULL)`).run();
  db.prepare("INSERT INTO meta(key,value) VALUES('conversation_completion_seq:ws','0')").run();
  db.prepare(`INSERT INTO scheduled_job_runs(id,job_id,workspace_id,node_id,tree_id,turn_id,trigger,status,scheduled_for,started_at,finished_at,summary,error,notify_state,notify_kind,attention,claimed_by)
    VALUES('run','job','ws','maintenance-node',NULL,'turn-maint','scheduled','running',NULL,5,NULL,NULL,NULL,'none',NULL,NULL,'worker')`).run();
  getDb().prepare(`INSERT OR IGNORE INTO scheduler_execution_claims
    (run_id,job_id,holder,generation,acquired_at,workspace_id)
    SELECT r.id,r.job_id,r.claimed_by,l.generation,r.started_at,r.workspace_id
    FROM scheduled_job_runs r JOIN scheduler_lease l ON l.id=1`).run();
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', now: 10 });
  for (let index = 0; index < extraPages; index += 1) createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: `Resource ${index}`, now: 11 + index });
  const database = includeDatabase ? createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Milestones', now: 15,
    columns: [{ id: 'task', name: 'Task', type: 'text' }, { id: 'status', name: 'Status', type: 'text' }], views: [],
    rows: [
      { id: 'row-1', position: 0, values: { task: 'Ship', status: 'Planned' }, rev: 1, edited: {}, bodyEditedAt: null, updatedAt: 15 },
      { id: 'row-2', position: 1, values: { task: 'Review', status: 'Planned' }, rev: 1, edited: {}, bodyEditedAt: null, updatedAt: 15 },
    ] }) : undefined;
  if (database) db.prepare('INSERT INTO page_database_refs(page_id,database_id) VALUES(?,?)').run(page.id, database.id);
  const config = createMaintenanceConfig({ workspaceId: 'ws', ownerUserId: 'alice', jobId: 'job', enabled: true, now: 20 });
  db.prepare("UPDATE meta SET value='1' WHERE key='conversation_completion_seq:ws'").run();
  const authority = { workspaceId: 'ws', ownerUserId: 'alice', jobId: 'job', runId: 'run', claimedBy: 'worker', configRevision: config.revision };
  const plan = createMaintenancePlan({ ...authority, after: 0, through: 1, now: 30 });
  const source = plan.sources[0]!;
  const context: MaintenanceExecutionContext = { ...authority, planId: plan.id,
    sources: [{ sourceTurnId: source.sourceTurnId, evidence: source.evidence }],
    execution: { nodeId: 'maintenance-node', turnId: 'turn-maint', assistantId: 'a-maint', runId: 'run' } };
  return { page, plan, source, context, database };
}

function details(result: any): any {
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return result.details;
}

function routeAndAcknowledge(tools: ReturnType<typeof createMaintenanceTools>, context: MaintenanceExecutionContext, pageId: string) {
  const read = tools.find((tool) => tool.name === 'maintenance_read_source')!;
  const offered = details(read.execute({ sourceTurnId: 'turn-source' }));
  assert.equal(offered.coverageComplete, false);
  const ack = details(read.execute({ sourceTurnId: 'turn-source', acknowledgeParts: offered.parts.map((part: any) => ({ partId: part.partId, partHash: part.partHash })) }));
  assert.equal(ack.coverageComplete, true);
  const route = tools.find((tool) => tool.name === 'maintenance_route_source')!;
  details(route.execute({ sourceTurnId: 'turn-source', candidates: [{ kind: 'page', id: pageId }] }));
}

test('maintenance per-item sources persist with one receipt and cannot cite an unacknowledged conversation', () => {
  const { page, source, context } = setup();
  const tools = createMaintenanceTools(context, { now: () => 40 });
  routeAndAcknowledge(tools, context, page.id);
  const write = tools.find(tool => tool.name === 'maintenance_write_page')!;
  const block = { type: 'markdown', text: '- Release ready', segmentSources: [{ text: '- Release ready', sources: [source.evidence] }] };
  const execution = { nodeId: context.execution.nodeId, turnId: context.execution.turnId, assistantId: context.execution.assistantId };
  const invalid = write.execute({ sourceTurnId: source.sourceTurnId, pageId: page.id, ops: [
    { op: 'insert', after: null, block: { ...block, segmentSources: [{ text: block.text, sources: [execution] }] } },
  ] }) as any;
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /acknowledged source/);
  assert.equal(getPage(page.id, 'alice').revision, page.revision);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM page_maintenance_receipts').get() as { count: number }).count, 0);
  const raw = { sourceTurnId: source.sourceTurnId, pageId: page.id, ops: [{ op: 'insert', after: null, block }] };
  const result = details(write.execute(raw));
  assert.equal(result.applied.length, 1);
  const saved = getPage(page.id, 'alice').blocks[0]!;
  assert.ok(saved.type === 'markdown');
  assert.deepEqual(saved.segmentSources, block.segmentSources);
  assert.deepEqual(details(write.execute(raw)), result);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM page_maintenance_receipts').get() as { count: number }).count, 1);
});

test('maintenance writer commits one atomic page set and retry returns its receipt after the result was deleted', () => {
  const { page, plan, source, context } = setup();
  const tools = createMaintenanceTools(context, { now: () => 40 });
  routeAndAcknowledge(tools, context, page.id);
  const write = tools.find((tool) => tool.name === 'maintenance_write_page')!;
  const raw = { sourceTurnId: source.sourceTurnId, pageId: page.id, ops: [
    { op: 'insert', block: { type: 'heading', text: 'Ready to ship' }, after: null },
  ] };
  const first = details(write.execute(raw));
  assert.equal(first.applied.length, 1);
  assert.equal(first.proposed.length, 0);
  const inserted = getPage(page.id, 'alice').blocks[0]!;
  const receipt = getMaintenanceReceipt(first.applied[0]!.source.kind === 'maintenance'
    ? getDb().prepare('SELECT receipt_key FROM page_maintenance_receipts').get()!.receipt_key as string : '');
  assert.ok(receipt);
  assert.equal(receipt.planId, plan.id);
  assert.equal(receipt.evidence.turnId, source.sourceTurnId);
  assert.equal(receipt.execution.turnId, 'turn-maint');

  applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: getPage(page.id, 'alice').revision,
    now: 50, ops: [{ op: 'delete', id: inserted.id, expectRev: inserted.rev }] });
  assert.equal(getPage(page.id, 'alice').blocks.length, page.blocks.length);

  const replayContext = { ...context, execution: { ...context.execution, turnId: 'replacement-maintenance-turn', assistantId: 'replacement-assistant' } };
  const replay = details(createMaintenanceTools(replayContext, { now: () => 40 })
    .find((tool) => tool.name === 'maintenance_write_page')!.execute(raw));
  assert.deepEqual(replay, first);
  assert.equal(getPage(page.id, 'alice').blocks.length, page.blocks.length, 'receipt replay must not recreate the deleted block');
});

test('an incremental write cites its source turn and ignores block sources meant for a first-time generation', () => {
  const { page, source, context } = setup();
  const tools = createMaintenanceTools(context, { now: () => 40 });
  routeAndAcknowledge(tools, context, page.id);
  const write = tools.find((tool) => tool.name === 'maintenance_write_page')!;
  const insert = (write.parameters.properties as any).ops.items.oneOf[0];
  assert.deepEqual(insert.properties.sources.items.required, ['nodeId', 'messageId']);
  const result = details(write.execute({ sourceTurnId: source.sourceTurnId, pageId: page.id, ops: [
    { op: 'insert', block: { type: 'heading', text: 'Cited' }, after: null, sources: [{ nodeId: 'other-node', messageId: 'other-message' }] },
  ] }));
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.applied[0].source.evidence, [source.evidence]);
  assert.equal(result.applied[0].source.read, undefined);
});

test('source coverage and stale operation sets fail closed without content or receipt writes', () => {
  const { page, source, context } = setup();
  const tools = createMaintenanceTools(context, { now: () => 40 });
  const route = tools.find((tool) => tool.name === 'maintenance_route_source')!;
  const blocked = route.execute({ sourceTurnId: source.sourceTurnId, candidates: [{ kind: 'page', id: page.id }] }) as any;
  assert.equal(blocked.isError, true, 'routing before full source coverage must fail');

  routeAndAcknowledge(tools, context, page.id);
  const write = tools.find((tool) => tool.name === 'maintenance_write_page')!;
  const failed = write.execute({ sourceTurnId: source.sourceTurnId, pageId: page.id, ops: [
    { op: 'insert', block: { type: 'heading', text: 'Would be partial' }, after: null },
    { op: 'update', id: 'missing-block', expectRev: 1, block: { type: 'heading', text: 'Invalid' } },
  ] }) as any;
  assert.equal(failed.isError, true);
  assert.equal(getPage(page.id, 'alice').blocks.length, page.blocks.length);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM page_maintenance_receipts').get() as { n: number }).n, 0);
});

test('source refresh updates revisions while keeping the plan-time resource IDs and routes', () => {
  const { page, source, context } = setup();
  applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: page.revision,
    now: 35, ops: [{ op: 'update', id: page.blocks[0]!.id, expectRev: page.blocks[0]!.rev,
      block: { type: 'markdown', text: 'Changed before routing' } }] });

  const refreshed = refreshMaintenanceSource(context, source.sourceTurnId);
  const refreshedSource = refreshed.sources[0]!;
  assert.deepEqual(refreshedSource.manifest.map(({ kind, id, pageIds }) => ({ kind, id, pageIds })),
    source.manifest.map(({ kind, id, pageIds }) => ({ kind, id, pageIds })));
  assert.equal(refreshedSource.manifest.find((item) => item.kind === 'page' && item.id === page.id)?.revision,
    getPage(page.id, 'alice').revision);
  const pageOfResources = createMaintenanceTools(context, { now: () => 40 })
    .find((tool) => tool.name === 'maintenance_list_resources')!
    .execute({ sourceTurnId: source.sourceTurnId, offset: 0, limit: 1 });
  assert.equal(pageOfResources.isError, undefined);
  const listed = pageOfResources.details as { resources: Array<{ id: string; title: string; pagePath?: string }>; offset: number; nextOffset: number | null; totalResources: number };
  assert.equal(listed.offset, 0);
  assert.equal(listed.totalResources, source.manifest.length);
  assert.deepEqual(listed.resources.map((resource) => resource.id), [page.id]);
  assert.equal(listed.resources[0]?.title, 'Release');
  assert.ok(listed.resources[0]?.pagePath);
  assert.equal(listed.nextOffset, null);
});

test('maintenance database reads paginate rows and return only selected columns under the response cap', () => {
  const { page } = setup();
  const database = createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Large', now: 35,
    columns: [{ id: 'task', name: 'Task', type: 'text' }, { id: 'status', name: 'Status', type: 'text' }], views: [],
    rows: Array.from({ length: 7 }, (_, index) => ({ id: `row-${index + 1}`, position: index,
      values: { task: `Task ${index + 1}`, status: 'open' }, rev: 1, edited: {}, bodyEditedAt: null, updatedAt: 35 })) });
  getDb().prepare('INSERT INTO page_database_refs(page_id,database_id) VALUES(?,?)').run(page.id, database.id);

  const first = getMaintenanceDatabasePage(database.id, 'alice', { limit: 5, columnIds: ['task'] });
  assert.equal(first.rows.length, 5);
  assert.deepEqual(first.rows[0]!.values, { task: 'Task 1' });
  assert.ok(first.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') <= 64 * 1024);
  const second = getMaintenanceDatabasePage(database.id, 'alice', { cursor: first.nextCursor, limit: 5, columnIds: ['task'] });
  assert.equal(second.rows.length, 2);
  assert.equal(second.nextCursor, null);
  assert.throws(() => getMaintenanceDatabasePage(database.id, 'alice', { limit: 6, columnIds: ['task'] }));
  assert.throws(() => getMaintenanceDatabasePage(database.id, 'alice', { columnIds: ['task', 'task'] }));
});

test('maintenance page writer schema and parser accept only insert/update/delete/move with current revisions', () => {
  const { page, source, context } = setup();
  getDb().prepare('UPDATE pages SET blocks=? WHERE id=?').run(JSON.stringify([
    { id: 'seed-heading', rev: 1, type: 'heading', text: 'Keep' },
    { id: 'seed-markdown', rev: 1, type: 'markdown', text: 'Move me' },
    { id: 'seed-callout', rev: 1, type: 'callout', text: 'Remove me', tone: 'warn' },
  ]), page.id);
  const existing = getPage(page.id, 'alice').blocks;
  const tools = createMaintenanceTools(context, { now: () => 40 });
  const write = tools.find((tool) => tool.name === 'maintenance_write_page')!;
  assert.match(write.description, /one final write call/);
  assert.match(write.description, /result\.proposed/);
  assert.match(write.description, /maintenance_no_change/);
  const opsSchema = (write.parameters.properties as any).ops;
  assert.equal(opsSchema.maxItems, 50);
  assert.deepEqual(opsSchema.items.oneOf.map((variant: any) => variant.properties.op.enum[0]), ['insert', 'update', 'delete', 'move']);

  routeAndAcknowledge(tools, context, page.id);
  const invalid = write.execute({ sourceTurnId: source.sourceTurnId, pageId: page.id,
    ops: [{ op: 'release', id: existing[0]!.id, expectRev: existing[0]!.rev }] }) as any;
  assert.equal(invalid.isError, true, 'agent maintenance cannot release human protection');

  const updatedBlock = existing[0]!.type === 'callout'
    ? { type: 'callout' as const, text: 'Updated' }
    : { type: existing[0]!.type as 'heading' | 'markdown', text: 'Updated' };
  const result = details(write.execute({ sourceTurnId: source.sourceTurnId, pageId: page.id, ops: [
    { op: 'update', id: existing[0]!.id, expectRev: existing[0]!.rev, block: updatedBlock },
    { op: 'move', id: existing[1]!.id, expectRev: existing[1]!.rev, after: null },
    { op: 'delete', id: existing[2]!.id, expectRev: existing[2]!.rev },
  ] }));
  assert.equal(result.applied.length, 3);
  const saved = getPage(page.id, 'alice').blocks;
  assert.equal(saved.length, 2);
  assert.equal(saved.find((block) => block.id === existing[0]!.id)?.type, 'heading');
  assert.equal(saved[0]!.id, existing[1]!.id, 'move preserves the row-level ordering contract');
});

test('maintenance writes metrics, next-steps and timeline blocks and its schema lists them', () => {
  const { page, source, context } = setup();
  const tools = createMaintenanceTools(context, { now: () => 40 });
  const write = tools.find((tool) => tool.name === 'maintenance_write_page')!;
  const blockSchema = (write.parameters.properties as any).ops.items.oneOf[0].properties.block;
  const types = blockSchema.oneOf.map((variant: any) => variant.properties.type.enum[0]);
  for (const type of ['metrics', 'next-steps', 'timeline']) assert.ok(types.includes(type), type);
  const timeline = blockSchema.oneOf.find((variant: any) => variant.properties.type.enum[0] === 'timeline');
  assert.deepEqual(timeline.properties.items.items.required, ['title', 'at']);
  assert.equal(timeline.properties.items.maxItems, 50);

  routeAndAcknowledge(tools, context, page.id);
  const blocks = [
    { type: 'metrics', items: [{ label: 'Branches in dev', value: '6', note: 'Scheduled jobs' }, { label: 'Ahead', value: '22 commits', tone: 'accent' }] },
    { type: 'next-steps', title: 'Next steps', items: [{ who: 'user', text: 'Confirm the rewrite', unblocks: 'Release notes' }] },
    { type: 'timeline', title: 'Progress', items: [{ title: 'Merged', at: '2026-10-22T05:35', detail: 'Tests pass.', tone: 'success' }] },
  ];
  const last = getPage(page.id, 'alice').blocks.at(-1)!.id;
  const result = details(write.execute({ sourceTurnId: source.sourceTurnId, pageId: page.id, ops: [
    { op: 'insert', after: last, block: blocks[2] },
    { op: 'insert', after: last, block: blocks[1] },
    { op: 'insert', after: last, block: blocks[0] },
  ] }));
  assert.equal(result.applied.length, 3, JSON.stringify(result));
  const saved = getPage(page.id, 'alice').blocks.slice(-3).map(({ id: _id, rev: _rev, sources: _sources, ...content }) => content);
  assert.deepEqual(saved, blocks);
});

test('maintenance writes every catalog block; thread cards name only conversations of the page workspace', () => {
  const { page, source, context } = setup();
  const tools = createMaintenanceTools(context, { now: () => 40 });
  const write = tools.find((tool) => tool.name === 'maintenance_write_page')!;
  const blockSchema = (write.parameters.properties as any).ops.items.oneOf[0].properties.block;
  assert.deepEqual(blockSchema.oneOf.map((variant: any) => variant.properties.type.enum[0]), PAGE_BLOCK_TYPES);

  routeAndAcknowledge(tools, context, page.id);
  const blocks = (['plan-actual', 'compare', 'conflict', 'table', 'criteria', 'chart', 'gallery', 'forgot'] as const)
    .map((type) => PAGE_BLOCK_CATALOG[type].example!);
  const threads = { type: 'threads', title: 'Sessions', nodeIds: ['source-node'] };
  const last = getPage(page.id, 'alice').blocks.at(-1)!.id;
  // A refused block says which operation it was and why, so the agent can fix it.
  const refused = write.execute({ sourceTurnId: source.sourceTurnId, pageId: page.id, ops: [{ op: 'insert', after: last,
    block: { type: 'chart', title: 'T', kind: 'bar', labels: ['a', 'b'], series: [{ label: 's', values: [1] }] } }] }) as any;
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /operation 0: This chart block breaks a rule of its fields: .*one per label/);
  const result = details(write.execute({ sourceTurnId: source.sourceTurnId, pageId: page.id,
    ops: [...blocks, threads].reverse().map((block) => ({ op: 'insert', after: last, block })) }));
  assert.equal(result.applied.length, blocks.length + 1, JSON.stringify(result));
  const saved = getPage(page.id, 'alice').blocks.slice(-(blocks.length + 1)).map(({ id: _id, rev: _rev, sources: _sources, ...content }) => content);
  assert.deepEqual(saved, [...blocks, threads]);

  getDb().prepare("INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES ('other','Other','alice',1,1)").run();
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES('elsewhere','other','chat','idle',1)").run();
  const edit = (block: unknown) => applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: getPage(page.id, 'alice').revision,
    ops: [{ op: 'insert', after: null, block }] });
  assert.throws(() => edit({ type: 'threads', nodeIds: ['ghost'] }), /not a conversation of this workspace/);
  assert.throws(() => edit({ type: 'threads', nodeIds: ['elsewhere'] }), /in another workspace/);
  assert.throws(() => edit({ type: 'conflict', question: 'Q', options: [{ text: 'A', nodeId: 'elsewhere' }, { text: 'B' }] }), /in another workspace/);

  // A conversation deleted after a block named it keeps the page writable, and the person can still resolve the block.
  getDb().prepare("UPDATE nodes SET deleted_at=50 WHERE id='source-node'").run();
  const written = getPage(page.id, 'alice').blocks.find((block) => block.type === 'threads')!;
  const conflict = getPage(page.id, 'alice').blocks.find((block) => block.type === 'conflict')!;
  applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: getPage(page.id, 'alice').revision,
    ops: [{ op: 'update', id: written.id, block: { type: 'threads', title: 'Renamed', nodeIds: ['source-node'] } }] });
  applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: getPage(page.id, 'alice').revision,
    ops: [{ op: 'update', id: conflict.id, block: { ...PAGE_BLOCK_CATALOG.conflict.example!, resolution: 0 } }] });
  assert.equal((getPage(page.id, 'alice').blocks.find((block) => block.id === written.id) as { title?: string }).title, 'Renamed');

  // So does one moved to another workspace since: unrelated edits, ticks and agent writes still save, and a new card cannot name it.
  getDb().prepare("UPDATE nodes SET deleted_at=NULL, workspace_id='other' WHERE id='source-node'").run();
  edit({ type: 'heading', text: 'Still writable' });
  assert.equal(getPage(page.id, 'alice').blocks[0]?.type, 'heading');
  const agent = planAgentEdits({ page: getPage(page.id, 'alice'), ownerUserId: 'alice', now: 60,
    source: { nodeId: 'source-node', turnId: 'turn-source', assistantId: 'assistant-source' },
    rawOps: [{ op: 'insert', after: null, block: { type: 'markdown', text: 'An agent note' } }] });
  assert.deepEqual([agent.rejected, agent.records.length], [[], 1]);
  assert.throws(() => edit({ type: 'threads', title: 'Copy', nodeIds: ['elsewhere'] }), /in another workspace/);
});

test('maintenance page reads carry the page\'s layout rules, inside the read bound', () => {
  const { page, context } = setup();
  const rule = addLayoutRule({ pageId: page.id, ownerUserId: 'alice', text: 'Progress: at most 3 items', createdBy: 'user', now: 25 });
  const preferences = saveLayoutPreferences({ pageId: page.id, ownerUserId: 'alice', text: 'Lead with current risks', expectedRevision: 0, actor: 'user', now: 25 });
  const tools = createMaintenanceTools(context, { now: () => 40 });
  routeAndAcknowledge(tools, context, page.id);
  const read = details(tools.find((tool) => tool.name === 'maintenance_read_page')!.execute({ sourceTurnId: 'turn-source', pageId: page.id }));
  assert.deepEqual(read.layoutRules, [{ id: rule.id, text: 'Progress: at most 3 items' }]);
  assert.deepEqual(read.layoutPreferences, preferences);
  assert.equal(read.page.id, page.id);
  assert.match(tools.find((tool) => tool.name === 'maintenance_read_page')!.description, /layoutRules/);
  assert.match(maintenanceContextPrompt({ sources: [{ sourceTurnId: 'turn-source', evidence: [] }] } as never), /layoutRules/);
});

test('maintenance page reads return bounded block ranges with stable offsets', () => {
  const { page } = setup();
  const blocks = Array.from({ length: 25 }, (_, index) => ({ id: `block-${index}`, type: 'markdown', text: `Block ${index}`, rev: 1 }));
  getDb().prepare('UPDATE pages SET blocks=? WHERE id=?').run(JSON.stringify(blocks), page.id);
  const first = getMaintenancePageBlocks(page.id, 'alice', { limit: 20 });
  assert.equal(first.blockCount, 25);
  assert.equal(first.page.blocks.length, 20);
  assert.equal(first.nextOffset, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') <= 64 * 1024);
  const second = getMaintenancePageBlocks(page.id, 'alice', { offset: first.nextOffset!, limit: 20 });
  assert.equal(second.page.blocks.length, 5);
  assert.equal(second.nextOffset, null);
  assert.throws(() => getMaintenancePageBlocks(page.id, 'alice', { limit: 21 }));
});

test('maintenance resource listing pages over more than 100 eligible resources with trusted titles', () => {
  const { source, context } = setup(104);
  const first = listMaintenanceSourceResources(context, source.sourceTurnId, 0, 100);
  assert.equal(first.totalResources, 105);
  assert.equal(first.resources.length, 100);
  assert.ok(first.nextOffset);
  assert.ok(first.resources.every((resource) => resource.kind === 'page' && resource.title.length > 0 && resource.pagePath));
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') <= 64 * 1024);

  const second = listMaintenanceSourceResources(context, source.sourceTurnId, first.nextOffset!, 100);
  assert.equal(second.resources.length, 5);
  assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.resources, ...second.resources].map((resource) => resource.id)).size, 105);
});

test('maintenance database writer accepts documented row.add/update/delete shapes and rejects invented cell operations', () => {
  const { source, context, database } = setup(0, true);
  assert.ok(database);
  const tools = createMaintenanceTools(context, { now: () => 40 });
  const sourceRead = tools.find((tool) => tool.name === 'maintenance_read_source')!;
  const offered = details(sourceRead.execute({ sourceTurnId: source.sourceTurnId }));
  details(sourceRead.execute({ sourceTurnId: source.sourceTurnId,
    acknowledgeParts: offered.parts.map((part: any) => ({ partId: part.partId, partHash: part.partHash })) }));
  details(tools.find((tool) => tool.name === 'maintenance_route_source')!.execute({ sourceTurnId: source.sourceTurnId,
    candidates: [{ kind: 'database', id: database.id }] }));

  const write = tools.find((tool) => tool.name === 'maintenance_write_database')!;
  assert.match(write.description, /one final write call/);
  assert.match(write.description, /result\.proposed/);
  assert.match(write.description, /maintenance_no_change/);
  const invalid = write.execute({ sourceTurnId: source.sourceTurnId, databaseId: database.id,
    ops: [{ op: 'setCellValue', rowId: 'row-1', columnId: 'status', value: 'In progress' }] }) as any;
  assert.equal(invalid.isError, true);
  assert.equal(getDatabase(database.id, 'alice').rows[0]!.values.status, 'Planned');

  const result = details(write.execute({ sourceTurnId: source.sourceTurnId, databaseId: database.id, ops: [
    { op: 'row.update', id: 'row-1', expectRev: 1, values: { status: 'In progress' } },
    { op: 'row.add', values: { task: 'Deploy', status: 'Queued' } },
    { op: 'row.delete', id: 'row-2', expectRev: 1 },
  ] }));
  assert.equal(result.applied.length, 3);
  const saved = getDatabase(database.id, 'alice');
  assert.equal(saved.rows.length, 2);
  assert.equal(saved.rows.find((row) => row.id === 'row-1')?.values.status, 'In progress');
  assert.equal(saved.rows.some((row) => row.id === 'row-2'), false);
  assert.equal(saved.rows[1]!.values.task, 'Deploy');
});

test('a recovered, already-routed source lists its routed resources and the plan can still finish after the target moved', () => {
  const { page, source, context, plan } = setup(1, true);
  const database = getDb().prepare('SELECT database_id AS id FROM page_database_refs').get() as { id: string };
  const first = createMaintenanceTools(context, { now: () => 40 });
  const offered = details(first.find((tool) => tool.name === 'maintenance_read_source')!.execute({ sourceTurnId: 'turn-source' }));
  details(first.find((tool) => tool.name === 'maintenance_read_source')!.execute({ sourceTurnId: 'turn-source',
    acknowledgeParts: offered.parts.map((part: any) => ({ partId: part.partId, partHash: part.partHash })) }));
  details(first.find((tool) => tool.name === 'maintenance_route_source')!.execute({ sourceTurnId: 'turn-source',
    candidates: [{ kind: 'page', id: page.id }, { kind: 'database', id: database.id }] }));
  // The run stops here; both routed targets then move before a later run reclaims the plan.
  getDb().prepare('UPDATE pages SET revision=revision+1 WHERE id=?').run(page.id);
  getDb().prepare('UPDATE page_databases SET revision=revision+1 WHERE id=?').run(database.id);

  const recovered = createMaintenanceTools(context, { now: () => 41 });
  const call = (name: string, args: Record<string, unknown>) => recovered.find((tool) => tool.name === name)!.execute(args) as any;
  const stale = call('maintenance_read_page', { sourceTurnId: 'turn-source', pageId: page.id, offset: 1 });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /[Rr]ead it again/);

  const listed = details(call('maintenance_list_resources', { sourceTurnId: 'turn-source' }));
  assert.equal(listed.routed, true);
  assert.match(listed.note, /routing is final/);
  assert.deepEqual(listed.resources.map((item: any) => `${item.kind}:${item.id}:${item.decision}`).sort(),
    [`database:${database.id}:pending`, `page:${page.id}:pending`].sort());
  assert.equal(listed.totalResources, 2, 'no resource can be added to a routed source');

  details(call('maintenance_read_page', { sourceTurnId: 'turn-source', pageId: page.id }));
  details(call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id }));
  details(call('maintenance_no_change', { sourceTurnId: 'turn-source', resourceKind: 'page', resourceId: page.id, reason: 'Nothing to add' }));
  assert.deepEqual(listMaintenanceSourceResources(context, 'turn-source').resources.map((item) => item.decision).sort(), ['no_change', 'pending']);
  const written = details(call('maintenance_write_database', { sourceTurnId: 'turn-source', databaseId: database.id,
    ops: [{ op: 'row.add', values: { task: 'Release', status: 'Planned' } }] }));
  assert.equal(written.applied.length, 1);

  const done = getDb().prepare('SELECT state FROM page_maintenance_plans WHERE id=?').get(plan.id) as { state: string };
  assert.equal(done.state, 'terminal');
  assert.equal((getDb().prepare('SELECT state FROM page_maintenance_sources WHERE plan_id=? AND source_turn_id=?').get(plan.id, source.sourceTurnId) as { state: string }).state, 'terminal');
});

test('maintenance gateway creates Michi content and stops dispatch after its run loses authority', async () => {
  const { buildMcpServerForSlot, McpSlotRegistry } = await import('../src/services/mcpServer');
  const { META_AGENT_MAINTENANCE_TOOL_NAMES } = await import('../src/agents/maintenancePolicy');
  const { context } = setup();
  const slot = new McpSlotRegistry().create('maintenance-node', dir, 'alice', {
    owner: { mode: 'interactive', key: 'maintenance-node' }, maintenance: true,
    exposedToolNames: new Set(META_AGENT_MAINTENANCE_TOOL_NAMES),
    getActiveMaintenanceExecutionContext: () => ({ ...context, sources: context.sources.map(source => ({ ...source, manifest: [] })) }),
  }, { nodeId: 'maintenance-node', workspaceId: 'ws' });
  const tools = (buildMcpServerForSlot(slot) as any)._registeredTools;
  const created = await tools.maintenance_call_tool.handler({ tool: 'create_page', arguments: { title: 'Gateway-created page' } });
  assert.equal(created.isError, undefined, JSON.stringify(created));
  assert.equal((getDb().prepare("SELECT count(*) AS n FROM pages WHERE title='Gateway-created page' AND workspace_id='ws'").get() as any).n, 1);
  const blocked = await tools.maintenance_call_tool.handler({ tool: 'send_to_thread', arguments: { nodeId: 'source-node', text: 'Run a command' } });
  assert.equal(blocked.isError, undefined);
  assert.match(JSON.stringify(blocked.content), /unavailable/);
  getDb().prepare("UPDATE scheduled_job_runs SET status='cancelled' WHERE id='run'").run();
  const stale = await tools.maintenance_call_tool.handler({ tool: 'create_page', arguments: { title: 'Must not exist' } });
  assert.equal(stale.isError, true);
  assert.equal((getDb().prepare("SELECT count(*) AS n FROM pages WHERE title='Must not exist'").get() as any).n, 0);
});
