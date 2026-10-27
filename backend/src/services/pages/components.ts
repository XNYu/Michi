import { randomUUID } from 'node:crypto';
import {
  PAGE_COMPONENT_LIMITS, parsePageComponentInput, parsePageComponentSource, parsePageComponentVersionSource, validatePageComponentProps,
  type PageComponent, type PageComponentReference, type PageComponentSource, type PageComponentVersionSource,
  type PageComponentVersion,
} from 'michi-shared';
import { getDb } from '../db';
import { PageWriteError, invalidateDatabasePages, invalidatePages, pagesTransaction, requireChatChangeSource, requirePagesWorkspace } from './core';

type ComponentRow = {
  id:string; owner_user_id:string; workspace_id:string; name:string; description:string; enabled:number;
  active_version:number; latest_version:number; library_revision:number; revocation_epoch:number;
  created_at:number; updated_at:number; deleted_at:number|null;
};
type VersionRow = { component_id:string; version:number; code:string; props_schema:string|null; source:string; created_at:number };
const db = () => getDb();
function fail(message:string, status:400|404|409 = 400, code:'invalid'|'not_found'|'stale_revision'='invalid'):never { throw new PageWriteError(status,code,message); }
const nowValue = (value?:number) => { const n=value??Date.now(); if(!Number.isSafeInteger(n)||n<0)fail('Invalid timestamp'); return n; };
const decodeSource = (raw:string):PageComponentVersionSource => {
  let value:unknown;
  try { value=JSON.parse(raw); } catch { return fail('Invalid stored component version attribution'); }
  const parsed=parsePageComponentVersionSource(value);
  if(!parsed)return fail('Invalid stored component version attribution');
  return parsed;
};
const toComponent = (r:ComponentRow, versions:number):PageComponent => ({
  id:r.id,ownerUserId:r.owner_user_id,workspaceId:r.workspace_id,name:r.name,description:r.description,enabled:r.enabled===1,
  activeVersion:r.active_version,libraryRevision:r.library_revision,revocationEpoch:r.revocation_epoch,deletedAt:r.deleted_at,
  versions,createdAt:r.created_at,updatedAt:r.updated_at,
});
const getRow = (workspaceId:string, ownerUserId:string, componentId:string, includeDeleted=false):ComponentRow => {
  requirePagesWorkspace(workspaceId,ownerUserId);
  const row=db().prepare('SELECT * FROM page_components WHERE id=? AND workspace_id=? AND owner_user_id=?').get(componentId,workspaceId,ownerUserId) as ComponentRow|undefined;
  if(!row)return fail('Component not found',404,'not_found');
  if(!includeDeleted&&row.deleted_at!==null)return fail('Component not found',404,'not_found');
  return row;
};
const getVersion = (id:string, version:number):VersionRow => {
  const row=db().prepare('SELECT * FROM page_component_versions WHERE component_id=? AND version=?').get(id,version) as VersionRow|undefined;
  if(!row)return fail('Component version not found',404,'not_found'); return row;
};
const dtoVersion = (r:VersionRow):PageComponentVersion => ({componentId:r.component_id,version:r.version,code:r.code,propsSchema:r.props_schema===null?null:JSON.parse(r.props_schema),source:decodeSource(r.source),createdAt:r.created_at});
function requireSource(workspaceId:string,ownerUserId:string,value:unknown):PageComponentSource {
  const source=parsePageComponentSource(value); if(!source)return fail('Invalid current chat source');
  requireChatChangeSource(workspaceId,ownerUserId,source); return source;
}
function requireUserActor(workspaceId:string,ownerUserId:string,value:unknown):void {
  requirePagesWorkspace(workspaceId,ownerUserId,true);
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||(value as {kind?:unknown}).kind!=='user')fail('A trusted UI actor is required');
}
function libraryRevision(workspaceId:string,ownerUserId:string):number {
  requirePagesWorkspace(workspaceId,ownerUserId);
  const row=db().prepare('SELECT revision FROM page_component_libraries WHERE workspace_id=? AND owner_user_id=?').get(workspaceId,ownerUserId) as {revision:number}|undefined;
  return row?.revision??0;
}
function bumpLibrary(workspaceId:string,ownerUserId:string,expected:number,now:number):number {
  const current=libraryRevision(workspaceId,ownerUserId);
  if(!Number.isSafeInteger(expected)||expected!==current)fail('Component library changed; reread and retry',409,'stale_revision');
  const next=current+1;
  db().prepare(`INSERT INTO page_component_libraries(workspace_id,owner_user_id,revision,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(workspace_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,revision=excluded.revision,updated_at=excluded.updated_at`).run(workspaceId,ownerUserId,next,now);
  return next;
}
function refs(id:string, owner:string, workspace:string, includePinned:boolean):PageComponentReference[] {
  const rows=db().prepare(`SELECT component_id,workspace_id,host_kind,page_id,block_id,database_id,view_id,pinned_version,protected,host_revision
    FROM page_component_refs WHERE component_id=? AND owner_user_id=? AND workspace_id=? ${includePinned?'':'AND pinned_version IS NULL'}`).all(id,owner,workspace) as Array<{
      component_id:string;workspace_id:string;host_kind:'page_block'|'database_view';page_id:string|null;block_id:string|null;database_id:string|null;view_id:string|null;pinned_version:number|null;protected:number;host_revision:number;
    }>;
  return rows.map(r=>({componentId:r.component_id,workspaceId:r.workspace_id,kind:r.host_kind,...(r.page_id?{pageId:r.page_id}:{}),...(r.block_id?{blockId:r.block_id}:{}),...(r.database_id?{databaseId:r.database_id}:{}),...(r.view_id?{viewId:r.view_id}:{}),pinnedVersion:r.pinned_version,protected:r.protected===1,hostRevision:r.host_revision}));
}
function invalidateReferences(list:readonly PageComponentReference[], now:number):void {
  const pageIds=new Set<string>(); const databaseIds=new Set<string>();
  for(const r of list){if(r.pageId)pageIds.add(r.pageId);if(r.databaseId)databaseIds.add(r.databaseId);}
  if(pageIds.size)invalidatePages([...pageIds],now,'agent');
  for(const id of databaseIds)invalidateDatabasePages(id,now,'agent');
}

