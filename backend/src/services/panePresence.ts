/** In-process, TTL'd registry of which renderer windows report which panes as open.
 *
 *  Presence records VIEWS. It never controls execution: closing a view updates a registration,
 *  it does not cancel a chat or a Run; an expired lease means "unknown", never "the user closed
 *  it". See design doc §9 for the full specification this module implements.
 *
 *  This module is transport-agnostic on purpose — it returns typed results rather than writing to
 *  an Express `res`, so backend/src/routes/paneInspection.ts (owned by task P1-8) can mount it
 *  thinly. See the bottom of this file for exactly what P1-8 must wire up. */

import { randomUUID } from 'node:crypto';

import { getNode, getWorkspace } from './dbRepository';
import { AgentRunsRepository } from './agentRunsRepository';
import { LOCAL_AGENT_OWNER_ID } from './agentOwner';
import {
  PANE_INSPECTION_LIMITS,
  PaneInspectionError,
  decodePaneId,
  encodePaneId,
  type PaneTarget,
  type PaneViewV1,
  type PaneDescriptorV1,
} from 'michi-shared';

/** Maximum number of surface registrations a single caller scope (ownerUserId+workspaceId+
 *  connectionId — the same triple a presence lease is bound to, see `PresenceCaller`) may hold
 *  at once, counting BOTH unclaimed (never submitted to presence) and claimed (currently live in
 *  some lease's view set) registrations. Chosen to match `PANE_INSPECTION_LIMITS.subscribeMaxPanes`
 *  (32) — this codebase's existing convention for "how many panes can one caller reasonably be
 *  juggling at once" (design §8) — rather than inventing an unrelated number: a single renderer
 *  window opening more than 32 terminal/browser/launcher/files/review/file/diff surface panes
 *  simultaneously is the same order-of-magnitude ceiling already applied to subscribePanes, and
 *  reusing it keeps the two limits from silently drifting apart. Exceeding it throws
 *  `RATE_LIMITED` (mapped to HTTP 429 by the route layer) rather than allocating an unbounded
 *  number of registrations that would otherwise sit in memory until their unclaimed-TTL sweep. */
export const MAX_SURFACE_REGISTRATIONS_PER_SCOPE = PANE_INSPECTION_LIMITS.subscribeMaxPanes;

// ---------------------------------------------------------------------------
// Public request/result types (this module's own contract — not part of the
// shared PaneInspection DTOs, which do not model the presence wire format).
// ---------------------------------------------------------------------------

/** The authenticated identity submitting a presence update. Mirrors how the rest of this
 *  codebase resolves ownership: `userId` is `req.user?.id` in cloud mode, absent on desktop. */
export interface PresenceCaller {
  ownerUserId: string;
  workspaceId: string;
  connectionId: string;
}

/** One reported view, as the renderer sees it. `paneId` is the opaque public id (see
 *  shared/src/paneInspection.ts's encodePaneId/decodePaneId); the server decodes it to validate
 *  node/run ownership and to derive the PaneTarget for storage. */
export interface PresenceViewInput {
  paneId: string;
  windowId: string;
  uiPaneId: string;
  treeId: string | null;
  visible: boolean;
  openedAtClient: number | null;
  /** Renderer-supplied surface title (for `surface:` targets only). Stored verbatim as
   *  renderer-provided data — never treated as fact, never executed or interpolated. */
  surfaceTitle?: string | null;
}

/** PUT /api/panes/presence body, after the route layer's JSON/auth extraction. */
export interface SubmitPresenceRequest {
  /** Absent on the very first submission from a renderer instance; the registry allocates one
   *  and returns it. Present on every subsequent submission. */
  rendererLeaseId?: string;
  /** Monotonically increasing per rendererLeaseId. The first submission (no rendererLeaseId yet)
   *  may pass any value; the registry seeds its counter from it. */
  viewRevision: number;
  windowId: string;
  views: PresenceViewInput[];
}

export type SubmitPresenceResult =
  | { ok: true; rendererLeaseId: string; accepted: number; rejectedTargets: RejectedTarget[] }
  | { ok: false; code: 'STALE_REVISION'; currentRevision: number }
  | { ok: false; code: 'WRONG_WINDOW' }
  | { ok: false; code: 'EMPTY_SNAPSHOT_IGNORED'; rendererLeaseId: string };

