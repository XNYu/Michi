/** Production wiring for the Pane Presence reporter (design §9; W13 brief).
 *
 *  `usePanePresenceReporter` (`./usePanePresenceReporter.ts`) is a pure client of the presence
 *  contract — it takes a `PanePresenceBackendSlots[]` snapshot and a `PanePresenceIdResolver` and
 *  does the PUT/DELETE/keepalive bookkeeping. Something has to actually build those two things
 *  from the live chat store and mount the reporter exactly once per renderer. This module is that
 *  something.
 *
 *  Scope decision (per brief): one active workspace per renderer is sufficient. There is no
 *  cross-backend global inspection/isolation feature here — this hook reports exactly one
 *  `PanePresenceBackendSlots` entry, for the ACTIVE project's backend connection, built from every
 *  open-pane slot belonging to that project (every tree, not just the visible one — `openPanesMap`
 *  is passed through read-only from `usePaneState`, not just the currently-focused slot). A window
 *  with no active project (`activeProjectId === null`) reports an empty `backends` array, which the
 *  reporter tears down to zero leases via its own empty-backends cleanup path — no special-casing
 *  needed here.
 *
 *  Capability gate: presence is enabled only when `fetchPersistenceCapabilities` for the active
 *  `{backendConnectionId, workspaceId}` scope resolves with `supportsPaneInspection(...) ===
 *  true`. The probe result is tagged with the exact scope it was resolved for — a workspace or
 *  connection switch can never inherit the previous scope's `enabled: true` for even one render
 *  while its own probe is in flight, and a probe failure (old gateway, network error, malformed
 *  response) records `false` for that scope rather than leaving the flag ambiguous. The probe
 *  itself is gated on `hydrated` and depends only on stable primitives
 *  (`hydrated`/`activeProjectId`/`activeBackendConnectionId`), never on the `Project` object's own
 *  reference — an ordinary immutable update to the active project (rename, unrelated field bump)
 *  must not re-probe or tear down an already-active lease.
 *
 *  Surface allocation: `node` and `agent-run` PaneItems resolve to their persistent identity
 *  directly (`node:{nodeId}` / `run:{runId}` — no server round-trip needed, matching
 *  `usePanePresenceReporter`'s own `computeViewsForConnection`). Every other PaneItem kind
 *  (`launcher`/`files`/`review`/`file`/`diff`/`terminal`/`browser`) has no persistent object and
 *  needs a server-allocated `surface:{registrationId}` id — this hook calls
 *  `allocateSurfaceRegistration` for each newly-seen uiPaneId of that kind, dedupes concurrent
 *  allocation attempts for the same `{connection, workspace, uiPaneId}` triple (fast pane-state
 *  churn — e.g. two renders in quick succession before the first allocation resolves — must not
 *  fire two allocate calls for the same pane), and removes the mapping once its pane closes.
 *
 *  Deliberately NOT wired here: `attachPaneInspectionStore` (`./paneInspection.ts`). That module
 *  opens a `subscribePanes` feed and its own contract requires a real subscriber — there is no
 *  Inspector UI consuming it yet, so mounting it globally here would open a feed nothing reads.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from './chatTypes';
import type { PaneItem, PaneItemKind } from './paneItems';
import { usePanePresenceDashboardVisible } from './panePresenceVisibility';
import {
  fetchPersistenceCapabilities,
  supportsPaneInspection,
} from '../services/api/persistence';
import {
  allocateSurfaceRegistration,
  panePresenceTransport,
  type SurfacePaneKind,
} from '../services/api/panePresence';
import {
  usePanePresenceReporter,
  type PanePresenceBackendSlots,
  type PanePresenceIdResolver,
  type PanePresenceViewSource,
} from './usePanePresenceReporter';

/** Every non-persistent PaneItem kind, mapped 1:1 onto the backend's `SurfacePaneKind` union.
 *  `node` (bare chat ids, not a PaneItem at all) and `agent-run` are excluded — those resolve
 *  directly without allocation. */
const SURFACE_KINDS: ReadonlySet<PaneItemKind> = new Set<PaneItemKind>([
  'launcher', 'files', 'review', 'file', 'diff', 'terminal', 'browser',
]);

