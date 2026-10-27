import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePageBlockInput, splitPageMarkdown, withoutStalePageSegmentSources } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createPage, getPage } from '../src/services/pages/repository';
import { applyAgentPageEdits, applyUserPageEdits } from '../src/services/pages/pageWrites';
import { listRelevantChanges } from '../src/services/pages/historyRepository';
import { acceptProposal, redoChange, revertChange } from '../src/services/pages/pageChanges';
import { citedOps, forgetHomeRunReads, noteReadMessages, withoutSources } from '../src/services/metaAgent/firstRunSources';
import { readNode } from '../src/services/globalContext';

let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;
const a = { nodeId: 'evidence-a', turnId: 'turn-a', assistantId: 'message-a' };
const b = { nodeId: 'evidence-b', turnId: 'turn-b', assistantId: 'message-b' };
const text = '- Alpha\n- Beta';
const content = { type: 'markdown' as const, text, segmentSources: [{ text: '- Alpha', sources: [a] }, { text: '- Beta', sources: [b] }] };
const actor = { kind: 'chat' as const, nodeId: 'writer', turnId: 'writer-turn', assistantId: 'writer-message' };

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR; oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-segment-sources-'));
  process.env.MICHI_DATA_DIR = dir; process.env.MICHI_CLOUD = '1';
  closeDb(); initDb();
  const db = getDb();
  db.prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws', 'Workspace', 'alice');
  for (const source of [a, b, actor]) {
    db.prepare("INSERT INTO nodes(id,workspace_id,kind,status) VALUES (?,'ws','chat','idle')").run(source.nodeId);
    db.prepare("INSERT INTO messages(id,node_id,role,content,seq,created_at) VALUES (?,?,'assistant',?,1,1)").run(source.assistantId, source.nodeId, `Evidence from ${source.nodeId}`);
    db.prepare('INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES (?,?,?,?,1,1)').run(source.turnId, source.nodeId, source.assistantId, source === actor ? 'active' : 'completed');
  }
});
afterEach(() => {
  forgetHomeRunReads('run'); closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('exact segment anchors reject count-preserving rewrites, reorders, malformed sources and extra claims', () => {
  assert.deepEqual(parsePageBlockInput(content), content);
  assert.equal(parsePageBlockInput({ ...content, text: '- Other\n- Beta' }), null);
  assert.equal(parsePageBlockInput({ ...content, text: '- Beta\n- Alpha' }), null);
  assert.equal(parsePageBlockInput({ ...content, segmentSources: content.segmentSources.slice(1) }), null);
  assert.equal(parsePageBlockInput({ ...content, segmentSources: [{ text: '- Alpha', sources: [{ ...a, url: 'https://example.com' }] }, content.segmentSources[1]] }), null);
  assert.deepEqual(withoutStalePageSegmentSources({ ...content, text: '- Edited\n- Beta' }), { type: 'markdown', text: '- Edited\n- Beta' });
  assert.deepEqual(splitPageMarkdown('1. First\n   - Nested\n   ```js\n   x\n   ```\n1. Second\n\n```md\n- not an item\n```').map(segment => segment.kind), ['list-item', 'list-item', 'code']);
});

test('native writes persist exact citations, preserve them on Ignore, invalidate them on edits, and keep history reversible', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', now: 10 });
  const target = page.blocks[0]!;
  const written = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source: actor, ops: [{ op: 'update', id: target.id, expectRev: target.rev, block: content }], now: 20 });
  assert.equal(written.commitStatus, 'committed');
  assert.equal(written.applied.length, 1);
  assert.deepEqual((getPage(page.id, 'alice').blocks[0] as typeof content).segmentSources, content.segmentSources);
  const after = written.applied[0]!.after;
  assert.ok(after?.kind === 'block' && after.exists && after.block.type === 'markdown');
  assert.deepEqual(after.block.segmentSources, content.segmentSources);
  revertChange(written.applied[0]!.id, 'alice', 21);
  assert.equal((getPage(page.id, 'alice').blocks[0] as typeof content).segmentSources, undefined);
  redoChange(written.applied[0]!.id, 'alice', 22);
  const mapped = getPage(page.id, 'alice');
  assert.deepEqual((mapped.blocks[0] as typeof content).segmentSources, content.segmentSources);
  applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: mapped.revision, ops: [{ op: 'update', id: target.id, block: content }], now: 30 });
  const ignored = getPage(page.id, 'alice');
  assert.deepEqual((ignored.blocks[0] as typeof content).segmentSources, content.segmentSources);
  const edited = applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: ignored.revision, ops: [{ op: 'update', id: target.id, block: { type: 'markdown', text: '- Rewritten\n- Beta' } }], now: 40 });
  assert.equal((getPage(page.id, 'alice').blocks[0] as typeof content).segmentSources, undefined);
  const before = edited.applied[0]!.before;
  assert.ok(before?.kind === 'block' && before.exists && before.block.type === 'markdown');
  assert.deepEqual(before.block.segmentSources, content.segmentSources);
});