export interface RejectedTarget {
  paneId: string;
  reason: 'INVALID_ARGUMENT' | 'NOT_FOUND';
}

/** DELETE /api/panes/presence body. Removes specific views (or, if `paneIds` is omitted, the
 *  whole lease — e.g. window close). Never touches chat/run execution state. */
export interface RemovePresenceRequest {
  rendererLeaseId: string;
  paneIds?: string[];
}

export type RemovePresenceResult =
  | { ok: true; removed: number }
  | { ok: false; code: 'WRONG_WINDOW' }
  | { ok: false; code: 'NOT_FOUND' };

/** Body for the independent presence keepalive POST; unrelated to native ping/pong frames. */
export interface PresenceKeepaliveRequest {
  rendererLeaseId: string;
}

export type PresenceKeepaliveResult =
  | { ok: true; renewedViews: number }
  | { ok: false; code: 'NOT_FOUND' };

/** Read side consumed by P1-6 (inspect) and P2-4 (list). */
export type PanePresenceSectionV1 = PaneDescriptorV1['presence'];

// ---------------------------------------------------------------------------
// Internal storage
// ---------------------------------------------------------------------------

interface StoredView {
  paneId: string;
  target: PaneTarget;
  windowId: string;
  uiPaneId: string;
  treeId: string | null;
  visible: boolean;
  openedAtClient: number | null;
  registeredAt: number;
  lastSeenAt: number;
  surfaceTitle: string | null;
}

interface Lease {
  rendererLeaseId: string;
  ownerUserId: string;
  workspaceId: string;
  connectionId: string;
  windowId: string;
  viewRevision: number;
  lastKeepaliveAt: number;
  /** paneId -> view, scoped to this lease. */
  views: Map<string, StoredView>;
  /** True once this lease has submitted at least one non-empty snapshot. Used to distinguish a
   *  legitimately-empty first submission (new window, nothing open yet) from a later empty
   *  submission, which is always a hydration-failure symptom per design §9 and is ignored. */
  hasReportedNonEmpty: boolean;
}

interface Tombstone {
  rendererLeaseId: string;
  expiredAt: number;
}

/** A surface registration's own bookkeeping record — see `registrations` above for why this
 *  exists and what replaces the old bare-kind map. `ownerUserId`/`workspaceId`/`connectionId` are
 *  the caller scope the registration is bound to; a submit/resolve attempt from any other scope
 *  is rejected exactly like a lease's own WRONG_WINDOW check (see `resolveOwnedTarget` and
 *  `submitPresence`). */
interface SurfaceRegistration {
  registrationId: string;
  kind: string;
  ownerUserId: string;
  workspaceId: string;
  connectionId: string;
  allocatedAt: number;
}

export interface PanePresenceRegistryOptions {
  /** Injected clock — do not call Date.now() directly so TTL/expiry are testable with a fake
   *  clock instead of real sleeps. */
  now?: () => number;
  createLeaseId?: () => string;
  keepaliveIntervalMs?: number;
  ttlMs?: number;
  /** How long an expired lease's views remain visible as a tombstone marker before release.
   *  Defaults to one keepalive interval, matching design §9's "short tombstone, then release". */
  tombstoneRetentionMs?: number;
}

/** In-process, TTL'd registry. One instance per backend process — presence is never persisted
 *  into an authoritative table (design §9); a restart means every lease starts as `unknown` and
 *  waits for renderers to re-register. */
export class PanePresenceRegistry {
  private readonly now: () => number;
  private readonly createLeaseId: () => string;
  private readonly keepaliveIntervalMs: number;
  private readonly ttlMs: number;
  private readonly tombstoneRetentionMs: number;

