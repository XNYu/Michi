/**
 * PaneInspectionService — the caller-scoped `inspect` entry point.
 *
 * This is the keystone assembling P1-1's shared contract, P1-2/P1-3's pure projections, P1-4's
 * count queries, P1-5's ChatHub read-only observation, and P2-1's presence registry behind one
 * authorised entry point. P1-7 (`readOutput`) and P2-4 (`list`) reuse `resolvePaneTarget` and
 * `authorizeCaller` rather than duplicating locator/permission logic — see the exports at the
 * bottom of this file.
 *
 * Design: docs/pane-inspection-api-design-2026-09-14.md §4 (identity), §6 (semantics), §7.2
 * (inspect_pane), §10 (permissions). COMMON.md decisions 6, 7, 8, 9, 10.
 *
 * No side effects: no ensureSession/newSession, no claim, no cancel, no lazy conversation load,
 * no focus or active-tree change, no file reads (COMMON.md decision 10 / brief §6).
 */

import {
  AgentPolicyCategory,
  AgentPolicyDecision,
  AgentRunEventType,
  decodePaneId,
  encodePaneId,
  PANE_INSPECTION_ERROR_CODES,
  PANE_INSPECTION_LIMITS,
  PaneInspectionError,
  type AgentRunEventV1,
  type ExecutionRef,
  type PaneDescriptorV1,
  type PaneLocator,
  type PaneTarget,
} from 'michi-shared';
import { chatHub, type ChatObservationSnapshot } from '../agents/chatHub';
import { agentRunToDescriptor, type AgentRunCancellationEventsInput } from './paneInspectionProjection.run';
import { chatNodeToDescriptor } from './paneInspectionProjection.chat';
import { surfaceToDescriptor, SURFACE_PANE_KINDS, type SurfacePaneKind } from './paneInspectionProjection.surface';
import { paneInspectionRing, type AuthorizationScope } from './paneInspectionRing';
import {
  getAiGlobalContext,
  getCompletedTurnCount,
  getMessageCountsByNode,
  getNode,
  getWorkspace,
  listEdges,
  type NodeRow,
  type TurnRow,
} from './dbRepository';
import { getDb } from './db';
import { AgentRunsRepository } from './agentRunsRepository';
import { panePresenceRegistry } from './panePresence';

/** Re-exported under the old name so the P1-6b surface tests keep compiling. They now exercise the
 *  SAME instance the presence routes write to, which is the point of the fix: previously this
 *  module built its own registry, so a view submitted through `PUT /api/panes/presence` was
 *  invisible here and every descriptor reported `coverage: 'unknown'`. */
export { panePresenceRegistry as __testOnlyPanePresenceRegistry };

// ---------------------------------------------------------------------------
// Caller context — server-derived only. Never constructed from request-body fields.
// ---------------------------------------------------------------------------

/**
 * The authenticated/session-bound caller, resolved upstream (route auth middleware, or the
 * runtime-session-bound tool caller) and handed to this service as already-trusted data. This
 * service NEVER reads ownerUserId/workspaceId/backendConnectionId from a request payload —
 * brief step 2's "server-derived caller context only, never an id from the payload" applies to
 * every field here.
 *
 * `runOwner` is populated only when the CALLING session is itself an agent run (COMMON.md
 * decision 7 / design §10): a read-only tool must additionally respect that run's own Read policy
 * and context policy so it cannot bypass the Run's restrictions. This is about the CALLER's own
 * run, not the target object — inspecting an AgentRun as the *target* does not require this.
 */
export interface PaneInspectionCaller {
  ownerUserId: string;
  workspaceId: string;
  backendConnectionId: string;
  runOwner?: { runId: string } | null;
}

/** Maps a caller onto the ring's `AuthorizationScope` shape. MUST stay structurally identical to
 *  `paneInspectionSubscribe.ts`'s own private `scopeFor` — a cursor minted here under one scope
 *  shape and resolved there under a differently-derived one would never match, silently defeating
 *  the whole boundary this task closes. Both derive the same three fields from the same
 *  `PaneInspectionCaller` shape, so keeping this as the one shared export (rather than each file
 *  re-deriving it) removes the chance of the two drifting apart. */
export function scopeForCaller(caller: PaneInspectionCaller): AuthorizationScope {
  return { ownerUserId: caller.ownerUserId, workspaceId: caller.workspaceId, runOwnerId: caller.runOwner?.runId ?? null };
}

/**
 * The subset of a `PaneDescriptorV1` that constitutes "content" for the ring's revision
 * bookkeeping. MUST stay structurally identical to `paneInspectionSubscribe.ts`'s own private
 * `toContentSnapshot` — both this function and that one feed the SAME `PaneInspectionRing`
 * instance's `contentEquals` (deep-JSON) comparison for the SAME paneId, so a divergent shaping
 * here would make `inspect`'s baseline and `subscribePanes`'s first diff disagree about whether
 * anything actually changed, which is exactly the kind of gap this task exists to close. Strips
 * `observation.observedAt` (a plain re-read must never look like a change — design §8) and
 * `presence.views[].registeredAt/lastSeenAt` (keepalive-only fields) for the same reason
 * `paneInspectionSubscribe.ts` strips them. `cursor` is never part of "content" either way — it
 * is derived FROM the content, not a member of it, so including it here would be circular.
 */
