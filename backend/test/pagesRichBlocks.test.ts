import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import { PAGE_BLOCK_CATALOG, PAGE_BLOCK_TYPES, pageBlockInputSchema, parsePageBlockInput } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createPage, getPage } from '../src/services/pages/repository';
import { applyUserPageEdits } from '../src/services/pages/pageWrites';
import { listRelevantChanges } from '../src/services/pages/historyRepository';

let dir: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.MICHI_DATA_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-rich-pages-'));
  process.env.MICHI_DATA_DIR = dir;
  closeDb(); initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('rich-ws', 'Rich pages', 'alice');
});
afterEach(() => {
  closeDb();
  if (previous === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('all offered examples satisfy both the agent schema and authoritative write validation', () => {
  const validate = new Ajv({ strict: false }).compile(pageBlockInputSchema());
  for (const type of PAGE_BLOCK_TYPES) {
    const example = PAGE_BLOCK_CATALOG[type].example;
    if (!example) continue;
    assert.ok(validate(example), `${type}: ${JSON.stringify(validate.errors)}`);
    assert.deepEqual(parsePageBlockInput(example), example, type);
    assert.equal(parsePageBlockInput({ ...example, id: 'forged' }), null, type);
  }
});

test('rich input rejects unknown fields, lossy values, invalid dates and recursive resources', () => {
  const invalid = [
    { type: 'ring', items: [{ label: 'Done', value: 1.1 }] },
    { type: 'image', url: 'http://example.com/picture.jpg' },
    { type: 'image', url: 'https://user:secret@example.com/picture.jpg' },
    { type: 'calendar', month: '2026-10', events: [{ date: '2026-11-01', title: 'Invisible' }] },
    { type: 'gantt', items: [{ label: 'Backwards', start: '2026-10-10', end: '2026-10-01' }] },
    { type: 'countdown', title: 'No day', to: '2026-02-30' },
    { type: 'status', label: ' ', tone: 'warn' },
    { type: 'status', label: 'At risk', tone: 'orange' },
    { type: 'milestones', items: [{ label: 'Beta', date: '2026-11-01', done: false, note: 'x'.repeat(201) }] },
    { type: 'milestones', items: [{ label: 'Beta', date: '2026-11-01', done: false, tone: 'risky' }] },
    { type: 'form', title: 'Duplicate fields', fields: [{ key: 'x', label: 'One', type: 'text' }, { key: 'x', label: 'Two', type: 'text' }], prompt: 'Answer' },
    { type: 'form', title: 'Invalid select', fields: [{ key: 'x', label: 'One', type: 'select' }], prompt: 'Answer' },
    { type: 'chart', kind: 'radar', title: 'Mismatch', axes: ['A', 'B', 'C'], series: [{ label: 'X', values: [1, 2, 3, 4] }] },
    { type: 'chart', kind: 'sankey', title: 'Cycle', nodes: [{ name: 'A' }, { name: 'B' }], links: [{ source: 'A', target: 'B', value: 1 }, { source: 'B', target: 'A', value: 1 }] },
    { type: 'toggle', title: 'Forged metadata', blocks: [{ type: 'markdown', text: 'x', sources: [{ nodeId: 'other' }] }] },
    { type: 'toggle', title: 'Hidden resource', blocks: [{ type: 'component', componentId: 'other', props: {} }] },
    { type: 'toggle', title: 'Too deep', blocks: [{ type: 'toggle', title: 'Two', blocks: [{ type: 'toggle', title: 'Three', blocks: [{ type: 'markdown', text: 'x' }] }] }] },
  ];
  for (const input of invalid) assert.equal(parsePageBlockInput(input), null, JSON.stringify(input));
});

test('new and existing blocks survive SQLite reload and archive history can reinsert their full content', () => {
  const samples = PAGE_BLOCK_TYPES.flatMap((type) => {
    const example = PAGE_BLOCK_CATALOG[type].example;
    return example && type !== 'threads' ? [example] : [];
  });
  for (let offset = 0; offset < samples.length; offset += 30) {
    const batch = samples.slice(offset, offset + 30);
    const created = createPage({ workspaceId: 'rich-ws', ownerUserId: 'alice', title: 'Visual acceptance' });
    applyUserPageEdits({ pageId: created.id, ownerUserId: 'alice', revision: created.revision, ops: [...created.blocks.map((block) => ({ op: 'delete', id: block.id, expectRev: block.rev })), ...batch.map((block) => ({ op: 'insert', after: null, block }))] });
    const saved = getPage(created.id, 'alice');
    closeDb(); initDb();
    assert.deepEqual(getPage(created.id, 'alice').blocks, saved.blocks);
    assert.equal(saved.blocks.length, batch.length);
    for (const block of saved.blocks) {
      const { id: _id, rev: _rev, sources: _sources, edit: _edit, ...content } = block;
      assert.deepEqual(content, batch.find((sample) => sample.type === block.type));
    }
    applyUserPageEdits({ pageId: saved.id, ownerUserId: 'alice', revision: saved.revision,
      ops: saved.blocks.map((block) => ({ op: 'delete', id: block.id, expectRev: block.rev })) });
    const emptied = getPage(saved.id, 'alice');
    assert.equal(emptied.blocks.length, 0);
    const history = listRelevantChanges(saved.id, 'alice', { limit: 100 }).changes;
    const recovered = saved.blocks.map((block) => {
      const archived = history.find((change) => change.op === 'delete' && change.target.kind === 'block' && change.target.blockId === block.id);
      assert.ok(archived?.before?.kind === 'block' && archived.before.exists);
      assert.deepEqual(archived.before.block, block);
      const { id: _id, rev: _rev, sources: _sources, edit: _edit, ...content } = archived.before.block;
      return content;
    });
    // User archives are retained in history; only agent changes support Undo.
    // Reinsert the saved content through the ordinary native write path.
    applyUserPageEdits({ pageId: saved.id, ownerUserId: 'alice', revision: emptied.revision,
      ops: recovered.map((block) => ({ op: 'insert', after: null, block })) });
    const restored = getPage(saved.id, 'alice');
    assert.equal(restored.blocks.length, batch.length);
    for (const block of restored.blocks) {
      const { id: _id, rev: _rev, sources: _sources, edit: _edit, ...content } = block;
      assert.deepEqual(content, batch.find((sample) => sample.type === block.type));
    }
  }
});
