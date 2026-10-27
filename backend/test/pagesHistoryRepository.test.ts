import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { PageWriteError } from '../src/services/pages/core';
import {
  acknowledgePageActivity, dismissPendingProposals, getChange, getPageActivitySeen, getTargetHead, insertChange,
  listChangeBatch, listRelevantChanges, setTargetHead, TASK_ACTIVITY_SQL, targetKey, updateChange,
} from '../src/services/pages/historyRepository';
import type { PageChangeDto } from '../../shared/src/pages/types';

let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pages-history-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  const db = getDb();
  db.prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws','Workspace','alice');
  db.prepare(`INSERT INTO pages(id,owner_user_id,workspace_id,parent_id,position,title,blocks,revision,view_version,updated_at,created_at)
    VALUES ('p','alice','ws',NULL,0,'Page','[]',1,1,1,1)`).run();
  db.prepare(`INSERT INTO page_databases(id,owner_user_id,workspace_id,title,columns_json,views_json,revision,updated_at,created_at)
    VALUES ('d','alice','ws','DB','[]','[]',1,1,1)`).run();
  db.prepare('INSERT INTO page_database_refs(page_id,database_id) VALUES (?,?)').run('p','d');
});

afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

function change(id: string, target: PageChangeDto['target'], proposalState: PageChangeDto['proposalState'] = null): Omit<PageChangeDto, 'seq'> {
  const block = { type: 'markdown' as const, id: 'b1', text: 'hello', rev: 1 };
  const location = { parentId: null, slot: null, previousId: null, nextId: null };
  return {
    id, batchId: 'batch-1', target, op: target.kind === 'row' ? 'row' : 'update',
    before: null, after: null,
    forward: { kind: 'block', op: 'upsert', block, location },
    inverse: { kind: 'block', op: 'delete', id: 'b1', expectedLocation: location },
    baseRev: 1, appliedRev: proposalState === 'pending' ? null : 2, previousHeadId: null,
    source: { kind: 'user' }, proposalState, applicationState: proposalState === 'pending' ? null : 'applied',
    createdAt: 10, resolvedAt: null,
  };
}

test('target keys are canonical and target heads upsert by workspace and key', () => {
  assert.equal(targetKey({ kind: 'block', pageId: 'p', blockId: 'b' }), 'block:p:b');
  assert.equal(targetKey({ kind: 'row', databaseId: 'd', rowId: 'r', columnIds: ['c'] }), 'row:d:r');
  assert.equal(targetKey({ kind: 'database', databaseId: 'd' }), 'database:d');
  assert.equal(getTargetHead('ws', { kind: 'block', pageId: 'p', blockId: 'b' }), null);
  setTargetHead('ws', { kind: 'block', pageId: 'p', blockId: 'b' }, { headId: 'chg-1', targetRevision: 2 });
  setTargetHead('ws', { kind: 'block', pageId: 'p', blockId: 'b' }, { headId: null, targetRevision: 3 });
  assert.deepEqual(getTargetHead('ws', { kind: 'block', pageId: 'p', blockId: 'b' }), { headId: null, targetRevision: 3 });
});

test('inserts validated owner-scoped history with increasing sequence and reads batches', () => {
  const first = insertChange('alice', 'ws', change('chg-1', { kind: 'block', pageId: 'p', blockId: 'b1' }));
  const second = insertChange('alice', 'ws', change('chg-2', { kind: 'block', pageId: 'p', blockId: 'b2' }));
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.deepEqual(listChangeBatch('batch-1', 'alice', 'ws').map((item) => item.id), ['chg-1', 'chg-2']);
  assert.throws(() => getChange('chg-1', 'bob'), (error: unknown) => error instanceof PageWriteError && error.status === 404);
  assert.throws(() => insertChange('bob', 'ws', change('chg-3', { kind: 'block', pageId: 'p', blockId: 'b3' })), /not found/);
  assert.throws(() => insertChange('alice', 'ws', { ...change('bad', { kind: 'block', pageId: 'p', blockId: 'b' }), proposalState: 'pending', applicationState: 'applied' } as never), /Invalid/);
});

test('lifecycle updates preserve immutable content and reject invalid state transitions', () => {
  insertChange('alice', 'ws', change('chg-1', { kind: 'block', pageId: 'p', blockId: 'b1' }, 'pending'));
  const accepted = updateChange('chg-1', 'alice', { proposalState: 'accepted', applicationState: 'applied', resolvedAt: 20 });
  assert.equal(accepted.proposalState, 'accepted');
  assert.equal(accepted.resolvedAt, 20);
  assert.throws(() => updateChange('chg-1', 'alice', { proposalState: 'pending' }), /Invalid change lifecycle/);
  assert.throws(() => updateChange('chg-1', 'alice', { id: 'other' } as never), /Only change lifecycle/);
  assert.equal(getChange('chg-1', 'alice').id, 'chg-1');
});