  private readonly leases = new Map<string, Lease>();
  /** Recently-expired leases, kept briefly so a caller mid-race with an expiry doesn't see a view
   *  vanish with no explanation. Not part of `coverage: 'reported'` — expired leases are swept
   *  out of the live view set before every read. */
  private readonly tombstones = new Map<string, Tombstone>();
  /** registrationId -> the surface registration record. Superseded `registrationKinds: Map<string,
   *  string>` (which stored only the kind — 'launcher' | 'files' | 'review' | 'file' | 'diff' |
   *  'terminal' | 'browser' — chosen at allocation time). `kind` is still typed as `string` rather
   *  than importing `SurfacePaneKind` from paneInspectionProjection.surface.ts (P2-3's file) —
   *  that type is presentation-layer, not a presence concern, and importing it would create a
   *  cross-task dependency in the wrong direction. Callers that need the narrower type (P1-6's
   *  `inspect`) already know it is one of the seven surface kinds because that is the only thing
   *  `allocateSurfaceRegistration` accepts.
   *
   *  Now that allocation is an authenticated call, a registration must be BOUND to the caller who
   *  allocated it (`ownerUserId`/`workspaceId`/`connectionId` — the same triple a lease is bound
   *  to, see `submitPresence`'s WRONG_WINDOW checks) so a different owner/workspace/connection can
   *  never submit a view for, or resolve, someone else's opaque registrationId merely by guessing
   *  or observing it. `allocatedAt` (via the injected clock) drives the unclaimed-registration
   *  sweep in `sweepExpired()` below.
   *
   *  Never persisted — like every other registration in this registry, it disappears on a backend
   *  restart along with the lease that reported it. */
  private readonly registrations = new Map<string, SurfaceRegistration>();

  constructor(private readonly runs: AgentRunsRepository = new AgentRunsRepository(), opts: PanePresenceRegistryOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.createLeaseId = opts.createLeaseId ?? (() => `lease-${randomUUID()}`);
    this.keepaliveIntervalMs = opts.keepaliveIntervalMs ?? PANE_INSPECTION_LIMITS.presenceKeepaliveSeconds * 1_000;
    this.ttlMs = opts.ttlMs ?? PANE_INSPECTION_LIMITS.presenceTtlSeconds * 1_000;
    this.tombstoneRetentionMs = opts.tombstoneRetentionMs ?? this.keepaliveIntervalMs;
  }

  // -------------------------------------------------------------------------
  // Server-side node/run/workspace ownership validation
  // -------------------------------------------------------------------------

  /** Resolves and validates a submitted paneId against the caller's own workspace/owner. Never
   *  trusts client-asserted status, output, or lineage for the target — only that it exists and
   *  is owned by this caller. Surface targets have no persistent object to check. */
  private resolveOwnedTarget(paneId: string, caller: PresenceCaller): PaneTarget | null {
    let target: PaneTarget;
    try {
      target = decodePaneId(paneId);
    } catch {
      return null;
    }

    if (target.kind === 'node') {
      const node = getNode(target.nodeId);
      if (!node) return null;
      const workspace = getWorkspace(node.workspace_id, caller.ownerUserId);
      if (!workspace || workspace.id !== caller.workspaceId) return null;
      return target;
    }

    if (target.kind === 'agent_run') {
      const run = this.runs.getRun(caller.ownerUserId, target.runId);
      if (!run) return null;
      // AgentRunDtoV1 carries its own workspaceId; a run owned by this caller but living in a
      // different workspace than the one presence is scoped to is not this caller's pane.
      if ((run as { workspaceId?: string }).workspaceId !== caller.workspaceId) return null;
      return target;
    }

    // 'surface' — no persistent object; the registration must exist AND be bound to this exact
    // caller scope (ownerUserId+workspaceId+connectionId — mirrors the lease WRONG_WINDOW check
    // above). A fabricated registrationId, an expired/swept one, or one allocated by a different
    // owner/workspace/connection are all indistinguishable NOT_FOUND here — never a scoped 403 —
    // matching this file's own "never leak whether the id exists for someone else" convention
    // used throughout `keepalive`/`removePresence`.
    const registration = this.registrations.get(target.registrationId);
    if (!registration) return null;
    if (
      registration.ownerUserId !== caller.ownerUserId ||
      registration.workspaceId !== caller.workspaceId ||
      registration.connectionId !== caller.connectionId
    ) {
      return null;
    }
    return target;
  }

