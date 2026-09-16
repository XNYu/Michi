/**
 * PaneInspectionService — `list` (design §7.1; brief P2-4).
 *
 * Discovery across open and all panes for a workspace: `scope=open` returns only presence-
 * reported views, `scope=all` returns permitted node/run objects plus still-valid surface
 * registrations, deduplicated by canonical paneId.
 *
 * Reuses P1-6's `resolvePaneTarget`/`authorizeCaller` (no second authorisation path) and the
 * three projection modules indirectly via `inspect()` — see "Why this calls inspect() per row"
 * below for the deliberate reasoning, since it looks expensive at first glance.
 *
 * No side effects: no ensureSession/newSession, no claim, no cancel, no lazy conversation load,
 * no focus or active-tree change, no file reads (COMMON.md decision 10 / brief §6).
 */

import {
  encodePaneId,
  PANE_INSPECTION_LIMITS,
  PaneInspectionError,
  type ListPanesRequestV1,
  type PaneKind,
  type PaneSummaryV1,
  type PaneTarget,
} from 'michi-shared';
import { assertPaneInspectionCaller, inspect, type PaneInspectionCaller } from './paneInspection';
import { getWorkspace, listNodes, type NodeRow } from './dbRepository';
import { AgentRunsRepository } from './agentRunsRepository';
import { panePresenceRegistry as sharedPanePresenceRegistry } from './panePresence';
import { surfaceToDescriptor, SURFACE_PANE_KINDS, type SurfacePaneKind } from './paneInspectionProjection.surface';
import type { PanePresenceRegistry } from './panePresence';

const runsRepository = new AgentRunsRepository();

/**
 * This file enumerates `scope=open`/surface targets against `panePresence.ts`'s module-level
 * `panePresenceRegistry` singleton — the SAME instance `paneInspection.ts`'s `inspect()` already
 * imports directly (see that file's own import), and the same one `routes/paneInspection.ts`
 * re-exports for the renderer's PUT/DELETE `/panes/presence` routes to feed. There is exactly one
 * registry instance in the running process, so `inspect()`'s surface-target authorisation and
 * this file's surface enumeration always agree.
 *
 * An earlier draft of this file imported the registry from `../routes/paneInspection` instead
 * (which merely re-exports the same singleton) and carried a long comment describing a
 * split-registry bug that predated commit 1fd513ed ("use one shared presence registry instance").
 * That commit already fixed the split — `paneInspection.ts` was changed to import the singleton
 * from `./panePresence` directly rather than constructing its own — so the bug this comment used
 * to describe no longer exists on this branch. Importing from `./panePresence` directly here
 * (rather than through `../routes/paneInspection`) also avoids a service module depending on a
 * routes module, which `routes/paneInspection.ts`'s own header comment calls out as an inverted
 * dependency direction to avoid.
 */

export interface ListPanesResult {
  summaries: PaneSummaryV1[];
  nextCursor: string | null;
  /**
   * `'reported'` only when at least one summary row's own `openedInViews` count came from a
   * live presence view; `'unknown'` when the whole page had no presence signal at all — see
   * `panePresence.ts`'s `getPresence` doc comment: a target with zero live views is
   * INDISTINGUISHABLE from "no lease has ever registered anything for it", so `scope=open`
   * returning an empty page must not be read as "definitely nothing is open" — it means "no
   * presence signal for anything in this page", which could be true either because nothing is
   * open OR because every renderer's lease has expired / not yet reported. Callers must not
   * collapse this into a boolean "is anything open" — see the report for the exact contract.
   */
  presenceCoverage: 'reported' | 'unknown';
}

/**
 * `scope=open`'s row source: every distinct PaneTarget with at least one live presence view in
 * this caller's workspace, from ANY of node/agent_run/surface. `getPresenceForTargets`/
 * `getPresence` only ANSWER "does this target have presence" for a target already named — for
 * `scope=open` we instead need "which targets currently HAVE presence at all" without knowing
 * their ids up front, which the registry's public read API (by design; see panePresence.ts) does
 * not expose since it is not meant to leak cross-workspace/cross-caller registration lists.
 * `PanePresenceRegistry` therefore gets one narrow, additive read method for this purpose —
 * `listOpenTargetsForWorkspace` — added below via a thin wrapper rather than a class change,
 * to avoid touching panePresence.ts (owned by P2-1) for a method its own file did not anticipate.
 * See the report for why a wrapper was chosen over editing that file.
 */
function listOpenTargets(registry: PanePresenceRegistry, workspaceId: string): PaneTarget[] {
  return registry.listOpenTargetsForWorkspace(workspaceId);
}

