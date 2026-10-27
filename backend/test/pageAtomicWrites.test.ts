import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PageDto } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createPage, getPage } from '../src/services/pages/repository';
import { applyAgentPageEdits, applyUserPageEdits } from '../src/services/pages/pageWrites';
import { listRelevantChanges } from '../src/services/pages/historyRepository';

let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-page-atomic-writes-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws', 'Workspace', 'alice');
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status) VALUES ('n','ws','chat','idle')").run();
  getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES ('t','n','a','active',1,1)").run();
});

afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

const source = { kind: 'chat' as const, nodeId: 'n', turnId: 't', assistantId: 'a' };

function makePage(): PageDto {
  const parent = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', now: 10 });
  return createPage({ workspaceId: 'ws', ownerUserId: 'alice', parentId: parent.id, title: 'Status', now: 11 });
}

function storedState() {
  const db = getDb();
  return {
    pages: db.prepare('SELECT * FROM pages ORDER BY id').all(),
    revisions: db.prepare('SELECT * FROM page_revisions ORDER BY page_id,revision').all(),
    changes: db.prepare('SELECT * FROM page_changes ORDER BY seq').all(),
    heads: db.prepare('SELECT * FROM page_target_heads ORDER BY workspace_id,target_key').all(),
    databaseRefs: db.prepare('SELECT * FROM page_database_refs ORDER BY page_id,database_id').all(),
    componentRefs: db.prepare('SELECT * FROM page_component_refs ORDER BY ref_id').all(),
    changeSequence: db.prepare("SELECT * FROM sqlite_sequence WHERE name='page_changes'").all(),
  };
}

function write(page: PageDto, ops: unknown, options: { atomic?: boolean; now?: number } = {}) {
  return applyAgentPageEdits({
    pageId: page.id, workspaceId: 'ws', ownerUserId: 'alice', source, ops,
    now: options.now ?? 30, ...(options.atomic === undefined ? {} : { atomic: options.atomic }),
  });
}

function textOf(block: PageDto['blocks'][number]): string | undefined {
  return 'text' in block && typeof block.text === 'string' ? block.text : undefined;
}

const rejectedCases: Array<{
  name: string;
  reason: 'invalid' | 'stale' | 'missing';
  operation: (page: PageDto) => unknown;
}> = [
  {
    name: 'malformed operation', reason: 'invalid',
    operation: () => ({ op: 'insert', after: null, block: { type: 'not-a-block' } }),
  },
  {
    name: 'stale block revision', reason: 'stale',
    operation: (page) => ({ op: 'update', id: page.blocks[0]!.id, expectRev: page.blocks[0]!.rev + 1, block: { type: 'markdown', text: 'Stale' } }),
  },
  {
    name: 'missing block', reason: 'missing',
    operation: () => ({ op: 'delete', id: 'missing-block', expectRev: 1 }),
  },
  {
    name: 'invalid page reference', reason: 'invalid',
    operation: () => ({ op: 'insert', after: null, block: { type: 'page-link', pageId: 'missing-page' } }),
  },
];

for (const scenario of rejectedCases) {
  test(`atomic agent batch with a ${scenario.name} leaves page, history and view versions unchanged`, () => {
    const page = makePage();
    const before = storedState();
    const result = write(page, [
      { op: 'insert', after: page.blocks[0]!.id, block: { type: 'markdown', text: 'Must not appear' } },
      scenario.operation(page),
    ], { atomic: true });

    assert.deepEqual(result.resource, { kind: 'page', id: page.id });
    assert.equal(result.revision, page.revision);
    assert.equal(result.viewVersion, page.viewVersion);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.proposed, []);
    assert.ok(result.rejected.some((rejection) => rejection.index === 1 && rejection.reason === scenario.reason && rejection.message.length > 0));
    assert.deepEqual(getPage(page.id, 'alice'), page);
    assert.deepEqual(storedState(), before);
  });
}

