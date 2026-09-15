/** Renderer-side reporter for the Pane Inspection presence registry (design §9,
 *  `backend/src/services/panePresence.ts`, owned by P2-1).
 *
 *  This hook tells the backend which panes THIS window currently has open. It is a pure client
 *  for that backend contract — no animation, no DOM lifecycle. Do NOT confuse it with
 *  `components/terminal/usePanePresence.ts`, which despite the near-identical name is a pure
 *  exit-animation/DOM-lifecycle hook with zero network code and is not prior art for this module
 *  (confirmed in `.worktrees/briefs/research/R5-transport-frontend.md` §8).
 *
 *  The network call is fully injectable via `PanePresenceTransport` so this hook's tests run
 *  against the seam, never a server. The real implementation is
 *  `frontend/src/services/api/panePresence.ts` (PUT/DELETE `/panes/presence` via `fetch`, POST
 *  `/panes/presence/keepalive` via `fetchStream`) — see the bottom of this file for exactly what
 *  it does.
 */

import { useEffect, useRef } from 'react';
import { encodePaneId, PANE_INSPECTION_LIMITS, type PaneTarget } from 'michi-shared';

// ---------------------------------------------------------------------------
// Public wire types — mirrors backend/src/services/panePresence.ts's request/result shapes.
// Re-declared here (not imported) because that module is backend-only and this hook must not
// pull backend code into the frontend bundle; keep the two in sync by hand.
// ---------------------------------------------------------------------------

export interface PresenceViewInput {
  paneId: string;
  windowId: string;
  uiPaneId: string;
  treeId: string | null;
  visible: boolean;
  openedAtClient: number | null;
  surfaceTitle?: string | null;
}

export interface SubmitPresenceRequest {
  rendererLeaseId?: string;
  viewRevision: number;
  windowId: string;
  views: PresenceViewInput[];
}

export type SubmitPresenceResult =
  | { ok: true; rendererLeaseId: string; accepted: number; rejectedTargets: Array<{ paneId: string; reason: string }> }
  | { ok: false; code: 'STALE_REVISION'; currentRevision: number }
  | { ok: false; code: 'WRONG_WINDOW' }
  | { ok: false; code: 'EMPTY_SNAPSHOT_IGNORED'; rendererLeaseId: string };

export interface RemovePresenceRequest {
  rendererLeaseId: string;
  paneIds?: string[];
}

export type RemovePresenceResult =
  | { ok: true; removed: number }
  | { ok: false; code: 'WRONG_WINDOW' }
  | { ok: false; code: 'NOT_FOUND' };

export interface PresenceKeepaliveRequest {
  rendererLeaseId: string;
}

export type PresenceKeepaliveResult =
  | { ok: true; renewedViews: number }
  | { ok: false; code: 'NOT_FOUND' };

/** The transport seam. `backendConnectionId` identifies which backend a call targets — a window
 *  may hold leases against several backends (local + remote) at once (design §9), so every call
 *  is scoped per-connection rather than assuming a single global backend. `workspaceId` travels
 *  alongside it on every method: the backend route resolves and authorises `workspaceId` from
 *  the request BODY, not from a route param or ambient state (see
 *  `backend/src/routes/paneInspection.ts`'s `resolvePresenceWorkspaceId`), so a transport
 *  implementation needs it explicitly on every call, not just at connection-resolution time — a
 *  single window can have projects on different backends, each with its own workspaceId, and a
 *  connection can in principle serve more than one. A real implementation
 *  (`frontend/src/services/api/panePresence.ts`) resolves the base URL per
 *  `backendApiBase(backendConnectionId)` (R5 §5) and PUTs/DELETEs/POSTs `/api/panes/presence`
 *  (+ `/keepalive`), never a hardcoded `API_BASE_URL`. This hook never resolves that base
 *  itself — it only calls the injected functions with the connection id and workspace id it was
 *  given. */
