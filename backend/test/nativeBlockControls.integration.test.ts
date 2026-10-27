import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createPage, getPage } from '../src/services/pages/repository';
import { applyAgentPageEdits, applyUserPageEdits } from '../src/services/pages/pageWrites';
import { listRelevantChanges } from '../src/services/pages/historyRepository';

test('block ignore prevents automatic overwrites; archive preserves content and source history after reopening SQLite', () => {
  const originalData = process.env.MICHI_DATA_DIR;
  const originalCloud = process.env.MICHI_CLOUD;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-block-controls-'));
  process.env.MICHI_DATA_DIR = data;
  delete process.env.MICHI_CLOUD;
  closeDb();
  try {
    initDb();
    getDb().prepare("INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES ('ws','Workspace','alice',1,1)").run();
    getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status) VALUES ('node','ws','chat','idle')").run();
    getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES ('turn','node','assistant','active',1,1)").run();
    const source = { kind: 'chat' as const, nodeId: 'node', turnId: 'turn', assistantId: 'assistant' };
    const created = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Notes', now: 10 });
    applyAgentPageEdits({ pageId: created.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 20,
      ops: [{ op: 'insert', after: null, block: { type: 'markdown', text: 'Keep this content' } }] });
    let page = getPage(created.id, 'alice');
    const block = page.blocks[0]!;
    applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: page.revision, now: 30,
      ops: [{ op: 'update', id: block.id, expectRev: block.rev, block: { type: 'markdown', text: 'Keep this content' } }] });
    page = getPage(page.id, 'alice');
    assert.deepEqual(page.blocks[0]!.edit, { at: 30 });
    const proposed = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 40,
      ops: [{ op: 'update', id: block.id, expectRev: page.blocks[0]!.rev, block: { type: 'markdown', text: 'Automatic replacement' } }] });
    assert.equal(proposed.applied.length, 0);
    assert.equal(proposed.proposed.length, 1);
    page = getPage(page.id, 'alice');
    assert.equal(page.blocks[0]!.type === 'markdown' && page.blocks[0]!.text, 'Keep this content');
    const archive = applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: page.revision, now: 50,
      ops: [{ op: 'delete', id: block.id, expectRev: page.blocks[0]!.rev }] });
    const id = archive.applied[0]!.id;
    closeDb();
    initDb();
    assert.equal(getPage(page.id, 'alice').blocks.some(item => item.id === block.id), false);
    const recorded = listRelevantChanges(page.id, 'alice').changes.find(change => change.id === id)!;
    assert.equal(recorded.before?.kind, 'block');
    assert.ok(recorded.before?.kind === 'block' && recorded.before.exists);
    const archived = recorded.before.block;
    assert.equal(archived.type === 'markdown' && archived.text, 'Keep this content');
    assert.deepEqual(archived.sources, [source].map(({ kind: _kind, ...tuple }) => tuple));
    assert.equal(getDb().prepare("SELECT status FROM nodes WHERE id = 'node'").get()!.status, 'idle');
  } finally {
    closeDb();
    if (originalData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = originalData;
    if (originalCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = originalCloud;
    fs.rmSync(data, { recursive: true, force: true });
  }
});
