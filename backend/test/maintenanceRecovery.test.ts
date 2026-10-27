import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createDatabase, createPage, getDatabase } from '../src/services/pages/repository';
import { applyUserDatabaseEdits } from '../src/services/pages/databaseWrites';
import {
  claimMaintenancePlan, createMaintenanceConfig, createMaintenancePlan, maintenancePlanIsTerminal, reobserveRoutedMaintenanceResource,
} from '../src/services/pages/maintenanceRepository';
import { createMaintenanceTools } from '../src/services/pages/maintenanceTools';
import type { MaintenanceExecutionContext } from '../src/services/pages/maintenanceWriter';

let dir: string;
let priorData: string | undefined;
beforeEach(() => {
  priorData = process.env.MICHI_DATA_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-maintenance-recovery-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws', 'Workspace', 'alice');
});
afterEach(() => {
  closeDb();
  if (priorData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = priorData;
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(role?: 'tasks', routePage: boolean | 'both' = false) {
  const db = getDb();
  db.prepare(`INSERT INTO scheduled_jobs(id,owner_user_id,workspace_id,name,prompt,schedule,permission_mode,session_mode,notify,enabled,auto_paused,consecutive_failures,timeout_seconds,created_at,updated_at)
    VALUES('job','alice','ws','Maintenance','prompt','{"kind":"every","everySeconds":3600}','trust','fresh',0,1,0,0,1800,1,1)`).run();
  db.prepare("INSERT INTO scheduler_lease(id,holder,expires_at) VALUES(1,'worker',9007199254740000)").run();
  db.prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES('source-node','ws','chat','idle',1),('maintenance-node','ws','chat','idle',1)").run();
  db.prepare("INSERT INTO messages(id,node_id,role,content,seq,created_at,metadata) VALUES('u-source','source-node','user','Release is ready.',1,2,'{}'),('a-source','source-node','assistant','Update the release status.',2,3,'{}'),('u-maint','maintenance-node','user','maint',1,4,'{\"scheduledJobId\":\"job\"}'),('a-maint','maintenance-node','assistant','done',2,5,'{}')").run();
  db.prepare(`INSERT INTO turns(turn_id,node_id,user_message_id,assistant_message_id,status,last_seq,started_at,completed_at,updated_at,completion_seq)
    VALUES('turn-source','source-node','u-source','a-source','completed',2,1,3,3,1),('turn-maint','maintenance-node','u-maint','a-maint','active',1,4,NULL,5,NULL)`).run();
  db.prepare("INSERT INTO meta(key,value) VALUES('conversation_completion_seq:ws','0')").run();
  const insertRun = (id: string) => {
    db.prepare(`INSERT INTO scheduled_job_runs(id,job_id,workspace_id,node_id,tree_id,turn_id,trigger,status,scheduled_for,started_at,finished_at,summary,error,notify_state,notify_kind,attention,claimed_by)
      VALUES(?,'job','ws','maintenance-node',NULL,'turn-maint','scheduled','running',NULL,5,NULL,NULL,NULL,'none',NULL,NULL,'worker')`).run(id);
    db.prepare(`INSERT OR IGNORE INTO scheduler_execution_claims(run_id,job_id,holder,generation,acquired_at,workspace_id)
      SELECT r.id,r.job_id,r.claimed_by,l.generation,r.started_at,r.workspace_id FROM scheduled_job_runs r JOIN scheduler_lease l ON l.id=1 WHERE r.id=?`).run(id);
  };
  insertRun('run');
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', now: 10 });
  const database = createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Milestones', now: 15,
    columns: [{ id: 'task', name: 'Task', type: 'text' }, { id: 'status', name: 'Status', type: 'text' }], views: [],
    rows: [{ id: 'row-1', position: 0, values: { task: 'Ship', status: 'Planned' }, rev: 1, edited: {}, bodyEditedAt: null, updatedAt: 15 }] });
  db.prepare('INSERT INTO page_database_refs(page_id,database_id) VALUES(?,?)').run(page.id, database.id);
  let spare: { id: string } | undefined;
  if (routePage === 'both') {
    spare = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Spare', now: 12 });
    getDb().prepare('INSERT INTO page_database_refs(page_id,database_id) VALUES(?,?)').run(spare.id, database.id);
  }
  if (role) db.prepare("UPDATE page_databases SET role='tasks' WHERE id=?").run(database.id);
  const config = createMaintenanceConfig({ workspaceId: 'ws', ownerUserId: 'alice', jobId: 'job', enabled: true, now: 20 });
  db.prepare("UPDATE meta SET value='1' WHERE key='conversation_completion_seq:ws'").run();
  const authority = { workspaceId: 'ws', ownerUserId: 'alice', jobId: 'job', runId: 'run', claimedBy: 'worker', configRevision: config.revision };
  const plan = createMaintenancePlan({ ...authority, after: 0, through: 1, now: 30 });
  const source = plan.sources[0]!;
  const contextFor = (runId: string): MaintenanceExecutionContext => ({ ...authority, runId, planId: plan.id,
    sources: [{ sourceTurnId: source.sourceTurnId, evidence: source.evidence }],
    execution: { nodeId: 'maintenance-node', turnId: 'turn-maint', assistantId: 'a-maint', runId } });
  const toolsFor = (context: MaintenanceExecutionContext) => {
    const tools = createMaintenanceTools(context, { now: () => 40 });
    return (name: string, args: Record<string, unknown>) => tools.find((tool) => tool.name === name)!.execute(args) as any;
  };
  const call = toolsFor(contextFor('run'));
  const offered = call('maintenance_read_source', { sourceTurnId: 'turn-source' }).details;
  call('maintenance_read_source', { sourceTurnId: 'turn-source', acknowledgeParts: offered.parts.map((p: any) => ({ partId: p.partId, partHash: p.partHash })) });
  const candidates = routePage === 'both' ? [{ kind: 'page', id: page.id }, { kind: 'database', id: database.id }]
    : [routePage ? { kind: 'page', id: page.id } : { kind: 'database', id: database.id }];
  const routed = call('maintenance_route_source', { sourceTurnId: 'turn-source', candidates });
  assert.equal(routed.isError, undefined, routed.content?.[0]?.text);
  return { page, spare, database, plan, call, authority, contextFor, toolsFor, insertRun };
}
const resourceRow = (planId: string) => getDb().prepare('SELECT state,payload_hash AS hash,observed_revision AS rev,page_ids_json AS pages FROM page_maintenance_resources WHERE plan_id=?').get(planId) as { state: string; hash: string | null; rev: number; pages: string };
const userBump = (databaseId: string, ops: unknown[]) => applyUserDatabaseEdits({ databaseId, ownerUserId: 'alice', revision: getDatabase(databaseId, 'alice').revision, ops, now: 50 } as any);
const bump = (databaseId: string) => getDb().prepare('UPDATE page_databases SET revision=revision+1 WHERE id=?').run(databaseId);

test('no_change against a moved task database fails before freezing; reading again then recording no change finishes the plan', () => {
  const { database, plan, call } = setup('tasks');
  call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id });
  bump(database.id);
  const refused = call('maintenance_no_change', { sourceTurnId: 'turn-source', resourceKind: 'database', resourceId: database.id, reason: 'Nothing new' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /changed since you read it/);
  assert.equal(resourceRow(plan.id).hash, null);
  assert.equal(call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id }).isError, undefined);
  const done = call('maintenance_no_change', { sourceTurnId: 'turn-source', resourceKind: 'database', resourceId: database.id, reason: 'Nothing new' });
  assert.equal(done.isError, undefined, done.content?.[0]?.text);
  assert.equal(maintenancePlanIsTerminal(plan.id, 'alice'), true);
});

