import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PaneInspectionRing, type AuthorizationScope, type RingEvent } from '../src/services/paneInspectionRing';

const SCOPE_A: AuthorizationScope = { ownerUserId: 'user-a', workspaceId: 'ws-1' };
const SCOPE_B: AuthorizationScope = { ownerUserId: 'user-b', workspaceId: 'ws-1' };
const SCOPE_RUN: AuthorizationScope = { ownerUserId: 'user-a', workspaceId: 'ws-1', runOwnerId: 'run-1' };

function makeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    set: (value: number) => {
      now = value;
    },
  };
}

function makeTokenSequence() {
  let n = 0;
  return () => `token-${n++}`;
}

function contentEvent(payload: unknown, sizeBytes = 10): RingEvent {
  return { kind: 'changed', payload, sizeBytes };
}

type RingCtorOptions = ConstructorParameters<typeof PaneInspectionRing>[0];

function ring(overrides: Partial<RingCtorOptions> = {}) {
  const clock = makeClock();
  const tokens = makeTokenSequence();
  const r = new PaneInspectionRing({
    now: clock.now,
    createToken: tokens,
    epoch: 'epoch-1',
    ...overrides,
  });
  return { r, clock, tokens };
}

describe('paneInspectionRing — workspace budget + LRU eviction', () => {
  test('workspace budget evicts the least-recently-used object', () => {
    const { r, clock } = ring({ workspaceRingBudgetBytes: 25, ringMaxBytes: 1_000_000, ringMaxEvents: 1_000, ringMaxAgeMs: 1_000_000 });
    r.recordContentChange('p1', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }, 20));
    clock.advance(10);
    r.recordContentChange('p2', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }, 20));
    // Total is 40 > 25 budget -> p1 (older lastTouchedAt) evicted.
    assert.equal(r.hasRing('p1'), false);
    assert.equal(r.hasRing('p2'), true);
  });

  test('when every object in the workspace is subscribed, the budget is exceeded rather than evicting', () => {
    const { r } = ring({ workspaceRingBudgetBytes: 10, ringMaxBytes: 1_000_000, ringMaxEvents: 1_000, ringMaxAgeMs: 1_000_000 });
    r.registerSubscriber('p1', SCOPE_A);
    r.registerSubscriber('p2', SCOPE_A);
    r.recordContentChange('p1', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }, 20));
    r.recordContentChange('p2', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }, 20));
    assert.equal(r.hasRing('p1'), true);
    assert.equal(r.hasRing('p2'), true);
    assert.ok(r.getRingBytes('p1') + r.getRingBytes('p2') > 10, 'budget intentionally exceeded');
  });
});

describe('paneInspectionRing — revision semantics', () => {
  test('a presence keepalive renewing lastSeenAt does NOT advance revision', () => {
    const { r } = ring();
    r.recordContentChange('p1', SCOPE_A, { views: ['w1'] }, contentEvent({ v: 1 }));
    const before = r.getRevision('p1');
    r.recordPresenceKeepalive('p1', SCOPE_A);
    assert.equal(r.getRevision('p1'), before);
  });

  test('a feed heartbeat does NOT advance revision', () => {
    const { r } = ring();
    r.recordContentChange('p1', SCOPE_A, { views: ['w1'] }, contentEvent({ v: 1 }));
    const before = r.getRevision('p1');
    r.recordHeartbeat('p1');
    assert.equal(r.getRevision('p1'), before);
  });

  test('a heartbeat for an object with no ring yet is a harmless no-op', () => {
    const { r } = ring();
    assert.doesNotThrow(() => r.recordHeartbeat('never-seen'));
    assert.equal(r.hasRing('never-seen'), false);
  });

  test('recordContentChange with genuinely identical content is a no-op, not just caller trust', () => {
    const { r } = ring();
    r.recordContentChange('p1', SCOPE_A, { views: ['w1'] }, contentEvent({ v: 1 }));
    const before = r.getRevision('p1');
    const beforeCount = r.getEventCount('p1');
    r.recordContentChange('p1', SCOPE_A, { views: ['w1'] }, contentEvent({ v: 2 }));
    assert.equal(r.getRevision('p1'), before, 'identical content never advances revision even via the content-change entry point');
    assert.equal(r.getEventCount('p1'), beforeCount, 'no event appended for a no-op change');
  });
});

describe('paneInspectionRing — cursors', () => {
  test('an expired cursor yields resync', () => {
    const { r, clock } = ring({ cursorTtlMs: 1_000 });
    const cursor = r.recordContentChange('p1', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }));
    clock.advance(1_001);
    const resolution = r.resolveCursor(cursor, SCOPE_A);
    assert.equal(resolution.ok, false);
    if (!resolution.ok) assert.equal(resolution.reason, 'aged_out');
  });

  test('a cursor minted for a plain caller does not resolve for a Run caller with the same owner/workspace', () => {
    const { r } = ring();
    const cursor = r.recordContentChange('p1', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }));
    const resolution = r.resolveCursor(cursor, SCOPE_RUN);
    assert.equal(resolution.ok, false);
  });

  test('a simulated process-epoch change invalidates every outstanding cursor', () => {
    const { r } = ring();
    const cursor = r.recordContentChange('p1', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }));
    assert.equal(r.resolveCursor(cursor, SCOPE_A).ok, true, 'sanity: resolves before any epoch change');

    r.resetEpoch('epoch-after-restart');
    const resolution = r.resolveCursor(cursor, SCOPE_A);
    assert.equal(resolution.ok, false);
    if (!resolution.ok) assert.equal(resolution.reason, 'epoch_mismatch');

    // And it stays invalid — resetEpoch's mismatch also sweeps the token on first detection.
    assert.equal(r.resolveCursor(cursor, SCOPE_A).ok, false);
  });

  test('a cursor pointing past ring-trimmed history is not_replayable', () => {
    const { r } = ring({ ringMaxAgeMs: 1_000_000, ringMaxEvents: 2, ringMaxBytes: 1_000_000 });
    const cursor1 = r.recordContentChange('p1', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }));
    r.recordContentChange('p1', SCOPE_A, { v: 2 }, contentEvent({ i: 2 }));
    r.recordContentChange('p1', SCOPE_A, { v: 3 }, contentEvent({ i: 3 }));
    r.recordContentChange('p1', SCOPE_A, { v: 4 }, contentEvent({ i: 4 }));
    // Ring bound is 2 events; cursor1 was minted at revision 1, but the ring now only retains
    // revisions 3 and 4 — replaying from revision 1 would have a gap.
    const resolution = r.resolveCursor(cursor1, SCOPE_A);
    assert.equal(resolution.ok, false);
    if (!resolution.ok) assert.equal(resolution.reason, 'not_replayable');
  });
});
