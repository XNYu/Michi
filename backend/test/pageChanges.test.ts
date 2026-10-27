import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createDatabase, createPage, getDatabase, getPage, saveDatabase } from '../src/services/pages/repository';
import { applyAgentPageEdits, applyUserPageEdits } from '../src/services/pages/pageWrites';
import { applyAgentDbEdits, applyUserDatabaseEdits, configureDatabaseView } from '../src/services/pages/databaseWrites';
import { pageComponents } from '../src/services/pages/components';
import { acceptProposal, dismissProposal, redoBatch, redoChange, reopenProposal, revertBatch, revertChange } from '../src/services/pages/pageChanges';
import { PageWriteError } from '../src/services/pages/core';
import type { PageBlock } from 'michi-shared';

let dir: string;
let priorDataDir: string | undefined;
let priorCloud: string | undefined;

beforeEach(() => {
  priorDataDir = process.env.MICHI_DATA_DIR;
  priorCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-page-changes-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws', 'Workspace', 'alice');
});

afterEach(() => {
  closeDb();
  if (priorDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = priorDataDir;
  if (priorCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = priorCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeActiveChatSource() {
  const db = getDb();
  db.prepare("INSERT INTO nodes(id,workspace_id,kind,status) VALUES ('node','ws','chat','idle')").run();
  db.prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES ('turn','node','assistant','active',1,1)").run();
  return { kind: 'chat' as const, nodeId: 'node', turnId: 'turn', assistantId: 'assistant' };
}

function blockText(pageId: string, id: string): string {
  const block = getPage(pageId, 'alice').blocks.find((item) => item.id === id);
  assert.ok(block && block.type === 'markdown');
  return block.text;
}

test('block update, deletion, undo and redo keep revisions monotonic and preserve structural anchors', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'History', now: 10 });
  const initialBlockIds = getPage(page.id, 'alice').blocks.map((block) => block.id);
  const source = makeActiveChatSource();
  const insert = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 11,
    ops: [{ op: 'insert', block: { type: 'markdown', text: 'before' }, after: null }] });
  const inserted = insert.applied[0]!;
  const blockId = inserted.target.kind === 'block' ? inserted.target.blockId : '';
  let current = getPage(page.id, 'alice');
  const existing = current.blocks.find((block) => block.id === blockId)!;
  const edit = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 12,
    ops: [{ op: 'update', id: blockId, expectRev: existing.rev, block: { type: 'markdown', text: 'after' } }] });
  const update = edit.applied[0]!;
  const revAfterEdit = getPage(page.id, 'alice').revision;
  assert.equal(blockText(page.id, blockId), 'after');
  assert.equal(revertChange(update.id, 'alice', 13).applicationState, 'reverted');
  assert.equal(blockText(page.id, blockId), 'before');
  assert.equal(redoChange(update.id, 'alice', 14).applicationState, 'applied');
  assert.equal(blockText(page.id, blockId), 'after');
  current = getPage(page.id, 'alice');
  const currentBlock = current.blocks.find((block) => block.id === blockId)!;
  const remove = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 15,
    ops: [{ op: 'delete', id: blockId, expectRev: currentBlock.rev }] });
  const deletion = remove.applied[0]!;
  assert.equal(remove.rejected.length, 0, JSON.stringify(remove));
  assert.deepEqual(getPage(page.id, 'alice').blocks.map((block) => block.id), initialBlockIds);
  revertChange(deletion.id, 'alice', 16);
  assert.equal(blockText(page.id, blockId), 'after');
  redoChange(deletion.id, 'alice', 17);
  assert.deepEqual(getPage(page.id, 'alice').blocks.map((block) => block.id), initialBlockIds);
  assert.ok(getPage(page.id, 'alice').revision > revAfterEdit);
});

