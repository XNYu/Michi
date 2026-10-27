import { createHash, randomUUID } from 'node:crypto';
import type {
  BlockSource, MaintenanceCatchupSuggestion, MaintenanceConfig, MaintenancePlan, MaintenanceReceipt, MaintenanceSourceMessageDescriptor, MaintenanceSourcePart,
  MaintenanceResourceKind, MaintenanceResourceRef, MaintenanceSourcePlan,
} from 'michi-shared';
import { getDb, runInTransaction } from '../db';
import { PageWriteError, requirePagesWorkspace } from './core';
import { workspaceOwnerMatches } from '../agentOwner';
import { backgroundMaintenanceResources } from '../metaAgent/homeWrites';

const db = () => getDb();
const json = (value: unknown) => JSON.stringify(value);
const parse = <T>(value: string): T => JSON.parse(value) as T;
const nowValue = (now: number) => {
  if (!Number.isSafeInteger(now) || now < 0) throw new PageWriteError(400, 'invalid', 'Invalid timestamp');
  return now;
};
const idValue = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new PageWriteError(400, 'invalid', `Invalid ${name}`);
  return value;
};

export class PageMaintenanceConflictError extends PageWriteError {
  constructor(message: string) { super(409, 'stale_revision', message); this.name = 'PageMaintenanceConflictError'; }
}

interface ConfigRow {
  workspace_id: string; owner_user_id: string; job_id: string; enabled: number; paused: number; revision: number;
  completion_cursor: number; runtime_id: string | null; provider_id: string | null; model_id: string | null; reasoning: string | null; updated_at: number;
}
function configDto(row: ConfigRow): MaintenanceConfig {
  return { workspaceId: row.workspace_id, ownerUserId: row.owner_user_id, jobId: row.job_id,
    enabled: row.enabled === 1, paused: row.paused === 1, revision: row.revision, completionCursor: row.completion_cursor,
    runtimeId: row.runtime_id, providerId: row.provider_id, modelId: row.model_id, reasoning: row.reasoning, updatedAt: row.updated_at };
}

function counter(workspaceId: string): number {
  const row = db().prepare('SELECT value FROM meta WHERE key=?').get(`conversation_completion_seq:${workspaceId}`) as { value: string } | undefined;
  const result = row ? Number(row.value) : 0;
  if (!Number.isSafeInteger(result) || result < 0) throw new PageWriteError(409, 'invalid', 'Invalid conversation completion counter');
  return result;
}
function countEligibleMaintenanceSources(workspaceId:string,ownerUserId:string,after:number,through:number):number {
  const row=db().prepare(`SELECT COUNT(*) AS n FROM turns t JOIN nodes n ON n.id=t.node_id JOIN workspaces w ON w.id=n.workspace_id
    JOIN messages m ON m.id=t.user_message_id LEFT JOIN trees tr ON tr.id=n.tree_id WHERE n.workspace_id=? AND n.kind='chat'
    AND n.purged_at IS NULL AND n.deleted_at IS NULL AND n.status<>'archived' AND tr.archived_at IS NULL
    AND w.deleted_at IS NULL AND w.purged_at IS NULL AND (w.owner_user_id=? OR (?='local-user' AND ?<>'1'))
    AND t.status='completed' AND t.completion_seq>? AND t.completion_seq<=?
    AND COALESCE(json_extract(m.metadata,'$.scheduledJobId'),'')=''`).get(workspaceId,ownerUserId,ownerUserId,process.env.MICHI_CLOUD??'',after,through) as {n:number};
  return row.n;
}

export interface CreateMaintenanceConfigInput {
  workspaceId: string; ownerUserId: string; jobId: string; now: number;
  enabled?: boolean; paused?: boolean;
}

/**
 * Creates the one workspace consumer, starting at the current counter unless an explicit bounded catch-up is requested later.
 * Its runtime columns stay null: every run resolves the Meta agent settings when it starts.
 */
export function createMaintenanceConfig(input: CreateMaintenanceConfigInput): MaintenanceConfig {
  const now = nowValue(input.now);
  idValue(input.workspaceId, 'workspace'); idValue(input.ownerUserId, 'owner'); idValue(input.jobId, 'job');
  return runInTransaction(() => {
    const workspace = requirePagesWorkspace(input.workspaceId, input.ownerUserId, true);
    if (!workspaceOwnerMatches(workspace.owner_user_id,input.ownerUserId)) throw new PageWriteError(404, 'not_found', 'Workspace not found');
    const job = db().prepare('SELECT workspace_id,owner_user_id FROM scheduled_jobs WHERE id=?').get(input.jobId) as { workspace_id: string; owner_user_id: string | null } | undefined;
    if (!job || job.workspace_id !== input.workspaceId || (job.owner_user_id !== input.ownerUserId && !(job.owner_user_id===null&&input.ownerUserId==='local-user'&&process.env.MICHI_CLOUD!=='1'))) throw new PageWriteError(404, 'not_found', 'Maintenance job not found');
    db().prepare(`INSERT INTO page_maintenance_configs
      (workspace_id,owner_user_id,job_id,enabled,paused,revision,completion_cursor,runtime_id,provider_id,model_id,reasoning,updated_at)
      VALUES(?,?,?,?,?,1,?,NULL,NULL,NULL,NULL,?)`).run(input.workspaceId, input.ownerUserId, input.jobId, input.enabled ? 1 : 0,
      input.paused ? 1 : 0, counter(input.workspaceId), now);
    return getMaintenanceConfig(input.workspaceId, input.ownerUserId)!;
  });
}

export function getMaintenanceConfig(workspaceId: string, ownerUserId: string): MaintenanceConfig | null {
  const row = db().prepare('SELECT * FROM page_maintenance_configs WHERE workspace_id=? AND owner_user_id=?').get(workspaceId, ownerUserId) as ConfigRow | undefined;
  return row ? configDto(row) : null;
}

export interface UpdateMaintenanceConfigInput {
  workspaceId: string; ownerUserId: string; expectedRevision: number; now: number;
  enabled?: boolean; paused?: boolean;
}
/** A pause preserves the live cursor. Re-enabling never resets it to now. */
export function updateMaintenanceConfig(input: UpdateMaintenanceConfigInput): MaintenanceConfig {
  const now = nowValue(input.now);
  return runInTransaction(() => {
    const current = getMaintenanceConfig(input.workspaceId, input.ownerUserId);
    if (!current) throw new PageWriteError(404, 'not_found', 'Maintenance config not found');
    if (current.revision !== input.expectedRevision) throw new PageMaintenanceConflictError('Maintenance config changed');
    requirePagesWorkspace(input.workspaceId, input.ownerUserId, true);
    const next = { ...current, ...Object.fromEntries(['enabled','paused']
      .filter(key => Object.hasOwn(input, key) && input[key as keyof UpdateMaintenanceConfigInput] !== undefined)
      .map(key => [key, input[key as keyof UpdateMaintenanceConfigInput]])) } as MaintenanceConfig;
    db().prepare(`UPDATE page_maintenance_configs SET enabled=?,paused=?,revision=revision+1,runtime_id=NULL,provider_id=NULL,model_id=NULL,reasoning=NULL,updated_at=?
      WHERE workspace_id=? AND owner_user_id=? AND revision=?`).run(next.enabled ? 1 : 0, next.paused ? 1 : 0,
      now, input.workspaceId, input.ownerUserId, input.expectedRevision);
    const changed = db().prepare('SELECT changes() AS n').get() as { n: number };
    if (changed.n !== 1) throw new PageMaintenanceConflictError('Maintenance config changed');
    return getMaintenanceConfig(input.workspaceId, input.ownerUserId)!;
  });
}

export function setSpaceMaintenanceExcluded(input: { workspaceId: string; ownerUserId: string; spaceId: string; excluded: boolean; expectedRevision: number; now: number }): MaintenanceConfig {
  const now = nowValue(input.now);
  return runInTransaction(() => {
    const current = getMaintenanceConfig(input.workspaceId, input.ownerUserId);
    if (!current) throw new PageWriteError(404, 'not_found', 'Maintenance config not found');
    if (current.revision !== input.expectedRevision) throw new PageMaintenanceConflictError('Maintenance config changed');
    const space = db().prepare('SELECT workspace_id,owner_user_id,parent_id,deleted_at FROM pages WHERE id=?').get(input.spaceId) as
      { workspace_id: string; owner_user_id: string; parent_id: string | null; deleted_at: number | null } | undefined;
    if (!space || space.workspace_id !== input.workspaceId || space.owner_user_id !== input.ownerUserId || space.parent_id !== null || space.deleted_at !== null) {
      throw new PageWriteError(404, 'not_found', 'Space not found');
    }
    const wasExcluded=!!db().prepare('SELECT 1 FROM page_maintenance_exclusions WHERE workspace_id=? AND owner_user_id=? AND space_id=?').get(input.workspaceId,input.ownerUserId,input.spaceId);
    if (input.excluded) {
      db().prepare(`INSERT INTO page_maintenance_exclusions(workspace_id,owner_user_id,space_id,excluded_at)
        VALUES(?,?,?,?) ON CONFLICT(workspace_id,owner_user_id,space_id) DO UPDATE SET excluded_at=excluded_at`).run(input.workspaceId,input.ownerUserId,input.spaceId,now);
      if(!wasExcluded)startSpaceExclusionPeriod(input.workspaceId,input.ownerUserId,input.spaceId,now);
    } else {
      db().prepare('DELETE FROM page_maintenance_exclusions WHERE workspace_id=? AND owner_user_id=? AND space_id=?').run(input.workspaceId,input.ownerUserId,input.spaceId);
      if(wasExcluded)closeSpaceExclusionPeriod(input.workspaceId,input.ownerUserId,input.spaceId,now);
    }
    db().prepare('UPDATE page_maintenance_configs SET revision=revision+1,updated_at=? WHERE workspace_id=? AND owner_user_id=? AND revision=?')
      .run(now,input.workspaceId,input.ownerUserId,input.expectedRevision);
    return getMaintenanceConfig(input.workspaceId,input.ownerUserId)!;
  });
}

/** Persists a new Space's default exclusion before its workspace consumer exists. */
export function setInitialSpaceMaintenanceExcluded(input:{workspaceId:string;ownerUserId:string;spaceId:string;excluded:boolean;now:number}):void {
  const now=nowValue(input.now);
  runInTransaction(()=>{
    const workspace=requirePagesWorkspace(input.workspaceId,input.ownerUserId,true);
    if(!workspaceOwnerMatches(workspace.owner_user_id,input.ownerUserId))throw new PageWriteError(404,'not_found','Workspace not found');
    if(db().prepare('SELECT 1 FROM page_maintenance_configs WHERE workspace_id=? AND owner_user_id=?').get(input.workspaceId,input.ownerUserId))
      throw new PageMaintenanceConflictError('Maintenance config already exists; use revision-checked exclusion updates');
    const space=db().prepare('SELECT workspace_id,owner_user_id,parent_id,deleted_at FROM pages WHERE id=?').get(input.spaceId) as
      {workspace_id:string;owner_user_id:string;parent_id:string|null;deleted_at:number|null}|undefined;
    if(!space||space.workspace_id!==input.workspaceId||space.owner_user_id!==input.ownerUserId||space.parent_id!==null||space.deleted_at!==null)throw new PageWriteError(404,'not_found','Space not found');
    if(input.excluded){
      const inserted=db().prepare(`INSERT INTO page_maintenance_exclusions(workspace_id,owner_user_id,space_id,excluded_at)
        VALUES(?,?,?,?) ON CONFLICT(workspace_id,owner_user_id,space_id) DO NOTHING`).run(input.workspaceId,input.ownerUserId,input.spaceId,now);
      if(Number(inserted.changes)===1)startSpaceExclusionPeriod(input.workspaceId,input.ownerUserId,input.spaceId,now);
    }
    else db().prepare('DELETE FROM page_maintenance_exclusions WHERE workspace_id=? AND owner_user_id=? AND space_id=?').run(input.workspaceId,input.ownerUserId,input.spaceId);
  });
}

