import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ClaudeSession, type ClaudeSessionDeps } from '../src/agents/claude/ClaudeSession';
import { ClaudeSessionManager } from '../src/agents/claude/ClaudeSessionManager';
import { ClaudeRuntime, ClaudeSessionNotResumableError } from '../src/agents/claude/ClaudeRuntime';
import type { NormalizedEvent } from '../src/services/chatEvents';
import * as sessionRegistry from '../src/agents/sessionRegistry';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };
const drain = async (iterator: AsyncIterable<NormalizedEvent>) => {
  const events: NormalizedEvent[] = [];
  for await (const event of iterator) events.push(event);
  return events;
};

class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: NodeJS.Signals[] = [];
  exitOnSignal = true;
  exited = false;

  constructor(public pid: number | undefined) { super(); }

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.signals.push(signal);
    if (this.exitOnSignal && !this.exited) queueMicrotask(() => this.exit());
    return true;
  }

  exit() {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', 0, null);
  }

  send(envelope: object) { this.stdout.write(JSON.stringify(envelope) + '\n'); }
  init(id = 'native-original') { this.send({ type: 'system', subtype: 'init', session_id: id }); }
  result() { this.send({ type: 'result', subtype: 'success', usage: {} }); }
  chunk(text: string) {
    this.send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  }
}

function harness(t: TestContext) {
  const binary = require('../src/agents/claude/claudeBinary');
  const db = require('../src/services/dbRepository');
  const children: Child[] = [];
  const spawns: any[] = [];
  const writes: Array<[string, string]> = [];
  const sessions = new Set<ClaudeSession>();
  const managers = new Set<ClaudeSessionManager>();
  const slots = new Map<string, any>();
  const gates: Array<() => void> = [];
  let nextSlot = 0;
  let disposalGate: Promise<void> | null = null;
  let persistError: Error | null = null;
  let spawnError: Error | null = null;
  let nextHasPid = true;
  let autoWarm = false;
  const mcp: any = {
    create(id: string, _cwd: string, _owner: unknown, callbacks: any, opts: any) {
      const slot = { slotId: `slot-${++nextSlot}`, parentChatId: id, ...callbacks, ...opts };
      slots.set(slot.slotId, slot);
      return slot;
    },
    get(id: string) { return slots.get(id); },
    async dispose(id: string) { if (disposalGate) await disposalGate; slots.delete(id); },
  };
  t.mock.method(binary, 'preflightClaudeAuth', () => {});
  t.mock.method(binary, 'spawnClaude', (opts: unknown) => {
    spawns.push(opts);
    if (spawnError) { const error = spawnError; spawnError = null; throw error; }
    const child = new Child(nextHasPid ? 10_000 + children.length : undefined);
    nextHasPid = true;
    children.push(child);
    child.stdin.on('data', (data: Buffer) => {
      if (autoWarm && JSON.parse(data.toString()).shouldQuery === false) {
        queueMicrotask(() => { child.init(`native-warm-${child.pid}`); child.result(); });
      }
    });
    return child;
  });
  t.mock.method(require('../src/agents/processTree'), 'killProcessTree', (pid: number, signal: NodeJS.Signals) => {
    const child = children.find((entry) => entry.pid === pid);
    assert.ok(child, 'only fixture processes may be signaled');
    child.kill(signal);
  });
  t.mock.method(db, 'setNodeExternalSessionId', (nodeId: string, nativeId: string) => {
    if (persistError) throw persistError;
    writes.push([nodeId, nativeId]);
  });
  t.mock.method(require('../src/agents/claude/claudeProjectsPath'), 'getClaudeJsonlPath', () => '/__michi_test_missing__/native.jsonl');
  t.mock.method(require('../src/services/agentConfig'), 'resolveModel', () => 'sonnet');
  t.after(async () => {
    for (const release of gates) release();
    disposalGate = null;
    for (const child of children) child.exit();
    await Promise.all([...sessions].map((session) => session.dispose()));
    await Promise.all([...managers].map((manager) => manager.shutdown()));
    sessionRegistry.clearAllSessions();
  });
  return {
    children, spawns, writes, slots, db, mcp,
    failPersistence(error: Error | null) { persistError = error; },
    failSpawn(error: Error) { spawnError = error; },
    noPidNext() { nextHasPid = false; },
    warmAutomatically() { autoWarm = true; },
    blockDisposal() {
      let release!: () => void;
      disposalGate = new Promise<void>((resolve) => { release = resolve; });
      gates.push(release);
      return release;
    },
    session(overrides: Partial<ClaudeSessionDeps> = {}) {
      const session = new ClaudeSession('node-edge', {
        nodeId: 'node-edge', cwd: '/tmp', workspaceId: null, bridge, mcpRegistry: mcp, mcpPort: 1, ...overrides,
      });
      sessions.add(session);
      return session;
    },
    manager(cap = 1, poolDisabled = true) {
      const manager = new ClaudeSessionManager({ bridge, mcpRegistry: mcp, mcpPort: 1, concurrencyCap: cap, currentModel: 'sonnet', poolDisabled, sessionsPerSlot: 1 });
      managers.add(manager);
      return manager;
    },
  };
}

