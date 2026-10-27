import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createPage, getPage } from '../src/services/pages/repository';
import { applyAgentPageEdits, applyUserPageEdits, PageWriteError } from '../src/services/pages/pageWrites';
import { getChange, getTargetHead, listRelevantChanges, setTargetHead } from '../src/services/pages/historyRepository';

let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-page-writes-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws', 'Workspace', 'alice');
});

afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

function makePage() {
  return createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', now: 10 });
}

function blockText(value: unknown): string | undefined {
  return value && typeof value === 'object' && 'text' in value ? (value as { text: string }).text : undefined;
}

function addLiveSource() {
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status) VALUES ('n','ws','chat','idle')").run();
  getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES ('t','n','a','active',1,1)").run();
  return { kind: 'chat' as const, nodeId: 'n', turnId: 't', assistantId: 'a' };
}

test('user edits coalesce each target into one atomic change batch and reject stale page revisions', () => {
  const page = makePage();
  const initial = page.blocks[0]!;
  const result = applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: page.revision, now: 20, ops: [
    { op: 'update', id: initial.id, expectRev: initial.rev, block: { type: 'markdown', text: 'Draft' } },
    { op: 'update', id: initial.id, expectRev: page.revision + 1, block: { type: 'markdown', text: 'Final' } },
    { op: 'insert', after: initial.id, block: { type: 'heading', text: 'Next' } },
  ] });
  assert.equal(result.applied.length, 2);
  assert.equal(result.proposed.length, 0);
  assert.equal(result.revision, page.revision + 1);
  const blockChange = result.applied.find((change) => change.target.kind === 'block' && change.target.blockId === initial.id)!;
  assert.equal(blockChange.before && (blockChange.before as { block: { text: string } }).block.text, '');
  assert.equal(blockChange.after && (blockChange.after as { block: { text: string } }).block.text, 'Final');
  assert.equal(result.applied[0]?.batchId, result.applied[1]?.batchId);
  assert.throws(() => applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: page.revision, ops: [] }),
    (error: unknown) => error instanceof PageWriteError && error.code === 'stale_revision');
  assert.equal(blockText(getPage(page.id, 'alice').blocks[0]), 'Final');
  assert.equal(listRelevantChanges(page.id, 'alice').changes.length, 2);
  const latest = getPage(page.id, 'alice');
  assert.throws(() => applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: latest.revision, ops: [
    { op: 'insert', after: null, block: { type: 'page-link', pageId: 'missing-page' } },
  ] }), (error: unknown) => error instanceof PageWriteError && error.code === 'not_found');
  assert.equal(getPage(page.id, 'alice').revision, latest.revision);
  assert.equal(listRelevantChanges(page.id, 'alice').changes.length, 2);
});

test('agent changes on a fresh block apply, while edits to protected blocks become proposals without content revision', () => {
  const page = makePage();
  const source = addLiveSource();
  const block = page.blocks[0]!;
  const human = applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: page.revision, now: 15, ops: [
    { op: 'update', id: block.id, expectRev: block.rev, block: { type: 'markdown', text: 'Human' } },
  ] });
  const protectedPage = getPage(page.id, 'alice');
  const target = { kind: 'block' as const, pageId: page.id, blockId: block.id };
  const head = getTargetHead('ws', target)!;
  setTargetHead('ws', target, { ...head, targetRevision: protectedPage.blocks[0]!.rev + 10 });
  const proposed = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 30, ops: [
    { op: 'update', id: block.id, expectRev: protectedPage.blocks[0]!.rev, block: { type: 'markdown', text: 'Agent idea' } },
  ] });
  assert.equal(human.revision, page.revision + 1);
  assert.equal(proposed.applied.length, 0);
  assert.equal(proposed.proposed.length, 1, JSON.stringify(proposed));
  assert.equal(proposed.revision, protectedPage.revision);
  assert.equal(proposed.proposed[0]?.proposalState, 'pending');
  assert.equal(proposed.proposed[0]?.baseRev, protectedPage.blocks[0]!.rev);
  assert.equal(blockText(getPage(page.id, 'alice').blocks[0]), 'Human');
  assert.equal(getPage(page.id, 'alice').pendingProposals, 1);
  assert.equal(getPage(page.id, 'alice').viewVersion, protectedPage.viewVersion + 1);
  const proposedChange = proposed.proposed[0]!;
  const headBeforeDelete = getTargetHead('ws', target)!;
  const deleted = applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: protectedPage.revision, now: 40, ops: [
    { op: 'delete', id: block.id, expectRev: protectedPage.blocks[0]!.rev },
  ] });
  assert.equal(deleted.applied.length, 1);
  assert.equal(getChange(proposedChange.id, 'alice').proposalState, 'dismissed');
  assert.ok(getTargetHead('ws', target)!.targetRevision > headBeforeDelete.targetRevision);
});

test('agent writes reject stale and duplicate existing targets independently and protect workspace scope', () => {
  const base = makePage();
  applyUserPageEdits({ pageId: base.id, ownerUserId: 'alice', revision: base.revision, now: 15, ops: [
    { op: 'insert', after: null, block: { type: 'markdown', text: 'Second' } },
  ] });
  const page = getPage(base.id, 'alice');
  const source = addLiveSource();
  const block = page.blocks[0]!;
  const second = page.blocks[1]!;
  const result = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 30, ops: [
    { op: 'update', id: block.id, expectRev: block.rev + 1, block: { type: 'markdown', text: 'stale' } },
    { op: 'update', id: second.id, expectRev: second.rev, block: { type: 'markdown', text: 'Agent' } },
    { op: 'delete', id: second.id, expectRev: second.rev },
  ] });
  assert.equal(result.rejected.length, 2);
  assert.equal(result.rejected[0]?.reason, 'stale');
  assert.equal(result.rejected[1]?.reason, 'invalid');
  assert.equal(result.applied.length, 1);
  assert.equal(getPage(page.id, 'alice').blocks.length, 2);
  assert.equal(blockText(getPage(page.id, 'alice').blocks[1]), 'Agent');
  assert.throws(() => applyAgentPageEdits({ pageId: page.id, workspaceId: 'elsewhere', ownerUserId: 'alice', source, ops: [] }),
    (error: unknown) => error instanceof PageWriteError && error.status === 404);
});