  // -------------------------------------------------------------------------
  // Lease allocation for surface panes (terminal/browser/launcher/files/review)
  // -------------------------------------------------------------------------

  /** Allocates a new surface registration and returns its public paneId. Callers that want to
   *  register a not-yet-existing surface pane call this first, then submit it like any other view
   *  via submitPresence. Not persisted — a new registrationId is minted every time a renderer
   *  opens a surface pane, including across a backend restart.
   *
   *  `caller` binds the registration to the exact scope that allocated it: allocation is now an
   *  authenticated call, so an opaque registrationId must not be usable by anyone other than the
   *  caller who minted it — `submitPresence`'s `resolveOwnedTarget` rejects any other
   *  owner/workspace/connection as NOT_FOUND, the same way it already does for `node`/`agent_run`
   *  targets.
   *
   *  Throws `PaneInspectionError('RATE_LIMITED', ...)` once this caller's scope already holds
   *  `MAX_SURFACE_REGISTRATIONS_PER_SCOPE` registrations (unclaimed + claimed combined) — see
   *  that constant's own doc comment for the chosen value and rationale. The cap is counted per
   *  ownerUserId+workspaceId+connectionId, the exact same triple used everywhere else in this file
   *  to isolate one caller's state from another's, so one exhausted scope never blocks a different
   *  window, workspace, or owner.
   *
   *  `kind` is required (added for P1-6b): a surface registration's `PaneKind` is otherwise never
   *  captured anywhere — `PresenceViewInput`/`StoredView` carry `treeId` and `surfaceTitle` but
   *  no kind field, and `registrationId` is an opaque random UUID that encodes nothing. Without
   *  storing it here, `inspect()` would have no way to know whether a `surface:` locator names a
   *  `launcher`, `terminal`, `browser`, etc., and could not build a typed `PaneDescriptorV1`. */
  allocateSurfaceRegistration(caller: PresenceCaller, kind: string): { registrationId: string; paneId: string } {
    this.sweepExpired();

    const scopeCount = this.countRegistrationsForScope(caller);
    if (scopeCount >= MAX_SURFACE_REGISTRATIONS_PER_SCOPE) {
      throw new PaneInspectionError(
        'RATE_LIMITED',
        'presence.allocate',
        `too many open surface pane registrations for this session (max ${MAX_SURFACE_REGISTRATIONS_PER_SCOPE})`,
      );
    }

    const registrationId = randomUUID();
    this.registrations.set(registrationId, {
      registrationId,
      kind,
      ownerUserId: caller.ownerUserId,
      workspaceId: caller.workspaceId,
      connectionId: caller.connectionId,
      allocatedAt: this.now(),
    });
    return { registrationId, paneId: encodePaneId({ kind: 'surface', registrationId }) };
  }

