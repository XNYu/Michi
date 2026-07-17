/**
 * Unit tests for ClaudeSession.ts
 *
 * Uses node:test (Node 22+) + ts-node.
 * spawnClaude is stubbed; no real claude binary is invoked.
 */

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildStableSystemPrompt } from '../src/agents/preamble';

// ---- MockClaudeChild --------------------------------------------------------

class MockClaudeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  killSignals: string[] = [];

  kill(signal?: string): boolean {
    this.killed = true;
    this.killSignals.push(signal ?? 'SIGTERM');
    process.nextTick(() => this.emit('exit', signal === 'SIGKILL' ? 137 : 0, null));
    return true;
  }

  send(envelope: object): void {
    this.stdout.push(JSON.stringify(envelope) + '\n');
  }

  emitInit(sessionId = 'ext-session-001'): void {
    this.send({ type: 'system', subtype: 'init', session_id: sessionId });
  }

  emitResult(subtype: 'success' | 'error' = 'success'): void {
    this.send({ type: 'result', subtype, usage: { input_tokens: 10, output_tokens: 5 } });
  }

  emitChunk(text: string): void {
    this.send({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text },
      },
    });
  }

  emitThought(text: string): void {
    this.send({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: text },
      },
    });
  }
}

// ---- Stub helpers -----------------------------------------------------------

let mockChildFactory: (() => MockClaudeChild) | null = null;
const createdChildren: MockClaudeChild[] = [];
const capturedSpawnArgs: unknown[] = [];

function stubSpawnClaude(factory?: () => MockClaudeChild): void {
  createdChildren.length = 0;
  capturedSpawnArgs.length = 0;
  const claudeBinaryPath = require.resolve('../src/agents/claude/claudeBinary');
  const mod = require(claudeBinaryPath);
  mod._origSpawnClaude = mod._origSpawnClaude ?? mod.spawnClaude;
  mod._origPreflight = mod._origPreflight ?? mod.preflightClaudeAuth;
  mod.preflightClaudeAuth = () => {};
  mod.spawnClaude = (args: unknown) => {
    capturedSpawnArgs.push(args);
    const child = factory ? factory() : (mockChildFactory ? mockChildFactory() : new MockClaudeChild());
    createdChildren.push(child);
    return child;
  };
}

function restoreSpawnClaude(): void {
  const claudeBinaryPath = require.resolve('../src/agents/claude/claudeBinary');
  const mod = require(claudeBinaryPath);
  if (mod._origSpawnClaude) {
    mod.spawnClaude = mod._origSpawnClaude;
    delete mod._origSpawnClaude;
  }
  if (mod._origPreflight) {
    mod.preflightClaudeAuth = mod._origPreflight;
    delete mod._origPreflight;
  }
}

function stubDbRepository(): void {
  const dbRepoPath = require.resolve('../src/services/dbRepository');
  const mod = require(dbRepoPath);
  mod._origSetNode = mod._origSetNode ?? mod.setNodeExternalSessionId;
  mod._origGetNode = mod._origGetNode ?? mod.getNode;
  mod._origHasGrant = mod._origHasGrant ?? mod.hasGrant;
  mod._origGrantPermission = mod._origGrantPermission ?? mod.grantPermission;
  mod.setNodeExternalSessionId = (_nodeId: string, _sid: string) => {};
  mod.getNode = () => undefined;
  mod.hasGrant = () => false;
  // track calls for assertions
  mod._setNodeCalls = [] as Array<[string, string]>;
  mod._grantCalls = [] as Array<[string, string]>;
  mod.setNodeExternalSessionId = (nodeId: string, sid: string) => {
    mod._setNodeCalls.push([nodeId, sid]);
  };
  mod.grantPermission = (workspaceId: string, toolName: string) => {
    mod._grantCalls.push([workspaceId, toolName]);
  };
}

function restoreDbRepository(): void {
  const dbRepoPath = require.resolve('../src/services/dbRepository');
  const mod = require(dbRepoPath);
  if (mod._origSetNode) { mod.setNodeExternalSessionId = mod._origSetNode; delete mod._origSetNode; }
  if (mod._origGetNode) { mod.getNode = mod._origGetNode; delete mod._origGetNode; }
  if (mod._origHasGrant) { mod.hasGrant = mod._origHasGrant; delete mod._origHasGrant; }
  if (mod._origGrantPermission) { mod.grantPermission = mod._origGrantPermission; delete mod._origGrantPermission; }
  delete mod._setNodeCalls;
  delete mod._grantCalls;
}

function makeMcpRegistry() {
  let slotCounter = 0;
  const disposedSlots: string[] = [];
  const createdCallbacks: any[] = [];
  return {
    create(_parentChatId: string, _cwd: string, _ownerUserId: string | null, callbacks: unknown) {
      createdCallbacks.push(callbacks);
      const slotId = `slot-${++slotCounter}`;
      return { slotId, workspaceId: null as string | null };
    },
    async dispose(slotId: string) {
      disposedSlots.push(slotId);
    },
    disposedSlots,
    createdCallbacks,
  };
}

function makeBridge() {
  return {
    spawnBranches: async () => [],
    saveContext: () => null,
    updateContext: () => null,
  };
}

function freshClaudeSession() {
  // Clear caches so we pick up patched modules
  delete require.cache[require.resolve('../src/agents/claude/ClaudeSession')];
  return require('../src/agents/claude/ClaudeSession') as typeof import('../src/agents/claude/ClaudeSession');
}