function isSurfaceKind(kind: PaneItemKind): kind is SurfacePaneKind {
  return SURFACE_KINDS.has(kind);
}

/** A bare chat/node id never starts with `pane:` (see `paneItems.ts`'s id constructors — every
 *  non-node PaneItem id is `pane:{kind}:...`). Used to tell "this openPanesMap entry is a plain
 *  nodeId, no PaneItem lookup needed" apart from "this is a `pane:*` id that must be looked up in
 *  `paneItems`". */
function isBareNodeId(uiPaneId: string): boolean {
  return !uiPaneId.startsWith('pane:');
}

interface SurfaceMappingEntry {
  kind: SurfacePaneKind;
  registrationId: string;
  /** The backend connection + workspace this registration was allocated against. A mapping
   *  allocated for a previous connection/workspace (e.g. before a workspace switch) is stale and
   *  must not be reused even if the same uiPaneId string happens to still be open. */
  backendConnectionId: string;
  workspaceId: string;
}

/** Identifies one capability-probe scope: a specific `{backendConnectionId, workspaceId}` pair.
 *  Used both as the capability-state key and as the allocation/dedupe scope prefix. */
function scopeKey(connectionId: string, workspaceId: string): string {
  return `${connectionId}\u0000${workspaceId}`;
}

/** The capability probe's result, tagged with the exact scope it was resolved for. A component
 *  reading `enabled` must compare `state.key` against the CURRENT scope before trusting
 *  `state.supported` — never read `supported` alone, since a stale `state` from a previous scope
 *  must never be mistaken for the current scope's answer, not even for one render. */
interface CapabilityProbeState {
  key: string | null;
  supported: boolean;
}

const NO_CAPABILITY_PROBE: CapabilityProbeState = { key: null, supported: false };

export interface UsePanePresenceIntegrationArgs {
  /** This window's stable identity (`WINDOW_ID` from `chatStore.tsx`). Passed in rather than
   *  imported directly to avoid a circular import between this module and `chatStore.tsx`, which
   *  mounts this hook. */
  windowId: string;
  /** Backend hydration barrier (R5 §7) — gates every submission, per
   *  `usePanePresenceReporter`'s own `hydrated` doc comment. Also gates the capability probe
   *  itself: a probe fired before hydration completes would be asking the wrong question (the
   *  active project can still change during hydration), so the probe waits for `hydrated` too. */
  hydrated: boolean;
  projects: readonly Project[];
  activeProjectId: string | null;
  activeBackendConnectionId: string;
  /** Every open-pane slot across every project, keyed exactly as `paneState.ts`'s `paneSlotKey`
   *  produces it (`${projectId}::${treeId ?? 'workspace'}`). Passed through read-only — this hook
   *  filters down to the active project's own keys itself, so every tree/tab of that project is
   *  reported, not just the currently-focused one. */
  openPanesMap: Readonly<Record<string, string[]>>;
  /** Registered PaneItem objects, keyed by their `pane:*` id (or an agent-run's own id). Used to
   *  resolve every `openPanesMap` entry that isn't a bare nodeId. */
  paneItems: Readonly<Record<string, PaneItem>>;
}

/**
 * Mounts the Pane Presence reporter for the active project, wiring the real
 * `panePresenceTransport` and a resolver backed by on-demand surface allocation. Mount exactly
 * once, in `ChatProvider` — never per-pane or per-window-instance, since the reporter itself
 * already owns one lease per backend connection internally.
 */
