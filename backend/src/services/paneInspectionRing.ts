/** The discardable per-object observation cache ring, plus the server-side cursor store that
 *  later tasks (P3-2's feed, P3-5's wait_pane) page and resync against.
 *
 *  This module is a **self-contained data structure with an injected clock** — no HTTP, no DB, no
 *  event-bus subscription, no `Date.now()` inside. That is deliberate (design §8, brief P3-1): it
 *  makes every bound and every race exhaustively testable with a fake clock instead of real
 *  timers. Callers (P3-2's feed, P3-5's wait_pane) own actually watching ChatHub/AgentRun sources
 *  and calling `recordEvent`/`recordSnapshot` when something real happens.
 *
 *  Design: docs/pane-inspection-api-design-2026-09-14.md §8 (ring, cursor format, revision
 *  semantics), §11 (resource bounds). COMMON.md decision 8 (never invent success — not this
 *  module's concern directly, but the descriptors this ring stores must already respect it).
 *
 *  ## What this ring is, and is not
 *
 *  It is a bounded, per-object buffer of recent feed-shaped events plus the latest known
 *  descriptor, used to (a) replay events after a cursor and (b) decide whether "content" changed
 *  meaningfully enough to advance a revision. It is NOT a durable event log: eviction, aging out,
 *  or a backend restart all produce `resync_required` rather than data loss recovery — the caller
 *  is expected to rebuild the snapshot from the database and live domain sources (design §8:
 *  "它是可丢弃的观察缓存，不是第二套 durable event log").
 *
 *  ## Revision semantics
 *
 *  `revision` only advances on a MEANINGFULLY different snapshot. Three sampling-only mutations
 *  must NOT advance it (design §8, brief acceptance list):
 *   - `recordObservedAtRefresh` — a plain `inspect` re-touching `observedAt`;
 *   - `recordPresenceKeepalive` — a presence keepalive renewing `lastSeenAt`;
 *   - `recordHeartbeat` — a feed heartbeat proving only that the connection is alive.
 *  Everything else that changes the tracked "content snapshot" (view add/remove, a `visible`
 *  flip, a lease expiry, or any other caller-supplied content change) DOES advance it, via
 *  `recordContentChange`. See `ContentSnapshot` below for exactly what participates in the
 *  equivalence check, and this file's own report for which descriptor fields were excluded and
 *  why each is a sampling artefact.
 *
 *  ## Cursor format
 *
 *  A cursor is a random, unguessable, TTL'd token. It resolves server-side to locating
 *  information only — the object's paneId, the authorisation scope it was minted under, the
 *  process epoch, and the revision it was minted at. It is **never** an authorisation credential:
 *  resolving a cursor tells a caller "where you left off", not "you may see this" — the caller is
 *  authorised against the live object separately, every time, by whoever calls `resolveCursor`.
 *  An expired, unknown, forged, or wrong-scope cursor all resolve to the same `resync_required`
 *  outcome — never a different error that would let a caller distinguish "this token almost
 *  worked" from "this token is nonsense". */

import { randomUUID } from 'node:crypto';