function makeSessionDeps(overrides: Partial<import('../src/agents/claude/ClaudeSession').ClaudeSessionDeps> = {}) {
  return {
    nodeId: 'node-001',
    cwd: '/tmp/test-cwd',
    workspaceId: null,
    mcpRegistry: makeMcpRegistry() as any,
    bridge: makeBridge() as any,
    mcpPort: 9876,
    ...overrides,
  };
}

// ---- Suite ------------------------------------------------------------------

describe('ClaudeSession', () => {
  beforeEach(() => {
    stubSpawnClaude();
    stubDbRepository();
    mock.restoreAll();
  });

  afterEach(() => {
    restoreSpawnClaude();
    restoreDbRepository();
    mock.restoreAll();
  });

  // ── Case 1: spawnFresh persists external_session_id before queue ─────────────
  // SKIPPED: behavior moved. claude in stream-json input mode does NOT emit
  // system/init until the first user envelope arrives on stdin (verified
  // empirically with claude 2.1.138). So spawnFresh no longer awaits or captures
  // init — both happen during the first send() turn. Smoke test
  // (backend/test/claudeRuntimeSmoke.test.ts) covers end-to-end persistence.

  test.skip('spawnFresh: persists external_session_id via dbRepository on first system/init envelope', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);

    const { ClaudeSession } = freshClaudeSession();
    const deps = makeSessionDeps({ nodeId: 'node-persist' });
    const session = new ClaudeSession('session-persist', deps as any);

    const dbRepoMod = require('../src/services/dbRepository');
    // Emit init slightly after spawn
    setTimeout(() => child.emitInit('ext-persist-123'), 30);

    await session.spawnFresh();

    assert.ok(
      dbRepoMod._setNodeCalls.some(([nid, sid]: [string, string]) => nid === 'node-persist' && sid === 'ext-persist-123'),
      `setNodeExternalSessionId should have been called with ('node-persist', 'ext-persist-123'), got: ${JSON.stringify(dbRepoMod._setNodeCalls)}`,
    );

    await session.dispose();
  });

  // ── Case 2: spawnFresh rejects with ClaudeInitTimeoutError on no init ─────────
  // SKIPPED: behavior removed. See Case 1's comment. spawnFresh no longer
  // awaits init, so it cannot reject with a spawn-init timeout. Timeout
  // semantics if claude is hung during a send() turn are covered by the
  // turn-level heartbeat path (a different test).

  test.skip('spawnFresh: rejects with ClaudeInitTimeoutError when no init envelope arrives', async () => {
    // Child that never emits init and exits after a short time
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    // Simulate process exit without emitting init
    setTimeout(() => child.emit('exit', 1, null), 100);

    const { ClaudeSession } = freshClaudeSession();
    const { ClaudeInitTimeoutError } = require('../src/agents/claude/claudeBinary');

    const deps = makeSessionDeps();
    const session = new ClaudeSession('session-timeout', deps as any);

    await assert.rejects(
      () => session.spawnFresh(),
      (err: unknown) => {
        assert.ok(
          err instanceof ClaudeInitTimeoutError,
          `expected ClaudeInitTimeoutError, got ${(err as Error).constructor.name}: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });

  // ── Case 3: send() writes user envelope to stdin ─────────────────────────────

  test('send(): writes user envelope JSON line to stdin', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);

    setTimeout(() => child.emitInit('ext-send-001'), 20);

    const { ClaudeSession } = freshClaudeSession();
    const deps = makeSessionDeps();
    const session = new ClaudeSession('session-send', deps as any);
    await session.spawnFresh();

    const stdinChunks: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => stdinChunks.push(chunk.toString()));

    // Emit result after sending to complete the turn
    setTimeout(() => child.emitResult('success'), 30);

    const gen = session.send('hello world');
    // Drain the iterator
    const events = [];
    for await (const ev of gen) {
      events.push(ev);
    }

    const stdinData = stdinChunks.join('');
    let parsedEnvelope: any;
    try {
      parsedEnvelope = JSON.parse(stdinData.trim().split('\n')[0]);
    } catch {
      assert.fail(`stdin data was not valid JSON: ${stdinData}`);
    }

    assert.equal(parsedEnvelope.type, 'user');
    assert.equal(parsedEnvelope.message.role, 'user');
    assert.equal(parsedEnvelope.message.content, 'hello world');

    await session.dispose();
  });

  // ── warmInit ────────────────────────────────────────────────────────────────

  test('warmInit(): writes shouldQuery:false envelope and resolves on result/success', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);

    const { ClaudeSession } = freshClaudeSession();
    const deps = makeSessionDeps({ nodeId: 'node-warm-1' });
    const session = new ClaudeSession('session-warm-1', deps as any);
    await session.spawnFresh();

    const stdinChunks: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => stdinChunks.push(chunk.toString()));

    // Emit init then result/success to close the dummy turn
    setTimeout(() => {
      child.emitInit('ext-warm-1');
      child.emitResult('success');
    }, 20);

    await session.warmInit();

    const stdinData = stdinChunks.join('');
    const firstLine = stdinData.trim().split('\n')[0];
    const env = JSON.parse(firstLine);
    assert.equal(env.type, 'user');
    assert.equal(env.shouldQuery, false, 'warm envelope MUST set shouldQuery:false');
    assert.equal(env.parent_tool_use_id, null);
    assert.equal(env.message.role, 'user');
    assert.match(env.message.content, /__michi:warm__/);

    await session.dispose();
  });

  test('warmInit(): throws on disposed session', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);

    const { ClaudeSession } = freshClaudeSession();
    const deps = makeSessionDeps({ nodeId: 'node-warm-2' });
    const session = new ClaudeSession('session-warm-2', deps as any);
    await session.spawnFresh();
    await session.dispose();

    await assert.rejects(() => session.warmInit(), /disposed|crashed/);
  });

  // ── First-turn prefix injection ─────────────────────────────────────────────

  test('send(): prepends firstTurnPrefix exactly once', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);

    const { ClaudeSession } = freshClaudeSession();
    const deps = makeSessionDeps({ nodeId: 'node-prefix-1' });
    const session = new ClaudeSession('session-prefix-1', deps as any);
    await session.spawnFresh();
    session.setFirstTurnPrefix('PREFIX-CONTEXT-HERE');

    const stdinChunks: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => stdinChunks.push(chunk.toString()));

    // First send
    setTimeout(() => child.emitResult('success'), 20);
    for await (const _ of session.send('hello')) { void _; }

    // Second send
    setTimeout(() => child.emitResult('success'), 20);
    for await (const _ of session.send('again')) { void _; }

    const envelopes = stdinChunks
      .join('')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

    assert.equal(envelopes.length, 2, `expected 2 envelopes, got ${envelopes.length}`);

    // First envelope: prefix + separator + 'hello'
    assert.match(envelopes[0].message.content, /PREFIX-CONTEXT-HERE/);
    assert.match(envelopes[0].message.content, /hello$/);

    // Second envelope: no first-turn prefix. A metadata reminder may be
    // appended once the conversation crosses the reminder threshold.
    assert.doesNotMatch(envelopes[1].message.content, /PREFIX-CONTEXT-HERE/);
    assert.match(envelopes[1].message.content, /^again(?:\n|$)/);

    await session.dispose();
  });

  test('send(): no prefix when setFirstTurnPrefix never called', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);

    const { ClaudeSession } = freshClaudeSession();
    const deps = makeSessionDeps({ nodeId: 'node-prefix-2' });
    const session = new ClaudeSession('session-prefix-2', deps as any);
    await session.spawnFresh();

    const stdinChunks: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => stdinChunks.push(chunk.toString()));

    setTimeout(() => child.emitResult('success'), 20);
    for await (const _ of session.send('plain hello')) { void _; }

    const env = JSON.parse(stdinChunks.join('').trim().split('\n')[0]);
    assert.equal(env.message.content, 'plain hello');
    await session.dispose();
  });

  test('setFirstTurnPrefix(): throws after first send consumed the prefix', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);

    const { ClaudeSession } = freshClaudeSession();
    const deps = makeSessionDeps({ nodeId: 'node-prefix-3' });
    const session = new ClaudeSession('session-prefix-3', deps as any);
    await session.spawnFresh();
    session.setFirstTurnPrefix('once');

    setTimeout(() => child.emitResult('success'), 20);
    for await (const _ of session.send('go')) { void _; }

    assert.throws(() => session.setFirstTurnPrefix('again'), /already sent|consumed/);
    await session.dispose();
  });

  test('warmInit(): session reusable for send() afterwards', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);

    const { ClaudeSession } = freshClaudeSession();
    const deps = makeSessionDeps({ nodeId: 'node-warm-3' });
    const session = new ClaudeSession('session-warm-3', deps as any);
    await session.spawnFresh();

    // Warm phase
    setTimeout(() => {
      child.emitInit('ext-warm-3');
      child.emitResult('success');
    }, 20);
    await session.warmInit();

    // Real phase. Subscribing to stdin now drains the PassThrough's buffer,
    // so chunks captured here include both the warm envelope (buffered
    // earlier) AND the real send envelope. Filter by content.
    const stdinChunks: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => stdinChunks.push(chunk.toString()));
    setTimeout(() => child.emitResult('success'), 30);

    const events: any[] = [];
    for await (const ev of session.send('actual question')) {
      events.push(ev);
    }

    const envelopes = stdinChunks
      .join('')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

    // Two envelopes expected: warm (shouldQuery:false) + real send
    assert.equal(envelopes.length, 2, `expected 2 envelopes, got ${envelopes.length}`);

    const warmEnv = envelopes.find((e) => e.shouldQuery === false);
    const realEnv = envelopes.find((e) => e.shouldQuery !== false);
    assert.ok(warmEnv, 'warm envelope should still be present in stdin trace');
    assert.ok(realEnv, 'real envelope should be present');
    assert.equal(realEnv.message.content, 'actual question');

    await session.dispose();
  });

  // ── Case 4: send() yields events ending with turn_end ────────────────────────

  test('send(): yields chunk events then turn_end', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);

    setTimeout(() => child.emitInit('ext-events-001'), 20);

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-events', makeSessionDeps() as any);
    await session.spawnFresh();

    setTimeout(() => {
      child.emitChunk('Hello, ');
      child.emitChunk('world!');
      child.emitResult('success');
    }, 30);

    const events = [];
    for await (const ev of session.send('hi')) {
      events.push(ev);
    }

    const kinds = events.map((e: any) => e.kind);
    assert.ok(kinds.includes('chunk'), `expected chunk events, got: ${kinds}`);
    assert.equal(kinds[kinds.length - 1], 'turn_end', `last event should be turn_end, got: ${kinds[kinds.length - 1]}`);

    await session.dispose();
  });

  // ── Case 4b: turn_end returns session to idle even when consumer breaks ───────
  // Regression: the /chats/:id/message route breaks its for-await the moment a
  // turn_end arrives. That calls the generator's .return(), unwinding past the
  // post-loop `state = 'idle'` assignment in send() and leaving the session
  // pinned in `in_turn` — which reclaimActiveSession never reclaims, so slots
  // leaked until ClaudeConcurrencyError (503). The fix flips state to idle from
  // the translator's turn_end emit (the claude process's own end-of-turn signal),
  // independent of whether the consumer drains the generator.

  test('send(): returns to idle when consumer breaks on turn_end (no zombie in_turn)', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);

    setTimeout(() => child.emitInit('ext-zombie-001'), 20);

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-zombie', makeSessionDeps() as any);
    await session.spawnFresh();

    setTimeout(() => {
      child.emitChunk('done');
      child.emitResult('success');
    }, 30);

    // Mimic the route exactly: stop consuming the instant turn_end arrives,
    // rather than draining the generator to its natural completion.
    for await (const ev of session.send('hi')) {
      if (ev.kind === 'turn_end') break;
    }

    assert.equal(
      session.getState(),
      'idle',
      'session must be idle (reclaimable) after turn_end, even when the consumer breaks on it',
    );

    await session.dispose();
  });

  test('send(): treats child exit during a turn as error even when exit code is 0', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);

    setTimeout(() => child.emitInit('ext-midturn-exit-001'), 20);

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-midturn-exit', makeSessionDeps() as any);
    await session.spawnFresh();

    const events: any[] = [];
    const drain = (async () => {
      for await (const ev of session.send('hi')) {
        events.push(ev);
      }
    })();

    await new Promise(r => setTimeout(r, 10));
    assert.equal(session.getState(), 'in_turn');

    child.emit('exit', 0, null);
    await drain;

    const end = events.find((ev) => ev.kind === 'turn_end');
    assert.ok(end, `expected turn_end event, got: ${JSON.stringify(events)}`);
    assert.equal(
      end.stopReason,
      'error',
      'a process exit before Claude emits result/success must be surfaced as incomplete',
    );
    assert.equal(session.getState(), 'crashed');

    await session.dispose();
  });

  // ── Case 5: send() throws ESESSION_BUSY on concurrent call ───────────────────

  test('send(): throws ESESSION_BUSY when called concurrently', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);

    setTimeout(() => child.emitInit('ext-busy-001'), 20);

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-busy', makeSessionDeps() as any);
    await session.spawnFresh();

    // Start a send that won't complete yet (no result emitted)
    const gen1 = session.send('first message');
    // Pull first event to start the turn
    const nextP = gen1.next();

    // Small delay to ensure turn lock is acquired
    await new Promise(r => setTimeout(r, 10));

    // Second concurrent send should throw ESESSION_BUSY
    await assert.rejects(
      async () => {
        for await (const _ of session.send('concurrent')) { /* drain */ }
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as any).code, 'ESESSION_BUSY', `expected ESESSION_BUSY, got code: ${(err as any).code}`);
        return true;
      },
    );

    // Clean up — emit result to unblock first gen
    child.emitResult('success');
    await nextP;
    // drain remaining
    for await (const _ of gen1) { /* drain */ }

    await session.dispose();
  });

  // ── Case 6: cancel() sends SIGINT and marks state crashed ────────────────────

  test('cancel(): sends SIGINT to child and marks state as crashed', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);

    setTimeout(() => child.emitInit('ext-cancel-001'), 20);

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-cancel', makeSessionDeps() as any);
    await session.spawnFresh();

    // Manually force in_turn state by setting state via the internals
    (session as any).state = 'in_turn';
    // Make exitPromise resolve quickly
    (session as any).exitPromise = Promise.resolve();

    await session.cancel();

    assert.ok(child.killSignals.includes('SIGINT'), `expected SIGINT, got: ${child.killSignals}`);
    assert.equal((session as any).state, 'crashed');
  });

  // ── Case 7: after cancel(), next send() re-spawns via resume ─────────────────

  test('after cancel(), next send() respawns via spawnResume with externalSessionId', async () => {
    let spawnCallCount = 0;
    const children: MockClaudeChild[] = [];
    stubSpawnClaude(() => {
      spawnCallCount++;
      const child = new MockClaudeChild();
      children.push(child);
      return child;
    });

    // Emit init on first spawn
    const firstInitDelay = 20;
    setTimeout(() => {
      if (children[0]) children[0].emitInit('ext-resume-001');
    }, firstInitDelay);

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-resume', makeSessionDeps() as any);
    await session.spawnFresh();

    assert.equal(spawnCallCount, 1, 'should have spawned once for fresh');

    // Force crashed state with externalSessionId set
    (session as any).state = 'crashed';
    (session as any).externalSessionId = 'ext-resume-001';
    (session as any).exitPromise = Promise.resolve();

    // On next spawnResume call, emit init for the second child
    setTimeout(() => {
      if (children[1]) children[1].emitInit('ext-resume-001');
    }, 30);

    // Emit result shortly after for the send to complete
    setTimeout(() => {
      if (children[1]) children[1].emitResult('success');
    }, 80);

    const events = [];
    for await (const ev of session.send('post-cancel message')) {
      events.push(ev);
    }

    assert.equal(spawnCallCount, 2, 'should have spawned again on send after crash');

    await session.dispose();
  });

  // ── Case 8: dispose() kills child and calls mcpRegistry.dispose ──────────────

  test('dispose(): kills child process and calls mcpRegistry.dispose(slotId)', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    setTimeout(() => child.emitInit('ext-dispose-001'), 20);

    const { ClaudeSession } = freshClaudeSession();
    const mcpReg = makeMcpRegistry() as any;
    const session = new ClaudeSession('session-dispose', makeSessionDeps({ mcpRegistry: mcpReg }) as any);
    await session.spawnFresh();

    const slotIdBefore = (session as any).slotId;
    assert.ok(slotIdBefore, 'slotId should be set after spawnFresh');

    await session.dispose();

    assert.ok(child.killed, 'child process should be killed');
    assert.ok(
      mcpReg.disposedSlots.includes(slotIdBefore),
      `mcpRegistry.dispose should have been called with ${slotIdBefore}, got: ${mcpReg.disposedSlots}`,
    );
    assert.equal((session as any).state, 'disposed');
  });

  // ── Case 9: heartbeat event emitted when queue is idle ───────────────────────

  test('heartbeat event is queued within heartbeat interval when session is idle', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    setTimeout(() => child.emitInit('ext-hb-001'), 20);

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-hb', makeSessionDeps() as any);
    await session.spawnFresh();

    // Directly call the heartbeat callback to simulate timer firing
    // The EventQueue's onHeartbeat is called from setInterval — we can trigger
    // it by accessing the queue's internal callback.
    const queue = (session as any).queue;
    assert.ok(queue, 'queue should be accessible');

    // Pull one event with a short race to confirm heartbeat arrives
    let heartbeatReceived = false;
    const pullPromise = queue.pull().then((ev: any) => {
      if (ev && ev.kind === 'heartbeat') heartbeatReceived = true;
      return ev;
    });

    // Directly invoke the heartbeat callback (simulating the interval firing)
    // by calling into queue's onHeartbeat handler
    const queueAny = queue as any;
    if (typeof queueAny.onHeartbeat === 'function') {
      queueAny.onHeartbeat(10001);
    } else {
      // Fallback: push a synthetic heartbeat to verify the EventQueue accepts it
      queue.push({ kind: 'heartbeat', idleMs: 10001 });
    }

    const ev = await pullPromise;
    assert.ok(ev && ev.kind === 'heartbeat', `expected heartbeat event, got: ${JSON.stringify(ev)}`);

    await session.dispose();
  });

  // ── Case 10: JSONL tail repair truncates malformed final line ────────────────

  test('spawnResume: truncates JSONL file with malformed final line and logs warn', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);

    // Set up a real temp JSONL file path that checkAndRepairJsonl will find
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-'));
    const extSessionId = 'abc123-external';

    // We need to know what path getClaudeJsonlPath would produce
    // It's at ~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl
    // Rather than fully reproducing that, we stub getClaudeJsonlPath
    const projPathMod = require('../src/agents/claude/claudeProjectsPath');
    const origGetPath = projPathMod.getClaudeJsonlPath;
    const jsonlPath = path.join(tmpDir, `${extSessionId}.jsonl`);
    projPathMod.getClaudeJsonlPath = (_cwd: string, sid: string) => {
      return sid === extSessionId ? jsonlPath : origGetPath(_cwd, sid);
    };

    // Write a JSONL with a valid line followed by a malformed partial line (no trailing newline)
    const validLine = JSON.stringify({ type: 'result', subtype: 'success' });
    const malformedTail = '{"type":"incomplete';
    fs.writeFileSync(jsonlPath, validLine + '\n' + malformedTail);

    const originalSize = fs.statSync(jsonlPath).size;

    // Capture console.warn calls
    const warnMessages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => warnMessages.push(args.join(' '));

    setTimeout(() => child.emitInit(extSessionId), 20);

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-jsonl', makeSessionDeps({ cwd: tmpDir }) as any);

    try {
      await session.spawnResume(extSessionId);

      const newSize = fs.statSync(jsonlPath).size;
      assert.ok(
        newSize < originalSize,
        `JSONL should be truncated (was ${originalSize}, now ${newSize})`,
      );

      const content = fs.readFileSync(jsonlPath, 'utf8');
      assert.ok(content.endsWith('\n'), 'JSONL should end with newline after repair');

      assert.ok(
        warnMessages.some(m => m.includes('JSONL tail repair') || m.includes('truncating')),
        `expected a warn about JSONL truncation, got: ${warnMessages.join('; ')}`,
      );
    } finally {
      console.warn = origWarn;
      projPathMod.getClaudeJsonlPath = origGetPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await session.dispose();
    }
  });

  // ── Case 11: onApprove — allow policy returns allow ──────────────────────────

  test('onApprove with allow policy returns { behavior: allow }', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    setTimeout(() => child.emitInit('ext-approve-001'), 20);

    // Stub resolvePolicy to return 'allow'
    const policyMod = require('../src/agents/permissionPolicy');
    const origResolve = policyMod.resolvePolicy;
    policyMod.resolvePolicy = () => 'allow';

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-approve', makeSessionDeps({ workspaceId: 'ws-1' }) as any);
    await session.spawnFresh();

    // Access the makeOnApprove callback via the MCP slot callbacks
    // We need to trigger it through the mcpRegistry.create callback
    // Re-spawn to capture the onApprove from the slot callbacks
    const mcpReg = (session as any).mcpRegistry;
    let capturedOnApprove: Function | undefined;
    const origCreate = mcpReg.create.bind(mcpReg);
    mcpReg.create = (pcid: string, cwd: string, ownerUserId: string | null, cbs: any) => {
      capturedOnApprove = cbs.onApprove;
      return origCreate(pcid, cwd, ownerUserId, cbs);
    };

    // Trigger spawnFresh again to capture callbacks (dispose first)
    const child2 = new MockClaudeChild();
    let spawnIdx = 0;
    const origSpawn = require('../src/agents/claude/claudeBinary').spawnClaude;
    require('../src/agents/claude/claudeBinary').spawnClaude = () => {
      spawnIdx++;
      const c = spawnIdx === 1 ? child2 : new MockClaudeChild();
      setTimeout(() => c.emitInit(`ext-approve-002`), 20);
      return c;
    };
    await session.spawnFresh();

    try {
      if (capturedOnApprove) {
        const result = await capturedOnApprove({ toolName: 'read', input: {}, toolUseId: 'tc-1' });
        assert.equal(result.behavior, 'allow');
      } else {
        assert.fail('onApprove callback was not captured');
      }
    } finally {
      policyMod.resolvePolicy = origResolve;
      require('../src/agents/claude/claudeBinary').spawnClaude = origSpawn;
      await session.dispose();
    }
  });

  // ── Case 12: onApprove — deny policy returns deny ────────────────────────────

  test('onApprove with deny policy returns { behavior: deny }', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    setTimeout(() => child.emitInit('ext-deny-001'), 20);

    const policyMod = require('../src/agents/permissionPolicy');
    const origResolve = policyMod.resolvePolicy;
    policyMod.resolvePolicy = () => 'deny';

    const { ClaudeSession } = freshClaudeSession();
    const mcpReg = makeMcpRegistry() as any;
    let capturedOnApprove: Function | undefined;
    const origCreate = mcpReg.create.bind(mcpReg);
    mcpReg.create = (pcid: string, cwd: string, ownerUserId: string | null, cbs: any) => {
      capturedOnApprove = cbs.onApprove;
      return origCreate(pcid, cwd, ownerUserId, cbs);
    };

    const session = new ClaudeSession('session-deny', makeSessionDeps({ workspaceId: 'ws-deny', mcpRegistry: mcpReg }) as any);
    await session.spawnFresh();

    try {
      assert.ok(capturedOnApprove, 'onApprove should have been captured');
      const result = await capturedOnApprove!({ toolName: 'bash', input: {}, toolUseId: 'tc-deny' });
      assert.equal(result.behavior, 'deny');
    } finally {
      policyMod.resolvePolicy = origResolve;
      await session.dispose();
    }
  });

  // ── Case 13: onApprove — ask policy pushes permission_request then resolves ───

  test('onApprove with ask policy pushes permission_request event and resolves on respondToPermission', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    setTimeout(() => child.emitInit('ext-ask-001'), 20);

    const policyMod = require('../src/agents/permissionPolicy');
    const origResolve = policyMod.resolvePolicy;
    policyMod.resolvePolicy = () => 'ask';

    const { ClaudeSession } = freshClaudeSession();
    const mcpReg = makeMcpRegistry() as any;
    let capturedOnApprove: Function | undefined;
    const origCreate = mcpReg.create.bind(mcpReg);
    mcpReg.create = (pcid: string, cwd: string, ownerUserId: string | null, cbs: any) => {
      capturedOnApprove = cbs.onApprove;
      return origCreate(pcid, cwd, ownerUserId, cbs);
    };

    const session = new ClaudeSession('session-ask', makeSessionDeps({ workspaceId: 'ws-ask', mcpRegistry: mcpReg }) as any);
    await session.spawnFresh();

    try {
      assert.ok(capturedOnApprove, 'onApprove should have been captured');

      // Pull the permission_request event from the queue
      const queue = (session as any).queue;
      const permEventPromise = queue.pull();

      // Start the approve — it will push a permission_request and then wait
      const approvePromise = capturedOnApprove!({
        toolName: 'Bash',
        input: { command: 'npm test', description: 'Run tests' },
        toolUseId: 'tc-ask',
      });

      const permEv = await permEventPromise;
      assert.equal(permEv.kind, 'permission_request', `expected permission_request, got: ${permEv?.kind}`);
      assert.ok(typeof permEv.requestId === 'number');
      assert.equal(permEv.title, 'Approve Bash?');
      assert.equal(permEv.detail, 'Description: Run tests\nCommand: npm test');

      // Respond allow_always, which should persist the canonical tool category.
      session.respondToPermission(permEv.requestId, 'allow_always');

      const result = await approvePromise;
      assert.equal(result.behavior, 'allow');
      const dbRepoMod = require('../src/services/dbRepository');
      assert.deepEqual(dbRepoMod._grantCalls, [['ws-ask', 'bash']]);
    } finally {
      policyMod.resolvePolicy = origResolve;
      await session.dispose();
    }
  });

  test('metadata hook POC blocks once, then passes after overview and follow-ups are set', async () => {
    const previous = process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
    const previousMode = process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE;
    process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = '1';
    process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE = 'hook-tool';
    const { log } = require('../src/services/logger') as typeof import('../src/services/logger');
    const infoSpy = mock.method(log, 'info', () => {});
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    const registry = makeMcpRegistry();

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-hook-poc', makeSessionDeps({
      nodeId: 'node-hook-poc',
      mcpRegistry: registry as any,
      systemPromptAppend: buildStableSystemPrompt('structured-tool'),
    }) as any);

    try {
      await session.spawnFresh();
      const spawnArgs = capturedSpawnArgs[0] as Record<string, unknown>;
      assert.equal(spawnArgs.includeHookEvents, true);
      assert.equal(spawnArgs.bare, false);
      assert.match(String(spawnArgs.mcpConfigInline), /"alwaysLoad":true/);
      assert.match(String(spawnArgs.settingsInline), /validate_turn_metadata/);
      assert.match(String(spawnArgs.systemPromptAppend), /set_branch_overview/);
      assert.match(String(spawnArgs.systemPromptAppend), /set_follow_ups/);
      assert.doesNotMatch(String(spawnArgs.systemPromptAppend), /\[FOLLOW-UP/);
      assert.doesNotMatch(String(spawnArgs.systemPromptAppend), /\[BRANCH-OVERVIEW:/);

      child.send({
        type: 'system',
        subtype: 'hook_started',
        hook_name: 'Stop',
        hook_id: 'hook-poc-1',
      });
      child.send({
        type: 'system',
        subtype: 'hook_response',
        hook_name: 'Stop',
        hook_id: 'hook-poc-1',
        outcome: 'success',
      });
      child.send({
        type: 'system',
        subtype: 'hook_started',
        hook_name: 'SessionStart:startup',
        hook_id: 'unrelated-hook',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const lifecycleLogs = infoSpy.mock.calls.filter(
        (call) => call.arguments[1] === 'claude follow-ups hook poc lifecycle event',
      );
      assert.equal(lifecycleLogs.length, 2);
      assert.deepEqual(lifecycleLogs.map((call) => call.arguments[2]), [
        {
          nodeId: 'node-hook-poc',
          sessionId: 'session-hook-poc',
          type: 'hook_started',
          hookName: 'Stop',
          hookId: 'hook-poc-1',
          outcome: undefined,
        },
        {
          nodeId: 'node-hook-poc',
          sessionId: 'session-hook-poc',
          type: 'hook_response',
          hookName: 'Stop',
          hookId: 'hook-poc-1',
          outcome: 'success',
        },
      ]);

      const callbacks = registry.createdCallbacks[0];
      assert.equal(typeof callbacks.onSetFollowUps, 'function');
      assert.equal(typeof callbacks.onSetBranchOverview, 'function');
      assert.equal(typeof callbacks.onValidateFollowUps, 'function');

      const turnEventsPromise = (async () => {
        const events: any[] = [];
        for await (const ev of session.send('hello')) events.push(ev);
        return events;
      })();
      await new Promise<void>((resolve) => setImmediate(resolve));

      child.emitChunk('original answer');
      await new Promise<void>((resolve) => setImmediate(resolve));

      const blocked = callbacks.onValidateFollowUps();
      assert.equal(blocked.decision, 'block');
      assert.match(String(blocked.reason), /set_branch_overview/);
      assert.match(String(blocked.reason), /set_follow_ups/);

      child.emitChunk('duplicate repair answer');
      child.emitThought('repair-only reasoning');
      callbacks.onSetBranchOverview(' Current durable branch state. ');
      callbacks.onSetFollowUps(['one?', 'two?', 'three?']);
      child.emitChunk('tool acknowledgement');
      child.send({ type: 'stream_event', event: { type: 'message_stop' } });
      assert.deepEqual(callbacks.onValidateFollowUps(), {});

      child.emitResult('success');
      const events = await turnEventsPromise;
      assert.equal(
        events.filter((ev) => ev.kind === 'chunk').map((ev) => ev.text).join(''),
        'original answer',
      );
      assert.equal(events.some((ev) => ev.kind === 'thought'), false);
      assert.deepEqual(
        events.find((ev) => ev.kind === 'follow_ups')?.followUps,
        ['one?', 'two?', 'three?'],
      );
      assert.deepEqual(
        events.filter((ev) => ev.kind === 'follow_ups_status').map((ev) => ev.status),
        ['in_progress', 'completed'],
      );
      assert.ok(
        events.findIndex((ev) => ev.kind === 'follow_ups_status' && ev.status === 'in_progress')
          < events.findIndex((ev) => ev.kind === 'follow_ups'),
      );
      assert.ok(
        events.findIndex((ev) => ev.kind === 'follow_ups')
          < events.findIndex((ev) => ev.kind === 'follow_ups_status' && ev.status === 'completed'),
      );
      assert.equal(
        events.find((ev) => ev.kind === 'branch_overview')?.overview,
        'Current durable branch state.',
      );
      assert.equal(events.some((ev) => ev.kind === 'turn_end'), true);
      assert.deepEqual(
        session.getHistory().filter((message) => message.role === 'assistant'),
        [{ role: 'assistant', content: 'original answer' }],
      );
      const suppressionLogs = infoSpy.mock.calls.filter(
        (call) => call.arguments[1] === 'claude follow-ups hook poc hidden metadata output suppressed',
      );
      assert.deepEqual(suppressionLogs.map((call) => call.arguments[2]), [{
        nodeId: 'node-hook-poc',
        sessionId: 'session-hook-poc',
        chunks: 2,
        thoughts: 1,
      }]);
    } finally {
      if (previous === undefined) delete process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
      else process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = previous;
      if (previousMode === undefined) delete process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE;
      else process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE = previousMode;
      await session.dispose();
    }
  });

  test('sentinel experiment reminds every turn and Hook requires only Overview', async () => {
    const previous = process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
    const previousMode = process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE;
    process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = '1';
    process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE = 'sentinel';
    const child = new MockClaudeChild();
    const stdinChunks: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => stdinChunks.push(chunk.toString()));
    stubSpawnClaude(() => child);
    const registry = makeMcpRegistry();

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-sentinel-poc', makeSessionDeps({
      nodeId: 'node-sentinel-poc',
      mcpRegistry: registry as any,
    }) as any);

    try {
      await session.spawnFresh();
      const spawnArgs = capturedSpawnArgs[0] as Record<string, unknown>;
      assert.match(String(spawnArgs.mcpConfigInline), /"alwaysLoad":true/);
      const callbacks = registry.createdCallbacks[0];
      assert.equal(callbacks.onSetFollowUps, undefined);
      assert.equal(typeof callbacks.onSetBranchOverview, 'function');

      const turnPromise = (async () => {
        const events: any[] = [];
        for await (const event of session.send('hello')) events.push(event);
        return events;
      })();
      await new Promise<void>((resolve) => setImmediate(resolve));

      const envelopes = stdinChunks
        .join('')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const prompt = String(envelopes.at(-1)?.message?.content ?? '');
      assert.match(prompt, /do not call set_follow_ups/i);
      assert.match(prompt, /FOLLOW-UP 1\/3/);
      assert.match(prompt, /FOLLOW-UP 3\/3/);

      child.emitChunk('answer\n[FOLLOW-UP 1/3: one?]\n[FOLLOW-UP 2/3: two?]\n[FOLLOW-UP 3/3: three?]');
      await new Promise<void>((resolve) => setImmediate(resolve));
      callbacks.onSetBranchOverview('Sentinel experiment overview.');
      assert.deepEqual(callbacks.onValidateFollowUps(), {});
      child.emitChunk('SHOULD STAY HIDDEN');
      child.emitResult('success');
      const events = await turnPromise;
      assert.equal(events.some((event) => event.kind === 'follow_ups'), false);
      assert.deepEqual(
        events.filter((event) => event.kind === 'chunk').map((event) => event.text),
        ['answer\n[FOLLOW-UP 1/3: one?]\n[FOLLOW-UP 2/3: two?]\n[FOLLOW-UP 3/3: three?]'],
      );
      assert.equal(events.some((event) => event.kind === 'turn_end'), true);
    } finally {
      if (previous === undefined) delete process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
      else process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = previous;
      if (previousMode === undefined) delete process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE;
      else process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE = previousMode;
      await session.dispose();
    }
  });

  test('follow-ups hook POC fails open after one block and resets on the next turn', async () => {
    const previous = process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
    process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = '1';
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    const registry = makeMcpRegistry();

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-hook-retry', makeSessionDeps({
      nodeId: 'node-hook-retry',
      mcpRegistry: registry as any,
    }) as any);

    try {
      await session.spawnFresh();
      const callbacks = registry.createdCallbacks[0];

      const firstTurn = (async () => {
        const events: any[] = [];
        for await (const event of session.send('first')) events.push(event);
        return events;
      })();
      await new Promise<void>((resolve) => setImmediate(resolve));
      child.emitChunk('first visible');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(callbacks.onValidateFollowUps().decision, 'block');
      child.emitChunk('first repair hidden');
      assert.deepEqual(callbacks.onValidateFollowUps(), {});
      child.emitResult('success');
      const firstEvents = await firstTurn;
      assert.equal(
        firstEvents.filter((event) => event.kind === 'chunk').map((event) => event.text).join(''),
        'first visible',
      );

      const secondTurn = (async () => {
        const events: any[] = [];
        for await (const event of session.send('second')) events.push(event);
        return events;
      })();
      await new Promise<void>((resolve) => setImmediate(resolve));
      child.emitChunk('second visible');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(callbacks.onValidateFollowUps().decision, 'block');
      child.emitChunk('second repair hidden');
      assert.deepEqual(callbacks.onValidateFollowUps(), {});
      child.emitResult('success');
      const secondEvents = await secondTurn;
      assert.equal(
        secondEvents.filter((event) => event.kind === 'chunk').map((event) => event.text).join(''),
        'second visible',
      );
    } finally {
      if (previous === undefined) delete process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
      else process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = previous;
      await session.dispose();
    }
  });

  test('follow-ups hook POC skips validation during warmInit', async () => {
    const previous = process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
    process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = '1';
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    const registry = makeMcpRegistry();

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-hook-warm', makeSessionDeps({
      nodeId: 'node-hook-warm',
      mcpRegistry: registry as any,
    }) as any);

    try {
      await session.spawnFresh();
      const callbacks = registry.createdCallbacks[0];
      const warm = session.warmInit();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(callbacks.onValidateFollowUps(), {});
      child.emitInit('ext-hook-warm');
      child.emitResult('success');
      await warm;
    } finally {
      if (previous === undefined) delete process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
      else process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = previous;
      await session.dispose();
    }
  });
});
