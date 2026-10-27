import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isTimelineAt, parsePageBlock, parsePageBlockInput } from '../../shared/src/pages/blocks';
import { PAGE_BLOCK_CATALOG, PAGE_BLOCK_TYPES, pageBlockFieldsDoc, pageBlockInputSchema, pageBlockProblem, pageBlockText } from '../../shared/src/pages/blockCatalog';
import { agentPageOpProblem, applyPageOps, parseAgentPageOps, parseUserPageOps } from '../../shared/src/pages/pageEdit';
import type { PageBlock } from '../../shared/src/pages/blocks';

const source = { nodeId: 'node-a', turnId: 'turn-a', assistantId: 'assistant-a' };

describe('native page block contracts', () => {
  test('validates six closed bounded block forms and rejects unknown or server metadata on inputs', () => {
    const inputs = [
      { type: 'heading', text: 'Release' },
      { type: 'markdown', text: '' },
      { type: 'callout', text: 'Ship it', title: 'Status', tone: 'success' },
      { type: 'checklist', title: 'Tasks', items: [{ text: 'Test', done: false }] },
      { type: 'database-ref', databaseId: 'db-1', viewId: 'view-1' },
      { type: 'page-link', pageId: 'page-1' },
    ];
    for (const input of inputs) assert.deepEqual(parsePageBlockInput(input), input);
    assert.equal(parsePageBlockInput({ type: 'markdown', text: 'x', id: 'forged' }), null);
    assert.equal(parsePageBlockInput({ type: 'custom', code: 'x' }), null);
    assert.equal(parsePageBlockInput({ type: 'heading', text: 'x'.repeat(201) }), null);
    assert.equal(parsePageBlockInput({ type: 'checklist', items: Array.from({ length: 51 }, () => ({ text: 'x', done: false })) }), null);
    assert.deepEqual(parsePageBlock({ type: 'markdown', text: '', id: 'b-1', rev: 1, sources: [source] }), {
      type: 'markdown', text: '', id: 'b-1', rev: 1, sources: [source],
    });
    assert.equal(parsePageBlock({ type: 'markdown', text: '', id: 'b-1', rev: 0 }), null);
  });

  test('validates metrics, next-steps and timeline blocks with closed bounded items', () => {
    const inputs = [
      { type: 'metrics', items: [{ label: 'Branches in dev', value: '6', note: 'Scheduled jobs' }, { label: 'Ahead of dev', value: '22 commits', tone: 'accent' }, { label: 'Plain', value: '1', tone: 'default' }] },
      { type: 'metrics', items: [] },
      { type: 'next-steps', title: 'Next steps', items: [{ who: 'user', text: 'Confirm the rewrite', unblocks: 'Release notes' }, { who: 'agent', text: 'Run the rollback cases' }] },
      { type: 'next-steps', items: [] },
      { type: 'timeline', title: 'Progress', items: [
        { title: 'Review changed the plan', at: '2026-10-22T15:21', detail: 'Extend the block editor.', tone: 'info' },
        { title: 'Merged', at: 1_792_682_460_000, tone: 'success' },
        { title: 'Dated', at: '2026-10-22' },
        { title: 'Zoned', at: '2026-10-22T15:21:30.250+08:00', tone: 'warn' },
      ] },
    ];
    for (const input of inputs) assert.deepEqual(parsePageBlockInput(input), input);
    assert.deepEqual(parsePageBlock({ ...inputs[0], id: 'm', rev: 2, edit: { at: 3 } }), { ...inputs[0], id: 'm', rev: 2, edit: { at: 3 } });

    const metric = { label: 'L', value: 'V' };
    const step = { who: 'agent', text: 'Step' };
    const entry = { title: 'T', at: '2026-10-22' };
    const invalid: unknown[] = [
      { type: 'metrics', title: 'No title on metrics', items: [metric] },
      { type: 'metrics', items: [{ ...metric, tone: 'warn' }] },
      { type: 'metrics', items: [{ ...metric, extra: true }] },
      { type: 'metrics', items: [{ label: 'L' }] },
      { type: 'metrics', items: [{ ...metric, value: 'x'.repeat(101) }] },
      { type: 'metrics', items: Array.from({ length: 13 }, () => metric) },
      { type: 'metrics', items: 'nope' },
      { type: 'next-steps', items: [{ ...step, who: 'you' }] },
      { type: 'next-steps', items: [{ who: 'user' }] },
      { type: 'next-steps', items: [{ ...step, text: 'x'.repeat(501) }] },
      { type: 'next-steps', items: Array.from({ length: 21 }, () => step) },
      { type: 'next-steps', title: 'x'.repeat(201), items: [] },
      { type: 'timeline', items: [{ ...entry, tone: 'mauve' }] },
      { type: 'timeline', items: [{ title: 'No time' }] },
      { type: 'timeline', items: [{ ...entry, at: 'yesterday' }] },
      { type: 'timeline', items: [{ ...entry, detail: 'x'.repeat(501) }] },
      { type: 'timeline', items: Array.from({ length: 51 }, () => entry) },
      { type: 'timeline', items: [{ ...entry, id: 'forged' }] },
    ];
    for (const value of invalid) assert.equal(parsePageBlockInput(value), null, JSON.stringify(value).slice(0, 120));
  });

  test('timeline times are epoch milliseconds or ISO dates that name a real day', () => {
    for (const at of [0, 1_792_682_460_000, '2026-10-22', '2026-10-22T15:21', '2026-10-22T15:21:09Z', '2024-02-29T00:00:00.5-07:00']) assert.ok(isTimelineAt(at), String(at));
    for (const at of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2026-02-31', '2025-02-29', '2026-13-01', '2026-10-22T24:00', '2026-10-22 15:21', '10-22 15:21', '', null]) assert.equal(isTimelineAt(at), false, String(at));
  });

  test('parses user release and requires observed revisions on agent existing-target operations', () => {
    assert.deepEqual(parseUserPageOps([{ op: 'release', id: 'b-1' }]), [{ op: 'release', id: 'b-1' }]);
    assert.equal(parseAgentPageOps([{ op: 'release', id: 'b-1' }]), null);
    assert.equal(parseAgentPageOps([{ op: 'delete', id: 'b-1' }]), null);
    assert.equal(parseAgentPageOps([{ op: 'update', id: 'b-1', expectRev: 1, block: { type: 'markdown', text: 'ok', rev: 4 } }]), null);
    assert.equal(parseAgentPageOps([{ op: 'delete', id: 'b-1', expectRev: 1, arbitrary: true }]), null);
    assert.deepEqual(parseAgentPageOps([{ op: 'insert', after: null, block: { type: 'markdown', text: 'new' } }]), [
      { op: 'insert', after: null, block: { type: 'markdown', text: 'new' } },
    ]);
  });

  test('applies human and agent metadata, revisions, anchors, snapshots and no-op identity', () => {
    const initial: PageBlock[] = [
      { type: 'heading', text: 'A', id: 'a', rev: 1 },
      { type: 'markdown', text: 'B', id: 'b', rev: 1, edit: { at: 5 } },
    ];
    const inserted = applyPageOps(initial, [{ op: 'insert', block: { type: 'markdown', text: 'C' }, after: 'a' }], {
      actor: 'user', revision: 2, now: 10, newId: () => 'c',
    });
    assert.deepEqual(inserted.blocks.map((block) => block.id), ['a', 'c', 'b']);
    assert.deepEqual(inserted.blocks[1], { type: 'markdown', text: 'C', id: 'c', rev: 2, edit: { at: 10 } });
    assert.deepEqual(inserted.touched[0].before, { exists: false, block: null, location: null });
    assert.deepEqual(inserted.touched[0].after.location, { parentId: null, slot: null, previousId: 'a', nextId: 'b' });

    const unchanged = applyPageOps(initial, [{ op: 'update', id: 'b', block: { type: 'markdown', text: 'B' } }], {
      actor: 'user', revision: 2, now: 10,
    });
    assert.equal(unchanged.blocks, initial);
    assert.equal(unchanged.blocks[1], initial[1]);
    assert.equal(unchanged.touched.length, 0);

    const agent = applyPageOps(initial, [{ op: 'update', id: 'b', expectRev: 1, block: { type: 'markdown', text: 'B2' } }], {
      actor: 'agent', source, revision: 2, now: 10,
    });
    assert.deepEqual(agent.blocks[1], { type: 'markdown', text: 'B2', id: 'b', rev: 2, edit: { at: 5 }, sources: [source] });

    const stale = applyPageOps(initial, [{ op: 'delete', id: 'b', expectRev: 0 }], {
      actor: 'agent', source, revision: 2, now: 10,
    });
    assert.equal(stale.blocks, initial);
    assert.equal(stale.rejected[0].reason, 'stale');
  });

  test('every catalog example is a valid block of its type, and the catalog covers every type', () => {
    for (const type of PAGE_BLOCK_TYPES) {
      const entry = PAGE_BLOCK_CATALOG[type];
      assert.equal(entry.type, type);
      assert.equal((entry.schema.properties as { type: { enum: string[] } }).type.enum[0], type);
      if (!entry.example) continue;
      assert.deepEqual(parsePageBlockInput(entry.example), entry.example, type);
      assert.ok(pageBlockText(entry.example).trim(), `${type} reads as text`);
    }
    assert.deepEqual(pageBlockInputSchema().oneOf.length, PAGE_BLOCK_TYPES.length);
    for (const type of ['plan-actual', 'compare', 'conflict', 'table', 'criteria', 'chart', 'gallery', 'forgot', 'threads']) {
      assert.ok(PAGE_BLOCK_TYPES.includes(type as never), type);
      assert.ok(pageBlockFieldsDoc().includes(`${type} {`), type);
    }
    const stored = { ...PAGE_BLOCK_CATALOG.chart.example!, id: 'c', rev: 3, sources: [source], edit: { at: 1 } };
    assert.deepEqual(parsePageBlock(stored), stored, 'stored blocks keep their metadata whatever fields their type has');
    assert.equal(parsePageBlock({ ...stored, columns: ['x'] }), null, 'a field of another type is still refused');
  });

  test('plan-actual takes amounts or days, never both, and days that run backwards are refused', () => {
    const amounts = { type: 'plan-actual', items: [{ label: 'Hotel', planned: 800, actual: 950, unit: 'USD', forecast: 1000 }], today: 600 };
    const days = { type: 'plan-actual', title: 'Plan vs actual', items: [
      { label: 'Schema', planStart: '2026-10-10', planEnd: '2026-10-11', actualStart: '2026-10-10', actualEnd: '2026-10-12' },
      { label: 'Migration', planStart: '2026-10-12', planEnd: '2026-10-15', actualStart: '2026-10-13', forecastEnd: '2026-10-18' },
      { label: 'Tests', planStart: '2026-10-16', planEnd: '2026-10-18', forecastStart: '2026-10-18', forecastEnd: '2026-10-21' },
    ] };
    assert.deepEqual(parsePageBlockInput(amounts), amounts);
    assert.deepEqual(parsePageBlockInput(days), days);
    const invalid: unknown[] = [
      { type: 'plan-actual', items: [] },
      { type: 'plan-actual', items: [amounts.items[0], days.items[0]] },
      { type: 'plan-actual', items: [days.items[0], amounts.items[0]] },
      { ...days, today: 3 },
      { type: 'plan-actual', items: [{ label: 'x', planned: -1, actual: 1 }] },
      { type: 'plan-actual', items: [{ label: 'x', planned: Infinity, actual: 1 }] },
      { type: 'plan-actual', items: [{ label: 'x', planStart: '2026-10-12', planEnd: '2026-10-10' }] },
      { type: 'plan-actual', items: [{ label: 'x', planStart: '2026-10-10', planEnd: '2026-10-12', actualEnd: '2026-10-12' }] },
      { type: 'plan-actual', items: [{ label: 'x', planStart: '2026-10-10', planEnd: '2026-10-12', forecastStart: '2026-10-11' }] },
      { type: 'plan-actual', items: [{ label: 'x', planStart: '2026-02-30', planEnd: '2026-03-01' }] },
      { type: 'plan-actual', items: [{ label: 'x', planStart: '2026-10-10T00:00', planEnd: '2026-10-12' }] },
    ];
    for (const value of invalid) assert.equal(parsePageBlockInput(value), null, JSON.stringify(value).slice(0, 160));
  });

  test('compare, conflict, table, criteria, chart, gallery, forgot and thread cards are closed and bounded', () => {
    const valid: unknown[] = [
      { type: 'compare', options: [{ name: 'A', value: '¥32,000', unit: '/ night', pros: ['Near'], cons: [], lean: true }, { name: 'B' }], picked: 1 },
      { type: 'conflict', question: 'Where on Nov 3?', options: [{ text: 'Arashiyama', from: 'Kiro', at: '2026-10-14', nodeId: 'node-1' }, { text: 'Nara' }], resolution: 'both' },
      { type: 'conflict', question: 'Q', options: [{ text: 'A' }, { text: 'B' }], resolution: 0 },
      { type: 'table', columns: ['Day', 'Plan'], rows: [['Mon', 'Kyoto'], ['', '']] },
      { type: 'table', columns: ['Only'], rows: [] },
      { type: 'criteria', title: 'Success criteria', items: [{ text: 'Merged', state: 'in-progress', now: '6 / 11', from: 'git · main' }, { text: 'Docs', state: 'done' }] },
      { type: 'chart', title: 'Turns', kind: 'line', labels: ['Mon', 'Tue'], series: [{ label: 'Kiro', values: [1, 2.5] }], unit: 'turns' },
      { type: 'gallery', items: [{ url: 'https://example.com/a.jpg', caption: 'Lobby' }, { url: 'http://example.com/b.png' }] },
      { type: 'forgot', items: [{ title: 'Orbit layout', state: 'shipped', at: '2026-09-28', detail: 'Map → Layout → Orbit' }, { title: 'Streamdown', state: 'unfinished' }] },
      { type: 'threads', title: 'Sessions', nodeIds: ['node-1', 'node-2'] },
    ];
    for (const value of valid) assert.deepEqual(parsePageBlockInput(value), value, JSON.stringify(value).slice(0, 160));
    const option = { name: 'A' };
    const invalid: unknown[] = [
      { type: 'compare', options: [] },
      { type: 'compare', options: [option], picked: 1 },
      { type: 'compare', options: [option], picked: -1 },
      { type: 'compare', options: [{ ...option, pros: Array.from({ length: 7 }, () => 'p') }] },
      { type: 'compare', options: Array.from({ length: 7 }, () => option) },
      { type: 'compare', options: [{ ...option, lean: 'yes' }] },
      { type: 'conflict', question: 'Q', options: [{ text: 'Only one' }] },
      { type: 'conflict', question: 'Q', options: [{ text: 'A' }, { text: 'B' }], resolution: 2 },
      { type: 'conflict', question: 'Q', options: [{ text: 'A' }, { text: 'B' }], resolution: 'neither' },
      { type: 'conflict', question: 'Q', options: [{ text: 'A', at: 'yesterday' }, { text: 'B' }] },
      { type: 'conflict', question: 'Q', options: [{ text: 'A', nodeId: '' }, { text: 'B' }] },
      { type: 'table', columns: [], rows: [] },
      { type: 'table', columns: ['A', 'B'], rows: [['only one cell']] },
      { type: 'table', columns: ['A'], rows: [['a', 'extra']] },
      { type: 'table', columns: ['A'], rows: [[1]] },
      { type: 'table', columns: Array.from({ length: 9 }, () => 'c'), rows: [] },
      { type: 'criteria', items: [{ text: 'x', state: 'waiting' }] },
      { type: 'criteria', items: [{ text: 'x' }] },
      { type: 'chart', title: 'T', kind: 'pie', labels: ['a'], series: [{ label: 's', values: [1] }] },
      { type: 'chart', title: 'T', kind: 'bar', labels: ['a', 'b'], series: [{ label: 's', values: [1] }] },
      { type: 'chart', title: 'T', kind: 'bar', labels: ['a'], series: [{ label: 's', values: [-1] }] },
      { type: 'chart', title: 'T', kind: 'line', labels: ['a'], series: [{ label: 's', values: [1] }], stacked: true },
      { type: 'chart', title: 'T', kind: 'bar', labels: ['a'], series: Array.from({ length: 4 }, () => ({ label: 's', values: [1] })) },
      { type: 'chart', kind: 'bar', labels: ['a'], series: [{ label: 's', values: [1] }] },
      { type: 'gallery', items: [] },
      { type: 'gallery', items: [{ url: 'javascript:alert(1)' }] },
      { type: 'gallery', items: [{ url: 'data:image/png;base64,AAAA' }] },
      { type: 'gallery', items: [{ url: ' https://example.com/a.jpg' }] },
      { type: 'gallery', items: [{ url: 'file:///etc/passwd' }] },
      { type: 'forgot', items: [{ title: 'x', state: 'done' }] },
      { type: 'threads', nodeIds: [] },
      { type: 'threads', nodeIds: ['a', 'a'] },
      { type: 'threads', nodeIds: Array.from({ length: 21 }, (_, i) => `n${i}`) },
      { type: 'threads', threadIds: ['a'] },
    ];
    for (const value of invalid) assert.equal(parsePageBlockInput(value), null, JSON.stringify(value).slice(0, 160));
  });

  test('says why a block is refused, in words an agent can act on', () => {
    assert.equal(pageBlockProblem(PAGE_BLOCK_CATALOG.chart.example), '');
    assert.match(pageBlockProblem({ type: 'pie' }), /^Unknown block type "pie"; the types are heading, markdown, /);
    assert.equal(pageBlockProblem('x'), 'A block is an object with a type');
    assert.match(pageBlockProblem({ type: 'chart', title: 'T', kind: 'bar', labels: ['a'], series: [], colour: 'red' }), /^A chart block has no colour\. Its fields: \{title, kind/);
    assert.match(pageBlockProblem({ type: 'threads' }), /^A threads block needs nodeIds\./);
    assert.match(pageBlockProblem({ type: 'threads', nodeIds: ['a', 'a'] }), /^This threads block breaks a rule of its fields: .*each once/);
    assert.match(agentPageOpProblem({ op: 'insert', after: null, block: { type: 'conflict', question: 'Q', options: [{ text: 'A', at: 'Oct 14' }, { text: 'B' }] } }),
      /^This conflict block breaks a rule of its fields: .*at\?: epoch ms or ISO 8601/);
    assert.match(agentPageOpProblem({ op: 'rename', id: 'b' }), /^Invalid rename operation\. insert takes/);
    assert.equal(agentPageOpProblem({ op: 'delete', id: 'b', expectRev: 1 }), '');
    assert.equal(agentPageOpProblem(null), 'An operation is an object whose op is insert, update, delete or move');
    const threads = (pageBlockInputSchema().oneOf.find((branch: any) => branch.properties.type.enum[0] === 'threads') as any).properties.nodeIds;
    assert.equal(threads.uniqueItems, true);
  });

  test('takes a line chart that says it does not stack, and epochs only as far as dates go', () => {
    const line = { type: 'chart', title: 'T', kind: 'line', labels: ['a'], series: [{ label: 's', values: [1] }] };
    assert.deepEqual(parsePageBlockInput({ ...line, stacked: false }), { ...line, stacked: false });
    assert.equal(parsePageBlockInput({ ...line, stacked: true }), null);
    assert.equal(isTimelineAt(8_640_000_000_000_000), true);
    assert.equal(isTimelineAt(8_640_000_000_000_001), false);
    assert.equal(parsePageBlockInput({ type: 'forgot', items: [{ title: 'x', state: 'shipped', at: 9e15 }] }), null);
    assert.doesNotThrow(() => pageBlockText({ type: 'timeline', items: [{ title: 'Far', at: 8_640_000_000_000_000 }] }));
  });

  test('release clears human ownership and delete retains its full before snapshot', () => {
    const initial: PageBlock[] = [{ type: 'markdown', text: 'human', id: 'b', rev: 4, edit: { at: 3 }, sources: [source] }];
    const released = applyPageOps(initial, [{ op: 'release', id: 'b' }], { actor: 'user', revision: 5, now: 8 });
    assert.deepEqual(released.blocks[0], { type: 'markdown', text: 'human', id: 'b', rev: 5, sources: [source] });
    const removed = applyPageOps(initial, [{ op: 'delete', id: 'b' }], { actor: 'user', revision: 5, now: 8 });
    assert.deepEqual(removed.deleted[0].before.block, initial[0]);
    assert.deepEqual(removed.deleted[0].after, { exists: false, block: null, location: null });
  });

  test('a task board sits on a page or inside a container, and names no database', () => {
    assert.deepEqual(parsePageBlockInput({ type: 'task-view' }), { type: 'task-view' });
    assert.deepEqual(parsePageBlockInput({ type: 'task-view', viewId: 'tasks-needs-you', title: 'Needs you' }), { type: 'task-view', viewId: 'tasks-needs-you', title: 'Needs you' });
    assert.equal(parsePageBlockInput({ type: 'task-view', databaseId: 'db-1' }), null);
    assert.equal(parsePageBlockInput({ type: 'task-view', viewId: '' }), null);
    const grid = { type: 'grid', regions: [
      { id: 'main', span: 8, blocks: [{ type: 'task-view' }] },
      { id: 'side', span: 4, blocks: [{ type: 'task-view', viewId: 'tasks-needs-you' }] },
    ] };
    assert.deepEqual(parsePageBlockInput(grid), grid);
    assert.ok(parsePageBlockInput({ type: 'toggle', title: 'Work', blocks: [{ type: 'task-view' }] }));
    assert.equal(parsePageBlockInput({ type: 'toggle', title: 'Work', blocks: [{ type: 'database-ref', databaseId: 'db-1' }] }), null, 'other database references stay top-level');
    assert.ok(PAGE_BLOCK_TYPES.includes('task-view'));
    assert.equal(PAGE_BLOCK_CATALOG['task-view'].category, 'references');
    assert.equal(pageBlockText({ type: 'task-view' }), 'Task board');
    assert.equal(pageBlockText({ type: 'task-view', title: 'Release tasks' }), 'Release tasks');
  });
});
