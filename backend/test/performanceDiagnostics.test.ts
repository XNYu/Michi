import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { instrumentDatabase, timedSync, withPerformanceContext, startEventLoopDiagnostics } from '../src/services/performanceDiagnostics';

const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('SQL diagnostics preserve native operations and correlate slow calls without parameter values', () => {
  const events: Array<{ event: string; details: Record<string, unknown> }> = [];
  const db = instrumentDatabase(new DatabaseSync(':memory:'), 'test-db', (event, details) => events.push({ event, details }), 0);
  try {
    db.exec('CREATE TABLE sample(value TEXT)');
    const secret = 'private-message-do-not-log';
    withPerformanceContext('request-test', () => db.prepare('INSERT INTO sample VALUES (?)').run(secret));
    assert.equal(db.prepare('SELECT value FROM sample').get()?.value, secret);
    assert.equal(db.prepare('SELECT * FROM sample').all().length, 1);
    assert.equal(events.some(item => item.details.context === 'request-test'), true);
    assert.equal(JSON.stringify(events).includes(secret), false);
    assert.equal(JSON.stringify(events).includes('INSERT INTO sample'), false);
    assert.throws(() => db.prepare('SELECT * FROM missing'), /no such table/);
    assert.equal(events.at(-1)?.details.failed, true);
  } finally { db.close(); }
});

test('synchronous timing preserves return and exception identity', () => {
  const events: unknown[] = [];
  const report = (_: string, details: unknown) => events.push(details);
  assert.equal(timedSync('fast', () => 42, report, 0), 42);
  const failure = new Error('expected');
  assert.throws(() => timedSync('fail', () => { throw failure; }, report, 0), error => error === failure);
  assert.equal(events.length, 2);
});

test('event-loop watchdog detects a stall and stops cleanly', async () => {
  const events: Array<Record<string, unknown>> = [];
  const stop = startEventLoopDiagnostics((_, details) => events.push(details), 20, 50);
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    block(110);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.ok(events.some(event => Number(event.delayMs) >= 50));
  } finally { stop(); }
  const count = events.length;
  block(110);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(events.length, count);
});

test('diagnostic sink failures cannot change database results or errors', () => {
  const report = () => { throw new Error('logging unavailable'); };
  const db = instrumentDatabase(new DatabaseSync(':memory:'), 'test-db', report, 0);
  try {
    db.exec('CREATE TABLE sample(value INTEGER)');
    db.prepare('INSERT INTO sample VALUES (?)').run(42);
    assert.equal(db.prepare('SELECT value FROM sample').get()?.value, 42);
    assert.throws(() => db.prepare('SELECT * FROM missing'), /no such table/);
    const original = new Error('original failure');
    assert.throws(() => timedSync('fail', () => { throw original; }, report, 0), error => error === original);
  } finally { db.close(); }
});
