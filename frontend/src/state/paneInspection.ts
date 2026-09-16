/**
 * Pane Inspection API — shared, ref-counted external store over `subscribePanes` (design §8;
 * brief P3-6).
 *
 * This module is the single place in the renderer that opens a `subscribePanes` connection. It
 * exists so that N components independently interested in the same `{apiBase, paneIds}` set
 * (design §8's "两个窗口同时订阅同一对象不重复创建逻辑 pane" acceptance criterion, and the
 * general React rule that a component's own mount/unmount should not be what decides whether a
 * network connection opens) share exactly one underlying feed, reference-counted: the feed opens
 * on the first `attachPaneInspectionStore` call for a given key and closes when the matching
 * `detach()` brings that key's subscriber count back to zero.
 *
 * IMPORTANT SCOPE NOTE (per the brief): a real second BrowserWindow (Electron) is a SEPARATE JS
 * runtime with its own module registry — this store's ref-count map is an in-memory `Map` at
 * module scope, so it dedups only WITHIN one renderer process. Two windows each subscribing to
 * the same paneId will each open their own physical `subscribePanes` connection; this module does
 * not claim otherwise, and does not attempt any cross-window (e.g. `BroadcastChannel`, shared
 * worker) dedup — that is out of scope for this task.
 *
 * `useSyncExternalStore` compatibility: `attach()` returns a handle whose `subscribe` and
 * `getSnapshot` methods have exactly the signatures `useSyncExternalStore` expects
 * (`subscribe(onStoreChange): () => void`, `getSnapshot(): Snapshot`) — a consumer hook can pass
 * them straight through:
 *
 * ```ts
 * const handle = useMemo(
 *   () => attachPaneInspectionStore({ scopeKey: workspaceId, apiBase, paneIds }),
 *   [workspaceId, apiBase, paneIdsKey],
 * );
 * useEffect(() => handle.detach, [handle]);
 * const snapshot = useSyncExternalStore(handle.subscribe, handle.getSnapshot);
 * ```
 *
 * This module intentionally has no React import — the hook wiring above is documentation, not
 * exported code, so this file stays testable with plain function calls (brief: "focused tests
 * adjacent to those files", not a DOM/component test).
 */

import type {
  ExecutionStatus,
  PaneActivity,
  PaneDescriptorV1,
  PaneFeedEventV1,
} from 'michi-shared';
import { subscribePanes, type PaneInspectionClientError } from '../services/api/paneInspection';

// ---------------------------------------------------------------------------
// Public state shape
// ---------------------------------------------------------------------------

/** Per-paneId lifecycle state, independent of any single feed connection's own transport state.
 *  `loading`: subscribed, no event received yet (covers cold-start and the moment right after a
 *  ring/epoch resubscribe before the replacement snapshot lands). `ready`: descriptor is current.
 *  `resync_required`/`removed`/`access_revoked` mirror the feed event types 1:1 (design §8) —
 *  deliberately NOT collapsed into a single generic "stale" bucket, so a consumer can tell "the
 *  cursor rotted, resubscribe" apart from "this object is gone" apart from "you lost access". */
export type PaneInspectionEntryStatus = 'loading' | 'ready' | 'resync_required' | 'removed' | 'access_revoked';

export interface PaneInspectionEntry {
  status: PaneInspectionEntryStatus;
  /** Present only when `status === 'ready'`. Cleared (not stale-cached) on any of the other four
   *  statuses — design COMMON.md decision 8 ("Never invent success"): a consumer must not read a
   *  `removed` pane's last-known descriptor and mistake it for a live one. */
  descriptor: PaneDescriptorV1 | null;
  /** Latest opaque observation cursor for this pane, present even while `status !== 'ready'` so a
   *  future resubscribe (out of scope for this store, but the field must exist for that caller)
   *  has something to hand `subscribePanes` again. Null before the first event arrives. */
  cursor: string | null;
  /** Authoritative execution status for this pane, independent of whether a `PaneDescriptorV1`
   *  happens to be present. Derived from `snapshot`/`changed`'s `descriptor.execution` Section
   *  (COMMON.md decision 8: a `ready` Section whose `value` is `null` means "known to have no
   *  execution" and is recorded as `null` here, not `'unknown'`), AND kept current from
   *  `execution_settled.outcome` even when that event carries no descriptor at all — an
   *  `execution_settled` frame is itself an authoritative statement of outcome (design §8) and
   *  must not be discarded just because this store's `descriptor` field stays stale. `'unknown'`
   *  means no execution information has been observed for this pane yet (no descriptor, no
   *  settled event). */
  executionStatus: ExecutionStatus | 'unknown' | null;
}