function toRingContentSnapshot(descriptor: PaneDescriptorV1): unknown {
  const { observation, presence, ...rest } = descriptor;
  return {
    ...rest,
    observation: { freshness: observation.freshness },
    presence: {
      coverage: presence.coverage,
      views: presence.views.map((view) => ({
        windowId: view.windowId,
        uiPaneId: view.uiPaneId,
        treeId: view.treeId,
        visible: view.visible,
        openedAtClient: view.openedAtClient,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// §1 Locator resolution — exported for P1-7 / P2-4 reuse.
// ---------------------------------------------------------------------------

/**
 * Resolves a PaneLocator (paneId | nodeId | runId — exactly one, enforced upstream by
 * `parsePaneLocator`) into a PaneTarget, without touching the database. `paneId` is decoded via
 * the shared codec; `nodeId`/`runId` are wrapped directly. This function cannot fail on a
 * well-formed PaneLocator except when a `paneId` fails to decode (surfaces the codec's own
 * INVALID_ARGUMENT).
 */
export function resolvePaneTarget(locator: PaneLocator): PaneTarget {
  if ('paneId' in locator) return decodePaneId(locator.paneId);
  if ('nodeId' in locator) return { kind: 'node', nodeId: locator.nodeId };
  return { kind: 'agent_run', runId: locator.runId };
}

// ---------------------------------------------------------------------------
// §2 Authorisation — exported for P1-7 / P2-4 reuse.
// ---------------------------------------------------------------------------

export interface AuthorizedNodeTarget {
  kind: 'node';
  node: NodeRow;
}

export interface AuthorizedRunTarget {
  kind: 'agent_run';
  run: import('michi-shared').AgentRunDtoV1;
}

/** A surface registration that has passed authorisation: the caller's own workspace matches the
 *  registration's workspace, and the registration currently has a live presence view (an expired
 *  or unknown registrationId never reaches this shape — see `authorizeCaller` below). Carries
 *  exactly the fields `surfaceToDescriptor` needs beyond `observedAt`/`backendConnectionId`. */
export interface AuthorizedSurfaceTarget {
  kind: 'surface';
  registrationId: string;
  surfaceKind: SurfacePaneKind;
  workspaceId: string;
  treeId: string | null;
  rendererTitle: string | null;
}

export type AuthorizedTarget = AuthorizedNodeTarget | AuthorizedRunTarget | AuthorizedSurfaceTarget;

const runsRepository = new AgentRunsRepository();

/**
 * Authorises the caller against a resolved PaneTarget and returns the underlying row/DTO once
 * ownership and every applicable gate has passed. Reads NOTHING beyond what is needed to prove
 * visibility — no messages, no turns, no run attempts/events.
 *
 * Order of checks (brief step 2 / COMMON.md decisions 6, 7, 9):
 *  1. Existence + real workspace/owner ownership in the database (never inferred from the
 *     request). Anything not owned by the caller, or not found at all, is NOT_FOUND — the two
 *     cases are deliberately indistinguishable to the caller.
 *  2. The `aiGlobalContext` gate for the caller's OWN workspace. When off, the whole call fails
 *     NAVIGATION_DISABLED — this must happen before any title/lineage read, so a disabled gate
 *     can never leak a title past it.
 *  3. If the caller is itself an agent run (`caller.runOwner` set), that run's own
 *     `permissionPolicy.categories[Read] === Allow` and its `contextPolicy` must hold, loaded
 *     owner-scoped by `caller.ownerUserId` (never trusting a run id from the request).
 *
 * `surface` targets have no persistent database row to authorise against — surfaces are
 * presence-only (design §4.2). Authorisation instead checks that the registration currently has
 * a live view in the presence registry AND that view's own workspace matches the caller's
 * (added for P1-6b — this was previously an unconditional NOT_FOUND because P2-3's surface
 * projection did not yet exist on this branch when P1-6 was written).
 */
export function authorizeCaller(caller: PaneInspectionCaller, target: PaneTarget): AuthorizedTarget {
  // §2.2 caller's own AI-navigation gate — before any read of the TARGET.
  if (!getAiGlobalContext(caller.workspaceId, caller.ownerUserId)) {
    throw new PaneInspectionError('NAVIGATION_DISABLED', 'inspect', 'AI navigation is disabled for this workspace.');
  }

  // §2.3 caller's own Run policy, if the caller itself is an agent run.
  if (caller.runOwner) {
    const callerRun = runsRepository.getRun(caller.ownerUserId, caller.runOwner.runId);
    if (!callerRun) {
      // The caller's own run cannot be resolved owner-scoped — never trust the id blindly.
      throw new PaneInspectionError('NOT_FOUND', 'inspect', 'caller run not found');
    }
    const readDecision = callerRun.effectiveDefinition.permissionPolicy.categories[AgentPolicyCategory.Read];
    if (readDecision !== AgentPolicyDecision.Allow) {
      throw new PaneInspectionError('NAVIGATION_DISABLED', 'inspect', "caller Run's Read policy does not allow this.");
    }
    // contextPolicy has no single boolean "allowed" flag to check generically beyond the
    // Read category decision above — the policy's finer-grained flags (allowMessageContext,
    // allowFileContext, allowArtifactContext) govern what CONTEXT the run may assemble for
    // itself, not whether it may call a read-only inspection tool. Read is the gating category
    // per COMMON.md decision 7 / design §10 ("must additionally satisfy its own Run's Read
    // policy AND context policy") — contextPolicy is consulted by the tool layer (P1-9) when it
    // decides what to fold into the model's own context, not by this service.
  }

  // §2.1 existence + real ownership.
  if (target.kind === 'node') {
    const node = getNode(target.nodeId);
    if (!node) throw new PaneInspectionError('NOT_FOUND', 'inspect', 'target not found');
    const workspace = getWorkspace(node.workspace_id, caller.ownerUserId);
    if (!workspace || workspace.id !== caller.workspaceId) {
      throw new PaneInspectionError('NOT_FOUND', 'inspect', 'target not found');
    }
    return { kind: 'node', node };
  }

  if (target.kind === 'agent_run') {
    const run = runsRepository.getRun(caller.ownerUserId, target.runId);
    if (!run) throw new PaneInspectionError('NOT_FOUND', 'inspect', 'target not found');
    if (run.workspaceId !== caller.workspaceId) {
      throw new PaneInspectionError('NOT_FOUND', 'inspect', 'target not found');
    }
    return { kind: 'agent_run', run };
  }

  // target.kind === 'surface' — presence-only, no persistent database row (design §4.2). An
  // expired or unknown registrationId, or one belonging to another workspace, is NOT_FOUND — the
  // two cases are deliberately indistinguishable to the caller, matching the node/agent_run rule
  // above (COMMON.md decision 9).
  const info = panePresenceRegistry.getSurfaceRegistrationInfo(target.registrationId);
  if (!info || info.workspaceId !== caller.workspaceId || !SURFACE_PANE_KINDS.includes(info.kind as SurfacePaneKind)) {
    throw new PaneInspectionError('NOT_FOUND', 'inspect', 'target not found');
  }
  return {
    kind: 'surface',
    registrationId: target.registrationId,
    surfaceKind: info.kind as SurfacePaneKind,
    workspaceId: info.workspaceId,
    treeId: info.treeId,
    rendererTitle: info.rendererTitle,
  };
}

// ---------------------------------------------------------------------------
// §3 inspect — the deliverable.
// ---------------------------------------------------------------------------

export interface InspectPaneInput {
  locator: PaneLocator;
  executionRef?: ExecutionRef;
}

/**
 * The caller-scoped `inspect` query. Resolves the locator, authorises, fetches every input the
 * pure adapters need, and returns a PaneDescriptorV1.
 *
 * `chat` and `agent-run` targets route to the respective pure adapter. `digest` and `artifact`
 * are node-backed kinds (design §5.1) that this service also serves directly, per the brief's
 * "kind coverage" section — see `nodeKind`/`digestOrArtifactDescriptor` below. The seven
 * non-persistent surface kinds (launcher/files/review/file/diff/terminal/browser) have no
 * database row to resolve from a bare nodeId/runId locator and are only ever reached via a
 * `surface:` paneId; `authorizeCaller` resolves that against the presence registry and this
 * function delegates to P2-3's `surfaceToDescriptor` (added for P1-6b — P1-6 and P2-3 shipped in
 * the same wave and could not see each other; both are now present on this branch).
 */
export function inspect(caller: PaneInspectionCaller, input: InspectPaneInput): PaneDescriptorV1 {
  const target = resolvePaneTarget(input.locator);
  const authorized = authorizeCaller(caller, target);
  const observedAt = Date.now();

  if (authorized.kind === 'agent_run') {
    return inspectAgentRun(caller, authorized.run, input.executionRef, observedAt);
  }

  if (authorized.kind === 'surface') {
    // No side effects, no executionRef: surfaces have no execution concept to select a specific
    // historical attempt of (COMMON.md decision 10 / brief: "no side effects"). An executionRef
    // passed alongside a surface locator is simply ignored rather than validated against
    // anything, since ExecutionRef's own variants (`chat_turn` | `agent_run`) have no surface
    // form to validate against in the first place.
    const presence = panePresenceRegistry.getPresence({ kind: 'surface', registrationId: authorized.registrationId });
    return surfaceToDescriptor({
      registrationId: authorized.registrationId,
      kind: authorized.surfaceKind,
      workspaceId: authorized.workspaceId,
      treeId: authorized.treeId,
      rendererTitle: authorized.rendererTitle,
      presence,
      backendConnectionId: caller.backendConnectionId,
      observedAt,
    });
  }

  return inspectNode(caller, authorized.node, input.executionRef, observedAt);
}

// ---------------------------------------------------------------------------
// Chat / digest / artifact (all node-backed)
// ---------------------------------------------------------------------------

function inspectNode(
  caller: PaneInspectionCaller,
  node: NodeRow,
  executionRef: ExecutionRef | undefined,
  observedAt: number,
): PaneDescriptorV1 {
  if (executionRef) validateExecutionRefForNode(node, executionRef);

  const nodeKind = mapNodeKindToPaneKind(node.kind);
  if (nodeKind === 'digest') return digestDescriptor(caller, node, observedAt);
  if (nodeKind === 'artifact') return artifactDescriptor(caller, node, observedAt);

  // 'chat' (and any other persisted node.kind we don't otherwise special-case — treated as chat,
  // matching design §5.1's "所有现有 pane 类型都有基础描述" and this task's chat/digest/artifact
  // coverage; a future node kind would need its own adapter, not a silent chat coercion, but no
  // such kind exists on this branch today).
  return chatDescriptor(caller, node, executionRef, observedAt);
}

function chatDescriptor(
  caller: PaneInspectionCaller,
  node: NodeRow,
  executionRef: ExecutionRef | undefined,
  observedAt: number,
): PaneDescriptorV1 {
  const paneId = encodePaneId({ kind: 'node', nodeId: node.id });
  const scope = scopeForCaller(caller);

  // §8 boundary: attach the ring's subscriber registration (the "domain listener") BEFORE
  // reading the source snapshot, then read the snapshot together with its native watermark in
  // one call — ChatHub.getSnapshot(nodeId) already returns `{ ..., cursor: {turnId, seq} }` as
  // one atomic, synchronous read (this process has no separate "read snapshot" / "read
  // watermark" round trip for chat to race between — see alignChatObservation's own doc comment
  // for why the bounded retry still exists despite that). Released again below once the
  // baseline snapshot has actually been minted — inspect() is a single request/response, not a
  // live subscription, so holding the LRU-eviction exemption open past this function's return
  // would starve every OTHER object's eviction candidacy for no reason.
  paneInspectionRing.registerSubscriber(paneId, scope);
  let effectiveObservation: ChatObservationSnapshot | null;
  try {
    effectiveObservation = alignChatObservation(node.id);
  } finally {
    paneInspectionRing.releaseSubscriber(paneId);
  }

  const durableTurn = fetchLatestTurnForNode(node.id, caller.ownerUserId);
  const counts = getMessageCountsByNode(node.id, caller.ownerUserId);
  const turns = getCompletedTurnCount(node.id, caller.ownerUserId);
  const lineage = buildChatLineage(node, caller);
  const runtime = buildRuntimeSummary(node);
  const presence = panePresenceRegistry.getPresence({ kind: 'node', nodeId: node.id });

  // executionRef honouring (brief step 4 / design §7.2): when the caller asked for a specific
  // historical turn rather than "most recent", and that turn is not the one ChatHub/durableTurn
  // already resolved to, re-point the projection's inputs at that turn's own durable row so the
  // returned execution/latestOutput describe THAT turn, not the newest one. validateExecutionRefForNode
  // already proved the ref belongs to this node.
  let effectiveDurableTurn = durableTurn;
  if (executionRef && executionRef.kind === 'chat_turn' && executionRef.turnId !== effectiveObservation?.turnId) {
    const requestedTurn = fetchTurnById(executionRef.turnId, caller.ownerUserId);
    // requestedTurn is guaranteed non-null here: validateExecutionRefForNode already confirmed
    // this turnId exists and belongs to this node before we got this far.
    effectiveDurableTurn = requestedTurn;
    // The requested turn is not the one ChatHub is currently tracking in memory (or ChatHub has
    // no observation at all) — report the durable outcome only, never mix in a *different*
    // turn's live observation.
    effectiveObservation = effectiveObservation && effectiveObservation.turnId === executionRef.turnId ? effectiveObservation : null;
  }

  const descriptor = chatNodeToDescriptor({
    node,
    observation: effectiveObservation,
    durableTurn: effectiveDurableTurn,
    counts,
    turns,
    lineage,
    runtime,
    presence,
    backendConnectionId: caller.backendConnectionId,
    observedAt,
  });

  return mintChatCursor(descriptor, paneId, scope);
}

// ---------------------------------------------------------------------------
// §8 snapshot→subscribe boundary — chat
// ---------------------------------------------------------------------------

/** Bounded attempts to read a self-consistent `{observation, watermark}` pair before giving up
 *  (design §8: "初始化有界... 无法对齐则返回 unavailable/resync，不能无限循环"). `chatHub.
 *  getSnapshot(nodeId)` already returns the observation and its own native watermark
 *  (`observation.cursor`, `{turnId, seq}` — ChatHub's own doc comment on `ChatObservationSnapshot
 *  .cursor`) from ONE synchronous read, so in THIS process there is no window between "read the
 *  watermark" and "read the snapshot" for an event to land in — they are literally the same
 *  property access. The bound below exists anyway, for two real reasons rather than an imagined
 *  one: (1) it is the mechanism that proves the "no gap" claim rather than merely asserting it —
 *  a second read that disagrees with the first is exactly the signal a real race would produce,
 *  and this function is what turns that signal into a decision instead of silently trusting
 *  whichever read happened to run; (2) `getSnapshot` calls `findLogByNodeId`, which is NOT a
 *  single map lookup — it scans candidate turns and picks the "best" one by status/startedAt, so
 *  two back-to-back calls at the same instant SHOULD always agree if nothing changed, and
 *  disagreeing here would be the caller-visible symptom of the underlying source not settling
 *  (e.g. a future async ChatHub backing store). No timer/clock is needed to bound this: each
 *  attempt is a plain synchronous read, so a fixed attempt count already bounds wall-clock time
 *  by construction, unlike PANE_INSPECTION_RING's own age/count/byte bounds which need a clock
 *  because they bound something that spans real elapsed time. */
const CHAT_ALIGNMENT_MAX_ATTEMPTS = 3;

function alignChatObservation(nodeId: string): ChatObservationSnapshot | null {
  let previous: ChatObservationSnapshot | null | undefined;
  for (let attempt = 0; attempt < CHAT_ALIGNMENT_MAX_ATTEMPTS; attempt += 1) {
    const current = chatHub.getSnapshot(nodeId);
    if (previous !== undefined && sameChatWatermark(previous, current)) return current;
    previous = current;
  }
  // Never settled within the bound — design §8 says force a resync rather than loop
  // indefinitely. There is nothing "unavailable" about the OBJECT here (the node itself is
  // authorised and exists — authorizeCaller already proved that), so SOURCE_UNAVAILABLE (not
  // NOT_FOUND) is the correct signal: the observation source could not be read consistently this
  // time, which is retryable, not a permanent absence.
  throw new PaneInspectionError('SOURCE_UNAVAILABLE', 'inspect', 'chat observation did not settle within the bounded alignment window');
}

function sameChatWatermark(a: ChatObservationSnapshot | null, b: ChatObservationSnapshot | null): boolean {
  if (a === null || b === null) return a === b;
  return a.cursor.turnId === b.cursor.turnId && a.cursor.seq === b.cursor.seq;
}

/** Publishes the aligned snapshot into the ring and overwrites the projection's own
 *  string-derived `observation.cursor` with the ring-minted token — the fix this task delivers.
 *  `chatNodeToDescriptor` (P1-2, not owned by this task) still computes its own `node:${id}`- or
 *  `turnId:seq`-shaped string for `observation.cursor` internally; this function replaces that
 *  value with a real `ring.resolveCursor`-recognisable token AFTER the descriptor is fully built,
 *  rather than threading a ring dependency into P1-2's file. `mintInspectionCursor` degrades to a
 *  no-op-for-revision on an unchanged repeat call (P3-1's own contract), which is exactly what
 *  makes "inspect run repeatedly does not advance revision" true here for free. */
function mintChatCursor(descriptor: PaneDescriptorV1, paneId: string, scope: AuthorizationScope): PaneDescriptorV1 {
  const content = toRingContentSnapshot(descriptor);
  const cursor = paneInspectionRing.mintInspectionCursor(paneId, scope, content);
  return { ...descriptor, observation: { ...descriptor.observation, cursor } };
}

/** design §5.1 footnote 1: digest execution is 'unknown' — its generation model (one-shot
 *  streaming, no durable turn, no retry) is deliberately deferred, not mapped onto the chat
 *  adapter. conversation/lineage/runtime beyond identity are 'unsupported' — a digest node is
 *  not a chat and does not have chat statistics. */
function digestDescriptor(caller: PaneInspectionCaller, node: NodeRow, observedAt: number): PaneDescriptorV1 {
  const presence = panePresenceRegistry.getPresence({ kind: 'node', nodeId: node.id });
  const paneId = encodePaneId({ kind: 'node', nodeId: node.id });
  const scope = scopeForCaller(caller);
  const descriptor: PaneDescriptorV1 = {
    version: 1,
    ref: { backendConnectionId: caller.backendConnectionId, paneId },
    target: { kind: 'node', nodeId: node.id },
    kind: 'digest',
    title: node.title ?? '',
    workspaceId: node.workspace_id,
    treeId: node.tree_id ?? null,
    archived: node.status === 'archived',
    truncatedFields: [],
    // Placeholder — `mintChatCursor` below overwrites this with a ring-minted token before the
    // descriptor is returned. Never the literal `node:${node.id}` pattern (P3-3b's whole point).
    observation: { observedAt, freshness: 'persisted', cursor: '' },
    capabilities: { readOutput: false, subscribe: true, waitForTerminal: false },
    activity: 'unknown',
    execution: { status: 'unknown', reason: 'Digest generation status is not modeled in the first release (design §5.1 footnote 1).' },
    timeline: { resourceCreatedAt: node.created_at, firstExecutionStartedAt: null },
    presence,
    conversation: { status: 'unsupported', reason: 'Digest is not a chat and has no message/turn model.' },
    lineage: { status: 'unsupported', reason: 'Digest lineage is not modeled in the first release.' },
    runtime: { status: 'unsupported', reason: 'Digest has no runtime binding.' },
    latestOutput: { status: 'unsupported', reason: 'Digest output is not modeled in the first release.' },
  };
  return mintChatCursor(descriptor, paneId, scope);
}

/** design §5.1: artifact execution is 'not_applicable' (never started/completed at all — it is a
 *  static object, not something that runs), distinct from digest's 'unknown'. */
function artifactDescriptor(caller: PaneInspectionCaller, node: NodeRow, observedAt: number): PaneDescriptorV1 {
  const presence = panePresenceRegistry.getPresence({ kind: 'node', nodeId: node.id });
  const paneId = encodePaneId({ kind: 'node', nodeId: node.id });
  const scope = scopeForCaller(caller);
  const descriptor: PaneDescriptorV1 = {
    version: 1,
    ref: { backendConnectionId: caller.backendConnectionId, paneId },
    target: { kind: 'node', nodeId: node.id },
    kind: 'artifact',
    title: node.title ?? '',
    workspaceId: node.workspace_id,
    treeId: node.tree_id ?? null,
    archived: node.status === 'archived',
    truncatedFields: [],
    // Placeholder — `mintChatCursor` below overwrites this with a ring-minted token before the
    // descriptor is returned. Never the literal `node:${node.id}` pattern (P3-3b's whole point).
    observation: { observedAt, freshness: 'persisted', cursor: '' },
    capabilities: { readOutput: false, subscribe: true, waitForTerminal: false },
    activity: 'not_applicable',
    execution: { status: 'ready', value: null },
    timeline: { resourceCreatedAt: node.created_at, firstExecutionStartedAt: null },
    presence,
    conversation: { status: 'unsupported', reason: 'Artifact is not a chat and has no message/turn model.' },
    lineage: { status: 'unsupported', reason: 'Artifact lineage is not modeled in the first release.' },
    runtime: { status: 'unsupported', reason: 'Artifact has no runtime binding.' },
    latestOutput: { status: 'unsupported', reason: 'Use existing file APIs to read Artifact content (design §5.1).' },
  };
  return mintChatCursor(descriptor, paneId, scope);
}

/** Maps a persisted `nodes.kind` value onto the shared `PaneKind` union. Only 'digest' and
 *  'artifact' get their own adapter here; every other persisted kind (including 'chat' and any
 *  value this service does not specifically recognise) is treated as a chat node — see the
 *  comment in `inspectNode`. */
function mapNodeKindToPaneKind(nodeKind: string): 'chat' | 'digest' | 'artifact' {
  if (nodeKind === 'digest') return 'digest';
  if (nodeKind === 'artifact') return 'artifact';
  return 'chat';
}

// ---------------------------------------------------------------------------
// AgentRun
// ---------------------------------------------------------------------------

function inspectAgentRun(
  caller: PaneInspectionCaller,
  run: import('michi-shared').AgentRunDtoV1,
  executionRef: ExecutionRef | undefined,
  observedAt: number,
): PaneDescriptorV1 {
  if (executionRef) validateExecutionRefForRun(run, executionRef);

  const paneId = encodePaneId({ kind: 'agent_run', runId: run.id });
  const scope = scopeForCaller(caller);

  // §8 boundary, Run side: `run.latestEventSeq` (from the single `getRun()` read already
  // performed by `authorizeCaller`) IS the native watermark — brief: "R2 established [it] is
  // written in the same transaction as every event append, so one getRun() is already
  // consistent". The alignment loop here bounds the ONE thing that is a genuinely separate read:
  // `listEvents`, fetched after `run` — see `alignRunEvents`'s own doc comment for exactly what
  // it guards against and why it is bounded rather than looping.
  paneInspectionRing.registerSubscriber(paneId, scope);
  let allEvents: AgentRunEventV1[];
  try {
    allEvents = alignRunEvents(caller, run);
  } finally {
    paneInspectionRing.releaseSubscriber(paneId);
  }

  const attempts = runsRepository.listAttempts(caller.ownerUserId, run.id);

  // executionRef honouring for a Run (design §7.2): if the caller named a specific historical
  // attempt via an ExecutionRef, the adapter must select and describe THAT attempt's outcome —
  // but ExecutionRef's `agent_run` variant only carries `runId`, not an attemptId, so "a specific
  // historical turn/run" for a Run means "this Run, regardless of which attempt is currently
  // active" — the Run's own terminal status/resultBundle already IS attempt-independent once the
  // Run itself is terminal. There is no per-attempt ExecutionRef in the shared contract to
  // disambiguate further; see the report for why this is a deliberate no-op beyond validation.
  const cancellationRequested = allEvents.filter((event) => event.type === AgentRunEventType.CancellationRequested);
  const selectedAttemptId = run.activeAttemptId
    ?? attempts.reduce((latest: string | null, attempt) => {
      if (!latest) return attempt.id;
      const latestAttempt = attempts.find((candidate) => candidate.id === latest);
      return latestAttempt && attempt.attemptIndex > latestAttempt.attemptIndex ? attempt.id : latest;
    }, null as string | null);
  const assistantEvents: AgentRunEventV1[] = selectedAttemptId
    ? allEvents.filter((event) => event.type === AgentRunEventType.Assistant && event.attemptId === selectedAttemptId)
    : [];

  const cancellation: AgentRunCancellationEventsInput = { cancellationRequested };
  const presence = panePresenceRegistry.getPresence({ kind: 'agent_run', runId: run.id });

  const descriptor = agentRunToDescriptor({
    run,
    attempts,
    assistantEvents,
    cancellation,
    presence,
    backendConnectionId: caller.backendConnectionId,
    observedAt,
  });

  return mintRunCursor(descriptor, paneId, scope);
}

/** Bounded attempts to fetch a run's event list that is still consistent with the watermark
 *  (`run.latestEventSeq`) already captured by the caller's single `getRun()` read (design §8 /
 *  brief: "a Run's latestEventSeq is written in the same transaction as every event append, so a
 *  single getRun() already gives a consistent pair"). `listEvents` itself is a second, later
 *  read — re-fetching `getRun` here and comparing `latestEventSeq` is what actually PROVES that
 *  no event landed between the watermark being captured and the events being read, rather than
 *  assuming a single-process SQLite deployment makes that impossible forever. Bounded exactly
 *  like `alignChatObservation` — a fixed attempt count over synchronous reads bounds wall-clock
 *  time by construction, no clock needed. */
const RUN_ALIGNMENT_MAX_ATTEMPTS = 3;

function alignRunEvents(caller: PaneInspectionCaller, run: import('michi-shared').AgentRunDtoV1): AgentRunEventV1[] {
  let watermark = run.latestEventSeq;
  for (let attempt = 0; attempt < RUN_ALIGNMENT_MAX_ATTEMPTS; attempt += 1) {
    const events = runsRepository.listEvents(caller.ownerUserId, run.id, -1, Math.max(1, watermark + 1));
    const recheck = runsRepository.getRun(caller.ownerUserId, run.id);
    // A run that vanished between authorizeCaller and here (deleted mid-request) is a real
    // absence, not a would-be alignment failure — surface it as SOURCE_UNAVAILABLE rather than
    // retrying against nothing.
    if (!recheck) break;
    if (recheck.latestEventSeq === watermark) return events;
    // The watermark moved since we captured it — realign to the NEW watermark and retry, rather
    // than returning events read against a now-stale bound.
    watermark = recheck.latestEventSeq;
  }
  throw new PaneInspectionError('SOURCE_UNAVAILABLE', 'inspect', 'agent run events did not settle within the bounded alignment window');
}

/** Mirrors `mintChatCursor` for the Run adapter — see that function's doc comment for why the
 *  overwrite happens here rather than inside `paneInspectionProjection.run.ts` (P1-3, not owned
 *  by this task). */
function mintRunCursor(descriptor: PaneDescriptorV1, paneId: string, scope: AuthorizationScope): PaneDescriptorV1 {
  const content = toRingContentSnapshot(descriptor);
  const cursor = paneInspectionRing.mintInspectionCursor(paneId, scope, content);
  return { ...descriptor, observation: { ...descriptor.observation, cursor } };
}

// ---------------------------------------------------------------------------
// executionRef validation (brief step 4: "reject if it does not belong to the target object or
// the caller's workspace")
// ---------------------------------------------------------------------------

function validateExecutionRefForNode(node: NodeRow, ref: ExecutionRef): void {
  if (ref.kind !== 'chat_turn') {
    throw new PaneInspectionError('INVALID_ARGUMENT', 'executionRef', 'executionRef.kind must be "chat_turn" for a chat/digest/artifact target');
  }
  if (ref.nodeId !== node.id) {
    throw new PaneInspectionError('INVALID_ARGUMENT', 'executionRef', "executionRef does not belong to the target object");
  }
  const row = getDb().prepare('SELECT node_id FROM turns WHERE turn_id = ?').get(ref.turnId) as { node_id: string } | undefined;
  if (!row || row.node_id !== node.id) {
    throw new PaneInspectionError('INVALID_ARGUMENT', 'executionRef', 'executionRef does not identify a known turn on this node');
  }
}

function validateExecutionRefForRun(run: import('michi-shared').AgentRunDtoV1, ref: ExecutionRef): void {
  if (ref.kind !== 'agent_run') {
    throw new PaneInspectionError('INVALID_ARGUMENT', 'executionRef', 'executionRef.kind must be "agent_run" for an agent-run target');
  }
  if (ref.runId !== run.id) {
    throw new PaneInspectionError('INVALID_ARGUMENT', 'executionRef', 'executionRef does not belong to the target object');
  }
}

// ---------------------------------------------------------------------------
// Turn fetching — no existing dbRepository export returns "the latest turn row for a node" or
// "a turn row by id" with owner scoping, so this service owns those two small, targeted SELECTs
// (adapters are pure by design — brief: "all database fetching is yours").
// ---------------------------------------------------------------------------

/** Owner/workspace-scoped fetch of the most recently started turn row for a node, or null if the
 *  node has no turn rows at all. Mirrors dbRepository's own owner-scoping convention exactly
 *  (`process.env.MICHI_CLOUD === '1' && userId` branch joining nodes/workspaces on
 *  owner_user_id, unscoped otherwise) rather than inventing a new one — COMMON.md decision 5. */
function fetchLatestTurnForNode(nodeId: string, userId?: string): TurnRow | null {
  const cloudScoped = process.env.MICHI_CLOUD === '1' && userId;
  const row = cloudScoped
    ? getDb().prepare(
        `SELECT t.* FROM turns t
         JOIN nodes n ON t.node_id = n.id
         JOIN workspaces w ON n.workspace_id = w.id
         WHERE t.node_id = ? AND w.owner_user_id = ?
         ORDER BY t.started_at DESC LIMIT 1`,
      ).get(nodeId, userId)
    : getDb().prepare(
        'SELECT * FROM turns WHERE node_id = ? ORDER BY started_at DESC LIMIT 1',
      ).get(nodeId);
  return (row as TurnRow | undefined) ?? null;
}

/** Owner/workspace-scoped fetch of a single turn row by its turn_id. Used only after
 *  `validateExecutionRefForNode` has already proven the turnId belongs to the caller-visible
 *  node, so this is a plain lookup rather than a second ownership check. */
function fetchTurnById(turnId: string, userId?: string): TurnRow | null {
  const cloudScoped = process.env.MICHI_CLOUD === '1' && userId;
  const row = cloudScoped
    ? getDb().prepare(
        `SELECT t.* FROM turns t
         JOIN nodes n ON t.node_id = n.id
         JOIN workspaces w ON n.workspace_id = w.id
         WHERE t.turn_id = ? AND w.owner_user_id = ?`,
      ).get(turnId, userId)
    : getDb().prepare('SELECT * FROM turns WHERE turn_id = ?').get(turnId);
  return (row as TurnRow | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Lineage — branch children only (see report: parent_node_id chosen over edges(kind='branch'))
// ---------------------------------------------------------------------------

function buildChatLineage(node: NodeRow, caller: PaneInspectionCaller) {
  const cloudScoped = process.env.MICHI_CLOUD === '1' ? caller.ownerUserId : undefined;

  const childRows = cloudScoped
    ? (getDb().prepare(
        `SELECT n.id FROM nodes n
         JOIN workspaces w ON n.workspace_id = w.id
         WHERE n.parent_node_id = ? AND n.purged_at IS NULL AND w.owner_user_id = ?
         ORDER BY n.created_at ASC`,
      ).all(node.id, cloudScoped) as Array<{ id: string }>)
    : (getDb().prepare(
        'SELECT id FROM nodes WHERE parent_node_id = ? AND purged_at IS NULL ORDER BY created_at ASC',
      ).all(node.id) as Array<{ id: string }>);

  const childrenTruncated = childRows.length > PANE_INSPECTION_LIMITS.childrenDefaultMax;
  const childNodeIds = childRows.slice(0, PANE_INSPECTION_LIMITS.childrenDefaultMax).map((row) => row.id);

  const treeRootNodeId = resolveTreeRootNodeId(node);
  const originMessageId = resolveOriginMessageId(node, caller);

  return {
    parentNodeId: node.parent_node_id ?? null,
    treeRootNodeId,
    childNodeIds,
    childrenTruncated,
    originMessageId,
  };
}

/** Reads the tree's own root_node_id (TreeRow), not the current UI active tree and not
 *  project.chatIds[0] (design §6.3: "不使用当前界面 active tree 或 project.chatIds[0] 代替"). Returns
 *  null when the node has no tree_id — allowed per design §6.3. */
function resolveTreeRootNodeId(node: NodeRow): string | null {
  if (!node.tree_id) return null;
  const row = getDb().prepare('SELECT root_node_id FROM trees WHERE id = ?').get(node.tree_id) as { root_node_id: string } | undefined;
  return row?.root_node_id ?? null;
}

/**
 * originMessageId is returned only when a reliable branch anchor exists (design §6.3): the
 * `branch` edge whose TARGET is this node carries `anchor_message_id` — the parent message this
 * node branched from. Returns null (never leaking existence) when: no such edge exists, the edge
 * has no anchor_message_id, or the edge's source node is not visible to this caller (deleted /
 * not owned) — a deleted or invisible source must not leak its identity via this field (design
 * §6.3: "来源已删除或不可见时返回 null，不泄露其身份").
 */
function resolveOriginMessageId(node: NodeRow, caller: PaneInspectionCaller): string | null {
  const edges = listEdges(node.workspace_id, caller.ownerUserId);
  const branchEdge = edges.find((edge) => edge.kind === 'branch' && edge.target_node_id === node.id);
  if (!branchEdge || !branchEdge.anchor_message_id) return null;
  const sourceNode = getNode(branchEdge.source_node_id);
  if (!sourceNode || sourceNode.workspace_id !== node.workspace_id) return null;
  return branchEdge.anchor_message_id;
}

// ---------------------------------------------------------------------------
// Runtime binding
// ---------------------------------------------------------------------------

/**
 * `contextUsagePercentage` has no real source on `NodeRow` today — there is no persisted column
 * tracking context-window usage percentage for a chat node (see report). This always returns
 * null for it; the design's Section<T> honesty rule (COMMON.md decision 8) is satisfied at the
 * OUTER level: `runtime` itself is still `status: 'ready'` (the runtime binding fields
 * runtimeId/modelId/providerId ARE real and available), but the one sub-field with no source is
 * `null` rather than a fabricated number — the design's PaneRuntimeSummary type models
 * `contextUsagePercentage` as `number | null` for exactly this "no real source" case, not as a
 * reason to mark the whole section unknown.
 */
function buildRuntimeSummary(node: NodeRow) {
  return {
    runtimeId: node.runtime_id ?? null,
    modelId: node.model_id ?? null,
    providerId: node.provider_id ?? null,
    contextUsagePercentage: null,
  };
}

// Re-export so tests / P1-7 / P2-4 can reference the error-code list without a second import path.
export { PANE_INSPECTION_ERROR_CODES };
