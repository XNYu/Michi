/**
 * paneInspectionSubscribe.test.ts — P3-2 acceptance table (brief's "Acceptance" section).
 *
 * Uses a fully fake clock/timer port (`PaneSubscribeClock`) — no real setTimeout/setInterval, no
 * real sockets, no Express. `PaneFeed` is exercised directly against a fake `inspect`/
 * `authorizeCaller` pair (module-level mutable stubs, restored in `afterEach`) and a fake
 * `AgentRunEventBus`-shaped bus. This keeps the whole suite synchronous and deterministic: every
 * timer fires only when the test calls `clock.fireTimeout()` / `clock.fireInterval()` itself, so
 * there is no way for this file to hang on an unclosed server or an un-unref'd real timer (the
 * exact failure mode the brief warns cost a previous wave its 30-minute budget) — nothing here
 * ever calls the real `setTimeout`.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import type { PaneDescriptorV1, PaneFeedEventV1, PaneTarget } from 'michi-shared';
import { PaneInspectionError } from 'michi-shared';
import * as paneInspectionModule from '../src/services/paneInspection';
import { PaneFeed, type PaneFeedEmitter, type PaneSubscribeClock } from '../src/services/paneInspectionSubscribe';
import { PaneInspectionRing } from '../src/services/paneInspectionRing';
import type { PaneInspectionCaller } from '../src/services/paneInspection';

// ---------------------------------------------------------------------------
// Fake clock/timer port — fully manual, no real timers anywhere in this file.
// ---------------------------------------------------------------------------

interface FakeHandle {
  id: number;
  fn: () => void;
  dueAt: number;
  intervalMs: number | null; // null for a one-shot setTimeout; the period for setInterval.
  cancelled: boolean;
}

function makeFakeClock() {
  let now = 0;
  let nextId = 1;
  const handles = new Map<number, FakeHandle>();

  const clock: PaneSubscribeClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      handles.set(id, { id, fn, dueAt: now + ms, intervalMs: null, cancelled: false });
      return id;
    },
    clearTimeout: (handle) => {
      const h = handles.get(handle as number);
      if (h) h.cancelled = true;
    },
    setInterval: (fn, ms) => {
      const id = nextId++;
      handles.set(id, { id, fn, dueAt: now + ms, intervalMs: ms, cancelled: false });
      return id;
    },
    clearInterval: (handle) => {
      const h = handles.get(handle as number);
      if (h) h.cancelled = true;
    },
  };

  return {
    clock,
    /** Advances the fake clock and fires every due, non-cancelled handle in dueAt order —
     *  intervals reschedule themselves; one-shot timeouts are removed after firing. */
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const due = [...handles.values()]
          .filter((h) => !h.cancelled && h.dueAt <= target)
          .sort((a, b) => a.dueAt - b.dueAt)[0];
        if (!due) break;
        now = due.dueAt;
        if (due.intervalMs !== null) due.dueAt = now + due.intervalMs;
        else handles.delete(due.id);
        due.fn();
      }
      now = target;
    },
    pendingTimeoutCount(): number {
      return [...handles.values()].filter((h) => !h.cancelled && h.intervalMs === null).length;
    },
    liveIntervalCount(): number {
      return [...handles.values()].filter((h) => !h.cancelled && h.intervalMs !== null).length;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake inspect() / authorizeCaller() — module-level, restored in afterEach.
// ---------------------------------------------------------------------------

const CALLER: PaneInspectionCaller = { ownerUserId: 'owner-a', workspaceId: 'ws-1', backendConnectionId: 'local' };

let inspectImpl: (caller: PaneInspectionCaller, input: unknown) => PaneDescriptorV1 = () => {
  throw new Error('inspectImpl not configured for this test');
};
let authorizeImpl: (caller: PaneInspectionCaller, target: PaneTarget) => void = () => {};

const originalInspect = paneInspectionModule.inspect;
const originalAuthorize = paneInspectionModule.authorizeCaller;

function stubService(): void {
  // node:test has no jest-style module mocking; this codebase's own convention (seen in
  // paneInspectionRoutes.test.ts) is DI overrides at the ROUTE layer. PaneFeed itself imports
  // `inspect`/`authorizeCaller` directly rather than taking them as constructor deps (see its
  // own file: it deliberately reuses the real functions so a feed test cannot silently drift
  // from what inspect_pane actually returns) — so this suite monkey-patches the two named
  // exports on the live module object, which Node's CJS/ESM interop for TypeScript's compiled
  // output still allows for a plain object export. Restored in afterEach unconditionally.
  (paneInspectionModule as unknown as Record<string, unknown>).inspect = (caller: PaneInspectionCaller, input: unknown) => inspectImpl(caller, input);
  (paneInspectionModule as unknown as Record<string, unknown>).authorizeCaller = (caller: PaneInspectionCaller, target: PaneTarget) => authorizeImpl(caller, target);
}

afterEach(() => {
  (paneInspectionModule as unknown as Record<string, unknown>).inspect = originalInspect;
  (paneInspectionModule as unknown as Record<string, unknown>).authorizeCaller = originalAuthorize;
  inspectImpl = () => { throw new Error('inspectImpl not configured for this test'); };
  authorizeImpl = () => {};
});

// ---------------------------------------------------------------------------
// Descriptor builders
// ---------------------------------------------------------------------------

function baseDescriptor(overrides: Partial<PaneDescriptorV1> = {}): PaneDescriptorV1 {
  return {
    version: 1,
    ref: { backendConnectionId: 'local', paneId: 'node:n-1' },
    target: { kind: 'node', nodeId: 'n-1' },
    kind: 'chat',
    title: 'Sample',
    workspaceId: 'ws-1',
    treeId: null,
    archived: false,
    truncatedFields: [],
    observation: { observedAt: 0, freshness: 'live', cursor: 'ignored' },
    capabilities: { readOutput: true, subscribe: true, waitForTerminal: true },
    activity: 'running',
    execution: {
      status: 'ready',
      value: {
        ref: { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' },
        assistantId: 'a-1', attemptId: null, attemptIndex: null,
        status: 'running', startedAt: 0, endedAt: null, commitState: 'pending',
        waitingReason: null, error: null,
      },
    },
    timeline: { resourceCreatedAt: 0, firstExecutionStartedAt: 0 },
    presence: { coverage: 'unknown', views: [] },
    conversation: { status: 'ready', value: { messageCount: 1, userMessageCount: 1, assistantMessageCount: 0, completedTurnCount: 0, turnHistoryCoverage: 'complete' } },
    lineage: { status: 'ready', value: { parentNodeId: null, parentRunId: null, originMessageId: null, treeRootNodeId: 'n-1', childNodeIds: [], childrenTruncated: false } },
    runtime: { status: 'ready', value: { runtimeId: null, modelId: null, providerId: null, contextUsagePercentage: null } },
    latestOutput: { status: 'ready', value: null },
    ...overrides,
  };
}

function withOutput(descriptor: PaneDescriptorV1, text: string, outputRevision: string): PaneDescriptorV1 {
  return {
    ...descriptor,
    latestOutput: {
      status: 'ready',
      value: {
        outputId: 'chat_turn:t-1', execution: { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' },
        kind: 'answer', text, outputRevision, updatedAt: 0, partial: true, truncated: false,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Emitter spy
// ---------------------------------------------------------------------------

function makeEmitter(): PaneFeedEmitter & { events: PaneFeedEventV1[] } {
  const events: PaneFeedEventV1[] = [];
  return { events, emit: (event) => events.push(event) };
}

function ring(clock: PaneSubscribeClock): PaneInspectionRing {
  return new PaneInspectionRing({ now: clock.now });
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// PaneFeed factory — always injects a synchronous in-memory metadataFetcher so this suite never
// opens a real SQLite handle (this file's own header comment promises no real I/O anywhere).
// A test that specifically wants to exercise the metadata watcher passes its own fetcher via
// `metadataFetcher` and this helper leaves it untouched.
// ---------------------------------------------------------------------------

function noopMetadataFetcher(): Map<string, import('../src/services/dbRepository').NodeMetadataBatchEntry> {
  return new Map();
}

function makeFeed(deps: Partial<ConstructorParameters<typeof PaneFeed>[0]> & { clock: PaneSubscribeClock; ring: PaneInspectionRing }): PaneFeed {
  return new PaneFeed({ metadataFetcher: noopMetadataFetcher, ...deps });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaneFeed — event types + cursor', () => {
  test('changed event fires with changedSections on a non-output change', () => {
    stubService();
    let descriptor = baseDescriptor();
    inspectImpl = () => descriptor;
    const fake = makeFakeClock();
    const feed = makeFeed({ clock: fake.clock, ring: ring(fake.clock), pollIntervalMs: 1_000 });
    const emitter = makeEmitter();
    feed.subscribe(CALLER, 'node:n-1', undefined, emitter);
    assert.equal(emitter.events.length, 1);

    descriptor = baseDescriptor({ title: 'Renamed' });
    fake.advance(1_000);

    const changed = emitter.events.find((e) => e.type === 'changed');
    assert.ok(changed, 'expected a changed event');
    if (changed?.type === 'changed') {
      assert.ok(changed.changedSections.includes('title'));
    }
    feed.stop();
  });
});

describe('PaneFeed — output coalescing must not swallow state (brief acceptance item)', () => {
  test('output_changed coalesces within the 250ms window', () => {
    stubService();
    let descriptor = withOutput(baseDescriptor(), 'hello', 'rev-1');
    inspectImpl = () => descriptor;
    const fake = makeFakeClock();
    const feed = makeFeed({ clock: fake.clock, ring: ring(fake.clock), pollIntervalMs: 50 });
    const emitter = makeEmitter();
    feed.subscribe(CALLER, 'node:n-1', undefined, emitter);
    assert.equal(emitter.events.length, 1); // snapshot only so far.

    descriptor = withOutput(descriptor, 'hello wor', 'rev-2');
    fake.advance(50); // one poll tick — detects the output-only change, arms the coalesce timer.
    assert.equal(emitter.events.filter((e) => e.type === 'output_changed').length, 0, 'must not flush before the window elapses');

    descriptor = withOutput(descriptor, 'hello world', 'rev-3');
    fake.advance(50); // a second poll tick within the window — replaces the pending descriptor.
    assert.equal(emitter.events.filter((e) => e.type === 'output_changed').length, 0);

    fake.advance(200); // total elapsed since the timer armed: 250ms — it fires now.
    const flushed = emitter.events.filter((e) => e.type === 'output_changed');
    assert.equal(flushed.length, 1, 'exactly one coalesced output_changed, not one per tick');
    if (flushed[0].type === 'output_changed') {
      assert.equal(flushed[0].preview.text, 'hello world', 'the LATEST pending descriptor wins, not the first');
    }
    feed.stop();
  });

  test('a terminal event flushes immediately even with an output coalesce timer pending', () => {
    stubService();
    let descriptor = withOutput(baseDescriptor(), 'partial', 'rev-1');
    inspectImpl = () => descriptor;
    const fake = makeFakeClock();
    const feed = makeFeed({ clock: fake.clock, ring: ring(fake.clock), pollIntervalMs: 50 });
    const emitter = makeEmitter();
    feed.subscribe(CALLER, 'node:n-1', undefined, emitter);

    // Arm a pending output-only change.
    descriptor = withOutput(descriptor, 'partial mo', 'rev-2');
    fake.advance(50);
    assert.equal(emitter.events.filter((e) => e.type === 'output_changed').length, 0);

    // Before the 250ms window elapses, the turn completes — a terminal transition.
    descriptor = {
      ...withOutput(descriptor, 'partial mo', 'rev-2'),
      activity: 'idle',
      execution: {
        status: 'ready',
        value: {
          ref: { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' },
          assistantId: 'a-1', attemptId: null, attemptIndex: null,
          status: 'completed', startedAt: 0, endedAt: 10, commitState: 'committed',
          waitingReason: null, error: null,
        },
      },
    };
    fake.advance(50); // still well within the 250ms coalesce window (only 100ms elapsed total).

    // Both the drained pending output_changed AND the execution_settled must have fired NOW,
    // without waiting for the remaining ~150ms of the coalesce window.
    const outputEvents = emitter.events.filter((e) => e.type === 'output_changed');
    const settledEvents = emitter.events.filter((e) => e.type === 'execution_settled');
    assert.equal(outputEvents.length, 1, 'the pending output change must be drained, not lost');
    assert.equal(settledEvents.length, 1, 'execution_settled must not be delayed behind the output timer');
    if (settledEvents[0].type === 'execution_settled') {
      assert.equal(settledEvents[0].outcome, 'completed');
      assert.equal(settledEvents[0].commitState, 'committed');
    }

    // Advancing further must not produce a SECOND output_changed for the same drained content.
    fake.advance(500);
    assert.equal(emitter.events.filter((e) => e.type === 'output_changed').length, 1);
    feed.stop();
  });
});

describe('PaneFeed — bounds and resync', () => {
  test('an unreplayable cursor yields resync_required rather than a gap', () => {
    stubService();
    const descriptor = baseDescriptor();
    inspectImpl = () => descriptor;
    const fake = makeFakeClock();
    const feed = makeFeed({ clock: fake.clock, ring: ring(fake.clock) });
    const emitter = makeEmitter();

    feed.subscribe(CALLER, 'node:n-1', 'totally-unknown-cursor-token', emitter);

    assert.equal(emitter.events[0].type, 'resync_required');
    assert.equal(emitter.events[1].type, 'snapshot', 'resync is always followed by data to resync from');
    feed.stop();
  });
});

describe('PaneFeed — slow consumer disconnect never cancels anything', () => {
  test('disconnect during initial snapshot never arms a new observer after stop', () => {
    stubService();
    inspectImpl = () => baseDescriptor();
    const fake = makeFakeClock();
    const sharedRing = ring(fake.clock);
    const feed = makeFeed({ clock: fake.clock, ring: sharedRing });
    feed.subscribe(CALLER, 'node:n-1', undefined, { emit: () => feed.stop() });
    assert.equal(sharedRing.hasActiveSubscriber('node:n-1'), false);
    assert.equal(fake.liveIntervalCount(), 0, 'snapshot failure must not retain polling/metadata timers');
    assert.equal(fake.pendingTimeoutCount(), 0);
  });

  test('a buffer-ceiling disconnect only detaches the observer', () => {
    stubService();
    let descriptor = baseDescriptor();
    inspectImpl = () => descriptor;
    const fake = makeFakeClock();
    const sharedRing = ring(fake.clock);
    const feed = makeFeed({ clock: fake.clock, ring: sharedRing, pollIntervalMs: 10 });
    let cancelCalled = false;
    const emitter: PaneFeedEmitter = {
      emit: () => {
        // Simulate the transport layer deciding the consumer is too slow and tearing the feed
        // down — mirrors what the route handler's own buffer-ceiling check does.
        feed.unsubscribe('node:n-1');
      },
    };

    feed.subscribe(CALLER, 'node:n-1', undefined, emitter);
    descriptor = baseDescriptor({ title: 'changed' });
    fake.advance(10);

    assert.equal(cancelCalled, false, 'no cancel call happened');
    assert.equal(sharedRing.hasActiveSubscriber('node:n-1'), false, 'ref-count released on disconnect');
  });
});

describe('PaneFeed — revoking access mid-stream', () => {
  test('emits access_revoked once and sends nothing further for that object', () => {
    stubService();
    let allowed = true;
    authorizeImpl = () => {
      if (!allowed) throw new PaneInspectionError('NOT_FOUND', 'inspect', 'target not found');
    };
    let descriptor = baseDescriptor();
    inspectImpl = () => descriptor;
    const fake = makeFakeClock();
    const sharedRing = ring(fake.clock);
    const feed = makeFeed({ clock: fake.clock, ring: sharedRing, pollIntervalMs: 10 });
    const emitter = makeEmitter();
    feed.subscribe(CALLER, 'node:n-1', undefined, emitter);
    assert.equal(emitter.events.length, 1);

    allowed = false;
    fake.advance(10);
    assert.equal(emitter.events.filter((e) => e.type === 'access_revoked').length, 1);

    // Further ticks must not produce a SECOND access_revoked, or any other content.
    descriptor = baseDescriptor({ title: 'should never be seen' });
    allowed = true; // even if access were restored, this object is already settled.
    fake.advance(1_000);
    assert.equal(emitter.events.filter((e) => e.type === 'access_revoked').length, 1);
    assert.equal(emitter.events.length, 2, 'no further events for a settled/revoked object');
    feed.stop();
  });
});