export interface PaneInspectionStoreSnapshot {
  /** Every paneId this feed was opened for, keyed exactly as the caller passed them to
   *  `attachPaneInspectionStore` — never re-sorted, so `panes[paneId]` round-trips the caller's
   *  own ids. Absent key = no event received for that paneId yet (equivalent to `loading`, but
   *  distinguishable: a caller can tell "we never even initialized this entry" apart from "we
   *  initialized it and it is still loading" if that distinction ever matters upstream). */
  panes: Record<string, PaneInspectionEntry>;
  /** Set when the underlying `subscribePanes` connection itself failed (HTTP/transport/protocol
   *  — see `PaneInspectionClientError`). This is feed-level, not per-pane: design §8 does not
   *  specify per-pane transport failures, only per-pane content events, so one connection error
   *  applies to every paneId on this feed. Cleared on the next successful event delivery. */
  error: { code: PaneInspectionClientError['code']; message: string } | null;
}

export interface PaneInspectionStoreHandle {
  /** Matches `useSyncExternalStore`'s `subscribe` parameter exactly. Returns an unsubscribe
   *  function; the callback fires only on a semantic change (never on a heartbeat — design §8:
   *  "单纯...feed heartbeat，不触发 changed"). */
  subscribe(onStoreChange: () => void): () => void;
  /** Matches `useSyncExternalStore`'s `getSnapshot` parameter exactly. Returns the SAME object
   *  reference across calls when nothing changed since the last call — required for
   *  `useSyncExternalStore` to avoid an infinite render loop, and independently required by this
   *  task's brief ("stable getSnapshot identity when no semantic change"). */
  getSnapshot(): PaneInspectionStoreSnapshot;
  /** Detaches this subscriber from the shared feed. Idempotent — safe to call more than once.
   *  When this is the LAST attached subscriber for this feed's key, the underlying
   *  `subscribePanes` connection is closed. */
  detach(): void;
}

// ---------------------------------------------------------------------------
// Structural selectors — design §8 / brief: "structural selectors must not read or copy output
// token text". Each selector below reads only a scalar/small-enum field, never `latestOutput`
// (which is the one Section<T> that can carry token text) and never returns an object that
// embeds it. A consumer that actually wants the answer body calls `readPaneOutput` (P1-10)
// directly — this store's snapshot exists for STRUCTURE (status/activity/title/cursor), not
// content, exactly like design §8's own event taxonomy separates `changed` from
// `output_changed`.
// ---------------------------------------------------------------------------

/** `'unknown'` for a paneId with no entry yet or a non-ready entry — mirrors `PaneActivity`'s own
 *  `'unknown'` member rather than inventing a second sentinel, per COMMON.md decision 8. */
export function selectPaneStatus(snapshot: PaneInspectionStoreSnapshot, paneId: string): PaneInspectionEntryStatus | 'unknown' {
  return snapshot.panes[paneId]?.status ?? 'unknown';
}

export function selectPaneActivity(snapshot: PaneInspectionStoreSnapshot, paneId: string): PaneActivity | 'unknown' {
  return snapshot.panes[paneId]?.descriptor?.activity ?? 'unknown';
}

export function selectPaneTitle(snapshot: PaneInspectionStoreSnapshot, paneId: string): string | null {
  return snapshot.panes[paneId]?.descriptor?.title ?? null;
}

export function selectPaneCursor(snapshot: PaneInspectionStoreSnapshot, paneId: string): string | null {
  return snapshot.panes[paneId]?.cursor ?? null;
}

/** The authoritative execution status recorded on this pane's entry — see
 *  {@link PaneInspectionEntry.executionStatus}'s doc comment for how it is derived and kept
 *  current independent of `descriptor`. Returns `'unknown'` for a paneId with no entry at all. */
