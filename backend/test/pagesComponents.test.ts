import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'node:test';
import { closeDb, getDb, initDb } from '../src/services/db';
import { PageWriteError } from '../src/services/pages/core';
import { PageComponents } from '../src/services/pages/components';
import { parsePageComponentInput, validatePageComponentProps } from '../../shared/src/pages/components';
import { parseComponentSandboxMessage } from '../../shared/src/pages/sandboxProtocol';

let dir:string;
let oldData:string|undefined;
let oldCloud:string|undefined;
const source={kind:'chat' as const,nodeId:'n',turnId:'t',assistantId:'a'};
const comps=new PageComponents();
const definition=(name='widget',code='<p>Hello</p>',propsSchema?:unknown)=>({name,description:'A component',code,...(propsSchema===undefined?{}:{propsSchema})});
const save=(input:unknown,revision=0)=>comps.save('ws','alice',{input,expectedLibraryRevision:revision,source,now:10});
const mutate=(method:'activate'|'rollback'|'setEnabled'|'delete',id:string,revision:number,...args:unknown[])=>{
  const options={expectedLibraryRevision:revision,actor:{kind:'user' as const},now:20};
  if(method==='activate'||method==='rollback')return comps[method]('ws','alice',id,args[0] as number,options);
  if(method==='setEnabled')return comps.setEnabled('ws','alice',id,args[0] as boolean,options);
  return comps.delete('ws','alice',id,options);
};
beforeEach(()=>{
  oldData=process.env.MICHI_DATA_DIR; oldCloud=process.env.MICHI_CLOUD;
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'michi-page-components-'));
  process.env.MICHI_DATA_DIR=dir; delete process.env.MICHI_CLOUD; closeDb(); initDb();
  const db=getDb();
  db.prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws','Workspace','alice');
  db.prepare("INSERT INTO nodes(id,workspace_id,kind,status) VALUES ('n','ws','chat','idle')").run();
  db.prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES ('t','n','a','active',1,1)").run();
});
afterEach(()=>{closeDb();if(oldData===undefined)delete process.env.MICHI_DATA_DIR;else process.env.MICHI_DATA_DIR=oldData;if(oldCloud===undefined)delete process.env.MICHI_CLOUD;else process.env.MICHI_CLOUD=oldCloud;fs.rmSync(dir,{recursive:true,force:true});});

test('migration creates workspace-scoped component/version/ref storage',()=>{
  const names=getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'page_component%'").all().map((r:any)=>r.name).sort();
  assert.deepEqual(names,['page_component_libraries','page_component_refs','page_component_versions','page_components']);
  assert.ok(getDb().prepare("SELECT version FROM schema_migrations WHERE version='0036_page_components'").get());
});

test('code, metadata, props schema and values are bounded and strictly validated',()=>{
  assert.equal(parsePageComponentInput(definition('Bad Name')),null);
  assert.equal(parsePageComponentInput(definition('valid-name','x'.repeat(200_001))),null);
  assert.equal(parsePageComponentInput({...definition(),surprise:true}),null);
  assert.equal(parsePageComponentInput(definition('widget','<p/>',{type:'object',properties:{count:{type:'integer',minimum:0}},required:['count'],additionalProperties:false}))?.name,'widget');
  assert.equal(parsePageComponentInput(definition('widget','<p/>',{type:'object',patternProperties:{}})),null);
  const schema={type:'object' as const,properties:{count:{type:'integer' as const,minimum:0}},required:['count'],additionalProperties:false};
  assert.deepEqual(validatePageComponentProps(schema,{count:2}),{count:2});
  assert.equal(validatePageComponentProps(schema,{count:-1}),null);
  assert.equal(validatePageComponentProps(schema,{count:2,extra:true}),null);
});