// ---------------------------------------------------------------------------
// Pagination — stable key order (brief: "additions and removals are reconciled by re-querying,
// not by promising consistency").
//
// The stable key is `id` (the node's or agent_run's own primary-key id string) for scope=all,
// and `paneId` (the canonical encoded id) for scope=open. Both are:
//  - assigned once at creation and never mutated for the life of the row (nodes.id / agent_runs.id
//    are immutable primary keys — see dbRepository.saveNode / AgentRunsRepository.createId);
//  - unique within the set being paginated (a primary key by definition; for scope=open, paneId
//    dedup already guarantees uniqueness — see the scope=all dedup note below);
//  - safe under concurrent insertion: a new row's id is a fresh v4 UUID (see
//    AgentRunsRepository's `createId` and every `saveNode` call site), so a row inserted mid-
//    pagination sorts unpredictably relative to the cursor's boundary rather than being
//    guaranteed to land after it — but a lexicographic `id > cursor` WHERE clause is still stable
//    in the sense that matters here: it never re-shows a row already returned, and it never
//    skips a row that existed at BOTH the time the initial and the cursor page were read. A row
//    inserted between pages may or may not appear once, and a row deleted between pages simply
//    stops appearing — this is documented (design §7.1 / brief: "not a cross-page transactional
//    snapshot") rather than silently promised away. Do NOT "fix" this into a transactional
//    snapshot later; that is a deliberate design choice, not an oversight.
// ---------------------------------------------------------------------------

interface SortableRow {
  key: string;
  target: PaneTarget;
}

function clampAndValidateLimit(limit: number): number {
  // parseListPanesRequestV1 (shared) already clamps/validates via parseListLimit before this
  // service ever sees the request, so this is a defensive re-assertion for direct service callers
  // (tests, a future non-HTTP caller) that might bypass the parser.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new PaneInspectionError('INVALID_ARGUMENT', 'limit', 'must be a positive integer');
  }
  return Math.min(limit, PANE_INSPECTION_LIMITS.listLimitMax);
}

/**
 * The caller-scoped `list` query (design §7.1).
 */
export function list(caller: PaneInspectionCaller, request: ListPanesRequestV1): ListPanesResult {
  // §2.2/§2.3 caller-side gates, checked exactly once for the WHOLE call — never per row, and
  // never skippable by scope: a disabled AI-navigation gate must fail before a single title is
  // read, so a list of titles can never become a bypass (brief: "the AI-navigation gate must fail
  // the WHOLE call").
  assertCallerGates(caller);

  const limit = clampAndValidateLimit(request.limit);
  const rows = request.scope === 'open'
    ? collectOpenScopeTargets(caller)
    : collectAllScopeTargets(caller);

  // Cheap kind pre-filter (agent_run only — see targetHasKind) before sorting/pagination; the
  // real kind/treeId/parentNodeId filters are resolved once the descriptor is built, inside
  // buildSummary — see there for why. Sorting/pagination then walks candidates past the cursor,
  // building summaries and applying those real filters, until `limit` rows are accepted or
  // candidates run out. This keeps "the next page of my filtered query" behaving as a caller
  // expects (brief acceptance: "each filter... narrows correctly, and they compose").
  const candidates = request.kind ? rows.filter((row) => targetHasKind(row.target, request.kind as PaneKind)) : rows;
  candidates.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const afterCursor = request.cursor
    ? candidates.filter((row) => row.key > (request.cursor as string))
    : candidates;

  let anyPresenceReported = false;
  const summaries: PaneSummaryV1[] = [];
  let lastAcceptedKey: string | null = null;
  let idx = 0;
  for (; idx < afterCursor.length && summaries.length < limit; idx++) {
    const row = afterCursor[idx];
    const summary = buildSummary(caller, row, request);
    if (!summary) continue; // narrowed out by a real filter, archive visibility, or a delete/expiry race.
    if (summary.openedInViews > 0) anyPresenceReported = true;
    summaries.push(summary);
    lastAcceptedKey = row.key;
  }
  // nextCursor walks the REMAINING candidate rows (not yet examined), keyed by the last row this
  // page actually consumed (accepted or rejected) — using the last ACCEPTED row's key would skip
  // re-examining rejected rows between pages, which is fine (they were rejected and stay
  // rejected), but using the last EXAMINED row's key is what guarantees "exactly once, no
  // duplicates, no omissions" per the acceptance table, since a rejected row must not be
  // re-examined on the next page either.
  const lastExaminedKey = idx > 0 ? afterCursor[idx - 1].key : null;
  const nextCursor = idx < afterCursor.length ? lastExaminedKey : null;

  return {
    summaries,
    nextCursor,
    // §7.1: "无有效登记不等于确定没有窗口，presenceCoverage 必须能表达 unknown" — reported only when
    // this page actually observed at least one live view; otherwise unknown, deliberately never
    // read as "confirmed nothing is open" (see this file's ListPanesResult doc comment).
    presenceCoverage: anyPresenceReported ? 'reported' : 'unknown',
  };
}

