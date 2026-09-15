import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexSession } from '../src/agents/codex/CodexSession';
import { CodexRuntime } from '../src/agents/codex/CodexRuntime';
import { ClaudeSession } from '../src/agents/claude/ClaudeSession';
import { PiSession } from '../src/agents/pi/PiSession';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import type { NormalizedEvent } from '../src/services/chatEvents';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const drain = async (events: AsyncIterable<NormalizedEvent>) => {
  const result: NormalizedEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
};
const bridge: any = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };
const mcp: any = { create: (_id: string, _cwd: string, _owner: unknown, cbs: any) => ({ slotId: 'test-slot', ...cbs }), dispose: async () => {} };

function codexClient() {
  const calls: Array<{ method: string; params: any }> = [];
  const handlers = new Map<string, (method: string, params: any) => void>();
  let counter = 0;
  const client: any = {
    calls, handlers,
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: `thread-${++counter}` } };
      if (method === 'thread/resume') return { thread: { id: params.threadId } };
      if (method === 'turn/start') return { turn: { id: `turn-${++counter}` } };
      return {};
    },
    onNotification: (id: string, handler: any) => { handlers.set(id, handler); return () => { handlers.delete(id); }; },
    onGlobalNotification: () => () => {}, onServerRequest() {}, onExit() {},
    ensureStarted: async () => {}, isRunning: () => true, hasPendingRequests: () => false,
    shutdown: async () => { calls.push({ method: 'shutdown', params: {} }); },
    emit(id: string, method: string, params: any) { handlers.get(id)?.(method, params); },
  };
  return client;
}

function codex(client = codexClient(), recover?: (session: CodexSession) => Promise<void>) {
  const session = new CodexSession({ nodeId: 'node', threadId: 'native', cwd: '/tmp', workspaceId: null, client, bridge, mcpRegistry: mcp, mcpPort: 1, recover, cancelTimeoutMs: 10 });
  session.wireNotifications();
  return { session, client };
}

test('Codex normal cancellation acknowledges the correct native turn and reuses its thread', async () => {
  const { session, client } = codex();
  try {
    const a = drain(session.send('A'));
    await tick();
    assert.deepEqual(await session.cancel(), { acknowledged: true });
    const interrupt = client.calls.find((c: any) => c.method === 'turn/interrupt');
    assert.deepEqual(interrupt.params, { threadId: 'native', turnId: 'turn-1' });
    client.emit('native', 'turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } });
    await a;
    const b = drain(session.send('B'));
    await tick();
    client.emit('native', 'item/agentMessage/delta', { turnId: 'turn-1', delta: 'STALE' });
    client.emit('native', 'item/agentMessage/delta', { turnId: 'turn-2', delta: 'clean' });
    client.emit('native', 'turn/completed', { turn: { id: 'turn-2', status: 'completed' } });
    assert.deepEqual((await b).filter((e) => e.kind === 'chunk'), [{ kind: 'chunk', text: 'clean' }]);
    assert.equal(session.requiresRestart, false);
    assert.ok(client.calls.filter((c: any) => c.method === 'turn/start').every((c: any) => c.params.threadId === 'native'));
  } finally { await session.dispose(); }
});

test('Codex cancel watchdog terminates locally, recovers same identity and fences late output', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let recovered = 0;
  const { session, client } = codex(undefined, async (current) => {
    assert.equal(current.nativeSessionId, 'native');
    assert.equal(current.requiresRestart, true);
    recovered++;
    current.completeNativeResume();
  });
  try {
    const a = drain(session.send('A'));
    await tick();
    await session.cancel();
    t.mock.timers.tick(10);
    assert.equal((await a).at(-1)?.kind, 'turn_end');
    client.emit('native', 'item/agentMessage/delta', { turnId: 'turn-1', delta: 'STALE' });
    const b = drain(session.send('B'));
    await tick();
    client.emit('native', 'item/agentMessage/delta', { turnId: 'turn-2', delta: 'clean' });
    client.emit('native', 'turn/completed', { turn: { id: 'turn-2', status: 'completed' } });
    const events = await b;
    assert.equal(recovered, 1);
    assert.deepEqual(events.filter((e) => e.kind === 'retry_start' || e.kind === 'retry_end').map((e) => e.kind), ['retry_start', 'retry_end']);
    assert.deepEqual(events.filter((e) => e.kind === 'chunk'), [{ kind: 'chunk', text: 'clean' }]);
  } finally { await session.dispose(); }
});