function startSpaceExclusionPeriod(workspaceId:string,ownerUserId:string,spaceId:string,now:number):void {
  db().prepare(`INSERT INTO page_maintenance_exclusion_periods(id,workspace_id,owner_user_id,space_id,after_seq,excluded_at)
    VALUES(?,?,?,?,?,?)`).run(`mep-${randomUUID()}`,workspaceId,ownerUserId,spaceId,counter(workspaceId),now);
}
function closeSpaceExclusionPeriod(workspaceId:string,ownerUserId:string,spaceId:string,now:number):void {
  db().prepare(`UPDATE page_maintenance_exclusion_periods SET through_seq=?,reenabled_at=?
    WHERE workspace_id=? AND owner_user_id=? AND space_id=? AND through_seq IS NULL`)
    .run(counter(workspaceId),now,workspaceId,ownerUserId,spaceId);
}

export function listMaintenanceExcludedSpaces(workspaceId:string,ownerUserId:string):string[] {
  return (db().prepare('SELECT space_id FROM page_maintenance_exclusions WHERE workspace_id=? AND owner_user_id=? ORDER BY space_id')
    .all(workspaceId,ownerUserId) as unknown as Array<{space_id:string}>).map(row=>row.space_id);
}

export interface MaintenanceManifest {
  pages: Array<{ id: string; parentId: string | null; title: string; revision: number; viewVersion: number }>;
  /** `role: 'tasks'` marks the workspace's task database. */
  databases: Array<{ id: string; title: string; revision: number; pageIds: string[]; role?: 'tasks' }>;
  resources: MaintenanceResourceRef[];
  pageCursor: string | null;
}
/**
 * Full active manifest for routing; the upper bound is the native workspace page limit, not the feed's 20-turn page size.
 * A database is a candidate while every page showing it is. The workspace's task database always is, routed with the
 * eligible pages that show a task board (none is fine): its tasks belong to the workspace, not to those pages.
 */
export function listEligibleMaintenanceManifest(workspaceId: string, ownerUserId: string): MaintenanceManifest {
  requirePagesWorkspace(workspaceId, ownerUserId);
  const exclusions = db().prepare('SELECT space_id FROM page_maintenance_exclusions WHERE workspace_id=? AND owner_user_id=?').all(workspaceId,ownerUserId) as unknown as Array<{space_id:string}>;
  const excluded = exclusions.map(x => x.space_id);
  const rows = db().prepare(`WITH RECURSIVE hidden(id) AS (
      SELECT id FROM pages WHERE 0
      ${excluded.length ? `UNION SELECT id FROM pages WHERE id IN (${excluded.map(()=>'?').join(',')})
        UNION ALL SELECT p.id FROM pages p JOIN hidden h ON p.parent_id=h.id WHERE p.deleted_at IS NULL` : ''}
    ) SELECT id,parent_id,title,revision,view_version FROM pages
      WHERE workspace_id=? AND owner_user_id=? AND deleted_at IS NULL AND id NOT IN (SELECT id FROM hidden)
        AND NOT EXISTS (SELECT 1 FROM home_customization h WHERE h.owner_user_id=pages.owner_user_id AND json_extract(h.preferences,'$.pageId')=pages.id)
      ORDER BY position,id LIMIT 2001`).all(...excluded,workspaceId,ownerUserId) as unknown as Array<{id:string;parent_id:string|null;title:string;revision:number;view_version:number}>;
  if (rows.length > 2000) throw new PageWriteError(409,'invalid','Maintenance manifest exceeds the native page limit');
  const pageIds=rows.map(r=>r.id);
  const dbRows=pageIds.length ? db().prepare(`SELECT d.id,d.title,d.revision,r.page_id FROM page_databases d
      JOIN page_database_refs r ON r.database_id=d.id JOIN pages p ON p.id=r.page_id
      WHERE d.workspace_id=? AND d.owner_user_id=? AND d.deleted_at IS NULL AND d.role IS NULL AND p.deleted_at IS NULL
      ORDER BY d.created_at,d.id,r.page_id`).all(workspaceId,ownerUserId) as unknown as Array<{id:string;title:string;revision:number;page_id:string}> : [];
  const databases = new Map<string,{id:string;title:string;revision:number;pageIds:string[]}>();
  for(const row of dbRows){const item=databases.get(row.id)??{id:row.id,title:row.title,revision:row.revision,pageIds:[]};item.pageIds.push(row.page_id);databases.set(row.id,item);}
  const pages=rows.map(r=>({id:r.id,parentId:r.parent_id,title:r.title,revision:r.revision,viewVersion:r.view_version}));
  const eligiblePages=new Set(pageIds);
  const databaseList:MaintenanceManifest['databases']=[...databases.values()].filter(database=>database.pageIds.length>0&&database.pageIds.every(pageId=>eligiblePages.has(pageId)));
  const tasks=db().prepare("SELECT id,title,revision FROM page_databases WHERE workspace_id=? AND owner_user_id=? AND role='tasks' AND deleted_at IS NULL")
    .get(workspaceId,ownerUserId) as {id:string;title:string;revision:number}|undefined;
  if(tasks){
    const boards=(db().prepare('SELECT r.page_id FROM page_database_refs r JOIN pages p ON p.id=r.page_id WHERE r.database_id=? AND p.deleted_at IS NULL ORDER BY r.page_id')
      .all(tasks.id) as unknown as Array<{page_id:string}>).map(row=>row.page_id).filter(pageId=>eligiblePages.has(pageId));
    databaseList.push({id:tasks.id,title:tasks.title,revision:tasks.revision,pageIds:boards,role:'tasks'});
  }
  return { pages, databases:databaseList, resources:[
    ...pages.map(p=>({kind:'page' as const,id:p.id,revision:p.revision,pageIds:[p.id]})),
    ...databaseList.map(d=>({kind:'database' as const,id:d.id,revision:d.revision,pageIds:d.pageIds})),
  ], pageCursor:null };
}

export function listEligibleMaintenanceManifestForSpace(workspaceId:string,ownerUserId:string,spaceId:string):MaintenanceManifest {
  const manifest=listEligibleMaintenanceManifest(workspaceId,ownerUserId);
  const root=manifest.pages.find(page=>page.id===spaceId&&page.parentId===null);
  if(!root)throw new PageWriteError(409,'invalid','Selected Space must be active and enabled for maintenance');
  const descendants=db().prepare(`WITH RECURSIVE subtree(id) AS (
      SELECT id FROM pages WHERE id=? AND workspace_id=? AND owner_user_id=? AND deleted_at IS NULL
      UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id=s.id WHERE p.deleted_at IS NULL
    ) SELECT id FROM subtree`).all(spaceId,workspaceId,ownerUserId) as unknown as Array<{id:string}>;
  const pageSet=new Set(descendants.map(row=>row.id).filter(id=>manifest.pages.some(page=>page.id===id)));
  const pages=manifest.pages.filter(page=>pageSet.has(page.id));
  // A Space catch-up revisits a period the regular feed already read for the workspace's tasks.
  const databases=manifest.databases.filter(database=>!database.role&&database.pageIds.length>0&&database.pageIds.every(id=>pageSet.has(id)));
  const resources:MaintenanceResourceRef[]=[
    ...pages.map(page=>({kind:'page' as const,id:page.id,revision:page.revision,pageIds:[page.id]})),
    ...databases.map(database=>({kind:'database' as const,id:database.id,revision:database.revision,pageIds:[...database.pageIds]})),
  ];
  return {pages,databases,resources,pageCursor:null};
}

export interface CreateMaintenancePlanInput {
  workspaceId: string; ownerUserId: string; jobId: string; runId: string; claimedBy: string;
  configRevision: number; after: number; through: number; now: number;
  scopeSpaceId?: string | null;
  reconsiderOfPlanId?: string | null;
  reconsiderSourceTurnIds?: string[];
  historicalCatchup?: boolean;
}
/** Creates an immutable source set from currently readable completed feed rows. */
export function createMaintenancePlan(input: CreateMaintenancePlanInput): MaintenancePlan {
  const now=nowValue(input.now);
  if(!Number.isSafeInteger(input.after)||!Number.isSafeInteger(input.through)||input.after<0||input.through<input.after) throw new PageWriteError(400,'invalid','Invalid maintenance interval');
  return runInTransaction(()=>createMaintenancePlanInTransaction(input,now));
}
function createMaintenancePlanInTransaction(input:CreateMaintenancePlanInput,now:number):MaintenancePlan {
    assertMaintenanceAuthority(input,now);
    const existing=db().prepare('SELECT id,after_seq,through_seq,scope_space_id,reconsider_of_plan_id FROM page_maintenance_plans WHERE job_id=? AND run_id=?').get(input.jobId,input.runId) as
      {id:string;after_seq:number;through_seq:number;scope_space_id:string|null;reconsider_of_plan_id:string|null}|undefined;
    if(existing){
      if(existing.after_seq!==input.after||existing.through_seq!==input.through||(existing.scope_space_id??null)!==(input.scopeSpaceId??null)||existing.reconsider_of_plan_id!==(input.reconsiderOfPlanId??null))
        throw new PageMaintenanceConflictError('Scheduler run already owns a different maintenance plan');
      return getMaintenancePlan(existing.id,input.ownerUserId)!;
    }
    const current=counter(input.workspaceId);
    if(input.through>current)throw new PageMaintenanceConflictError('Maintenance interval is beyond the current counter');
    const config=getMaintenanceConfig(input.workspaceId,input.ownerUserId)!;
    const reconsider=!!input.reconsiderOfPlanId;
    if(!reconsider && input.after!==config.completionCursor && !input.historicalCatchup) throw new PageMaintenanceConflictError('Maintenance cursor changed');
    if(!reconsider && input.historicalCatchup && input.through-input.after>1000) throw new PageWriteError(400,'invalid','Historical catch-up is limited to 1000 completion positions');
    if(input.reconsiderSourceTurnIds && (!reconsider||!input.reconsiderSourceTurnIds.length||input.reconsiderSourceTurnIds.length>100)) throw new PageWriteError(400,'invalid','Invalid reconsider source set');
    const sourceIds=input.reconsiderSourceTurnIds??[];
    const sourceFilter=sourceIds.length ? `AND t.turn_id IN (${sourceIds.map(()=>'?').join(',')})` : '';
    const sourceRows=db().prepare(`SELECT t.turn_id,t.node_id,t.user_message_id,t.assistant_message_id,t.completion_seq FROM turns t
      JOIN nodes n ON n.id=t.node_id JOIN workspaces w ON w.id=n.workspace_id LEFT JOIN trees tr ON tr.id=n.tree_id
      WHERE n.workspace_id=? AND w.deleted_at IS NULL AND w.purged_at IS NULL
        AND (w.owner_user_id=? OR (?='local-user' AND ?<>'1')) AND n.kind='chat'
        AND n.purged_at IS NULL AND n.deleted_at IS NULL AND n.status<>'archived' AND tr.archived_at IS NULL
        AND t.status='completed' AND t.user_message_id IS NOT NULL AND t.completion_seq>? AND t.completion_seq<=?
        ${sourceFilter}
        AND COALESCE(json_extract((SELECT metadata FROM messages WHERE id=t.user_message_id),'$.scheduledJobId'),'')=''
      ORDER BY t.completion_seq`).all(input.workspaceId,input.ownerUserId,input.ownerUserId,process.env.MICHI_CLOUD??'',input.after,input.through,...sourceIds) as unknown as Array<{turn_id:string;node_id:string;user_message_id:string;assistant_message_id:string;completion_seq:number}>;
    const id=`mpl-${randomUUID()}`;
    const generationRow=db().prepare('SELECT COALESCE(MAX(generation),0)+1 AS n FROM page_maintenance_plans WHERE job_id=?').get(input.jobId) as {n:number};
    const eligible=(input.scopeSpaceId?listEligibleMaintenanceManifestForSpace(input.workspaceId,input.ownerUserId,input.scopeSpaceId):listEligibleMaintenanceManifest(input.workspaceId,input.ownerUserId)).resources;
    const manifest=backgroundMaintenanceResources(input.workspaceId,input.ownerUserId,eligible);
    db().prepare(`INSERT INTO page_maintenance_plans(id,workspace_id,owner_user_id,job_id,run_id,config_revision,generation,scope_space_id,reconsider_of_plan_id,after_seq,through_seq,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,?,?)`).run(id,input.workspaceId,input.ownerUserId,input.jobId,input.runId,input.configRevision,generationRow.n,input.scopeSpaceId??null,input.reconsiderOfPlanId??null,input.after,input.through,sourceRows.length?'routing':'terminal',now,now);
    const insert=db().prepare(`INSERT INTO page_maintenance_sources(plan_id,source_turn_id,completion_seq,evidence_json,manifest_json,state,updated_at) VALUES(?,?,?,?,?,'routing',?)`);
    for(const row of sourceRows){
      insert.run(id,row.turn_id,row.completion_seq,json({nodeId:row.node_id,turnId:row.turn_id,assistantId:row.assistant_message_id}),json(manifest),now);
      registerMaintenanceSourceMessages(id,row.turn_id,[row.user_message_id,row.assistant_message_id]);
    }
    return getMaintenancePlan(id,input.ownerUserId)!;
}

