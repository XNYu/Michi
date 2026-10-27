import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerMode, sameOwner, type RuntimeSessionOwner } from 'michi-runtime';
import { chatNodeOf, chatOwner, hostOwner, isRunOwner, runIdOfOwner, runOwner, sameHostOwner } from '../src/agents/ownerMapping';

test('a chat owner is interactive and keyed by its node id', () => {
  const owner = chatOwner('n-1');
  assert.equal(owner.mode, 'interactive');
  assert.equal(owner.key, 'n-1');
  assert.equal(owner.hostRef, undefined);
  assert.equal(ownerMode(owner), 'interactive');
  assert.deepEqual(owner, { mode: 'interactive', key: 'n-1' }, 'nothing Michi-specific reaches the runtime');
  assert.deepEqual(hostOwner(owner), { kind: 'chat_node', nodeId: 'n-1' });
});

test('a Run owner is headless, keyed by its Attempt id, and carries its Run id frozen', () => {
  const owner = runOwner('run-1', 'attempt-1');
  assert.equal(owner.mode, 'headless');
  assert.equal(owner.key, 'attempt-1');
  assert.deepEqual(owner.hostRef, { runId: 'run-1' });
  assert.ok(Object.isFrozen(owner.hostRef));
  assert.equal(ownerMode(owner), 'headless');
  assert.deepEqual(Object.keys(owner), ['mode', 'key', 'hostRef'], 'nothing Michi-specific outside hostRef');
  assert.deepEqual(hostOwner(owner), { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' });
});

test('hostOwner fails closed for a headless owner without a Run id', () => {
  assert.throws(() => hostOwner({ mode: 'headless', key: 'attempt-1' }), /carries no Run id/);
  assert.throws(() => hostOwner({ mode: 'headless', key: 'attempt-1', hostRef: { runId: '' } }), /carries no Run id/);
  assert.throws(() => hostOwner({ mode: 'headless', key: 'attempt-1', hostRef: 'run-1' }), /carries no Run id/);
});

test('readers name the chat node or the Run an owner stands for', () => {
  assert.equal(isRunOwner(runOwner('run-1', 'attempt-1')), true);
  assert.equal(isRunOwner(chatOwner('n-1')), false);
  assert.equal(isRunOwner(undefined), false);
  assert.equal(chatNodeOf(chatOwner('n-1')), 'n-1');
  assert.equal(chatNodeOf(runOwner('run-1', 'attempt-1')), undefined);
  assert.equal(chatNodeOf(undefined), undefined);
  assert.equal(runIdOfOwner(runOwner('run-1', 'attempt-1')), 'run-1');
  assert.equal(runIdOfOwner(chatOwner('n-1')), null);
  assert.equal(runIdOfOwner(null), null);
  // A Run-scoped reader never reads an unnamed Run as "no Run".
  assert.throws(() => runIdOfOwner({ mode: 'headless', key: 'attempt-1' }), /carries no Run id/);
});

test('runtime equality is mode and key; Michi equality also compares the Run', () => {
  assert.equal(sameOwner(chatOwner('n-1'), chatOwner('n-1')), true);
  assert.equal(sameOwner(chatOwner('shared'), runOwner('run-1', 'shared')), false);
  assert.equal(sameOwner(runOwner('run-1', 'attempt-1'), runOwner('run-1', 'attempt-2')), false);
  // The Attempt id is a primary key and decides its Run: the runtime never compares Runs.
  assert.equal(sameOwner(runOwner('run-1', 'attempt-1'), runOwner('run-2', 'attempt-1')), true);
  assert.equal(sameHostOwner(chatOwner('n-1'), chatOwner('n-1')), true);
  assert.equal(sameHostOwner(chatOwner('n-1'), chatOwner('n-2')), false);
  assert.equal(sameHostOwner(chatOwner('shared'), runOwner('run-1', 'shared')), false);
  assert.equal(sameHostOwner(runOwner('run-1', 'shared'), chatOwner('shared')), false);
  assert.equal(sameHostOwner(runOwner('run-1', 'attempt-1'), runOwner('run-1', 'attempt-1')), true);
  assert.equal(sameHostOwner(runOwner('run-1', 'attempt-1'), runOwner('run-2', 'attempt-1')), false);
  assert.equal(sameHostOwner(runOwner('run-1', 'attempt-1'), runOwner('run-1', 'attempt-2')), false);
  const unnamed: RuntimeSessionOwner = { mode: 'headless', key: 'attempt-1' };
  assert.equal(sameHostOwner(runOwner('run-1', 'attempt-1'), unnamed), false);
  assert.equal(sameHostOwner(unnamed, unnamed), false);
});