test('Codex cancellation before start response settles on failed native completion', async () => {
  const client = codexClient();
  const original = client.request;
  let accept!: (value: unknown) => void;
  client.request = (method: string, params: any) => method === 'turn/start'
    ? new Promise((resolve) => { accept = resolve; }) : original(method, params);
  const { session } = codex(client);
  try {
    const a = drain(session.send('A'));
    await tick();
    assert.deepEqual(await session.cancel(), { acknowledged: false });
    accept({ turn: { id: 'early' } });
    await tick();
    client.emit('native', 'turn/completed', { turn: { id: 'early', status: 'failed', error: { message: 'cancelled before startup' } } });
    assert.equal((await a).at(-1)?.kind, 'turn_end');
    assert.equal(session.isBusy(), false);
    assert.equal(session.needsRecovery(), false);
  } finally { await session.dispose(); }
});

test('Codex never claims acknowledgement for rejected interrupts and quarantines early return', async () => {
  const client = codexClient();
  const original = client.request;
  client.request = (method: string, params: any) => method === 'turn/interrupt' ? Promise.reject(new Error('rejected')) : original(method, params);
  const { session } = codex(client);
  try {
    const a = session.send('A');
    const next = a.next();
    await tick();
    client.emit('native', 'item/agentMessage/delta', { turnId: 'turn-1', delta: 'first' });
    await next;
    assert.deepEqual(await session.cancel(), { acknowledged: false });
    await a.return!();
    assert.equal(session.needsRecovery(), true);
    await assert.rejects(drain(session.send('B')), /native recovery/);
    assert.equal(client.calls.filter((c: any) => c.method === 'turn/start').length, 1);
  } finally { await session.dispose(); }
});

test('Codex shared-daemon recovery protects healthy peers and reloads the original thread', async () => {
  const client = codexClient();
  const runtime = new CodexRuntime(bridge, mcp, 1, { client });
  const owner = (id: string): any => ({ kind: 'agent_run', runId: id, attemptId: id });
  const a = await runtime.newSession({ sessionId: 'a', cwd: '/tmp', model: 'model', owner: owner('a') }) as CodexSession;
  const b = await runtime.newSession({ sessionId: 'b', cwd: '/tmp', model: 'model', owner: owner('b') }) as CodexSession;
  const peer = drain(b.send('peer'));
  await tick();
  a.requiresRestart = true;
  a.markCrashed('injected cancellation timeout');
  await assert.rejects(drain(a.send('retry')), /other tasks/);
  assert.equal(client.calls.some((c: any) => c.method === 'shutdown'), false);
  client.emit(b.threadId, 'turn/completed', { turn: { id: 'turn-3', status: 'completed' } });
  await peer;
  const resumed = drain(a.send('retry'));
  await tick();
  const loaded = client.calls.filter((c: any) => c.method === 'thread/resume');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].params.threadId, a.nativeSessionId);
  client.emit(a.threadId, 'turn/completed', { turn: { id: 'turn-4', status: 'completed' } });
  assert.ok((await resumed).some((e) => e.kind === 'retry_start'));
  assert.equal(client.calls.filter((c: any) => c.method === 'thread/start').length, 2);
  await runtime.shutdown();
});

class Child extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  signals: string[] = [];
  exitOnSignal = true;
  kill(signal: string) { this.signals.push(signal); if (this.exitOnSignal) setImmediate(() => this.emit('exit', 0)); return true; }
  send(value: object) { this.stdout.write(JSON.stringify(value) + '\n'); }
}