test('an atomic delete-and-replace preserves the original block when its replacement is invalid', () => {
  const page = makePage();
  const block = page.blocks[0]!;
  const before = storedState();
  const result = write(page, [
    { op: 'delete', id: block.id, expectRev: block.rev },
    { op: 'insert', after: null, block: { type: 'page-link', pageId: 'missing-page' } },
  ], { atomic: true });

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.proposed, []);
  assert.ok(result.rejected.some((rejection) => rejection.index === 1 && rejection.reason === 'invalid'));
  assert.equal(result.revision, page.revision);
  assert.equal(result.viewVersion, page.viewVersion);
  assert.deepEqual(storedState(), before);
});

for (const proposalFirst of [true, false]) {
  test(`atomic batches reject mixed applied and protected changes with the proposal ${proposalFirst ? 'first' : 'last'}`, () => {
    const initial = makePage();
    const block = initial.blocks[0]!;
    applyUserPageEdits({ pageId: initial.id, ownerUserId: 'alice', revision: initial.revision, now: 20, ops: [
      { op: 'update', id: block.id, expectRev: block.rev, block: { type: 'markdown', text: 'Human decision' } },
    ] });
    const page = getPage(initial.id, 'alice');
    const before = storedState();
    const proposal = { op: 'update', id: block.id, expectRev: page.blocks[0]!.rev, block: { type: 'markdown', text: 'Agent replacement' } };
    const applied = { op: 'insert', after: block.id, block: { type: 'markdown', text: 'Depends on replacement' } };
    const result = write(page, proposalFirst ? [proposal, applied] : [applied, proposal], { atomic: true });

    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.proposed, []);
    assert.ok(result.rejected.some((rejection) => rejection.reason === 'invalid' && rejection.message.length > 0));
    assert.equal(result.revision, page.revision);
    assert.equal(result.viewVersion, page.viewVersion);
    assert.deepEqual(storedState(), before);
  });
}

test('an atomic group of protected edits creates one proposal batch without changing the body revision', () => {
  const initial = makePage();
  applyUserPageEdits({ pageId: initial.id, ownerUserId: 'alice', revision: initial.revision, now: 20, ops: [
    { op: 'update', id: initial.blocks[0]!.id, expectRev: initial.blocks[0]!.rev, block: { type: 'markdown', text: 'Human decision' } },
    { op: 'insert', after: initial.blocks[0]!.id, block: { type: 'markdown', text: 'Human details' } },
  ] });
  const page = getPage(initial.id, 'alice');
  const parent = getPage(page.parentId!, 'alice');
  const before = storedState();
  const result = write(page, [
    { op: 'update', id: page.blocks[0]!.id, expectRev: page.blocks[0]!.rev, block: { type: 'markdown', text: 'Proposed decision' } },
    { op: 'delete', id: page.blocks[1]!.id, expectRev: page.blocks[1]!.rev },
  ], { atomic: true });

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.proposed.length, 2);
  assert.equal(new Set(result.proposed.map((change) => change.batchId)).size, 1);
  assert.ok(result.proposed.every((change) => change.proposalState === 'pending' && change.appliedRev === null));
  const latest = getPage(page.id, 'alice');
  assert.deepEqual(latest.blocks, page.blocks);
  assert.equal(latest.revision, page.revision);
  assert.equal(result.revision, latest.revision);
  assert.equal(latest.pendingProposals, 2);
  assert.equal(latest.viewVersion, page.viewVersion + 1);
  assert.equal(result.viewVersion, latest.viewVersion);
  assert.equal(getPage(parent.id, 'alice').viewVersion, parent.viewVersion + 1);
  const after = storedState();
  assert.deepEqual(after.revisions, before.revisions);
  assert.deepEqual(after.heads, before.heads);
  assert.equal(after.changes.length, before.changes.length + 2);
});