async function expireRetirement(t: TestContext) {
  await tick();
  t.mock.timers.tick(2_000);
  await tick();
  t.mock.timers.tick(1_000);
  await tick();
}

test('unconfirmed disposal never frees manager capacity, including a repeated attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t), manager = h.manager();
  const session = await manager.createSession({ id: 'A', cwd: '/tmp' });
  h.children[0].exitOnSignal = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const rejected = assert.rejects(manager.createSession({ id: 'B', cwd: '/tmp' }), /exit could not be confirmed/);
    await expireRetirement(t);
    await rejected;
    assert.equal(manager.get('A'), session);
    assert.equal(sessionRegistry.getSession('A'), session);
    assert.equal(h.children.length, 1);
    assert.equal(manager.stats().total, 1);
  }
  h.children[0].exit();
  await tick();
  await manager.createSession({ id: 'B', cwd: '/tmp' });
  assert.equal(h.children.length, 2);
});

test('unexpected exit retires the captured group and MCP before another native spawn', async (t) => {
  const h = harness(t), session = h.session();
  await session.spawnResume('native-original');
  const running = drain(session.send('A'));
  await tick();
  h.children[0].init();
  const release = h.blockDisposal();
  h.children[0].exit();
  const restoring = session.spawnResume('native-original');
  await tick();
  assert.deepEqual(h.children[0].signals, ['SIGINT', 'SIGKILL']);
  assert.equal(h.children.length, 1);
  assert.equal(h.slots.size, 1);
  release();
  await restoring;
  assert.ok((await running).some((event) => event.kind === 'turn_end' && event.stopReason === 'error'));
  assert.equal(h.slots.has('slot-1'), false);
  assert.equal(h.spawns[1].resumeSessionId, 'native-original');
});

test('stalled MCP retirement fails within a deadline without admitting another process', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t), manager = h.manager();
  await manager.createSession({ id: 'A', cwd: '/tmp' });
  const release = h.blockDisposal();
  const rejected = assert.rejects(manager.createSession({ id: 'B', cwd: '/tmp' }), /tool connection cleanup timed out/);
  await tick();
  t.mock.timers.tick(2_000);
  await rejected;
  assert.equal(h.children.length, 1);
  assert.ok(manager.get('A'));
  release();
  await manager.createSession({ id: 'B', cwd: '/tmp' });
  assert.equal(h.children.length, 2);
});

test('manager release respects Attempt ownership and retires the matching process tree', async (t) => {
  const h = harness(t), manager = h.manager();
  const current = { kind: 'agent_run' as const, runId: 'run', attemptId: 'current' };
  const stale = { ...current, attemptId: 'previous' };
  const session = await manager.createSession({ id: current.attemptId, owner: current, cwd: '/tmp' });
  await manager.releaseSession(current.attemptId, stale);
  assert.equal(manager.get(current.attemptId), session);
  assert.deepEqual(h.children[0].signals, []);
  await manager.releaseSession(current.attemptId, current);
  assert.equal(manager.get(current.attemptId), undefined);
  assert.deepEqual(h.children[0].signals, ['SIGINT', 'SIGKILL']);
  assert.equal(h.slots.size, 0);
});

for (const fault of ['chunk', 'result', 'missing-id', 'wrong-id'] as const) {
  test(`native restore rejects ${fault} before identity validation`, async (t) => {
    const h = harness(t), session = h.session();
    await session.spawnResume('native-original');
    const running = drain(session.send('resume'));
    await tick();
    if (fault === 'chunk') h.children[0].chunk('unvalidated');
    if (fault === 'result') h.children[0].result();
    if (fault === 'missing-id') h.children[0].send({ type: 'system', subtype: 'init' });
    if (fault === 'wrong-id') h.children[0].init('different-native');
    const events = await running;
    assert.ok(events.some((event) => event.kind === 'runtime_error'));
    assert.ok(!events.some((event) => event.kind === 'chunk' || event.kind === 'retry_end'));
    assert.ok(!events.some((event) => event.kind === 'turn_end' && event.stopReason === 'end_turn'));
    assert.equal(session.nativeSessionId, 'native-original');
    assert.deepEqual(h.writes, []);
  });
}

test('native initialization deadline is bounded and retains the original token', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t), session = h.session();
  await session.spawnResume('native-original');
  const running = drain(session.send('resume'));
  await tick();
  t.mock.timers.tick(20_000);
  const events = await running;
  assert.ok(events.some((event) => event.kind === 'runtime_error' && /20 seconds/.test(event.error)));
  assert.equal(session.nativeSessionId, 'native-original');
  assert.equal(session.getState(), 'crashed');
});

