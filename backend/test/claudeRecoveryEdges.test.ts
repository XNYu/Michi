import './helpers/claudeSdkFixture';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ClaudeSession, type ClaudeSessionDeps } from 'michi-runtime/internal/adapters/claude/ClaudeSession';
import { ClaudeSessionManager } from 'michi-runtime/internal/adapters/claude/ClaudeSessionManager';
import { ClaudeRuntime, ClaudeSessionNotResumableError } from 'michi-runtime/internal/adapters/claude/ClaudeRuntime';
import type { NormalizedEvent } from '../src/services/chatEvents';
import * as sessionRegistry from '../src/agents/sessionRegistry';
import * as claudeProjectsPath from 'michi-runtime/internal/adapters/claude/claudeProjectsPath';
import { log } from '../src/services/logger';
import { runOwner } from './helpers/owners';

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

function harness(t: TestContext, Session = ClaudeSession) {
  const binary = require('michi-runtime/internal/adapters/claude/claudeBinary');
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
  const logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
  for (const level of ['info', 'warn', 'error'] as const) {
    t.mock.method(log, level, (_stage: string, message: string, meta?: Record<string, unknown>) => {
      logs.push({ level, message, meta });
    });
  }
  const mcp: any = {
    create(id: string, _cwd: string, _owner: unknown, callbacks: any, opts: any) {
      const slot = { slotId: `slot-${++nextSlot}`, parentChatId: id, ...callbacks, ...opts };
      slots.set(slot.slotId, slot);
      return slot;
    },
    get(id: string) { return slots.get(id); },
    async dispose(id: string) { if (disposalGate) await disposalGate; slots.delete(id); },
    endpoint: (slotId: string) => ({ type: 'http' as const, url: `http://127.0.0.1:3000/api/mcp/${slotId}`, headers: [] }),
    rebind(id: string, patch: object) { const slot = slots.get(id); if (slot) Object.assign(slot, patch); },
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
  t.mock.method(require('michi-runtime/internal/adapters/claude/claudeProjectsPath'), 'getClaudeJsonlPath', () => '/__michi_test_missing__/native.jsonl');
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
    children, spawns, writes, slots, db, mcp, logs,
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
      const session = new Session('node-edge', {
        options: claudeTestOptions(),
        nodeId: 'node-edge', cwd: '/tmp', workspaceId: null, bridge, mcpRegistry: mcp, ...overrides,
      });
      sessions.add(session);
      return session;
    },
    manager(cap = 1, poolDisabled = true) {
      const manager = new ClaudeSessionManager({ bridge, mcpRegistry: mcp, options: claudeTestOptions(), concurrencyCap: cap, currentModel: 'sonnet', poolDisabled, sessionsPerSlot: 1 });
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
  const current = runOwner('run', 'current');
  const stale = runOwner('run', 'previous');
  const session = await manager.createSession({ id: 'current', owner: current, cwd: '/tmp' });
  await assert.rejects(manager.releaseSession('current', stale), {
    code: 'SESSION_OWNER_MISMATCH',
  });
  assert.equal(manager.get('current'), session);
  assert.deepEqual(h.children[0].signals, []);
  await manager.releaseSession('current', current);
  assert.equal(manager.get('current'), undefined);
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
  t.mock.timers.tick(59_999);
  await tick();
  assert.equal(session.getState(), 'in_turn');
  assert.deepEqual(h.children[0].signals, []);
  t.mock.timers.tick(1);
  const events = await running;
  assert.ok(events.some((event) => event.kind === 'runtime_error' && /60 seconds/.test(event.error)));
  assert.equal(session.nativeSessionId, 'native-original');
  assert.equal(session.getState(), 'crashed');
  assert.ok(h.logs.some((entry) => entry.message === 'claude process failed'
    && entry.meta?.nativeSessionId === 'native-original' && entry.meta?.resumePending === true));
});