export interface ComponentListResult { revision:number; items:PageComponent[] }
export interface ComponentMutationOptions { expectedLibraryRevision:number; actor:{kind:'user'}; now?:number }
export interface SavePageComponentInput { expectedLibraryRevision:number; source:unknown; now?:number; input:unknown }
export interface SaveUserPageComponentInput { expectedLibraryRevision:number; now?:number; input:unknown }
export interface ComponentHostReference extends Omit<PageComponentReference,'componentId'|'protected'|'hostRevision'> { componentId:string; protected?:boolean; hostRevision:number }

/** Workspace-scoped library; all writes derive attribution from a validated active chat/helper turn. */
export class PageComponents {
  list(workspaceId:string,ownerUserId:string):ComponentListResult {
    const revision=libraryRevision(workspaceId,ownerUserId);
    const rows=db().prepare('SELECT * FROM page_components WHERE workspace_id=? AND owner_user_id=? AND deleted_at IS NULL ORDER BY name,id').all(workspaceId,ownerUserId) as ComponentRow[];
    const items=rows.map(r=>toComponent(r,Number((db().prepare('SELECT COUNT(*) AS n FROM page_component_versions WHERE component_id=?').get(r.id) as {n:number}).n)));
    return {revision,items};
  }
  read(workspaceId:string,ownerUserId:string,componentId:string,version?:number,options:{includeDisabled?:boolean}={}):PageComponentVersion {
    const row=getRow(workspaceId,ownerUserId,componentId);
    if(!row.enabled&&!options.includeDisabled)fail('Component is disabled',404,'not_found');
    const selected=version??row.active_version;
    if(!Number.isSafeInteger(selected)||selected<1||selected>row.latest_version)fail('Invalid component version');
    return dtoVersion(getVersion(componentId,selected));
  }
  references(workspaceId:string,ownerUserId:string,componentId:string):PageComponentReference[] {
    getRow(workspaceId,ownerUserId,componentId,true);
    return refs(componentId,ownerUserId,workspaceId,true);
  }
  save(workspaceId:string,ownerUserId:string,args:SavePageComponentInput):{component:PageComponent;version:PageComponentVersion;revision:number} {
    return this.saveAttributed(workspaceId,ownerUserId,args,()=>requireSource(workspaceId,ownerUserId,args.source));
  }
  /** Native authenticated UI entry point. Actor attribution is server-created and cannot be supplied by the caller. */
  saveUser(workspaceId:string,ownerUserId:string,args:SaveUserPageComponentInput):{component:PageComponent;version:PageComponentVersion;revision:number} {
    return this.saveAttributed(workspaceId,ownerUserId,args,()=>{
      requireUserActor(workspaceId,ownerUserId,{kind:'user'});
      return {kind:'user'};
    });
  }
  private saveAttributed(workspaceId:string,ownerUserId:string,args:{expectedLibraryRevision:number;input:unknown;now?:number},attribution:()=>PageComponentVersionSource):{component:PageComponent;version:PageComponentVersion;revision:number} {
    const now=nowValue(args.now),input=parsePageComponentInput(args.input);
    if(!input)return fail('Invalid component definition');
    return pagesTransaction(()=>{
      const source=attribution();
      const revision=bumpLibrary(workspaceId,ownerUserId,args.expectedLibraryRevision,now);
      const existing=db().prepare('SELECT * FROM page_components WHERE owner_user_id=? AND workspace_id=? AND name=? AND deleted_at IS NULL').get(ownerUserId,workspaceId,input.name) as ComponentRow|undefined;
      let row:ComponentRow;
      let version:number;
      if(existing){
        version=existing.latest_version+1;
        db().prepare(`INSERT INTO page_component_versions(component_id,version,code,props_schema,source,created_at) VALUES(?,?,?,?,?,?)`).run(existing.id,version,input.code,input.propsSchema===undefined||input.propsSchema===null?null:JSON.stringify(input.propsSchema),JSON.stringify(source),now);
        db().prepare(`UPDATE page_components SET description=?,active_version=?,latest_version=?,library_revision=?,revocation_epoch=revocation_epoch+1,updated_at=? WHERE id=?`).run(input.description,version,version,revision,now,existing.id);
        row=getRow(workspaceId,ownerUserId,existing.id);
      } else {
        const componentId=`pc-${randomUUID()}`; version=1;
        db().prepare(`INSERT INTO page_components(id,owner_user_id,workspace_id,name,description,enabled,active_version,latest_version,library_revision,revocation_epoch,created_at,updated_at)
          VALUES(?,?,?,?,?,1,1,1,?,1,?,?)`).run(componentId,ownerUserId,workspaceId,input.name,input.description,revision,now,now);
        db().prepare(`INSERT INTO page_component_versions(component_id,version,code,props_schema,source,created_at) VALUES(?,?,?,?,?,?)`).run(componentId,version,input.code,input.propsSchema===undefined||input.propsSchema===null?null:JSON.stringify(input.propsSchema),JSON.stringify(source),now);
        row=getRow(workspaceId,ownerUserId,componentId);
      }
      invalidateReferences(refs(row.id,ownerUserId,workspaceId,false),now);
      return {component:toComponent(row,version),version:dtoVersion(getVersion(row.id,version)),revision};
    });
  }
  activate(workspaceId:string,ownerUserId:string,componentId:string,version:number,args:ComponentMutationOptions):PageComponent {
    return this.change(workspaceId,ownerUserId,componentId,args,(row,revision,now)=>{
      getVersion(componentId,version);
      if(!row.enabled)fail('Enable the component before activating a version',409,'stale_revision');
      db().prepare('UPDATE page_components SET active_version=?,library_revision=?,revocation_epoch=revocation_epoch+1,updated_at=? WHERE id=?').run(version,revision,now,componentId);
      return refs(componentId,ownerUserId,workspaceId,false);
    });
  }
  rollback(workspaceId:string,ownerUserId:string,componentId:string,version:number,args:ComponentMutationOptions):PageComponent {
    return this.activate(workspaceId,ownerUserId,componentId,version,args);
  }
  setEnabled(workspaceId:string,ownerUserId:string,componentId:string,enabled:boolean,args:ComponentMutationOptions):PageComponent {
    if(typeof enabled!=='boolean')fail('Invalid enabled value');
    return this.change(workspaceId,ownerUserId,componentId,args,(row,revision,now)=>{
      db().prepare('UPDATE page_components SET enabled=?,library_revision=?,revocation_epoch=revocation_epoch+1,updated_at=? WHERE id=?').run(enabled?1:0,revision,now,componentId);
      return refs(componentId,ownerUserId,workspaceId,true);
    });
  }
  delete(workspaceId:string,ownerUserId:string,componentId:string,args:ComponentMutationOptions):PageComponent {
    return this.change(workspaceId,ownerUserId,componentId,args,(_row,revision,now)=>{
      db().prepare('UPDATE page_components SET enabled=0,deleted_at=?,library_revision=?,revocation_epoch=revocation_epoch+1,updated_at=? WHERE id=?').run(now,revision,now,componentId);
      return refs(componentId,ownerUserId,workspaceId,true);
    });
  }
  private change(workspaceId:string,ownerUserId:string,componentId:string,args:ComponentMutationOptions,mutate:(row:ComponentRow,revision:number,now:number)=>PageComponentReference[]):PageComponent {
    const now=nowValue(args.now);
    return pagesTransaction(()=>{
      requireUserActor(workspaceId,ownerUserId,args.actor);
      const row=getRow(workspaceId,ownerUserId,componentId); const revision=bumpLibrary(workspaceId,ownerUserId,args.expectedLibraryRevision,now);
      const affected=mutate(row,revision,now); invalidateReferences(affected,now);
      return toComponent(getRow(workspaceId,ownerUserId,componentId,true),Number((db().prepare('SELECT COUNT(*) AS n FROM page_component_versions WHERE component_id=?').get(componentId) as {n:number}).n));
    });
  }
  /** Internal adapter for page/database writers. Validates cross-workspace references and preserves accepted version pins. */
  replaceReferences(ownerUserId:string,workspaceId:string,hostKind:'page_block'|'database_view',hostId:string,refsInput:unknown,now?:number,actor:'user'|'agent'='agent'):void {
    const at=nowValue(now); requirePagesWorkspace(workspaceId,ownerUserId,true);
    if(!Array.isArray(refsInput)||refsInput.length>PAGE_COMPONENT_LIMITS.refsPerComponent)return fail('Invalid component reference batch');
    const referenceInputs=refsInput as unknown[];
    const host=hostKind==='page_block'
      ? db().prepare('SELECT workspace_id,owner_user_id,deleted_at FROM pages WHERE id=?').get(hostId) as {workspace_id:string;owner_user_id:string;deleted_at:number|null}|undefined
      : db().prepare('SELECT workspace_id,owner_user_id,deleted_at FROM page_databases WHERE id=?').get(hostId) as {workspace_id:string;owner_user_id:string;deleted_at:number|null}|undefined;
    if(!host||host.workspace_id!==workspaceId||host.owner_user_id!==ownerUserId||host.deleted_at!==null)fail('Component host not found',404,'not_found');
    const parsed:PageComponentReference[]=[];
    const oldRefs=db().prepare(`SELECT component_id,page_id,block_id,database_id,view_id,pinned_version,protected,host_revision FROM page_component_refs
      WHERE owner_user_id=? AND workspace_id=? AND host_kind=? AND page_id IS ? AND database_id IS ?`).all(ownerUserId,workspaceId,hostKind,hostKind==='page_block'?hostId:null,hostKind==='database_view'?hostId:null) as Array<{
        component_id:string;page_id:string|null;block_id:string|null;database_id:string|null;view_id:string|null;pinned_version:number|null;protected:number;host_revision:number;
      }>;
    if(actor==='agent')for(const old of oldRefs.filter(x=>x.protected===1)){
      const kept=referenceInputs.some(value=>{
        if(!value||typeof value!=='object'||Array.isArray(value))return false;
        const next=value as Record<string,unknown>;
        return next.componentId===old.component_id&&(hostKind==='page_block'?next.blockId===old.block_id:next.viewId===old.view_id)&&
          (next.pinnedVersion??null)===old.pinned_version;
      });
      if(!kept)fail('Agent edits cannot remove or upgrade a protected component host',409,'stale_revision');
    }
    for(const raw of referenceInputs){
      if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('Invalid component reference');
      const r=raw as Record<string,unknown>,componentId=String(r.componentId??''),component=getRow(workspaceId,ownerUserId,componentId);
      const pinned=r.pinnedVersion===undefined||r.pinnedVersion===null?null:Number(r.pinnedVersion);
      if(pinned!==null){if(!Number.isSafeInteger(pinned)||pinned<1)fail('Invalid pinned component version');getVersion(componentId,pinned);}
      if(!Number.isSafeInteger(r.hostRevision)||Number(r.hostRevision)<1)fail('Invalid component host revision');
      const old=oldRefs.find(x=>x.component_id===componentId&&(hostKind==='page_block'?x.block_id===r.blockId:x.view_id===r.viewId));
      if(actor==='agent'&&old?.protected===1&&pinned!==old.pinned_version)fail('Protected component version requires an explicit host edit or proposal',409,'stale_revision');
      const isProtected=(actor==='user'&&r.protected===true)||(actor==='agent'&&old?.protected===1);
      if(isProtected&&pinned===null)fail('Protected component references must pin a version');
      if(hostKind==='page_block'){
        if(typeof r.blockId!=='string'||!r.blockId||r.databaseId!==undefined||r.viewId!==undefined)fail('Invalid page component reference');
        parsed.push({componentId,workspaceId,kind:hostKind,pageId:hostId,blockId:r.blockId as string,pinnedVersion:pinned,protected:isProtected,hostRevision:Number(r.hostRevision)});
      }else{
        if(typeof r.viewId!=='string'||!r.viewId||r.blockId!==undefined||r.pageId!==undefined)fail('Invalid database component reference');
        parsed.push({componentId,workspaceId,kind:hostKind,databaseId:hostId,viewId:r.viewId as string,pinnedVersion:pinned,protected:isProtected,hostRevision:Number(r.hostRevision)});
      }
      if(component.deleted_at!==null||!component.enabled)fail('Component is disabled',409,'stale_revision');
    }
    pagesTransaction(()=>{
      db().prepare('DELETE FROM page_component_refs WHERE owner_user_id=? AND workspace_id=? AND host_kind=? AND page_id IS ? AND database_id IS ?').run(ownerUserId,workspaceId,hostKind,hostKind==='page_block'?hostId:null,hostKind==='database_view'?hostId:null);
      const insert=db().prepare(`INSERT INTO page_component_refs(owner_user_id,workspace_id,component_id,host_kind,page_id,block_id,database_id,view_id,pinned_version,protected,host_revision,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      for(const r of parsed)insert.run(ownerUserId,workspaceId,r.componentId,hostKind,r.pageId??null,r.blockId??null,r.databaseId??null,r.viewId??null,r.pinnedVersion,r.protected?1:0,r.hostRevision,at);
    });
  }
  validateProps(workspaceId:string,ownerUserId:string,componentId:string,version:number,props:unknown):Record<string,unknown>|null {
    const record=this.read(workspaceId,ownerUserId,componentId,version); return validatePageComponentProps(record.propsSchema,props);
  }
}

export const pageComponents = new PageComponents();
