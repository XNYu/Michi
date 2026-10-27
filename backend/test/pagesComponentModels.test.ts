import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePageBlockInput } from '../../shared/src/pages/blocks';
import { parsePageDatabaseOps } from '../../shared/src/pages/database';
import { parseChangeSource } from '../../shared/src/pages/types';

test('native component blocks accept bounded props and version pins only', () => {
  const block = { type: 'component', componentId: 'cmp-1', pinnedVersion: 2, props: { title: 'Review' } };
  assert.deepEqual(parsePageBlockInput(block), block);
  assert.equal(parsePageBlockInput({ ...block, pinnedVersion: 0 }), null);
  assert.equal(parsePageBlockInput({ ...block, props: ['bad'] }), null);
  assert.equal(parsePageBlockInput({ ...block, extra: true }), null);
});

test('custom database views use native component identity and bounded props', () => {
  const op = { op: 'view.save', view: { id: 'v1', name: 'Panel', type: 'custom', config: {
    filters: [], match: 'all', sorts: [], componentId: 'cmp-1', pinnedVersion: 2, props: { title: 'Review' },
  } } };
  assert.equal(parsePageDatabaseOps([op], 'user').ok, true);
  assert.equal(parsePageDatabaseOps([{ ...op, view: { ...op.view, config: { ...op.view.config, code: 'arbitrary source' } } }], 'user').ok, false);
  assert.equal(parsePageDatabaseOps([{ ...op, view: { ...op.view, config: { ...op.view.config, props: [] } } }], 'user').ok, false);
});

test('component attribution accepts exactly one page block or database view host', () => {
  assert.deepEqual(parseChangeSource({ kind: 'component', componentId: 'cmp-1', version: 2, pageId: 'p1', blockId: 'b1' }),
    { kind: 'component', componentId: 'cmp-1', version: 2, pageId: 'p1', blockId: 'b1' });
  assert.deepEqual(parseChangeSource({ kind: 'component', componentId: 'cmp-1', version: 2, databaseId: 'd1', viewId: 'v1' }),
    { kind: 'component', componentId: 'cmp-1', version: 2, databaseId: 'd1', viewId: 'v1' });
  assert.equal(parseChangeSource({ kind: 'component', componentId: 'cmp-1', version: 2, databaseId: 'd1', blockId: 'b1' }), null);
});