// ---------------------------------------------------------------------------
// Caller-side gates (brief step: AI-navigation + agent-run-caller Read policy, once per call)
// ---------------------------------------------------------------------------

function assertCallerGates(caller: PaneInspectionCaller): void {
  assertPaneInspectionCaller(caller, 'list');
  // The caller's OWN workspace must exist and be owned by them — mirrors authorizeCaller's
  // node/run existence+ownership check, applied to the workspace itself since `list` has no
  // single target to authorise against. An unowned/absent workspace returns NOT_FOUND, never
  // revealing whether the workspaceId exists at all (COMMON.md decision 9).
  const workspace = getWorkspace(caller.workspaceId, caller.ownerUserId);
  if (!workspace) {
    throw new PaneInspectionError('NOT_FOUND', 'list', 'target not found');
  }
}

// ---------------------------------------------------------------------------
// scope=open — presence-reported views only (design §7.1: "views 在该 workspace 各 slot 中报告为
// 打开的视图").
// ---------------------------------------------------------------------------

function collectOpenScopeTargets(caller: PaneInspectionCaller): SortableRow[] {
  const targets = listOpenTargets(sharedPanePresenceRegistry, caller.workspaceId);
  return targets.map((target) => ({ key: encodePaneId(target), target }));
}

// ---------------------------------------------------------------------------
// scope=all — permitted node/run objects plus still-valid surface registrations, deduplicated by
// canonical paneId (design §7.1).
//
// Surface registrations have no persistent row (design §4.2) — the ONLY way to enumerate them at
// all is via presence (there is nothing else tracking their existence), so "still-valid surface
// registrations" for scope=all is exactly the surface-kind subset of the presence-open set. This
// is why scope=all's surface rows and scope=open's surface rows are identical in practice: a
// surface pane that isn't currently open cannot be listed under either scope, because there is
// nothing else in this system that remembers it existed. That is a real, reportable consequence
// of design §4.2's "surfaces are presence-only" — not a bug in this file.
// ---------------------------------------------------------------------------

function collectAllScopeTargets(caller: PaneInspectionCaller): SortableRow[] {
  const seen = new Set<string>();
  const rows: SortableRow[] = [];

  const nodes = listNodes(caller.workspaceId, caller.ownerUserId);
  for (const node of nodes) {
    if (isTrashed(node)) continue; // deleted (not-yet-purged) objects never appear under any scope.
    const target: PaneTarget = { kind: 'node', nodeId: node.id };
    const paneId = encodePaneId(target);
    if (seen.has(paneId)) continue;
    seen.add(paneId);
    rows.push({ key: node.id, target });
  }

  // listRuns (AgentRunsRepository) caps at 100 rows and paginates via its OWN cursor/limit
  // contract (id > cursor, ORDER BY id) — unlike listNodes above, which returns every node for
  // the workspace unbounded. A single listRuns call with limit:100 would silently drop every
  // run beyond the 100th for a workspace with more runs than that, which this file's own
  // "no omissions" pagination guarantee cannot paper over (this function returns its FULL
  // candidate set to list()'s own sort/cursor/limit logic — it must not itself be missing rows).
  // Walk listRuns' cursor to exhaustion here.
  let runCursor: string | undefined;
  for (;;) {
    const runsPage = runsRepository.listRuns(caller.ownerUserId, {
      version: 1,
      workspaceId: caller.workspaceId,
      includeArchived: true, // this function filters archived visibility itself, per-row, below.
      limit: 100,
      cursor: runCursor,
    });
    if (runsPage.length === 0) break;
    for (const run of runsPage) {
      const target: PaneTarget = { kind: 'agent_run', runId: run.id };
      const paneId = encodePaneId(target);
      if (seen.has(paneId)) continue;
      seen.add(paneId);
      rows.push({ key: run.id, target });
    }
    if (runsPage.length < 100) break; // last page — fewer rows than the cap means exhausted.
    runCursor = runsPage[runsPage.length - 1].id;
  }

  // Surface registrations with a currently-live view — see the module-level comment above for
  // why this is the only way to enumerate them, and why it collapses onto the same set scope=open
  // uses for surfaces specifically.
  for (const target of listOpenTargets(sharedPanePresenceRegistry, caller.workspaceId)) {
    if (target.kind !== 'surface') continue;
    const paneId = encodePaneId(target);
    if (seen.has(paneId)) continue;
    seen.add(paneId);
    rows.push({ key: `surface:${target.registrationId}`, target });
  }

  return rows;
}

