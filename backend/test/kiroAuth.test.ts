import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { KiroAuthGate, KiroSignedOutError, kiroCredentialPaths, readKiroCredentials } from '../src/agents/kiro/kiroAuth';

test('signed-out startup is coalesced across workers and stays paused until credentials change', async () => {
  let fingerprint = 'expired';
  let launches = 0;
  const gate = new KiroAuthGate(() => ({ fingerprint, configured: true }));
  const launch = async () => { launches++; throw new KiroSignedOutError(); };
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => gate.start('kiro', launch)));
  assert.equal(launches, 1);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason instanceof KiroSignedOutError));
  await assert.rejects(gate.start('kiro', launch), KiroSignedOutError);
  assert.equal(launches, 1, 'polling does not spawn another CLI probe or ACP');
  fingerprint = 'new-login';
  await gate.start('kiro', async () => { launches++; });
  assert.equal(launches, 2);
});

test('a definitely empty credential store starts no process; unknown and transient failures are not sign-out', async () => {
  const empty = new KiroAuthGate(() => ({ fingerprint: 'empty', configured: false }));
  await assert.rejects(empty.start('kiro', async () => { assert.fail('must not launch'); }), KiroSignedOutError);
  const unknown = new KiroAuthGate(() => ({ fingerprint: 'unknown', configured: 'unknown' }));
  await assert.rejects(unknown.start('kiro', async () => { throw new Error('network unavailable'); }), /network unavailable/);
  let started = false;
  await unknown.start('kiro', async () => { started = true; });
  assert.ok(started);
  unknown.signedOut('kiro');
  await assert.rejects(unknown.start('kiro', async () => { assert.fail('must stay paused'); }), KiroSignedOutError);
});

test('an old startup failure cannot block a login completed while it was starting', async () => {
  let fingerprint = 'expired';
  const gate = new KiroAuthGate(() => ({ fingerprint, configured: true }));
  await assert.rejects(gate.start('kiro', async () => {
    fingerprint = 'new-login';
    gate.signedOut('kiro'); // The old ACP reports its sign-in error after login.
    throw new KiroSignedOutError();
  }), KiroSignedOutError);
  let launched = false;
  await gate.start('kiro', async () => { launched = true; });
  assert.ok(launched);
});

test('credential change detection reads auth only and never creates an absent database', t => {
  const dir = mkdtempSync(join(tmpdir(), 'michi-kiro-auth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'data.sqlite3');
  assert.equal(readKiroCredentials([path], '').configured, false);
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE history (text TEXT)');
  assert.equal(readKiroCredentials([path], '').configured, false);
  db.prepare('INSERT INTO auth_kv VALUES (?, ?)').run('token', 'fixture-token');
  const before = readKiroCredentials([path], '');
  assert.equal(before.configured, true);
  assert.ok(!before.fingerprint.includes('fixture-token'));
  db.exec("INSERT INTO history VALUES ('unrelated conversation')");
  assert.deepEqual(readKiroCredentials([path], ''), before);
  db.prepare('UPDATE auth_kv SET value=?').run('replacement-fixture');
  assert.notEqual(readKiroCredentials([path], '').fingerprint, before.fingerprint);
  assert.equal(readKiroCredentials([], 'fixture-api-key').configured, true);
  db.exec('DROP TABLE auth_kv');
  assert.equal(readKiroCredentials([path], '').configured, 'unknown');
});

test('credential stores follow platform data roots', () => {
  assert.deepEqual(kiroCredentialPaths('darwin', '/home/u', {}), ['/home/u/Library/Application Support/kiro-cli/data.sqlite3']);
  assert.deepEqual(kiroCredentialPaths('linux', '/home/u', { XDG_DATA_HOME: '/data' }), ['/data/kiro-cli/data.sqlite3']);
});
