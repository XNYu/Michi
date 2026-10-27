import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createPage, getPage, listSpaces } from '../src/services/pages/repository';
import { spaceActivity } from '../src/services/pages/homeActivity';
import { applyMaintenancePageSet, applyUserPageEdits, PageWriteError } from '../src/services/pages/pageWrites';
import { parseAgentPageOps } from 'michi-shared';
import {
  createMaintenanceConfig, createMaintenancePlan, freezeMaintenanceResourcePayload,
  getMaintenanceReceipt, maintenanceOperationKey, readMaintenanceSourceMessages, recordMaintenanceRouting,
} from '../src/services/pages/maintenanceRepository';

let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;
beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR; oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-maintenance-page-writes-'));
  process.env.MICHI_DATA_DIR = dir; delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws', 'Workspace', 'alice');
  seedRunAndSource();
});
afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedRunAndSource(): void {
  const db = getDb();
  db.prepare(`INSERT INTO scheduled_jobs(id,owner_user_id,workspace_id,name,prompt,schedule,permission_mode,session_mode,notify,enabled,auto_paused,consecutive_failures,timeout_seconds,created_at,updated_at)
    VALUES('job','alice','ws','Maintenance','prompt','{"kind":"every","everySeconds":3600}','trust','fresh',0,1,0,0,1800,1,1)`).run();
  db.prepare("INSERT INTO scheduler_lease(id,holder,expires_at) VALUES(1,'worker',10000)").run();
  db.prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES('source-node','ws','chat','idle',1),('maintenance-node','ws','chat','idle',1)").run();
  db.prepare("INSERT INTO messages(id,node_id,role,content,seq,created_at,metadata) VALUES('u-source','source-node','user','release is ready',1,2,'{}'),('a-source','source-node','assistant','We should update release status.',2,3,'{}'),('u-maint','maintenance-node','user','maint',1,4,'{\"scheduledJobId\":\"job\"}'),('a-maint','maintenance-node','assistant','done',2,5,'{}')").run();
  db.prepare(`INSERT INTO turns(turn_id,node_id,user_message_id,assistant_message_id,status,last_seq,started_at,completed_at,updated_at,completion_seq)
    VALUES('turn-source','source-node','u-source','a-source','completed',2,1,3,3,1),('turn-maint','maintenance-node','u-maint','a-maint','active',1,4,NULL,5,NULL)`).run();
  db.prepare("INSERT INTO meta(key,value) VALUES('conversation_completion_seq:ws','1')").run();
  db.prepare(`INSERT INTO scheduled_job_runs(id,job_id,workspace_id,node_id,tree_id,turn_id,trigger,status,scheduled_for,started_at,finished_at,summary,error,notify_state,notify_kind,attention,claimed_by)
    VALUES('run','job','ws','maintenance-node',NULL,'turn-maint','scheduled','running',NULL,5,NULL,NULL,NULL,'none',NULL,NULL,'worker')`).run();
  getDb().prepare(`INSERT OR IGNORE INTO scheduler_execution_claims
    (run_id,job_id,holder,generation,acquired_at,workspace_id)
    SELECT r.id,r.job_id,r.claimed_by,l.generation,r.started_at,r.workspace_id
    FROM scheduled_job_runs r JOIN scheduler_lease l ON l.id=1`).run();
}

function setup() {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', now: 10 });
  const config = createMaintenanceConfig({ workspaceId: 'ws', ownerUserId: 'alice', jobId: 'job', now: 20, enabled: true });
  const authority = { workspaceId: 'ws', ownerUserId: 'alice', jobId: 'job', runId: 'run', claimedBy: 'worker', configRevision: config.revision };
  const plan = createMaintenancePlan({ ...authority, after: 0, through: 1, historicalCatchup: true, now: 30 });
  const source = plan.sources[0]!;
  const offered = readMaintenanceSourceMessages({ planId: plan.id, ownerUserId: 'alice', sourceTurnId: source.sourceTurnId, maxParts: 8, now: 31 });
  readMaintenanceSourceMessages({ planId: plan.id, ownerUserId: 'alice', sourceTurnId: source.sourceTurnId,
    acknowledgeParts: offered.parts.map((part) => ({ partId: part.partId, partHash: part.partHash })), now: 32 });
  const resource = source.manifest.find((entry) => entry.kind === 'page' && entry.id === page.id)!;
  recordMaintenanceRouting({ ...authority, planId: plan.id, sourceTurnId: source.sourceTurnId, manifest: [resource], now: 33 });
  const execution = { nodeId: 'maintenance-node', turnId: 'turn-maint', assistantId: 'a-maint', runId: 'run' };
  return { page, authority, plan, source, resource, execution };
}

