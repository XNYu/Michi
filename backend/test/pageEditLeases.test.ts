import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createPage, getPage } from '../src/services/pages/repository';
import { applyAgentPageEdits, applyUserPageEdits } from '../src/services/pages/pageWrites';
import {
  acquirePageEditLease, livePageEditLease, PAGE_EDIT_LEASE_IDLE_MS, PAGE_EDIT_LEASE_MAX_MS,
} from '../src/services/pages/editLeases';
import {
  createMaintenanceConfig, createMaintenancePlan, maintenancePlanWaitsOnEditLeases,
} from '../src/services/pages/maintenanceRepository';
import { createMaintenanceTools } from '../src/services/pages/maintenanceTools';
import type { MaintenanceExecutionContext } from '../src/services/pages/maintenanceWriter';
import { maintenanceHasWork } from '../src/services/metaAgent/maintenanceCoordinator';
import { runPageTool } from '../src/agents/pageTools';

let dir: string;
let priorData: string | undefined;
let priorCloud: string | undefined;

beforeEach(() => {
  priorData = process.env.MICHI_DATA_DIR;
  priorCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-page-edit-leases-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  const db = getDb();
  db.prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws', 'Workspace', 'alice');
  db.prepare("INSERT INTO nodes(id,workspace_id,kind,status,title) VALUES ('n1','ws','chat','idle','Release notes'),('n2','ws','chat','idle',NULL)").run();
  db.prepare(`INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at)
    VALUES ('t1','n1','a1','active',1,1),('t2','n2','a2','active',1,1)`).run();
});

afterEach(() => {
  closeDb();
  if (priorData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = priorData;
  if (priorCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = priorCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

const first = { kind: 'chat' as const, nodeId: 'n1', turnId: 't1', assistantId: 'a1' };
const second = { kind: 'chat' as const, nodeId: 'n2', turnId: 't2', assistantId: 'a2' };
const insert = (text: string) => [{ op: 'insert', after: null, block: { type: 'markdown', text } }];

function edit(pageId: string, source: typeof first, text: string, now: number) {
  return applyAgentPageEdits({ pageId, workspaceId: 'ws', ownerUserId: 'alice', source, ops: insert(text), now });
}

test('a chat edit takes the lease and another live turn is refused without saving anything', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Status', now: 10 });
  assert.equal(edit(page.id, first, 'One', 1_000).commitStatus, 'committed');
  const lease = livePageEditLease(page.id, 1_000)!;
  assert.equal(lease.turnId, 't1');
  assert.equal(lease.expiresAt, 1_000 + PAGE_EDIT_LEASE_IDLE_MS);

  const revision = getPage(page.id, 'alice').revision;
  assert.throws(() => edit(page.id, second, 'Two', 2_000), (error: any) =>
    error.code === 'page_busy' && error.status === 409 && /Release notes/.test(error.message));
  assert.equal(getPage(page.id, 'alice').revision, revision);

  // The holder keeps writing and renews; the person is never blocked.
  assert.equal(edit(page.id, first, 'Three', 3_000).commitStatus, 'committed');
  assert.equal(livePageEditLease(page.id, 3_000)!.expiresAt, 3_000 + PAGE_EDIT_LEASE_IDLE_MS);
  const current = getPage(page.id, 'alice');
  applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: current.revision, now: 3_500, ops: insert('Mine') });
});

for (const status of ['completed', 'cancelled', 'error']) {
  test(`a ${status} turn stops holding its lease without a release step`, () => {
    const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Status', now: 10 });
    edit(page.id, first, 'One', 1_000);
    getDb().prepare('UPDATE turns SET status=? WHERE turn_id=?').run(status, 't1');
    assert.equal(livePageEditLease(page.id, 1_001), null);
    assert.equal(edit(page.id, second, 'Two', 1_002).commitStatus, 'committed');
    assert.equal(livePageEditLease(page.id, 1_002)!.turnId, 't2');
  });
}

test('the lease idles out after 5 minutes and renewals stop at the 30 minute cap', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Status', now: 10 });
  const hold = (holder: { nodeId: string; turnId: string }, now: number) =>
    acquirePageEditLease({ pageId: page.id, ownerUserId: 'alice', workspaceId: 'ws', holder, now });
  const t1 = { nodeId: 'n1', turnId: 't1' };
  const t2 = { nodeId: 'n2', turnId: 't2' };

  assert.equal(hold(t1, 0).acquired, true);
  assert.equal(livePageEditLease(page.id, PAGE_EDIT_LEASE_IDLE_MS), null, 'idle expiry is exclusive');
  assert.equal(hold(t2, PAGE_EDIT_LEASE_IDLE_MS).acquired, true, 'an idle lease is free to another turn');

  // t2 keeps renewing every 4 minutes from its fresh acquiredAt.
  const start = PAGE_EDIT_LEASE_IDLE_MS;
  for (let at = start; at < start + PAGE_EDIT_LEASE_MAX_MS; at += 4 * 60_000) {
    const renewed = hold(t2, at);
    assert.equal(renewed.acquired, true);
    assert.ok(renewed.lease.expiresAt <= start + PAGE_EDIT_LEASE_MAX_MS);
  }
  const beforeCap = start + PAGE_EDIT_LEASE_MAX_MS - 1;
  assert.equal(hold(t1, beforeCap).acquired, false, 'still held just before the cap');
  const atCap = start + PAGE_EDIT_LEASE_MAX_MS;
  assert.equal(livePageEditLease(page.id, atCap), null);
  const taken = hold(t1, atCap);
  assert.equal(taken.acquired, true, 'past the cap anyone may take it');
  assert.equal(taken.lease.acquiredAt, atCap);
});