import { PANE_INSPECTION_LIMITS } from 'michi-shared';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The authorisation scope a cursor (and the ring's subscriber refcount) is bound to. Mirrors
 *  `PaneInspectionCaller`'s identity fields, not the whole caller shape — this module never
 *  imports `paneInspection.ts` (P1-6 owns that file, and importing it would create a cycle since
 *  P1-6 does not depend on this ring). Two scopes are equal iff every field matches; a cursor
 *  minted under one scope never resolves under another, even for the same object. */
export interface AuthorizationScope {
  ownerUserId: string;
  workspaceId: string;
  /** Present when the caller is itself an agent run (COMMON.md decision 7) — a cursor minted for
   *  a plain UI caller must not resolve for a Run caller impersonating the same owner/workspace,
   *  and vice versa. */
  runOwnerId?: string | null;
}

function scopesEqual(a: AuthorizationScope, b: AuthorizationScope): boolean {
  return a.ownerUserId === b.ownerUserId && a.workspaceId === b.workspaceId && (a.runOwnerId ?? null) === (b.runOwnerId ?? null);
}

/** One feed-shaped event as stored in the ring. Intentionally a subset of `PaneFeedEventV1`'s
 *  fields — this module does not know how to serialise a full descriptor and does not need to:
 *  callers (P3-2) attach their own `PaneDescriptorV1`/`OutputPreview`/etc. payload; this module
 *  only needs `sizeBytes` (for the byte bound) and `kind` (for revision bookkeeping and replay
 *  filtering). `payload` travels opaquely. */
export interface RingEvent {
  /** Mirrors `PaneFeedEventV1['type']` minus `'snapshot'` (a snapshot is the ring's baseline,
   *  not a ring *event* — see `recordSnapshot`). */
  kind: 'changed' | 'output_changed' | 'execution_settled' | 'removed' | 'access_revoked';
  /** Caller-supplied payload, stored and replayed opaquely (e.g. a `changedSections` list plus
   *  descriptor, for P3-2 to serialise into a `PaneFeedEventV1`). Never inspected by this module. */
  payload: unknown;
  /** UTF-8 byte size of `payload` as the caller measured it, for the ring's byte bound. This
   *  module does not serialise `payload` itself (it is unknown to us) — the caller, which already
   *  built the JSON to size the descriptor against `descriptorMaxBytes`, is in the best position
   *  to report this once rather than have every ring re-derive it via JSON.stringify. */
  sizeBytes: number;
}

/** One entry as retained in the ring, with the bookkeeping this module adds. */
export interface RetainedEvent {
  event: RingEvent;
  /** The revision the ring was at immediately AFTER this event was recorded. Monotonically
   *  increasing across the object's whole ring, not reset by trimming. */
  revision: number;
  emittedAt: number;
  /** This entry's own cursor — resolving it replays every RETAINED entry strictly after it. */
  cursor: string;
}

/** The "content" half of what a caller observes — the part that participates in the
 *  meaningful-change comparison. Deliberately excludes every timestamp that a mere *read* or
 *  *keepalive* would refresh (see the module doc comment and this task's report for the full
 *  list) so that re-observing an unchanged object never advances revision. Structurally opaque to
 *  this module: callers pass whatever they consider "content" (e.g. view set membership,
 *  visibility flags, execution outcome) and this module only ever compares it by deep JSON
 *  equality — it does not know or care what the fields mean. */
export type ContentSnapshot = unknown;

function contentEquals(a: ContentSnapshot, b: ContentSnapshot): boolean {
  // Deep-equality via canonical JSON. Both snapshots are caller-controlled plain data (arrays of
  // view descriptors, a visible flag, an outcome enum) — never containing functions, Dates,
  // Maps, or other JSON-hostile types — so this is exact, not a heuristic. Property insertion
  // order differences would be a false "changed" here; callers must build snapshots with stable
  // key order (object literals in a fixed shape), which every caller of this module does today.
  return JSON.stringify(a) === JSON.stringify(b);
}

export type ResyncReason =
  | 'aged_out'
  | 'evicted'
  | 'not_replayable'
  | 'epoch_mismatch'
  | 'unknown_cursor';

export type CursorResolution =
  | { ok: true; paneId: string; revision: number; cursorRevision: number; replay: RetainedEvent[] }
  | { ok: false; reason: ResyncReason };

export interface RegisterOptions {
  now?: number;
}

// ---------------------------------------------------------------------------
// Internal per-object state
// ---------------------------------------------------------------------------

interface ObjectRing {
  paneId: string;
  scope: AuthorizationScope;
  /** Bumped by `recordContentChange`; read by `recordObservedAtRefresh` et al. to attach the
   *  correct (unchanged) revision to sampling-only ring entries — a heartbeat still gets a
   *  cursor a caller can hand back, it just doesn't move `revision`. */
  revision: number;
  /** The last ContentSnapshot passed to `recordContentChange`, or `undefined` before the first
   *  one. Used to detect whether the NEXT `recordContentChange` call is actually a change. */
  lastContent: ContentSnapshot | undefined;
  events: RetainedEvent[];
  /** Sum of `event.sizeBytes` over `events` — kept incrementally rather than re-summed every
   *  trim, since trimming happens on every record call. */
  bytes: number;
  createdAt: number;
  /** Bumped on every record call (event, snapshot, or sampling-only touch) — this is what LRU
   *  eviction orders by, deliberately independent of `revision` (a heartbeat should still count
   *  as "recently used" for eviction purposes even though it never advances content). */
  lastTouchedAt: number;
  /** Ref-count of active subscribers. >0 exempts this object from LRU eviction (design §8's
   *  central rule) regardless of `lastTouchedAt`. */
  subscriberCount: number;
}

interface StoredCursor {
  token: string;
  paneId: string;
  scope: AuthorizationScope;
  epoch: string;
  revision: number;
  mintedAt: number;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PaneInspectionRingOptions {
  /** Injected clock port — required by design, not merely a test convenience. Every timestamp
   *  this module produces or compares against comes from calling this, never `Date.now()`. */
  now: () => number;
  createToken?: () => string;
  /** Fixed for one backend process's lifetime; changes only across a restart. A cursor minted
   *  under one epoch never resolves under another (see "process epoch" in the module doc and
   *  this task's report). Defaults to a fresh random id per `PaneInspectionRing` instance, which
   *  is exactly "one per process" as long as the instance itself is a module-scope singleton —
   *  the same contract `PanePresenceRegistry` relies on. */
  epoch?: string;
  cursorTtlMs?: number;
  ringMaxAgeMs?: number;
  ringMaxEvents?: number;
  ringMaxBytes?: number;
  workspaceRingBudgetBytes?: number;
}

/** The bounded per-object observation cache ring and its cursor store. One instance is intended
 *  to be a module-scope singleton per backend process (mirrors `PanePresenceRegistry`'s own
 *  contract) — P1-8/P3-2 wiring constructs it once and imports it from routes, the feed, and
 *  wait_pane. */
export class PaneInspectionRing {
  private readonly now: () => number;
  private readonly createToken: () => string;
  /** NOT `readonly` — see `resetEpoch()`. In production this is set once at construction and
   *  never touched again (a real restart constructs a brand-new process, and therefore a
   *  brand-new instance, rather than calling a method on the old one). The setter exists solely
   *  so tests can exercise the epoch-mismatch branch without spinning up a second process. */
  private epoch: string;
  private readonly cursorTtlMs: number;
  private readonly ringMaxAgeMs: number;
  private readonly ringMaxEvents: number;
  private readonly ringMaxBytes: number;
  private readonly workspaceRingBudgetBytes: number;

  private readonly objects = new Map<string, ObjectRing>();
  private readonly cursors = new Map<string, StoredCursor>();
  /** paneId -> workspaceId, so workspace-budget eviction can find every ring in a workspace
   *  without scanning all objects across every workspace on the process. Kept in lockstep with
   *  `objects` (same insert/delete calls). */
  private readonly workspaceIndex = new Map<string, Set<string>>();

  constructor(opts: PaneInspectionRingOptions) {
    this.now = opts.now;
    this.createToken = opts.createToken ?? (() => randomUUID());
    this.epoch = opts.epoch ?? randomUUID();
    this.cursorTtlMs = opts.cursorTtlMs ?? PANE_INSPECTION_LIMITS.ringRetentionSeconds * 1_000;
    this.ringMaxAgeMs = opts.ringMaxAgeMs ?? PANE_INSPECTION_LIMITS.ringRetentionSeconds * 1_000;
    this.ringMaxEvents = opts.ringMaxEvents ?? PANE_INSPECTION_LIMITS.ringMaxEvents;
    this.ringMaxBytes = opts.ringMaxBytes ?? PANE_INSPECTION_LIMITS.ringMaxBytes;
    this.workspaceRingBudgetBytes = opts.workspaceRingBudgetBytes ?? PANE_INSPECTION_LIMITS.workspaceRingBudgetBytes;
  }

  /** Exposed for tests and diagnostics: the current epoch this instance is tagging new cursors
   *  with. */
  getEpoch(): string {
    return this.epoch;
  }

  /** Test-only: simulates "the backend process restarted" WITHOUT constructing a new instance —
   *  a real restart never calls this; it just builds a fresh `PaneInspectionRing` with a fresh
   *  random epoch, at which point every previously-minted cursor is `unknown_cursor` to the new
   *  instance simply because it never existed in the new instance's `cursors` map. This method
   *  exists purely so a test can exercise the OTHER path to the same outcome: a cursor this
   *  instance still has on file, but tagged with an epoch that no longer matches — this is the
   *  literal `epoch_mismatch` branch in `resolveCursor`, which is otherwise unreachable from
   *  outside this class in a real deployment (there, a restart always means a new `cursors` map
   *  too, so `unknown_cursor` is what actually gets returned; `epoch_mismatch` only exists as a
   *  defensive/diagnostic label for a cursor bookkeeping bug that leaks state across a would-be
   *  restart boundary, which this method is the only way to provoke on purpose). Rings and their
   *  content are untouched — only the epoch tag changes. */
  resetEpoch(newEpoch?: string): void {
    this.epoch = newEpoch ?? randomUUID();
  }

  // -------------------------------------------------------------------------
  // Object lifecycle
  // -------------------------------------------------------------------------

  private getOrCreate(paneId: string, scope: AuthorizationScope): ObjectRing {
    let ring = this.objects.get(paneId);
    if (ring) return ring;
    const now = this.now();
    ring = {
      paneId,
      scope,
      revision: 0,
      lastContent: undefined,
      events: [],
      bytes: 0,
      createdAt: now,
      lastTouchedAt: now,
      subscriberCount: 0,
    };
    this.objects.set(paneId, ring);
    let bucket = this.workspaceIndex.get(scope.workspaceId);
    if (!bucket) {
      bucket = new Set();
      this.workspaceIndex.set(scope.workspaceId, bucket);
    }
    bucket.add(paneId);
    return ring;
  }

  private removeObject(paneId: string): void {
    const ring = this.objects.get(paneId);
    if (!ring) return;
    this.objects.delete(paneId);
    this.workspaceIndex.get(ring.scope.workspaceId)?.delete(paneId);
    // Every outstanding cursor pointing into a removed ring must resync — it can no longer be
    // replayed against anything. Cheap here since cursors are already scoped per-paneId in a
    // separate index-free map; a full scan is bounded by the small number of live cursors per
    // process (bounded by concurrentWaitsPerOwnerMax * live owners, not by ring size).
    for (const [token, cursor] of this.cursors) {
      if (cursor.paneId === paneId) this.cursors.delete(token);
    }
  }

  /** Registers an active subscriber for `paneId`, exempting its ring from LRU eviction while at
   *  least one subscriber is registered. Safe to call before any event has been recorded for this
   *  object — creates an empty ring if needed, so P3-2's feed can register before its first
   *  snapshot. Returns nothing; pair every call with exactly one `releaseSubscriber` (ref-counted
   *  — see `releaseSubscriber`'s doc for the double-subscribe case). */
  registerSubscriber(paneId: string, scope: AuthorizationScope): void {
    const ring = this.getOrCreate(paneId, scope);
    ring.subscriberCount += 1;
    ring.lastTouchedAt = this.now();
  }

  /** Releases one subscriber registration. The object re-enters the LRU eviction candidate pool
   *  only once its count reaches zero (design §8) — releasing when already at zero, or releasing
   *  an unknown paneId, is a no-op rather than an error, since a feed disconnect racing an
   *  eviction sweep must never throw. Calling `registerSubscriber` twice for the "same" logical
   *  subscriber (e.g. two browser tabs watching the same pane) and releasing once correctly leaves
   *  it exempt — the ref-count, not identity, decides eviction exemption; deduping logical
   *  subscribers is the caller's own concern (P3-2), not this store's. */
  releaseSubscriber(paneId: string): void {
    const ring = this.objects.get(paneId);
    if (!ring || ring.subscriberCount === 0) return;
    ring.subscriberCount -= 1;
  }

  /** True while at least one subscriber is registered — exposed for tests and for P3-2 to decide
   *  whether it is the object's last subscriber before tearing down a domain listener. */
  hasActiveSubscriber(paneId: string): boolean {
    return (this.objects.get(paneId)?.subscriberCount ?? 0) > 0;
  }

  // -------------------------------------------------------------------------
  // Recording — content changes (advance revision) vs. sampling-only touches (never do)
  // -------------------------------------------------------------------------

  /** Records a genuine content change: a view added/removed, a `visible` flip, a lease expiry, or
   *  any other caller-classified meaningful mutation. Compares `content` against the last
   *  recorded content by deep equality — if unchanged, this call degrades to a no-op that neither
   *  advances `revision` nor appends `event` to the ring (a caller that mistakenly calls this for
   *  something that turned out identical gets exactly the sampling-only behaviour it should have
   *  used `recordObservedAtRefresh`/etc. for instead; the safety net is here, not just in the
   *  caller's classification). Returns the resulting cursor either way, so P3-2 can always attach
   *  one to the outgoing feed event. */
  recordContentChange(paneId: string, scope: AuthorizationScope, content: ContentSnapshot, event: RingEvent): string {
    const ring = this.getOrCreate(paneId, scope);
    const now = this.now();
    ring.lastTouchedAt = now;

    const changed = ring.lastContent === undefined || !contentEquals(ring.lastContent, content);
    ring.lastContent = content;
    if (!changed) {
      const cursor = this.mintCursorForRing(ring, now, scope);
      this.enforceWorkspaceBudget(ring.scope.workspaceId, now);
      return cursor;
    }

    ring.revision += 1;
    const cursor = this.mintCursorForRing(ring, now, scope);
    this.appendEvent(ring, event, cursor, now);
    // Budget enforcement runs LAST, after this call's own byte growth (both the new ring event
    // and the fresh cursor's bookkeeping) has already landed — enforcing it any earlier would
    // check totals that don't yet include what this very call just added, letting a single large
    // write slip in under a budget it should have triggered eviction for.
    this.enforceWorkspaceBudget(ring.scope.workspaceId, now);
    return cursor;
  }

  /** Records the object's baseline compact snapshot (design §8: "先读取来源快照... 再发布第一份
   *  inspection snapshot"). Establishes `lastContent` without appending a ring EVENT — a snapshot
   *  is the replay baseline itself, not something replayed on top of a baseline, matching
   *  `RingEvent['kind']`'s exclusion of `'snapshot'`. Safe to call multiple times (e.g.
   *  re-establishing after a resync); each call resets `lastContent` to the new value without
   *  forcing a revision bump purely for being called again — only an actual content difference
   *  from the PREVIOUS `lastContent` bumps revision, exactly like `recordContentChange`. Returns a
   *  cursor for the snapshot itself. */
  recordSnapshot(paneId: string, scope: AuthorizationScope, content: ContentSnapshot, event?: RingEvent): string {
    const ring = this.getOrCreate(paneId, scope);
    const now = this.now();
    ring.lastTouchedAt = now;
    // The very first snapshot for an object establishes the baseline — it is not itself a
    // "change" (there is nothing to have changed FROM yet), so it never bumps revision even
    // though `lastContent` moves from undefined to a real value. Only a snapshot that differs
    // from a PREVIOUSLY established baseline (e.g. re-establishing after a resync found new
    // content) advances revision — mirroring recordContentChange's own equality contract.
    const isFirstSnapshot = ring.lastContent === undefined;
    const changed = !isFirstSnapshot && !contentEquals(ring.lastContent, content);
    ring.lastContent = content;
    if (changed) ring.revision += 1;
    const cursor = this.mintCursorForRing(ring, now, scope);
    if (changed && event) this.appendEvent(ring, event, cursor, now);
    // Changed snapshots retain their supplied event so inspect cannot create a replay gap.
    // Enforce the budget after both the snapshot and cursor have been recorded.
    this.enforceWorkspaceBudget(ring.scope.workspaceId, now);
    return cursor;
  }

  /**
   * P3-3's minting entry point: the `inspect` boundary's public name for establishing/refreshing
   * this object's baseline and getting back a cursor that `resolveCursor` can later recognise.
   *
   * This is a documented alias for `recordSnapshot` — NOT new mechanism. `inspect_pane`'s job at
   * the snapshot→subscribe boundary (design §8) is exactly "read the aligned snapshot, then
   * publish/mint" — the same baseline-establishing contract `recordSnapshot` already has for
   * `subscribePanes`'s own initial snapshot. Reusing it (rather than adding a parallel method) is
   * what makes the acceptance criterion "inspect returns a cursor that resolveCursor resolves"
   * true for free: both callers register the same object under the same paneId/scope in the same
   * ring, so a cursor either one mints resolves identically for the other. It also gets
   * `recordSnapshot`'s revision contract at no extra cost — repeated calls with unchanged content
   * never advance `revision`, so polling `inspect` in a loop cannot wake a `wait_pane(until=changed)`
   * waiter (brief acceptance item).
   */
  mintInspectionCursor(paneId: string, scope: AuthorizationScope, content: ContentSnapshot, event?: RingEvent): string {
    return this.recordSnapshot(paneId, scope, content, event);
  }

  /** A plain `inspect` re-touching `observedAt` on an otherwise-unchanged object. Never advances
   *  revision, never appends a ring event, never even needs `content` — this call exists purely
   *  so `lastTouchedAt` (the LRU order) reflects that the object was just read, and so a caller
   *  that wants a cursor to hand back after a read-only inspect can get one without going through
   *  the content-change path. */
  recordObservedAtRefresh(paneId: string, scope: AuthorizationScope): string {
    const ring = this.getOrCreate(paneId, scope);
    const now = this.now();
    ring.lastTouchedAt = now;
    return this.mintCursorForRing(ring, now, scope);
  }

  /** A presence keepalive renewing `lastSeenAt` for a view of this object. Same non-advancing
   *  contract as `recordObservedAtRefresh` — kept as a separate method (rather than one shared
   *  "touch" method) because design §8 enumerates these as three DISTINCT sampling cases and a
   *  future revision-affecting refinement to one must not silently apply to the others. */
  recordPresenceKeepalive(paneId: string, scope: AuthorizationScope): void {
    const ring = this.objects.get(paneId);
    if (!ring) return; // Nothing to touch yet — a keepalive for a pane with no ring is a no-op.
    ring.lastTouchedAt = this.now();
  }

  /** A feed heartbeat proving only that the connection is alive, "not that runtime made progress"
   *  (design §8). Never advances revision. Appends a lightweight ring event of its own accord is
   *  deliberately NOT done here — a heartbeat is not something a resubscribing caller needs
   *  replayed; it is transport liveness, not object content. Still updates `lastTouchedAt` so a
   *  heartbeat also counts as "recently used" for LRU purposes, matching `recordObservedAtRefresh`. */
  recordHeartbeat(paneId: string): void {
    const ring = this.objects.get(paneId);
    if (!ring) return;
    ring.lastTouchedAt = this.now();
  }

  // -------------------------------------------------------------------------
  // Per-object trimming (age / count / bytes, whichever hits first)
  // -------------------------------------------------------------------------

  private appendEvent(ring: ObjectRing, event: RingEvent, cursor: string, now: number): void {
    event = this.withCursor(event, cursor);
    ring.events.push({ event, revision: ring.revision, emittedAt: now, cursor });
    ring.bytes += event.sizeBytes;
    this.trimRing(ring, now);
  }

  private withCursor(event: RingEvent, cursor: string): RingEvent {
    if (!event.payload || typeof event.payload !== 'object') return event;
    const payload = { ...event.payload } as Record<string, unknown>;
    if ('cursor' in payload) payload.cursor = cursor;
    const descriptor = payload.descriptor as { observation?: object } | undefined;
    if (descriptor?.observation) payload.descriptor = { ...descriptor, observation: { ...descriptor.observation, cursor } };
    return { ...event, payload };
  }

  /** Trims the FRONT of the ring (oldest first) until all three per-object bounds are satisfied —
   *  age, count, and bytes are independent bounds, "whichever hits first" per §8/§11, so each is
   *  checked and enforced on every call rather than picking just the tightest one up front (their
   *  relative tightness can change over the ring's lifetime as events of different sizes arrive). */
  private trimRing(ring: ObjectRing, now: number): void {
    while (ring.events.length > 0) {
      const oldest = ring.events[0];
      const tooOld = now - oldest.emittedAt > this.ringMaxAgeMs;
      const tooMany = ring.events.length > this.ringMaxEvents;
      const tooBig = ring.bytes > this.ringMaxBytes;
      if (!tooOld && !tooMany && !tooBig) break;
      ring.events.shift();
      ring.bytes -= oldest.event.sizeBytes;
    }
  }

  // -------------------------------------------------------------------------
  // Workspace budget + LRU eviction
  // -------------------------------------------------------------------------

  /** Enforces the per-workspace byte budget by evicting least-recently-used objects — skipping
   *  any object with `subscriberCount > 0` (design §8's central rule) regardless of how stale its
   *  `lastTouchedAt` is. If every object in the workspace is subscribed, the budget is
   *  intentionally exceeded rather than evicting a watched object; §8 accepts this as the cost of
   *  the exemption (the budget is "首版可配置默认值", not a hard safety ceiling — design §11's
   *  closing note). Called after every record that can grow a ring's byte footprint. */
  private enforceWorkspaceBudget(workspaceId: string, now: number): void {
    const paneIds = this.workspaceIndex.get(workspaceId);
    if (!paneIds) return;

    const totalBytes = (): number => {
      let sum = 0;
      for (const id of paneIds) sum += this.objects.get(id)?.bytes ?? 0;
      return sum;
    };

    while (totalBytes() > this.workspaceRingBudgetBytes) {
      let victim: ObjectRing | undefined;
      for (const id of paneIds) {
        const ring = this.objects.get(id);
        if (!ring || ring.subscriberCount > 0) continue;
        if (!victim || ring.lastTouchedAt < victim.lastTouchedAt) victim = ring;
      }
      if (!victim) break; // Every remaining object is subscribed — exceed the budget, don't evict.
      this.evict(victim.paneId, now);
    }
  }

  /** Evicts one object's ring entirely: drops its events, its content baseline, and invalidates
   *  every cursor that pointed into it (each such cursor now resolves `resync_required`, per
   *  acceptance: "evicting a ring yields resync_required for a cursor that pointed into it").
   *  Subscriber count is NOT reset by eviction — a caller could evict a ring for an object that
   *  currently has zero subscribers (the only case eviction ever targets) and then immediately
   *  register a new one; that new registration starts a fresh ring via `getOrCreate`, which is
   *  the correct "resync and rebuild" story, not a leaked stale count. */
  private evict(paneId: string, now: number): void {
    void now;
    this.removeObject(paneId);
  }

  /** Public entry point for a caller (P3-2, or a periodic sweep) to trigger workspace-budget
   *  enforcement explicitly, e.g. after recording a batch of events for several objects in one
   *  workspace without re-running the check after every single one. `recordContentChange` and
   *  `recordSnapshot` already call this internally after growing a ring, so most callers never
   *  need to call it directly. */
  enforceWorkspaceBudgetFor(workspaceId: string): void {
    this.enforceWorkspaceBudget(workspaceId, this.now());
  }

  // -------------------------------------------------------------------------
  // Cursors
  // -------------------------------------------------------------------------

  /** Mints a cursor for `ring` at its CURRENT revision. Deliberately does not itself trigger
   *  workspace-budget enforcement — a caller that is about to grow the ring's byte footprint
   *  (`recordContentChange`'s changed branch) must mint first, append second, and enforce the
   *  budget LAST, once the call's own growth has actually landed; enforcing here would run against
   *  byte totals that don't yet include what the caller is about to add. Every call site is
   *  responsible for calling `enforceWorkspaceBudget` itself once it is done growing anything. */
  private mintCursorForRing(ring: ObjectRing, now: number, scope: AuthorizationScope = ring.scope): string {
    // TTL cleanup must run even when clients never resolve their old tokens. The hard cap
    // bounds a burst of inspect calls within one retention window as well.
    for (const [token, stored] of this.cursors) {
      if (stored.expiresAt < now) this.cursors.delete(token);
      else break;
    }
    while (this.cursors.size >= 10_000) this.cursors.delete(this.cursors.keys().next().value!);
    const token = this.createToken();
    this.cursors.set(token, {
      token,
      paneId: ring.paneId,
      scope,
      epoch: this.epoch,
      revision: ring.revision,
      mintedAt: now,
      expiresAt: now + this.cursorTtlMs,
    });
    return token;
  }

  /** Resolves a cursor token to its locating information and the events to replay after it.
   *  Never grants access on its own — the caller (P3-2/P3-5) must still separately authorise
   *  `scope` against the live object before acting on this result; this method only tells the
   *  caller WHERE the requester left off, matching the module doc's "locating information, not an
   *  authorisation credential" contract.
   *
   *  Every failure mode collapses to `{ ok: false, reason }` with no signal that would let a
   *  caller distinguish "almost valid" from "complete nonsense" beyond the coarse `reason` label
   *  (itself only for logging/metrics, never surfaced to a remote caller as anything but a
   *  generic `resync_required`). */
  resolveCursor(token: string, requesterScope: AuthorizationScope): CursorResolution {
    const now = this.now();
    const stored = this.cursors.get(token);
    if (!stored) return { ok: false, reason: 'unknown_cursor' };

    if (stored.epoch !== this.epoch) {
      // A restart changed the epoch — invalidate lazily on first use rather than eagerly sweeping
      // every stored cursor at boot (there are none yet at boot; this branch fires for a cursor
      // minted by a PREVIOUS process instance if one were ever persisted across restarts, which
      // this module never does — kept as a defensive check matching the module's own contract).
      this.cursors.delete(token);
      return { ok: false, reason: 'epoch_mismatch' };
    }

    if (now > stored.expiresAt) {
      this.cursors.delete(token);
      return { ok: false, reason: 'aged_out' };
    }

    if (!scopesEqual(stored.scope, requesterScope)) {
      // A cursor minted for one authorisation scope must not resolve for another — do not even
      // reveal that the token is otherwise well-formed, or that the paneId behind it exists.
      return { ok: false, reason: 'unknown_cursor' };
    }

    const ring = this.objects.get(stored.paneId);
    if (!ring) {
      // The ring was evicted (or never existed under this paneId any more) — the cursor itself
      // stays in `this.cursors` only if `removeObject` didn't already sweep it; `removeObject`
      // always sweeps every cursor for a removed paneId, so reaching here without a ring means
      // this exact case was already handled and `unknown_cursor` is what a repeat resolve sees.
      return { ok: false, reason: 'evicted' };
    }

    if (stored.revision > ring.revision) {
      // Cannot happen in practice (a cursor's revision is always <= the ring's revision at mint
      // time, and revision only increases) — defensive guard against a future bug that mints a
      // cursor before bumping revision, rather than silently replaying garbage.
      return { ok: false, reason: 'not_replayable' };
    }

    this.trimRing(ring, now);
    const replay = ring.events.filter((entry) => entry.revision > stored.revision);
    // If the ring has been trimmed past the point this cursor was minted at (its own baseline
    // event, if any, aged/counted/byte-evicted out from under it) there is no way to prove the
    // replay is gapless — the oldest RETAINED event's revision must be <= stored.revision + 1 for
    // a contiguous replay; a gap means some events between the cursor and the oldest retained one
    // are gone forever.
    const oldestRetainedRevision = ring.events.length > 0 ? ring.events[0].revision : ring.revision;
    if (ring.events.length > 0 && oldestRetainedRevision > stored.revision + 1 && stored.revision < ring.revision) {
      return { ok: false, reason: 'not_replayable' };
    }
    if (stored.revision < ring.revision && (replay.length !== ring.revision - stored.revision)) {
      return { ok: false, reason: 'not_replayable' };
    }

    // Content is shared, but cursors remain caller-scoped even when another subscriber
    // published the retained event. Authorization must still precede replay at the feed.
    const scopedReplay = replay.map((entry) => {
      const existing = this.cursors.get(entry.cursor);
      if (existing && scopesEqual(existing.scope, requesterScope)) return entry;
      const cursor = this.mintCursorForRing(ring, now, requesterScope);
      this.cursors.get(cursor)!.revision = entry.revision;
      return { ...entry, cursor, event: this.withCursor(entry.event, cursor) };
    });
    return { ok: true, paneId: stored.paneId, revision: ring.revision, cursorRevision: stored.revision, replay: scopedReplay };
  }

  // -------------------------------------------------------------------------
  // Test / diagnostic helpers — not part of the API P3-2/P3-5 consume
  // -------------------------------------------------------------------------

  /** Current revision for an object, or `null` if no ring exists yet. Exposed for tests. */
  getRevision(paneId: string): number | null {
    return this.objects.get(paneId)?.revision ?? null;
  }

  /** Whether an object's ring currently exists at all (vs. never created or evicted). Exposed for
   *  tests. */
  hasRing(paneId: string): boolean {
    return this.objects.has(paneId);
  }

  /** Current retained-event count for an object's ring. Exposed for tests. */
  getEventCount(paneId: string): number {
    return this.objects.get(paneId)?.events.length ?? 0;
  }

  /** Current retained-bytes total for an object's ring. Exposed for tests. */
  getRingBytes(paneId: string): number {
    return this.objects.get(paneId)?.bytes ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

/** One instance per backend process (mirrors `panePresenceRegistry`'s own contract — see that
 *  module's doc comment on why two independently-constructed instances is a real bug class, not
 *  a style nit: a cursor minted against one instance's `objects`/`cursors` maps is invisible to
 *  another). `paneInspection.ts` (P3-3, the `inspect` boundary) and `paneInspectionSubscribe.ts`
 *  via `routes/paneInspection.ts` (P3-2, the feed) MUST share this exact instance — that sharing
 *  is what makes the acceptance criterion "a cursor minted by inspect resolves through this
 *  ring" true at all. `routes/paneInspection.ts` previously constructed its OWN
 *  `new PaneInspectionRing(...)` (added alongside the P3-2 feed route) — the exact same
 *  double-instance bug this campaign already hit once for `panePresenceRegistry` (see that
 *  module's own doc comment). Fixed as part of this task: that file now imports and re-exports
 *  this singleton instead. Real `Date.now()` clock in production; tests construct their own
 *  `new PaneInspectionRing({ now: fakeClock.now })` instead of importing this singleton, exactly
 *  like `paneInspectionSubscribe.test.ts` already does. */
export const paneInspectionRing = new PaneInspectionRing({ now: () => Date.now() });
