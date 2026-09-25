import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AcpClient } from '../src/services/acpClient';
import { KiroRuntime } from '../src/agents/kiro/KiroRuntime';
import { KiroSession } from '../src/agents/kiro/KiroSession';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import * as sessions from '../src/agents/sessionRegistry';

const realLoadSession = AcpClient.prototype.loadSession;

function fixture(timeoutMs = 25) {
  const client = new AcpClient('/bin/false', '/tmp') as any;
  client.cancelTimeoutMs = timeoutMs;
  const wire: any[] = [];
  client.proc = { stdin: { destroyed: false, write(text: string, cb?: () => void) {
    const message = JSON.parse(text);
    wire.push(message);
    cb?.();
    if (message.method === 'session/new') {
      queueMicrotask(() => client.dispatch({ id: message.id, result: { sessionId: message.params.cwd } }));
    }
  } } };
  return { client, wire };
}

test('cancel watchdog settles a silent live RPC and fences the session without killing its peers', async () => {
  const { client, wire } = fixture();
  await client.newSession();
  const turn = client.prompt('/tmp', 'cancel me');
  const result = turn.next().then((value: unknown) => ({ value }), (error: Error) => ({ error }));
  await delay(0);
  const prompt = wire.find((m) => m.method === 'session/prompt');
  await client.cancel('/tmp');
  const observed = await Promise.race([result, delay(100).then(() => 'hung')]);
  // Always release the original RPC, including on RED, so the test cannot hang.
  client.dispatch({ id: prompt.id, result: { stopReason: 'cancelled' } });
  await result;
  await turn.return();
  assert.notEqual(observed, 'hung', 'a cancelled RPC must have a bounded local lifetime');
  assert.equal(client.needsSessionRecovery('/tmp'), true);
  assert.equal(client.isAlive(), true, 'the shared process must not be killed by the watchdog');
  const callsBefore = wire.length;
  await assert.rejects(client.prompt('/tmp', 'do not send on the poisoned queue').next(), /original session|recovery/i);
  await assert.rejects(client.setModel('/tmp', 'other-model'), /original session|recovery/i);
  await assert.rejects(client.setMode('/tmp', 'other-agent'), /original session|recovery/i);
  assert.equal(wire.length, callsBefore);
  client.injectUpdate('/tmp', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late old text' } });
  assert.equal(client.sessionQueues.has('/tmp'), false);
  client.proc = null;
});

test('a cancelled RPC write failure disarms its timer before the next prompt', async () => {
  const { client } = fixture();
  await client.newSession();
  let failWrite!: (error: Error) => void;
  client.proc.stdin.write = (text: string, cb: (error?: Error) => void) => {
    if (JSON.parse(text).method === 'session/prompt') failWrite = cb;
    else cb();
  };
  const turn = client.prompt('/tmp', 'first');
  const result = turn.next().catch((error: Error) => error);
  await delay(0);
  await client.cancel('/tmp');
  failWrite(new Error('write failed'));
  await result;
  await turn.return();
  assert.equal(client.cancelTimers.size, 0);
  assert.equal(client.needsSessionRecovery('/tmp'), false);
  client.proc = null;
});

test('normal cancel completion disarms watchdog; next prompt remains on the same live queue', async () => {
  const { client, wire } = fixture();
  await client.newSession();
  const first = client.prompt('/tmp', 'first');
  const result = first.next();
  await delay(0);
  await client.cancel('/tmp');
  client.dispatch({ id: wire.find((m) => m.method === 'session/prompt').id, result: { stopReason: 'cancelled' } });
  assert.equal((await result).value.stopReason, 'cancelled');
  await first.return();
  await delay(40);
  assert.equal(client.needsSessionRecovery('/tmp'), false);
  const second = client.prompt('/tmp', 'second');
  const next = second.next();
  await delay(0);
  client.dispatch({ id: wire.at(-1).id, result: { stopReason: 'end_turn' } });
  assert.equal((await next).value.stopReason, 'end_turn');
  await second.return();
  client.proc = null;
});

function runtimeFixture(t: TestContext) {
  const { client: old } = fixture();
  const runtime = new KiroRuntime({} as AgentToolBridge, undefined, 0, '/tmp') as any;
  const binding = { publicSessionId: 'watchdog-node', nativeSessionId: 'watchdog-sid',
    owner: { kind: 'chat_node' as const, nodeId: 'watchdog-node' }, cwd: '/tmp', workspaceId: 'w1',
    ownerUserId: 'owner1', runtimeProfileHash: 'profile1', modelId: 'model1' };
  runtime.pool.set('/tmp', old);
  runtime.sessionCwd.set(binding.nativeSessionId, '/tmp');
  runtime.bindNodeSession(binding.publicSessionId, binding.nativeSessionId);
  runtime.storeBinding(binding);
  runtime.sessionCurrentModel.set(binding.nativeSessionId, 'model1');
  old.quarantinedSessions ??= new Set();
  old.quarantinedSessions.add(binding.nativeSessionId);
  const session = new KiroSession(binding.publicSessionId, binding.nativeSessionId, runtime, '/tmp', {
    owner: binding.owner, runtimeProfileHash: binding.runtimeProfileHash,
  });
  sessions.registerSession(session, binding.ownerUserId);
  const calls: Array<{ method: string; sid?: string }> = [];
  t.mock.method(AcpClient.prototype, 'start', function(this: any) { this.proc = { stdin: {} }; });
  t.mock.method(AcpClient.prototype, 'initialize', async () => { calls.push({ method: 'initialize' }); });
  t.mock.method(AcpClient.prototype, 'shutdown', async function(this: any) {
    calls.push({ method: this === old ? 'stop-old' : 'stop-new' }); this.stopped = true; this.proc = null;
  });
  t.mock.method(AcpClient.prototype, 'loadSession', async function(this: any, sid: string) {
    calls.push({ method: 'load', sid });
    this.sessionQueues.set(sid, {});
    return { models: { currentModelId: 'model1' }, modes: { currentModeId: 'original-agent' } };
  });
  t.after(async () => { await runtime.shutdown(); sessions.dropSession(binding.publicSessionId); });
  return { runtime, old, session, binding, calls };
}

test('watchdog recovery stops old process before one native load and restores owner/model/registry', async (t) => {
  const { runtime, old, session, binding, calls } = runtimeFixture(t);
  const [a, b] = await Promise.all([
    runtime.recoverCancelledSession(binding.nativeSessionId, '/tmp'),
    runtime.recoverCancelledSession(binding.nativeSessionId, '/tmp'),
  ]);
  assert.equal(a, b);
  assert.notEqual(a, old);
  assert.deepEqual(calls, [{ method: 'stop-old' }, { method: 'initialize' }, { method: 'load', sid: binding.nativeSessionId }]);
  assert.equal(sessions.getSession(binding.publicSessionId), session);
  assert.deepEqual(runtime.getBinding(binding.publicSessionId), { ...binding, slotId: undefined });
  assert.equal(runtime.getCurrentMode(binding.nativeSessionId), 'original-agent');
  assert.equal(runtime.getCurrentModel(binding.nativeSessionId), 'model1');
});

test('watchdog recovery refuses to kill a healthy peer prompt and retains its binding', async (t) => {
  const { runtime, old, binding, calls } = runtimeFixture(t);
  old.sessionInFlight.set('healthy-peer', new Promise(() => {}));
  await assert.rejects(runtime.recoverCancelledSession(binding.nativeSessionId, '/tmp'), /other.*task|another.*task/i);
  assert.deepEqual(calls, []);
  assert.equal(runtime.getBinding(binding.publicSessionId), binding);
  assert.equal(old.isAlive(), true);
});

test('failed recovery loads no replacement session and never registers a half-restored session', async (t) => {
  const { runtime, binding, calls } = runtimeFixture(t);
  t.mock.method(AcpClient.prototype, 'loadSession', async () => { throw new Error('authentication unavailable'); });
  await assert.rejects(runtime.recoverCancelledSession(binding.nativeSessionId, '/tmp'), /original.*retained/i);
  assert.equal(calls.filter((c) => c.method === 'stop-new').length, 1);
  assert.equal(sessions.getSession(binding.publicSessionId), undefined);
  assert.equal(runtime.pool.size, 0);
});

test('recovery has a hard deadline even if the loading session keeps emitting updates', async (t) => {
  const { runtime, binding } = runtimeFixture(t);
  runtime.cancelRecoveryTimeoutMs = 35;
  t.mock.method(AcpClient.prototype, 'start', function(this: any) {
    this.proc = { stdin: { destroyed: false, write(_data: string, callback: () => void) { callback(); } } };
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  t.mock.method(AcpClient.prototype, 'loadSession', function(this: any, ...args: Parameters<typeof realLoadSession>) {
    timer = setInterval(() => this.dispatch({ method: 'session/update', params: {
      sessionId: binding.nativeSessionId, update: { sessionUpdate: 'agent_message_chunk', content: [] },
    } }), 5);
    return realLoadSession.apply(this, args);
  });
  try {
    const started = Date.now();
    await assert.rejects(runtime.recoverCancelledSession(binding.nativeSessionId, '/tmp'), /original.*retained/i);
    assert.ok(Date.now() - started < 250, 'progress notifications must not extend the hard deadline');
    assert.equal(runtime.pool.size, 0);
  } finally { clearInterval(timer); }
});

test('unconfirmed old-process exit never starts a replacement or overwrites original binding', async (t) => {
  const { runtime, old, binding, calls } = runtimeFixture(t);
  t.mock.method(old, 'shutdown', async () => { old.stopped = true; throw new Error('exit not confirmed'); });
  await assert.rejects(runtime.recoverCancelledSession(binding.nativeSessionId, '/tmp'), /original.*retained/i);
  await assert.rejects(runtime.ensureClient('/tmp'), /original.*retained/i);
  assert.deepEqual(calls, []);
  assert.equal(runtime.getBinding(binding.publicSessionId), binding);
});

test('cancel during native restoration sends no user prompt after the load finishes', async (t) => {
  const { runtime, session, binding, calls } = runtimeFixture(t);
  let complete!: () => void;
  let started!: () => void;
  const loading = new Promise<void>((resolve) => { started = resolve; });
  t.mock.method(AcpClient.prototype, 'loadSession', async function(this: any) {
    await new Promise<void>((resolve) => { complete = resolve; started(); });
    this.sessionQueues.set(binding.nativeSessionId, {});
    return { models: { currentModelId: 'model1' } };
  });
  let prompts = 0;
  t.mock.method(AcpClient.prototype, 'prompt', async function*() { prompts++; });
  const stream = session.send('new message');
  assert.equal((await stream.next()).value?.kind, 'retry_start');
  const next = stream.next();
  await loading;
  await session.cancel();
  complete();
  await next;
  const done = await stream.next();
  assert.deepEqual(done.value, { kind: 'turn_end', stopReason: 'cancelled' });
  await stream.return?.(undefined);
  assert.equal(prompts, 0);
  assert.ok(calls.some((c) => c.method === 'stop-old'));
  assert.equal(runtime.getBinding(binding.publicSessionId).nativeSessionId, binding.nativeSessionId);
});

test('an aborted waiter cannot release the queue for a third prompt before the predecessor completes', async () => {
  const { client, wire } = fixture();
  await client.newSession();
  const first = client.prompt('/tmp', 'first');
  const firstNext = first.next();
  await delay(0);
  const abort = new AbortController();
  const second = client.prompt('/tmp', 'cancelled waiter', [], abort.signal);
  const secondNext = second.next();
  abort.abort();
  await secondNext;
  await second.return();
  const third = client.prompt('/tmp', 'third');
  const thirdNext = third.next();
  await delay(0);
  assert.equal(wire.filter((m) => m.method === 'session/prompt').length, 1);
  client.dispatch({ id: wire.find((m) => m.method === 'session/prompt').id, result: { stopReason: 'end_turn' } });
  await firstNext;
  await first.return();
  await delay(0);
  assert.equal(wire.filter((m) => m.method === 'session/prompt').length, 2);
  client.dispatch({ id: wire.at(-1).id, result: { stopReason: 'end_turn' } });
  await thirdNext;
  await third.return();
  assert.equal(client.sessionInFlight.size, 0);
  client.proc = null;
});

test('a blocked cancellation write still returns promptly and arms the watchdog only once', async () => {
  const { client, wire } = fixture();
  await client.newSession();
  const turn = client.prompt('/tmp', 'first');
  const result = turn.next().catch((error: Error) => error);
  await delay(0);
  const write = client.proc.stdin.write;
  client.proc.stdin.write = (text: string, cb?: () => void) => {
    if (JSON.parse(text).method === 'session/cancel') return true;
    return write(text, cb);
  };
  await Promise.race([client.cancel('/tmp'), delay(100).then(() => { throw new Error('cancel response hung'); })]);
  const timer = client.cancelTimers.get('/tmp');
  await client.cancel('/tmp');
  assert.equal(client.cancelTimers.get('/tmp'), timer);
  await result;
  await turn.return();
  assert.equal(client.needsSessionRecovery('/tmp'), true);
  assert.equal(wire.filter((m) => m.method === 'session/prompt').length, 1);
  client.proc = null;
});
