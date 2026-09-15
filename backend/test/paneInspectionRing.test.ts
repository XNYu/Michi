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

describe('paneInspectionRing — per-object bounds', () => {
  test('age bound trims independently of count/bytes', () => {
    const { r, clock } = ring({ ringMaxAgeMs: 1_000, ringMaxEvents: 1_000, ringMaxBytes: 1_000_000 });
    r.recordContentChange('p1', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }));
    clock.advance(500);
    r.recordContentChange('p1', SCOPE_A, { v: 2 }, contentEvent({ i: 2 }));
    assert.equal(r.getEventCount('p1'), 2);

    clock.advance(600); // first event now 1100ms old, > 1000ms bound; second is 600ms old, within bound
    r.recordContentChange('p1', SCOPE_A, { v: 3 }, contentEvent({ i: 3 }));
    // Trimming happens lazily on the next record call (append triggers trimRing).
    assert.equal(r.getEventCount('p1'), 2, 'oldest event aged out, the other two remain');
  });

  test('count bound trims independently of age/bytes', () => {
    const { r } = ring({ ringMaxAgeMs: 1_000_000, ringMaxEvents: 3, ringMaxBytes: 1_000_000 });
    for (let i = 0; i < 5; i++) {
      r.recordContentChange('p1', SCOPE_A, { v: i }, contentEvent({ i }));
    }
    assert.equal(r.getEventCount('p1'), 3);
  });

  test('byte bound trims independently of age/count', () => {
    const { r } = ring({ ringMaxAgeMs: 1_000_000, ringMaxEvents: 1_000, ringMaxBytes: 25 });
    r.recordContentChange('p1', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }, 10));
    r.recordContentChange('p1', SCOPE_A, { v: 2 }, contentEvent({ i: 2 }, 10));
    assert.equal(r.getRingBytes('p1'), 20);
    r.recordContentChange('p1', SCOPE_A, { v: 3 }, contentEvent({ i: 3 }, 10));
    // 30 bytes total > 25 bound -> oldest (10 bytes) trimmed, leaving 20 bytes.
    assert.equal(r.getRingBytes('p1'), 20);
    assert.equal(r.getEventCount('p1'), 2);
  });

  test('whichever bound hits first wins, per call', () => {
    // Count bound is the tightest here; age/bytes are generous.
    const { r } = ring({ ringMaxAgeMs: 1_000_000, ringMaxEvents: 2, ringMaxBytes: 1_000_000 });
    r.recordContentChange('p1', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }));
    r.recordContentChange('p1', SCOPE_A, { v: 2 }, contentEvent({ i: 2 }));
    r.recordContentChange('p1', SCOPE_A, { v: 3 }, contentEvent({ i: 3 }));
    assert.equal(r.getEventCount('p1'), 2);
  });
});

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

  test('an object with an active subscriber is NOT evicted under pressure that evicts an unwatched one', () => {
    const { r, clock } = ring({ workspaceRingBudgetBytes: 25, ringMaxBytes: 1_000_000, ringMaxEvents: 1_000, ringMaxAgeMs: 1_000_000 });
    r.recordContentChange('watched', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }, 20));
    r.registerSubscriber('watched', SCOPE_A);
    clock.advance(10);
    r.recordContentChange('idle', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }, 20));
    // Total 40 > 25. 'watched' is older (more evictable by LRU order) but has a subscriber, so
    // 'idle' — the unwatched object — must be evicted instead even though it is newer.
    assert.equal(r.hasRing('watched'), true, 'subscribed object survives LRU pressure');
    assert.equal(r.hasRing('idle'), false, 'unwatched object is evicted instead');
  });

  test('after its last subscriber disconnects, the object becomes evictable again', () => {
    const { r, clock } = ring({ workspaceRingBudgetBytes: 25, ringMaxBytes: 1_000_000, ringMaxEvents: 1_000, ringMaxAgeMs: 1_000_000 });
    r.recordContentChange('watched', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }, 20));
    r.registerSubscriber('watched', SCOPE_A);
    r.releaseSubscriber('watched');
    assert.equal(r.hasActiveSubscriber('watched'), false);

    clock.advance(10);
    r.recordContentChange('idle', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }, 20));
    // Now 'watched' has zero subscribers and is the LRU victim.
    assert.equal(r.hasRing('watched'), false);
    assert.equal(r.hasRing('idle'), true);
  });

  test('subscriber ref-counting survives double-subscribe + single release', () => {
    const { r } = ring();
    r.registerSubscriber('p1', SCOPE_A);
    r.registerSubscriber('p1', SCOPE_A); // e.g. two tabs watching the same pane
    r.releaseSubscriber('p1');
    assert.equal(r.hasActiveSubscriber('p1'), true, 'still exempt — one registration remains');
    r.releaseSubscriber('p1');
    assert.equal(r.hasActiveSubscriber('p1'), false, 'now evictable — last subscriber released');
  });

  test('releasing an already-zero or unknown subscriber is a no-op, not an error', () => {
    const { r } = ring();
    assert.doesNotThrow(() => r.releaseSubscriber('never-registered'));
    r.registerSubscriber('p1', SCOPE_A);
    r.releaseSubscriber('p1');
    assert.doesNotThrow(() => r.releaseSubscriber('p1')); // already at zero
    assert.equal(r.hasActiveSubscriber('p1'), false);
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
  test('an inspect-style observedAt refresh does NOT advance revision', () => {
    const { r } = ring();
    r.recordContentChange('p1', SCOPE_A, { views: ['w1'] }, contentEvent({ v: 1 }));
    const before = r.getRevision('p1');
    r.recordObservedAtRefresh('p1', SCOPE_A);
    assert.equal(r.getRevision('p1'), before);
  });

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

  test('a view added DOES advance revision', () => {
    const { r } = ring();
    r.recordContentChange('p1', SCOPE_A, { views: ['w1'] }, contentEvent({ v: 1 }));
    const before = r.getRevision('p1');
    r.recordContentChange('p1', SCOPE_A, { views: ['w1', 'w2'] }, contentEvent({ v: 2 }));
    assert.equal(r.getRevision('p1'), (before ?? 0) + 1);
  });

  test('a view removed DOES advance revision', () => {
    const { r } = ring();
    r.recordContentChange('p1', SCOPE_A, { views: ['w1', 'w2'] }, contentEvent({ v: 1 }));
    const before = r.getRevision('p1');
    r.recordContentChange('p1', SCOPE_A, { views: ['w1'] }, contentEvent({ v: 2 }));
    assert.equal(r.getRevision('p1'), (before ?? 0) + 1);
  });

  test('a visible flip DOES advance revision', () => {
    const { r } = ring();
    r.recordContentChange('p1', SCOPE_A, { visible: true }, contentEvent({ v: 1 }));
    const before = r.getRevision('p1');
    r.recordContentChange('p1', SCOPE_A, { visible: false }, contentEvent({ v: 2 }));
    assert.equal(r.getRevision('p1'), (before ?? 0) + 1);
  });

  test('a lease expiry (modeled as a content field change) DOES advance revision', () => {
    const { r } = ring();
    r.recordContentChange('p1', SCOPE_A, { presence: 'reported' }, contentEvent({ v: 1 }));
    const before = r.getRevision('p1');
    r.recordContentChange('p1', SCOPE_A, { presence: 'unknown' }, contentEvent({ v: 2 }));
    assert.equal(r.getRevision('p1'), (before ?? 0) + 1);
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

  test('recordSnapshot establishes a baseline without advancing revision on the very first call', () => {
    const { r } = ring();
    r.recordSnapshot('p1', SCOPE_A, { views: [] });
    assert.equal(r.getRevision('p1'), 0);
    assert.equal(r.getEventCount('p1'), 0, 'a snapshot is the baseline, not a replayable ring event');
  });

  test('recordSnapshot after a genuine change DOES advance revision', () => {
    const { r } = ring();
    r.recordSnapshot('p1', SCOPE_A, { views: [] });
    r.recordSnapshot('p1', SCOPE_A, { views: ['w1'] });
    assert.equal(r.getRevision('p1'), 1);
  });
});

describe('paneInspectionRing — cursors', () => {
  test('a cursor round-trips to its locating information', () => {
    const { r } = ring();
    const cursor = r.recordContentChange('p1', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }));
    const resolution = r.resolveCursor(cursor, SCOPE_A);
    assert.equal(resolution.ok, true);
    if (resolution.ok) {
      assert.equal(resolution.paneId, 'p1');
      assert.equal(resolution.revision, 1);
    }
  });

  test('an expired cursor yields resync', () => {
    const { r, clock } = ring({ cursorTtlMs: 1_000 });
    const cursor = r.recordContentChange('p1', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }));
    clock.advance(1_001);
    const resolution = r.resolveCursor(cursor, SCOPE_A);
    assert.equal(resolution.ok, false);
    if (!resolution.ok) assert.equal(resolution.reason, 'aged_out');
  });

  test('an unknown/forged token yields resync and never resolves', () => {
    const { r } = ring();
    const resolution = r.resolveCursor('completely-made-up-token', SCOPE_A);
    assert.equal(resolution.ok, false);
    if (!resolution.ok) assert.equal(resolution.reason, 'unknown_cursor');
  });

  test('re-resolving the same forged token twice never succeeds', () => {
    const { r } = ring();
    assert.equal(r.resolveCursor('forged', SCOPE_A).ok, false);
    assert.equal(r.resolveCursor('forged', SCOPE_A).ok, false);
  });

  test('a cursor minted for one authorisation scope does not resolve for another', () => {
    const { r } = ring();
    const cursor = r.recordContentChange('p1', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }));
    const resolution = r.resolveCursor(cursor, SCOPE_B);
    assert.equal(resolution.ok, false);
    if (!resolution.ok) assert.equal(resolution.reason, 'unknown_cursor');
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

  test('a fresh process instance (different epoch, empty cursor map) reports unknown_cursor for a prior process\'s token', () => {
    const clock = makeClock();
    const tokens = makeTokenSequence();
    const before = new PaneInspectionRing({ now: clock.now, createToken: tokens, epoch: 'epoch-A' });
    const cursor = before.recordContentChange('p1', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }));

    // A real restart never reuses the old instance — it constructs a brand-new one with no
    // knowledge of the old instance's cursors at all, so the SAME token string resolves
    // unknown_cursor here, not epoch_mismatch (that branch is unreachable from a real restart;
    // see resetEpoch's doc comment).
    const after = new PaneInspectionRing({ now: clock.now, createToken: tokens, epoch: 'epoch-B' });
    const resolution = after.resolveCursor(cursor, SCOPE_A);
    assert.equal(resolution.ok, false);
    if (!resolution.ok) assert.equal(resolution.reason, 'unknown_cursor');
  });

  test('evicting a ring yields resync_required for a cursor that pointed into it', () => {
    const { r } = ring({ workspaceRingBudgetBytes: 25, ringMaxBytes: 1_000_000, ringMaxEvents: 1_000, ringMaxAgeMs: 1_000_000 });
    const cursor = r.recordContentChange('p1', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }, 20));
    // Force eviction of p1 by exceeding the workspace budget with a second object.
    r.recordContentChange('p2', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }, 20));
    assert.equal(r.hasRing('p1'), false);
    const resolution = r.resolveCursor(cursor, SCOPE_A);
    assert.equal(resolution.ok, false);
    if (!resolution.ok) assert.equal(resolution.reason, 'unknown_cursor', 'evict() sweeps the cursor outright, so a repeat resolve reports unknown');
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

  test('a cursor resolves with a gapless replay of every event strictly after it', () => {
    const { r } = ring();
    const cursor1 = r.recordContentChange('p1', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }));
    r.recordContentChange('p1', SCOPE_A, { v: 2 }, contentEvent({ i: 2 }));
    r.recordContentChange('p1', SCOPE_A, { v: 3 }, contentEvent({ i: 3 }));
    const resolution = r.resolveCursor(cursor1, SCOPE_A);
    assert.equal(resolution.ok, true);
    if (resolution.ok) {
      assert.equal(resolution.replay.length, 2, 'events at revision 2 and 3, strictly after cursor1 (revision 1)');
      assert.deepEqual(resolution.replay.map((e) => e.revision), [2, 3]);
    }
  });

  test('a cursor minted at the current (latest) revision replays nothing', () => {
    const { r } = ring();
    r.recordContentChange('p1', SCOPE_A, { v: 1 }, contentEvent({ i: 1 }));
    const cursorLatest = r.recordObservedAtRefresh('p1', SCOPE_A);
    const resolution = r.resolveCursor(cursorLatest, SCOPE_A);
    assert.equal(resolution.ok, true);
    if (resolution.ok) assert.equal(resolution.replay.length, 0);
  });
});