export function selectPaneExecutionStatus(snapshot: PaneInspectionStoreSnapshot, paneId: string): ExecutionStatus | 'unknown' | null {
  const entry = snapshot.panes[paneId];
  // `entry` absent entirely (no event ever received for this paneId) is 'unknown'. `null` is a
  // real, distinct value once an entry exists (COMMON.md decision 8: a `ready` Section whose
  // `value` is `null` is known-absent, not the same as "we don't know") — `?? 'unknown'` here
  // would incorrectly collapse that legitimate `null` back into `'unknown'`.
  return entry ? entry.executionStatus : 'unknown';
}

export function selectFeedError(snapshot: PaneInspectionStoreSnapshot): PaneInspectionStoreSnapshot['error'] {
  return snapshot.error;
}

// ---------------------------------------------------------------------------
// Internal feed record — one per distinct {apiBase, paneIds} key, ref-counted.
// ---------------------------------------------------------------------------

interface FeedRecord {
  refCount: number;
  unsubscribeTransport: () => void;
  listeners: Set<() => void>;
  snapshot: PaneInspectionStoreSnapshot;
}

const feeds = new Map<string, FeedRecord>();

/** Order-independent in `paneIds`: `attachPaneInspectionStore({ scopeKey, apiBase, paneIds:
 *  ['a','b'] })` and the same call with `['b','a']` MUST resolve to the same feed (brief:
 *  "duplicate components subscribing to same pane set must not create duplicate logical feed" —
 *  a caller building its paneIds array from, say, object iteration order should not accidentally
 *  defeat dedup). Sorting is stable and only affects this internal key, never the array order the
 *  caller gets back in the snapshot or hands to `subscribePanes` on the wire.
 *
 *  `scopeKey` is REQUIRED (no default) and participates in the key alongside `apiBase`: two
 *  callers that happen to share an `apiBase` (e.g. two workspaces on the same backend connection,
 *  or a test double that reuses one base URL across cases) must not be folded into the same feed
 *  just because their `paneIds` also collide — `apiBase` alone identifies a backend connection,
 *  not a workspace/tenant boundary, so a caller must pass its own explicit scope (typically
 *  `workspaceId`) rather than relying on this module to guess one. */
function feedKey(scopeKey: string, apiBase: string, paneIds: readonly string[]): string {
  return `${scopeKey}\u0000${apiBase}\u0000${[...paneIds].sort().join('\u0000')}`;
}

const EMPTY_SNAPSHOT: PaneInspectionStoreSnapshot = { panes: {}, error: null };

function initialSnapshot(paneIds: readonly string[]): PaneInspectionStoreSnapshot {
  if (paneIds.length === 0) return EMPTY_SNAPSHOT;
  const panes: Record<string, PaneInspectionEntry> = {};
  for (const id of paneIds) panes[id] = { status: 'loading', descriptor: null, cursor: null, executionStatus: 'unknown' };
  return { panes, error: null };
}

function notify(feed: FeedRecord): void {
  for (const listener of feed.listeners) listener();
}

/** Derives {@link PaneInspectionEntry.executionStatus} from a descriptor's `execution` Section
 *  (COMMON.md decision 8: `ready` + `value: null` is a known-absent execution, recorded as
 *  `null`, never collapsed into `'unknown'`). */
function executionStatusFromDescriptor(descriptor: PaneDescriptorV1): ExecutionStatus | 'unknown' | null {
  if (descriptor.execution.status !== 'ready') return 'unknown';
  return descriptor.execution.value?.status ?? null;
}

/** Carries forward `previous.executionStatus` when a `previous` entry exists at all — a
 *  legitimate `null` (known-absent execution, COMMON.md decision 8) must be preserved as `null`,
 *  not collapsed into `'unknown'` by `?? 'unknown'` (which only distinguishes `null`/`undefined`
 *  from everything else, not "no entry" from "entry exists with executionStatus: null"). Only a
 *  genuinely absent `previous` (no entry has ever been created for this paneId) falls back to
 *  `'unknown'`. */
function carryForwardExecutionStatus(previous: PaneInspectionEntry | undefined): ExecutionStatus | 'unknown' | null {
  return previous ? previous.executionStatus : 'unknown';
}

/** Applies one `PaneFeedEventV1` to a feed's snapshot immutably. Returns the SAME snapshot
 *  reference when the event carries no semantic change (heartbeat — design §8), so callers that
 *  compare `before === after` can tell a real update from a liveness ping without inspecting the
 *  event themselves. Every other branch returns a NEW top-level object (and a new per-paneId
 *  entry object for the affected paneId only) — the previous snapshot and its untouched paneId
 *  entries are never mutated in place. */
