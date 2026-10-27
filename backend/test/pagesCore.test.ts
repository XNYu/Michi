import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { PageWriteError, pagesTransaction, requirePagesWorkspace, requireChatChangeSource } from '../src/services/pages/core';

let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;
beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pages-core-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws','Workspace','alice');
});
afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('native migration upgrades the previous schema and preserves existing data', () => {
  const db = getDb();
  // Reconstruct the pre-Pages fixture. Remove the complete feature schema so
  // adding another dependent maintenance/component table cannot leave a dangling
  // foreign key in this artificial downgrade. Production migrations still run
  // below with foreign-key enforcement enabled.
  const featureTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB 'page_*' OR name='pages')")
    .all() as Array<{ name: string }>;
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    for (const { name } of featureTables) db.exec(`DROP TABLE "${name.replaceAll('"', '""')}"`);
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }
  db.exec(`DROP INDEX idx_nodes_active_page_helper; ALTER TABLE nodes DROP COLUMN page_id;
    ALTER TABLE nodes DROP COLUMN maintenance_job_id;
    DELETE FROM schema_migrations WHERE version IN ('0034_pages','0035_page_maintenance','0036_page_components','0037_node_maintenance_identity','0039_spaces_home');`);
  closeDb(); initDb();
  assert.equal((getDb().prepare("SELECT name FROM workspaces WHERE id='ws'").get() as {name:string}).name, 'Workspace');
  assert.ok(getDb().prepare("SELECT name FROM sqlite_master WHERE name='page_target_heads'").get());
  assert.deepEqual(getDb().prepare('PRAGMA foreign_key_check').all(), []);
  closeDb(); initDb();
  assert.ok(requirePagesWorkspace('ws','alice'));
});

test('nested page transactions roll back the entire content and ledger unit', () => {
  assert.throws(() => pagesTransaction(() => {
    getDb().prepare("UPDATE workspaces SET name='Outer' WHERE id='ws'").run();
    pagesTransaction(() => { getDb().prepare("UPDATE workspaces SET name='Inner' WHERE id='ws'").run(); });
    throw new Error('receipt failed');
  }), /receipt failed/);
  assert.equal(requirePagesWorkspace('ws','alice').name, 'Workspace');
  pagesTransaction(() => {
    assert.throws(() => pagesTransaction(() => {
      getDb().prepare("UPDATE workspaces SET name='Failed' WHERE id='ws'").run();
      throw new Error('inner');
    }), /inner/);
    getDb().prepare("UPDATE workspaces SET name='Committed' WHERE id='ws'").run();
  });
  assert.equal(requirePagesWorkspace('ws','alice').name, 'Committed');
});

test('owner, system, archive and live chat source boundaries are enforced', () => {
  const missing = (fn: () => unknown) => assert.throws(fn, (e:unknown) => e instanceof PageWriteError && e.status === 404);
  missing(() => requirePagesWorkspace('ws','bob'));
  getDb().prepare("UPDATE workspaces SET settings=? WHERE id='ws'").run('{"system":"assistant"}');
  missing(() => requirePagesWorkspace('ws','alice'));
  getDb().prepare("UPDATE workspaces SET settings=NULL,archived_at=10 WHERE id='ws'").run();
  assert.ok(requirePagesWorkspace('ws','alice'));
  assert.throws(() => requirePagesWorkspace('ws','alice',true), /read-only/);
  getDb().prepare("UPDATE workspaces SET archived_at=NULL WHERE id='ws'").run();
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status) VALUES ('n','ws','chat','idle')").run();
  getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES ('t','n','a','active',1,1)").run();
  const source = {kind:'chat' as const,nodeId:'n',turnId:'t',assistantId:'a'};
  requireChatChangeSource('ws','alice',source);
  missing(() => requireChatChangeSource('ws','alice',{...source,assistantId:'forged'}));
  missing(() => requireChatChangeSource('ws','alice',{...source,kind:'helper'}));
  getDb().prepare("UPDATE turns SET status='completed' WHERE turn_id='t'").run();
  missing(() => requireChatChangeSource('ws','alice',source));
});

test('a chat source from another workspace is refused, but for the owner\'s Meta agent chat', () => {
  const missing = (fn: () => unknown) => assert.throws(fn, (e:unknown) => e instanceof PageWriteError && e.status === 404);
  const db = getDb();
  db.prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('other','Other','alice');
  db.prepare('INSERT INTO workspaces(id,name,owner_user_id,settings,created_at,updated_at) VALUES (?,?,?,?,1,1)').run('meta','Michi assistant','alice','{"system":"assistant"}');
  db.prepare('INSERT INTO workspaces(id,name,owner_user_id,settings,created_at,updated_at) VALUES (?,?,?,?,1,1)').run('meta-bob','Michi assistant','bob','{"system":"assistant"}');
  for (const [node, workspace] of [['n-other','other'],['n-meta','meta'],['n-bob','meta-bob']]) {
    db.prepare("INSERT INTO nodes(id,workspace_id,kind,status) VALUES (?,?,'chat','idle')").run(node, workspace);
    db.prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES (?,?,?,'active',1,1)").run(`t-${node}`, node, `a-${node}`);
  }
  const source = (node: string, kind: 'chat' | 'helper' = 'chat') => ({ kind, nodeId: node, turnId: `t-${node}`, assistantId: `a-${node}` });
  missing(() => requireChatChangeSource('ws','alice',source('n-other')));
  requireChatChangeSource('ws','alice',source('n-meta'));
  missing(() => requireChatChangeSource('ws','alice',source('n-meta','helper')));
  missing(() => requireChatChangeSource('ws','alice',source('n-bob')));
  process.env.MICHI_CLOUD = '1';
  missing(() => requireChatChangeSource('ws','alice',source('n-meta')));
});