test('target deletion can dismiss its pending proposals while preserving an excepted proposal', () => {
  insertChange('alice', 'ws', change('dismiss-me', { kind: 'block', pageId: 'p', blockId: 'b1' }, 'pending'));
  insertChange('alice', 'ws', { ...change('keep-me', { kind: 'block', pageId: 'p', blockId: 'b2' }, 'pending'), target: { kind: 'block', pageId: 'p', blockId: 'b1' } });
  assert.equal(dismissPendingProposals('ws', { kind: 'block', pageId: 'p', blockId: 'b1' }, 50, 'keep-me'), 1);
  assert.equal(getChange('dismiss-me', 'alice').proposalState, 'dismissed');
  assert.equal(getChange('dismiss-me', 'alice').resolvedAt, 50);
  assert.equal(getChange('keep-me', 'alice').proposalState, 'pending');
});

test('relevant changes page through the page and its active referenced databases', () => {
  insertChange('alice', 'ws', change('page-change', { kind: 'block', pageId: 'p', blockId: 'b1' }));
  insertChange('alice', 'ws', change('row-change', { kind: 'row', databaseId: 'd', rowId: 'r', columnIds: [] }));
  insertChange('alice', 'ws', change('other-change', { kind: 'block', pageId: 'p', blockId: 'b2' }, 'pending'));
  const page = listRelevantChanges('p', 'alice', { limit: 2 });
  assert.deepEqual(page.changes.map((item) => item.id), ['page-change', 'row-change']);
  assert.equal(page.hasMore, true);
  const next = listRelevantChanges('p', 'alice', { afterSeq: page.nextAfter, proposalState: 'pending' });
  assert.deepEqual(next.changes.map((item) => item.id), ['other-change']);
  const latest = listRelevantChanges('p', 'alice', { direction: 'backward', limit: 2 });
  assert.deepEqual(latest.changes.map((item) => item.id), ['other-change', 'row-change']);
  assert.equal(latest.nextBefore, latest.changes.at(-1)?.seq);
  assert.deepEqual(listRelevantChanges('p', 'alice', { direction: 'backward', beforeSeq: latest.nextBefore!, limit: 2 }).changes.map((item) => item.id), ['page-change']);
  assert.throws(() => listRelevantChanges('p', 'alice', { direction: 'backward', afterSeq: 1 }), /Invalid history/);
  getDb().prepare('UPDATE page_databases SET deleted_at=50 WHERE id=?').run('d');
  assert.deepEqual(listRelevantChanges('p', 'alice').changes.map((item) => item.id), ['page-change', 'other-change']);
});

test('activity acknowledgements are monotonic and bounded to relevant authorized history', () => {
  insertChange('alice', 'ws', change('page-change', { kind: 'block', pageId: 'p', blockId: 'b1' }));
  insertChange('alice', 'ws', change('db-change', { kind: 'row', databaseId: 'd', rowId: 'r', columnIds: [] }));
  getDb().prepare(`INSERT INTO pages(id,owner_user_id,workspace_id,parent_id,position,title,blocks,revision,view_version,updated_at,created_at)
    VALUES ('other','alice','ws',NULL,1,'Other','[]',1,1,1,1)`).run();
  insertChange('alice', 'ws', change('other-change', { kind: 'block', pageId: 'other', blockId: 'b1' }));
  assert.equal(getPageActivitySeen('p', 'alice'), 0);
  assert.equal(acknowledgePageActivity('p', 'alice', 999), 2);
  assert.equal(acknowledgePageActivity('p', 'alice', 1), 2);
  assert.equal(getPageActivitySeen('p', 'alice'), 2);
  assert.throws(() => acknowledgePageActivity('p', 'bob', 2), (error: unknown) => error instanceof PageWriteError && error.status === 404);
});

test('task activity reads go through their indexes, not the database’s whole history', () => {
  const db = getDb();
  const insert = db.prepare(`INSERT INTO page_changes(id,owner_user_id,workspace_id,database_id,target_key,target,batch_id,op,forward_json,inverse_json,base_rev,source,proposal_state,application_state,created_at)
    VALUES (?,?,?,?,?,'{}',?,?,?,?,1,?,?,?,?)`);
  for (let i = 0; i < 200; i += 1) {
    const pending = i % 10 === 0;
    insert.run(`c${i}`, 'alice', 'ws', 'd', `row:d:r${i % 5}`, 'b', 'row', '{}', '{}', '{"kind":"maintenance"}', pending ? 'pending' : null, pending ? null : 'applied', i);
  }
  const plan = (sql: string, params: unknown[]): string =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>).map((row) => row.detail).join('\n');
  assert.match(plan(TASK_ACTIVITY_SQL.pending, ['alice', 'd', 5]), /USING INDEX idx_page_changes_database_pending/);
  assert.match(plan(TASK_ACTIVITY_SQL.upkeep, ['alice', 'd', 100, 5]), /USING INDEX idx_page_changes_database_created/);
  assert.match(plan(TASK_ACTIVITY_SQL.first, ['alice', 'ws', 'd', 'row:d:r1']), /USING INDEX idx_page_changes_target/);
});