test('save creates immutable monotonic versions and uses workspace library CAS',()=>{
  const first=save(definition());
  assert.equal(first.revision,1); assert.equal(first.version.version,1); assert.equal(first.component.enabled,true);
  assert.throws(()=>save(definition('other'),0),(e:unknown)=>e instanceof PageWriteError&&e.code==='stale_revision');
  const second=save(definition('widget','<p>two</p>'),1);
  assert.equal(second.version.version,2); assert.equal(second.component.activeVersion,2); assert.equal(second.revision,2);
  assert.equal(comps.read('ws','alice',first.component.id,1).code,'<p>Hello</p>');
  assert.equal(comps.read('ws','alice',first.component.id).code,'<p>two</p>');
});

test('trusted UI save records user attribution while agent saves still validate the active source',()=>{
  const item=comps.saveUser('ws','alice',{input:definition(),expectedLibraryRevision:0,now:11});
  assert.deepEqual(item.version.source,{kind:'user'});
  const stored=getDb().prepare('SELECT source FROM page_component_versions WHERE component_id=? AND version=1').get(item.component.id) as {source:string};
  assert.deepEqual(JSON.parse(stored.source),{kind:'user'});
  assert.throws(()=>comps.save('ws','alice',{input:definition('another'),expectedLibraryRevision:1,source:{kind:'user'}} as never),
    (e:unknown)=>e instanceof PageWriteError&&e.status===400);
  getDb().prepare('UPDATE page_component_versions SET source=? WHERE component_id=? AND version=1').run('{"kind":"user","nodeId":"forged"}',item.component.id);
  assert.throws(()=>comps.read('ws','alice',item.component.id),(e:unknown)=>e instanceof PageWriteError&&e.code==='invalid');
});

test('activation, rollback, disable and delete increment epoch and reject stale writes',()=>{
  const first=save(definition()); save(definition('widget','<p>two</p>'),1);
  const switched=mutate('activate',first.component.id,2,1);
  assert.equal(switched.activeVersion,1); assert.equal(switched.revocationEpoch,3);
  const rolled=mutate('rollback',first.component.id,3,2);
  assert.equal(rolled.activeVersion,2); assert.equal(rolled.libraryRevision,4);
  const off=mutate('setEnabled',first.component.id,4,false);
  assert.equal(off.enabled,false); assert.equal(off.revocationEpoch,5);
  assert.throws(()=>comps.read('ws','alice',first.component.id),/disabled/);
  assert.equal(comps.read('ws','alice',first.component.id,1,{includeDisabled:true}).version,1);
  assert.throws(()=>mutate('setEnabled',first.component.id,4,true),(e:unknown)=>e instanceof PageWriteError&&e.code==='stale_revision');
  const deleted=mutate('delete',first.component.id,5);
  assert.equal(deleted.deletedAt,20); assert.equal(deleted.enabled,false);
  assert.throws(()=>comps.read('ws','alice',first.component.id,1,{includeDisabled:true}),(e:unknown)=>e instanceof PageWriteError&&e.status===404);
  const replacement=save(definition(),6);
  assert.notEqual(replacement.component.id,first.component.id); assert.equal(replacement.version.version,1);
});

test('save requires current chat/helper attribution; UI lifecycle requires trusted user actor and enforces owner/workspace isolation',()=>{
  assert.throws(()=>comps.save('ws','alice',{input:definition(),expectedLibraryRevision:0,source:{...source,assistantId:'forged'}}),(e:unknown)=>e instanceof PageWriteError&&e.status===404);
  assert.throws(()=>comps.list('ws','bob'),(e:unknown)=>e instanceof PageWriteError&&e.status===404);
  const item=save(definition());
  assert.throws(()=>comps.read('ws','bob',item.component.id),(e:unknown)=>e instanceof PageWriteError&&e.status===404);
  getDb().prepare("UPDATE turns SET status='completed' WHERE turn_id='t'").run();
  assert.throws(()=>comps.setEnabled('ws','alice',item.component.id,false,{expectedLibraryRevision:1,actor:{kind:'chat'} as unknown as {kind:'user'},now:2}));
  assert.equal(comps.setEnabled('ws','alice',item.component.id,false,{expectedLibraryRevision:1,actor:{kind:'user'},now:2}).enabled,false);
});

