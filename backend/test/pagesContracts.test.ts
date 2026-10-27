import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  isPageChangeDto,
  isTargetMutation,
  isTargetSnapshot,
  isValidChangeState,
  parseChangeSource,
  parseChangeTarget,
} from '../../shared/src/pages/types';
import { materializePageTemplate } from '../../shared/src/pages/templates';
import { parsePageBlock } from '../../shared/src/pages/blocks';

describe('native page DTO contracts', () => {
  test('accepts supported source/target variants and rejects forged or unbounded metadata', () => {
    assert.deepEqual(parseChangeSource({ kind: 'user' }), { kind: 'user' });
    assert.equal(parseChangeSource({ kind: 'user', nodeId: 'forged' }), null);
    assert.equal(parseChangeSource({ kind: 'chat', nodeId: 'n', turnId: 't', assistantId: 'a', jobId: 'j' }), null);
    assert.deepEqual(parseChangeSource({ kind: 'maintenance', nodeId: 'n', turnId: 't', assistantId: 'a', jobId: 'j', runId: 'r', evidence: [{ nodeId: 'n2', turnId: 't2', assistantId: 'a2' }] }), {
      kind: 'maintenance', nodeId: 'n', turnId: 't', assistantId: 'a', jobId: 'j', runId: 'r', evidence: [{ nodeId: 'n2', turnId: 't2', assistantId: 'a2' }],
    });
    assert.equal(parseChangeSource({ kind: 'component', componentId: 'c', version: 0, pageId: 'p', blockId: 'b' }), null);
    assert.deepEqual(parseChangeTarget({ kind: 'row', databaseId: 'd', rowId: 'r', columnIds: ['c1'], body: true }), {
      kind: 'row', databaseId: 'd', rowId: 'r', columnIds: ['c1'], body: true,
    });
    assert.equal(parseChangeTarget({ kind: 'row', databaseId: 'd', rowId: 'r', columnIds: Array.from({ length: 101 }, (_, index) => `c${index}`) }), null);
  });

  test('a maintenance source may cite exact messages and say what its run read; records without either still parse', () => {
    const run = { kind: 'maintenance', nodeId: 'n', turnId: 't', assistantId: 'a', jobId: 'j', runId: 'r' };
    // Written before blocks named their sources: every read conversation, no read scope.
    const legacy = { ...run, evidence: [{ nodeId: 'n2', turnId: 't2', assistantId: 'a2' }, { nodeId: 'n3', turnId: 't3', assistantId: 'a3' }] };
    assert.deepEqual(parseChangeSource(legacy), legacy);
    const cited = { ...run, evidence: [{ nodeId: 'n2', turnId: 't2', assistantId: 'a2', messageId: 'u2' }], read: { kind: 'conversations', count: 3 } };
    assert.deepEqual(parseChangeSource(cited), cited);
    const summary = { ...run, evidence: [], read: { kind: 'workspace-homes', count: 5 } };
    assert.deepEqual(parseChangeSource(summary), summary);
    for (const read of [{ kind: 'pages', count: 1 }, { kind: 'conversations', count: -1 }, { kind: 'conversations' }, { kind: 'conversations', count: 2, extra: 1 }, 'conversations']) {
      assert.equal(parseChangeSource({ ...run, evidence: [], read }), null, JSON.stringify(read));
    }
    assert.equal(parseChangeSource({ ...run, evidence: [{ nodeId: 'n2', turnId: 't2', assistantId: 'a2', messageId: '' }] }), null);
    assert.equal(parseChangeSource({ ...run, evidence: [{ nodeId: 'n2', turnId: 't2', assistantId: 'a2', quote: 'x' }] }), null);
  });

  test('enforces independent proposal and application states', () => {
    for (const [proposal, application] of [
      [null, 'applied'], [null, 'reverted'], ['pending', null], ['dismissed', null], ['accepted', 'applied'], ['accepted', 'reverted'],
    ] as const) assert.equal(isValidChangeState(proposal, application), true);
    for (const [proposal, application] of [
      [null, null], ['pending', 'applied'], ['dismissed', 'reverted'], ['accepted', null], ['unknown', 'applied'],
    ] as const) assert.equal(isValidChangeState(proposal, application), false);
  });

  test('validates discriminated structural snapshots and field-scoped row mutations', () => {
    const block = { type: 'markdown', text: 'body', id: 'b-1', rev: 2, edit: { at: 100 }, sources: [{ nodeId: 'n', turnId: 't', assistantId: 'a' }] };
    const blockSnapshot = { kind: 'block', exists: true, block, location: { parentId: null, slot: null, previousId: 'before', nextId: null } };
    assert.equal(isTargetSnapshot(blockSnapshot), true);
    assert.equal(isTargetSnapshot({ ...blockSnapshot, location: { parentId: null, slot: null, previousId: 'before' } }), false);
    assert.equal(isTargetSnapshot({ kind: 'block', exists: false, id: 'b-1', location: null }), true);
    const rowMutation = { kind: 'row', op: 'patch', id: 'r-1', values: { status: 'done' }, edited: { status: 42 } };
    assert.equal(isTargetMutation(rowMutation), true);
    assert.equal(isTargetMutation({ ...rowMutation, values: { status: 'done', other: { invalid: true } } }), false);
    assert.equal(isTargetMutation({ kind: 'row', op: 'replace', row: {} }), false);
    assert.deepEqual(parsePageBlock(block), block);
  });

  test('rejects malformed PageChangeDto state and accepts a typed direct change', () => {
    const snapshot = { kind: 'block', exists: true, block: { type: 'markdown', text: 'x', id: 'b', rev: 1 }, location: { parentId: null, slot: null, previousId: null, nextId: null } };
    const change = {
      id: 'chg-1', seq: 1, batchId: 'batch-1', target: { kind: 'block', pageId: 'p', blockId: 'b' }, op: 'update',
      before: snapshot, after: snapshot,
      forward: { kind: 'block', op: 'upsert', block: snapshot.block, location: snapshot.location },
      inverse: { kind: 'block', op: 'upsert', block: snapshot.block, location: snapshot.location },
      baseRev: 1, appliedRev: 2, previousHeadId: null, source: { kind: 'user' }, proposalState: null,
      applicationState: 'applied', createdAt: 1, resolvedAt: null,
    };
    assert.equal(isPageChangeDto(change), true);
    assert.equal(isPageChangeDto({ ...change, applicationState: null }), false);
    assert.equal(isPageChangeDto({ ...change, forward: { kind: 'unknown', op: 'patch' } }), false);
  });
});