test('forged or cross-workspace citations reject the entire write before history or other operations change', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', now: 10 });
  const db = getDb();
  db.prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('foreign', 'Foreign', 'bob');
  db.prepare("UPDATE nodes SET workspace_id='foreign' WHERE id=?").run(b.nodeId);
  for (const candidate of [content, { ...content, segmentSources: [{ text: '- Alpha', sources: [{ ...a, assistantId: b.assistantId }] }, { text: '- Beta', sources: [] }] }]) {
    assert.throws(() => applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source: actor, ops: [
      { op: 'insert', after: null, block: { type: 'heading', text: 'Never saved' } },
      { op: 'update', id: page.blocks[0]!.id, expectRev: 1, block: candidate },
    ] }), /segment source/);
    assert.equal(getPage(page.id, 'alice').revision, page.revision);
    assert.equal(listRelevantChanges(page.id, 'alice').changes.length, 0);
  }
});

test('human edits cannot add source claims, including edited proposals', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', now: 10 });
  const id = page.blocks[0]!.id;
  applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: 1, ops: [{ op: 'update', id, block: content }], now: 20 });
  assert.equal((getPage(page.id, 'alice').blocks[0] as typeof content).segmentSources, undefined);
  const proposed = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source: actor, ops: [{ op: 'update', id, expectRev: 2, block: content }], now: 30 });
  const changed = { ...content, text: '- Changed\n- Beta', segmentSources: [{ text: '- Changed', sources: [a] }, content.segmentSources[1]] };
  acceptProposal(proposed.proposed[0]!.id, 'alice', 40, changed);
  assert.equal((getPage(page.id, 'alice').blocks[0] as typeof content).segmentSources, undefined);
});

test('first-run segment citations require read-message evidence and summary runs strip conversation claims', () => {
  const rawOps = [{ op: 'insert', after: null, block: content }];
  const input = { runId: 'run', rawOps, nodeIds: new Set([a.nodeId, b.nodeId]) };
  noteReadMessages('run', a.nodeId, `assistant [message ${a.assistantId}]: Alpha`);
  assert.throws(() => citedOps(input), /read_node showed/);
  noteReadMessages('run', b.nodeId, `assistant [message ${b.assistantId}]: Beta`);
  assert.deepEqual(citedOps(input).evidence, [[a, b]]);
  assert.deepEqual(withoutSources(rawOps, true).ops, [{ op: 'insert', after: null, block: { type: 'markdown', text } }]);
});

test('read_node exposes exact references only for visible, owned assistant messages', () => {
  getDb().prepare("UPDATE workspaces SET settings=? WHERE id='ws'").run(JSON.stringify({ aiGlobalContext: true }));
  const visible = readNode('ws', 'alice', a.nodeId, { messageIds: true, limit: 1 });
  assert.equal(visible.status, 'ok');
  assert.match(visible.text, /Page source references/);
  assert.ok(visible.text.includes(JSON.stringify(a)));
  assert.ok(!visible.text.includes(b.assistantId));
  const ordinary = readNode('ws', 'alice', a.nodeId);
  assert.match(ordinary.text, /assistant \[message message-a\]: Evidence from evidence-a/);
  assert.ok(ordinary.text.includes(JSON.stringify(a)));
  getDb().prepare('DELETE FROM turns WHERE node_id=?').run(a.nodeId);
  const noReference = readNode('ws', 'alice', a.nodeId);
  assert.match(noReference.text, /assistant: Evidence from evidence-a/);
  assert.doesNotMatch(noReference.text, /Page source references|\[message /);
  assert.equal(readNode('ws', 'bob', a.nodeId).status, 'not_found');
});
