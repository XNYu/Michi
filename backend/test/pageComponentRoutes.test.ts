import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { closeDb, getDb, initDb } from '../src/services/db';
import { setupPageComponentRoutes } from '../src/routes/pageComponents';

let dataDir:string;
let previousDataDir:string|undefined;
let previousCloud:string|undefined;
let server:Server|undefined;
let baseUrl='';

beforeEach(async()=>{
  previousDataDir=process.env.MICHI_DATA_DIR; previousCloud=process.env.MICHI_CLOUD;
  dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'michi-page-component-routes-'));
  process.env.MICHI_DATA_DIR=dataDir; delete process.env.MICHI_CLOUD; closeDb(); initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws','Workspace','alice');
  const app=express(); app.use(express.json());
  app.use((req,_res,next)=>{(req as typeof req & {user:{id:string;email:string}}).user={id:req.header('x-user-id')??'alice',email:'test@example.invalid'};next();});
  app.use('/api',setupPageComponentRoutes());
  server=app.listen(0); await new Promise<void>(resolve=>server!.once('listening',resolve));
  baseUrl=`http://127.0.0.1:${(server!.address() as AddressInfo).port}/api`;
});
afterEach(async()=>{
  if(server)await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
  server=undefined;closeDb();
  if(previousDataDir===undefined)delete process.env.MICHI_DATA_DIR;else process.env.MICHI_DATA_DIR=previousDataDir;
  if(previousCloud===undefined)delete process.env.MICHI_CLOUD;else process.env.MICHI_CLOUD=previousCloud;
  fs.rmSync(dataDir,{recursive:true,force:true});
});

const definition={name:'native-panel',description:'Native panel',code:'<p>hello</p>'};
const savePath='/workspaces/ws/components';
test('native component save attributes the authenticated user and rejects caller-selected provenance',async()=>{
  const saved=await fetch(`${baseUrl}${savePath}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:definition,expectedLibraryRevision:0})});
  assert.equal(saved.status,201);
  const result=await saved.json() as {version:{source:unknown};component:{id:string}};
  assert.deepEqual(result.version.source,{kind:'user'});
  const stored=getDb().prepare('SELECT source FROM page_component_versions WHERE component_id=? AND version=1').get(result.component.id) as {source:string};
  assert.deepEqual(JSON.parse(stored.source),{kind:'user'});

  const forged=await fetch(`${baseUrl}${savePath}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:{...definition,name:'forged-panel'},expectedLibraryRevision:1,source:{kind:'chat',nodeId:'n',turnId:'t',assistantId:'a'}})});
  assert.equal(forged.status,400);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM page_components').get() as {n:number}).n,1);
});
