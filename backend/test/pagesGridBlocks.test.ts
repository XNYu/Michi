import assert from 'node:assert/strict';
import { test } from 'node:test';
import Ajv from 'ajv';
import { PAGE_BLOCK_CATALOG, pageBlockInputSchema, pageBlockText } from '../../shared/src/pages/blockCatalog';
import { parsePageBlock, parsePageBlockInput, type PageBlockInput } from '../../shared/src/pages/blocks';
import { applyPageOps } from '../../shared/src/pages/pageEdit';

const grid = (): Extract<PageBlockInput, { type: 'grid' }> => ({ type: 'grid', regions: [
  { id: 'main', title: 'Main', span: 8, tabletSpan: 6, blocks: [{ type: 'markdown', text: 'Current work' }] },
  { id: 'attention', span: 4, blocks: [{ type: 'toggle', title: 'Details', blocks: [{ type: 'heading', text: 'Risk' }] }] },
] });

test('native grid accepts exact content and participates in catalog schemas, text and stored metadata', () => {
  const content = grid();
  assert.deepEqual(parsePageBlockInput(content), content);
  const schema = new Ajv({ strict: false }).compile(pageBlockInputSchema());
  assert.ok(schema(content), JSON.stringify(schema.errors));
  assert.ok(schema(PAGE_BLOCK_CATALOG.grid.example), JSON.stringify(schema.errors));
  assert.equal(pageBlockText(content), 'Main\nCurrent work\nDetails\nRisk');
  const stored = { ...content, id: 'layout', rev: 3, edit: { at: 10 }, sources: [{ nodeId: 'n', turnId: 't', assistantId: 'a' }] };
  assert.deepEqual(parsePageBlock(stored), stored);
});

test('grid rejects duplicate region ids, invalid widths, excessive children and hidden resource references', () => {
  const content = grid();
  const invalid = [
    { ...content, regions: [] },
    { ...content, regions: [content.regions[0], content.regions[0]] },
    ...[0, 13, 3.5].map(span => ({ ...content, regions: [{ ...content.regions[0], span }] })),
    { ...content, regions: [{ ...content.regions[0], tabletSpan: 0 }] },
    { ...content, regions: [{ ...content.regions[0], id: '' }] },
    { ...content, regions: [{ ...content.regions[0], extra: true }] },
    { ...content, regions: [{ ...content.regions[0], blocks: Array.from({ length: 21 }, () => ({ type: 'markdown', text: 'x' })) }] },
    { ...content, regions: Array.from({ length: 13 }, (_, index) => ({ id: String(index), span: 12, blocks: [] })) },
    { ...content, regions: Array.from({ length: 12 }, (_, index) => ({ id: String(index), span: 12, blocks: Array.from({ length: 10 }, () => ({ type: 'markdown', text: 'x' })) })) },
    ...[
      { type: 'component', componentId: 'outside', props: {} },
      { type: 'database-ref', databaseId: 'outside' },
      { type: 'page-link', pageId: 'outside' },
      { type: 'threads', nodeIds: ['outside'] },
      { type: 'markdown', id: 'forged', text: 'x' },
      { type: 'toggle', title: 'Too deep', blocks: [{ type: 'toggle', title: 'Inner', blocks: [{ type: 'markdown', text: 'x' }] }] },
    ].map(block => ({ ...content, regions: [{ id: 'main', span: 12, blocks: [block] }] })),
  ];
  for (const value of invalid) assert.equal(parsePageBlockInput(value), null, JSON.stringify(value));
});

test('layout edits preserve nested content and source metadata, mark the grid manual, and reject stale revisions', () => {
  const content = grid();
  const source = { nodeId: 'n', turnId: 't', assistantId: 'a' };
  const stored = { ...content, id: 'layout', rev: 3, sources: [source] };
  const next = { ...content, regions: [content.regions[1], { ...content.regions[0], span: 9 }] };
  const op = { op: 'update' as const, id: stored.id, expectRev: 3, block: next };
  const saved = applyPageOps([stored], [op], { actor: 'user', revision: 4, now: 20 });
  assert.deepEqual(saved.blocks[0], { ...next, id: 'layout', rev: 4, sources: [source], edit: { at: 20 } });
  assert.deepEqual(saved.touched[0].before.block, stored);
  assert.throws(() => applyPageOps(saved.blocks, [op], { actor: 'user', revision: 5, now: 30 }), /revision changed/);
});