test('accepted block proposal retains agent source and human edit through undo and redo', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Protected', now: 20 });
  const inserted = applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: page.revision, now: 21,
    ops: [{ op: 'insert', block: { type: 'markdown', text: 'person' }, after: null }] });
  const blockId = inserted.applied[0]!.target.kind === 'block' ? inserted.applied[0]!.target.blockId : '';
  const source = makeActiveChatSource();
  const block = getPage(page.id, 'alice').blocks.find((item) => item.id === blockId)!;
  const proposed = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 22,
    ops: [{ op: 'update', id: blockId, expectRev: block.rev, block: { type: 'markdown', text: 'suggestion' } }] });
  const proposal = proposed.proposed[0]!;
  assert.equal(blockText(page.id, blockId), 'person');
  const accepted = acceptProposal(proposal.id, 'alice', 23);
  assert.equal(accepted.proposalState, 'accepted');
  assert.equal(blockText(page.id, blockId), 'suggestion');
  let after = getPage(page.id, 'alice').blocks.find((item) => item.id === blockId)!;
  assert.equal(after.edit?.at, 23);
  assert.deepEqual(after.sources, [{ nodeId: source.nodeId, turnId: source.turnId, assistantId: source.assistantId }]);
  revertChange(proposal.id, 'alice', 24);
  assert.equal(blockText(page.id, blockId), 'person');
  assert.equal(accepted.proposalState, 'accepted');
  assert.equal(redoChange(proposal.id, 'alice', 25).proposalState, 'accepted');
  after = getPage(page.id, 'alice').blocks.find((item) => item.id === blockId)!;
  assert.equal(blockText(page.id, blockId), 'suggestion');
  assert.equal(after.edit?.at, 23);
  assert.deepEqual(after.sources, [{ nodeId: source.nodeId, turnId: source.turnId, assistantId: source.assistantId }]);
});

test('accepting a protected component block pins the acceptance version and keeps that pin through undo and redo', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Component block', now: 26 });
  const source = makeActiveChatSource();
  const component = pageComponents.save('ws', 'alice', { expectedLibraryRevision: 0, source, now: 27, input: {
    name: 'block-renderer', description: 'Block renderer', code: 'export default () => null;',
  } });
  const inserted = applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: page.revision, now: 28,
    ops: [{ op: 'insert', block: { type: 'component', componentId: component.component.id, props: {} }, after: null }] });
  const blockId = inserted.applied[0]!.target.kind === 'block' ? inserted.applied[0]!.target.blockId : '';
  const block = getPage(page.id, 'alice').blocks.find((item) => item.id === blockId)!;
  assert.equal(block.type, 'component');
  if (block.type === 'component') assert.equal(block.pinnedVersion, 1);
  const proposal = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 29,
    ops: [{ op: 'update', id: blockId, expectRev: block.rev,
      block: { type: 'component', componentId: component.component.id, pinnedVersion: 1, props: { label: 'approved' } } }] }).proposed[0]!;
  pageComponents.save('ws', 'alice', { expectedLibraryRevision: 1, source, now: 30, input: {
    name: 'block-renderer', description: 'Block renderer', code: 'export default () => null; // version 2',
  } });

  acceptProposal(proposal.id, 'alice', 31);
  let accepted = getPage(page.id, 'alice').blocks.find((item) => item.id === blockId)!;
  assert.equal(accepted.type, 'component');
  if (accepted.type === 'component') {
    assert.equal(accepted.pinnedVersion, 1);
    assert.deepEqual(accepted.edit, { at: 31 });
  }
  revertChange(proposal.id, 'alice', 32);
  let restored = getPage(page.id, 'alice').blocks.find((item) => item.id === blockId)!;
  assert.equal(restored.type, 'component');
  if (restored.type === 'component') assert.equal(restored.pinnedVersion, 1);
  redoChange(proposal.id, 'alice', 33);
  accepted = getPage(page.id, 'alice').blocks.find((item) => item.id === blockId)!;
  assert.equal(accepted.type, 'component');
  if (accepted.type === 'component') assert.equal(accepted.pinnedVersion, 1);
});

