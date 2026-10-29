import assert from 'node:assert/strict';
import { test } from 'node:test';
import Ajv from 'ajv';
import { parsePageBlockInput, pageBlockInputSchema, pageViewProblem, pageViewActionFromHref, pageBlockText, type PageBlock } from 'michi-shared';

const action = { type: 'open-view' as const, viewId: 'evidence', presentation: 'drawer' as const };
const blocks: PageBlock[] = [
  { id: 'entry', rev: 1, type: 'view-link', label: 'Evidence', action },
  { id: 'view', rev: 1, type: 'view', viewId: 'evidence', title: 'Why A', blockIds: ['detail'] },
  { id: 'detail', rev: 2, type: 'markdown', text: 'Because…', visibility: 'detail', edit: { at: 1 } },
];

test('optional interactions accept arbitrary native content without loosening strict schemas', () => {
  const validate = new Ajv({ strict: false }).compile(pageBlockInputSchema());
  const contents = [
    { type: 'markdown', text: 'Notes', interaction: { label: 'Evidence', action } },
    { type: 'metrics', items: [{ label: 'Review', value: '2', action }] },
    { type: 'stat', label: 'Change', value: '20%', interaction: { label: 'Explain', action } },
    { type: 'component', componentId: 'c', props: {}, visibility: 'detail', interaction: { label: 'Evidence', action } },
    { type: 'chart', kind: 'pie', title: 'Options', slices: [{ label: 'A', value: 2 }], interaction: { label: 'Why?', action } },
    { type: 'view', viewId: 'evidence', title: 'Why A', blockIds: ['detail'] },
    { type: 'view-link', label: 'Evidence', action },
  ];
  for (const content of contents) {
    assert.deepEqual(parsePageBlockInput(content), content);
    assert.ok(validate(content), JSON.stringify(validate.errors));
  }
  for (const invalid of [
    { ...contents[0], interaction: { label: 'Oops', action: { ...action, url: 'https://example.com' } } },
    { ...contents[0], interaction: { label: 'Oops', action: { ...action, presentation: 'page' } } },
    { ...contents[0], visibility: 'hidden' },
    { type: 'view', viewId: '../other', title: 'Wrong', blockIds: ['detail'] },
    { type: 'view', viewId: 'evidence', title: 'Wrong', blockIds: ['detail', 'detail'] },
    { type: 'toggle', title: 'Details', blocks: [contents[5]] },
    { type: 'toggle', title: 'Details', blocks: [{ type: 'markdown', text: 'x', visibility: 'detail' }] },
  ]) assert.equal(parsePageBlockInput(invalid), null, JSON.stringify(invalid));
});

test('view references are page-local, bounded and cannot recurse through definitions', () => {
  assert.equal(pageViewProblem(blocks), null);
  assert.match(pageViewProblem(blocks.filter(b => b.id !== 'detail'))!, /missing block detail/);
  assert.match(pageViewProblem(blocks.filter(b => b.id !== 'view'))!, /does not exist/);
  assert.match(pageViewProblem([...blocks, { ...blocks[1], id: 'other' }])!, /unique/);
  assert.match(pageViewProblem(blocks.map(b => b.type === 'view' ? { ...b, blockIds: ['view'] } : b))!, /not another view/);
  const nested: PageBlock = { id: 'nested', rev: 1, type: 'toggle', title: 'More', blocks: [{ type: 'view-link', label: 'Missing', action: { ...action, viewId: 'elsewhere' } }] };
  assert.match(pageViewProblem([...blocks, nested])!, /elsewhere/);
  assert.match(pageViewProblem([...blocks, { id: 'metric', rev: 1, type: 'metrics', items: [{ label: 'X', value: '2', action: { ...action, viewId: 'elsewhere' } }] }])!, /elsewhere/);
});

test('only local, explicitly supported Markdown view links become actions', () => {
  assert.deepEqual(pageViewActionFromHref('#view/evidence?presentation=drawer'), action);
  assert.deepEqual(pageViewActionFromHref('#view/evidence'), { type: 'open-view', viewId: 'evidence' });
  for (const href of ['https://example.com/#view/evidence', '#heading', '#view/evidence?presentation=page', '#view/../x', '#view/evidence?url=external']) assert.equal(pageViewActionFromHref(href), null);
});

test('copy and assistant context omit interaction protocol metadata', () => {
  assert.equal(pageBlockText({ type: 'stat', label: 'Change', value: '20%', visibility: 'detail', interaction: { label: 'Explain', action } }), 'Change\n20%');
});