export interface AuthorityInput { workspaceId:string;ownerUserId:string;jobId:string;runId:string;claimedBy:string;configRevision:number }
/** Call inside the caller's write transaction immediately before committing any maintenance mutation. */
export function assertMaintenanceAuthority(input: AuthorityInput, now: number): void {
  const row=db().prepare(`SELECT c.revision,c.enabled,c.paused,c.job_id,c.workspace_id,c.owner_user_id,
      r.status,r.claimed_by,r.attention,r.node_id AS run_node_id,r.turn_id AS run_turn_id,
      j.workspace_id AS job_workspace,j.owner_user_id AS job_owner,j.enabled AS job_enabled,j.auto_paused,
      l.holder,l.expires_at,x.run_id AS execution_claim FROM page_maintenance_configs c JOIN scheduled_jobs j ON j.id=c.job_id
      JOIN scheduled_job_runs r ON r.id=? AND r.job_id=j.id JOIN scheduler_lease l ON l.id=1
      LEFT JOIN scheduler_execution_claims x ON x.run_id=r.id AND x.holder=l.holder AND x.generation=l.generation
      WHERE c.workspace_id=? AND c.owner_user_id=? AND c.job_id=?`).get(input.runId,input.workspaceId,input.ownerUserId,input.jobId) as
    {revision:number;enabled:number;paused:number;job_id:string;workspace_id:string;owner_user_id:string;status:string;claimed_by:string;attention:string|null;
     run_node_id:string|null;run_turn_id:string|null;job_workspace:string;job_owner:string|null;job_enabled:number;auto_paused:number;holder:string;expires_at:number;execution_claim:string|null}|undefined;
  const ownerOk=row?.job_owner===input.ownerUserId||(row?.job_owner===null&&input.ownerUserId==='local-user'&&process.env.MICHI_CLOUD!=='1');
  if(!row||row.job_workspace!==input.workspaceId||!ownerOk) throw new PageWriteError(404,'not_found','Maintenance authority not found');
  if(!row.execution_claim||row.revision!==input.configRevision||row.enabled!==1||row.paused===1||row.job_enabled!==1||row.auto_paused===1||row.status!=='running'||row.attention!==null||row.claimed_by!==input.claimedBy||row.holder!==input.claimedBy||row.expires_at<=now)
    throw new PageMaintenanceConflictError('Maintenance run authority expired or changed');
}

export function getMaintenancePlan(planId:string,ownerUserId:string):MaintenancePlan|null {
  const row=db().prepare('SELECT * FROM page_maintenance_plans WHERE id=? AND owner_user_id=?').get(planId,ownerUserId) as any;
  if(!row)return null;
  const sources=db().prepare('SELECT * FROM page_maintenance_sources WHERE plan_id=? ORDER BY completion_seq').all(planId) as unknown as Array<any>;
  return {id:row.id,workspaceId:row.workspace_id,ownerUserId:row.owner_user_id,jobId:row.job_id,runId:row.run_id,
    configRevision:row.config_revision,generation:row.generation,scopeSpaceId:row.scope_space_id??null,reconsiderOfPlanId:row.reconsider_of_plan_id,after:row.after_seq,through:row.through_seq,state:row.state,
    sources:sources.map((s):MaintenanceSourcePlan=>({sourceTurnId:s.source_turn_id,completionSeq:s.completion_seq,evidence:parse(s.evidence_json),
      state:s.state,routingComplete:s.routing_complete===1,manifest:parse(s.manifest_json),messages:listMaintenanceSourceMessageDescriptors(planId,s.source_turn_id),candidates:parse(s.candidates_json),terminalReason:s.terminal_reason})),createdAt:row.created_at,updatedAt:row.updated_at};
}