test('refs validate same owner/workspace, pin accepted version, and mutations invalidate affected pages',()=>{
  const item=save(definition());
  const db=getDb();
  db.prepare(`INSERT INTO pages(id,owner_user_id,workspace_id,title,blocks,updated_at,created_at) VALUES('p','alice','ws','Page','[]',1,1)`).run();
  comps.replaceReferences('alice','ws','page_block','p',[{componentId:item.component.id,blockId:'b',pinnedVersion:null,protected:false,hostRevision:1}],10);
  assert.equal((db.prepare("SELECT view_version AS n FROM pages WHERE id='p'").get() as {n:number}).n,1);
  const next=save(definition('widget','<p>v2</p>'),1);
  assert.equal((db.prepare("SELECT view_version AS n FROM pages WHERE id='p'").get() as {n:number}).n,2);
  comps.replaceReferences('alice','ws','page_block','p',[{componentId:item.component.id,blockId:'b',pinnedVersion:1,protected:true,hostRevision:2}],12,'user');
  mutate('activate',item.component.id,2,1);
  assert.equal(next.version.version,2);
  assert.equal((db.prepare("SELECT view_version AS n FROM pages WHERE id='p'").get() as {n:number}).n,2,'pinned ref is not invalidated by active-version change');
  assert.throws(()=>comps.replaceReferences('alice','ws','page_block','p',[],14),(e:unknown)=>e instanceof PageWriteError&&e.code==='stale_revision');
  mutate('setEnabled',item.component.id,3,false);
  assert.equal((db.prepare("SELECT view_version AS n FROM pages WHERE id='p'").get() as {n:number}).n,3,'disable invalidates pinned refs too');
  assert.throws(()=>comps.replaceReferences('alice','ws','page_block','p',[{componentId:item.component.id,blockId:'b',pinnedVersion:1,protected:true,hostRevision:3}],15),/disabled/);
});

test('sandbox messages accept only bounded call/error envelopes and known methods',()=>{
  const call={type:'michi-component:call',channel:'a'.repeat(32),id:1,method:'read.host',args:[]};
  assert.deepEqual(parseComponentSandboxMessage(call),call);
  assert.equal(parseComponentSandboxMessage({...call,method:'shell'}),null);
  assert.equal(parseComponentSandboxMessage({...call,channel:'short'}),null);
  assert.equal(parseComponentSandboxMessage({...call,extra:true}),null);
  assert.equal(parseComponentSandboxMessage({type:'michi-component:update',channel:'a'.repeat(32),props:{},data:{rows:Array(2_000).fill({text:'x'.repeat(100)})}}),null);
});

test('a frame theme carries only known palette variables with values that load nothing',()=>{
  const channel='a'.repeat(32);
  const load={type:'michi-component:load',channel,code:'root.textContent="x"',props:{},data:{}};
  const theme={'--term-fg':'#eeeeee','--term-danger-text':'color-mix(in srgb, #e06c75 55%, #eeeeee)','--ui-font':"'Geist', system-ui, sans-serif"};
  assert.deepEqual(parseComponentSandboxMessage(load),load);
  assert.deepEqual(parseComponentSandboxMessage({...load,theme}),{...load,theme});
  assert.deepEqual(parseComponentSandboxMessage({type:'michi-component:theme',channel,theme}),{type:'michi-component:theme',channel,theme});
  assert.equal(parseComponentSandboxMessage({type:'michi-component:theme',channel}),null);
  for(const bad of [{'--term-composer-bg':'#fff'},{color:'red'},{'--term-bg':'url(https://t.example/a.png)'},{'--term-bg':'#fff; background: red'},{'--term-bg':'}body{'},{'--term-bg':''},{'--term-bg':'x'.repeat(301)},{'--term-bg':1}]){
    assert.equal(parseComponentSandboxMessage({...load,theme:bad}),null,JSON.stringify(bad));
    assert.equal(parseComponentSandboxMessage({type:'michi-component:theme',channel,theme:bad}),null,JSON.stringify(bad));
  }
});