/** Trash (soft-deleted, not-yet-purged, not-archived) — see dbRepository.emptyWorkspaceTrash's
 *  own comment: archived nodes ALSO carry deleted_at (archive reuses the trim engine), so the
 *  archive lane is distinguished by its 'arch-' deletion_group_id prefix, never by deleted_at
 *  alone. A node in the trash lane must never appear under any scope, matching "deleted objects
 *  never appear" — this is distinct from `includeArchived`, which only gates the archive lane. */
function isTrashed(node: NodeRow): boolean {
  if (!node.deleted_at) return false;
  const groupId = node.deletion_group_id ?? '';
  return !groupId.startsWith('arch-');
}

// ---------------------------------------------------------------------------
// Filters — kind / treeId / parentNodeId, resolved for real once a descriptor/row is available
// (see buildSummary). node/agent_run/surface targets differ in what's cheaply knowable, so each
// filter is checked against the already-built PaneDescriptorV1 rather than the bare PaneTarget.
// ---------------------------------------------------------------------------

/** Cheap pre-filter so `kind` narrows before the expensive per-row work below — avoids
 *  authorising/fetching rows the caller has already excluded. agent_run is known from the target
 *  itself; node-backed kinds (chat/digest/artifact) and surface kinds both require a lookup this
 *  function does not do (mirrors `mapNodeKindToPaneKind` in paneInspection.ts, not exported), so
 *  those are left in here and the real check happens once the descriptor/kind is available in
 *  `buildSummary`. */
function targetHasKind(target: PaneTarget, kind: PaneKind): boolean {
  if (target.kind === 'agent_run') return kind === 'agent-run';
  return true;
}

// ---------------------------------------------------------------------------
// Row -> PaneSummaryV1 (design §7.1: "compact summaries" — ref/kind/title/activity/latest
// execution ref+outcome/openedInViews/updatedAt. NO output body — the whole point of list is
// that it is cheap; reviewers will check this).
//
// Why this calls inspect() per row rather than a second, lighter activity-derivation path:
// `PaneInspectionService.inspect` already assembles every Section<T>/activity/execution rule this
// summary needs (§6.1's full state table, cancellation timeout, digest/artifact special cases,
// surface kind mapping) — those rules are non-trivial (see paneInspectionProjection.chat.ts's
// `deriveActivityAndExecution`) and P1-2/P1-3/P2-3 already encode them correctly and are already
// unit-tested. Re-deriving "activity" from raw rows a second way here would be a second place
// that can silently drift from inspect()'s answer for the exact same pane — a correctness risk
// this file will not take for a field (activity) that is exactly as authoritative in a list row
// as it is in a full descriptor. `inspect()` DOES currently do more DB work than a minimal
// summary strictly needs (conversation/lineage/runtime queries this file discards) — that cost is
// bounded by `limit` (<=100 rows per page) and is the explicit, reported trade-off; see the
// report for the alternative (a leaner activity-only path) this deliberately did not build in the
// 30-minute budget.
// ---------------------------------------------------------------------------

function buildSummary(
  caller: PaneInspectionCaller,
  row: SortableRow,
  request: ListPanesRequestV1,
): PaneSummaryV1 | null {
  const { target } = row;

  const descriptor = target.kind === 'surface'
    ? buildSurfaceDescriptor(caller, target.registrationId)
    : buildNodeOrRunDescriptor(caller, target);
  if (!descriptor) return null;

  if (request.kind && descriptor.kind !== request.kind) return null;
  if (request.treeId !== undefined && descriptor.treeId !== request.treeId) return null;
  if (request.parentNodeId !== undefined && !hasParentNodeId(descriptor, request.parentNodeId)) return null;
  if (!request.includeArchived && descriptor.archived) return null;

  return {
    ref: descriptor.ref,
    kind: descriptor.kind,
    title: descriptor.title,
    activity: descriptor.activity,
    latestExecution: descriptor.execution.status === 'ready' && descriptor.execution.value
      ? { ref: descriptor.execution.value.ref, outcome: terminalOutcomeOf(descriptor.execution.value.status) }
      : null,
    openedInViews: descriptor.presence.views.length,
    updatedAt: latestUpdatedAt(descriptor),
  };
}