test('row proposal acceptance changes only proposed protected cells and keeps other row fields', () => {
  const database = createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Checklist', now: 30,
    columns: [{ id: 'status', name: 'Status', type: 'text' }, { id: 'owner', name: 'Owner', type: 'text' }], views: [],
    rows: [{ id: 'row-1', position: 0, values: { status: 'Todo', owner: 'Mina' }, body: 'notes', rev: 1, edited: { status: 1 }, bodyEditedAt: 2, updatedAt: 3 }] });
  const source = makeActiveChatSource();
  const result = applyAgentDbEdits({ databaseId: database.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 31,
    ops: [{ op: 'row.update', id: 'row-1', expectRev: 1, values: { status: 'Ready', owner: 'Ada' } }] });
  assert.equal(result.applied.length, 1);
  assert.equal(result.proposed.length, 1);
  const proposal = result.proposed[0]!;
  let row = getDatabase(database.id, 'alice').rows[0]!;
  assert.deepEqual(row.values, { status: 'Todo', owner: 'Ada' });
  assert.equal(row.body, 'notes');
  acceptProposal(proposal.id, 'alice', 32, { kind: 'row', values: { status: 'Doing' } });
  row = getDatabase(database.id, 'alice').rows[0]!;
  assert.deepEqual(row.values, { status: 'Doing', owner: 'Ada' });
  assert.equal(row.edited.status, 32);
  assert.equal(row.body, 'notes');
  revertChange(proposal.id, 'alice', 33);
  row = getDatabase(database.id, 'alice').rows[0]!;
  assert.deepEqual(row.values, { status: 'Todo', owner: 'Ada' });
  assert.equal(row.edited.status, 1);
  redoChange(proposal.id, 'alice', 34);
  row = getDatabase(database.id, 'alice').rows[0]!;
  assert.deepEqual(row.values, { status: 'Doing', owner: 'Ada' });
  assert.equal(row.edited.status, 32);
});

test('accepted protected view proposal pins its acceptance-time component version and round-trips exact snapshots', () => {
  const source = makeActiveChatSource();
  const component = pageComponents.save('ws', 'alice', { expectedLibraryRevision: 0, source, now: 30, input: {
    name: 'view-renderer', description: 'View renderer', code: 'export default () => null;',
  } });
  const database = createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Views', now: 31,
    columns: [{ id: 'task', name: 'Task', type: 'text' }], views: [
      { id: 'protected', name: 'Protected', type: 'table', position: 0, config: { filters: [], match: 'all', sorts: [] } },
      { id: 'sibling', name: 'Sibling', type: 'table', position: 1, config: { filters: [], match: 'all', sorts: [] } },
    ], rows: [] });
  saveDatabase({ ...database, revision: 2, views: [
    { ...database.views[0]!, type: 'custom', edit: { at: 32 }, config: {
      filters: [], match: 'all', sorts: [], componentId: component.component.id, pinnedVersion: 1, props: { label: 'original' },
    } },
    { ...database.views[1]!, type: 'custom', edit: { at: 32 }, config: {
      filters: [], match: 'all', sorts: [], componentId: component.component.id, pinnedVersion: 1, props: { label: 'untouched' },
    } },
  ] }, 'alice', { now: 32, actor: 'user' });
  const siblingBefore = structuredClone(getDatabase(database.id, 'alice').views[1]);
  const proposal = configureDatabaseView({ databaseId: database.id, workspaceId: 'ws', ownerUserId: 'alice', revision: 2,
    viewId: 'protected', componentId: component.component.id, pinnedVersion: 1, props: { label: 'agent suggestion' }, source, now: 33 }).proposed[0]!;
  assert.equal(proposal.target.kind, 'database');
  assert.equal(getDatabase(database.id, 'alice').revision, 2);
  pageComponents.save('ws', 'alice', { expectedLibraryRevision: 1, source, now: 34, input: {
    name: 'view-renderer', description: 'View renderer', code: 'export default () => null; // version 2',
  } });

  const accepted = acceptProposal(proposal.id, 'alice', 35, { kind: 'view', config: { props: { label: 'human approved' } } });
  let current = getDatabase(database.id, 'alice');
  assert.equal(accepted.proposalState, 'accepted');
  assert.equal(accepted.source.kind, 'chat');
  assert.equal(current.views[0]?.type, 'custom');
  if (current.views[0]?.type === 'custom') {
    assert.equal(current.views[0].config.pinnedVersion, 1);
    assert.deepEqual(current.views[0].config.props, { label: 'human approved' });
    assert.deepEqual(current.views[0].edit, { at: 35 });
  }
  assert.deepEqual(current.views[1], siblingBefore);
  assert.equal(revertChange(proposal.id, 'alice', 36).applicationState, 'reverted');
  current = getDatabase(database.id, 'alice');
  assert.equal(current.views[0]?.type, 'custom');
  if (current.views[0]?.type === 'custom') {
    assert.equal(current.views[0].config.pinnedVersion, 1);
    assert.deepEqual(current.views[0].config.props, { label: 'original' });
  }
  assert.equal(redoChange(proposal.id, 'alice', 37).applicationState, 'applied');
  current = getDatabase(database.id, 'alice');
  assert.equal(current.views[0]?.type, 'custom');
  if (current.views[0]?.type === 'custom') {
    assert.equal(current.views[0].config.pinnedVersion, 1);
    assert.deepEqual(current.views[0].config.props, { label: 'human approved' });
  }
  assert.deepEqual(current.views[1], siblingBefore);
});

