import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createPage } from '../src/services/pages/repository';
import {
  claimMaintenancePlan, claimQueuedMaintenanceCatchup, claimQueuedMaintenanceReconsider, claimTerminalMaintenancePlan,
  createMaintenanceConfig, createMaintenancePlan, findTerminalMaintenancePlan, freezeMaintenanceResourcePayload,
  getMaintenanceReceipt, listEligibleMaintenanceManifest, listMaintenanceCatchupSuggestions, maintenanceOperationKey, maintenancePlanIsTerminal,
  listQueuedMaintenanceReconsiderations, persistMaintenanceReceiptInTransaction, queueMaintenanceCatchup, queueMaintenanceReconsider,
  readMaintenanceSourceMessages, recordMaintenanceRouting, refreshMaintenanceSourceManifest, setSpaceMaintenanceExcluded,
  updateMaintenanceConfig,
} from '../src/services/pages/maintenanceRepository';
import { runInTransaction } from '../src/services/db';

let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;
beforeEach(() => {
  oldData=process.env.MICHI_DATA_DIR; oldCloud=process.env.MICHI_CLOUD;
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'michi-page-maintenance-'));
  process.env.MICHI_DATA_DIR=dir; delete process.env.MICHI_CLOUD;
  closeDb();initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws','Workspace','alice');
});
afterEach(()=>{
  closeDb(); if(oldData===undefined)delete process.env.MICHI_DATA_DIR;else process.env.MICHI_DATA_DIR=oldData;
  if(oldCloud===undefined)delete process.env.MICHI_CLOUD;else process.env.MICHI_CLOUD=oldCloud;
  fs.rmSync(dir,{recursive:true,force:true});
});