test('a write after list with no read is refused before freezing; a write after a fresh read succeeds', () => {
  const { database, plan, call } = setup();
  call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id });
  userBump(database.id, [{ op: 'row.add', values: { task: 'Release notes', status: 'Planned' } }]);
  const ops = [{ op: 'row.add', values: { task: 'Release notes', status: 'Planned' } }];
  assert.equal(call('maintenance_write_database', { sourceTurnId: 'turn-source', databaseId: database.id, ops }).isError, true);
  const listed = call('maintenance_list_resources', { sourceTurnId: 'turn-source' });
  assert.equal(listed.isError, undefined);
  const stale = call('maintenance_write_database', { sourceTurnId: 'turn-source', databaseId: database.id, ops });
  assert.equal(stale.isError, true, 'list does not make a stale write current');
  assert.equal(resourceRow(plan.id).hash, null);
  assert.equal(getDatabase(database.id, 'alice').rows.filter((row) => row.values.task === 'Release notes').length, 1);
  call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id });
  const row = getDatabase(database.id, 'alice').rows.find((r) => r.id === 'row-1')!;
  const fresh = call('maintenance_write_database', { sourceTurnId: 'turn-source', databaseId: database.id,
    ops: [{ op: 'row.update', id: 'row-1', expectRev: row.rev, values: { status: 'Shipped' } }] });
  assert.equal(fresh.isError, undefined, fresh.content?.[0]?.text);
  assert.equal(maintenancePlanIsTerminal(plan.id, 'alice'), true);
});