export interface PanePresenceTransport {
  submit(backendConnectionId: string, workspaceId: string, req: SubmitPresenceRequest): Promise<SubmitPresenceResult>;
  remove(backendConnectionId: string, workspaceId: string, req: RemovePresenceRequest): Promise<RemovePresenceResult>;
  keepalive(backendConnectionId: string, workspaceId: string, req: PresenceKeepaliveRequest): Promise<PresenceKeepaliveResult>;
}

// ---------------------------------------------------------------------------
// Input shape — a narrow layout snapshot, not the whole chat store (R5 §6).
// ---------------------------------------------------------------------------

/** One backend this window talks to, and the panes it has open there. A window may have several
 *  (local + remote), each with its own lease (design §9's "一个窗口可能通过不同连接到多个
 *  backend"). `workspaceId` is needed to validate ownership server-side; it travels alongside
 *  each connection because a single window can have projects on different backends. */
export interface PanePresenceBackendSlots {
  backendConnectionId: string;
  workspaceId: string;
  /** Every open-pane slot this backend's project(s) currently have, keyed by
   *  `${projectId}::${treeId ?? 'workspace'}` exactly as `paneState.ts`'s `paneSlotKey` produces
   *  it — this hook does not recompute that key, it is handed the already-keyed maps so it stays
   *  a thin reporter rather than a second copy of pane-state logic. */
  openPanesMap: Record<string, string[]>;
  /** The slot key that is currently VISIBLE for this backend (the active project's active tree
   *  slot), or null if this backend has no active slot right now (e.g. a different backend's
   *  project is focused). Only panes in this slot are reported `visible: true`; every other open
   *  pane is still reported, just with `visible: false` — a pane saved in a background tree slot
   *  is still open (design §9 / brief). */
  activeSlotKey: string | null;
}

/** Maps a bare/prefixed UI pane id to the shape presence needs to submit it. `uiPaneId` is kept
 *  distinct from the public `paneId` this hook computes (`node:`/`run:`/`surface:` — design
 *  §4.1.1) because the UI's own id space (bare nodeId, `pane:agent-run:<enc>:<enc>`, `pane:file:
 *  <hash>`, …) is not the same string. */
export interface PanePresenceViewSource {
  /** How to resolve the pane's public identity. Chat panes and agent-run panes map onto an
   *  existing persistent object (`node:{nodeId}` / `run:{runId}` — backend routing remains in
   *  the connection/workspace arguments, while the shared codec percent-encodes the runId). Every other `pane:*` kind has no
   *  persistent object and must be registered as a `surface`, using a registrationId the SERVER
   *  allocated — never invented client-side. */
  target:
    | { kind: 'node'; nodeId: string }
    | { kind: 'agent-run'; backendConnectionId: string; runId: string }
    | { kind: 'surface'; registrationId: string };
  surfaceTitle?: string | null;
}

/** Resolves a UI pane id (as it appears in `openPanesMap`) to its presence source. Returning
 *  `undefined` means "no server-allocated surface registration exists yet for this id" — the
 *  caller is responsible for allocating one (via the backend's `allocateSurfaceRegistration`)
 *  before this pane can be reported; until then this hook simply omits it from the submission
 *  rather than inventing a `surface:` id itself. */
export type PanePresenceIdResolver = (uiPaneId: string) => PanePresenceViewSource | undefined;