const SOURCE_PART_BYTES = 16 * 1024;
const SOURCE_READ_MAX_PARTS = 8;
function sourceChunks(content: string): Array<{start:number;end:number;bytes:Buffer;hash:string}> {
  const bytes=Buffer.from(content,'utf8');
  const ranges:Array<{start:number;end:number}> = [];
  if(bytes.length===0) ranges.push({start:0,end:0});
  else {
    let start=0, end=0;
    for(const char of content){
      const size=Buffer.byteLength(char,'utf8');
      if(end>start&&end-start+size>SOURCE_PART_BYTES){ranges.push({start,end});start=end;}
      end+=size;
    }
    if(end>start)ranges.push({start,end});
  }
  return ranges.map(({start,end})=>{const part=bytes.subarray(start,end);return {start,end,bytes:part,hash:createHash('sha256').update(part).digest('hex')};});
}
function registerMaintenanceSourceMessages(planId:string,sourceTurnId:string,messageIds:string[]):void {
  const rows=db().prepare(`SELECT m.id,m.role,m.content FROM messages m WHERE m.id IN (${messageIds.map(()=>'?').join(',')})`).all(...messageIds) as unknown as Array<{id:string;role:string;content:string}>;
  if(rows.length!==messageIds.length)throw new PageWriteError(409,'invalid','Maintenance source messages are unavailable');
  const insertMessage=db().prepare(`INSERT INTO page_maintenance_source_messages(plan_id,source_turn_id,message_id,role,byte_length,content_hash,part_count)
    VALUES(?,?,?,?,?,?,?)`);
  const insertPart=db().prepare(`INSERT INTO page_maintenance_source_parts(plan_id,source_turn_id,message_id,part_index,byte_start,byte_end,part_hash,offered_at)
    VALUES(?,?,?,?,?,?,?,0)`);
  for(const id of messageIds){
    const row=rows.find(item=>item.id===id)!;
    if(row.role!=='user'&&row.role!=='assistant')throw new PageWriteError(409,'invalid','Maintenance source message role is invalid');
    const bytes=Buffer.from(row.content,'utf8'), chunks=sourceChunks(row.content);
    insertMessage.run(planId,sourceTurnId,id,row.role,bytes.length,createHash('sha256').update(bytes).digest('hex'),chunks.length);
    chunks.forEach((part,index)=>insertPart.run(planId,sourceTurnId,id,index,part.start,part.end,part.hash));
  }
}
export function listMaintenanceSourceMessageDescriptors(planId:string,sourceTurnId:string):MaintenanceSourceMessageDescriptor[] {
  return db().prepare(`SELECT message_id,role,byte_length,content_hash,part_count FROM page_maintenance_source_messages
    WHERE plan_id=? AND source_turn_id=? ORDER BY CASE role WHEN 'user' THEN 0 ELSE 1 END,message_id`).all(planId,sourceTurnId)
    .map((row:any)=>({messageId:row.message_id,role:row.role,byteLength:row.byte_length,contentHash:row.content_hash,partCount:row.part_count}));
}
function messageIdFor(planId:string,sourceTurnId:string,role:'user'|'assistant'):string|null {
  const row=db().prepare(`SELECT message_id FROM page_maintenance_source_messages WHERE plan_id=? AND source_turn_id=? AND role=?`)
    .get(planId,sourceTurnId,role) as {message_id:string}|undefined;
  return row?.message_id??null;
}
export interface ReadMaintenanceSourceMessagesInput {
  planId:string;ownerUserId:string;sourceTurnId:string;afterMessageId?:string|null;afterPartIndex?:number;maxParts?:number;
  acknowledgeParts?:Array<{partId:string;partHash:string}>;now:number;
}
export interface ReadMaintenanceSourceMessagesResult {
  parts:MaintenanceSourcePart[];next:{messageId:string;partIndex:number}|null;coverageComplete:boolean;
}
/** Offers deterministic UTF-8-safe parts. Call again with acknowledged partIds to confirm prior delivery and advance safely. */
export function readMaintenanceSourceMessages(input:ReadMaintenanceSourceMessagesInput):ReadMaintenanceSourceMessagesResult {
  const now=nowValue(input.now), limit=input.maxParts??SOURCE_READ_MAX_PARTS;
  if(!Number.isSafeInteger(limit)||limit<1||limit>SOURCE_READ_MAX_PARTS)throw new PageWriteError(400,'invalid',`Source reads are limited to ${SOURCE_READ_MAX_PARTS} parts`);
  if(input.afterPartIndex!==undefined&&(!Number.isSafeInteger(input.afterPartIndex)||input.afterPartIndex<0))throw new PageWriteError(400,'invalid','Invalid source cursor');
  const acknowledgements=input.acknowledgeParts??[];
  const ackIds=[...new Set(acknowledgements.map(x=>x.partId))];
  if(ackIds.length>100||ackIds.some(x=>typeof x!=='string'||x.length>220)||ackIds.length!==acknowledgements.length||acknowledgements.some(x=>typeof x.partHash!=='string'||!/^[a-f0-9]{64}$/.test(x.partHash)))throw new PageWriteError(400,'invalid','Invalid source part acknowledgements');
  return runInTransaction(()=>{
    const plan=db().prepare(`SELECT workspace_id FROM page_maintenance_plans WHERE id=? AND owner_user_id=?`).get(input.planId,input.ownerUserId) as {workspace_id:string}|undefined;
    if(!plan)throw new PageWriteError(404,'not_found','Maintenance plan not found');
    const source=db().prepare(`SELECT s.evidence_json,t.node_id,t.user_message_id,t.assistant_message_id,t.status FROM page_maintenance_sources s
      JOIN turns t ON t.turn_id=s.source_turn_id WHERE s.plan_id=? AND s.source_turn_id=?`).get(input.planId,input.sourceTurnId) as
      {evidence_json:string;node_id:string;user_message_id:string;assistant_message_id:string;status:string}|undefined;
    if(!source)throw new PageWriteError(404,'not_found','Source turn is not in this plan');
    const evidence=parse<BlockSource>(source.evidence_json);
    if(source.status!=='completed'||source.node_id!==evidence.nodeId||source.user_message_id!==messageIdFor(input.planId,input.sourceTurnId,'user')||source.assistant_message_id!==messageIdFor(input.planId,input.sourceTurnId,'assistant'))
      throw new PageMaintenanceConflictError('Source turn provenance changed');
    for(const partId of ackIds){
      const split=partId.lastIndexOf(':');
      const messageId=partId.slice(0,split), partIndex=Number(partId.slice(split+1));
      const part=db().prepare(`SELECT offered_at,acknowledged_at,part_hash FROM page_maintenance_source_parts WHERE plan_id=? AND source_turn_id=? AND message_id=? AND part_index=?`)
        .get(input.planId,input.sourceTurnId,messageId,partIndex) as {offered_at:number;acknowledged_at:number|null;part_hash:string}|undefined;
      if(!part||part.offered_at<=0||part.part_hash!==acknowledgements.find(x=>x.partId===partId)?.partHash)throw new PageWriteError(409,'invalid','Cannot acknowledge an unoffered or changed source part');
      db().prepare(`UPDATE page_maintenance_source_parts SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE plan_id=? AND source_turn_id=? AND message_id=? AND part_index=?`)
        .run(now,input.planId,input.sourceTurnId,messageId,partIndex);
    }
    const messageRows=db().prepare(`SELECT message_id,role,byte_length,content_hash,part_count FROM page_maintenance_source_messages
      WHERE plan_id=? AND source_turn_id=? ORDER BY CASE role WHEN 'user' THEN 0 ELSE 1 END,message_id`).all(input.planId,input.sourceTurnId) as unknown as Array<any>;
    if(!messageRows.length)throw new PageWriteError(409,'invalid','Source message snapshot is missing');
    const flat:Array<{message:any;part:any}> = [];
    for(const message of messageRows){
      const content=db().prepare('SELECT node_id,role,content FROM messages WHERE id=?').get(message.message_id) as {node_id:string;role:string;content:string}|undefined;
      if(!content)throw new PageWriteError(409,'invalid','A frozen source message is no longer readable');
      if(content.node_id!==evidence.nodeId||content.role!==message.role)throw new PageMaintenanceConflictError('A frozen source message changed provenance');
      const bytes=Buffer.from(content.content,'utf8');
      if(bytes.length!==message.byte_length||createHash('sha256').update(bytes).digest('hex')!==message.content_hash)throw new PageMaintenanceConflictError('A frozen source message changed');
      const chunks=sourceChunks(content.content);
      if(chunks.length!==message.part_count)throw new PageMaintenanceConflictError('A frozen source part map changed');
      const saved=db().prepare(`SELECT part_index,byte_start,byte_end,part_hash,offered_at,acknowledged_at FROM page_maintenance_source_parts
        WHERE plan_id=? AND source_turn_id=? AND message_id=? ORDER BY part_index`).all(input.planId,input.sourceTurnId,message.message_id) as unknown as Array<any>;
      if(saved.length!==chunks.length)throw new PageMaintenanceConflictError('A frozen source part map is incomplete');
      chunks.forEach((chunk,index)=>{
        const part=saved[index];
        if(part.part_index!==index||part.byte_start!==chunk.start||part.byte_end!==chunk.end||part.part_hash!==chunk.hash)throw new PageMaintenanceConflictError('A frozen source part changed');
        flat.push({message,part:{...part,content:chunk.bytes.toString('utf8')}});
      });
    }
    let start=0;
    if(input.afterMessageId){start=flat.findIndex(x=>x.message.message_id===input.afterMessageId&&x.part.part_index===(input.afterPartIndex??0));if(start<0)throw new PageWriteError(400,'invalid','Unknown source cursor');start++;}
    const pending=flat.slice(start).slice(0,limit);
    for(const item of pending)db().prepare(`UPDATE page_maintenance_source_parts SET offered_at=CASE WHEN offered_at=0 THEN ? ELSE offered_at END
      WHERE plan_id=? AND source_turn_id=? AND message_id=? AND part_index=?`).run(now,input.planId,input.sourceTurnId,item.message.message_id,item.part.part_index);
    const parts:MaintenanceSourcePart[]=pending.map(item=>({partId:`${item.message.message_id}:${item.part.part_index}`,sourceTurnId:input.sourceTurnId,
      messageId:item.message.message_id,role:item.message.role,partIndex:item.part.part_index,partCount:item.message.part_count,
      byteStart:item.part.byte_start,byteEnd:item.part.byte_end,content:item.part.content,partHash:item.part.part_hash,acknowledged:item.part.acknowledged_at!==null}));
    const hasMore=start+pending.length<flat.length;
    const last=pending[pending.length-1];
    const next=hasMore&&last?{messageId:last.message.message_id,partIndex:last.part.part_index}:null;
    const coverageComplete=flat.every(item=>item.part.acknowledged_at!==null);
    return {parts,next,coverageComplete};
  });
}
export function assertMaintenanceSourceCoverageComplete(planId:string,ownerUserId:string,sourceTurnId:string):void {
  const row=db().prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN acknowledged_at IS NOT NULL THEN 1 ELSE 0 END) AS acknowledged
    FROM page_maintenance_source_parts WHERE plan_id=? AND source_turn_id=?`).get(planId,sourceTurnId) as {total:number;acknowledged:number|null};
  if(row.total===0||row.acknowledged!==row.total)throw new PageMaintenanceConflictError('Source message coverage is incomplete');
  const expected=db().prepare(`SELECT COUNT(*) AS n FROM page_maintenance_source_messages WHERE plan_id=? AND source_turn_id=?`).get(planId,sourceTurnId) as {n:number};
  if(expected.n!==2)throw new PageMaintenanceConflictError('Source message snapshot is incomplete');
  const source=db().prepare(`SELECT s.evidence_json,t.node_id,t.user_message_id,t.assistant_message_id,t.status FROM page_maintenance_sources s
    JOIN page_maintenance_plans p ON p.id=s.plan_id JOIN turns t ON t.turn_id=s.source_turn_id
    WHERE s.plan_id=? AND s.source_turn_id=? AND p.owner_user_id=?`).get(planId,sourceTurnId,ownerUserId) as
    {evidence_json:string;node_id:string;user_message_id:string;assistant_message_id:string;status:string}|undefined;
  if(!source)throw new PageWriteError(404,'not_found','Source turn is not in this plan');
  const evidence=parse<BlockSource>(source.evidence_json);
  if(source.status!=='completed'||source.node_id!==evidence.nodeId||source.user_message_id!==messageIdFor(planId,sourceTurnId,'user')||source.assistant_message_id!==messageIdFor(planId,sourceTurnId,'assistant'))
    throw new PageMaintenanceConflictError('Source turn provenance changed');
  for(const message of db().prepare(`SELECT message_id,role,byte_length,content_hash FROM page_maintenance_source_messages WHERE plan_id=? AND source_turn_id=?`).all(planId,sourceTurnId) as unknown as Array<any>){
    const current=db().prepare('SELECT node_id,role,content FROM messages WHERE id=?').get(message.message_id) as {node_id:string;role:string;content:string}|undefined;
    if(!current||current.node_id!==evidence.nodeId||current.role!==message.role)throw new PageMaintenanceConflictError('Source message provenance changed');
    const bytes=Buffer.from(current.content,'utf8');
    if(bytes.length!==message.byte_length||createHash('sha256').update(bytes).digest('hex')!==message.content_hash)throw new PageMaintenanceConflictError('Source message content changed');
    const expectedParts=sourceChunks(current.content);
    const savedParts=db().prepare(`SELECT part_index,byte_start,byte_end,part_hash,acknowledged_at FROM page_maintenance_source_parts
      WHERE plan_id=? AND source_turn_id=? AND message_id=? ORDER BY part_index`).all(planId,sourceTurnId,message.message_id) as unknown as Array<any>;
    if(savedParts.length!==expectedParts.length||savedParts.some((part,index)=>part.part_index!==index||part.byte_start!==expectedParts[index]!.start||part.byte_end!==expectedParts[index]!.end||part.part_hash!==expectedParts[index]!.hash||part.acknowledged_at===null))
      throw new PageMaintenanceConflictError('Source part coverage changed');
  }
}

/** A reconsideration is an explicit new generation linked to the old immutable plan. */
export function reconsiderMaintenanceSource(input: AuthorityInput & {previousPlanId:string;sourceTurnIds:string[];now:number}):MaintenancePlan {
  const prior=getMaintenancePlan(input.previousPlanId,input.ownerUserId);
  if(!prior||prior.workspaceId!==input.workspaceId||prior.jobId!==input.jobId)throw new PageWriteError(404,'not_found','Maintenance source plan not found');
  const wanted=[...new Set(input.sourceTurnIds)];
  if(!wanted.length||wanted.length>100||wanted.some(id=>!prior.sources.some(s=>s.sourceTurnId===id)))throw new PageWriteError(400,'invalid','Invalid reconsider source set');
  const selected=prior.sources.filter(s=>wanted.includes(s.sourceTurnId));
  return createMaintenancePlan({...input,
    after:Math.min(...selected.map(s=>s.completionSeq))-1,through:Math.max(...selected.map(s=>s.completionSeq)),
    reconsiderOfPlanId:prior.id,reconsiderSourceTurnIds:wanted});
}

export function queueMaintenanceReconsider(input:{workspaceId:string;ownerUserId:string;previousPlanId:string;sourceTurnIds:string[];expectedConfigRevision:number;now:number}):{requestId:string;queued:true} {
  const now=nowValue(input.now), wanted=[...new Set(input.sourceTurnIds)];
  if(!wanted.length||wanted.length>100)throw new PageWriteError(400,'invalid','Select between 1 and 100 source turns');
  return runInTransaction(()=>{
    const config=getMaintenanceConfig(input.workspaceId,input.ownerUserId);
    if(!config||config.revision!==input.expectedConfigRevision)throw new PageMaintenanceConflictError('Maintenance config changed');
    const previous=getMaintenancePlan(input.previousPlanId,input.ownerUserId);
    if(!previous||previous.workspaceId!==input.workspaceId||previous.jobId!==config.jobId)throw new PageWriteError(404,'not_found','Maintenance source plan not found');
    if(wanted.some(id=>!previous.sources.some(s=>s.sourceTurnId===id)))throw new PageWriteError(400,'invalid','Reconsideration contains a source outside the selected plan');
    const requestId=`mrr-${randomUUID()}`;
    db().prepare(`INSERT INTO page_maintenance_reconsider_requests(id,workspace_id,owner_user_id,previous_plan_id,source_turn_ids_json,config_revision,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'queued',?,?)`).run(requestId,input.workspaceId,input.ownerUserId,previous.id,json(wanted),config.revision,now,now);
    return {requestId,queued:true as const};
  });
}
export interface QueuedMaintenanceReconsideration {requestId:string;previousPlanId:string;sourceTurnIds:string[];configRevision:number;createdAt:number}
export function listQueuedMaintenanceReconsiderations(workspaceId:string,ownerUserId:string):QueuedMaintenanceReconsideration[] {
  return db().prepare(`SELECT id,previous_plan_id,source_turn_ids_json,config_revision,created_at FROM page_maintenance_reconsider_requests
    WHERE workspace_id=? AND owner_user_id=? AND state='queued' ORDER BY created_at,id`).all(workspaceId,ownerUserId)
    .map((row:any)=>({requestId:row.id,previousPlanId:row.previous_plan_id,sourceTurnIds:parse(row.source_turn_ids_json),configRevision:row.config_revision,createdAt:row.created_at}));
}
export interface QueueMaintenanceCatchupInput {workspaceId:string;ownerUserId:string;spaceId:string;expectedConfigRevision:number;after:number;through:number;now:number}
export function queueMaintenanceCatchup(input:QueueMaintenanceCatchupInput):{requestId:string;spaceId:string;after:number;through:number;queued:true} {
  const now=nowValue(input.now);
  if(!Number.isSafeInteger(input.after)||!Number.isSafeInteger(input.through)||input.after<0||input.through<=input.after||input.through-input.after>1000)
    throw new PageWriteError(400,'invalid','Catch-up must cover between 1 and 1000 completion positions');
  return runInTransaction(()=>{
    const config=getMaintenanceConfig(input.workspaceId,input.ownerUserId);
    if(!config||config.revision!==input.expectedConfigRevision)throw new PageMaintenanceConflictError('Maintenance config changed');
    requirePagesWorkspace(input.workspaceId,input.ownerUserId,true);
    const current=counter(input.workspaceId);
    if(input.after>current||input.through>current)throw new PageMaintenanceConflictError('Catch-up interval is beyond the current completion counter');
    listEligibleMaintenanceManifestForSpace(input.workspaceId,input.ownerUserId,input.spaceId);
    const excludedPeriod=db().prepare(`SELECT 1 FROM page_maintenance_exclusion_periods WHERE workspace_id=? AND owner_user_id=? AND space_id=?
      AND through_seq IS NOT NULL AND after_seq<=? AND through_seq>=? LIMIT 1`).get(input.workspaceId,input.ownerUserId,input.spaceId,input.after,input.through);
    if(!excludedPeriod)throw new PageWriteError(400,'invalid','Catch-up interval must belong to a recorded excluded period for this Space');
    const sourceCount=countEligibleMaintenanceSources(input.workspaceId,input.ownerUserId,input.after,input.through);
    if(sourceCount===0)throw new PageWriteError(400,'invalid','Catch-up interval contains no eligible completed sources');
    if(sourceCount>100)
      throw new PageWriteError(400,'invalid','Catch-up interval contains more than 100 sources; choose a narrower interval');
    const requestId=`mcc-${randomUUID()}`;
    db().prepare(`INSERT INTO page_maintenance_catchup_requests(id,workspace_id,owner_user_id,after_seq,through_seq,space_id,config_revision,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'queued',?,?)`).run(requestId,input.workspaceId,input.ownerUserId,input.after,input.through,input.spaceId,config.revision,now,now);
    return {requestId,spaceId:input.spaceId,after:input.after,through:input.through,queued:true as const};
  });
}
export function listQueuedMaintenanceRequests(workspaceId:string,ownerUserId:string):Array<{kind:'reconsider';requestId:string;createdAt:number}|{kind:'catchup';requestId:string;spaceId:string;after:number;through:number;createdAt:number}> {
  const rows:Array<{kind:'reconsider';requestId:string;createdAt:number}|{kind:'catchup';requestId:string;spaceId:string;after:number;through:number;createdAt:number}> = [
    ...db().prepare(`SELECT id AS request_id,created_at FROM page_maintenance_reconsider_requests WHERE workspace_id=? AND owner_user_id=? AND state='queued'`)
      .all(workspaceId,ownerUserId).map((row:any)=>({kind:'reconsider' as const,requestId:row.request_id,createdAt:row.created_at})),
    ...db().prepare(`SELECT id AS request_id,space_id,after_seq,through_seq,created_at FROM page_maintenance_catchup_requests WHERE workspace_id=? AND owner_user_id=? AND state='queued'`)
      .all(workspaceId,ownerUserId).map((row:any)=>({kind:'catchup' as const,requestId:row.request_id,spaceId:row.space_id,after:row.after_seq,through:row.through_seq,createdAt:row.created_at})),
  ];
  return rows.sort((a,b)=>a.createdAt-b.createdAt||a.requestId.localeCompare(b.requestId));
}
export function listMaintenanceCatchupSuggestions(workspaceId:string,ownerUserId:string,spaceId?:string,maxSuggestions=20):MaintenanceCatchupSuggestion[] {
  if(!Number.isSafeInteger(maxSuggestions)||maxSuggestions<1||maxSuggestions>100)throw new PageWriteError(400,'invalid','Invalid catch-up suggestion limit');
  const eligibleRoots=new Set(listEligibleMaintenanceManifest(workspaceId,ownerUserId).pages.filter(page=>page.parentId===null).map(page=>page.id));
  const periods=db().prepare(`SELECT id,space_id,after_seq,through_seq,excluded_at,reenabled_at FROM page_maintenance_exclusion_periods
    WHERE workspace_id=? AND owner_user_id=? AND through_seq IS NOT NULL ${spaceId?'AND space_id=?':''} ORDER BY excluded_at DESC,id DESC LIMIT 100`)
    .all(...(spaceId?[workspaceId,ownerUserId,spaceId]:[workspaceId,ownerUserId])) as unknown as Array<{id:string;space_id:string;after_seq:number;through_seq:number;excluded_at:number;reenabled_at:number}>;
  const suggestions:MaintenanceCatchupSuggestion[]=[];
  for(const period of periods){
    if(!eligibleRoots.has(period.space_id))continue;
    let after=period.after_seq;
    while(after<period.through_seq&&suggestions.length<maxSuggestions){
      const through=Math.min(period.through_seq,after+100);
      const sources=db().prepare(`SELECT t.turn_id,t.completion_seq,t.completed_at,substr(m.content,1,240) AS preview FROM turns t JOIN nodes n ON n.id=t.node_id
        JOIN workspaces w ON w.id=n.workspace_id JOIN messages m ON m.id=t.user_message_id
        LEFT JOIN trees tr ON tr.id=n.tree_id WHERE n.workspace_id=? AND n.kind='chat' AND n.deleted_at IS NULL AND n.purged_at IS NULL
        AND n.status<>'archived' AND tr.archived_at IS NULL AND w.deleted_at IS NULL AND w.purged_at IS NULL
        AND (w.owner_user_id=? OR (?='local-user' AND ?<>'1')) AND t.status='completed'
        AND t.completion_seq>? AND t.completion_seq<=? AND COALESCE(json_extract(m.metadata,'$.scheduledJobId'),'')=''
        ORDER BY t.completion_seq DESC LIMIT 3`).all(workspaceId,ownerUserId,ownerUserId,process.env.MICHI_CLOUD??'',after,through) as unknown as Array<{turn_id:string;completion_seq:number;completed_at:number;preview:string}>;
      const count=db().prepare(`SELECT COUNT(*) AS n FROM turns t JOIN nodes n ON n.id=t.node_id JOIN workspaces w ON w.id=n.workspace_id
        JOIN messages m ON m.id=t.user_message_id LEFT JOIN trees tr ON tr.id=n.tree_id WHERE n.workspace_id=? AND n.kind='chat'
        AND n.deleted_at IS NULL AND n.purged_at IS NULL AND n.status<>'archived' AND tr.archived_at IS NULL AND w.deleted_at IS NULL AND w.purged_at IS NULL
        AND (w.owner_user_id=? OR (?='local-user' AND ?<>'1')) AND t.status='completed'
        AND t.completion_seq>? AND t.completion_seq<=? AND COALESCE(json_extract(m.metadata,'$.scheduledJobId'),'')=''`).get(workspaceId,ownerUserId,ownerUserId,process.env.MICHI_CLOUD??'',after,through) as {n:number};
      if(count.n===0){after=through;continue;}
      suggestions.push({periodId:period.id,spaceId:period.space_id,after,through,maxPositions:100,availablePositions:through-after,
        excludedAt:period.excluded_at,reenabledAt:period.reenabled_at,sourceCount:count.n,
        latestSources:sources.map(source=>({turnId:source.turn_id,completionSeq:source.completion_seq,completedAt:source.completed_at,preview:source.preview}))});
      after=through;
    }
    if(suggestions.length>=maxSuggestions)break;
  }
  return suggestions;
}
export function claimQueuedMaintenanceCatchup(input:AuthorityInput & {requestId:string;now:number}):MaintenancePlan {
  const now=nowValue(input.now);
  return runInTransaction(()=>{
    assertMaintenanceAuthority(input,now);
    const request=db().prepare(`SELECT * FROM page_maintenance_catchup_requests WHERE id=? AND workspace_id=? AND owner_user_id=?`)
      .get(input.requestId,input.workspaceId,input.ownerUserId) as {after_seq:number;through_seq:number;space_id:string;config_revision:number;state:string;claimed_plan_id:string|null}|undefined;
    if(!request)throw new PageWriteError(404,'not_found','Queued catch-up not found');
    if(request.config_revision!==input.configRevision)throw new PageMaintenanceConflictError('Queued catch-up uses an older config revision');
    if(request.state!=='queued'){
      const claimed=request.claimed_plan_id?getMaintenancePlan(request.claimed_plan_id,input.ownerUserId):null;
      if(claimed?.runId===input.runId)return claimed;
      throw new PageMaintenanceConflictError('Queued catch-up was already consumed');
    }
    const plan=createMaintenancePlanInTransaction({...input,after:request.after_seq,through:request.through_seq,scopeSpaceId:request.space_id,historicalCatchup:true,now},now);
    const changed=db().prepare(`UPDATE page_maintenance_catchup_requests SET state='completed',claimed_plan_id=?,updated_at=? WHERE id=? AND state='queued'`)
      .run(plan.id,now,input.requestId);
    if(Number(changed.changes)!==1){
      const saved=db().prepare('SELECT claimed_plan_id FROM page_maintenance_catchup_requests WHERE id=?').get(input.requestId) as {claimed_plan_id:string|null}|undefined;
      if(saved?.claimed_plan_id!==plan.id)throw new PageMaintenanceConflictError('Queued catch-up was claimed by another run');
    }
    return plan;
  });
}
export function claimQueuedMaintenanceReconsider(input:AuthorityInput & {requestId:string;now:number}):MaintenancePlan {
  const now=nowValue(input.now);
  assertMaintenanceAuthority(input,now);
  const request=db().prepare(`SELECT * FROM page_maintenance_reconsider_requests WHERE id=? AND workspace_id=? AND owner_user_id=? AND state='queued'`)
    .get(input.requestId,input.workspaceId,input.ownerUserId) as {previous_plan_id:string;source_turn_ids_json:string;config_revision:number}|undefined;
  if(!request)throw new PageWriteError(404,'not_found','Queued reconsideration not found');
  if(request.config_revision!==input.configRevision)throw new PageMaintenanceConflictError('Queued reconsideration uses an older config revision');
  const sourceTurnIds=parse<string[]>(request.source_turn_ids_json);
  const existing=db().prepare('SELECT id,reconsider_of_plan_id FROM page_maintenance_plans WHERE job_id=? AND run_id=?').get(input.jobId,input.runId) as {id:string;reconsider_of_plan_id:string|null}|undefined;
  if(existing){
    const existingSources=(getMaintenancePlan(existing.id,input.ownerUserId)?.sources??[]).map(source=>source.sourceTurnId).sort();
    if(existing.reconsider_of_plan_id!==request.previous_plan_id||json(existingSources)!==json([...sourceTurnIds].sort()))throw new PageMaintenanceConflictError('Scheduler run already owns another maintenance plan');
  }
  const plan=reconsiderMaintenanceSource({...input,previousPlanId:request.previous_plan_id,sourceTurnIds,now});
  runInTransaction(()=>{
    const changed=db().prepare(`UPDATE page_maintenance_reconsider_requests SET state='completed',claimed_plan_id=?,updated_at=? WHERE id=? AND state='queued'`).run(plan.id,now,input.requestId);
    if(Number(changed.changes)!==1){
      const saved=db().prepare('SELECT claimed_plan_id FROM page_maintenance_reconsider_requests WHERE id=?').get(input.requestId) as {claimed_plan_id:string|null}|undefined;
      if(saved?.claimed_plan_id!==plan.id)throw new PageMaintenanceConflictError('Queued reconsideration was claimed by another run');
    }
  });
  return plan;
}

export function markMaintenanceSourceAttention(input:{planId:string;ownerUserId:string;sourceTurnId:string;reason:string;now:number}):MaintenancePlan {
  const now=nowValue(input.now);
  if(!input.reason?.trim()||input.reason.length>2000)throw new PageWriteError(400,'invalid','An attention reason is required');
  return runInTransaction(()=>{
    const plan=getMaintenancePlan(input.planId,input.ownerUserId);
    if(!plan)throw new PageWriteError(404,'not_found','Maintenance plan not found');
    const source=plan.sources.find(s=>s.sourceTurnId===input.sourceTurnId);
    if(!source)throw new PageWriteError(404,'not_found','Source turn is not in this plan');
    if(source.state==='terminal'||source.state==='skipped')throw new PageMaintenanceConflictError('Source is already terminal');
    db().prepare(`UPDATE page_maintenance_sources SET state='attention',terminal_reason=?,updated_at=? WHERE plan_id=? AND source_turn_id=?`).run(input.reason.trim(),now,input.planId,input.sourceTurnId);
    db().prepare(`UPDATE page_maintenance_resources SET state='attention',terminal_reason=?,updated_at=? WHERE plan_id=? AND source_turn_id=? AND state='pending'`).run(input.reason.trim(),now,input.planId,input.sourceTurnId);
    db().prepare(`UPDATE page_maintenance_plans SET state='attention',updated_at=? WHERE id=?`).run(now,input.planId);
    return getMaintenancePlan(input.planId,input.ownerUserId)!;
  });
}

/** User-authorized skip outcome; the caller must authorize the owner and reason before calling. */
export function skipMaintenanceSource(input:{planId:string;ownerUserId:string;sourceTurnId:string;reason:string;expectedConfigRevision:number;now:number}):MaintenancePlan {
  const now=nowValue(input.now);
  if(!input.reason?.trim()||input.reason.length>2000)throw new PageWriteError(400,'invalid','A skip reason is required');
  return runInTransaction(()=>{
    const plan=getMaintenancePlan(input.planId,input.ownerUserId);
    if(!plan)throw new PageWriteError(404,'not_found','Maintenance plan not found');
    const config=getMaintenanceConfig(plan.workspaceId,input.ownerUserId);
    if(!config||config.revision!==input.expectedConfigRevision)throw new PageMaintenanceConflictError('Maintenance config changed');
    const source=plan.sources.find(s=>s.sourceTurnId===input.sourceTurnId);
    if(!source)throw new PageWriteError(404,'not_found','Source turn is not in this plan');
    if(source.state==='terminal'||source.state==='skipped')throw new PageMaintenanceConflictError('Source is already terminal');
    db().prepare(`UPDATE page_maintenance_resources SET state='skipped',terminal_reason=?,updated_at=? WHERE plan_id=? AND source_turn_id=? AND state IN ('pending','attention')`).run(input.reason.trim(),now,input.planId,input.sourceTurnId);
    db().prepare(`UPDATE page_maintenance_sources SET state='skipped',terminal_reason=?,routing_complete=1,updated_at=? WHERE plan_id=? AND source_turn_id=?`).run(input.reason.trim(),now,input.planId,input.sourceTurnId);
    updatePlanState(input.planId,now);
    return getMaintenancePlan(input.planId,input.ownerUserId)!;
  });
}

export const MAINTENANCE_SOURCE_DELETED='Skipped: the conversation was deleted';
export const MAINTENANCE_SOURCE_ARCHIVED='Skipped: the conversation was archived';

/**
 * Why a source can no longer be read because the user removed its
 * conversation: put in Trash, purged, archived (status, archive group or
 * archived tree), or its turn or frozen messages gone. Null while it is still
 * there, or when it moved to another workspace.
 */
function removedSourceReason(plan:MaintenancePlan,source:MaintenanceSourcePlan):string|null {
  const node=db().prepare(`SELECT n.workspace_id,n.deleted_at,n.purged_at,n.status,n.deletion_group_id,tr.archived_at AS tree_archived_at
    FROM nodes n LEFT JOIN trees tr ON tr.id=n.tree_id WHERE n.id=?`).get(source.evidence.nodeId) as
    {workspace_id:string;deleted_at:number|null;purged_at:number|null;status:string;deletion_group_id:string|null;tree_archived_at:number|null}|undefined;
  if(!node||node.purged_at!==null)return MAINTENANCE_SOURCE_DELETED;
  if(node.workspace_id!==plan.workspaceId)return null;
  if(node.deleted_at!==null)return node.deletion_group_id?.startsWith('arch-')?MAINTENANCE_SOURCE_ARCHIVED:MAINTENANCE_SOURCE_DELETED;
  if(node.status==='archived'||node.tree_archived_at!==null)return MAINTENANCE_SOURCE_ARCHIVED;
  if(!db().prepare('SELECT 1 FROM turns WHERE turn_id=? AND node_id=?').get(source.sourceTurnId,source.evidence.nodeId))return MAINTENANCE_SOURCE_DELETED;
  const missing=db().prepare(`SELECT 1 FROM page_maintenance_source_messages f WHERE f.plan_id=? AND f.source_turn_id=?
    AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=f.message_id)`).get(plan.id,source.sourceTurnId);
  return missing?MAINTENANCE_SOURCE_DELETED:null;
}

/**
 * Records each unfinished source whose conversation the user removed as
 * skipped, with why, so the batch completes without it instead of failing
 * every run. Other unreadable sources are left as they are.
 */
export function skipRemovedMaintenanceSources(input:AuthorityInput & {planId:string;now:number}):MaintenancePlan {
  const now=nowValue(input.now);
  return runInTransaction(()=>{
    assertMaintenanceAuthority(input,now);
    const plan=getMaintenancePlan(input.planId,input.ownerUserId);
    if(!plan||plan.workspaceId!==input.workspaceId||plan.jobId!==input.jobId)throw new PageWriteError(404,'not_found','Maintenance plan not found');
    let skipped=0;
    for(const source of plan.sources){
      if(source.state==='terminal'||source.state==='skipped')continue;
      const reason=removedSourceReason(plan,source);
      if(!reason)continue;
      db().prepare(`UPDATE page_maintenance_resources SET state='skipped',terminal_reason=?,updated_at=? WHERE plan_id=? AND source_turn_id=? AND state IN ('pending','attention')`).run(reason,now,plan.id,source.sourceTurnId);
      db().prepare(`UPDATE page_maintenance_sources SET state='skipped',terminal_reason=?,routing_complete=1,updated_at=? WHERE plan_id=? AND source_turn_id=?`).run(reason,now,plan.id,source.sourceTurnId);
      skipped+=1;
    }
    if(skipped)updatePlanState(plan.id,now);
    return getMaintenancePlan(plan.id,input.ownerUserId)!;
  });
}

/** Cursor consumers must test this before committing their terminal run/CAS. */
export function maintenancePlanIsTerminal(planId:string,ownerUserId:string):boolean {
  const plan=getMaintenancePlan(planId,ownerUserId);
  return !!plan&&plan.state==='terminal'&&plan.sources.every(source=>['terminal','skipped'].includes(source.state));
}

export function findTerminalMaintenancePlan(input:{workspaceId:string;ownerUserId:string;jobId:string;after:number;through:number}):MaintenancePlan|null {
  const rows=db().prepare(`SELECT id FROM page_maintenance_plans WHERE workspace_id=? AND owner_user_id=? AND job_id=?
    AND after_seq=? AND through_seq<=? AND state='terminal' ORDER BY through_seq DESC,generation DESC,created_at DESC`).all(input.workspaceId,input.ownerUserId,input.jobId,input.after,input.through) as unknown as Array<{id:string}>;
  return rows.map(row=>getMaintenancePlan(row.id,input.ownerUserId)).find(plan=>plan&&maintenancePlanIsTerminal(plan.id,input.ownerUserId))??null;
}
/** Rebinds a fully committed plan for cursor-only completion after a scheduler/config race. */
export function claimTerminalMaintenancePlan(input:AuthorityInput & {planId:string;now:number}):MaintenancePlan {
  const now=nowValue(input.now);
  return runInTransaction(()=>{
    assertMaintenanceAuthority(input,now);
    const plan=getMaintenancePlan(input.planId,input.ownerUserId);
    if(!plan||plan.workspaceId!==input.workspaceId||plan.jobId!==input.jobId||plan.state!=='terminal'||!maintenancePlanIsTerminal(plan.id,input.ownerUserId))
      throw new PageMaintenanceConflictError('Maintenance plan is not fully terminal');
    if(plan.after!==getMaintenanceConfig(input.workspaceId,input.ownerUserId)?.completionCursor)throw new PageMaintenanceConflictError('Maintenance cursor changed');
    const conflict=db().prepare(`SELECT id FROM page_maintenance_plans WHERE job_id=? AND run_id=? AND id<>?`).get(input.jobId,input.runId,input.planId);
    if(conflict)throw new PageMaintenanceConflictError('Run already owns another maintenance plan');
    db().prepare(`UPDATE page_maintenance_plans SET run_id=?,config_revision=?,updated_at=? WHERE id=? AND state='terminal'`)
      .run(input.runId,input.configRevision,now,input.planId);
    return getMaintenancePlan(input.planId,input.ownerUserId)!;
  });
}

/** Rebinds an unfinished durable plan to a new scheduler run while retaining its source/resource keys and frozen payloads. */
export function claimMaintenancePlan(input:AuthorityInput & {planId:string;now:number}):MaintenancePlan {
  const now=nowValue(input.now);
  return runInTransaction(()=>{
    assertMaintenanceAuthority(input,now);
    const plan=getMaintenancePlan(input.planId,input.ownerUserId);
    if(!plan||plan.workspaceId!==input.workspaceId||plan.jobId!==input.jobId||!['routing','processing','attention'].includes(plan.state))throw new PageMaintenanceConflictError('Maintenance plan cannot be resumed');
    const conflict=db().prepare('SELECT 1 FROM page_maintenance_plans WHERE job_id=? AND run_id=? AND id<>?').get(input.jobId,input.runId,input.planId);
    if(conflict)throw new PageMaintenanceConflictError('Run already owns another maintenance plan');
    db().prepare(`UPDATE page_maintenance_plans SET run_id=?,config_revision=?,state='processing',updated_at=? WHERE id=? AND state IN ('routing','processing','attention')`)
      .run(input.runId,input.configRevision,now,input.planId);
    reopenAttentionSources(input.planId,now);
    return getMaintenancePlan(input.planId,input.ownerUserId)!;
  });
}

function reopenAttentionSources(planId:string,now:number):void {
  db().prepare(`UPDATE page_maintenance_sources SET state=CASE WHEN routing_complete=1 THEN 'processing' ELSE 'routing' END,updated_at=?
    WHERE plan_id=? AND state='attention'`).run(now,planId);
  db().prepare(`UPDATE page_maintenance_resources SET state='pending',terminal_reason=NULL,updated_at=? WHERE plan_id=? AND state='attention'`).run(now,planId);
}

/**
 * The stopped state's Retry: puts each batch held for attention back in the
 * queue as an unfinished plan, which the next run claims like any other.
 * Returns how many plans were queued again.
 */
export function requeueMaintenanceAttention(input:{workspaceId:string;ownerUserId:string;now:number}):number {
  const now=nowValue(input.now);
  return runInTransaction(()=>{
    const plans=db().prepare(`SELECT p.id FROM page_maintenance_plans p WHERE p.workspace_id=? AND p.owner_user_id=?
      AND (p.state='attention' OR (p.state IN ('routing','processing')
        AND EXISTS(SELECT 1 FROM page_maintenance_sources s WHERE s.plan_id=p.id AND s.state='attention')))`)
      .all(input.workspaceId,input.ownerUserId) as unknown as Array<{id:string}>;
    for(const plan of plans){
      db().prepare(`UPDATE page_maintenance_plans SET state='processing',updated_at=? WHERE id=?`).run(now,plan.id);
      reopenAttentionSources(plan.id,now);
    }
    return plans.length;
  });
}

export function recordMaintenanceRouting(input: AuthorityInput & {planId:string;sourceTurnId:string;manifest:MaintenanceResourceRef[];reason?:string;now:number}):MaintenancePlan {
  const now=nowValue(input.now);
  return runInTransaction(()=>{
    assertMaintenanceAuthority(input,now);
    const plan=getMaintenancePlan(input.planId,input.ownerUserId);
    if(!plan||plan.jobId!==input.jobId||plan.workspaceId!==input.workspaceId||plan.configRevision!==input.configRevision||!['routing','processing'].includes(plan.state))throw new PageMaintenanceConflictError('Maintenance plan changed');
    const source=plan.sources.find(x=>x.sourceTurnId===input.sourceTurnId);
    if(!source)throw new PageWriteError(404,'not_found','Source turn is not in this plan');
    if(source.routingComplete) return plan;
    assertMaintenanceSourceCoverageComplete(input.planId,input.ownerUserId,input.sourceTurnId);
    const sourceRow=db().prepare('SELECT manifest_json FROM page_maintenance_sources WHERE plan_id=? AND source_turn_id=?').get(input.planId,input.sourceTurnId) as {manifest_json:string};
    const frozenManifest=parse<MaintenanceResourceRef[]>(sourceRow.manifest_json);
    const allowed=new Map<string,MaintenanceResourceRef>();
    for(const resource of frozenManifest)allowed.set(`${resource.kind}:${resource.id}`,resource);
    const currentResources=(plan.scopeSpaceId?listEligibleMaintenanceManifestForSpace(input.workspaceId,input.ownerUserId,plan.scopeSpaceId):listEligibleMaintenanceManifest(input.workspaceId,input.ownerUserId)).resources;
    const currentByKey=new Map(currentResources.map(resource=>[`${resource.kind}:${resource.id}`,resource]));
    const unique=new Map<string,MaintenanceResourceRef>();
    for(const raw of input.manifest){
      // The task database may be routed while no page shows it.
      if(!raw||!['page','database'].includes(raw.kind)||typeof raw.id!=='string'||!Array.isArray(raw.pageIds)||(raw.kind==='page'&&!raw.pageIds.length))throw new PageWriteError(400,'invalid','Invalid maintenance candidate');
      const permitted=allowed.get(`${raw.kind}:${raw.id}`);
      if(!permitted||raw.revision!==permitted.revision||raw.pageIds.some(pageId=>!permitted.pageIds.includes(pageId)))throw new PageWriteError(409,'invalid','Maintenance candidate is outside the frozen eligible manifest');
      const current=currentByKey.get(`${raw.kind}:${raw.id}`);
      if(!current||current.revision!==permitted.revision||json([...current.pageIds].sort())!==json([...permitted.pageIds].sort()))throw new PageMaintenanceConflictError('Maintenance candidate changed after source activation');
      const pageIds=[...new Set(raw.pageIds)].sort();
      const permittedPages=[...permitted.pageIds].sort();
      if(pageIds.length!==permittedPages.length||pageIds.some((pageId,index)=>pageId!==permittedPages[index]))throw new PageWriteError(409,'invalid','Maintenance candidate must preserve the full resource route');
      unique.set(`${raw.kind}:${raw.id}`,{kind:raw.kind,id:raw.id,revision:permitted.revision,pageIds});
    }
    if(!unique.size&&!input.reason?.trim())throw new PageWriteError(400,'invalid','No-change routing requires an explicit reason');
    const candidates=[...unique.values()].sort((a,b)=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id));
    const nextState=candidates.length?'processing':'terminal';
    db().prepare(`UPDATE page_maintenance_sources SET routing_complete=1,candidates_json=?,state=?,terminal_reason=?,updated_at=?
      WHERE plan_id=? AND source_turn_id=? AND routing_complete=0`).run(json(candidates),nextState,candidates.length?null:input.reason!.trim(),now,input.planId,input.sourceTurnId);
    for(const resource of candidates){
      const key=maintenanceOperationKey(input.jobId,input.sourceTurnId,resource.kind,resource.id,plan.generation);
      db().prepare(`INSERT OR IGNORE INTO page_maintenance_resources(plan_id,source_turn_id,resource_kind,resource_id,observed_revision,generation,page_ids_json,state,receipt_key,updated_at)
        VALUES(?,?,?,?,?,?,?, 'pending', ?,?)`).run(input.planId,input.sourceTurnId,resource.kind,resource.id,resource.revision,plan.generation,json(resource.pageIds),key,now);
    }
    updatePlanState(input.planId,now);
    return getMaintenancePlan(input.planId,input.ownerUserId)!;
  });
}

/** Refreshes one not-yet-routed source after all earlier sources are terminal.
 * The initial eligible IDs and page routes remain fixed; only revisions for
 * resources that are still eligible on the exact same route are advanced.
 */
export function refreshMaintenanceSourceManifest(input: AuthorityInput & {planId:string;sourceTurnId:string;now:number}): MaintenancePlan {
  const now=nowValue(input.now);
  return runInTransaction(()=>{
    assertMaintenanceAuthority(input,now);
    const plan=getMaintenancePlan(input.planId,input.ownerUserId);
    if(!plan||plan.jobId!==input.jobId||plan.workspaceId!==input.workspaceId||plan.configRevision!==input.configRevision||!['routing','processing'].includes(plan.state))
      throw new PageMaintenanceConflictError('Maintenance plan changed');
    const index=plan.sources.findIndex(source=>source.sourceTurnId===input.sourceTurnId);
    if(index<0)throw new PageWriteError(404,'not_found','Source turn is not in this plan');
    const source=plan.sources[index];
    if(source.routingComplete)throw new PageMaintenanceConflictError('A routed source manifest is immutable');
    if(plan.sources.slice(0,index).some(prior=>prior.state!=='terminal'&&prior.state!=='skipped'))
      throw new PageMaintenanceConflictError('Earlier maintenance sources are not terminal');
    const current=(plan.scopeSpaceId?listEligibleMaintenanceManifestForSpace(input.workspaceId,input.ownerUserId,plan.scopeSpaceId):listEligibleMaintenanceManifest(input.workspaceId,input.ownerUserId)).resources;
    const byKey=new Map(current.map(resource=>[`${resource.kind}:${resource.id}`,resource]));
    const refreshed=source.manifest.flatMap(original=>{
      const latest=byKey.get(`${original.kind}:${original.id}`);
      if(!latest||json([...latest.pageIds].sort())!==json([...original.pageIds].sort()))return [];
      return [{...original,revision:latest.revision}];
    });
    db().prepare(`UPDATE page_maintenance_sources SET manifest_json=?,updated_at=? WHERE plan_id=? AND source_turn_id=? AND routing_complete=0`)
      .run(json(refreshed),now,input.planId,input.sourceTurnId);
    return getMaintenancePlan(input.planId,input.ownerUserId)!;
  });
}

export const MAINTENANCE_TARGET_GONE='Skipped: the target was deleted or excluded after routing';
export const MAINTENANCE_TARGET_MOVED='Skipped: the target moved to other pages after routing';
export type MaintenanceReobserveOutcome='unchanged'|'advanced'|'adopted'|'skipped';

/**
 * Re-observes one routed resource when the agent starts reading it again. Only a pending resource without a frozen
 * payload is touched, and never the routed set. A moved revision is advanced; the workspace task database also adopts
 * a changed board route, since its tasks belong to the workspace; a resource that was deleted or excluded, or any other
 * resource whose page route changed, is skipped with a reason so the plan can still finish.
 */
export function reobserveRoutedMaintenanceResource(input: AuthorityInput & {planId:string;sourceTurnId:string;kind:MaintenanceResourceKind;resourceId:string;now:number}): {outcome:MaintenanceReobserveOutcome;reason?:string} {
  const now=nowValue(input.now);
  return runInTransaction(()=>{
    assertMaintenanceAuthority(input,now);
    const plan=getMaintenancePlan(input.planId,input.ownerUserId);
    if(!plan||plan.jobId!==input.jobId||plan.workspaceId!==input.workspaceId||plan.configRevision!==input.configRevision||!['routing','processing'].includes(plan.state))
      throw new PageMaintenanceConflictError('Maintenance plan changed');
    const source=plan.sources.find(x=>x.sourceTurnId===input.sourceTurnId);
    if(!source)throw new PageWriteError(404,'not_found','Source turn is not in this plan');
    if(!source.routingComplete)throw new PageMaintenanceConflictError('Source routing is not complete');
    const row=db().prepare(`SELECT observed_revision,page_ids_json FROM page_maintenance_resources
      WHERE plan_id=? AND source_turn_id=? AND resource_kind=? AND resource_id=? AND state='pending'`)
      .get(input.planId,input.sourceTurnId,input.kind,input.resourceId) as {observed_revision:number;page_ids_json:string}|undefined;
    if(!row)return {outcome:'unchanged'};
    // A Space catch-up whose Space was excluded or deleted after routing has no manifest: its targets are gone.
    let manifest:MaintenanceManifest={pages:[],databases:[],resources:[],pageCursor:null};
    if(plan.scopeSpaceId){
      const scopeId=plan.scopeSpaceId;
      const full=listEligibleMaintenanceManifest(input.workspaceId,input.ownerUserId);
      if(full.pages.some(page=>page.id===scopeId&&page.parentId===null))manifest=listEligibleMaintenanceManifestForSpace(input.workspaceId,input.ownerUserId,scopeId);
    }else manifest=listEligibleMaintenanceManifest(input.workspaceId,input.ownerUserId);
    const latest=manifest.resources.find(resource=>resource.kind===input.kind&&resource.id===input.resourceId);
    const routedPages=parse<string[]>(row.page_ids_json);
    const samePages=!!latest&&json([...latest.pageIds].sort())===json([...routedPages].sort());
    const isTaskDatabase=input.kind==='database'&&manifest.databases.some(database=>database.id===input.resourceId&&database.role==='tasks');
    if(latest&&(samePages||isTaskDatabase)){
      if(latest.revision===row.observed_revision&&samePages)return {outcome:'unchanged'};
      const pageIds=[...latest.pageIds].sort();
      db().prepare(`UPDATE page_maintenance_resources SET observed_revision=?,page_ids_json=?,updated_at=? WHERE plan_id=? AND source_turn_id=? AND resource_kind=? AND resource_id=? AND state='pending'`)
        .run(latest.revision,json(pageIds),now,input.planId,input.sourceTurnId,input.kind,input.resourceId);
      const candidates=source.candidates.map(candidate=>candidate.kind===input.kind&&candidate.id===input.resourceId?{...candidate,revision:latest.revision,pageIds}:candidate);
      db().prepare('UPDATE page_maintenance_sources SET candidates_json=?,updated_at=? WHERE plan_id=? AND source_turn_id=? AND routing_complete=1')
        .run(json(candidates),now,input.planId,input.sourceTurnId);
      return {outcome:samePages?'advanced':'adopted'};
    }
    const reason=latest?MAINTENANCE_TARGET_MOVED:MAINTENANCE_TARGET_GONE;
    db().prepare(`UPDATE page_maintenance_resources SET state='skipped',terminal_reason=?,updated_at=? WHERE plan_id=? AND source_turn_id=? AND resource_kind=? AND resource_id=? AND state='pending'`)
      .run(reason,now,input.planId,input.sourceTurnId,input.kind,input.resourceId);
    updateSourceState(input.planId,input.sourceTurnId,now);
    const decided=db().prepare(`SELECT COUNT(*) AS n FROM page_maintenance_resources WHERE plan_id=? AND source_turn_id=? AND state<>'skipped'`).get(input.planId,input.sourceTurnId) as {n:number};
    if(decided.n===0){
      const reasons=(db().prepare(`SELECT DISTINCT terminal_reason FROM page_maintenance_resources WHERE plan_id=? AND source_turn_id=? AND terminal_reason IS NOT NULL ORDER BY terminal_reason`).all(input.planId,input.sourceTurnId) as unknown as Array<{terminal_reason:string}>).map(row=>row.terminal_reason);
      const combined=(reasons.length>1?`Skipped: ${reasons.map(text=>text.replace(/^Skipped: /,'')).join('; ')}`:reasons[0]??reason).slice(0,2000);
      db().prepare(`UPDATE page_maintenance_sources SET state='skipped',terminal_reason=?,updated_at=? WHERE plan_id=? AND source_turn_id=?`).run(combined,now,input.planId,input.sourceTurnId);
    }
    updatePlanState(input.planId,now);
    return {outcome:'skipped',reason};
  });
}

export type MaintenanceResourceState='pending'|'attention'|'skipped'|'written'|'proposed'|'no_change';
/** Decision state of each routed resource of one source: pending until a receipt or a skip settles it. */
export function listMaintenanceResourceStates(planId:string,ownerUserId:string,sourceTurnId:string):Map<string,MaintenanceResourceState> {
  const rows=db().prepare(`SELECT r.resource_kind,r.resource_id,r.state FROM page_maintenance_resources r JOIN page_maintenance_plans p ON p.id=r.plan_id
    WHERE r.plan_id=? AND p.owner_user_id=? AND r.source_turn_id=?`).all(planId,ownerUserId,sourceTurnId) as unknown as Array<{resource_kind:string;resource_id:string;state:MaintenanceResourceState}>;
  return new Map(rows.map(row=>[`${row.resource_kind}:${row.resource_id}`,row.state]));
}

export function maintenanceOperationKey(jobId:string,sourceTurnId:string,kind:MaintenanceResourceKind,resourceId:string,generation:number):string {
  return `maintenance:${encodeURIComponent(jobId)}:${encodeURIComponent(sourceTurnId)}:${kind}:${encodeURIComponent(resourceId)}:${generation}`;
}

/** Rechecks the frozen manifest revision, page set, and current exclusion before a write transaction commits. */
export function assertMaintenanceResourceCurrent(input: {workspaceId:string;ownerUserId:string;planId:string;sourceTurnId:string;resource:MaintenanceResourceRef}):void {
  const row=db().prepare(`SELECT r.observed_revision,r.page_ids_json,s.routing_complete,s.candidates_json,p.workspace_id,p.owner_user_id
    FROM page_maintenance_resources r JOIN page_maintenance_sources s ON s.plan_id=r.plan_id AND s.source_turn_id=r.source_turn_id
    JOIN page_maintenance_plans p ON p.id=r.plan_id WHERE r.plan_id=? AND r.source_turn_id=? AND r.resource_kind=? AND r.resource_id=?`)
    .get(input.planId,input.sourceTurnId,input.resource.kind,input.resource.id) as {observed_revision:number;page_ids_json:string;routing_complete:number;candidates_json:string;workspace_id:string;owner_user_id:string}|undefined;
  if(!row||row.workspace_id!==input.workspaceId||row.owner_user_id!==input.ownerUserId||row.routing_complete!==1)throw new PageWriteError(404,'not_found','Maintenance resource is not in the plan');
  const recorded=parse<MaintenanceResourceRef[]>(row.candidates_json).find(r=>r.kind===input.resource.kind&&r.id===input.resource.id);
  const affectedPages=[...input.resource.pageIds].sort();
  if(!recorded||recorded.revision!==input.resource.revision||json(recorded.pageIds)!==json(affectedPages))throw new PageMaintenanceConflictError('Maintenance resource differs from its routed candidate');
  if(row.observed_revision!==input.resource.revision||json(parse<string[]>(row.page_ids_json))!==json(affectedPages))throw new PageMaintenanceConflictError('Maintenance target version or affected pages changed; read it again from the start');
  const current=listEligibleMaintenanceManifest(input.workspaceId,input.ownerUserId).resources.find(r=>r.kind===input.resource.kind&&r.id===input.resource.id);
  if(!current||json([...current.pageIds].sort())!==json(affectedPages))throw new PageMaintenanceConflictError('Maintenance target is no longer on its routed pages (deleted, excluded or moved). Read it once from its first page: the task database adopts its new route; anything else is recorded as skipped.');
  if(current.revision!==row.observed_revision)throw new PageMaintenanceConflictError('Maintenance target changed since you read it. Read it again from the start: the read refreshes its revision. Then retry with operations based on what you read.');
}

export function freezeMaintenanceResourcePayload(input: AuthorityInput & {planId:string;sourceTurnId:string;kind:MaintenanceResourceKind;resourceId:string;payload:unknown;assignedIds:unknown;now:number}): {payloadHash:string;payload:unknown;assignedIds:unknown} {
  const now=nowValue(input.now);
  const canonical=json({payload:input.payload,assignedIds:input.assignedIds});
  if(Buffer.byteLength(canonical)>1_048_576)throw new PageWriteError(400,'invalid','Maintenance resource payload exceeds 1 MB');
  const payloadHash=createHash('sha256').update(canonical).digest('hex');
  return runInTransaction(()=>{
    assertMaintenanceAuthority(input,now);
    const plan=db().prepare('SELECT generation,config_revision,state FROM page_maintenance_plans WHERE id=? AND job_id=? AND workspace_id=? AND owner_user_id=?')
      .get(input.planId,input.jobId,input.workspaceId,input.ownerUserId) as {generation:number;config_revision:number;state:string}|undefined;
    if(!plan||plan.config_revision!==input.configRevision||!['processing','routing'].includes(plan.state))throw new PageMaintenanceConflictError('Maintenance plan changed');
    const key=maintenanceOperationKey(input.jobId,input.sourceTurnId,input.kind,input.resourceId,plan.generation);
    // Apply and receipt commit together, so a pending resource with a frozen payload applied nothing: the payload of a
    // rejected attempt is replaced by the corrected one. Once a receipt settles the resource its payload stays final.
    const payloadJson=json(input.payload),assignedJson=json(input.assignedIds);
    const result=db().prepare(`UPDATE page_maintenance_resources SET
      payload_hash=CASE WHEN state='pending' THEN ? ELSE COALESCE(payload_hash,?) END,
      payload_json=CASE WHEN state='pending' THEN ? ELSE COALESCE(payload_json,?) END,
      assigned_ids_json=CASE WHEN state='pending' THEN ? ELSE COALESCE(assigned_ids_json,?) END,
      updated_at=? WHERE plan_id=? AND source_turn_id=? AND resource_kind=? AND resource_id=? AND receipt_key=?`)
      .run(payloadHash,payloadHash,payloadJson,payloadJson,assignedJson,assignedJson,now,input.planId,input.sourceTurnId,input.kind,input.resourceId,key);
    if(Number(result.changes)!==1)throw new PageWriteError(404,'not_found','Maintenance resource is not routed');
    const saved=db().prepare('SELECT payload_hash,payload_json,assigned_ids_json FROM page_maintenance_resources WHERE receipt_key=?').get(key) as {payload_hash:string;payload_json:string;assigned_ids_json:string}|undefined;
    if(saved?.payload_hash!==payloadHash||saved.payload_json!==json(input.payload)||saved.assigned_ids_json!==json(input.assignedIds))throw new PageMaintenanceConflictError('Resource payload is already final: a receipt settled this resource with a different operation set');
    return {payloadHash,payload:parse(saved.payload_json),assignedIds:parse(saved.assigned_ids_json)};
  });
}

export type CommitMaintenanceReceiptInput = AuthorityInput & {planId:string;sourceTurnId:string;resource:MaintenanceResourceRef;outcome:'written'|'proposed'|'no_change';payloadHash:string;payload:unknown;assignedIds:unknown;result:unknown;execution:BlockSource & {runId:string};evidence:BlockSource;now:number};
export function commitMaintenanceReceipt(input: CommitMaintenanceReceiptInput): MaintenanceReceipt {
  return runInTransaction(()=>persistMaintenanceReceiptInTransaction(input));
}

/** Persists the receipt inside the caller's page/content transaction. */
export function persistMaintenanceReceiptInTransaction(input: CommitMaintenanceReceiptInput): MaintenanceReceipt {
  const now=nowValue(input.now);
    assertMaintenanceAuthority(input,now);
    const plan=db().prepare('SELECT generation,config_revision FROM page_maintenance_plans WHERE id=? AND job_id=? AND workspace_id=? AND owner_user_id=?')
      .get(input.planId,input.jobId,input.workspaceId,input.ownerUserId) as {generation:number;config_revision:number}|undefined;
    if(!plan||plan.config_revision!==input.configRevision)throw new PageMaintenanceConflictError('Maintenance plan changed');
    const key=maintenanceOperationKey(input.jobId,input.sourceTurnId,input.resource.kind,input.resource.id,plan.generation);
    const resource=db().prepare(`SELECT r.*,s.evidence_json FROM page_maintenance_resources r JOIN page_maintenance_sources s
      ON s.plan_id=r.plan_id AND s.source_turn_id=r.source_turn_id WHERE r.receipt_key=? AND r.plan_id=?`).get(key,input.planId) as any;
    if(!resource||resource.state!=='pending'){
      const existing=getMaintenanceReceipt(key);
      if(existing&&existing.payloadHash===input.payloadHash)return existing;
      throw new PageMaintenanceConflictError('Maintenance resource is already terminal or missing');
    }
    if(resource.payload_hash!==input.payloadHash||resource.payload_json!==json(input.payload)||resource.assigned_ids_json!==json(input.assignedIds))throw new PageMaintenanceConflictError('Receipt payload does not match frozen plan');
    const evidence=parse<BlockSource>(resource.evidence_json);
    if(json(evidence)!==json(input.evidence))throw new PageMaintenanceConflictError('Receipt evidence does not match planned source');
    if(!input.execution||input.execution.runId!==input.runId||!input.execution.nodeId||!input.execution.turnId||!input.execution.assistantId)throw new PageMaintenanceConflictError('Execution provenance is invalid');
    const run=db().prepare(`SELECT r.node_id,r.turn_id,t.assistant_message_id FROM scheduled_job_runs r
      LEFT JOIN turns t ON t.turn_id=r.turn_id AND t.node_id=r.node_id WHERE r.id=? AND r.job_id=?`).get(input.runId,input.jobId) as
      {node_id:string|null;turn_id:string|null;assistant_message_id:string|null}|undefined;
    if(!run||run.node_id!==input.execution.nodeId||run.turn_id!==input.execution.turnId||run.assistant_message_id!==input.execution.assistantId)throw new PageMaintenanceConflictError('Execution provenance does not match the scheduled turn');
    const receipt:MaintenanceReceipt={operationKey:key,planId:input.planId,jobId:input.jobId,sourceTurnId:input.sourceTurnId,
      resource:{...input.resource,pageIds:parse(resource.page_ids_json)},generation:plan.generation,payloadHash:input.payloadHash,
      payload:parse(resource.payload_json),assignedIds:parse(resource.assigned_ids_json),result:input.result,outcome:input.outcome,
      execution:input.execution,evidence,committedAt:now};
    db().prepare(`INSERT INTO page_maintenance_receipts(receipt_key,plan_id,job_id,source_turn_id,resource_kind,resource_id,generation,
      payload_hash,payload_json,assigned_ids_json,result_json,outcome,execution_json,evidence_json,committed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(key,input.planId,input.jobId,input.sourceTurnId,input.resource.kind,input.resource.id,plan.generation,
      input.payloadHash,json(receipt.payload),json(receipt.assignedIds),json(input.result),input.outcome,json(input.execution),json(evidence),now);
    db().prepare(`UPDATE page_maintenance_resources SET state=?,updated_at=? WHERE receipt_key=? AND state='pending'`).run(input.outcome,now,key);
    updateSourceState(input.planId,input.sourceTurnId,now);
    updatePlanState(input.planId,now);
    return receipt;
}