test('dismiss and reopen are idempotent, and a later target head makes an old proposal stale', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Proposal', now: 40 });
  const result = applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: page.revision, now: 41,
    ops: [{ op: 'insert', block: { type: 'markdown', text: 'human' }, after: null }] });
  const blockId = result.applied[0]!.target.kind === 'block' ? result.applied[0]!.target.blockId : '';
  const source = makeActiveChatSource();
  const current = getPage(page.id, 'alice').blocks[0]!;
  const proposal = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 42,
    ops: [{ op: 'update', id: blockId, expectRev: current.rev, block: { type: 'markdown', text: 'suggested' } }] }).proposed[0]!;
  assert.equal(dismissProposal(proposal.id, 'alice', 43).proposalState, 'dismissed');
  assert.equal(dismissProposal(proposal.id, 'alice', 44).proposalState, 'dismissed');
  assert.equal(reopenProposal(proposal.id, 'alice', 45).proposalState, 'pending');
  const edited = getPage(page.id, 'alice');
  applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: edited.revision, now: 46,
    ops: [{ op: 'update', id: blockId, block: { type: 'markdown', text: 'new human value' } }] });
  assert.throws(() => acceptProposal(proposal.id, 'alice', 47), (error: unknown) => error instanceof PageWriteError && error.code === 'proposal_stale');
});

test('revertBatch reverses a multi-target batch newest first', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Batch', now: 50 });
  const initialBlockIds = getPage(page.id, 'alice').blocks.map((block) => block.id);
  const source = makeActiveChatSource();
  const inserted = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 51,
    ops: [{ op: 'insert', block: { type: 'markdown', text: 'one' }, after: null },
      { op: 'insert', block: { type: 'markdown', text: 'two' }, after: null }] });
  assert.equal(inserted.applied.length, 2);
  assert.equal(inserted.applied[0]!.batchId, inserted.applied[1]!.batchId);
  const batch = revertBatch(inserted.applied[0]!.batchId, 'alice', 'ws', 52);
  assert.deepEqual(batch.reverted, [inserted.applied[1]!.id, inserted.applied[0]!.id]);
  assert.deepEqual(batch.conflicts, []);
  assert.deepEqual(getPage(page.id, 'alice').blocks.map((block) => block.id), initialBlockIds);
});

test('revertBatch reverts unaffected targets and reports an identical-content intervening user write as a conflict', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Partial undo', now: 60 });
  const source = makeActiveChatSource();
  const inserted = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 61,
    ops: [{ op: 'insert', block: { type: 'markdown', text: 'first' }, after: null },
      { op: 'insert', block: { type: 'markdown', text: 'second' }, after: null }] });
  const ids = inserted.applied.map((change) => change.target.kind === 'block' ? change.target.blockId : '');
  const blocks = getPage(page.id, 'alice').blocks;
  const batchWrite = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 62,
    ops: ids.map((id, index) => ({ op: 'update' as const, id, expectRev: blocks.find((block) => block.id === id)!.rev,
      block: { type: 'markdown' as const, text: `changed ${index}` } })) });
  assert.equal(batchWrite.applied.length, 2);
  const batch = batchWrite.applied[0]!.batchId;
  const firstId = ids[0]!;
  const first = getPage(page.id, 'alice').blocks.find((block) => block.id === firstId)!;
  const user = getPage(page.id, 'alice');
  applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: user.revision, now: 63,
    ops: [{ op: 'update', id: firstId, block: { type: 'markdown', text: 'changed 0' } }] });

  const result = revertBatch(batch, 'alice', 'ws', 64);
  assert.deepEqual(result.reverted, [batchWrite.applied[1]!.id]);
  assert.deepEqual(result.conflicts.map((item) => item.changeId), [batchWrite.applied[0]!.id]);
  assert.equal(blockText(page.id, firstId), 'changed 0');
  assert.equal(blockText(page.id, ids[1]!), 'second');
  assert.notEqual(first.rev, getPage(page.id, 'alice').blocks.find((block) => block.id === firstId)!.rev);
});

