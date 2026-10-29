import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createPage, getPage } from '../src/services/pages/repository';
import { applyAgentPageEdits, applyUserPageEdits, PageWriteError } from '../src/services/pages/pageWrites';
import { getChange, getTargetHead, listRelevantChanges, setTargetHead } from '../src/services/pages/historyRepository';
import { acceptProposal, revertBatch, redoBatch, revertChange, redoChange } from '../src/services/pages/pageChanges';

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

test('named views reuse versioned blocks and validate the complete edit group before persisting', () => {
  const page = makePage(), source = addLiveSource(), content = page.blocks[0]!;
  const args = { pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, atomic: true };
  const action = { type: 'open-view', viewId: 'evidence', presentation: 'drawer' };
  const written = applyAgentPageEdits({ ...args, ops: [
    { op: 'update', id: content.id, expectRev: content.rev, block: { type: 'markdown', text: 'Research evidence', visibility: 'detail' } },
    // The entry can precede its definition in one atomic call.
    { op: 'insert', after: null, block: { type: 'view-link', label: 'Why A?', action } },
    { op: 'insert', after: null, block: { type: 'view', viewId: 'evidence', title: 'Evidence', blockIds: [content.id] } },
  ] });
  assert.equal(written.applied.length, 3);
  const saved = getPage(page.id, 'alice');
  assert.equal(saved.blocks.find(b => b.id === content.id)?.visibility, 'detail');
  const count = listRelevantChanges(page.id, 'alice').changes.length;
  assert.throws(() => applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: saved.revision,
    ops: [{ op: 'delete', id: content.id, expectRev: saved.blocks.find(b => b.id === content.id)!.rev }] }), /missing block/);
  assert.throws(() => applyAgentPageEdits({ ...args, ops: [{ op: 'insert', after: null,
    block: { type: 'view', viewId: 'foreign', title: 'Other page', blockIds: ['not-on-this-page'] } }] }), /missing block/);
  assert.equal(getPage(page.id, 'alice').revision, saved.revision);
  assert.equal(listRelevantChanges(page.id, 'alice').changes.length, count);
  const definition = written.applied.find(change => change.after?.kind === 'block' && change.after.exists && change.after.block.type === 'view')!;
  assert.throws(() => revertChange(definition.id, 'alice'), (error: unknown) => error instanceof PageWriteError && error.code === 'undo_conflict');
  const batchId = written.applied[0]!.batchId;
  assert.equal(revertBatch(batchId, 'alice', 'ws').reverted.length, 3);
  assert.deepEqual(getPage(page.id, 'alice').blocks.map(b => ({ ...b, rev: 0 })), page.blocks.map(b => ({ ...b, rev: 0 })));
  assert.equal(redoBatch(batchId, 'alice', 'ws').redone.length, 3);
  const restored = getPage(page.id, 'alice');
  assert.deepEqual(restored.blocks.map(b => ({ ...b, rev: 0 })), saved.blocks.map(b => ({ ...b, rev: 0 })));
  const deleted = applyAgentPageEdits({ ...args, ops: restored.blocks.map(b => ({ op: 'delete', id: b.id, expectRev: b.rev })) });
  assert.equal(deleted.applied.length, saved.blocks.length);
  assert.equal(getPage(page.id, 'alice').blocks.length, 0);
  assert.equal(revertBatch(deleted.applied[0]!.batchId, 'alice', 'ws').reverted.length, 3);
  assert.deepEqual(getPage(page.id, 'alice').blocks.map(b => ({ ...b, rev: 0 })), saved.blocks.map(b => ({ ...b, rev: 0 })));
  assert.equal(redoBatch(deleted.applied[0]!.batchId, 'alice', 'ws').redone.length, 3);
  assert.equal(getPage(page.id, 'alice').blocks.length, 0);
});

test('putting human content in a named view does not bypass its display or edit protection', () => {
  const page = makePage(), source = addLiveSource(), initial = page.blocks[0]!;
  applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: page.revision,
    ops: [{ op: 'update', id: initial.id, expectRev: initial.rev, block: { type: 'markdown', text: 'Keep my text visible' } }] });
  const current = getPage(page.id, 'alice'), block = current.blocks[0]!;
  const args = { pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, atomic: true };
  applyAgentPageEdits({ ...args, ops: [{ op: 'insert', after: null,
    block: { type: 'view', viewId: 'evidence', title: 'Evidence', blockIds: [block.id] } }] });
  assert.equal(getPage(page.id, 'alice').blocks.find(b => b.id === block.id)?.visibility, undefined);
  const proposed = applyAgentPageEdits({ ...args, ops: [{ op: 'update', id: block.id, expectRev: block.rev,
    block: { type: 'markdown', text: 'Keep my text visible', visibility: 'detail' } }] });
  assert.equal(proposed.proposed.length, 1);
  assert.equal(proposed.applied.length, 0);
  assert.equal(getPage(page.id, 'alice').blocks.find(b => b.id === block.id)?.visibility, undefined);
  acceptProposal(proposed.proposed[0]!.id, 'alice');
  assert.equal(getPage(page.id, 'alice').blocks.find(b => b.id === block.id)?.visibility, 'detail');
  revertChange(proposed.proposed[0]!.id, 'alice');
  assert.equal(getPage(page.id, 'alice').blocks.find(b => b.id === block.id)?.visibility, undefined);
  redoChange(proposed.proposed[0]!.id, 'alice');
  assert.equal(getPage(page.id, 'alice').blocks.find(b => b.id === block.id)?.visibility, 'detail');
});

test('a newer user edit rolls back an entire dependent view history group', () => {
  const page = makePage(), source = addLiveSource();
  const written = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, ops: [
    { op: 'insert', after: null, block: { type: 'view-link', label: 'Evidence', action: { type: 'open-view', viewId: 'evidence' } } },
    { op: 'insert', after: null, block: { type: 'view', viewId: 'evidence', title: 'Evidence', blockIds: [page.blocks[0]!.id] } },
  ] });
  const saved = getPage(page.id, 'alice'), entry = saved.blocks.find(b => b.type === 'view-link')!;
  applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: saved.revision, ops: [
    { op: 'update', id: entry.id, expectRev: entry.rev, block: { type: 'view-link', label: 'My evidence', action: { type: 'open-view', viewId: 'evidence' } } },
  ] });
  const before = getPage(page.id, 'alice');
  const result = revertBatch(written.applied[0]!.batchId, 'alice', 'ws');
  assert.equal(result.reverted.length, 0);
  assert.equal(result.conflicts.length, 2);
  assert.deepEqual(getPage(page.id, 'alice'), before);
  for (const change of written.applied) assert.equal(getChange(change.id, 'alice').applicationState, 'applied');
});

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