test('read_page with forEdit reserves the page and reports a busy page to others', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Status', now: 10 });
  const caller = (nodeId: string, turnId: string, assistantId: string) => ({
    ownerUserId: 'alice', workspaceId: 'ws', nodeId, ownerKind: 'chat_node' as const,
    getActivePageTurnAttribution: () => ({ turnId, assistantId }),
  });
  const mine = runPageTool('read_page', caller('n1', 't1', 'a1'), { pageId: page.id, forEdit: true });
  assert.equal(mine.isError, undefined, mine.content[0]!.text);
  assert.equal((mine.details as any).editLease.status, 'held');

  const plain = runPageTool('read_page', caller('n2', 't2', 'a2'), { pageId: page.id });
  assert.equal((plain.details as any).editLease.status, 'busy');
  assert.equal((plain.details as any).editLease.holderNodeId, 'n1');
  const contended = runPageTool('read_page', caller('n2', 't2', 'a2'), { pageId: page.id, forEdit: true });
  assert.equal((contended.details as any).editLease.status, 'busy');
  const refused = runPageTool('edit_page', caller('n2', 't2', 'a2'), { pageId: page.id, ops: insert('Two') });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.text, /PAGE_BUSY/);

  const own = runPageTool('read_page', caller('n1', 't1', 'a1'), { pageId: page.id });
  assert.equal((own.details as any).editLease, undefined, 'the holder is not told about its own lease');
});

function maintenanceSetup() {
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
  db.prepare(`INSERT OR IGNORE INTO scheduler_execution_claims(run_id,job_id,holder,generation,acquired_at,workspace_id)
    SELECT r.id,r.job_id,r.claimed_by,l.generation,r.started_at,r.workspace_id FROM scheduled_job_runs r JOIN scheduler_lease l ON l.id=1`).run();
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', now: 10 });
  const config = createMaintenanceConfig({ workspaceId: 'ws', ownerUserId: 'alice', jobId: 'job', enabled: true, now: 20 });
  db.prepare("UPDATE meta SET value='1' WHERE key='conversation_completion_seq:ws'").run();
  const authority = { workspaceId: 'ws', ownerUserId: 'alice', jobId: 'job', runId: 'run', claimedBy: 'worker', configRevision: config.revision };
  const plan = createMaintenancePlan({ ...authority, after: 0, through: 1, now: 30 });
  const source = plan.sources[0]!;
  const context: MaintenanceExecutionContext = { ...authority, planId: plan.id,
    sources: [{ sourceTurnId: source.sourceTurnId, evidence: source.evidence }],
    execution: { nodeId: 'maintenance-node', turnId: 'turn-maint', assistantId: 'a-maint', runId: 'run' } };
  const tools = createMaintenanceTools(context, { now: () => Date.now() });
  const tool = (name: string) => tools.find((entry) => entry.name === name)!;
  const read = tool('maintenance_read_source');
  const offered = read.execute({ sourceTurnId: 'turn-source' }) as any;
  read.execute({ sourceTurnId: 'turn-source', acknowledgeParts: offered.details.parts.map((part: any) => ({ partId: part.partId, partHash: part.partHash })) });
  const routed = tool('maintenance_route_source').execute({ sourceTurnId: 'turn-source', candidates: [{ kind: 'page', id: page.id }] }) as any;
  assert.equal(routed.isError, undefined, routed.content?.[0]?.text);
  return { page, plan, tool };
}