test('native restore accepts slow initialization and clears its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t), session = h.session();
  await session.spawnResume('native-original');
  const running = drain(session.send('resume'));
  await tick();
  t.mock.timers.tick(30_000);
  await tick();
  assert.deepEqual(h.children[0].signals, []);
  h.children[0].init();
  t.mock.timers.tick(60_000);
  h.children[0].chunk('restored');
  h.children[0].result();
  const events = await running;
  assert.ok(events.some((event) => event.kind === 'retry_end'));
  assert.ok(events.some((event) => event.kind === 'chunk' && event.text === 'restored'));
  assert.ok(!events.some((event) => event.kind === 'runtime_error'));
  assert.equal(session.nativeSessionId, 'native-original');
  assert.ok(h.logs.some((entry) => entry.message === 'claude native restore initialized'));
});

for (const [configured, expectedMs] of [['1250', 1250], ['invalid', 60_000], ['0', 60_000], ['2147483648', 60_000]] as const) {
  test(`native restore uses configured deadline ${configured} safely`, async (t) => {
    // Read when the session's options are built (michiClaudeAdapterOptions).
    const previous = process.env.MICHI_CLAUDE_INIT_TIMEOUT_MS;
    process.env.MICHI_CLAUDE_INIT_TIMEOUT_MS = configured;
    t.after(() => {
      if (previous === undefined) delete process.env.MICHI_CLAUDE_INIT_TIMEOUT_MS;
      else process.env.MICHI_CLAUDE_INIT_TIMEOUT_MS = previous;
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness(t), session = h.session();
    await session.spawnResume('native-original');
    const running = drain(session.send('resume'));
    await tick();
    t.mock.timers.tick(expectedMs - 1);
    await tick();
    assert.deepEqual(h.children[0].signals, []);
    t.mock.timers.tick(1);
    const events = await running;
    assert.ok(events.some((event) => event.kind === 'runtime_error'
      && event.error.includes(`${expectedMs / 1000} seconds`)));
    assert.equal(session.nativeSessionId, 'native-original');
  });
}

test('Claude stderr is persisted with bounded process context and keeps the credential notice', async (t) => {
  const h = harness(t), session = h.session();
  await session.spawnResume('native-original');
  const running = drain(session.send('resume'));
  await tick();
  h.children[0].stderr.write('awsCredentialExport did not return a valid value ' + 'x'.repeat(3_000));
  h.children[0].init();
  h.children[0].result();
  const events = await running;
  const entry = h.logs.find((entry) => entry.message === 'claude stderr');
  assert.equal(entry?.level, 'warn');
  assert.equal(entry?.meta?.nodeId, 'node-edge');
  assert.equal(entry?.meta?.pid, h.children[0].pid);
  assert.equal(entry?.meta?.resumePending, true);
  assert.equal(String(entry?.meta?.stderr).length, 2_000);
  const notices = events.filter((event) => event.kind === 'warning');
  assert.deepEqual(notices, [{
    kind: 'warning', source: 'auth', category: 'configuration',
    message: 'AWS credentials unavailable. Refresh your credentials in your terminal, then retry.',
  }]);
  assert.equal(events.some((event) => event.kind === 'mcp_server_error'), false,
    'a CLI credential warning must not be attributed to an MCP server');
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

test('model switch before init uses SDK controls, locks sends and preserves the process', async (t) => {
  const h = harness(t), session = h.session({ model: 'sonnet' });
  await session.spawnFresh();
  let release!: () => void;
  let selected: string | undefined;
  (session as any).transport.query.setModel = async (model: string) => { selected = model; await new Promise<void>(resolve => { release = resolve; }); };
  const switching = session.setModel('claude-sonnet-4-6');
  await tick();
  await assert.rejects(drain(session.send('racing prompt')), { code: 'ESESSION_BUSY' });
  assert.equal(h.spawns.length, 1);
  release(); await switching;
  assert.equal(selected, 'claude-sonnet-4-6');
  assert.equal(h.spawns.length, 1);
  assert.equal(session.currentModelId, 'claude-sonnet-4-6');
  assert.equal(session.nativeSessionId, null);
  assert.deepEqual(h.writes, []);
});

test('Claude loader rejects public placeholders but accepts a real legacy native token', async (t) => {
  const h = harness(t);
  t.mock.method(h.db, 'getNode', () => ({ id: 'public-node', acp_session_id: 'public-node', external_session_id: null }));
  const runtime = new ClaudeRuntime({ ...claudeTestOptions(), bridge, mcpSlots: h.mcp });
  t.after(() => runtime.shutdown());
  await assert.rejects(runtime.loadSession({ sessionId: 'public-node', cwd: '/tmp' }), ClaudeSessionNotResumableError);
  assert.equal(h.spawns.length, 0);
  t.mock.method(h.db, 'getNode', () => ({ id: 'public-node', acp_session_id: 'native-legacy', external_session_id: null }));
  t.mock.method(claudeProjectsPath, 'claudeTranscriptFindable', async () => true);
  const loaded = await runtime.loadSession({ sessionId: 'public-node', cwd: '/tmp' });
  assert.equal(loaded.nativeSessionId, 'native-legacy');
  assert.equal(h.spawns[0].resumeSessionId, 'native-legacy');
});

test('native interrupt waits for ACK and result, preserves process, and reports cancelled', async (t) => {
  const h = harness(t), session = h.session(); await session.spawnFresh();
  const child = h.children[0]; let ack!: () => void;
  (session as any).transport.query.interrupt = () => new Promise<void>(r => { ack = r; });
  const active = drain(session.send('work')); await tick(); child.init(); child.chunk('partial');
  const cancelling = session.cancel(); let finished = false; void cancelling.then(() => { finished = true; });
  ack(); await tick(); assert.equal(finished, false, 'control ACK alone is not a terminal boundary');
  child.result(); const events = await active; const result = await cancelling;
  assert.equal(result.source, 'native'); assert.equal(result.acknowledged, true);
  assert.equal(events.at(-1)?.kind, 'turn_end'); assert.equal((events.at(-1) as any).stopReason, 'cancelled');
  assert.equal(session.getState(), 'idle'); assert.deepEqual(child.signals, []);
  const next = drain(session.send('next')); await tick(); child.chunk('new'); child.result();
  assert.equal((await next).filter(e => e.kind === 'chunk').map(e => (e as any).text).join(''), 'new');
  assert.equal(h.spawns.length, 1);
});

test('mandatory SDK hook denies auto-approved Run tools and canonicalizes internal MCP tools', async (t) => {
  const h = harness(t); const calls: any[] = [];
  const session = h.session({ owner: runOwner('run', 'attempt'),
    toolProfile: { allowedToolNames: ['read', 'submit_agent_result'] },
    permissionBroker: { requestPermission: async (request: any) => { calls.push(request); return 'allow_once'; } } });
  await session.spawnFresh(); const hooks = h.spawns[0]; const signal = new AbortController().signal;
  assert.equal((await hooks.preToolUse('Bash', { command: 'touch forbidden' }, 'b', signal)).behavior, 'deny');
  assert.equal(calls.length, 0);
  assert.equal((await hooks.preToolUse('mcp____michi_internal____submit_agent_result', {}, 'm', signal)).behavior, 'allow');
  assert.equal(calls[0].toolName, 'submit_agent_result');
  assert.equal((await hooks.preToolUse('Read', {}, 'r', signal)).behavior, 'allow');
  assert.deepEqual(hooks.tools, ['ToolSearch', 'Read']);
  assert.equal(hooks.allowedTools, undefined);
});

test('native AskUserQuestion resolves through Michi interaction queue and cancellation cleans it', async (t) => {
  const h = harness(t), session = h.session(); await session.spawnFresh();
  const ac = new AbortController(); const args = h.spawns[0];
  const answer = args.authorize('AskUserQuestion', { questions: [{ question: 'Color?', options: [{ label: 'Blue' }], multiSelect: false }] }, 'q', ac.signal);
  await tick(); const requestId = [...(session as any).pendingUserInputs.keys()][0];
  assert.equal(typeof requestId, 'number'); session.respondToUserInput(requestId, [{ question: 'Color?', answer: 'Blue' }]);
  assert.deepEqual((await answer).updatedInput.answers, { 'Color?': 'Blue' });
  const cancelled = args.authorize('AskUserQuestion', { questions: [] }, 'q2', ac.signal);
  ac.abort(); assert.equal((await cancelled).behavior, 'deny'); assert.equal((session as any).pendingUserInputs.size, 0);
});

test('native AskUserQuestion obeys Run broker denial before opening user input', async (t) => {
  const h = harness(t); const calls: string[] = [];
  const session = h.session({ owner: runOwner('run', 'attempt'),
    toolProfile: { allowedToolNames: ['AskUserQuestion'] },
    permissionBroker: { requestPermission: async (request: any) => { calls.push(request.toolName); return 'deny'; } } });
  await session.spawnFresh();
  const result = await h.spawns[0].preToolUse('AskUserQuestion', {
    questions: [{ question: 'Color?', options: [{ label: 'Blue' }], multiSelect: false }],
  }, 'q', new AbortController().signal);
  assert.equal(result.behavior, 'deny');
  assert.deepEqual(calls, ['AskUserQuestion']);
  assert.equal((session as any).pendingUserInputs.size, 0);
});

test('SDK model failure keeps selected model and rejects concurrent commands', async (t) => {
  const h = harness(t), session = h.session({ model: 'sonnet' }); await session.spawnFresh();
  (session as any).transport.query.setModel = async () => { throw new Error('unsupported model'); };
  await assert.rejects(session.setModel('invalid'), /unsupported model/); assert.equal(session.currentModelId, 'sonnet');
  const active = drain(session.send('work')); await tick();
  await assert.rejects(session.executeCommand('status'), /active turn/);
  h.children[0].init(); h.children[0].result(); await active;
  assert.equal((await session.executeCommand('fork')).success, false);
});

test('structured authentication failure stops retrying while retaining native identity', async (t) => {
  const h = harness(t), session = h.session(); await session.spawnFresh();
  const active = drain(session.send('work')); await tick(); h.children[0].init('auth-original');
  h.children[0].send({ type: 'system', subtype: 'api_retry', error: 'authentication_failed' });
  const events = await active;
  assert.equal(session.nativeSessionId, 'auth-original'); assert.equal(session.getState(), 'crashed');
  assert(events.some(e => e.kind === 'runtime_error' && /authentication failed/.test(e.error)));
  assert(h.children[0].signals.includes('SIGKILL'));
});

test('SDK session trust is revocable and isolated from a different user session', async t => {
  const h = harness(t);
  let resetToken = 'first';
  t.mock.method(require('../src/agents/runtimeDeps'), 'getRuntimeDeps', () => ({
    chatPermissions: { getMode: () => 'ask', hasGrant: () => false, resetToken: () => resetToken },
  }));
  const session = h.session({ ownerUserId: 'owner-one' });
  await session.spawnFresh();
  const events: any[] = [];
  t.mock.method((session as any).queue, 'push', (event: any) => { events.push(event); });
  const signal = new AbortController().signal;
  const authorize = h.spawns[0].authorize;
  const first = authorize('Bash', { command: 'fixture' }, 'tool-1', signal);
  const request = events.at(-1);
  assert.equal(request.options.some((option: any) => option.optionId === 'allow_session'), true);
  session.respondToPermission(request.requestId, 'allow_session');
  assert.equal((await first).behavior, 'allow');
  const beforeTrusted = events.length;
  assert.equal((await authorize('Edit', {}, 'tool-2', signal)).behavior, 'allow');
  assert.equal(events.length, beforeTrusted);
  resetToken = 'revoked';
  const revoked = authorize('Edit', {}, 'tool-3', signal);
  const revokedRequest = events.at(-1);
  assert.notEqual(revokedRequest.requestId, request.requestId);
  session.respondToPermission(revokedRequest.requestId, 'reject_once');
  assert.equal((await revoked).behavior, 'deny');

  const other = h.session({ ownerUserId: 'owner-two' });
  await other.spawnFresh();
  t.mock.method((other as any).queue, 'push', (event: any) => { events.push(event); });
  const isolated = h.spawns[1].authorize('Bash', {}, 'other-user', signal);
  assert.equal((other as any).pendingPermissions.size, 1);
  other.respondToPermission(events.at(-1).requestId, 'reject_once');
  assert.equal((await isolated).behavior, 'deny');
});

test('late Run broker approval cannot bypass a cancelled SDK tool signal', async t => {
  const h = harness(t);
  let release!: (decision: string) => void;
  const session = h.session({ owner: runOwner('run', 'attempt'),
    toolProfile: { allowedToolNames: ['read'] },
    permissionBroker: { requestPermission: (() => new Promise(resolve => { release = resolve; })) as any },
  });
  await session.spawnFresh();
  const controller = new AbortController();
  const pending = h.spawns[0].preToolUse('Read', {}, 'late-read', controller.signal);
  controller.abort();
  release('allow_once');
  assert.equal((await pending).behavior, 'deny');
  assert.equal((session as any).pendingPermissions.size, 0);
});

test('cancelled native question ignores late answers without resolving the next question', async t => {
  const h = harness(t), session = h.session();
  await session.spawnFresh();
  const events: any[] = [];
  t.mock.method((session as any).queue, 'push', (event: any) => { events.push(event); });
  const args = h.spawns[0];
  const controller = new AbortController();
  const questions = { questions: [{ question: 'Color?', options: [{ label: 'Blue' }], multiSelect: false }] };
  const old = args.authorize('AskUserQuestion', questions, 'question-old', controller.signal);
  const oldId = events.at(-1).requestId;
  controller.abort();
  assert.equal((await old).behavior, 'deny');
  const next = args.authorize('AskUserQuestion', questions, 'question-next', new AbortController().signal);
  const nextId = events.at(-1).requestId;
  assert.notEqual(nextId, oldId);
  session.respondToUserInput(oldId, [{ question: 'Color?', answer: 'Red' }]);
  assert.equal((session as any).pendingUserInputs.has(nextId), true);
  session.respondToUserInput(nextId, [{ question: 'Color?', answer: 'Blue' }]);
  assert.deepEqual((await next).updatedInput.answers, { 'Color?': 'Blue' });
});

for (const oldSource of ['native', 'mcp'] as const) {
  test(`restoring the same node ignores an old ${oldSource} question reply`, async t => {
    const h = harness(t), original = h.session();
    const questions = [{ question: 'Color?', options: [{ label: 'Blue' }], multiSelect: false }];
    await original.spawnFresh();
    const oldQuestion = oldSource === 'native'
      ? h.spawns[0].authorize('AskUserQuestion', { questions }, 'old-question', new AbortController().signal)
      : h.slots.get('slot-1').onAskUser(questions);
    const oldId = [...(original as any).pendingUserInputs.keys()][0] as number;
    assert.ok(Number.isSafeInteger(oldId));
    await original.dispose();
    assert.equal(oldSource === 'native' ? (await oldQuestion).behavior : await oldQuestion,
      oldSource === 'native' ? 'deny' : null);

    const restored = h.session();
    assert.equal(restored.id, original.id);
    await restored.spawnResume('native-original');
    // Switching native/MCP sources also verifies that both use one namespace.
    const current = oldSource === 'native'
      ? h.slots.get('slot-2').onAskUser(questions)
      : h.spawns[1].authorize('AskUserQuestion', { questions }, 'new-question', new AbortController().signal);
    const currentId = [...(restored as any).pendingUserInputs.keys()][0] as number;
    assert.ok(Number.isSafeInteger(currentId));
    assert.ok(currentId > oldId);
    restored.respondToUserInput(oldId, [{ question: 'Color?', answer: 'Red' }]);
    await tick();
    assert.equal((restored as any).pendingUserInputs.has(currentId), true);
    restored.respondToUserInput(currentId, [{ question: 'Color?', answer: 'Blue' }]);
    assert.deepEqual(oldSource === 'native' ? await current : (await current).updatedInput.answers,
      { 'Color?': 'Blue' });
  });
}

for (const kind of ['chat', 'run'] as const) {
  test(`replacing the same node ignores an old ${kind} approval reply`, async t => {
    const h = harness(t);
    t.mock.method(require('../src/agents/runtimeDeps'), 'getRuntimeDeps', () => ({
      chatPermissions: { getMode: () => 'ask', hasGrant: () => false, resetToken: () => 'fixture' },
    }));
    const overrides: Partial<ClaudeSessionDeps> = kind === 'run'
      ? { ownerUserId: 'fixture-owner', owner: runOwner('run', 'attempt'),
        permissionBroker: { requestPermission: async () => 'ask' } }
      : { ownerUserId: 'fixture-owner' };
    const original = h.session(overrides);
    await original.spawnFresh();
    const oldApproval = h.spawns[0].authorize('Bash', { command: 'old command' }, 'old-tool', new AbortController().signal);
    await tick();
    const oldId = [...(original as any).pendingPermissions.keys()][0] as number;
    assert.ok(Number.isSafeInteger(oldId));
    await original.dispose();
    assert.equal((await oldApproval).behavior, 'deny');

    const replacement = h.session(overrides);
    assert.equal(replacement.id, original.id);
    await replacement.spawnFresh();
    const current = h.spawns[1].authorize('Bash', { command: 'new command' }, 'new-tool', new AbortController().signal);
    await tick();
    const currentId = [...(replacement as any).pendingPermissions.keys()][0] as number;
    assert.ok(Number.isSafeInteger(currentId));
    assert.ok(currentId > oldId);
    replacement.respondToPermission(oldId, 'allow_once');
    await tick();
    assert.equal((replacement as any).pendingPermissions.has(currentId), true);
    replacement.respondToPermission(currentId, 'reject_once');
    assert.equal((await current).behavior, 'deny');
  });
}

test('completed SDK turns persist their last parent message and original user UUID before yielding completion', async t => {
  const h = harness(t), session = h.session();
  const anchors: any[] = [];
  t.mock.method(require('../src/services/claudeForkAnchors'), 'saveClaudeForkAnchor', (anchor: any) => anchors.push(anchor));
  await session.spawnFresh();
  let outgoing: any;
  h.children[0].stdin.on('data', data => { outgoing = JSON.parse(data.toString()); });
  const active = drain(session.send('branchable', { assistantMessageId: 'michi-assistant', userMessageId: 'michi-user' }));
  await tick();
  h.children[0].init();
  h.children[0].send({ type: 'assistant', uuid: 'first-parent', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } });
  h.children[0].send({ type: 'assistant', uuid: 'last-parent', message: { role: 'assistant', content: [{ type: 'text', text: 'last' }] } });
  h.children[0].send({ type: 'assistant', uuid: 'child-message', parent_tool_use_id: 'child-tool', message: { role: 'assistant', content: [{ type: 'text', text: 'child' }] } });
  h.children[0].result();
  await active;
  assert.equal(anchors.length, 1);
  assert.deepEqual(anchors[0], {
    nodeId: 'node-edge', nativeSessionId: 'native-original',
    assistantMessageId: 'michi-assistant', userMessageId: 'michi-user',
    nativeMessageId: 'last-parent', nativeUserMessageId: outgoing.uuid,
  });
  assert.match(outgoing.uuid, /^[0-9a-f-]{36}$/);
  // startTurn must clear the old position rather than mapping a new text-only
  // stream to the previous answer's persisted history entry.
  const next = drain(session.send('no persisted parent', { assistantMessageId: 'next-assistant' }));
  await tick();
  h.children[0].chunk('partial only');
  h.children[0].result();
  await next;
  assert.equal(anchors.length, 1);
});

test('native fork anchor persistence failure keeps the visible answer successful', async t => {
  const h = harness(t), session = h.session();
  t.mock.method(require('../src/services/claudeForkAnchors'), 'saveClaudeForkAnchor', () => { throw new Error('write unavailable'); });
  await session.spawnFresh();
  const active = drain(session.send('answer', { assistantMessageId: 'michi-assistant' }));
  await tick();
  h.children[0].init();
  h.children[0].send({ type: 'assistant', uuid: 'native-message', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } });
  h.children[0].result();
  const events = await active;
  assert.equal(events.at(-1)?.kind, 'turn_end');
  assert.equal((events.at(-1) as any).stopReason, 'end_turn');
  assert(h.logs.some(entry => entry.level === 'warn' && /fork anchor/.test(entry.message)));
});