function seedRunAndSource(): void {
  const db=getDb();
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

test('starts from current feed counter; pause preserves cursor and exclusion hides the whole Space subtree',()=>{
  seedRunAndSource();
  const root=createPage({workspaceId:'ws',ownerUserId:'alice',title:'Release',now:10});
  const child=createPage({workspaceId:'ws',ownerUserId:'alice',parentId:root.id,title:'Notes',now:11});
  const other=createPage({workspaceId:'ws',ownerUserId:'alice',title:'Research',now:12});
  const config=createMaintenanceConfig({workspaceId:'ws',ownerUserId:'alice',jobId:'job',now:20,enabled:true});
  assert.equal(config.completionCursor,1);
  assert.deepEqual(listEligibleMaintenanceManifest('ws','alice').pages.map(p=>p.id).sort(),[root.id,child.id,other.id].sort());
  const excluded=setSpaceMaintenanceExcluded({workspaceId:'ws',ownerUserId:'alice',spaceId:root.id,excluded:true,expectedRevision:config.revision,now:21});
  assert.deepEqual(listEligibleMaintenanceManifest('ws','alice').pages.map(p=>p.id),[other.id]);
  const paused=updateMaintenanceConfig({workspaceId:'ws',ownerUserId:'alice',expectedRevision:excluded.revision,paused:true,now:22});
  assert.equal(paused.completionCursor,1);
  const resumed=updateMaintenanceConfig({workspaceId:'ws',ownerUserId:'alice',expectedRevision:paused.revision,paused:false,now:23});
  assert.equal(resumed.completionCursor,1);
});

test('freezes source routing and transaction-composable immutable receipts; retries return the original result',()=>{
  seedRunAndSource();
  getDb().prepare("UPDATE meta SET value='0' WHERE key='conversation_completion_seq:ws'").run();
  const config=createMaintenanceConfig({workspaceId:'ws',ownerUserId:'alice',jobId:'job',now:20,enabled:true});
  getDb().prepare("UPDATE meta SET value='1' WHERE key='conversation_completion_seq:ws'").run();
  const page=createPage({workspaceId:'ws',ownerUserId:'alice',title:'Release',now:10});
  const auth={workspaceId:'ws',ownerUserId:'alice',jobId:'job',runId:'run',claimedBy:'worker',configRevision:config.revision};
  const plan=createMaintenancePlan({...auth,after:0,through:1,now:30});
  assert.equal(plan.sources.length,1);
  const source=plan.sources[0]!;
  assert.equal(source.evidence.turnId,'turn-source');
  const ref=source.manifest.find(x=>x.kind==='page'&&x.id===page.id)!;
  const firstRead=readMaintenanceSourceMessages({planId:plan.id,ownerUserId:'alice',sourceTurnId:'turn-source',maxParts:8,now:30});
  assert.equal(firstRead.coverageComplete,false);
  assert.throws(()=>recordMaintenanceRouting({...auth,planId:plan.id,sourceTurnId:'turn-source',manifest:[ref],now:30}),/coverage is incomplete/);
  const acked=readMaintenanceSourceMessages({planId:plan.id,ownerUserId:'alice',sourceTurnId:'turn-source',acknowledgeParts:firstRead.parts.map(part=>({partId:part.partId,partHash:part.partHash})),now:31});
  assert.equal(acked.coverageComplete,true);
  assert.ok(source.manifest.some(x=>x.kind==='page'&&x.id===page.id));
  const routed=recordMaintenanceRouting({...auth,planId:plan.id,sourceTurnId:'turn-source',manifest:[ref],now:32});
  const frozen=freezeMaintenanceResourcePayload({...auth,planId:plan.id,sourceTurnId:'turn-source',kind:'page',resourceId:page.id,payload:{ops:[{op:'update',id:'b1'}]},assignedIds:{blockIds:['b1']},now:33});
  const receiptInput={...auth,planId:plan.id,sourceTurnId:'turn-source',resource:ref,outcome:'written' as const,payloadHash:frozen.payloadHash,
    payload:frozen.payload,assignedIds:frozen.assignedIds,result:{applied:['change-1']},execution:{nodeId:'maintenance-node',turnId:'turn-maint',assistantId:'a-maint',runId:'run'},evidence:source.evidence,now:34};
  const saved=runInTransaction(()=>persistMaintenanceReceiptInTransaction(receiptInput));
  assert.equal(saved.operationKey,maintenanceOperationKey('job','turn-source','page',page.id,plan.generation));
  assert.equal(maintenancePlanIsTerminal(plan.id,'alice'),true);
  const retry=runInTransaction(()=>persistMaintenanceReceiptInTransaction({...receiptInput,result:{applied:['different']},now:34}));
  assert.deepEqual(retry.result,{applied:['change-1']});
  assert.deepEqual(getMaintenanceReceipt(saved.operationKey),saved);
  assert.equal(routed.sources[0]?.routingComplete,true);
});

test('new source-plan generation can be explicitly bounded for historical reconsideration',()=>{
  seedRunAndSource();
  const config=createMaintenanceConfig({workspaceId:'ws',ownerUserId:'alice',jobId:'job',now:20,enabled:true});
  assert.throws(()=>createMaintenancePlan({workspaceId:'ws',ownerUserId:'alice',jobId:'job',runId:'run',claimedBy:'worker',configRevision:config.revision,after:0,through:1,now:30}),/current counter|cursor changed/);
  assert.equal(config.completionCursor,1);
});

test('owner reconsideration is durable and claimed only under a new active scheduler run',()=>{
  seedRunAndSource();
  getDb().prepare("UPDATE meta SET value='0' WHERE key='conversation_completion_seq:ws'").run();
  const config=createMaintenanceConfig({workspaceId:'ws',ownerUserId:'alice',jobId:'job',now:20,enabled:true});
  getDb().prepare("UPDATE meta SET value='1' WHERE key='conversation_completion_seq:ws'").run();
  const auth={workspaceId:'ws',ownerUserId:'alice',jobId:'job',runId:'run',claimedBy:'worker',configRevision:config.revision};
  const original=createMaintenancePlan({...auth,after:0,through:1,now:30});
  const queued=queueMaintenanceReconsider({workspaceId:'ws',ownerUserId:'alice',previousPlanId:original.id,sourceTurnIds:['turn-source'],expectedConfigRevision:config.revision,now:31});
  assert.equal(listQueuedMaintenanceReconsiderations('ws','alice')[0]?.requestId,queued.requestId);
  getDb().prepare(`INSERT INTO scheduled_job_runs(id,job_id,workspace_id,node_id,tree_id,turn_id,trigger,status,scheduled_for,started_at,finished_at,summary,error,notify_state,notify_kind,attention,claimed_by)
    VALUES('run2','job','ws','maintenance-node',NULL,'turn-maint','scheduled','running',NULL,40,NULL,NULL,NULL,'none',NULL,NULL,'worker')`).run();
  getDb().prepare(`INSERT OR IGNORE INTO scheduler_execution_claims
    (run_id,job_id,holder,generation,acquired_at,workspace_id)
    SELECT r.id,r.job_id,r.claimed_by,l.generation,r.started_at,r.workspace_id
    FROM scheduled_job_runs r JOIN scheduler_lease l ON l.id=1`).run();
  const next=claimQueuedMaintenanceReconsider({...auth,runId:'run2',requestId:queued.requestId,now:41});
  assert.equal(next.reconsiderOfPlanId,original.id);
  assert.equal(next.generation,original.generation+1);
  assert.equal(listQueuedMaintenanceReconsiderations('ws','alice').length,0);
});

test('Space catch-up suggestions are bounded to a closed exclusion interval and queue a scoped plan',()=>{
  seedRunAndSource();
  const space=createPage({workspaceId:'ws',ownerUserId:'alice',title:'Release',now:10});
  const other=createPage({workspaceId:'ws',ownerUserId:'alice',title:'Other',now:11});
  const config=createMaintenanceConfig({workspaceId:'ws',ownerUserId:'alice',jobId:'job',now:20,enabled:true});
  const excluded=setSpaceMaintenanceExcluded({workspaceId:'ws',ownerUserId:'alice',spaceId:space.id,excluded:true,expectedRevision:config.revision,now:21});
  getDb().prepare("UPDATE meta SET value='3' WHERE key='conversation_completion_seq:ws'").run();
  getDb().prepare(`INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES('source-node2','ws','chat','idle',30)`).run();
  getDb().prepare(`INSERT INTO messages(id,node_id,role,content,seq,created_at,metadata) VALUES('u-source2','source-node2','user','update release',1,31,'{}'),('a-source2','source-node2','assistant','Ready',2,32,'{}')`).run();
  getDb().prepare(`INSERT INTO turns(turn_id,node_id,user_message_id,assistant_message_id,status,last_seq,started_at,completed_at,updated_at,completion_seq)
    VALUES('turn-source2','source-node2','u-source2','a-source2','completed',2,30,32,32,2)`).run();
  const reenabled=setSpaceMaintenanceExcluded({workspaceId:'ws',ownerUserId:'alice',spaceId:space.id,excluded:false,expectedRevision:excluded.revision,now:40});
  const suggestions=listMaintenanceCatchupSuggestions('ws','alice',space.id);
  assert.equal(suggestions.length,1);
  assert.equal(suggestions[0]?.after,1);
  assert.equal(suggestions[0]?.through,3);
  assert.equal(suggestions[0]?.sourceCount,1);
  assert.equal(suggestions[0]?.latestSources[0]?.turnId,'turn-source2');
  assert.throws(()=>queueMaintenanceCatchup({workspaceId:'ws',ownerUserId:'alice',spaceId:space.id,
    expectedConfigRevision:reenabled.revision,after:0,through:3,now:41}),/recorded excluded period/);
  getDb().prepare("UPDATE meta SET value='4' WHERE key='conversation_completion_seq:ws'").run();
  assert.throws(()=>queueMaintenanceCatchup({workspaceId:'ws',ownerUserId:'alice',spaceId:space.id,
    expectedConfigRevision:reenabled.revision,after:1,through:4,now:41}),/recorded excluded period/);
  const queued=queueMaintenanceCatchup({workspaceId:'ws',ownerUserId:'alice',spaceId:space.id,expectedConfigRevision:reenabled.revision,after:1,through:3,now:41});
  getDb().prepare(`INSERT INTO scheduled_job_runs(id,job_id,workspace_id,node_id,tree_id,turn_id,trigger,status,scheduled_for,started_at,finished_at,summary,error,notify_state,notify_kind,attention,claimed_by)
    VALUES('run2','job','ws','maintenance-node',NULL,'turn-maint','scheduled','running',NULL,42,NULL,NULL,NULL,'none',NULL,NULL,'worker')`).run();
  getDb().prepare(`INSERT OR IGNORE INTO scheduler_execution_claims
    (run_id,job_id,holder,generation,acquired_at,workspace_id)
    SELECT r.id,r.job_id,r.claimed_by,l.generation,r.started_at,r.workspace_id
    FROM scheduled_job_runs r JOIN scheduler_lease l ON l.id=1`).run();
  const plan=claimQueuedMaintenanceCatchup({workspaceId:'ws',ownerUserId:'alice',jobId:'job',runId:'run2',claimedBy:'worker',configRevision:reenabled.revision,requestId:queued.requestId,now:43});
  assert.equal(plan.scopeSpaceId,space.id);
  assert.equal(plan.sources.length,1);
  assert.equal(plan.sources[0]?.sourceTurnId,'turn-source2');
  assert.ok(plan.sources[0]?.manifest.some(resource=>resource.id===space.id));
  assert.ok(!plan.sources[0]?.manifest.some(resource=>resource.id===other.id));
});

test('terminal plan recovery rebinds the same generation when new completions arrive before cursor commit',()=>{
  seedRunAndSource();
  const config=createMaintenanceConfig({workspaceId:'ws',ownerUserId:'alice',jobId:'job',now:20,enabled:true});
  const initial=createMaintenancePlan({workspaceId:'ws',ownerUserId:'alice',jobId:'job',runId:'run',claimedBy:'worker',configRevision:config.revision,after:1,through:1,now:30});
  assert.equal(initial.state,'terminal');
  getDb().prepare("UPDATE meta SET value='2' WHERE key='conversation_completion_seq:ws'").run();
  getDb().prepare(`INSERT INTO scheduled_job_runs(id,job_id,workspace_id,node_id,tree_id,turn_id,trigger,status,scheduled_for,started_at,finished_at,summary,error,notify_state,notify_kind,attention,claimed_by)
    VALUES('run2','job','ws','maintenance-node',NULL,'turn-maint','scheduled','running',NULL,40,NULL,NULL,NULL,'none',NULL,NULL,'worker')`).run();
  getDb().prepare(`INSERT OR IGNORE INTO scheduler_execution_claims
    (run_id,job_id,holder,generation,acquired_at,workspace_id)
    SELECT r.id,r.job_id,r.claimed_by,l.generation,r.started_at,r.workspace_id
    FROM scheduled_job_runs r JOIN scheduler_lease l ON l.id=1`).run();
  const found=findTerminalMaintenancePlan({workspaceId:'ws',ownerUserId:'alice',jobId:'job',after:1,through:2});
  assert.equal(found?.id,initial.id);
  const recovered=claimTerminalMaintenancePlan({workspaceId:'ws',ownerUserId:'alice',jobId:'job',runId:'run2',claimedBy:'worker',configRevision:config.revision,planId:initial.id,now:41});
  assert.equal(recovered.generation,initial.generation);
  assert.equal(recovered.runId,'run2');
  assert.equal(recovered.through,1);
});

test('unfinished plan resumes under current enabled config after revision changes without a new generation',()=>{
  seedRunAndSource();
  getDb().prepare("UPDATE meta SET value='0' WHERE key='conversation_completion_seq:ws'").run();
  const config=createMaintenanceConfig({workspaceId:'ws',ownerUserId:'alice',jobId:'job',now:20,enabled:true});
  getDb().prepare("UPDATE meta SET value='1' WHERE key='conversation_completion_seq:ws'").run();
  const plan=createMaintenancePlan({workspaceId:'ws',ownerUserId:'alice',jobId:'job',runId:'run',claimedBy:'worker',configRevision:config.revision,after:0,through:1,now:30});
  const paused=updateMaintenanceConfig({workspaceId:'ws',ownerUserId:'alice',expectedRevision:config.revision,paused:true,now:31});
  const resumed=updateMaintenanceConfig({workspaceId:'ws',ownerUserId:'alice',expectedRevision:paused.revision,paused:false,now:32});
  getDb().prepare(`INSERT INTO scheduled_job_runs(id,job_id,workspace_id,node_id,tree_id,turn_id,trigger,status,scheduled_for,started_at,finished_at,summary,error,notify_state,notify_kind,attention,claimed_by)
    VALUES('run2','job','ws','maintenance-node',NULL,'turn-maint','scheduled','running',NULL,40,NULL,NULL,NULL,'none',NULL,NULL,'worker')`).run();
  getDb().prepare(`INSERT OR IGNORE INTO scheduler_execution_claims
    (run_id,job_id,holder,generation,acquired_at,workspace_id)
    SELECT r.id,r.job_id,r.claimed_by,l.generation,r.started_at,r.workspace_id
    FROM scheduled_job_runs r JOIN scheduler_lease l ON l.id=1`).run();
  const rebound=claimMaintenancePlan({workspaceId:'ws',ownerUserId:'alice',jobId:'job',runId:'run2',claimedBy:'worker',configRevision:resumed.revision,planId:plan.id,now:41});
  assert.equal(rebound.generation,plan.generation);
  assert.equal(rebound.configRevision,resumed.revision);
  assert.equal(rebound.runId,'run2');
});

test('unrouted source manifest refreshes only after earlier source is terminal',()=>{
  seedRunAndSource();
  getDb().prepare("UPDATE meta SET value='0' WHERE key='conversation_completion_seq:ws'").run();
  const config=createMaintenanceConfig({workspaceId:'ws',ownerUserId:'alice',jobId:'job',now:20,enabled:true});
  getDb().prepare("UPDATE meta SET value='2' WHERE key='conversation_completion_seq:ws'").run();
  getDb().prepare(`INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES('source-node2','ws','chat','idle',10)`).run();
  getDb().prepare(`INSERT INTO messages(id,node_id,role,content,seq,created_at,metadata) VALUES('u-source2','source-node2','user','follow-up',1,11,'{}'),('a-source2','source-node2','assistant','follow-up response',2,12,'{}')`).run();
  getDb().prepare(`INSERT INTO turns(turn_id,node_id,user_message_id,assistant_message_id,status,last_seq,started_at,completed_at,updated_at,completion_seq)
    VALUES('turn-source2','source-node2','u-source2','a-source2','completed',2,10,12,12,2)`).run();
  const page=createPage({workspaceId:'ws',ownerUserId:'alice',title:'Shared target',now:13});
  const auth={workspaceId:'ws',ownerUserId:'alice',jobId:'job',runId:'run',claimedBy:'worker',configRevision:config.revision};
  const plan=createMaintenancePlan({...auth,after:0,through:2,now:30});
  const first=readMaintenanceSourceMessages({planId:plan.id,ownerUserId:'alice',sourceTurnId:'turn-source',now:31});
  readMaintenanceSourceMessages({planId:plan.id,ownerUserId:'alice',sourceTurnId:'turn-source',acknowledgeParts:first.parts.map(part=>({partId:part.partId,partHash:part.partHash})),now:32});
  recordMaintenanceRouting({...auth,planId:plan.id,sourceTurnId:'turn-source',manifest:[],reason:'No relevant targets for this source',now:33});
  getDb().prepare('UPDATE pages SET revision=revision+1 WHERE id=?').run(page.id);
  const refreshed=refreshMaintenanceSourceManifest({...auth,planId:plan.id,sourceTurnId:'turn-source2',now:34});
  assert.equal(refreshed.sources.find(source=>source.sourceTurnId==='turn-source2')?.manifest.find(resource=>resource.id===page.id)?.revision,2);
  assert.throws(()=>refreshMaintenanceSourceManifest({...auth,planId:plan.id,sourceTurnId:'turn-source',now:35}),/routed source manifest is immutable/);
});