test('metrics, next-steps and timeline blocks write, protect human edits as proposals, and undo like other blocks', () => {
  const source = makeActiveChatSource();
  const blocks = [
    { type: 'metrics' as const, items: [{ label: 'Branches in dev', value: '6', note: 'Scheduled jobs' }] },
    { type: 'next-steps' as const, title: 'Next steps', items: [{ who: 'user' as const, text: 'Confirm the rewrite', unblocks: 'Release notes' }] },
    { type: 'timeline' as const, title: 'Progress', items: [{ title: 'Merged', at: '2026-10-22T05:35', tone: 'success' as const }] },
  ];
  const revised = [
    { type: 'metrics' as const, items: [{ label: 'Branches in dev', value: '7', tone: 'accent' as const }] },
    { type: 'next-steps' as const, title: 'Next steps', items: [{ who: 'agent' as const, text: 'Run the rollback cases' }] },
    { type: 'timeline' as const, title: 'Progress', items: [{ title: 'Released', at: 1_792_682_460_000, detail: 'Tagged.' }] },
  ];
  blocks.forEach((content, index) => {
    const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: `Typed ${content.type}`, now: 300 });
    const inserted = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 301,
      ops: [{ op: 'insert', block: content, after: null }] });
    assert.equal(inserted.applied.length, 1, JSON.stringify(inserted.rejected));
    const blockId = inserted.applied[0]!.target.kind === 'block' ? inserted.applied[0]!.target.blockId : '';
    const stored = () => getPage(page.id, 'alice').blocks.find((block) => block.id === blockId)!;
    const strip = (block: PageBlock) => { const { id: _id, rev: _rev, sources: _sources, edit: _edit, ...rest } = block; return rest; };
    assert.deepEqual(strip(stored()), content);

    const agentUpdate = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 302,
      ops: [{ op: 'update', id: blockId, expectRev: stored().rev, block: revised[index] }] });
    assert.equal(agentUpdate.applied.length, 1);
    assert.deepEqual(strip(stored()), revised[index]);
    revertChange(agentUpdate.applied[0]!.id, 'alice', 303);
    assert.deepEqual(strip(stored()), content);
    redoChange(agentUpdate.applied[0]!.id, 'alice', 304);
    assert.deepEqual(strip(stored()), revised[index]);

    const human = applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: getPage(page.id, 'alice').revision, now: 305,
      ops: [{ op: 'update', id: blockId, expectRev: stored().rev, block: content }] });
    assert.equal(human.applied.length, 1);
    assert.equal(stored().edit?.at, 305);
    const proposed = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 306,
      ops: [{ op: 'update', id: blockId, expectRev: stored().rev, block: revised[index] }] });
    assert.equal(proposed.applied.length, 0);
    assert.equal(proposed.proposed.length, 1);
    assert.deepEqual(strip(stored()), content, 'a human-edited block keeps its content until the proposal is accepted');
    acceptProposal(proposed.proposed[0]!.id, 'alice', 307);
    assert.deepEqual(strip(stored()), revised[index]);
    revertChange(proposed.proposed[0]!.id, 'alice', 308);
    assert.deepEqual(strip(stored()), content);

    const deletion = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 309,
      ops: [{ op: 'delete', id: blockId, expectRev: stored().rev }] });
    assert.equal(deletion.proposed.length, 1, 'deleting a human-edited block is only proposed');
    assert.ok(stored());
  });
});