export function usePanePresenceIntegration({
  windowId,
  hydrated,
  projects,
  activeProjectId,
  activeBackendConnectionId,
  openPanesMap,
  paneItems,
}: UsePanePresenceIntegrationArgs): void {
  const dashboardVisible = usePanePresenceDashboardVisible();
  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  // ---------------------------------------------------------------------
  // Capability gate. Re-probes whenever the active scope (`{activeBackendConnectionId,
  // activeProjectId}`) or hydration changes — depends on those stable primitives directly, never
  // on `activeProject` (a new object reference on every immutable-update render, even ones that
  // change neither id nor connection, must NOT trigger a re-probe or a lease teardown).
  //
  // State is tagged with the exact scope it was resolved for (`CapabilityProbeState.key`) rather
  // than a bare boolean. `enabled` below is only ever read through a check that the tag matches
  // the CURRENT scope — so switching to a new workspace/connection can never inherit the
  // previous scope's `supported: true` for even one render while its own probe is in flight; the
  // stale entry is scope-mismatched and therefore always reads as disabled until overwritten by
  // a probe resolved for the new scope. Probing is also gated on `hydrated`: the backend hydration
  // barrier applies to the probe itself, not only to the reporter's own submissions.
  // ---------------------------------------------------------------------
  const [capabilityProbe, setCapabilityProbe] = useState<CapabilityProbeState>(NO_CAPABILITY_PROBE);
  const currentScopeKey = hydrated && activeProjectId ? scopeKey(activeBackendConnectionId, activeProjectId) : null;

  useEffect(() => {
    if (!hydrated || !activeProjectId) return;
    const key = scopeKey(activeBackendConnectionId, activeProjectId);
    let cancelled = false;
    void fetchPersistenceCapabilities(activeBackendConnectionId)
      .then((capabilities) => {
        if (cancelled) return;
        setCapabilityProbe({ key, supported: supportsPaneInspection(capabilities) });
      })
      .catch(() => {
        // Probe failure: old gateway, network error, or a malformed body already rejected inside
        // fetchPersistenceCapabilities. Record `supported: false` for this exact scope — never
        // claim an empty pane list, and never leave a stale scope's answer in place implying this
        // scope inherited it.
        if (cancelled) return;
        setCapabilityProbe({ key, supported: false });
      });
    return () => { cancelled = true; };
  }, [hydrated, activeProjectId, activeBackendConnectionId]);

  const paneInspectionEnabled = currentScopeKey !== null
    && capabilityProbe.key === currentScopeKey
    && capabilityProbe.supported;

  // ---------------------------------------------------------------------
  // Surface registration mappings — one per uiPaneId that needs a server-allocated id. Held in a
  // ref (not React state) because allocation is asynchronous and must not race a render; a
  // version counter forces the memoized resolver below to recompute once a mapping actually
  // lands, without making the ref itself a dependency (refs are not valid deps).
  // ---------------------------------------------------------------------------
  const surfaceMappingsRef = useRef(new Map<string, SurfaceMappingEntry>());
  const [surfaceMappingVersion, setSurfaceMappingVersion] = useState(0);
  /** Per-allocation-key generation counter. Every NEW allocation attempt for a key (a first
   *  attempt, or a retry after invalidation) increments the key's generation and captures the
   *  post-increment value as its own identity token. A completion (resolve or reject) may only
   *  act on `surfaceMappingsRef`/cleanup if its captured token still equals the CURRENT value for
   *  that key — an older attempt whose token has been superseded is a no-op unconditionally,
   *  whether it settles before or after the newer attempt's own completion.
   *
   *  Two separate maps, deliberately NOT merged into one:
   *  - `allocationGenerationsRef` is the monotonically increasing counter per key. It is NEVER
   *    deleted, only incremented — if it were deleted on invalidation, the next attempt's token
   *    would restart from 1 and could collide with an EARLIER, already-invalidated attempt's own
   *    captured token of 1, letting a stale result masquerade as current (the exact bug this
   *    generation scheme exists to prevent).
   *  - `inFlightAllocationKeysRef` tracks which keys currently have a live, uncompleted request —
   *    this is what the allocation effect checks to decide "already in flight, don't fire a
   *    second request", and what invalidation clears to allow a fresh attempt to start.
   *
   *  CRITICAL INVARIANT — both maps are updated together, in a fixed order, ONLY through
   *  `invalidateAllocationKey` below (never independently): every invalidation path (lease reset
   *  via `clearSurfaceMappingsFor`, a pane closing via the cleanup effect further down) MUST
   *  advance the counter BEFORE clearing the in-flight marker. This is what makes an in-flight
   *  attempt invalid AT THE MOMENT of invalidation — not merely "eventually superseded once some
   *  later retry effect gets around to starting a new attempt for the same key". Advancing the
   *  counter only when a retry actually starts (rather than at invalidation time) leaves a window
   *  where an old attempt can resolve, find its token still current, and install stale data
   *  before any retry has even begun — exactly the gap this two-step, invalidate-first order
   *  closes. */
  const allocationGenerationsRef = useRef(new Map<string, number>());
  const inFlightAllocationKeysRef = useRef(new Set<string>());
  const allocationKindsRef = useRef(new Map<string, SurfacePaneKind>());

  /** Invalidates one allocation key: advances its generation counter FIRST, then frees its
   *  in-flight marker. Order matters — advancing the generation before freeing the marker means
   *  that ANY attempt already in flight for this key (its token captured at dispatch time) is
   *  stale the INSTANT this function returns, regardless of whether that attempt happens to
   *  resolve before or after some later retry effect gets around to starting a new attempt for
   *  the same key. Freeing the in-flight marker only AFTER that (not before, not without it)
   *  is what lets a subsequent render actually start that fresh attempt.
   *
   *  This is the single choke point for "this key's in-flight attempt, if any, must never be
   *  allowed to install anything again" — both `clearSurfaceMappingsFor` (scope/lease
   *  invalidation) and the close-cleanup effect below (pane closed) call this for every key they
   *  invalidate, rather than each reimplementing the same two-step order. */
  const invalidateAllocationKey = useCallback((allocationKey: string): void => {
    const generations = allocationGenerationsRef.current;
    generations.set(allocationKey, (generations.get(allocationKey) ?? 0) + 1);
    inFlightAllocationKeysRef.current.delete(allocationKey);
  }, []);

  /** Clears every mapping for `connectionId`/`workspaceId`. Called synchronously from
   *  `onLeaseInvalidated` (before the reporter's own reacquire dispatch fires) so a stale
   *  registration id from a since-restarted backend is never handed back to a fresh lease. Also
   *  bumps `surfaceMappingVersion` when it invalidates an in-flight allocation attempt with no
   *  mapping yet (not just when it deletes an existing mapping) — that bump is what re-triggers
   *  the allocation effect's retry pass for the key it just freed; without it, a key invalidated
   *  before its first allocation ever resolved would sit unretried until an unrelated pane-content
   *  change happened to re-run that effect. */
  const clearSurfaceMappingsFor = useCallback((connectionId: string, workspaceId: string) => {
    const mappings = surfaceMappingsRef.current;
    let changed = false;
    for (const [uiPaneId, entry] of mappings) {
      if (entry.backendConnectionId === connectionId && entry.workspaceId === workspaceId) {
        mappings.delete(uiPaneId);
        changed = true;
      }
    }
    // Invalidate any allocation attempt in flight for this connection/workspace — advancing its
    // generation (via `invalidateAllocationKey`) makes any already-dispatched attempt for it
    // permanently stale AT THIS POINT, not merely "eventually superseded" once a retry starts;
    // freeing its in-flight marker in the same call is what then lets the allocation effect
    // start that retry. Keyed by `${connectionId}\0${workspaceId}\0${uiPaneId}`, matching
    // `allocationKey` below.
    const prefix = `${connectionId}\u0000${workspaceId}\u0000`;
    for (const key of Array.from(inFlightAllocationKeysRef.current)) {
      if (key.startsWith(prefix)) {
        invalidateAllocationKey(key);
        changed = true;
      }
    }
    if (changed) setSurfaceMappingVersion((v) => v + 1);
  }, [invalidateAllocationKey]);

  // ---------------------------------------------------------------------
  // Every uiPaneId currently open for the active project, across ALL of its trees — not just the
  // active/visible slot. Recomputed only when the active project's own openPanesMap keys change
  // (identity-stable inputs avoid resubmitting on every unrelated project's pane churn).
  // ---------------------------------------------------------------------------
  const activeProjectOpenUiPaneIds = useMemo(() => {
    if (!activeProjectId) return [] as string[];
    const prefix = `${activeProjectId}::`;
    const ids = new Set<string>();
    for (const [key, uiPaneIds] of Object.entries(openPanesMap)) {
      if (!key.startsWith(prefix)) continue;
      for (const id of uiPaneIds) ids.add(id);
    }
    return Array.from(ids);
  }, [openPanesMap, activeProjectId]);

  // Allocate a server-side surface registration for every open, not-yet-mapped surface-kind
  // PaneItem. Runs on every relevant change; internally deduped per uiPaneId via
  // `inFlightAllocationKeysRef` (an allocation already in flight for this exact key is left
  // alone) and per already-mapped uiPaneId via `surfaceMappingsRef`, so a rapid succession of
  // renders before the first allocation resolves never fires a second request for the same pane.
  //
  // Depends on `surfaceMappingVersion` in addition to the pane-content inputs: invalidation
  // (`clearSurfaceMappingsFor`, called from `onLeaseInvalidated`) frees a key for retry by
  // clearing its in-flight marker, but that alone changes no OTHER dependency here — without this
  // dependency, a key freed by invalidation would sit unretried until some unrelated pane-content
  // change happened to re-run this effect. `clearSurfaceMappingsFor` already bumps the version
  // whenever it actually clears something, so this effect re-scans exactly when there is
  // something new to (re)allocate.
  useEffect(() => {
    if (!paneInspectionEnabled || !activeProjectId) return;
    const connectionId = activeBackendConnectionId;
    const workspaceId = activeProjectId;

    for (const uiPaneId of activeProjectOpenUiPaneIds) {
      if (isBareNodeId(uiPaneId)) continue; // bare nodeId — resolves directly, no allocation.
      const item = paneItems[uiPaneId];
      if (!item || item.kind === 'agent-run') continue; // agent-run resolves directly too.
      if (!isSurfaceKind(item.kind)) continue; // Unknown/future kind — nothing to allocate yet.

      const existing = surfaceMappingsRef.current.get(uiPaneId);
      if (existing && existing.backendConnectionId === connectionId && existing.workspaceId === workspaceId && existing.kind === item.kind) continue;

      const allocationKey = `${connectionId}\u0000${workspaceId}\u0000${uiPaneId}`;
      if (allocationKindsRef.current.get(allocationKey) !== item.kind) {
        invalidateAllocationKey(allocationKey);
        allocationKindsRef.current.set(allocationKey, item.kind);
      }
      if (inFlightAllocationKeysRef.current.has(allocationKey)) continue; // Already in flight.
      inFlightAllocationKeysRef.current.add(allocationKey);

      // The generation counter is monotonic and NEVER deleted (see `allocationGenerationsRef`'s
      // doc comment) — an invalidated-then-retried attempt for the same key always gets a
      // strictly higher token than any attempt that came before it, so two attempts for the same
      // key can never collide on the same token no matter how many times the key is invalidated
      // and retried.
      const generations = allocationGenerationsRef.current;
      const token = (generations.get(allocationKey) ?? 0) + 1;
      generations.set(allocationKey, token);

      void allocateSurfaceRegistration(connectionId, workspaceId, item.kind)
        .then((result) => {
          // This attempt's token must still be the CURRENT one for this key — a superseding newer
          // attempt (started after this one was invalidated) has already bumped the counter past
          // this token, so a stale attempt's settlement can never install a mapping. This check
          // does not care about resolve-vs-reject ORDER between two attempts for the same key —
          // only whether THIS token is still current.
          if (generations.get(allocationKey) !== token) return;
          inFlightAllocationKeysRef.current.delete(allocationKey);
          surfaceMappingsRef.current.set(uiPaneId, {
            kind: item.kind as SurfacePaneKind,
            registrationId: result.registrationId,
            backendConnectionId: connectionId,
            workspaceId,
          });
          setSurfaceMappingVersion((v) => v + 1);
        })
        .catch(() => {
          // Best-effort: leave this pane unresolved (it is simply omitted from the next
          // submission, per `resolveViewSource`'s own contract) and let a future render retry.
          // Same stale-token guard as the success path — a rejected OLD attempt must not clear
          // the in-flight marker a newer attempt is currently using.
          if (generations.get(allocationKey) === token) inFlightAllocationKeysRef.current.delete(allocationKey);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneInspectionEnabled, activeProjectId, activeBackendConnectionId, activeProjectOpenUiPaneIds, paneItems, surfaceMappingVersion]);

  // Remove mappings for panes that are no longer open anywhere in the active project, so a
  // closed-then-reopened surface pane gets a fresh registration rather than resurrecting a stale
  // one, and so the map doesn't grow unboundedly across a long session.
  //
  // Also invalidates any allocation attempt still IN FLIGHT for a closed uiPaneId — not just
  // mappings that already landed. Without this, a pane closed while its first allocation was
  // still pending would leave that key's in-flight marker set forever (nothing else ever clears
  // it), so reopening the same uiPaneId would see "already in flight" and never issue a fresh
  // request; and if the original attempt happened to resolve after the close, it would still
  // read as current and install a mapping for a pane that isn't open anymore. Uses
  // `invalidateAllocationKey` (advance-generation-then-free-marker, in that order) for the exact
  // same reason `clearSurfaceMappingsFor` does — see that function's own doc comment. Scoped to
  // the CURRENT active connection/workspace: an in-flight attempt for a closed uiPaneId could
  // only ever have been dispatched under the scope that was active when it started, and by the
  // time this effect runs the pane's own scope-mismatched entries (if any, from a workspace
  // switch) are already handled by `resolveViewSource`'s scope check and by
  // `clearSurfaceMappingsFor` on the OLD scope's own invalidation path.
  useEffect(() => {
    const openSet = new Set(activeProjectOpenUiPaneIds);
    const mappings = surfaceMappingsRef.current;
    let changed = false;
    for (const uiPaneId of Array.from(mappings.keys())) {
      if (!openSet.has(uiPaneId)) {
        mappings.delete(uiPaneId);
        changed = true;
      }
    }
    if (activeProjectId) {
      const allocationKey = (paneId: string) => `${activeBackendConnectionId}\u0000${activeProjectId}\u0000${paneId}`;
      for (const key of Array.from(inFlightAllocationKeysRef.current)) {
        // Extract just the uiPaneId segment (the third `\0`-delimited part) to check openness —
        // cheaper than re-deriving it from `allocationKey` for every open id.
        const paneId = key.slice(key.lastIndexOf('\u0000') + 1);
        if (key === allocationKey(paneId) && !openSet.has(paneId)) {
          invalidateAllocationKey(key);
          changed = true;
        }
      }
    }
    if (changed) setSurfaceMappingVersion((v) => v + 1);
  }, [activeProjectOpenUiPaneIds, activeProjectId, activeBackendConnectionId, invalidateAllocationKey]);

  // ---------------------------------------------------------------------
  // Resolver — pure lookup, no allocation side effects of its own (allocation happens in the
  // effect above; this only reads whatever has already landed). Recomputed when the mapping
  // version bumps or the relevant inputs change, so its identity stays stable across renders that
  // don't actually change what it would resolve — `usePanePresenceReporter`'s submission effect
  // lists `resolveViewSource` as a dependency, so an unstable identity here would resubmit every
  // render.
  //
  // Surface mappings are checked against the CURRENT active scope (`activeBackendConnectionId` +
  // `activeProjectId`) before being trusted: a mapping recorded for a different
  // connection/workspace (e.g. left over from before a workspace switch, or — in principle — a
  // uiPaneId string that happens to collide across two different projects' pane maps) must be
  // treated exactly like "not yet allocated" rather than resurrected under the new scope. The
  // allocation effect above already re-allocates in that case; this resolver only has to avoid
  // reporting the stale one in the meantime.
  // ---------------------------------------------------------------------------
  const resolveViewSource: PanePresenceIdResolver = useCallback((uiPaneId: string): PanePresenceViewSource | undefined => {
    if (isBareNodeId(uiPaneId)) {
      return { target: { kind: 'node', nodeId: uiPaneId } };
    }
    const item = paneItems[uiPaneId];
    if (!item) return undefined;
    if (item.kind === 'agent-run') {
      return {
        target: { kind: 'agent-run', backendConnectionId: item.backendConnectionId, runId: item.runId },
        surfaceTitle: item.title || null,
      };
    }
    const mapping = surfaceMappingsRef.current.get(uiPaneId);
    if (!mapping) return undefined; // Not yet allocated — omitted from this submission.
    if (mapping.backendConnectionId !== activeBackendConnectionId || mapping.workspaceId !== activeProjectId || mapping.kind !== item.kind) {
      return undefined; // Stale scope — omitted until reallocated for the current scope.
    }
    return {
      target: { kind: 'surface', registrationId: mapping.registrationId },
      surfaceTitle: item.title || null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneItems, surfaceMappingVersion, activeBackendConnectionId, activeProjectId]);

  // ---------------------------------------------------------------------
  // The single PanePresenceBackendSlots entry for the active project. Stable-identity when
  // nothing relevant changed, so the reporter's submission effect (which lists `backends` as a
  // dependency) doesn't resubmit on every unrelated render.
  //
  // Retain this integration's lease-scope key for its transport and invalidation callbacks.
  // The reporter also isolates leases by connection/workspace/window; it is safe for callers
  // that pass raw connection IDs too. The transport below restores the real connection ID.
  // ---------------------------------------------------------------------------
  const activeSlotKey = activeProject && dashboardVisible
    ? `${activeProject.id}::${activeProject.activeTreeId ?? 'workspace'}`
    : null;

  const activeProjectOpenPanesMap = useMemo(() => {
    if (!activeProjectId) return {};
    const prefix = `${activeProjectId}::`;
    const slots: Record<string, string[]> = {};
    for (const [key, uiPaneIds] of Object.entries(openPanesMap)) {
      if (key.startsWith(prefix)) slots[key] = uiPaneIds;
    }
    return slots;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPanesMap, activeProjectId]);

  const leaseScopeKey = activeProject ? `${activeBackendConnectionId}\u0000${activeProject.id}` : null;

  const backends: PanePresenceBackendSlots[] = useMemo(() => {
    if (!activeProject || !paneInspectionEnabled || !leaseScopeKey) return [];
    return [{
      backendConnectionId: leaseScopeKey,
      workspaceId: activeProject.id,
      openPanesMap: activeProjectOpenPanesMap,
      activeSlotKey,
    }];
  }, [activeProject, paneInspectionEnabled, leaseScopeKey, activeProjectOpenPanesMap, activeSlotKey]);

  /** Un-mangles a lease-scope key (`${backendConnectionId}::${workspaceId}`) back to the real
   *  `backendConnectionId` for the real transport / for `onLeaseInvalidated` callers. The
   *  reporter always hands back exactly the key it was given as `connectionId` (see
   *  `usePanePresenceReporter`'s `submitForConnection`/keepalive — it never rewrites that
   *  parameter), so this is a safe, lossless inverse of how `leaseScopeKey` above is constructed. */
  const unmangleConnectionId = useCallback((leaseScope: string): string => {
    const sepIndex = leaseScope.indexOf('\u0000');
    return sepIndex === -1 ? leaseScope : leaseScope.slice(0, sepIndex);
  }, []);

  const leaseScopedTransport = useMemo(() => ({
    submit: (leaseScope: string, workspaceId: string, req: Parameters<typeof panePresenceTransport.submit>[2]) =>
      panePresenceTransport.submit(unmangleConnectionId(leaseScope), workspaceId, req),
    remove: (leaseScope: string, workspaceId: string, req: Parameters<typeof panePresenceTransport.remove>[2]) =>
      panePresenceTransport.remove(unmangleConnectionId(leaseScope), workspaceId, req),
    keepalive: (leaseScope: string, workspaceId: string, req: Parameters<typeof panePresenceTransport.keepalive>[2]) =>
      panePresenceTransport.keepalive(unmangleConnectionId(leaseScope), workspaceId, req),
  }), [unmangleConnectionId]);

  const onLeaseInvalidated = useCallback((leaseScope: string, workspaceId: string) => {
    clearSurfaceMappingsFor(unmangleConnectionId(leaseScope), workspaceId);
  }, [clearSurfaceMappingsFor, unmangleConnectionId]);

  usePanePresenceReporter({
    hydrated,
    windowId,
    backends,
    resolveViewSource,
    transport: leaseScopedTransport,
    onLeaseInvalidated,
  });
}