function frozenInput(args: ReturnType<typeof setup>, ops: unknown[], blockIds: string[], now = 32) {
  const operationKey = maintenanceOperationKey('job', args.source.sourceTurnId, 'page', args.page.id, args.plan.generation);
  const normalized = parseAgentPageOps(ops)!;
  const payload = canonical({ ops: normalized });
  const assignedIds = { blockIds };
  const frozen = freezeMaintenanceResourcePayload({ ...args.authority, planId: args.plan.id,
    sourceTurnId: args.source.sourceTurnId, kind: 'page', resourceId: args.page.id, payload, assignedIds, now });
  return { workspaceId: 'ws', ownerUserId: 'alice', pageId: args.page.id, expectedRevision: args.resource.revision,
    source: { kind: 'maintenance' as const, ...args.execution, jobId: 'job', evidence: [args.source.evidence] },
    evidence: args.source.evidence, operationKey, payloadHash: frozen.payloadHash, planId: args.plan.id,
    sourceTurnId: args.source.sourceTurnId, generation: args.plan.generation, ops: normalized,
    assignedIds, execution: args.execution, authority: args.authority, now: now + 1 };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

test('maintenance page set rejects the whole batch without page changes or a receipt', () => {
  const args = setup();
  const before = getPage(args.page.id, 'alice');
  const block = before.blocks[0]!;
  const ops = [
    { op: 'insert', after: block.id, block: { type: 'markdown', text: 'inserted' } },
    { op: 'update', id: 'missing-block', expectRev: 1, block: { type: 'markdown', text: 'stale' } },
  ];
  const input = frozenInput(args, ops, ['stable-block-id']);
  assert.throws(() => applyMaintenancePageSet(input), (error: unknown) => error instanceof PageWriteError && error.status === 409);
  assert.deepEqual(getPage(args.page.id, 'alice'), before);
  assert.equal(getMaintenanceReceipt(input.operationKey), null);
});

test('maintenance page set uses frozen block IDs and receipt retries return the original result after target changes', () => {
  const args = setup();
  const initial = getPage(args.page.id, 'alice');
  const target = initial.blocks[0]!;
  const ops = [
    { op: 'insert', after: target.id, block: { type: 'markdown', text: 'stable insert' } },
    { op: 'update', id: target.id, expectRev: target.rev, block: { type: 'markdown', text: 'maintained' } },
  ];
  const input = frozenInput(args, ops, ['stable-block-id']);
  const first = applyMaintenancePageSet(input);
  assert.equal(first.applied.length, 2);
  assert.equal(first.applied.some((change) => change.target.kind === 'block' && change.target.blockId === 'stable-block-id'), true);
  assert.equal(getPage(args.page.id, 'alice').blocks.some((block) => block.id === 'stable-block-id'), true);
  const edited = getPage(args.page.id, 'alice');
  const last = edited.blocks.find((block) => block.id === target.id)!;
  applyUserPageEdits({ pageId: args.page.id, ownerUserId: 'alice', revision: edited.revision, now: 40, ops: [
    { op: 'update', id: last.id, expectRev: last.rev, block: { type: 'markdown', text: 'later human edit' } },
  ] });
  const retry = applyMaintenancePageSet({ ...input, now: 50 });
  assert.deepEqual(retry, first);
  const currentTarget = getPage(args.page.id, 'alice').blocks.find((block) => block.id === target.id);
  assert.ok(currentTarget && currentTarget.type === 'markdown');
  assert.equal(currentTarget.text, 'later human edit');
  assert.deepEqual(getMaintenanceReceipt(input.operationKey)?.result, first);
});

test('maintenance page set rejects when run authority expires', () => {
  const args = setup();
  const block = args.page.blocks[0]!;
  const ops = [{ op: 'update', id: block.id, expectRev: block.rev, block: { type: 'markdown', text: 'changed' } }];
  const input = frozenInput(args, ops, []);
  input.now = 10001;
  assert.throws(() => applyMaintenancePageSet(input), (error: unknown) => error instanceof PageWriteError && error.status === 409);
  assert.deepEqual(getPage(args.page.id, 'alice'), args.page);
  assert.equal(getMaintenanceReceipt(input.operationKey), null);
});

test('a maintenance change belongs to the conversation it read, also in rows written before that was so', () => {
  const args = setup();
  const block = args.page.blocks[0]!;
  const input = frozenInput(args, [{ op: 'update', id: block.id, expectRev: block.rev, block: { type: 'markdown', text: 'Release is ready' } }], []);
  const [change] = applyMaintenancePageSet(input).applied;
  assert.ok(change && change.source.kind === 'maintenance');
  assert.deepEqual(change.source.evidence, [{ nodeId: 'source-node', turnId: 'turn-source', assistantId: 'a-source' }]);
  assert.equal(change.source.nodeId, 'maintenance-node', 'the run that wrote it stays on the record');
  const stored = () => getDb().prepare('SELECT source_node_id FROM page_changes WHERE id=?').get(change.id) as { source_node_id: string };
  assert.equal(stored().source_node_id, 'source-node');
  const activity = () => spaceActivity('alice').find((item) => item.kind === 'page-change');
  assert.equal(activity()?.kind === 'page-change' && activity()?.sourceNodeId, 'source-node');

  getDb().prepare("UPDATE page_changes SET source_node_id='maintenance-node' WHERE id=?").run(change.id);
  assert.equal(activity()?.kind === 'page-change' && activity()?.sourceNodeId, 'source-node', 'an older row is read from its evidence');
  assert.deepEqual(listSpaces('alice').items.find((space) => space.id === args.page.id)?.contributorNodeIds, ['source-node']);
});