function applyEvent(snapshot: PaneInspectionStoreSnapshot, event: PaneFeedEventV1): PaneInspectionStoreSnapshot {
  if (event.type === 'heartbeat') return snapshot;

  const previous = snapshot.panes[event.paneId];
  const requiresFreshSnapshot = previous !== undefined
    && (previous.status === 'removed'
      || previous.status === 'access_revoked'
      || previous.status === 'resync_required');
  if (requiresFreshSnapshot && event.type !== 'snapshot' && event.type !== 'changed') {
    return snapshot;
  }

  const nextEntry: PaneInspectionEntry = (() => {
    switch (event.type) {
      case 'snapshot':
      case 'changed':
        return {
          status: 'ready',
          descriptor: event.descriptor,
          cursor: event.cursor,
          executionStatus: executionStatusFromDescriptor(event.descriptor),
        };
      case 'output_changed': {
        // An output delta carries no descriptor. Before the first full snapshot it advances only
        // the cursor and leaves the entry loading; after a snapshot it preserves the structural
        // descriptor. Non-ready terminal states were handled above and require a fresh snapshot
        // before any incremental event may reactivate them.
        if (!previous || previous.status !== 'ready' || !previous.descriptor) {
          return { status: 'loading', descriptor: null, cursor: event.cursor, executionStatus: carryForwardExecutionStatus(previous) };
        }
        return { status: 'ready', descriptor: { ...previous.descriptor,
          observation: { ...previous.descriptor.observation, cursor: event.cursor },
          latestOutput: { status: 'ready', value: event.preview } }, cursor: event.cursor, executionStatus: previous.executionStatus };
      }
      case 'execution_settled': {
        if (event.descriptor) return { status: 'ready', descriptor: event.descriptor,
          cursor: event.cursor, executionStatus: executionStatusFromDescriptor(event.descriptor) };
        // The outcome is authoritative even if it precedes the first descriptor, but it cannot by
        // itself make the entry structurally ready.
        if (!previous || previous.status !== 'ready') {
          return { status: 'loading', descriptor: null, cursor: event.cursor, executionStatus: event.outcome };
        }
        return { status: 'ready', descriptor: previous.descriptor, cursor: event.cursor, executionStatus: event.outcome };
      }
      case 'removed':
        return { status: 'removed', descriptor: null, cursor: event.cursor, executionStatus: 'unknown' };
      case 'access_revoked':
        return { status: 'access_revoked', descriptor: null, cursor: event.cursor, executionStatus: 'unknown' };
      case 'resync_required':
        return { status: 'resync_required', descriptor: null, cursor: event.cursor, executionStatus: 'unknown' };
      default:
        // Exhaustiveness guard: 'heartbeat' is handled by the early return above, so every other
        // PaneFeedEventV1 variant is covered by a case above. If a new variant is ever added to
        // the union without updating this switch, `event` here has type `never` and this line
        // fails to compile — a deliberate compile-time trip-wire rather than a silent `undefined`.
        return ((): never => { throw new Error(`applyEvent: unhandled event type ${(event as { type: string }).type}`); })();
    }
  })();

  return {
    panes: { ...snapshot.panes, [event.paneId]: nextEntry },
    error: null, // A successful event delivery clears any previously recorded feed-level error.
  };
}