test('revertBatch puts back a person’s own row edit; a single revert still refuses it, and a later edit makes it a conflict', () => {
  const database = createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Moves', now: 70,
    columns: [{ id: 'status', name: 'Status', type: 'text' }], views: [],
    rows: [{ id: 'row-1', position: 0, values: { status: 'Todo' }, rev: 1, edited: {}, bodyEditedAt: null, updatedAt: 70 }] });
  const moved = applyUserDatabaseEdits({ databaseId: database.id, ownerUserId: 'alice', revision: database.revision, now: 71,
    ops: [{ op: 'row.update', id: 'row-1', expectRev: 1, values: { status: 'Done' } }] });
  const change = moved.applied[0]!;
  assert.throws(() => revertChange(change.id, 'alice', 72), (error: unknown) => error instanceof PageWriteError && error.status === 409);
  assert.deepEqual(revertBatch(change.batchId, 'alice', 'ws', 73), { reverted: [change.id], conflicts: [] });
  let row = getDatabase(database.id, 'alice').rows[0]!;
  assert.deepEqual(row.values, { status: 'Todo' });
  assert.equal(row.edited.status, undefined);

  const again = applyUserDatabaseEdits({ databaseId: database.id, ownerUserId: 'alice', revision: getDatabase(database.id, 'alice').revision, now: 74,
    ops: [{ op: 'row.update', id: 'row-1', expectRev: row.rev, values: { status: 'Done' } }] });
  row = getDatabase(database.id, 'alice').rows[0]!;
  applyUserDatabaseEdits({ databaseId: database.id, ownerUserId: 'alice', revision: getDatabase(database.id, 'alice').revision, now: 75,
    ops: [{ op: 'row.update', id: 'row-1', expectRev: row.rev, values: { status: 'Blocked' } }] });
  const late = revertBatch(again.applied[0]!.batchId, 'alice', 'ws', 76);
  assert.deepEqual(late.reverted, []);
  assert.deepEqual(late.conflicts.map((item) => item.changeId), [again.applied[0]!.id]);
  assert.deepEqual(getDatabase(database.id, 'alice').rows[0]!.values, { status: 'Blocked' });
});

test('redoBatch puts back every row a revertBatch removed, exactly, and reports a row edited since as a conflict', () => {
  const database = createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Tasks', now: 90,
    columns: [{ id: 'task', name: 'Task', type: 'text' }], views: [], rows: [] });
  const added = applyAgentDbEdits({ databaseId: database.id, workspaceId: 'ws', ownerUserId: 'alice', source: makeActiveChatSource(), now: 91,
    ops: [1, 2, 3].map((n) => ({ op: 'row.add' as const, values: { task: `Task ${n}` } })) });
  const batch = added.applied[0]!.batchId;
  const before = getDatabase(database.id, 'alice').rows.map((row) => ({ id: row.id, values: row.values, position: row.position }));
  assert.equal(before.length, 3);
  assert.equal(revertBatch(batch, 'alice', 'ws', 92).reverted.length, 3);
  assert.equal(getDatabase(database.id, 'alice').rows.length, 0);
  assert.deepEqual(redoBatch(batch, 'alice', 'ws', 93), { redone: added.applied.map((change) => change.id), conflicts: [] });
  assert.deepEqual(getDatabase(database.id, 'alice').rows.map((row) => ({ id: row.id, values: row.values, position: row.position })), before);
  // Nothing left to redo.
  assert.deepEqual(redoBatch(batch, 'alice', 'ws', 94), { redone: [], conflicts: [] });
  // Owner isolation: another owner sees no such batch.
  assert.throws(() => redoBatch(batch, 'bob', 'ws', 95), (error: unknown) => error instanceof PageWriteError && error.status === 404);
});

test('redoBatch redoes deletions in the reverse of their undo order', () => {
  const source = makeActiveChatSource();
  const run = (ids: string[], removed: string[]) => {
    const database = createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Tasks', now: 110,
      columns: [{ id: 'task', name: 'Task', type: 'text' }], views: [],
      rows: ids.map((id, position) => ({ id, position, values: { task: id }, rev: 1, edited: {}, bodyEditedAt: null, updatedAt: 110 })) });
    const deleted = applyAgentDbEdits({ databaseId: database.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 111,
      ops: removed.map((id) => ({ op: 'row.delete' as const, id, expectRev: 1 })) });
    const batch = deleted.applied[0]!.batchId;
    const remaining = () => getDatabase(database.id, 'alice').rows.map((row) => row.id);
    const after = remaining();
    assert.equal(revertBatch(batch, 'alice', 'ws', 112).conflicts.length, 0);
    assert.deepEqual(remaining(), ids);
    const result = redoBatch(batch, 'alice', 'ws', 113);
    assert.equal(result.redone.length, removed.length);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(remaining(), after);
  };
  run(['a', 'b', 'c'], ['a', 'b']);
  run(['a', 'b', 'c', 'd'], ['a', 'b', 'c']);
});