test('a database that left its routed pages is listed unavailable, then skipped with a reason when read, and the plan finishes', () => {
  const { database, plan, call } = setup();
  const other = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Board 2', now: 60 });
  getDb().prepare('INSERT INTO page_database_refs(page_id,database_id) VALUES(?,?)').run(other.id, database.id);
  const listed = call('maintenance_list_resources', { sourceTurnId: 'turn-source' }).details;
  assert.equal(listed.totalResources, 1);
  assert.equal(listed.resources[0].available, false);
  assert.equal(listed.resources[0].decision, 'pending');
  const read = call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id });
  assert.equal(read.isError, true);
  assert.match(read.content[0].text, /moved to other pages/);
  assert.equal(resourceRow(plan.id).state, 'skipped');
  assert.equal(maintenancePlanIsTerminal(plan.id, 'alice'), true);
  const source = getDb().prepare('SELECT state,terminal_reason AS reason FROM page_maintenance_sources WHERE plan_id=?').get(plan.id) as { state: string; reason: string };
  assert.equal(source.state, 'skipped');
  assert.match(source.reason, /moved to other pages/);
});

test('a deleted routed database is skipped when read', () => {
  const { database, plan, call } = setup();
  getDb().prepare('UPDATE page_databases SET deleted_at=1 WHERE id=?').run(database.id);
  const read = call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id });
  assert.equal(read.isError, true);
  assert.match(read.content[0].text, /deleted or excluded/);
  assert.equal(maintenancePlanIsTerminal(plan.id, 'alice'), true);
});

test('the workspace task database adopts a changed board route when read', () => {
  const { database, plan, call } = setup('tasks');
  const other = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Board 2', now: 60 });
  getDb().prepare('INSERT INTO page_database_refs(page_id,database_id) VALUES(?,?)').run(other.id, database.id);
  const read = call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id });
  assert.equal(read.isError, undefined, read.content?.[0]?.text);
  assert.equal(JSON.parse(resourceRow(plan.id).pages).length, 2);
  const done = call('maintenance_no_change', { sourceTurnId: 'turn-source', resourceKind: 'database', resourceId: database.id, reason: 'Nothing new' });
  assert.equal(done.isError, undefined, done.content?.[0]?.text);
  assert.equal(maintenancePlanIsTerminal(plan.id, 'alice'), true);
});

test('a run that reclaims the stranded plan through claimMaintenancePlan lists, reads, decides and finishes', () => {
  const { database, plan, authority, contextFor, toolsFor, insertRun } = setup('tasks');
  bump(database.id);
  getDb().prepare("UPDATE scheduled_job_runs SET status='failed' WHERE id='run'").run();
  insertRun('run-2');
  const claimed = claimMaintenancePlan({ ...authority, runId: 'run-2', planId: plan.id, now: 41 });
  assert.equal(claimed.state, 'processing');
  const call = toolsFor(contextFor('run-2'));
  const listed = call('maintenance_list_resources', { sourceTurnId: 'turn-source' });
  assert.equal(listed.isError, undefined, listed.content?.[0]?.text);
  assert.equal(listed.details.routed, true);
  assert.equal(call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id }).isError, undefined);
  const done = call('maintenance_no_change', { sourceTurnId: 'turn-source', resourceKind: 'database', resourceId: database.id, reason: 'Nothing new' });
  assert.equal(done.isError, undefined, done.content?.[0]?.text);
  assert.equal(maintenancePlanIsTerminal(plan.id, 'alice'), true);
});