export interface UsePanePresenceReporterArgs {
  /** Gate every submission on this. Must only be true once the backend has actually answered
   *  (R5 §7's hydration barrier) — a pre-hydration or failed-hydration state must never produce
   *  a snapshot (design §9), and the client must not rely on the server-side backstop alone.
   *
   *  There is deliberately no separate `hydrationFailed` flag: per R5 §7, `workspacePersistence
   *  .ts` has no such signal either — a rejected fetch is retried forever and `hydrated` simply
   *  never becomes true until one resolves (even the catch-all fallback path still calls
   *  `finishHydration`). So "hydration failed" and "hydration hasn't happened yet" are the same
   *  observable state from this hook's perspective: `hydrated === false`. Gating on this one
   *  flag covers both. */
  hydrated: boolean;
  /** This window's stable identity, distinct across duplicate tabs — a duplicate tab must hold
   *  its own lease (design §9), never share this window's `rendererLeaseId`. */
  windowId: string;
  /** One entry per backend this window currently has panes open on. Recomputed by the caller on
   *  every relevant pane-state change; this hook re-derives its submission from whatever it is
   *  handed on each render; it does not read pane state itself. */
  backends: PanePresenceBackendSlots[];
  resolveViewSource: PanePresenceIdResolver;
  transport: PanePresenceTransport;
  /** Invoked synchronously, before this hook recomputes a forced reacquire, whenever a
   *  keepalive comes back NOT_FOUND for `connectionId`/`workspaceId` (the backend restarted or
   *  the lease's TTL expired server-side). This is the hook's only signal that the SERVER no
   *  longer recognizes a lease it previously accepted — production mounting code can use it to
   *  clear any stale surface registrations (`allocateSurfaceRegistration` ids) it was holding
   *  for that connection, since those registrations may not have survived the same restart.
   *  Optional: a caller with nothing to clean up (e.g. most test harnesses) can omit it. */
  onLeaseInvalidated?: (connectionId: string, workspaceId: string) => void;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Internal per-connection lease state
// ---------------------------------------------------------------------------

interface ConnectionState {
  rendererLeaseId: string | null;
  viewRevision: number;
  /** paneId -> registeredAt (openedAtClient), so a re-submission of a still-open pane keeps its
   *  original open time instead of resetting it every render. */
  openedAtClientByPaneId: Map<string, number>;
  keepaliveTimer: ReturnType<typeof setInterval> | null;
  /** Bumped on every state-changing SUBMIT dispatch for this connection (a normal render-driven
   *  PUT, a forced reacquire, or the drop/unmount cleanup DELETE) — never by keepalive itself.
   *  Captured by each in-flight request at dispatch time and compared against the CURRENT value
   *  when the response resolves, so a slow/reordered response can never clobber what a more
   *  recently dispatched submit already installed — e.g. two normal PUTs resolving out of order
   *  must leave the NEWEST one authoritative, and a keepalive that started before a reacquire and
   *  resolves after it must not overwrite the fresh lease the reacquire installed. Keepalive
   *  reads/captures this value to guard its own response handling but does not increment it: a
   *  keepalive is read-only with respect to lease identity (it either renews the existing lease
   *  or triggers a submit-driven reacquire, which is what actually bumps generation), so a
   *  keepalive resolving after a newer submit must never appear to invalidate that submit's
   *  result. */
  generation: number;
  /** The workspaceId of the most recent slot submitted for this connection. Kept on the state
   *  (not just read from `backends` at submission time) so a connection that later drops out of
   *  `backends` entirely — its last pane closed and the caller stopped reporting it — still has
   *  a workspaceId to send with the final cleanup DELETE; by that point there is no current slot
   *  left to read one from. */
  lastWorkspaceId: string | null;
}

function computeViewsForConnection(
  slot: PanePresenceBackendSlots,
  resolveViewSource: PanePresenceIdResolver,
  windowId: string,
  openedAtClientByPaneId: Map<string, number>,
  now: number,
): { views: PresenceViewInput[]; openUiPaneIds: Set<string> } {
  const views: PresenceViewInput[] = [];
  const openUiPaneIds = new Set<string>();

  for (const [slotKey, uiPaneIds] of Object.entries(slot.openPanesMap)) {
    const visible = slotKey === slot.activeSlotKey;
    const treeId = slotKey.includes('::') ? (slotKey.slice(slotKey.indexOf('::') + 2)) : null;
    const treeIdOrNull = treeId === 'workspace' ? null : treeId;

    for (const uiPaneId of uiPaneIds) {
      openUiPaneIds.add(uiPaneId);
      const source = resolveViewSource(uiPaneId);
      if (!source) continue; // No server-allocated surface id yet — nothing to report.

      const target: PaneTarget = source.target.kind === 'node'
        ? { kind: 'node', nodeId: source.target.nodeId }
        : source.target.kind === 'agent-run'
          ? { kind: 'agent_run', runId: source.target.runId }
          : { kind: 'surface', registrationId: source.target.registrationId };
      const paneId = encodePaneId(target);

      const openedAtClient = openedAtClientByPaneId.get(paneId) ?? now;
      if (!openedAtClientByPaneId.has(paneId)) openedAtClientByPaneId.set(paneId, openedAtClient);

      views.push({
        paneId,
        windowId,
        uiPaneId,
        treeId: treeIdOrNull,
        visible,
        openedAtClient,
        surfaceTitle: source.surfaceTitle ?? null,
      });
    }
  }

  return { views, openUiPaneIds };
}

/**
 * Batch-registers this window's open panes with the backend presence registry, and keeps the
 * registration alive with a periodic keepalive. See module doc comment for the design this
 * implements.
 */
export function usePanePresenceReporter({
  hydrated,
  windowId,
  backends,
  resolveViewSource,
  transport,
  onLeaseInvalidated,
  now = Date.now,
}: UsePanePresenceReporterArgs): void {
  const connectionsRef = useRef(new Map<string, ConnectionState>());
  // Tracks, per connection, which paneIds were reported as open on the LAST successful
  // submission. This is what lets us tell a pane that "went away" (present last time, absent
  // this time — needs an explicit DELETE, per the PUT/DELETE asymmetry) apart from a pane that
  // merely "became invisible" (still present in some open-pane slot, just not the active one —
  // stays in the PUT with visible: false, and is never removed).
  const lastReportedPaneIdsRef = useRef(new Map<string, Set<string>>());
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const resolveRef = useRef(resolveViewSource);
  resolveRef.current = resolveViewSource;
  const nowRef = useRef(now);
  nowRef.current = now;
  const windowIdRef = useRef(windowId);
  windowIdRef.current = windowId;
  const hydratedRef = useRef(hydrated);
  hydratedRef.current = hydrated;
  // Stored through a ref so the interval closure inside `ensureKeepalive` always calls the
  // latest callback identity without needing to be recreated — matching how `transport` and
  // `resolveViewSource` are handled below (both also kept live via ref AND listed in the
  // submission effect's deps, so a genuinely new callback still restarts reporting cleanly).
  const onLeaseInvalidatedRef = useRef(onLeaseInvalidated);
  onLeaseInvalidatedRef.current = onLeaseInvalidated;

  const backendsRef = useRef(backends);
  backendsRef.current = backends;

  /** Dispatches one submission for `connectionId` using `slot`'s CURRENT open-pane snapshot.
   *  Shared by the render-driven effect below and by the keepalive NOT_FOUND recovery path, so
   *  a lease reacquired outside of a render still goes through the exact same request-shaping,
   *  lastReported-bookkeeping, and stale-response guarding.
   *
   *  Never mutates `state.rendererLeaseId` optimistically — the caller decides whether this is a
   *  fresh-lease reacquire (pass `forceNewLease: true`, which drops any stale
   *  `rendererLeaseId`/`viewRevision` before building the request) or a normal incremental
   *  submission using whatever lease this connection already holds. */
  function submitForConnection(
    connectionId: string,
    state: ConnectionState,
    slot: PanePresenceBackendSlots,
    lastReported: Map<string, Set<string>>,
    opts: { forceNewLease?: boolean } = {},
  ): void {
    if (opts.forceNewLease) {
      state.rendererLeaseId = null;
      state.viewRevision = nowRef.current();
    }
    state.lastWorkspaceId = slot.workspaceId;

    const { views } = computeViewsForConnection(
      slot,
      resolveRef.current,
      windowIdRef.current,
      state.openedAtClientByPaneId,
      nowRef.current(),
    );
    // Drop cached open times for panes no longer open anywhere, so a pane closed then reopened
    // much later gets a fresh openedAtClient instead of resurrecting a stale one.
    for (const paneId of Array.from(state.openedAtClientByPaneId.keys())) {
      if (!views.some((v) => v.paneId === paneId)) state.openedAtClientByPaneId.delete(paneId);
    }

    const currentPaneIds = new Set(views.map((v) => v.paneId));
    const previousPaneIds = lastReported.get(connectionId) ?? new Set<string>();
    const wentAway = opts.forceNewLease ? [] : [...previousPaneIds].filter((id) => !currentPaneIds.has(id));

    state.viewRevision += 1;
    const submitReq: SubmitPresenceRequest = {
      rendererLeaseId: state.rendererLeaseId ?? undefined,
      viewRevision: state.viewRevision,
      windowId: windowIdRef.current,
      views,
    };

    // Design §9 / brief: an empty PUT is ignored by the server once a lease has reported
    // non-empty at least once — closing the LAST pane must be an explicit DELETE, never an
    // empty PUT. Skip the PUT entirely in that case and go straight to the DELETE below; this
    // also avoids burning a viewRevision on a submission the server will silently drop.
    const skipEmptyPut = views.length === 0 && state.rendererLeaseId !== null;
    if (!skipEmptyPut) {
      const activeState = state;
      // Every state-changing submit dispatch owns its own generation, not only a forced
      // reacquire. Two normal PUTs can resolve out of order (e.g. a slow first request and a
      // fast second one triggered by a rapid pane-state change) — without bumping generation
      // here, both would share the dispatch-time generation and the STALE first response could
      // still land after the second and clobber viewRevision/rendererLeaseId with older data.
      // Bumping unconditionally on every dispatch means only the response for the MOST
      // RECENTLY dispatched submit can ever apply; any earlier one is stale by construction the
      // moment a newer dispatch fires, whether or not that newer dispatch was itself a reacquire.
      activeState.generation += 1;
      const dispatchedGeneration = activeState.generation;
      void transportRef.current.submit(connectionId, slot.workspaceId, submitReq).then((result) => {
        // A newer submit/reacquire may have already superseded this one (e.g. this request was
        // in flight when a subsequent submit or a keepalive NOT_FOUND reacquire dispatched) —
        // never let a stale response overwrite what the newer request already installed.
        if (activeState.generation !== dispatchedGeneration) return;
        if (result.ok) {
          activeState.rendererLeaseId = result.rendererLeaseId;
          ensureKeepalive(connectionId, activeState);
        } else if (result.code === 'EMPTY_SNAPSHOT_IGNORED') {
          activeState.rendererLeaseId = result.rendererLeaseId;
        } else if (result.code === 'STALE_REVISION') {
          activeState.viewRevision = result.currentRevision;
        } else if (result.code === 'WRONG_WINDOW') {
          // This lease is no longer ours (e.g. a stale id from a previous process). Drop it
          // so the next submission starts a fresh lease.
          activeState.rendererLeaseId = null;
        }
      }).catch(() => { /* Best-effort; the next render's submission will retry. */ });
    }
    // else: nothing open anywhere for this connection and a lease already exists — the
    // brief's PUT/DELETE asymmetry means an empty PUT would be silently ignored by the
    // server anyway, so skip it. The DELETE below (driven by `wentAway`) is what actually
    // clears the last pane.

    if (wentAway.length > 0 && state.rendererLeaseId) {
      const activeState = state;
      const dispatchedGeneration = activeState.generation;
      void transportRef.current.remove(connectionId, slot.workspaceId, {
        rendererLeaseId: state.rendererLeaseId,
        paneIds: wentAway,
      }).then((result) => {
        if (activeState.generation !== dispatchedGeneration) return;
        // A lease-not-found DELETE (already expired/reacquired elsewhere) is a no-op — the
        // reacquire path (if any) already replaced it; nothing further to do here.
        if (!result.ok) return;
      }).catch(() => { /* Best-effort; a stale registration expires via TTL regardless. */ });
    }

    lastReported.set(connectionId, currentPaneIds);

    function ensureKeepalive(connectionId: string, state: ConnectionState): void {
      if (state.keepaliveTimer) return;
      state.keepaliveTimer = setInterval(() => {
        if (!hydratedRef.current || !state.rendererLeaseId) return;
        const slotNow = backendsRef.current.find((s) => s.backendConnectionId === connectionId);
        if (!slotNow) return;
        const rendererLeaseId = state.rendererLeaseId;
        const dispatchedGeneration = state.generation;
        void transportRef.current.keepalive(connectionId, slotNow.workspaceId, { rendererLeaseId })
          .then((result) => {
            if (state.generation !== dispatchedGeneration) return;
            if (result.ok) return;
            // NOT_FOUND: the lease expired or the backend restarted. Tell the caller first —
            // synchronously, before any reacquire bookkeeping below — so production mounting
            // code can clear stale surface registrations (allocateSurfaceRegistration ids) for
            // this connection/workspace before this hook's own reacquire dispatch fires; the
            // caller's cleanup and this hook's recovery must observe the same NOT_FOUND signal
            // in the same order every time, not race each other.
            try {
              onLeaseInvalidatedRef.current?.(connectionId, slotNow.workspaceId);
            } catch {
              // Notification hooks may update caller-owned caches, but cannot block the lease
              // state machine. A failed cache cleanup may cause surface views to be rejected on
              // this reacquire; the next allocation/render pass can recover them independently.
            }
            // Reacquire a fresh lease immediately from the LATEST pane snapshot this connection
            // currently has open, rather than waiting for an unrelated rerender to notice — a
            // window that has no pane-state churn for minutes must not sit unregistered until
            // something else happens to trigger the submission effect. Bump `generation` first
            // so any request already in flight for the OLD lease (a race between this
            // keepalive's own in-flight call and, e.g., a submit dispatched moments earlier)
            // cannot land after this reacquire and clobber it. (submitForConnection below bumps
            // generation again for its own dispatch when it actually submits; this bump alone
            // is what invalidates in-flight requests on the early-return "nothing open" path.)
            state.generation += 1;
            const latestSlot = backendsRef.current.find((s) => s.backendConnectionId === connectionId);
            if (!latestSlot) {
              // This connection is no longer open at all; nothing to reacquire for.
              if (state.keepaliveTimer) { clearInterval(state.keepaliveTimer); state.keepaliveTimer = null; }
              return;
            }
            const nonEmpty = Object.values(latestSlot.openPanesMap).some((ids) => ids.length > 0);
            if (!nonEmpty) {
              // Nothing open right now — a forced empty PUT would be pointless (and the server
              // would reject it as EMPTY_SNAPSHOT_IGNORED on a lease that never existed yet
              // anyway); just drop the dead lease id and let the next real submission (when a
              // pane opens) start a fresh one.
              state.rendererLeaseId = null;
              return;
            }
            submitForConnection(connectionId, state, latestSlot, lastReportedPaneIdsRef.current, { forceNewLease: true });
          })
          .catch(() => { /* Best-effort; TTL expiry is the fallback if keepalives keep failing. */ });
      }, PANE_INSPECTION_LIMITS.presenceKeepaliveSeconds * 1_000);
    }
  }

  // ---------------------------------------------------------------------
  // Submission effect — runs whenever hydration state or the backend/pane
  // inputs change. Never fires before `hydrated` is true.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!hydrated) return;

    const connections = connectionsRef.current;
    const lastReported = lastReportedPaneIdsRef.current;
    const seenConnectionIds = new Set<string>();

    for (const slot of backendsRef.current) {
      seenConnectionIds.add(slot.backendConnectionId);
      let state = connections.get(slot.backendConnectionId);
      if (!state) {
        state = {
          rendererLeaseId: null,
          viewRevision: nowRef.current(),
          openedAtClientByPaneId: new Map(),
          keepaliveTimer: null,
          generation: 0,
          lastWorkspaceId: null,
        };
        connections.set(slot.backendConnectionId, state);
      }

      submitForConnection(slot.backendConnectionId, state, slot, lastReported);
    }

    // Backends this window no longer talks to at all (e.g. its last pane on that connection
    // closed and the connection itself was dropped from `backends`): remove the whole lease.
    for (const [connectionId, state] of connections) {
      if (seenConnectionIds.has(connectionId)) continue;
      if (state.keepaliveTimer) clearInterval(state.keepaliveTimer);
      state.generation += 1;
      if (state.rendererLeaseId) {
        // Use the last known workspaceId recorded for this connection — it is no longer present
        // in `backends`, so there is no current slot to read one from. `lastReported` does not
        // carry it either; keep it on the state itself so a dropped connection can still be torn
        // down cleanly server-side.
        const workspaceId = state.lastWorkspaceId;
        if (workspaceId) {
          void transportRef.current.remove(connectionId, workspaceId, { rendererLeaseId: state.rendererLeaseId })
            .catch(() => { /* Best-effort. */ });
        }
      }
      connections.delete(connectionId);
      lastReported.delete(connectionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, windowId, backends, resolveViewSource, transport, onLeaseInvalidated]);

  // ---------------------------------------------------------------------
  // Unmount / window-close cleanup — remove every view this renderer holds
  // across every connection, and stop all keepalive timers. Never cancels a
  // chat or a Run; presence records views and nothing else.
  // ---------------------------------------------------------------------
  useEffect(() => {
    const connections = connectionsRef.current;
    const cleanup = () => {
      for (const [connectionId, state] of connections) {
        if (state.keepaliveTimer) {
          clearInterval(state.keepaliveTimer);
          state.keepaliveTimer = null;
        }
        state.generation += 1;
        if (state.rendererLeaseId && state.lastWorkspaceId) {
          void transportRef.current.remove(connectionId, state.lastWorkspaceId, { rendererLeaseId: state.rendererLeaseId })
            .catch(() => { /* Best-effort on unmount/unload; TTL is the fallback. */ });
        }
      }
    };
    window.addEventListener('beforeunload', cleanup);
    return () => {
      window.removeEventListener('beforeunload', cleanup);
      cleanup();
    };
  }, []);
}

// ---------------------------------------------------------------------------
// What the real PanePresenceTransport (frontend/src/services/api/panePresence.ts) implements
// against the fixed backend contract:
//
// submit(backendConnectionId, workspaceId, req)
//   -> PUT `${backendApiBase(backendConnectionId)}/panes/presence` with `{ ...req, workspaceId }`
//      as the JSON body (workspaceId travels in the body — the route resolves/authorises it from
//      there, not from a route param). Maps the backend's SubmitPresenceResult 1:1; a non-ok HTTP
//      status distinct from the typed `ok:false` codes above rejects the promise so this hook's
//      `.catch` retries on the next render rather than corrupting state.
//
// remove(backendConnectionId, workspaceId, req)
//   -> DELETE the same path with `{ ...req, workspaceId }` as the JSON body.
//
// keepalive(backendConnectionId, workspaceId, req)
//   -> POST `${backendApiBase(backendConnectionId)}/panes/presence/keepalive` via `fetchStream`
//      (never bare `fetch`), so an upgraded gateway carries it over the existing shared
//      per-window WebSocket and an older gateway falls back to HTTP transparently. One socket
//      per backendConnectionId; a lease is renewed only on the connection that owns it. On
//      NOT_FOUND (lease expired or the backend restarted), this hook reacquires a fresh lease
//      immediately — see `ensureKeepalive`'s NOT_FOUND branch above — rather than waiting for an
//      unrelated rerender to notice.
// ---------------------------------------------------------------------------