test('a mixed agent batch undoes and restores without false conflicts, twice', () => {
  const source = makeActiveChatSource();
  const mk = (title: string, ids: string[]) => createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title, now: 120,
    columns: [{ id: 'task', name: 'Task', type: 'text' }], views: [],
    rows: ids.map((id, position) => ({ id, position, values: { task: id }, rev: 1, edited: {}, bodyEditedAt: null, updatedAt: 120 })) });
  const snap = (databaseId: string) => getDatabase(databaseId, 'alice').rows.map((row) => ({ id: row.id, position: row.position, values: row.values }));
  const cycle = (databaseId: string, ops: Array<Record<string, unknown>>, expected: number) => {
    const original = snap(databaseId);
    const written = applyAgentDbEdits({ databaseId, workspaceId: 'ws', ownerUserId: 'alice', source, now: 121, ops: ops as never });
    assert.equal(written.applied.length, expected);
    // The write leaves stored positions as they were; redo renumbers them, so compare the order and cells.
    const ordered = (databaseId: string) => snap(databaseId).map(({ id, values }) => ({ id, values }));
    const post = ordered(databaseId);
    const batch = written.applied[0]!.batchId;
    for (let round = 0; round < 2; round += 1) {
      assert.deepEqual(revertBatch(batch, 'alice', 'ws', 122 + round).conflicts, []);
      assert.deepEqual(snap(databaseId), original);
      assert.deepEqual(redoBatch(batch, 'alice', 'ws', 130 + round).conflicts, []);
      assert.deepEqual(ordered(databaseId), post);
    }
  };
  cycle(mk('Mixed', ['a', 'b', 'c']).id, [
    { op: 'row.delete', id: 'a', expectRev: 1 }, { op: 'row.update', id: 'c', expectRev: 1, values: { task: 'C2' } },
    { op: 'row.add', values: { task: 'T' } }], 3);
  cycle(mk('Adds at top', ['e']).id, [1, 2, 3].map((n) => ({ op: 'row.add', values: { task: `T${n}` }, after: null })), 3);
  cycle(mk('Deletes', ['a', 'b', 'c', 'd']).id, ['a', 'b', 'c'].map((id) => ({ op: 'row.delete', id, expectRev: 1 })), 3);
});

test('undo and redo survive an earlier delete that left a gap in stored positions', () => {
  const source = makeActiveChatSource();
  const mk = (title: string) => createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title, now: 140,
    columns: [{ id: 'task', name: 'Task', type: 'text' }], views: [],
    rows: ['a', 'b', 'c'].map((id, position) => ({ id, position, values: { task: id }, rev: 1, edited: {}, bodyEditedAt: null, updatedAt: 140 })) });
  const cells = (databaseId: string) => getDatabase(databaseId, 'alice').rows.map((row) => [row.id, row.values.task]);
  const alone = mk('Gap');
  const deleted = applyUserDatabaseEdits({ databaseId: alone.id, ownerUserId: 'alice', revision: alone.revision, now: 141, ops: [{ op: 'row.delete', id: 'a', expectRev: 1 }] });
  assert.equal(deleted.applied.length, 1);
  const cRev = getDatabase(alone.id, 'alice').rows.find((row) => row.id === 'c')!.rev;
  const updated = applyAgentDbEdits({ databaseId: alone.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 142,
    ops: [{ op: 'row.update', id: 'c', expectRev: cRev, values: { task: 'C2' } }] });
  const batch = updated.applied[0]!.batchId;
  assert.deepEqual(revertBatch(batch, 'alice', 'ws', 143).conflicts, []);
  assert.deepEqual(cells(alone.id), [['b', 'b'], ['c', 'c']]);
  assert.deepEqual(redoBatch(batch, 'alice', 'ws', 144).conflicts, []);
  assert.deepEqual(cells(alone.id), [['b', 'b'], ['c', 'C2']]);

  const mixed = mk('Mixed gap');
  const written = applyAgentDbEdits({ databaseId: mixed.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 145,
    ops: [{ op: 'row.delete', id: 'a', expectRev: 1 }, { op: 'row.update', id: 'c', expectRev: 1, values: { task: 'C2' } }] });
  const post = cells(mixed.id);
  for (let round = 0; round < 2; round += 1) {
    assert.deepEqual(revertBatch(written.applied[0]!.batchId, 'alice', 'ws', 146 + round).conflicts, []);
    assert.deepEqual(cells(mixed.id), [['a', 'a'], ['b', 'b'], ['c', 'c']]);
    assert.deepEqual(redoBatch(written.applied[0]!.batchId, 'alice', 'ws', 150 + round).conflicts, []);
    assert.deepEqual(cells(mixed.id), post);
  }
});