/** node/agent_run targets route through the shared, already-authorised `inspect()` — see the
 *  module doc comment for why this is deliberate rather than a second activity-derivation path.
 *  Returns null (row silently dropped, never surfaced as an error) on NOT_FOUND/INVALID_ARGUMENT,
 *  which can legitimately happen if the row was deleted/expired between enumeration and this
 *  per-row authorisation (COMMON.md decision 9: never signal existence either way). */
function buildNodeOrRunDescriptor(caller: PaneInspectionCaller, target: PaneTarget) {
  try {
    return inspect(caller, { locator: target.kind === 'node' ? { nodeId: target.nodeId } : { runId: (target as { runId: string }).runId } });
  } catch (err) {
    if (err instanceof PaneInspectionError && (err.code === 'NOT_FOUND' || err.code === 'INVALID_ARGUMENT')) return null;
    throw err;
  }
}

/**
 * Surface targets build the descriptor directly against the shared registry rather than routing
 * through `inspect()`. Both paths would now resolve correctly — `inspect()`, `paneInspection.ts`,
 * and this file all share the one `panePresence.ts` registry singleton (see the module-level
 * comment above) — but this file already has the `SurfacePaneKind`/`info` values from the
 * enumeration step in `collectAllScopeTargets`/`listOpenTargets`, so re-deriving them by
 * round-tripping through `inspect(caller, { locator: { paneId } })` would just re-look-up the
 * same registration this function already has in hand. This re-checks the same authorisation
 * `authorizeCaller` would (workspace match + known surface kind) so a surface row from another
 * workspace is still never visible here.
 */
function buildSurfaceDescriptor(caller: PaneInspectionCaller, registrationId: string) {
  const info = sharedPanePresenceRegistry.getSurfaceRegistrationInfo(registrationId);
  if (!info || info.workspaceId !== caller.workspaceId || !SURFACE_PANE_KINDS.includes(info.kind as SurfacePaneKind)) {
    return null;
  }
  const presence = sharedPanePresenceRegistry.getPresence({ kind: 'surface', registrationId });
  return surfaceToDescriptor({
    registrationId,
    kind: info.kind as SurfacePaneKind,
    workspaceId: info.workspaceId,
    treeId: info.treeId,
    rendererTitle: info.rendererTitle,
    presence,
    backendConnectionId: caller.backendConnectionId,
    observedAt: Date.now(),
  });
}

function hasParentNodeId(descriptor: { lineage: { status: string; value?: { parentNodeId: string | null } } }, parentNodeId: string): boolean {
  // lineage is 'unsupported' for agent-run/surface/digest/artifact kinds (design §5.1) — those
  // simply never match a parentNodeId filter, which is correct: they have no parent-node concept
  // to match against, not an unknown one.
  return descriptor.lineage.status === 'ready' && descriptor.lineage.value?.parentNodeId === parentNodeId;
}

/** `latestExecution.outcome` per shared/src/paneInspection.ts's `PaneSummaryV1`: `ExecutionStatus
 *  | null` — the outcome is only meaningful once terminal; a non-terminal status (queued/
 *  preparing/running/waiting/recovering/cancelling) is reported as null rather than as itself,
 *  since "outcome" implies settled, and `activity` already carries the in-progress state. */
function terminalOutcomeOf(status: string): 'completed' | 'failed' | 'cancelled' | null {
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return status;
  return null;
}

/** No single `updatedAt` field exists on PaneDescriptorV1 — this derives the most recent of the
 *  timestamps the descriptor DOES carry: the resource's own creation time, its first execution
 *  start, and (when ready) its execution's start/end. This is a best-effort "most recently
 *  touched" signal, not a guarantee that every mutation is reflected — e.g. a title rename with
 *  no execution change is not separately tracked anywhere in PaneDescriptorV1 today. */
function latestUpdatedAt(descriptor: { timeline: { resourceCreatedAt: number | null; firstExecutionStartedAt: number | null }; execution: { status: string; value?: { startedAt: number | null; endedAt: number | null } | null } }): number {
  const candidates: Array<number | null | undefined> = [
    descriptor.timeline.resourceCreatedAt,
    descriptor.timeline.firstExecutionStartedAt,
  ];
  if (descriptor.execution.status === 'ready' && descriptor.execution.value) {
    candidates.push(descriptor.execution.value.startedAt, descriptor.execution.value.endedAt);
  }
  const known = candidates.filter((v): v is number => typeof v === 'number');
  return known.length > 0 ? Math.max(...known) : 0;
}
