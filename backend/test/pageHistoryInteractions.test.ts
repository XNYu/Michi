import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createDatabase, createPage, getDatabase, getPage, updatePageMetadata } from '../src/services/pages/repository';
import { applyAgentDbEdits } from '../src/services/pages/databaseWrites';
import { revertBatch } from '../src/services/pages/pageChanges';

let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-page-history-interactions-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)')
    .run('ws', 'Workspace', 'alice');
});

afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a metadata write invalidates the page view exactly once', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Before', now: 10 });
  const initial = getPage(page.id, 'alice');

  const updated = updatePageMetadata(page.id, 'alice', { title: 'After' }, { expectedRevision: initial.revision, now: 20 });

  assert.equal(updated.viewVersion, initial.viewVersion + 1);
});

test('undoing a batch that deletes adjacent rows restores rows in an order that keeps anchors available', () => {
  const database = createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', now: 10,
    columns: [{ id: 'task', name: 'Task', type: 'text' }], views: [], rows: [
      { id: 'r0', position: 0, values: { task: 'Keep' }, rev: 1, edited: {}, bodyEditedAt: null, updatedAt: 10 },
      { id: 'r1', position: 1, values: { task: 'First' }, rev: 1, edited: {}, bodyEditedAt: null, updatedAt: 10 },
      { id: 'r2', position: 2, values: { task: 'Second' }, rev: 1, edited: {}, bodyEditedAt: null, updatedAt: 10 },
    ],
  });
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status) VALUES ('node','ws','chat','idle')").run();
  getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES ('turn','node','assistant','active',1,1)").run();
  const deletion = applyAgentDbEdits({ databaseId: database.id, workspaceId: 'ws', ownerUserId: 'alice',
    source: { kind: 'chat', nodeId: 'node', turnId: 'turn', assistantId: 'assistant' }, now: 20,
    ops: [{ op: 'row.delete', id: 'r1', expectRev: 1 }, { op: 'row.delete', id: 'r2', expectRev: 1 }],
  });
  assert.equal(deletion.applied.length, 2);

  const undo = revertBatch(deletion.applied[0]!.batchId, 'alice', 'ws', 21);

  assert.deepEqual(undo.conflicts, []);
  assert.deepEqual([...undo.reverted].sort(), deletion.applied.map((change) => change.id).sort());
  assert.deepEqual(getDatabase(database.id, 'alice').rows.map((row) => row.id), ['r0', 'r1', 'r2']);
});