test('a row appended after a delete reads last and its batch undoes and redoes cleanly', () => {
  const database = createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Append', now: 160,
    columns: [{ id: 'task', name: 'Task', type: 'text' }], views: [],
    rows: ['a', 'b', 'z'].map((id, position) => ({ id, position, values: { task: id }, rev: 1, edited: {}, bodyEditedAt: null, updatedAt: 160 })) });
  const written = applyAgentDbEdits({ databaseId: database.id, workspaceId: 'ws', ownerUserId: 'alice', source: makeActiveChatSource(), now: 161,
    ops: [{ op: 'row.delete', id: 'a', expectRev: 1 }, { op: 'row.add', values: { task: 'NEW' } }] });
  const tasks = () => getDatabase(database.id, 'alice').rows.map((row) => row.values.task);
  assert.deepEqual(tasks(), ['b', 'z', 'NEW']);
  const batch = written.applied[0]!.batchId;
  assert.deepEqual(revertBatch(batch, 'alice', 'ws', 162).conflicts, []);
  assert.deepEqual(tasks(), ['a', 'b', 'z']);
  assert.deepEqual(redoBatch(batch, 'alice', 'ws', 163).conflicts, []);
  assert.deepEqual(tasks(), ['b', 'z', 'NEW']);
});

test('redoBatch reports a conflict when the target changed again after the undo', () => {
  const database = createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Moves', now: 96,
    columns: [{ id: 'status', name: 'Status', type: 'text' }], views: [],
    rows: [{ id: 'row-1', position: 0, values: { status: 'Todo' }, rev: 1, edited: {}, bodyEditedAt: null, updatedAt: 96 }] });
  const moved = applyUserDatabaseEdits({ databaseId: database.id, ownerUserId: 'alice', revision: database.revision, now: 97,
    ops: [{ op: 'row.update', id: 'row-1', expectRev: 1, values: { status: 'Done' } }] });
  const change = moved.applied[0]!;
  revertBatch(change.batchId, 'alice', 'ws', 98);
  const row = getDatabase(database.id, 'alice').rows[0]!;
  applyUserDatabaseEdits({ databaseId: database.id, ownerUserId: 'alice', revision: getDatabase(database.id, 'alice').revision, now: 99,
    ops: [{ op: 'row.update', id: 'row-1', expectRev: row.rev, values: { status: 'Blocked' } }] });
  const result = redoBatch(change.batchId, 'alice', 'ws', 100);
  assert.deepEqual(result.redone, []);
  assert.deepEqual(result.conflicts.map((item) => item.changeId), [change.id]);
  assert.deepEqual(getDatabase(database.id, 'alice').rows[0]!.values, { status: 'Blocked' });
});

test('reverting an agent-added row succeeds, but a row whose list cell was reordered since still conflicts', () => {
  const database = createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Tasks', now: 80,
    columns: [{ id: 'task', name: 'Task', type: 'text' }, { id: 'tags', name: 'Tags', type: 'multi' }], views: [], rows: [] });
  const source = makeActiveChatSource();
  const added = applyAgentDbEdits({ databaseId: database.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 81,
    ops: [{ op: 'row.add', values: { task: 'One', tags: ['a', 'b'] } }] });
  assert.equal(added.applied.length, 1);
  revertChange(added.applied[0]!.id, 'alice', 82);
  assert.equal(getDatabase(database.id, 'alice').rows.length, 0);
  redoChange(added.applied[0]!.id, 'alice', 83);
  const row = getDatabase(database.id, 'alice').rows[0]!;
  applyUserDatabaseEdits({ databaseId: database.id, ownerUserId: 'alice', revision: getDatabase(database.id, 'alice').revision, now: 84,
    ops: [{ op: 'row.update', id: row.id, expectRev: row.rev, values: { tags: ['b', 'a'] } }] });
  assert.throws(() => revertChange(added.applied[0]!.id, 'alice', 85), (error: unknown) => error instanceof PageWriteError && error.status === 409);
});
