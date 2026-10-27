import './helpers/claudeSdkFixture';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ClaudeSession } from 'michi-runtime/internal/adapters/claude/ClaudeSession';
import type { NormalizedEvent } from '../src/services/chatEvents';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const drain = async (events: AsyncIterable<NormalizedEvent>) => {
  const result: NormalizedEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
};

class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: NodeJS.Signals[] = [];
  exitOnSignal = true;
  exited = false;
  constructor(public pid: number) { super(); }
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    if (this.exitOnSignal) queueMicrotask(() => this.exit());
    return true;
  }
  exit() { if (!this.exited) { this.exited = true; this.emit('exit', 0, null); } }
  send(message: object) { this.stdout.write(JSON.stringify(message) + '\n'); }
  init() { this.send({ type: 'system', subtype: 'init', session_id: 'native-self' }); }
  result() { this.send({ type: 'result', subtype: 'success', usage: {} }); }
  chunk(text: string) {
    this.send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  }
}

function harness(t: TestContext) {
  const binary = require('michi-runtime/internal/adapters/claude/claudeBinary');
  const children: Child[] = [];
  const spawns: any[] = [];
  t.mock.method(binary, 'preflightClaudeAuth', () => {});
  t.mock.method(binary, 'spawnClaude', (options: unknown) => {
    spawns.push(options);
    const child = new Child(20_000 + children.length);
    children.push(child);
    return child;
  });
  t.mock.method(require('../src/agents/processTree'), 'killProcessTree', (pid: number, signal: NodeJS.Signals) => {
    const child = children.find((entry) => entry.pid === pid);
    assert.ok(child, 'only fixture processes may be signaled');
    child.kill(signal);
  });
  t.mock.method(require('../src/services/dbRepository'), 'setNodeExternalSessionId', () => {});
  t.mock.method(require('michi-runtime/internal/adapters/claude/claudeProjectsPath'), 'getClaudeJsonlPath', () => '/__michi_test_missing__/native.jsonl');
  const session = new ClaudeSession('node-self', {
    options: claudeTestOptions(),
    nodeId: 'node-self', cwd: '/tmp', workspaceId: null,
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any,
    mcpRegistry: { create: () => ({ slotId: 'slot-self' }), dispose: async () => {}, get: () => ({}), endpoint: (slotId: string) => ({ type: 'http' as const, url: `http://127.0.0.1:3000/api/mcp/${slotId}`, headers: [] }), rebind: () => {} } as any,
  });
  let selfDone = Promise.resolve<NormalizedEvent[]>([]);
  const selfEvents: NormalizedEvent[] = [];
  session.onSelfTurn(({ events }) => {
    selfDone = (async () => {
      for await (const event of events) selfEvents.push(event);
      return selfEvents;
    })();
  });
  t.after(async () => {
    for (const child of children) child.exit();
    await session.dispose();
  });
  return {
    session, children, spawns, selfEvents,
    selfDone: () => selfDone,
    holdInterrupt() {
      let acknowledge!: () => void;
      (session as any).transport.query.interrupt = () => new Promise<void>((resolve) => { acknowledge = resolve; });
      return () => acknowledge();
    },
    async beginSelfTurn() {
      await session.spawnFresh();
      children[0].init();
      children[0].chunk('background');
      await tick();
      assert.ok(selfEvents.some((event) => event.kind === 'chunk'));
    },
  };
}

test('self-turn result holds its owner until interrupt ACK and the next turn can be cancelled independently', async (t) => {
  const h = harness(t);
  await h.beginSelfTurn();
  const acknowledge = h.holdInterrupt();
  const cancelling = h.session.cancel();
  h.children[0].result();
  await tick();
  assert.equal(h.selfEvents.some((event) => event.kind === 'turn_end'), false);
  await assert.rejects(drain(h.session.send('too early')), { code: 'ESESSION_BUSY' });
  assert.equal(h.session.cancel(), cancelling, 'a repeated cancel still belongs to the self-turn');
  assert.equal(h.children[0].stdin.read(), null, 'no later user prompt crossed the old cancellation');

  acknowledge();
  assert.equal((await cancelling).source, 'native');
  assert.deepEqual((await h.selfDone()).at(-1), { kind: 'turn_end', stopReason: 'cancelled' });
  await tick();
  assert.deepEqual(h.children[0].signals, []);

  const next = drain(h.session.send('next'));
  await tick();
  assert.match(h.children[0].stdin.read().toString(), /next/);
  const acknowledgeNext = h.holdInterrupt();
  const cancellingNext = h.session.cancel();
  assert.notEqual(cancellingNext, cancelling);
  h.children[0].result();
  acknowledgeNext();
  await cancellingNext;
  assert.deepEqual((await next).at(-1), { kind: 'turn_end', stopReason: 'cancelled' });
  assert.equal(h.spawns.length, 1);
});