const deferredRun = (pageId: string) => ({ ...(getDb().prepare(
  "SELECT deferred_run_id,state FROM page_maintenance_resources WHERE resource_kind='page' AND resource_id=?").get(pageId) as { deferred_run_id: string | null; state: string }) });

test('maintenance leaves a page a conversation is editing pending and resumes after the turn ends', () => {
  const { page, plan, tool } = maintenanceSetup();
  edit(page.id, first, 'Conversation edit', Date.now());
  const revision = getPage(page.id, 'alice').revision;

  for (const [name, args] of [
    ['maintenance_read_page', { sourceTurnId: 'turn-source', pageId: page.id }],
    ['maintenance_write_page', { sourceTurnId: 'turn-source', pageId: page.id, ops: insert('Maintenance edit') }],
    ['maintenance_no_change', { sourceTurnId: 'turn-source', resourceKind: 'page', resourceId: page.id, reason: 'Nothing to add' }],
  ] as const) {
    const result = tool(name).execute(args) as any;
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, /PAGE_BUSY/, name);
  }
  assert.equal(getPage(page.id, 'alice').revision, revision);
  assert.deepEqual(deferredRun(page.id), { deferred_run_id: 'run', state: 'pending' });

  // While the conversation holds the page, no maintenance run is started for this plan.
  assert.equal(maintenancePlanWaitsOnEditLeases(plan.id, 'alice', Date.now()).waiting, true);
  assert.equal(maintenanceHasWork('ws', 'alice', Date.now()), false);

  getDb().prepare("UPDATE turns SET status='completed' WHERE turn_id='t1'").run();
  // The run that deferred still counts as having stopped for the lease; a new run is now due.
  assert.deepEqual(maintenancePlanWaitsOnEditLeases(plan.id, 'alice', Date.now(), 'run'), { waiting: true, pages: 1 });
  assert.equal(maintenancePlanWaitsOnEditLeases(plan.id, 'alice', Date.now()).waiting, false);
  assert.equal(maintenanceHasWork('ws', 'alice', Date.now()), true);

  const reread = tool('maintenance_read_page').execute({ sourceTurnId: 'turn-source', pageId: page.id }) as any;
  assert.equal(reread.isError, undefined, reread.content?.[0]?.text);
  const written = tool('maintenance_write_page').execute({ sourceTurnId: 'turn-source', pageId: page.id, ops: insert('Maintenance edit') }) as any;
  assert.equal(written.isError, undefined, written.content?.[0]?.text);
  assert.equal(deferredRun(page.id).state, 'written');
});

test('a lease taken after the maintenance read refuses the write and records the deferral', () => {
  const { page, tool } = maintenanceSetup();
  const reread = tool('maintenance_read_page').execute({ sourceTurnId: 'turn-source', pageId: page.id }) as any;
  assert.equal(reread.isError, undefined, reread.content?.[0]?.text);
  acquirePageEditLease({ pageId: page.id, ownerUserId: 'alice', workspaceId: 'ws', holder: { nodeId: 'n1', turnId: 't1' }, now: Date.now() });
  const result = tool('maintenance_write_page').execute({ sourceTurnId: 'turn-source', pageId: page.id, ops: insert('Late') }) as any;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /PAGE_BUSY/);
  assert.deepEqual(deferredRun(page.id), { deferred_run_id: 'run', state: 'pending' });
});