function openFeed(apiBase: string, paneIds: readonly string[]): FeedRecord {
  const feed: FeedRecord = {
    refCount: 0,
    unsubscribeTransport: () => {},
    listeners: new Set(),
    snapshot: initialSnapshot(paneIds),
  };

  feed.unsubscribeTransport = subscribePanes(apiBase, {
    paneIds: [...paneIds],
    cursors: {}, // Fresh feed: no prior cursor for any paneId yet.
    onEvent: (event) => {
      const next = applyEvent(feed.snapshot, event);
      if (next === feed.snapshot) return; // Heartbeat — no notification (design §8).
      feed.snapshot = next;
      notify(feed);
    },
    onError: (error) => {
      // An identical repeated error (same code + message) is the underlying transport retrying
      // or re-reporting the same failure, not a new fact — creating a fresh snapshot object and
      // notifying on every repeat would defeat `useSyncExternalStore`'s reference-equality
      // change detection for no informational gain, and could drive an unbounded re-render loop
      // on a persistently failing connection. Only a genuinely different error (or the first one)
      // produces a new snapshot + notification.
      const previous = feed.snapshot.error;
      if (previous && previous.code === error.code && previous.message === error.message) return;
      feed.snapshot = { panes: feed.snapshot.panes, error: { code: error.code, message: error.message } };
      notify(feed);
    },
  });

  return feed;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface AttachPaneInspectionStoreOptions {
  /** Explicit scope the caller's `apiBase`/`paneIds` are namespaced under — typically a
   *  `workspaceId`. REQUIRED, with no implicit default: `apiBase` alone identifies a backend
   *  connection, not a workspace/tenant boundary, so two callers that happen to share an
   *  `apiBase` (e.g. two workspaces on the same backend connection) must not be silently folded
   *  into one feed just because their `paneIds` also collide. There are no production consumers
   *  of this store yet, so this is an explicit API from the start rather than a default added
   *  later once something already depends on the old shape. */
  scopeKey: string;
  apiBase: string;
  paneIds: readonly string[];
}

/**
 * Attaches a subscriber to the shared feed for `{scopeKey, apiBase, paneIds}`, opening it if this
 * is the first attach for that key. Returns a handle with `subscribe`/`getSnapshot` (directly
 * usable with `useSyncExternalStore`) and `detach` (call on unmount).
 *
 * `paneIds` order does not affect feed identity (see {@link feedKey}) — pass them in whatever
 * order is natural for the caller.
 */
export function attachPaneInspectionStore(options: AttachPaneInspectionStoreOptions): PaneInspectionStoreHandle {
  const { scopeKey, apiBase, paneIds } = options;
  const key = feedKey(scopeKey, apiBase, paneIds);
  let feed = feeds.get(key);
  if (!feed) {
    feed = openFeed(apiBase, paneIds);
    feeds.set(key, feed);
  }
  feed.refCount += 1;

  // Listeners this specific handle registered via `subscribe` — tracked separately from
  // `feed.listeners` (the shared set every attached handle's callbacks live in) so `detach` can
  // remove exactly and only the callbacks THIS handle owns. Without this, a caller that calls
  // `subscribe` but never gets around to invoking the returned unsubscribe before `detach()`
  // would leave a dangling listener in the shared set for the lifetime of the feed (or until some
  // other handle happens to reuse the same key) — a leak that grows with every mount/unmount
  // cycle of a component that forgets the unsubscribe call.
  const ownListeners = new Set<() => void>();

  let detached = false;
  const detach = (): void => {
    if (detached) return;
    detached = true;
    for (const listener of ownListeners) feed!.listeners.delete(listener);
    ownListeners.clear();
    feed!.refCount -= 1;
    if (feed!.refCount <= 0) {
      feed!.unsubscribeTransport();
      feeds.delete(key);
    }
  };

  return {
    subscribe(onStoreChange: () => void): () => void {
      feed!.listeners.add(onStoreChange);
      ownListeners.add(onStoreChange);
      return () => {
        feed!.listeners.delete(onStoreChange);
        ownListeners.delete(onStoreChange);
      };
    },
    getSnapshot(): PaneInspectionStoreSnapshot {
      return feed!.snapshot;
    },
    detach,
  };
}

/** Test-only escape hatch: closes every open feed's transport (calling each `unsubscribeTransport`
 *  exactly as a real last-`detach()` would) and then clears the module-scoped `feeds` map. Tests
 *  that mock `subscribePanes` still own and can assert on their own mock's `unsubscribeTransport`
 *  spy directly — this helper does not replace that — but it must not leave a PREVIOUS test
 *  case's feed connected into the NEXT case: without closing the transport here, a feed left open
 *  by a test that forgot to `detach()` every handle would keep its `subscribePanes` mock
 *  "listening" past `beforeEach`, and once a per-call queue/spy is reset by the next case, a late
 *  callback from the leaked feed calls into stale closures. Not exported from any public barrel —
 *  imported by its exact relative path from the test file only, matching this codebase's existing
 *  `__resetXForTests` convention for module-scoped singletons. */
export function __resetPaneInspectionStoreForTests(): void {
  for (const feed of feeds.values()) feed.unsubscribeTransport();
  feeds.clear();
}