test('re-observing refreshes a receipt-less frozen resource and leaves a decided one alone', () => {
  const { database, plan, authority, call } = setup();
  call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id });
  const input = { ...authority, planId: plan.id, sourceTurnId: 'turn-source', kind: 'database' as const, resourceId: database.id, now: 45 };
  getDb().prepare('UPDATE page_maintenance_resources SET payload_hash=? WHERE plan_id=?').run('frozen', plan.id);
  const before = resourceRow(plan.id).rev;
  bump(database.id);
  assert.equal(reobserveRoutedMaintenanceResource(input).outcome, 'advanced');
  assert.equal(resourceRow(plan.id).rev, before + 1);
  assert.equal(resourceRow(plan.id).hash, 'frozen');
  getDb().prepare("UPDATE page_maintenance_resources SET state='no_change' WHERE plan_id=?").run(plan.id);
  bump(database.id);
  assert.equal(reobserveRoutedMaintenanceResource(input).outcome, 'unchanged');
  assert.equal(resourceRow(plan.id).rev, before + 1);
});

test('a write the apply step rejected leaves the resource open: the corrected write succeeds and the plan finishes', () => {
  const { database, plan, call } = setup();
  call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id });
  const wrong = call('maintenance_write_database', { sourceTurnId: 'turn-source', databaseId: database.id,
    ops: [{ op: 'row.update', id: 'row-1', expectRev: 9, values: { status: 'Shipped' } }] });
  assert.equal(wrong.isError, true);
  assert.notEqual(resourceRow(plan.id).hash, null, 'the rejected attempt froze its payload but applied nothing');
  assert.equal(resourceRow(plan.id).state, 'pending');
  const rev = getDatabase(database.id, 'alice').rows[0]!.rev;
  const fixed = call('maintenance_write_database', { sourceTurnId: 'turn-source', databaseId: database.id,
    ops: [{ op: 'row.update', id: 'row-1', expectRev: rev, values: { status: 'Shipped' } }] });
  assert.equal(fixed.isError, undefined, fixed.content?.[0]?.text);
  assert.equal(maintenancePlanIsTerminal(plan.id, 'alice'), true);
});

test('a page insert after a missing block is rejected, then the corrected insert succeeds', () => {
  const { page, plan, call } = setup(undefined, true);
  call('maintenance_read_page', { sourceTurnId: 'turn-source', pageId: page.id });
  const block = { type: 'markdown', text: '- Release ready' };
  const bad = call('maintenance_write_page', { sourceTurnId: 'turn-source', pageId: page.id, ops: [{ op: 'insert', after: 'no-such-block', block }] });
  assert.equal(bad.isError, true);
  const fixed = call('maintenance_write_page', { sourceTurnId: 'turn-source', pageId: page.id, ops: [{ op: 'insert', after: null, block }] });
  assert.equal(fixed.isError, undefined, fixed.content?.[0]?.text);
  assert.equal(maintenancePlanIsTerminal(plan.id, 'alice'), true);
});

test('a failed write leaves a frozen, receipt-less resource that no_change can still settle', () => {
  const { database, plan, call } = setup();
  call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id });
  const wrong = call('maintenance_write_database', { sourceTurnId: 'turn-source', databaseId: database.id,
    ops: [{ op: 'row.update', id: 'row-1', expectRev: 9, values: { status: 'Shipped' } }] });
  assert.equal(wrong.isError, true);
  const done = call('maintenance_no_change', { sourceTurnId: 'turn-source', resourceKind: 'database', resourceId: database.id, reason: 'Nothing to change' });
  assert.equal(done.isError, undefined, done.content?.[0]?.text);
  assert.equal(maintenancePlanIsTerminal(plan.id, 'alice'), true);
});

test('a frozen, receipt-less resource whose target then moved is refreshed by a read and written', () => {
  const { database, plan, call } = setup();
  call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id });
  assert.equal(call('maintenance_write_database', { sourceTurnId: 'turn-source', databaseId: database.id,
    ops: [{ op: 'row.update', id: 'row-1', expectRev: 9, values: { status: 'Shipped' } }] }).isError, true);
  bump(database.id);
  call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id });
  const rev = getDatabase(database.id, 'alice').rows[0]!.rev;
  const fixed = call('maintenance_write_database', { sourceTurnId: 'turn-source', databaseId: database.id,
    ops: [{ op: 'row.update', id: 'row-1', expectRev: rev, values: { status: 'Shipped' } }] });
  assert.equal(fixed.isError, undefined, fixed.content?.[0]?.text);
  assert.equal(maintenancePlanIsTerminal(plan.id, 'alice'), true);
});