test('a successful atomic group publishes all blocks in one revision and one history batch', () => {
  const page = makePage();
  const parent = getPage(page.parentId!, 'alice');
  const before = storedState();
  const result = write(page, [
    { op: 'update', id: page.blocks[0]!.id, expectRev: page.blocks[0]!.rev, block: { type: 'markdown', text: 'Published status' } },
    { op: 'insert', after: page.blocks[0]!.id, block: { type: 'heading', text: 'Next steps' } },
  ], { atomic: true });

  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.proposed, []);
  assert.equal(result.applied.length, 2);
  assert.equal(new Set(result.applied.map((change) => change.batchId)).size, 1);
  assert.ok(result.applied.every((change) => change.appliedRev === page.revision + 1));
  const latest = getPage(page.id, 'alice');
  assert.deepEqual(latest.blocks.map(textOf), ['Published status', 'Next steps']);
  assert.equal(latest.revision, page.revision + 1);
  assert.equal(result.revision, latest.revision);
  assert.equal(latest.viewVersion, page.viewVersion + 1);
  assert.equal(result.viewVersion, latest.viewVersion);
  assert.equal(getPage(parent.id, 'alice').viewVersion, parent.viewVersion + 1);
  const after = storedState();
  assert.equal(after.revisions.length, before.revisions.length + 1);
  assert.equal(after.changes.length, before.changes.length + 2);
  assert.deepEqual(listRelevantChanges(page.id, 'alice').changes.map((change) => change.id).sort(), result.applied.map((change) => change.id).sort());
});

test('a rejected atomic milestone B retains the exact previously committed milestone A', () => {
  const initial = makePage();
  const committed = write(initial, [
    { op: 'update', id: initial.blocks[0]!.id, expectRev: initial.blocks[0]!.rev, block: { type: 'markdown', text: 'Milestone A' } },
    { op: 'insert', after: initial.blocks[0]!.id, block: { type: 'markdown', text: 'A is ready to read' } },
  ], { atomic: true, now: 20 });
  assert.equal(committed.applied.length, 2);
  const milestoneA = getPage(initial.id, 'alice');
  const before = storedState();
  const history = listRelevantChanges(initial.id, 'alice');
  const rejected = write(milestoneA, [
    { op: 'delete', id: milestoneA.blocks[0]!.id, expectRev: milestoneA.blocks[0]!.rev },
    { op: 'update', id: milestoneA.blocks[1]!.id, expectRev: milestoneA.blocks[1]!.rev + 1, block: { type: 'markdown', text: 'Unfinished B' } },
  ], { atomic: true, now: 30 });

  assert.deepEqual(rejected.applied, []);
  assert.deepEqual(rejected.proposed, []);
  assert.ok(rejected.rejected.some((rejection) => rejection.index === 1 && rejection.reason === 'stale'));
  assert.equal(rejected.revision, committed.revision);
  assert.equal(rejected.viewVersion, committed.viewVersion);
  assert.deepEqual(getPage(initial.id, 'alice'), milestoneA);
  assert.deepEqual(listRelevantChanges(initial.id, 'alice'), history);
  assert.deepEqual(storedState(), before);
});

test('omitting atomic preserves legacy partial commits and reports the rejected operation', () => {
  const page = makePage();
  const result = write(page, [
    { op: 'update', id: page.blocks[0]!.id, expectRev: page.blocks[0]!.rev, block: { type: 'markdown', text: 'Legacy partial success' } },
    { op: 'delete', id: 'missing-block', expectRev: 1 },
  ]);

  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.proposed, []);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0]!.index, 1);
  assert.equal(result.rejected[0]!.reason, 'missing');
  const latest = getPage(page.id, 'alice');
  assert.equal(textOf(latest.blocks[0]!), 'Legacy partial success');
  assert.equal(latest.revision, page.revision + 1);
  assert.equal(result.revision, latest.revision);
  assert.equal(result.viewVersion, latest.viewVersion);
  assert.equal(latest.viewVersion, page.viewVersion + 1);
  assert.equal(listRelevantChanges(page.id, 'alice').changes.length, 1);
});
