import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseTypedLine, readTypedEvents } from './jsonl-events.mjs';

test('a whole JSON line of the requested type is returned as is', () => {
  assert.deepEqual(parseTypedLine('{"type":"startup","name":"a","t":1}', 'startup'), { type: 'startup', name: 'a', t: 1 });
});

test('a log prefix before the event is skipped', () => {
  assert.deepEqual(parseTypedLine('[1] [backend] {"type":"metric","name":"m"}', 'metric'), { type: 'metric', name: 'm' });
});

test('an earlier brace in the prefix does not hide a tagged event', () => {
  assert.deepEqual(parseTypedLine('[0] {weird} {"type":"startup","t":2}', 'startup'), { type: 'startup', t: 2 });
});

test('the type key need not come first when the event starts at the first brace', () => {
  assert.deepEqual(parseTypedLine('renderer: {"t":3,"type":"startup"}', 'startup'), { t: 3, type: 'startup' });
});

test('other event types, plain text and broken JSON are ignored', () => {
  assert.equal(parseTypedLine('{"type":"metric","t":1}', 'startup'), null);
  assert.equal(parseTypedLine('no json here', 'startup'), null);
  assert.equal(parseTypedLine('x {"type":"startup",', 'startup'), null);
});

test('events of one type are read from every file in order, skipping blank and other lines', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'michi-jsonl-events-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'a.jsonl');
  const b = path.join(dir, 'b.log');
  writeFileSync(a, '{"type":"startup","n":1}\r\n\n{"type":"metric","n":2}\nnoise\n');
  writeFileSync(b, 'x {"type":"startup","n":3}\n');
  assert.deepEqual(readTypedEvents([a, b], 'startup'), [
    { type: 'startup', n: 1 },
    { type: 'startup', n: 3 },
  ]);
});