test('after a receipt an identical retry replays and a different operation set conflicts', () => {
  const { database, call } = setup();
  call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id });
  const ops = [{ op: 'row.add', values: { task: 'Notes', status: 'Planned' } }];
  const first = call('maintenance_write_database', { sourceTurnId: 'turn-source', databaseId: database.id, ops });
  assert.equal(first.isError, undefined, first.content?.[0]?.text);
  const again = call('maintenance_write_database', { sourceTurnId: 'turn-source', databaseId: database.id, ops });
  assert.equal(again.isError, undefined, again.content?.[0]?.text);
  assert.deepEqual(again.details.applied, first.details.applied);
  const other = call('maintenance_write_database', { sourceTurnId: 'turn-source', databaseId: database.id,
    ops: [{ op: 'row.add', values: { task: 'Other', status: 'Planned' } }] });
  assert.equal(other.isError, true);
  assert.equal(getDatabase(database.id, 'alice').rows.length, 2);
});

test('a source whose resources were skipped for different reasons records both reasons', () => {
  const { page, database, plan, call } = setup(undefined, 'both');
  getDb().prepare('UPDATE pages SET deleted_at=1 WHERE id=?').run(page.id);
  assert.equal(call('maintenance_read_page', { sourceTurnId: 'turn-source', pageId: page.id }).isError, true);
  assert.equal(call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id }).isError, true);
  const source = getDb().prepare('SELECT state,terminal_reason AS reason FROM page_maintenance_sources WHERE plan_id=?').get(plan.id) as { state: string; reason: string };
  assert.equal(source.state, 'skipped');
  assert.match(source.reason, /deleted or excluded/);
  assert.match(source.reason, /moved to other pages/);
});

test('a Space catch-up whose Space is gone settles its routed resources as skipped', () => {
  const { database, plan, call } = setup();
  getDb().prepare("UPDATE page_maintenance_plans SET scope_space_id='pg-missing' WHERE id=?").run(plan.id);
  const read = call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id });
  assert.equal(read.isError, true);
  assert.match(read.content[0].text, /deleted or excluded/);
  assert.equal(maintenancePlanIsTerminal(plan.id, 'alice'), true);
});

test('the task database stays listed as available when its board route changed', () => {
  const { database, call } = setup('tasks');
  const other = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Board 2', now: 60 });
  getDb().prepare('INSERT INTO page_database_refs(page_id,database_id) VALUES(?,?)').run(other.id, database.id);
  const listed = call('maintenance_list_resources', { sourceTurnId: 'turn-source' }).details;
  assert.equal(listed.resources[0].available, undefined);
  assert.equal(listed.resources[0].role, 'tasks');
});

test('a scoped plan whose workspace was soft-deleted errors on read and leaves the resource pending', () => {
  const { page, database, plan, call } = setup();
  getDb().prepare('UPDATE page_maintenance_plans SET scope_space_id=? WHERE id=?').run(page.id, plan.id);
  getDb().prepare('UPDATE workspaces SET deleted_at=99 WHERE id=?').run('ws');
  assert.equal(call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id }).isError, true);
  assert.equal(resourceRow(plan.id).state, 'pending');
});

test('a scoped plan over the page limit errors on read and leaves the resource pending', () => {
  const { page, database, plan, call } = setup();
  getDb().prepare('UPDATE page_maintenance_plans SET scope_space_id=? WHERE id=?').run(page.id, plan.id);
  const cols = (getDb().prepare('PRAGMA table_info(pages)').all() as Array<{ name: string }>).map((c) => c.name);
  const select = cols.map((c) => c === 'id' ? "'flood-'||n" : c === 'parent_id' ? 'NULL' : c === 'position' ? '1000+n' : c).join(',');
  getDb().prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<2001)
    INSERT INTO pages(${cols.join(',')}) SELECT ${select} FROM seq, pages WHERE pages.id=?`).run(page.id);
  assert.equal(call('maintenance_read_database', { sourceTurnId: 'turn-source', databaseId: database.id }).isError, true);
  assert.equal(resourceRow(plan.id).state, 'pending');
});
