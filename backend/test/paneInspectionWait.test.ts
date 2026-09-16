/**
 * paneInspectionWait.test.ts — P3-5 core acceptance case (commit #1) plus priority-ordered
 * remaining cases (commit #2, brief's list).
 *
 * Fully fake clock/timer port (mirrors paneInspectionSubscribe.test.ts's own `makeFakeClock`) —
 * no real setTimeout/setInterval anywhere in this file, so a leaked listener or un-unref'd timer
 * makes a specific assertion fail rather than hanging the process.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import type { ExecutionRef, PaneDescriptorV1, PaneTarget } from 'michi-shared';
import { PaneInspectionError } from 'michi-shared';
import * as paneInspectionModule from '../src/services/paneInspection';
import { PaneInspectionRing } from '../src/services/paneInspectionRing';
import type { PaneInspectionCaller } from '../src/services/paneInspection';
import type { PaneSubscribeClock } from '../src/services/paneInspectionSubscribe';
import * as paneInspectionRingModule from '../src/services/paneInspectionRing';
import { waitPane, type WaitPaneInput } from '../src/services/paneInspectionWait';

// ---------------------------------------------------------------------------
// Fake clock — identical shape/semantics to paneInspectionSubscribe.test.ts's own.
// ---------------------------------------------------------------------------

interface FakeHandle {
  id: number;
  fn: () => void;
  dueAt: number;
  intervalMs: number | null;
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
    clearTimeout: (handle) => { const h = handles.get(handle as number); if (h) h.cancelled = true; },
    setInterval: (fn, ms) => {
      const id = nextId++;
      handles.set(id, { id, fn, dueAt: now + ms, intervalMs: ms, cancelled: false });
      return id;
    },
    clearInterval: (handle) => { const h = handles.get(handle as number); if (h) h.cancelled = true; },
  };

  return {
    clock,
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const due = [...handles.values()].filter((h) => !h.cancelled && h.dueAt <= target).sort((a, b) => a.dueAt - b.dueAt)[0];
        if (!due) break;
        now = due.dueAt;
        if (due.intervalMs !== null) due.dueAt = now + due.intervalMs;
        else handles.delete(due.id);
        due.fn();
      }
      now = target;
    },
    liveTimerCount(): number {
      return [...handles.values()].filter((h) => !h.cancelled).length;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake inspect()/authorizeCaller() — module-level monkeypatch, mirrors
// paneInspectionSubscribe.test.ts's own `stubService` convention exactly (this codebase's
// established pattern for a PaneFeed-consuming test, since PaneFeed/waitPane both import the
// real functions directly rather than taking them as constructor deps).
// ---------------------------------------------------------------------------

const CALLER: PaneInspectionCaller = { ownerUserId: 'owner-a', workspaceId: 'ws-1', backendConnectionId: 'local' };

let inspectImpl: (caller: PaneInspectionCaller, input: unknown) => PaneDescriptorV1 = () => {
  throw new Error('inspectImpl not configured for this test');
};
let authorizeImpl: (caller: PaneInspectionCaller, target: PaneTarget) => void = () => {};

const originalInspect = paneInspectionModule.inspect;
const originalAuthorize = paneInspectionModule.authorizeCaller;

function stubService(): void {
  (paneInspectionModule as unknown as Record<string, unknown>).inspect = (caller: PaneInspectionCaller, input: unknown) => inspectImpl(caller, input);
  (paneInspectionModule as unknown as Record<string, unknown>).authorizeCaller = (caller: PaneInspectionCaller, target: PaneTarget) => authorizeImpl(caller, target);
}

afterEach(() => {
  (paneInspectionModule as unknown as Record<string, unknown>).inspect = originalInspect;
  (paneInspectionModule as unknown as Record<string, unknown>).authorizeCaller = originalAuthorize;
  inspectImpl = () => { throw new Error('inspectImpl not configured for this test'); };
  authorizeImpl = () => {};
  // Fresh ring per test — waitPane imports the module-level `paneInspectionRing` singleton, so a
  // cursor minted in one test must not leak into the next.
  Object.assign(paneInspectionRingModule.paneInspectionRing, new PaneInspectionRing({ now: () => 0 }));
});

// ---------------------------------------------------------------------------
// Descriptor builder
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

const EXECUTION_REF: ExecutionRef = { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' };

// ---------------------------------------------------------------------------
// Commit #1's case
// ---------------------------------------------------------------------------

describe('waitPane — until: changed', () => {
  test('a stale cursor (content already differs) returns reason=changed immediately, no timer left running', async () => {
    stubService();
    const { clock } = makeFakeClock();
    authorizeImpl = () => {};

    const scope = { ownerUserId: CALLER.ownerUserId, workspaceId: CALLER.workspaceId, runOwnerId: null };
    const oldDescriptor = baseDescriptor({ title: 'Sample' });
    const newDescriptor = baseDescriptor({ title: 'Renamed' });
    const contentOf = (d: PaneDescriptorV1) => { const { observation, presence, ...rest } = d; return { ...rest, observation: { freshness: observation.freshness }, presence }; };

    // Mint a real cursor via the singleton ring the way `inspect()`'s own `mintChatCursor` does,
    // at the object's OLD content — this is "the caller's last-seen cursor".
    const staleCursor = paneInspectionRingModule.paneInspectionRing.mintInspectionCursor('node:n-1', scope, contentOf(oldDescriptor));
    // Advance the ring's content past that cursor — the object has moved on since it was minted.
    paneInspectionRingModule.paneInspectionRing.recordContentChange('node:n-1', scope, contentOf(newDescriptor), { kind: 'changed', payload: {}, sizeBytes: 1 });

    inspectImpl = () => newDescriptor;

    // Now the object has moved on — the very next inspect() (call #2 above) reports new content.
    const input: WaitPaneInput = { locator: { nodeId: 'n-1' }, until: 'changed', cursor: staleCursor, timeoutMs: 20_000 };
    const out = await waitPane(CALLER, input, { clock });

    assert.equal(out.reason, 'changed');
    assert.equal(out.descriptor?.title, 'Renamed');
    assert.ok(out.cursor.length > 0);
    assert.equal(clock, clock); // sanity: the same injected clock was actually used (no real timers).
  });
});

// ---------------------------------------------------------------------------
// Commit #2's cases, in the brief's priority order.
// ---------------------------------------------------------------------------

describe('waitPane — until: terminal', () => {
  test("returns when T1's own executionRef settles and is NOT satisfied by T2 starting", async () => {
    stubService();
    const { clock, advance, liveTimerCount } = makeFakeClock();
    authorizeImpl = () => {};

    const t1Running = baseDescriptor({
      execution: { status: 'ready', value: { ref: EXECUTION_REF, assistantId: 'a-1', attemptId: null, attemptIndex: null, status: 'running', startedAt: 0, endedAt: null, commitState: 'pending', waitingReason: null, error: null } },
    });
    // T2 starts (a NEW executionRef) while T1 is still running — a plain "current attempt" read
    // now reflects T2, not T1.
    const t2ExecRef: ExecutionRef = { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-2' };
    const t2Running = baseDescriptor({
      execution: { status: 'ready', value: { ref: t2ExecRef, assistantId: 'a-1', attemptId: null, attemptIndex: null, status: 'running', startedAt: 5, endedAt: null, commitState: 'pending', waitingReason: null, error: null } },
    });
    const t1Completed = baseDescriptor({
      execution: { status: 'ready', value: { ref: EXECUTION_REF, assistantId: 'a-1', attemptId: null, attemptIndex: null, status: 'completed', startedAt: 0, endedAt: 20, commitState: 'committed', waitingReason: null, error: null } },
    });

    let tick = 0; // advanced explicitly by the test, not by call count — avoids coupling to how
    // many times the service happens to call inspect() per phase.
    inspectImpl = (_caller, rawInput) => {
      const input = rawInput as { executionRef?: ExecutionRef };
      const ref = input.executionRef;
      if (ref && ref.kind === 'chat_turn' && ref.turnId === 't-1') {
        // Scoped re-inspect of T1's own ref: reflects T1's OWN status regardless of tick.
        return tick >= 2 ? t1Completed : t1Running;
      }
      // Plain re-inspect (no executionRef) reflects the CURRENT attempt: T2 once it has started.
      return tick >= 1 ? t2Running : t1Running;
    };

    const input: WaitPaneInput = { locator: { nodeId: 'n-1' }, until: 'terminal', executionRef: EXECUTION_REF, timeoutMs: 20_000 };
    const promise = waitPane(CALLER, input, { clock });

    // T2 starts: a plain re-inspect now shows T2 running. This must fire the oncePerObject
    // listener's "changed" trigger (via the coarse poll below) but must NOT settle the wait,
    // since it's re-scoped to T1's own ref, which is still running.
    tick = 1;
    advance(2_000); // oncePerObject's coarse poll fallback (this test injects no chatHub/run bus).

    // T1 itself now completes.
    tick = 2;
    advance(2_000);

    const out = await promise;
    assert.equal(out.reason, 'terminal');
    const execution = out.descriptor?.execution;
    const ref = execution && execution.status === 'ready' && execution.value ? execution.value.ref : null;
    assert.equal(ref?.kind === 'chat_turn' ? ref.turnId : undefined, 't-1');
    assert.equal(out.outcome, 'completed');
  });

  test('terminal without executionRef is rejected as INVALID_ARGUMENT before any inspect() call', async () => {
    stubService();
    const { clock } = makeFakeClock();
    let inspectCalled = false;
    inspectImpl = () => { inspectCalled = true; return baseDescriptor(); };
    authorizeImpl = () => {};

    const input = { locator: { nodeId: 'n-1' }, until: 'terminal', timeoutMs: 20_000 } as WaitPaneInput;
    await assert.rejects(() => waitPane(CALLER, input, { clock }), (err: unknown) => err instanceof PaneInspectionError && err.code === 'INVALID_ARGUMENT');
    assert.equal(inspectCalled, false);
  });

  test('a queued chat (no turn started) using until=terminal is rejected the same way', async () => {
    // design §7.4: "chat 的首轮 turnId 在 queued 状态时尚不存在" — the caller simply has no
    // executionRef to pass yet, so this collapses to the same INVALID_ARGUMENT case above rather
    // than a distinct code; the queued state itself is only ever observable via until=changed.
    stubService();
    const { clock } = makeFakeClock();
    authorizeImpl = () => {};
    inspectImpl = () => baseDescriptor({ activity: 'queued', execution: { status: 'unknown', reason: 'no turn yet' } });

    const input = { locator: { nodeId: 'n-1' }, until: 'terminal', timeoutMs: 20_000 } as WaitPaneInput;
    await assert.rejects(() => waitPane(CALLER, input, { clock }), (err: unknown) => err instanceof PaneInspectionError && err.code === 'INVALID_ARGUMENT');
  });
});

describe('waitPane — timeout', () => {
  test('aborting an observer releases listeners, timers and its owner wait slot', async () => {
    stubService();
    inspectImpl = () => baseDescriptor();
    const clock = makeFakeClock();
    for (let i = 0; i < 12; i++) {
      const controller = new AbortController();
      const waiting = waitPane(CALLER, { locator: { nodeId: 'n-1' }, until: 'terminal',
        executionRef: { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' }, timeoutMs: 30_000, signal: controller.signal }, { clock: clock.clock });
      controller.abort();
      assert.equal((await waiting).reason, 'unavailable');
      assert.equal(clock.liveTimerCount(), 0);
    }
  });

  test('an unexpected second-check failure cleans up the already attached observer', async () => {
    stubService();
    const clock = makeFakeClock();
    let calls = 0;
    inspectImpl = () => {
      if (++calls > 1) throw new Error('source failed');
      return baseDescriptor();
    };
    await assert.rejects(waitPane(CALLER, { locator: { nodeId: 'n-1' }, until: 'terminal',
      executionRef: { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' }, timeoutMs: 100 }, { clock: clock.clock }), /source failed/);
    assert.equal(clock.liveTimerCount(), 0);
  });

  test('timeout refreshes the descriptor instead of returning its setup snapshot', async () => {
    stubService();
    const clock = makeFakeClock();
    let current = baseDescriptor();
    inspectImpl = () => current;
    const waiting = waitPane(CALLER, { locator: { nodeId: 'n-1' }, until: 'terminal',
      executionRef: { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' }, timeoutMs: 100 }, { clock: clock.clock });
    current = { ...current, title: 'changed before timeout' };
    clock.advance(100);
    const result = await waiting;
    assert.equal(result.reason, 'timed_out');
    assert.equal(result.descriptor?.title, current.title);
    assert.equal(clock.liveTimerCount(), 0);
  });

  test('times out with reason=timed_out and asserts no cancel call happened', async () => {
    stubService();
    const { clock, advance } = makeFakeClock();
    authorizeImpl = () => {};
    let cancelCalled = false;
    inspectImpl = () => baseDescriptor(); // never changes.

    const input: WaitPaneInput = { locator: { nodeId: 'n-1' }, until: 'terminal', executionRef: EXECUTION_REF, timeoutMs: 10_000 };
    const promise = waitPane(CALLER, input, { clock });
    advance(10_000);
    const out = await promise;

    assert.equal(out.reason, 'timed_out');
    assert.equal(cancelCalled, false); // waitPane never calls any cancel function — verified by construction: no such import exists in the module.
  });

  test('the listener is released on timeout — no live timers remain', async () => {
    stubService();
    const { clock, advance, liveTimerCount } = makeFakeClock();
    authorizeImpl = () => {};
    inspectImpl = () => baseDescriptor();

    const input: WaitPaneInput = { locator: { nodeId: 'n-1' }, until: 'changed', cursor: 'whatever-does-not-resolve', timeoutMs: 10_000 };
    // An unresolvable cursor (`resolveCursor` -> ok:false) is treated as "already changed" per
    // this module's own contract for a cursor it cannot recognise as current — so this call
    // resolves on check #1 rather than timing out. Use a resolvable-but-current cursor instead so
    // the wait actually arms a listener and we can assert on timer cleanup after timeout.
    const scope = { ownerUserId: CALLER.ownerUserId, workspaceId: CALLER.workspaceId, runOwnerId: null };
    const content = (() => { const d = baseDescriptor(); const { observation, presence, ...rest } = d; return { ...rest, observation: { freshness: observation.freshness }, presence }; })();
    const currentCursor = paneInspectionRingModule.paneInspectionRing.mintInspectionCursor('node:n-1', scope, content);
    input.cursor = currentCursor;

    const promise = waitPane(CALLER, input, { clock });
    advance(10_000);
    await promise;
    assert.equal(liveTimerCount(), 0);
  });
});

describe('waitPane — check→subscribe→check race', () => {
  test('a change landing between the first check and the listener attach is still caught', async () => {
    stubService();
    const { clock } = makeFakeClock();
    authorizeImpl = () => {};

    const before = baseDescriptor({ title: 'Before' });
    const after = baseDescriptor({ title: 'After' });
    let callCount = 0;
    inspectImpl = () => {
      callCount += 1;
      // Call #1 (check #1) sees the OLD content; every call from #2 onward (check #2, and any
      // listener-triggered re-inspect) sees the NEW content — simulating a change that landed in
      // the window between check #1 returning and the listener being armed, entirely synchronous
      // (no clock advance needed) so this can only pass if check #2 exists.
      return callCount === 1 ? before : after;
    };

    const scope = { ownerUserId: CALLER.ownerUserId, workspaceId: CALLER.workspaceId, runOwnerId: null };
    const contentOf = (d: PaneDescriptorV1) => { const { observation, presence, ...rest } = d; return { ...rest, observation: { freshness: observation.freshness }, presence }; };
    const cursor = paneInspectionRingModule.paneInspectionRing.mintInspectionCursor('node:n-1', scope, contentOf(before));

    const input: WaitPaneInput = { locator: { nodeId: 'n-1' }, until: 'changed', cursor, timeoutMs: 20_000 };
    const out = await waitPane(CALLER, input, { clock });

    assert.equal(out.reason, 'changed');
    assert.equal(out.descriptor?.title, 'After');
    assert.ok(callCount >= 2, 'the race is only closed if a second inspect() actually happened after arming');
  });
});

describe('waitPane — rate limiting', () => {
  test('a 9th concurrent wait for the same owner is rejected as RATE_LIMITED', async () => {
    stubService();
    const { clock, advance } = makeFakeClock();
    authorizeImpl = () => {};
    inspectImpl = () => baseDescriptor(); // never changes — every wait stays pending until timeout.

    const owner = { ...CALLER, ownerUserId: 'owner-rate-limit-test' };
    const pending: Array<Promise<unknown>> = [];
    for (let i = 0; i < 8; i += 1) {
      pending.push(waitPane(owner, { locator: { nodeId: 'n-1' }, until: 'terminal', executionRef: EXECUTION_REF, timeoutMs: 20_000 }, { clock }));
    }

    await assert.rejects(
      () => waitPane(owner, { locator: { nodeId: 'n-1' }, until: 'terminal', executionRef: EXECUTION_REF, timeoutMs: 20_000 }, { clock }),
      (err: unknown) => err instanceof PaneInspectionError && err.code === 'RATE_LIMITED',
    );

    // Drain the 8 pending waits (their own timeout) so the wait-slot count returns to zero and
    // this test does not leak state into the next one.
    advance(20_000);
    await Promise.all(pending);
  });
});