function claude(t: any) {
  const binary = require('../src/agents/claude/claudeBinary');
  const db = require('../src/services/dbRepository');
  const children: Child[] = [], spawns: any[] = [], writes: any[] = [];
  t.mock.method(binary, 'preflightClaudeAuth', () => {});
  t.mock.method(binary, 'spawnClaude', (opts: any) => { spawns.push(opts); const child = new Child(); children.push(child); return child; });
  t.mock.method(db, 'setNodeExternalSessionId', (...args: any[]) => writes.push(args));
  const session = new ClaudeSession('claude-node', { nodeId: 'claude-node', cwd: '/tmp', workspaceId: null, mcpRegistry: mcp, bridge, mcpPort: 1 });
  return { session, children, spawns, writes };
}

test('Claude ignores an old result during retirement and next turn resumes the same native ID', async (t) => {
  const { session, children, spawns } = claude(t);
  await session.spawnResume('native-claude');
  const a = drain(session.send('A'));
  await tick();
  children[0].send({ type: 'system', subtype: 'init', session_id: 'native-claude' });
  children[0].exitOnSignal = false;
  const stopping = session.cancel();
  children[0].send({ type: 'result', subtype: 'success', usage: {} });
  await tick();
  await assert.rejects(drain(session.send('too early')), { code: 'ESESSION_BUSY' });
  children[0].emit('exit', 0);
  await stopping;
  await a;
  const b = drain(session.send('B'));
  await tick();
  assert.equal(spawns.at(-1).resumeSessionId, 'native-claude');
  children[0].emit('exit', 0);
  children[0].send({ type: 'result', subtype: 'error', usage: {} });
  children[1].send({ type: 'system', subtype: 'init', session_id: 'native-claude' });
  children[1].send({ type: 'result', subtype: 'success', usage: {} });
  assert.ok((await b).some((e) => e.kind === 'retry_start'));
  assert.equal(session.getState(), 'idle');
  assert.equal(session.nativeSessionId, 'native-claude');
  await session.dispose();
});

test('Claude rejects a mismatching late init without replacing its native binding', async (t) => {
  const { session, children, writes } = claude(t);
  await session.spawnResume('native-claude');
  const running = drain(session.send('resume'));
  await tick();
  children[0].send({ type: 'system', subtype: 'init', session_id: 'wrong' });
  const events = await running;
  assert.ok(events.some((e) => e.kind === 'runtime_error'));
  assert.equal(session.nativeSessionId, 'native-claude');
  assert.equal(writes.length, 0);
  await session.dispose();
});

for (const action of ['cancel', 'destroy'] as const) {
  test(`Pi ${action} during setup cannot dispatch a prompt or install an Agent`, async (t) => {
    configureRuntimeDeps({
      dataDir: '/tmp/michi-pi-cancel-tests',
      historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null, hasGrant: () => false, grantPermission() {} },
      providerKeys: { getProviderApiKey: () => 'fake' },
      agentConfig: { getAgentConfig: () => ({ provider: 'deepseek' } as any), resolveModel: () => 'deepseek-chat', resolveReasoning: () => undefined },
    });
    t.after(__resetRuntimeDeps);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    t.mock.method(require('../src/agents/pi/piAi'), 'loadPiAi', () => gate);
    const session = new PiSession('pi-node', { bridge, preamble: '', cwd: '/tmp', workspaceId: null, ownerUserId: null, enableFollowUps: false, requestedModel: 'deepseek-chat' });
    const running = drain(session.send('A'));
    await tick();
    assert.equal(session.currentModelId, 'deepseek-chat');
    session[action]();
    assert.deepEqual((await running).at(-1), { kind: 'turn_end', stopReason: 'cancelled' });
    release();
    await tick();
    assert.equal((session as any).agent, undefined);
    session.destroy();
  });
}