export function getMaintenanceReceipt(operationKey:string):MaintenanceReceipt|null {
  const row=db().prepare('SELECT * FROM page_maintenance_receipts WHERE receipt_key=?').get(operationKey) as any;
  return row?{operationKey:row.receipt_key,planId:row.plan_id,jobId:row.job_id,sourceTurnId:row.source_turn_id,
    resource:{kind:row.resource_kind,id:row.resource_id,revision:resourceRevision(row.plan_id,row.source_turn_id,row.resource_kind,row.resource_id),pageIds:resourcePageIds(row.plan_id,row.source_turn_id,row.resource_kind,row.resource_id)},
    generation:row.generation,payloadHash:row.payload_hash,payload:parse(row.payload_json),assignedIds:parse(row.assigned_ids_json),result:parse(row.result_json),
    outcome:row.outcome,execution:parse(row.execution_json),evidence:parse(row.evidence_json),committedAt:row.committed_at}:null;
}
function resourcePageIds(planId:string,sourceTurnId:string,kind:string,id:string):string[]{const row=db().prepare('SELECT page_ids_json FROM page_maintenance_resources WHERE plan_id=? AND source_turn_id=? AND resource_kind=? AND resource_id=?').get(planId,sourceTurnId,kind,id) as {page_ids_json:string}|undefined;return row?parse(row.page_ids_json):[];}
function resourceRevision(planId:string,sourceTurnId:string,kind:string,id:string):number{const row=db().prepare('SELECT observed_revision FROM page_maintenance_resources WHERE plan_id=? AND source_turn_id=? AND resource_kind=? AND resource_id=?').get(planId,sourceTurnId,kind,id) as {observed_revision:number}|undefined;return row?.observed_revision??1;}

