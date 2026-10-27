import type { AgentSession, RuntimeSessionOwner } from '../contract/types';
import { interactiveOwner, sameOwner } from '../contract/types';
import { ownerMode, type RuntimeHost } from '../contract/host';
import {
  createSessionStateFeed,
  type SessionLog,
  type SessionStateChanged,
  type SessionStateFeed,
  type SessionStateListener,
} from './sessionStateFeed';

export const HISTORY_STUB_TTL_MS = 30 * 60 * 1000;
export const HISTORY_STUB_MAX_ENTRIES = 256;

export type SessionEntryKind = 'live' | 'stub';

/** Read-only snapshot of one directory entry. */
export interface SessionEntryView {
  readonly session: AgentSession;
  readonly ownerUserId: string | null;
  readonly owner: RuntimeSessionOwner;
  readonly kind: SessionEntryKind;
  readonly lastAccessedAt: number;
}

export interface SessionDirectoryOptions {
  /**
   * Read on every user-scoped lookup, so a host can switch modes at runtime.
   * While it returns true, getForUser/getForOwner return null unless the entry's
   * ownerUserId strictly equals the caller's userId, so an entry registered
   * without a user is rejected for every non-null user.
   */
  enforceUserOwnership: () => boolean;
  /**
   * Host ports. When the directory builds its own state feed, the host's
   * onSessionStateChanged persists session state and observability.log
   * receives the feed's logs, each read at call time. An explicit
   * onSessionStateChanged or log below takes precedence; with `stateFeed`
   * neither is used.
   */
  host?: RuntimeHost;
  /** Builds the directory's own state feed. Not allowed together with `stateFeed`. */
  onSessionStateChanged?: SessionStateChanged;
  log?: SessionLog;
  /**
   * Host-supplied state feed, used instead of building one from
   * `onSessionStateChanged`/`log`. The directory uses it only through
   * track/untrack/clear/subscribe.
   *
   * - Directories given the same feed share its tracking: clear() on any of
   *   them clears tracking for all of them, and drop() of an id untracks it
   *   for all of them.
   * - subscribeStates() without `ownerUserId` receives every user's state,
   *   even while enforceUserOwnership holds. The host must apply its own
   *   access control before it subscribes unfiltered.
   */
  stateFeed?: SessionStateFeed;
  /** Idle time after which an unprotected history stub is evicted. Default HISTORY_STUB_TTL_MS. */
  stubTtlMs?: number;
  /** Resident history-stub cap applied when evictStubs() gets no maxEntries. Default HISTORY_STUB_MAX_ENTRIES. */
  stubMaxEntries?: number;
}

export interface EvictStubsOptions {
  now?: number;
  maxEntries?: number;
  /** Stubs that survive both the TTL and the cap; they still count against the cap. */
  protectedIds?: ReadonlySet<string>;
}

/**
 * In-memory directory of runtime sessions keyed by session id. Live sessions
 * come from register(); read-only history stubs from insertStub() fill gaps in
 * a parent chain and are evicted by TTL and count. Registering an id again
 * replaces its entry (the last write wins) and keeps its iteration position.
 */
export interface SessionDirectory {
  /**
   * Registers a live session, replacing any entry with the same id. `owner`
   * defaults to `session.owner`, else the chat node `session.id`. Only interactive
   * owners (ownerMode: chat nodes) track session state; a headless owner stops
   * tracking the id.
   */
  register(session: AgentSession, ownerUserId?: string | null, owner?: RuntimeSessionOwner): void;
  /** Adds a read-only history stub with no user. Returns false and changes nothing when the id already has an entry. */
  insertStub(session: AgentSession, owner: RuntimeSessionOwner): boolean;
  /** Evicts expired stubs, then the least recently used ones above the cap. Live sessions are never evicted. */
  evictStubs(options?: EvictStubsOptions): number;
  /** Trusted lookup without an ownership check. Refreshes the entry's idle time. */
  get(sessionId: string): AgentSession | undefined;
  /** User-facing lookup; see SessionDirectoryOptions.enforceUserOwnership. */
  getForUser(sessionId: string, userId: string | null): AgentSession | null;
  /** Requires the exact owner, so a delayed action for an old owner cannot reach a replacement session. */
  getForOwner(sessionId: string, owner: RuntimeSessionOwner, userId: string | null): AgentSession | null;
  matchesOwner(sessionId: string, owner: RuntimeSessionOwner): boolean;
  drop(sessionId: string): void;
  /** Drops the entry only when its owner matches. */
  dropForOwner(sessionId: string, owner: RuntimeSessionOwner): boolean;
  /** Snapshot of an entry without refreshing its idle time. */
  peek(sessionId: string): SessionEntryView | undefined;
  /** Snapshots of every entry in iteration order, without refreshing idle times. */
  entries(): SessionEntryView[];
  /**
   * Replays current state, then delivers changes; see SessionStateFeed.subscribe.
   * Not gated by enforceUserOwnership: without `ownerUserId` it receives every
   * user's state.
   */
  subscribeStates(receive: SessionStateListener, ownerUserId?: string | null): () => void;
  /** Drops every entry and all state tracking. State subscribers stay subscribed. */
  clear(): void;
}

