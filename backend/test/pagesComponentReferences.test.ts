import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { PageWriteError } from '../src/services/pages/core';
import { PageComponents } from '../src/services/pages/components';
import { createPage, getDatabase, getPage, saveDatabase, savePageContent } from '../src/services/pages/repository';

let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;
const components = new PageComponents();
const source = { kind: 'chat' as const, nodeId: 'n', turnId: 't', assistantId: 'a' };

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR; oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-page-component-refs-'));
  process.env.MICHI_DATA_DIR = dir; delete process.env.MICHI_CLOUD; closeDb(); initDb();
  const db = getDb();
  db.prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws','Workspace','alice');
  db.prepare("INSERT INTO nodes(id,workspace_id,kind,status) VALUES ('n','ws','chat','idle')").run();
  db.prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES ('t','n','a','active',1,1)").run();
});
afterEach(() => {
  closeDb(); if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saving page blocks and database custom views indexes scoped pinned protected references', () => {
  const component = components.save('ws','alice',{ input: { name:'review-panel', description:'Review panel', code:'<p>ok</p>', propsSchema:{ type:'object', properties:{ title:{type:'string'} }, required:['title'], additionalProperties:false } }, expectedLibraryRevision:0, source, now:2 });
  const page = createPage({ workspaceId:'ws', ownerUserId:'alice', title:'Page', template:'release', now:3 });
  const blockId = 'custom-block';
  savePageContent(page.id,'alice',{ ...page, revision:2, blocks:[...page.blocks,{ type:'component', componentId:component.component.id, pinnedVersion:1, props:{ title:'Hello' }, id:blockId, rev:2, edit:{ at:4 } }] },
    { source:{ kind:'user' }, now:4, expectedRevision:1 });
  const blockRef = getDb().prepare("SELECT pinned_version,protected,host_revision FROM page_component_refs WHERE page_id=? AND block_id=?").get(page.id,blockId) as {pinned_version:number;protected:number;host_revision:number};
  assert.deepEqual({ ...blockRef },{pinned_version:1,protected:1,host_revision:2});
  const updatedPage = getPage(page.id,'alice');
  assert.throws(() => savePageContent(page.id,'alice',{ ...updatedPage, revision:3, blocks:updatedPage.blocks.filter((block) => block.id !== blockId) },
    { source, now:5, expectedRevision:2 }), (error: unknown) => error instanceof PageWriteError && error.code === 'stale_revision');

  const ref = page.blocks.find((block) => block.type === 'database-ref');
  assert.ok(ref && ref.type === 'database-ref');
  const database = getDatabase(ref.databaseId,'alice');
  const base = database.views[0]!;
  saveDatabase({ ...database, revision:2, views:[{ ...base, type:'custom', edit:{ at:6 }, config:{ filters:[], match:'all', sorts:[], componentId:component.component.id, pinnedVersion:1, props:{ title:'Database' } } }] },
    'alice',{ now:6, actor:'user' });
  const viewRef = getDb().prepare("SELECT pinned_version,protected,host_revision FROM page_component_refs WHERE database_id=? AND view_id=?").get(ref.databaseId,base.id) as {pinned_version:number;protected:number;host_revision:number};
  assert.deepEqual({ ...viewRef },{pinned_version:1,protected:1,host_revision:2});
});

test('editing a sibling page block or database row does not adopt untouched agent component refs', () => {
  const component = components.save('ws','alice',{ input:{ name:'passive-panel', description:'Agent panel', code:'<p>ok</p>' }, expectedLibraryRevision:0, source, now:2 });
  const page = createPage({ workspaceId:'ws', ownerUserId:'alice', title:'Agent page', template:'release', now:3 });
  const blockId = 'agent-component';
  savePageContent(page.id,'alice',{ ...page, revision:2, blocks:[...page.blocks,
    { type:'component', componentId:component.component.id, props:{}, id:blockId, rev:2, sources:[{ nodeId:'n', turnId:'t', assistantId:'a' }] }] },
    { source, now:4, expectedRevision:1 });
  let current = getPage(page.id,'alice');
  const ordinary = current.blocks.find((block) => block.type === 'markdown')!;
  savePageContent(page.id,'alice',{ ...current, revision:3, blocks:current.blocks.map((block) => block.id === ordinary.id ? { ...block, text:'Human edit', rev:3, edit:{ at:5 } } : block) },
    { source:{ kind:'user' }, now:5, expectedRevision:2 });
  const blockRef = getDb().prepare("SELECT pinned_version,protected FROM page_component_refs WHERE page_id=? AND block_id=?").get(page.id,blockId) as {pinned_version:number|null;protected:number};
  assert.deepEqual({ ...blockRef },{pinned_version:null,protected:0});
  current = getPage(page.id,'alice');
  assert.equal((current.blocks.find((block) => block.id === blockId) as {pinnedVersion?:number}).pinnedVersion, undefined);

  const databaseRef = page.blocks.find((block) => block.type === 'database-ref');
  assert.ok(databaseRef && databaseRef.type === 'database-ref');
  const database = getDatabase(databaseRef.databaseId,'alice');
  const base = database.views[0]!;
  saveDatabase({ ...database, revision:2, views:[{ ...base, type:'custom', config:{ filters:[], match:'all', sorts:[], componentId:component.component.id, props:{} } }] },
    'alice',{ now:6, actor:'agent' });
  const afterView = getDatabase(database.id,'alice');
  const firstColumnId = afterView.columns[0]!.id;
  saveDatabase({ ...afterView, revision:3, rows:afterView.rows.map((row) => ({ ...row, values:{ ...row.values, [firstColumnId]:'human row edit' } })) },'alice',{ now:7, actor:'user' });
  const viewRef = getDb().prepare("SELECT pinned_version,protected FROM page_component_refs WHERE database_id=? AND view_id=?").get(database.id,base.id) as {pinned_version:number|null;protected:number};
  assert.deepEqual({ ...viewRef },{pinned_version:null,protected:0});
  assert.equal(getDatabase(database.id,'alice').views[0]?.config.pinnedVersion,undefined);
});