  /** How many surface registrations (unclaimed + claimed) currently exist for one caller scope —
   *  the denominator `allocateSurfaceRegistration`'s cap check compares against. */
  private countRegistrationsForScope(caller: PresenceCaller): number {
    let count = 0;
    for (const registration of this.registrations.values()) {
      if (
        registration.ownerUserId === caller.ownerUserId &&
        registration.workspaceId === caller.workspaceId &&
        registration.connectionId === caller.connectionId
      ) {
        count += 1;
      }
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // PUT /api/panes/presence
  // -------------------------------------------------------------------------

  submitPresence(caller: PresenceCaller, req: SubmitPresenceRequest): SubmitPresenceResult {
    this.sweepExpired();

    let lease = req.rendererLeaseId ? this.leases.get(req.rendererLeaseId) : undefined;

    if (req.rendererLeaseId && !lease) {
      // Named a lease that no longer exists (expired past its tombstone, or never existed). A
      // stale renderer must re-register from scratch, not silently resurrect a dead lease.
      lease = undefined;
    }

    if (lease) {
      if (lease.ownerUserId !== caller.ownerUserId || lease.workspaceId !== caller.workspaceId || lease.connectionId !== caller.connectionId) {
        // windowId is a label, never a credential — but the lease itself IS the credential, and
        // it is bound at allocation time to owner+workspace+connection+renderer instance. A
        // request presenting someone else's lease id is rejected outright.
        return { ok: false, code: 'WRONG_WINDOW' };
      }
      if (req.windowId !== lease.windowId) {
        // windowId cannot be used to modify another window's registration, even under a lease
        // that is otherwise valid — a duplicated tab must hold its OWN lease.
        return { ok: false, code: 'WRONG_WINDOW' };
      }
      if (req.viewRevision <= lease.viewRevision) {
        return { ok: false, code: 'STALE_REVISION', currentRevision: lease.viewRevision };
      }
    }

    const isNewLease = !lease;
    if (isNewLease) {
      lease = {
        rendererLeaseId: this.createLeaseId(),
        ownerUserId: caller.ownerUserId,
        workspaceId: caller.workspaceId,
        connectionId: caller.connectionId,
        windowId: req.windowId,
        viewRevision: req.viewRevision,
        lastKeepaliveAt: this.now(),
        views: new Map(),
        hasReportedNonEmpty: false,
      };
      this.leases.set(lease.rendererLeaseId, lease);
    }
    const activeLease = lease as Lease;

    // The dangerous case: a renderer whose hydration failed must never be able to erase its
    // views by reporting an empty set. Once a lease has reported at least one non-empty
    // snapshot, a later empty submission is a no-op — it neither replaces the stored views nor
    // advances the lease's revision, so the renderer's next real submission is not rejected as
    // stale. Only a genuinely NEW lease's first submission may legitimately be empty (a freshly
    // opened window with nothing loaded yet).
    if (req.views.length === 0 && activeLease.hasReportedNonEmpty) {
      return { ok: false, code: 'EMPTY_SNAPSHOT_IGNORED', rendererLeaseId: activeLease.rendererLeaseId };
    }

    const rejectedTargets: RejectedTarget[] = [];
    const resolved: Array<{ input: PresenceViewInput; target: PaneTarget }> = [];
    for (const view of req.views) {
      const target = this.resolveOwnedTarget(view.paneId, caller);
      if (!target) {
        rejectedTargets.push({ paneId: view.paneId, reason: 'NOT_FOUND' });
        continue;
      }
      resolved.push({ input: view, target });
    }

    // This submission fully replaces the lease's OWN view set (a renderer reports everything it
    // currently has open), but only once we know it isn't the empty-snapshot case above, and only
    // for the paneIds that passed ownership validation. Rejected targets are dropped, not stored,
    // and never overwrite a previously-valid registration for the same paneId.
    const now = this.now();
    activeLease.views = new Map(
      resolved.map(({ input, target }) => {
        const existing = activeLease.views.get(input.paneId);
        const stored: StoredView = {
          paneId: input.paneId,
          target,
          windowId: input.windowId,
          uiPaneId: input.uiPaneId,
          treeId: input.treeId,
          visible: input.visible,
          openedAtClient: input.openedAtClient ?? existing?.openedAtClient ?? null,
          registeredAt: existing?.registeredAt ?? now,
          lastSeenAt: now,
          surfaceTitle: input.surfaceTitle ?? existing?.surfaceTitle ?? null,
        };
        return [input.paneId, stored];
      }),
    );
    activeLease.viewRevision = req.viewRevision;
    activeLease.lastKeepaliveAt = now;
    if (resolved.length > 0) activeLease.hasReportedNonEmpty = true;
    this.tombstones.delete(activeLease.rendererLeaseId);

    return {
      ok: true,
      rendererLeaseId: activeLease.rendererLeaseId,
      accepted: resolved.length,
      rejectedTargets,
    };
  }

  // -------------------------------------------------------------------------
  // DELETE /api/panes/presence
  // -------------------------------------------------------------------------

  /** Removes view registrations. Performs NO cancellation of any kind — this only updates the
   *  presence registry; the underlying chat turn or Run, if any, is completely untouched. */
  removePresence(caller: PresenceCaller, req: RemovePresenceRequest): RemovePresenceResult {
    this.sweepExpired();
    const lease = this.leases.get(req.rendererLeaseId);
    if (!lease) return { ok: false, code: 'NOT_FOUND' };
    if (lease.ownerUserId !== caller.ownerUserId || lease.workspaceId !== caller.workspaceId || lease.connectionId !== caller.connectionId) {
      return { ok: false, code: 'WRONG_WINDOW' };
    }

    if (!req.paneIds) {
      const removed = lease.views.size;
      this.leases.delete(lease.rendererLeaseId);
      return { ok: true, removed };
    }

    let removed = 0;
    for (const paneId of req.paneIds) {
      if (lease.views.delete(paneId)) removed += 1;
    }
    return { ok: true, removed };
  }

  // -------------------------------------------------------------------------
  // presence_keepalive
  // -------------------------------------------------------------------------

  keepalive(caller: PresenceCaller, req: PresenceKeepaliveRequest): PresenceKeepaliveResult {
    this.sweepExpired();
    const lease = this.leases.get(req.rendererLeaseId);
    if (!lease) return { ok: false, code: 'NOT_FOUND' };
    if (lease.ownerUserId !== caller.ownerUserId || lease.workspaceId !== caller.workspaceId || lease.connectionId !== caller.connectionId) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    const now = this.now();
    lease.lastKeepaliveAt = now;
    for (const view of lease.views.values()) view.lastSeenAt = now;
    return { ok: true, renewedViews: lease.views.size };
  }

  // -------------------------------------------------------------------------
  // Read side — consumed by P1-6 (inspect) and P2-4 (list)
  // -------------------------------------------------------------------------

  /** Returns the presence section for one PaneTarget. `coverage: 'unknown'` means no lease has
   *  ever registered anything for this target (including "backend just restarted") — this is
   *  NOT the same as `coverage: 'reported'` with `views: []`, which cannot actually occur since a
   *  target with zero live views has no reason to be tracked; the distinction a caller relies on
   *  in practice is: 'unknown' -> no presence signal exists at all, 'reported' -> at least one
   *  view is currently live for this target. */
  getPresence(target: PaneTarget): PanePresenceSectionV1 {
    this.sweepExpired();
    const paneId = encodePaneId(target);
    const views: PaneViewV1[] = [];
    for (const lease of this.leases.values()) {
      const view = lease.views.get(paneId);
      if (view) views.push(this.toPaneViewV1(view));
    }
    return views.length > 0
      ? { coverage: 'reported', views }
      : { coverage: 'unknown', views: [] };
  }

  /**
   * Added for P2-4 (`list_panes` `scope=open`): every distinct PaneTarget with at least one live
   * view currently registered in this workspace, across all leases. Unlike `getPresence`/
   * `getPresenceForTargets`, which answer "does THIS already-named target have presence", this
   * answers "which targets currently HAVE presence at all" — the only way to enumerate
   * `scope=open`'s row set, since a caller cannot pre-name every possible pane id up front. Scoped
   * to `workspaceId` because presence has no cross-workspace query anywhere else in this
   * registry's API and `list_panes` must never scan another workspace (design §7.1). */
  listOpenTargetsForWorkspace(workspaceId: string): PaneTarget[] {
    this.sweepExpired();
    const byPaneId = new Map<string, PaneTarget>();
    for (const lease of this.leases.values()) {
      if (lease.workspaceId !== workspaceId) continue;
      for (const view of lease.views.values()) {
        byPaneId.set(view.paneId, view.target);
      }
    }
    return Array.from(byPaneId.values());
  }

  /** Bulk variant for list_panes (P2-4), avoiding one registry scan per row. */
  getPresenceForTargets(targets: readonly PaneTarget[]): Map<string, PanePresenceSectionV1> {
    this.sweepExpired();
    const byPaneId = new Map<string, PaneViewV1[]>();
    for (const target of targets) byPaneId.set(encodePaneId(target), []);
    for (const lease of this.leases.values()) {
      for (const [paneId, view] of lease.views) {
        const bucket = byPaneId.get(paneId);
        if (bucket) bucket.push(this.toPaneViewV1(view));
      }
    }
    const out = new Map<string, PanePresenceSectionV1>();
    for (const [paneId, views] of byPaneId) {
      out.set(paneId, views.length > 0 ? { coverage: 'reported', views } : { coverage: 'unknown', views: [] });
    }
    return out;
  }

  /** Added for P1-6b: resolves a `surface` registration's own identity — the fields
   *  `paneInspectionProjection.surface.ts`'s `SurfaceProjectionInput` needs beyond
   *  `observedAt`/`backendConnectionId`, which the service layer supplies itself. Returns `null`
   *  for a registration with no currently-live view in ANY lease — an expired lease's views are
   *  already swept out of `leases` by `sweepExpired()` above, so "no live view" and "unknown
   *  registrationId" are indistinguishable here on purpose (design §4.2: these panes cannot be
   *  promised queryable once the window is gone; the caller must turn this into NOT_FOUND, never
   *  an empty descriptor).
   *
   *  `workspaceId` comes from the LEASE that reported the view (every lease is bound to exactly
   *  one workspace at allocation time — see `submitPresence`'s WRONG_WINDOW checks), not from the
   *  view itself, since `StoredView`/`PresenceViewInput` carry no workspaceId of their own.
   *  `kind` comes from `registrations`, populated by `allocateSurfaceRegistration`; if a
   *  registrationId has a live view but (implausibly) no recorded registration, that is a bug in
   *  this registry's own bookkeeping, not a caller-visible NOT_FOUND — callers should not have to
   *  reason about that state, so this method still requires a registration to return anything,
   *  treating the pairing as a single atomic fact. */
  getSurfaceRegistrationInfo(registrationId: string): {
    kind: string;
    workspaceId: string;
    treeId: string | null;
    rendererTitle: string | null;
  } | null {
    this.sweepExpired();
    const paneId = encodePaneId({ kind: 'surface', registrationId });
    const registration = this.registrations.get(registrationId);
    if (!registration) return null;
    for (const lease of this.leases.values()) {
      const view = lease.views.get(paneId);
      if (view) {
        return { kind: registration.kind, workspaceId: lease.workspaceId, treeId: view.treeId, rendererTitle: view.surfaceTitle };
      }
    }
    return null;
  }

  /** How many distinct views (across all leases) currently have this pane open — used by
   *  list_panes' `openedInViews` summary field. */
  countOpenViews(target: PaneTarget): number {
    return this.getPresence(target).views.length;
  }

  private toPaneViewV1(view: StoredView): PaneViewV1 {
    return {
      windowId: view.windowId,
      uiPaneId: view.uiPaneId,
      treeId: view.treeId,
      visible: view.visible,
      openedAtClient: view.openedAtClient,
      registeredAt: view.registeredAt,
      lastSeenAt: view.lastSeenAt,
    };
  }

  // -------------------------------------------------------------------------
  // TTL / expiry
  // -------------------------------------------------------------------------

  private sweepExpired(): void {
    const now = this.now();
    for (const [id, lease] of this.leases) {
      if (now - lease.lastKeepaliveAt > this.ttlMs) {
        this.leases.delete(id);
        this.tombstones.set(id, { rendererLeaseId: id, expiredAt: now });
      }
    }
    for (const [id, tombstone] of this.tombstones) {
      if (now - tombstone.expiredAt > this.tombstoneRetentionMs) {
        this.tombstones.delete(id);
      }
    }
    this.sweepUnclaimedRegistrations(now);
  }

  /** Releases surface registrations that are both (a) older than `ttlMs` since allocation and
   *  (b) not currently referenced by any LIVE lease's view set. Runs after the lease expiry pass
   *  above, so "live lease" here already excludes anything just swept out this same tick.
   *
   *  The "not referenced" guard is the whole point: a registration that a renderer promptly
   *  submitted to presence and has kept alive via `keepalive`/resubmission ever since must never
   *  be released out from under it just because it is old — age alone is not evidence of
   *  abandonment for a claimed registration, only for one nobody ever submitted (a renderer that
   *  called allocate then crashed/never followed up before opening the surface pane, or simply
   *  never will). A claimed registration's real lifetime is already bounded by its owning
   *  lease's own TTL (`leases` above); this sweep only reclaims the UNCLAIMED case, which would
   *  otherwise accumulate in `registrations` forever (nothing else ever removes an entry). */
  private sweepUnclaimedRegistrations(now: number): void {
    if (this.registrations.size === 0) return;
    const referenced = new Set<string>();
    for (const lease of this.leases.values()) {
      for (const view of lease.views.values()) {
        if (view.target.kind === 'surface') referenced.add(view.target.registrationId);
      }
    }
    for (const [registrationId, registration] of this.registrations) {
      if (referenced.has(registrationId)) continue;
      if (now - registration.allocatedAt > this.ttlMs) {
        this.registrations.delete(registrationId);
      }
    }
  }

  /** True while a lease is remembered as "recently expired" (within its tombstone window) rather
   *  than having no record of it at all. Exposed for tests; not part of the read API any other
   *  task consumes. */
  hasTombstone(rendererLeaseId: string): boolean {
    this.sweepExpired();
    return this.tombstones.has(rendererLeaseId);
  }

  /** Test/diagnostic helper: true if a lease is currently live (not expired, not tombstoned, not
   *  unknown). */
  hasLiveLease(rendererLeaseId: string): boolean {
    this.sweepExpired();
    return this.leases.has(rendererLeaseId);
  }

  /** Test/diagnostic helper: true if a surface registration still exists in this registry's
   *  bookkeeping (claimed or unclaimed) — distinct from `getSurfaceRegistrationInfo`, which also
   *  requires a currently-live view and therefore cannot distinguish "never claimed, not yet
   *  swept" from "claimed once, now expired". */
  hasRegistration(registrationId: string): boolean {
    this.sweepExpired();
    return this.registrations.has(registrationId);
  }
}

/** Resolves the caller's ownerUserId the same way the rest of the routes do: `req.user?.id` in
 *  cloud mode, the fixed desktop identity otherwise. P1-8 should use this rather than reading
 *  `req.user` directly, so presence's desktop/cloud behaviour matches every other route. */
export function resolvePresenceOwnerUserId(reqUserId: string | undefined): string {
  return process.env.MICHI_CLOUD === '1' ? (reqUserId ?? '') : LOCAL_AGENT_OWNER_ID;
}

// ---------------------------------------------------------------------------
// What backend/src/routes/paneInspection.ts (P1-8) must mount
// ---------------------------------------------------------------------------
//
// PUT /api/panes/presence
//   body: SubmitPresenceRequest
//   caller: { ownerUserId: resolvePresenceOwnerUserId(req.user?.id), workspaceId: <from body or
//            route, validated the same way other workspace-scoped routes do>, connectionId:
//            <the route's own backendConnectionId / socket identity> }
//   -> registry.submitPresence(caller, body)
//   -> 200 with the SubmitPresenceResult on ok:true; 409 on STALE_REVISION; 403 on WRONG_WINDOW;
//      200 with the EMPTY_SNAPSHOT_IGNORED body on that case (it is not an error the renderer
//      needs to retry differently, just a no-op it should know about for its own logging).
//
// DELETE /api/panes/presence
//   body: RemovePresenceRequest
//   caller: same shape as PUT
//   -> registry.removePresence(caller, body)
//   -> 200 with RemovePresenceResult on ok:true; 403 on WRONG_WINDOW; 404 on NOT_FOUND.
//
// A single shared `PanePresenceRegistry` instance must be constructed once (module scope, like
// other in-process registries in this codebase) and imported by both the route handlers and
// whatever P1-6/P2-4 use to read `getPresence`/`getPresenceForTargets`/`countOpenViews`.

/**
 * The one process-wide presence registry.
 *
 * This lives here, in the module that owns the class, rather than in the service or the route
 * layer — a service importing a singleton from `routes/` would invert the dependency direction.
 *
 * It exists because P1-6 and P1-8 each constructed their OWN `new PanePresenceRegistry()`, which
 * silently broke presence end to end: views submitted through `PUT /api/panes/presence` landed in
 * the router's instance while `inspect` read the service's, so every descriptor reported
 * `coverage: 'unknown'` no matter what a renderer registered, and a `surface:` locator could never
 * resolve. Presence is deliberately process-local (design §9: it is never persisted, and after a
 * restart it is `unknown` until renderers re-register), so one module-scope instance is the whole
 * of the required lifetime — but it must genuinely be one.
 */
export const panePresenceRegistry = new PanePresenceRegistry();