type Entry = {
  session: AgentSession;
  ownerUserId: string | null;
  owner: RuntimeSessionOwner;
  kind: SessionEntryKind;
  lastAccessedAt: number;
};

export function createSessionDirectory(options: SessionDirectoryOptions): SessionDirectory {
  const { enforceUserOwnership } = options;
  if (typeof enforceUserOwnership !== 'function') {
    throw new TypeError('createSessionDirectory: enforceUserOwnership must be a function');
  }
  if (options.stateFeed && (options.onSessionStateChanged || options.log)) {
    throw new TypeError('createSessionDirectory: pass either stateFeed or onSessionStateChanged/log, not both');
  }
  const stubTtlMs = options.stubTtlMs ?? HISTORY_STUB_TTL_MS;
  const stubMaxEntries = options.stubMaxEntries ?? HISTORY_STUB_MAX_ENTRIES;
  const { host } = options;
  const states = options.stateFeed ?? createSessionStateFeed({
    onSessionStateChanged: options.onSessionStateChanged
      ?? (host && ((session, ownerUserId, state) => host.onSessionStateChanged?.(session, ownerUserId, state))),
    log: options.log ?? (host && ((level, scope, msg, data) => host.observability.log(level, scope, msg, data))),
  });
  const entries = new Map<string, Entry>();

  function touch(entry: Entry): void {
    if (entry.kind === 'stub') entry.lastAccessedAt = Date.now();
    else entry.session.touch?.();
  }

  function matchesOwner(sessionId: string, owner: RuntimeSessionOwner): boolean {
    const entry = entries.get(sessionId);
    return !!entry && sameOwner(entry.owner, owner);
  }

  return {
    // An unowned session is the interactive owner of its own id.
    register(session, ownerUserId, owner = session.owner ?? interactiveOwner(session.id)) {
      // Before any write: an unknown owner mode throws and leaves the directory as it was.
      const mode = ownerMode(owner);
      entries.set(session.id, {
        session,
        ownerUserId: ownerUserId ?? null,
        owner,
        kind: 'live',
        lastAccessedAt: Date.now(),
      });
      if (mode === 'interactive') states.track(session, ownerUserId ?? null);
      else states.untrack(session.id);
    },

    insertStub(session, owner) {
      if (entries.has(session.id)) return false;
      entries.set(session.id, { session, ownerUserId: null, owner, kind: 'stub', lastAccessedAt: Date.now() });
      return true;
    },

    evictStubs(opts = {}) {
      const now = opts.now ?? Date.now();
      const maxEntries = Math.max(0, Math.floor(opts.maxEntries ?? stubMaxEntries));
      const protectedIds = opts.protectedIds ?? new Set<string>();
      let removed = 0;

      for (const [id, entry] of entries) {
        if (entry.kind === 'stub' && !protectedIds.has(id) && now - entry.lastAccessedAt > stubTtlMs) {
          entries.delete(id);
          removed += 1;
        }
      }

      const protectedStubCount = [...protectedIds].filter((id) => entries.get(id)?.kind === 'stub').length;
      const unprotectedLimit = Math.max(0, maxEntries - protectedStubCount);
      const remaining = [...entries.entries()]
        .filter(([id, entry]) => entry.kind === 'stub' && !protectedIds.has(id))
        .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);
      for (let index = 0; index < remaining.length - unprotectedLimit; index += 1) {
        if (entries.delete(remaining[index][0])) removed += 1;
      }
      return removed;
    },

    get(sessionId) {
      const entry = entries.get(sessionId);
      if (!entry) return undefined;
      touch(entry);
      return entry.session;
    },

    getForUser(sessionId, userId) {
      const entry = entries.get(sessionId);
      if (!entry) return null;
      if (enforceUserOwnership() && entry.ownerUserId !== userId) return null; // null owner also rejected
      touch(entry);
      return entry.session;
    },

    getForOwner(sessionId, owner, userId) {
      const entry = entries.get(sessionId);
      if (!entry || !sameOwner(entry.owner, owner)) return null;
      if (enforceUserOwnership() && entry.ownerUserId !== userId) return null;
      touch(entry);
      return entry.session;
    },

    matchesOwner,

    drop(sessionId) {
      states.untrack(sessionId);
      entries.delete(sessionId);
    },

    dropForOwner(sessionId, owner) {
      if (!matchesOwner(sessionId, owner)) return false;
      states.untrack(sessionId);
      return entries.delete(sessionId);
    },

    peek(sessionId) {
      const entry = entries.get(sessionId);
      return entry ? { ...entry } : undefined;
    },

    entries() {
      return [...entries.values()].map((entry) => ({ ...entry }));
    },

    subscribeStates(receive, ownerUserId) {
      return states.subscribe(receive, ownerUserId);
    },

    clear() {
      states.clear();
      entries.clear();
    },
  };
}