function updateSourceState(planId:string,sourceTurnId:string,now:number):void {
  const row=db().prepare('SELECT routing_complete FROM page_maintenance_sources WHERE plan_id=? AND source_turn_id=?').get(planId,sourceTurnId) as {routing_complete:number}|undefined;
  if(!row?.routing_complete)return;
  const pending=db().prepare(`SELECT COUNT(*) AS n FROM page_maintenance_resources WHERE plan_id=? AND source_turn_id=? AND state IN ('pending','attention')`).get(planId,sourceTurnId) as {n:number};
  if(pending.n===0)db().prepare(`UPDATE page_maintenance_sources SET state='terminal',updated_at=? WHERE plan_id=? AND source_turn_id=?`).run(now,planId,sourceTurnId);
}
function updatePlanState(planId:string,now:number):void {
  const row=db().prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN state IN ('routing','processing') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN state='attention' THEN 1 ELSE 0 END) AS attention FROM page_maintenance_sources WHERE plan_id=?`).get(planId) as {total:number;pending:number|null;attention:number|null};
  const state=row.attention?'attention':row.pending?'processing':'terminal';
  db().prepare(`UPDATE page_maintenance_plans SET state=?,updated_at=? WHERE id=? AND state NOT IN ('cancelled','attention')`).run(state,now,planId);
}

export function listMaintenanceBacklog(workspaceId:string,ownerUserId:string):{plans:MaintenancePlan[];pendingSources:number;attentionSources:number} {
  const plans=db().prepare(`SELECT id FROM page_maintenance_plans WHERE workspace_id=? AND owner_user_id=? AND state IN ('routing','processing','attention') ORDER BY created_at,id`).all(workspaceId,ownerUserId) as unknown as Array<{id:string}>;
  const items=plans.map(row=>getMaintenancePlan(row.id,ownerUserId)!).filter(Boolean);
  return {plans:items,pendingSources:items.reduce((n,p)=>n+p.sources.filter(s=>['routing','processing'].includes(s.state)).length,0),attentionSources:items.reduce((n,p)=>n+p.sources.filter(s=>s.state==='attention').length,0)};
}