test('self-turn interrupt timeout retires the process before the next turn resumes its native identity', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t);
  await h.beginSelfTurn();
  h.holdInterrupt();
  const cancelling = h.session.cancel();
  h.children[0].result();
  await tick();
  t.mock.timers.tick(10_000);
  await tick();
  assert.equal((await cancelling).source, 'inferred');
  assert.deepEqual((await h.selfDone()).at(-1), { kind: 'turn_end', stopReason: 'cancelled' });
  await tick();
  assert.deepEqual(h.children[0].signals, ['SIGINT', 'SIGKILL']);

  const next = drain(h.session.send('next'));
  await tick();
  assert.equal(h.spawns[1].resumeSessionId, 'native-self');
  h.children[0].chunk('stale');
  h.children[0].result();
  h.children[1].init();
  h.children[1].chunk('fresh');
  h.children[1].result();
  const events = await next;
  assert.equal(events.filter((event) => event.kind === 'chunk').map((event: any) => event.text).join(''), 'fresh');
  assert.equal(h.session.nativeSessionId, 'native-self');
});

test('unconfirmed self-turn retirement never admits a replacement process', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t);
  await h.beginSelfTurn();
  h.children[0].exitOnSignal = false;
  h.holdInterrupt();
  const cancelling = h.session.cancel();
  h.children[0].result();
  await tick();
  t.mock.timers.tick(10_000);
  await tick();
  t.mock.timers.tick(2_000);
  await tick();
  t.mock.timers.tick(1_000);
  await tick();
  assert.equal((await cancelling).acknowledged, false);
  assert.deepEqual((await h.selfDone()).at(-1), { kind: 'turn_end', stopReason: 'cancelled' });
  await tick();
  assert.equal(h.session.getState(), 'crashed');

  const blocked = assert.rejects(drain(h.session.send('blocked')), /exit could not be confirmed/);
  await tick();
  t.mock.timers.tick(2_000);
  await tick();
  t.mock.timers.tick(1_000);
  await blocked;
  assert.equal(h.spawns.length, 1);
  assert.equal(h.session.nativeSessionId, 'native-self');
  h.children[0].exit();
});

test('a buffered result-only self-turn completes without retiring its healthy process', async (t) => {
  const h = harness(t);
  await h.session.spawnFresh();
  h.children[0].init();
  h.children[0].result();
  await tick();
  assert.deepEqual((await h.selfDone()).at(-1), { kind: 'turn_end', stopReason: 'end_turn' });
  assert.equal(h.session.getState(), 'idle');
  assert.deepEqual(h.children[0].signals, []);
  const next = drain(h.session.send('next'));
  await tick();
  h.children[0].result();
  assert.deepEqual((await next).at(-1), { kind: 'turn_end', stopReason: 'end_turn' });
  assert.equal(h.spawns.length, 1);
});

test('a self turn starts in chatHub on the chat\'s node, mapped from its owner as the node-id turn named it', async (t) => {
  const { chatHub } = require('../src/agents/chatHub') as typeof import('../src/agents/chatHub');
  const { createMichiRuntimeHost } = require('../src/agents/michiRuntimeHost') as typeof import('../src/agents/michiRuntimeHost');
  const started: Array<Record<string, unknown>> = [];
  let selfDone = Promise.resolve<NormalizedEvent[]>([]);
  t.mock.method(chatHub, 'startSelfTurn', ({ events, ...rest }: { events: AsyncIterable<NormalizedEvent> }) => {
    started.push(rest);
    selfDone = drain(events);
  });
  const h = harness(t);
  // ClaudeRuntime hands the self turn to the host's consumer unchanged; this is Michi's.
  const { backgroundTurns } = createMichiRuntimeHost();
  h.session.onSelfTurn((info) => backgroundTurns!.consume(info));
  await h.session.spawnFresh();
  h.children[0].init();
  h.children[0].result();
  await tick();
  assert.deepEqual((await selfDone).at(-1), { kind: 'turn_end', stopReason: 'end_turn' });
  assert.deepEqual(started, [{ chatId: 'node-self', ownerUserId: null, nodeId: 'node-self' }]);
});

test('an early self-turn consumer return retires the unfinished native owner', async (t) => {
  const h = harness(t);
  let returned = Promise.resolve();
  h.session.onSelfTurn(({ events }) => {
    returned = (async () => { await events.next(); await events.return?.(); })();
  });
  await h.session.spawnFresh();
  h.children[0].init();
  h.children[0].chunk('unfinished');
  await tick();
  await returned;
  await tick();
  assert.equal(h.session.getState(), 'crashed');
  assert.deepEqual(h.children[0].signals, ['SIGINT', 'SIGKILL']);
  assert.equal(h.session.nativeSessionId, 'native-self');
});