for (const fresh of [true, false]) {
  test(`DB init failure retains the ${fresh ? 'newly learned' : 'resumed'} token for native retry`, async (t) => {
    const h = harness(t), session = h.session();
    if (fresh) await session.spawnFresh();
    else await session.spawnResume('native-original');
    if (fresh) assert.equal(session.nativeSessionId, null, 'spawn UUID is not a native binding');
    h.failPersistence(new Error('missing node row'));
    const running = drain(session.send('A'));
    await tick();
    h.children[0].init();
    h.children[0].chunk('must not appear');
    h.children[0].result();
    const failed = await running;
    assert.ok(failed.some((event) => event.kind === 'runtime_error' && /persisted.*missing node row/.test(event.error)));
    assert.ok(!failed.some((event) => event.kind === 'retry_end' || event.kind === 'chunk'));
    assert.equal(session.nativeSessionId, 'native-original');
    h.failPersistence(null);
    const retry = drain(session.send('retry'));
    await tick();
    assert.equal(h.spawns[1].resumeSessionId, 'native-original');
    h.children[1].init();
    h.children[1].chunk('validated');
    h.children[1].result();
    const events = await retry;
    assert.deepEqual(h.writes, [['node-edge', 'native-original']]);
    assert.deepEqual(events.filter((event) => event.kind === 'retry_start' || event.kind === 'retry_end').map((event) => event.kind), ['retry_start', 'retry_end']);
    assert.deepEqual(events.filter((event) => event.kind === 'chunk'), [{ kind: 'chunk', text: 'validated' }]);
  });
}

test('asynchronous spawn failure without PID or exit does not poison native retry', async (t) => {
  const h = harness(t), session = h.session();
  h.noPidNext();
  await session.spawnResume('native-original');
  const running = drain(session.send('A'));
  await tick();
  h.children[0].exitOnSignal = false;
  h.children[0].emit('error', Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }));
  h.children[0].emit('close', -1, null);
  assert.ok((await running).some((event) => event.kind === 'runtime_error'));
  assert.equal(h.children[0].exited, false, 'failed spawn must not need an exit event');
  const retry = drain(session.send('retry'));
  await tick();
  assert.equal(h.spawns[1].resumeSessionId, 'native-original');
  h.children[1].init();
  h.children[1].result();
  assert.ok((await retry).some((event) => event.kind === 'retry_end'));
});

test('synchronous spawn failure cleans its slot without losing the native retry token', async (t) => {
  const h = harness(t), session = h.session();
  h.failSpawn(new Error('binary temporarily unavailable'));
  await assert.rejects(session.spawnResume('native-original'), /temporarily unavailable/);
  assert.equal(h.slots.size, 0);
  assert.equal(session.nativeSessionId, 'native-original');
  const retry = drain(session.send('retry'));
  await tick();
  assert.equal(h.spawns[1].resumeSessionId, 'native-original');
  h.children[0].init();
  h.children[0].result();
  await retry;
});

test('warm initialization and handoff do not write an anonymous or partial DB binding', async (t) => {
  const h = harness(t), manager = h.manager(3, false);
  h.warmAutomatically();
  h.failPersistence(new Error('node does not exist until complete binding is written'));
  await manager.warm('/tmp', 'sonnet');
  const session = await manager.createSession({ id: 'real-node', cwd: '/tmp', model: 'sonnet' });
  assert.equal(session.nativeSessionId, 'native-warm-10000');
  assert.equal(session.getState(), 'idle');
  assert.deepEqual(h.writes, []);
  h.failPersistence(null);
  const running = drain(session.send('A'));
  await tick();
  h.children[0].init('native-warm-10000');
  h.children[0].result();
  await running;
  assert.deepEqual(h.writes, [['real-node', 'native-warm-10000']]);
});

test('model switch before init retires the unused process and starts the requested model', async (t) => {
  const h = harness(t), session = h.session({ model: 'sonnet' });
  await session.spawnFresh();
  const release = h.blockDisposal();
  const switching = session.setModel('opus');
  await tick();
  await assert.rejects(drain(session.send('racing prompt')), { code: 'ESESSION_BUSY' });
  assert.equal(h.spawns.length, 1);
  release();
  await switching;
  assert.equal(h.spawns[1].model, 'opus');
  assert.equal(h.spawns[1].resumeSessionId, undefined);
  assert.equal(session.currentModelId, 'opus');
  assert.equal(session.nativeSessionId, null);
  assert.deepEqual(h.writes, []);
});

test('Claude loader rejects public placeholders but accepts a real legacy native token', async (t) => {
  const h = harness(t);
  t.mock.method(h.db, 'getNode', () => ({ id: 'public-node', acp_session_id: 'public-node', external_session_id: null }));
  const runtime = new ClaudeRuntime(bridge, h.mcp, 1);
  t.after(() => runtime.shutdown());
  await assert.rejects(runtime.loadSession({ sessionId: 'public-node', cwd: '/tmp' }), ClaudeSessionNotResumableError);
  assert.equal(h.spawns.length, 0);
  t.mock.method(h.db, 'getNode', () => ({ id: 'public-node', acp_session_id: 'native-legacy', external_session_id: null }));
  const loaded = await runtime.loadSession({ sessionId: 'public-node', cwd: '/tmp' });
  assert.equal(loaded.nativeSessionId, 'native-legacy');
  assert.equal(h.spawns[0].resumeSessionId, 'native-legacy');
});