describe('native page templates', () => {
  const materialize = (template: 'blank' | 'release' | 'research' | 'travel', call = 0) => {
    let counter = 0;
    return materializePageTemplate(template, {
      workspaceId: 'ws-1', now: 25 + call,
      idFactory(kind) { counter += 1; return `${kind}-${call}-${counter}`; },
    });
  };

  test('creates valid, unowned blank/research scaffolds at revision one', () => {
    for (const template of ['blank', 'research'] as const) {
      const result = materialize(template);
      assert.equal(result.databases.length, 0);
      assert.ok(result.blocks.length > 0);
      assert.ok(result.blocks.every((block) => block.rev === 1 && block.edit === undefined && block.sources === undefined && parsePageBlock(block)));
    }
    const blankBlocks = materialize('blank').blocks;
    assert.deepEqual(blankBlocks.map((block) => block.type === 'markdown' ? { type: block.type, text: block.text } : null), [{ type: 'markdown', text: '' }]);
  });

  test('release and travel link fresh native databases, views, columns and rows', () => {
    const release = materialize('release');
    const travel = materialize('travel');
    for (const result of [release, travel]) {
      assert.equal(result.databases.length, 1);
      const database = result.databases[0];
      assert.equal(database.revision, 1);
      assert.equal(database.updatedAt, 25);
      assert.equal(database.workspaceId, 'ws-1');
      assert.equal(database.rows.length, 1);
      assert.equal(database.rows[0].rev, 1);
      assert.deepEqual(database.rows[0].edited, {});
      assert.equal(database.rows[0].bodyEditedAt, null);
      const ref = result.blocks.find((block) => block.type === 'database-ref');
      assert.ok(ref && ref.type === 'database-ref');
      assert.equal(ref.databaseId, database.id);
      assert.equal(ref.viewId, database.views[0].id);
      assert.ok(![database.id, database.views[0].id, database.rows[0].id, ...database.columns.map((column) => column.id)].includes('$0'));
      assert.ok(result.blocks.every((block) => block.rev === 1 && block.edit === undefined));
    }
    assert.deepEqual(release.databases[0].columns.map((column) => column.name), ['Task', 'Status', 'Owner']);
    assert.equal(release.databases[0].views[0].type, 'board');
    assert.deepEqual(travel.databases[0].columns.map((column) => column.name), ['Day', 'Date', 'Place', 'Stay', 'Status']);
    assert.equal(travel.databases[0].views[0].type, 'table');
    assert.notEqual(release.databases[0].id, materialize('release', 2).databases[0].id);
  });

  test('default allocator yields distinct IDs and explicit allocator collisions fail', () => {
    const first = materializePageTemplate('release', { workspaceId: 'ws-1' });
    const second = materializePageTemplate('release', { workspaceId: 'ws-1' });
    assert.notEqual(first.databases[0].id, second.databases[0].id);
    assert.throws(() => materializePageTemplate('research', () => 'same-id'), /duplicate id/);
    assert.throws(() => materializePageTemplate('travel'), /workspaceId is required/);
  });
});
