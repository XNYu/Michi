/**
 * Pane Inspection API — the SSE change feed's server-side logic (design §8, §11; brief P3-2).
 *
 * This module owns:
 *  - one `PaneFeed` per subscribed object per socket/response, wired through P3-1's
 *    `PaneInspectionRing` for retention, cursor minting/resolution and the subscriber ref-count
 *    that exempts a watched object from LRU eviction;
 *  - the polling loop that detects content changes for chat/digest/artifact/surface targets
 *    (there is no live ChatHub event bus to subscribe to — `chatHub.getSnapshot` is poll-only,
 *    see its own doc comment) and the `AgentRunEventBus` subscription that detects them
 *    immediately for AgentRun targets;
 *  - coalescing `output_changed` at `PANE_INSPECTION_LIMITS.outputChangedCoalesceMs`, while
 *    NEVER delaying a terminal event, a status/permission/cancellation transition, `removed`, or
 *    `access_revoked` behind that timer (design §8, brief acceptance item — the single most
 *    likely thing to get wrong in this task);
 *  - continuous re-authorisation: every send re-checks `authorizeCaller`, and a caller who loses
 *    access mid-stream gets `access_revoked` once and nothing else for that object afterward
 *    (design §10).
 *
 * NOT owned here (seams for later tasks — see this task's report):
 *  - P3-3: the snapshot→subscribe watermark handoff (inspect_pane returning a cursor that this
 *    feed can resume from without a gap). This module already resolves an incoming cursor via
 *    the ring and falls back to a fresh `snapshot` + `resync_required` when it cannot replay —
 *    P3-3's job is the OTHER end, making `inspect_pane`'s own cursor mint compatible.
 *  - P3-5 (`wait_pane`): this module's `PaneFeed` class is deliberately reusable for a single
 *    one-shot wait, not just a long-lived HTTP stream — see `PaneFeed.oncePerObject`'s doc
 *    comment.
 *  - P3-6: the frontend client. Nothing here assumes a particular transport framing beyond the
 *    plain `PaneFeedEventV1` objects this module hands its caller.
 *
 * Notification sources (design §8 "通知来源与刷新"; brief P3-4 — this revision):
 *  - Chat (`node` targets): a real `chatHub.subscribe(chatId, ...)` listener, not a poll. Any
 *    raw ChatHub event (chunk/tool_call/done/error/cancel_phase/...) triggers an immediate
 *    re-`inspect()`, which is the ONLY thing that ever decides the emitted event's shape (design
 *    §8: "changed... 客户端按 cursor 替换，不自行重算状态机" — the raw event is just the wake-up
 *    signal, exactly as `handleAgentRunEvent` already treats AgentRun events). This makes a
 *    terminal state observable at the authoritative commit moment (ChatHub only broadcasts
 *    `done`/`error` AFTER `persistence.finalize` resolves — see chatHub.ts's own commit-boundary
 *    comment) instead of up to `pollIntervalMs` late. See `armChatWatcher` below for exactly how
 *    chatId is resolved from the nodeId locator, and how the subscription is released.
 *  - Run (`agent_run` targets): unchanged from P3-2 — `AgentRunEventBus.subscribe`, which only
 *    ever fires from repository-committed events (`publishCommitted`'s own contract), so
 *    commit-before-broadcast already holds without a second listener path.
 *  - Presence: NOT a separate source. `PanePresenceRegistry` (P2-1's file, not owned here) has no
 *    listener/event hook of its own — registration, update, explicit close, and lease expiry all
 *    change what `getPresence()` returns on the NEXT read, and `toContentSnapshot`'s `presence`
 *    section already participates in this module's own content-equality diff. So every one of
 *    those four presence transitions is picked up as an ordinary `changed` the next time this
 *    object is re-inspected for ANY reason (a ChatHub event, a Run event, or — for an object with
 *    no live execution source at all, e.g. an idle/completed chat nobody is actively streaming
 *    to — the per-workspace metadata tick below). This satisfies design §8's presence bullet
 *    without a fifth notification path: presence has always been *content*, never its own
 *    trigger.
 *  - Non-execution metadata (title/lineage/archived/counts): a coalesced check per **observed
 *    workspace**, not per object — see `WorkspaceMetadataWatcher` below. This replaces P3-2's
 *    per-object poll, which is what this task's brief asked to change ("N objects in one
 *    workspace must cost one check, not N"). The check reads ONLY
 *    `dbRepository.getNodesMetadataByIds` (a new batched, chunked-at-900 query added for this
 *    task) — it never calls `inspect()` itself and never decides activity/execution — it exists
 *    purely to detect "does this object need a fresh inspect()" for an object with no live
 *    execution source telling it so, and when it finds a difference it triggers the SAME
 *    `handlePotentialChange(..., tryAuthorizedInspect(...))` path every other source uses. A
 *    metadata check can therefore never itself produce `execution_settled` — it has no
 *    execution-shaped field to classify one from (see `classifyChangeKind`, which only ever runs
 *    against a freshly re-inspected `PaneDescriptorV1`, not against this watcher's own diff).
 *
 * Design: docs/pane-inspection-api-design-2026-09-14.md §8 (event types, cursor semantics,
 * coalescing, notification sources), §10 (continuous authorisation), §11 (transport/resource
 * bounds). COMMON.md decisions 5, 8, 9, 10.
 */

import type { AgentRunEventV1 } from 'michi-shared';
import { AgentRunEventType, PANE_INSPECTION_LIMITS, PaneInspectionError, type PaneDescriptorV1, type PaneFeedEventV1 } from 'michi-shared';
import { authorizeCaller, inspect, resolvePaneTarget, type PaneInspectionCaller } from './paneInspection';
import { PaneInspectionRing, type AuthorizationScope } from './paneInspectionRing';
import type { AgentRunEventBus } from '../agents/runs/agentRunEventBus';
import { chatHub as systemChatHub, type ChatObservationSnapshot, type HubSubscriber } from '../agents/chatHub';
import { getNodesMetadataByIds, type NodeMetadataBatchEntry } from './dbRepository';

/**
 * Narrow read-only slice of `ChatHub`'s public surface this module actually needs — deliberately
 * NOT the full class, so a unit test can inject an in-memory fake with zero persistence/DB
 * dependency instead of driving the real process-wide `chatHub` singleton (which defaults to
 * `repositoryTurnPersistence`, i.e. real SQLite writes on `startTurn`). Defaults to the real
 * singleton in `PaneFeedDeps` below, so production route wiring needs no change.
 */
export interface ChatHubObservationPort {
  getSnapshot(nodeId: string): ChatObservationSnapshot | null;
  subscribe(chatId: string, sub: HubSubscriber, opts?: { fromTurnId?: string; fromSeq?: number }): () => void;
}

// ---------------------------------------------------------------------------
// Injected clock/timer ports — mirrors PaneInspectionRing's own "no Date.now() inside" contract
// so this module is exhaustively testable with fake timers (brief step 3).
// ---------------------------------------------------------------------------

export interface PaneSubscribeClock {
  now(): number;
  /** Node's `setTimeout`, injected so tests can use `node:timers` fake timers.
   *  Returns an opaque handle for `clearTimeout`. */
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemPaneSubscribeClock: PaneSubscribeClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

// ---------------------------------------------------------------------------
// Content-snapshot shaping — what participates in the ring's deep-equality change detection.
// ---------------------------------------------------------------------------

/** The subset of a PaneDescriptorV1 that constitutes "content" for revision purposes. Explicitly
 *  excludes `observation.observedAt` (a plain re-read must never look like a change — design §8:
 *  "快照中的这些采样时间不参与 cursor 的内容等价判断") and `presence.views[].lastSeenAt` (a
 *  keepalive renewing lastSeenAt is sampling-only, mirrors `recordPresenceKeepalive`'s own
 *  contract). Everything else — activity, execution, latestOutput, presence view membership,
 *  conversation/lineage/runtime — is real content and participates in the comparison.
 */
function toContentSnapshot(descriptor: PaneDescriptorV1): unknown {
  const { observation, presence, ...rest } = descriptor;
  return {
    ...rest,
    observation: { freshness: observation.freshness }, // cursor/observedAt are sampling artefacts.
    presence: {
      coverage: presence.coverage,
      views: presence.views.map((view) => ({
        windowId: view.windowId,
        uiPaneId: view.uiPaneId,
        treeId: view.treeId,
        visible: view.visible,
        openedAtClient: view.openedAtClient,
        // registeredAt/lastSeenAt deliberately omitted — sampling artefacts.
      })),
    },
  };
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Whether a status implies the object is at an authoritative terminal (design §8:
 *  execution_settled "明确 executionRef、outcome、commitState" — this classifies which activity
 *  values are that kind of settling transition, PLUS every transition this task's brief calls
 *  out as never-delayable: "状态转换、权限等待、取消、终态". `running`/`preparing`/`queued`/
 *  `recovering` are excluded — those are still "in progress", not settling. */
const NEVER_COALESCE_ACTIVITIES = new Set<PaneDescriptorV1['activity']>([
  'waiting', 'cancelling', 'idle', 'completed' as PaneDescriptorV1['activity'], 'failed' as PaneDescriptorV1['activity'], 'cancelled' as PaneDescriptorV1['activity'],
]);

/** True for a transition whose ONLY difference from the previous content snapshot is the
 *  latestOutput section — i.e. this is purely a streaming-text update with no activity/execution
 *  change, which is the ONLY case coalescing may ever apply to (brief acceptance item / design
 *  §8: "低频状态变化不必延迟" implies the inverse — a state change is never low-frequency-throttled).
 *  Any other difference (activity, execution, conversation, lineage, runtime, presence
 *  membership) always flushes immediately regardless of this function's result. */
function isPureOutputChange(previous: unknown, next: unknown): boolean {
  if (previous === null || typeof previous !== 'object' || typeof next !== 'object' || next === null) return false;
  const prevRecord = previous as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  for (const key of Object.keys(nextRecord)) {
    if (key === 'latestOutput') continue;
    if (JSON.stringify(prevRecord[key]) !== JSON.stringify(nextRecord[key])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-object feed state
// ---------------------------------------------------------------------------

interface ObjectFeedState {
  /** Last descriptor actually emitted (post-coalescing) — the baseline the NEXT poll/event diffs
   *  against, distinct from the ring's own `lastContent` (which tracks every recorded change,
   *  including ones still pending in the coalesce timer). */
  lastEmittedContent: unknown;
  /** A pending output_changed timer, or undefined if none is scheduled. Cleared and NOT
   *  re-armed by a terminal/status event — see `PaneFeed.handlePotentialChange`'s doc comment on
   *  why a pending output-only change is flushed immediately alongside the terminal one rather
   *  than dropped. */
  pendingOutputTimer: unknown;
  /** The descriptor captured at the moment the pending timer was armed — flushed either when the
   *  timer fires or immediately if a non-coalescable change arrives first. */
  pendingDescriptor: PaneDescriptorV1 | null;
  /** True once this object has sent `access_revoked` or `removed` — no further content for it. */
  settled: boolean;
  /** Which workspace this object's per-workspace metadata check is registered under, or
   *  undefined for a target with no workspace concept (kept alongside `settled` rather than in
   *  the watcher itself so `unsubscribe`/`revoke` have a single place to look up what to release,
   *  without needing to re-resolve the target). */
  metadataWorkspaceId?: string;
  /** The caller and emitter this object was subscribed with — recorded so
   *  `WorkspaceMetadataWatcher`'s callback (which only carries a bare `nodeId`, since it is
   *  shared across every object a `PaneFeed` observes) can find its way back to the right
   *  authorised re-inspect call. Every object in `states` always has both set at subscribe time;
   *  they are not made optional to avoid a spurious null-check at every call site that already
   *  proved a `state` exists in `this.states`. */
  caller: PaneInspectionCaller;
  emitter: PaneFeedEmitter;
}

export interface PaneFeedEmitter {
  /** Emits one event on the outgoing transport (SSE `data:` frame, or a one-shot resolve for
   *  wait_pane). Never throws — a transport-level failure is the caller's (route layer's) job to
   *  detect via its own `res.on('close'/'error')`, not this module's. */
  emit(event: PaneFeedEventV1): void;
}

// ---------------------------------------------------------------------------
// Per-workspace metadata watcher (design §8's "非执行元信息" 2-second check, brief P3-4).
// ---------------------------------------------------------------------------

/** What the metadata check compares against on the NEXT tick — deliberately narrow: only the
 *  fields design §8 scopes this check to (title, archived, message/turn counts). Never activity,
 *  execution, or commitState — those fields do not exist on `NodeMetadataBatchEntry` at all,
 *  which is what makes "a metadata check can never produce a terminal conclusion" true by
 *  construction rather than by a runtime check someone could accidentally remove. */
function metadataFingerprint(entry: NodeMetadataBatchEntry): string {
  return JSON.stringify([
    entry.title,
    entry.status,
    entry.messageCounts.total,
    entry.messageCounts.user,
    entry.messageCounts.assistant,
    entry.completedTurns.count,
    entry.completedTurns.coverage,
  ]);
}

/**
 * One instance per `PaneFeed` (not a process-wide singleton — a feed's own subscribed objects are
 * already exactly the set the design's "observed workspace" language refers to; nothing in the
 * brief or design requires batching ACROSS separate `subscribePanes` connections, only across the
 * objects within one). Runs ONE `setInterval` per workspace that currently has at least one
 * registered node object, and on each tick does exactly ONE batched
 * `getNodesMetadataByIds` call for every node object registered under that workspace — this is
 * what makes "N objects in one workspace cost one check, not N" true regardless of N.
 *
 * Never calls `inspect()` and never constructs a `PaneDescriptorV1` — it only compares the
 * previous tick's `metadataFingerprint` against the new one per node and, on a difference, calls
 * back into `onChanged(nodeId)` so the caller (`PaneFeed`) can route that through the SAME
 * `tryAuthorizedInspect` → `handlePotentialChange` path every other notification source uses.
 * This is the mechanism behind "a metadata check never produces a terminal/execution_settled
 * conclusion" — the watcher has no execution-shaped data to derive one from in the first place.
 */
class WorkspaceMetadataWatcher {
  private readonly clock: PaneSubscribeClock;
  private readonly userId: string | undefined;
  private readonly intervalMs: number;
  private readonly onChanged: (nodeId: string) => void;
  /** Injected rather than calling `dbRepository.getNodesMetadataByIds` directly, for the same
   *  reason `PaneFeedDeps.clock`/`ring` are injected: it lets a unit test (this module's own
   *  `paneInspectionSubscribe.test.ts`) exercise the watcher's batching/coalescing/stop-on-empty
   *  logic with a synchronous in-memory fake instead of opening a real SQLite handle at
   *  `MICHI_DATA_DIR`/`~/.michi` on every fake-clock tick — this file's own header comment
   *  promises "nothing here ever calls the real setTimeout"; reaching out to a real database
   *  file would be the equivalent violation for I/O. Defaults to the real function in
   *  `PaneFeedDeps` below, so production route wiring needs no change. */
  private readonly fetchMetadata: (nodeIds: readonly string[], userId?: string) => Map<string, NodeMetadataBatchEntry>;
  /** workspaceId -> the set of nodeIds currently registered under it. */
  private readonly membersByWorkspace = new Map<string, Set<string>>();
  /** workspaceId -> its own setInterval handle. Absent entries mean "no timer" — the invariant
   *  this class maintains is: a timer exists if and only if `membersByWorkspace.get(ws)` is
   *  non-empty. */
  private readonly timers = new Map<string, unknown>();
  /** nodeId -> the last fingerprint this watcher observed for it, so the FIRST tick after
   *  registration establishes a baseline rather than firing a spurious change (the object's own
   *  `snapshot`/first-poll already reported its starting state via `inspect()`). */
  private readonly lastFingerprint = new Map<string, string>();
  /** Total batched `getNodesMetadataByIds` calls made — exposed for this task's test/report
   *  requirement to measure (not assume) the per-workspace check's call count. */
  batchCallCount = 0;

  constructor(deps: {
    clock: PaneSubscribeClock;
    userId?: string;
    intervalMs: number;
    onChanged: (nodeId: string) => void;
    fetchMetadata: (nodeIds: readonly string[], userId?: string) => Map<string, NodeMetadataBatchEntry>;
  }) {
    this.clock = deps.clock;
    this.userId = deps.userId;
    this.intervalMs = deps.intervalMs;
    this.onChanged = deps.onChanged;
    this.fetchMetadata = deps.fetchMetadata;
  }

  /** Registers `nodeId` under `workspaceId`, arming that workspace's timer if this is its first
   *  member. Idempotent — registering the same nodeId twice is a no-op beyond the Set add. */
  register(workspaceId: string, nodeId: string): void {
    let members = this.membersByWorkspace.get(workspaceId);
    if (!members) {
      members = new Set();
      this.membersByWorkspace.set(workspaceId, members);
    }
    members.add(nodeId);
    if (!this.timers.has(workspaceId)) {
      const handle = this.clock.setInterval(() => this.tick(workspaceId), this.intervalMs);
      this.timers.set(workspaceId, handle);
    }
  }

  /** Releases `nodeId` from `workspaceId`. When that empties the workspace's member set, the
   *  timer is cleared immediately — "stops entirely when nothing is subscribed" (design §8) —
   *  rather than left running an empty batch every tick. */
  unregister(workspaceId: string, nodeId: string): void {
    const members = this.membersByWorkspace.get(workspaceId);
    if (!members) return;
    members.delete(nodeId);
    this.lastFingerprint.delete(nodeId);
    if (members.size === 0) {
      this.membersByWorkspace.delete(workspaceId);
      const handle = this.timers.get(workspaceId);
      if (handle !== undefined) this.clock.clearInterval(handle);
      this.timers.delete(workspaceId);
    }
  }

  /** Tears down every workspace timer — called from `PaneFeed.stop()`. */
  stopAll(): void {
    for (const handle of this.timers.values()) this.clock.clearInterval(handle);
    this.timers.clear();
    this.membersByWorkspace.clear();
    this.lastFingerprint.clear();
  }

  private tick(workspaceId: string): void {
    const members = this.membersByWorkspace.get(workspaceId);
    if (!members || members.size === 0) return; // torn down mid-tick (unregister raced the timer).
    this.batchCallCount += 1;
    const entries = this.fetchMetadata([...members], this.userId);
    for (const nodeId of members) {
      const entry = entries.get(nodeId);
      // A node the batch query no longer returns (deleted / no longer owned) is exactly the
      // "removed/access_revoked" case — but detecting THAT authoritatively is
      // tryAuthorizedInspect's job (it re-runs authorizeCaller against the live DB row), not this
      // watcher's. Treat "missing from the batch" as "something changed, go re-inspect" and let
      // the authorised path decide removed vs. access_revoked vs. a transient miss.
      const fingerprint = entry ? metadataFingerprint(entry) : '__missing__';
      const previous = this.lastFingerprint.get(nodeId);
      this.lastFingerprint.set(nodeId, fingerprint);
      if (previous !== undefined && previous !== fingerprint) this.onChanged(nodeId);
    }
  }
}

export interface PaneFeedDeps {
  clock: PaneSubscribeClock;
  ring: PaneInspectionRing;
  /** The ChatHub slice this feed observes, per `ChatHubObservationPort` above. Defaults to the
   *  real process-wide singleton, so production route wiring needs no change; a unit test injects
   *  an in-memory fake and avoids the real singleton's SQLite-backed persistence entirely. */
  chatHub?: ChatHubObservationPort;
  /** Optional — absent when `agentRunAssembly.enabled` is false at boot (design: AgentRun
   *  support is conditional on that assembly). AgentRun targets subscribed without this present
   *  fall back to the same polling path used when there is no live bus, which is correct but
   *  coarser (design §8 does not require AgentRun's live bus specifically; it only requires SOME
   *  correct notification source). */
  agentRunEvents?: AgentRunEventBus;
  /** Owner scoping forwarded to `getNodesMetadataByIds` (COMMON.md decision 5) — undefined in
   *  desktop mode, the caller's ownerUserId in cloud mode. All objects a single `PaneFeed`
   *  serves share one authenticated caller (design §10: subscribePanes is one caller's stream),
   *  so this is a per-feed constant, not per-object. */
  metadataOwnerUserId?: string;
  /** How often the per-workspace metadata check (design §8) re-reads title/lineage/archived/
   *  counts for every currently-observed node object in a workspace. Default matches design §8's
   *  "2 秒元信息校验" cadence. Does NOT gate AgentRun's execution-change detection (that is
   *  exclusively the live event bus) or a node's execution-change detection (that is exclusively
   *  the ChatHub subscription below) — this interval governs ONLY the metadata watcher. */
  metadataPollIntervalMs?: number;
  /** Retained for AgentRun's coarse metadata-only poll fallback when no live bus is configured —
   *  see `armWatcher`'s agent_run branch. Chat/node targets no longer use this for execution
   *  detection (see the ChatHub subscription in `armChatWatcher`); AgentRun targets still need
   *  SOME interval for the presence/metadata-only changes the event bus does not model, and this
   *  is that interval, kept under its previous name for anyone integrating against P3-2's shape.
   *  Also used as the node/chat kind's own coarse fallback poll alongside the ChatHub
   *  subscription — see `armWatcher`'s node branch doc comment for why that fallback exists. */
  pollIntervalMs?: number;
  /** Injected metadata batch fetcher — defaults to the real `dbRepository.getNodesMetadataByIds`
   *  below. Overridden only by this module's own unit test, so the metadata watcher's tick never
   *  opens a real SQLite handle in a suite whose whole point is running with no real I/O — see
   *  `WorkspaceMetadataWatcher`'s own doc comment on why this is injected rather than imported
   *  directly. */
  metadataFetcher?: (nodeIds: readonly string[], userId?: string) => Map<string, NodeMetadataBatchEntry>;
}

/**
 * One subscribed object within one `subscribePanes` call (or one `wait_pane(until='changed')`
 * call — see `oncePerObject`). Owns:
 *  - registering/releasing itself against the ring's subscriber ref-count (constructor/`stop`);
 *  - polling (or, for AgentRun with a live bus, event-driven) change detection;
 *  - coalescing output-only changes while flushing everything else immediately;
 *  - continuous re-authorisation before every send.
 *
 * Deliberately UNAWARE of transport (SSE framing, WebSocket, HTTP response) — it only calls
 * `emitter.emit(event)`. `paneInspectionSubscribeRoute.ts`-equivalent wiring (this task's route
 * addition) adapts that to `res.write`; a future `wait_pane` (P3-5) can reuse this exact class by
 * calling `oncePerObject` instead of `start`.
 */
let processAgentRunEvents: AgentRunEventBus | undefined;

/** Installed once at boot; tool waits and HTTP feeds observe the same committed bus. */
export function configurePaneInspectionEventBus(events: AgentRunEventBus | undefined): void {
  processAgentRunEvents = events;
}

export class PaneFeed {
  private readonly clock: PaneSubscribeClock;
  private readonly ring: PaneInspectionRing;

  /** Defaults to the real process-wide ChatHub singleton; injectable so tests need no SQLite. */
  private readonly chatHub: ChatHubObservationPort;
  private readonly agentRunEvents?: AgentRunEventBus;
  private readonly pollIntervalMs: number;
  private readonly metadataWatcher: WorkspaceMetadataWatcher;

  private readonly states = new Map<string, ObjectFeedState>();
  private readonly pollTimers = new Map<string, unknown>();
  private readonly runEventUnsubscribes = new Map<string, () => void>();
  /** ChatHub-subscribed node targets — `paneId -> chatId` (resolved once at watch-arm time) and
   *  the corresponding `chatHub.subscribe(chatId, ...)` detach function. Separate from
   *  `runEventUnsubscribes` because a node target and an agent_run target never share a paneId,
   *  but keeping them in distinctly-named maps makes `unsubscribe`'s per-source teardown
   *  unambiguous to read rather than relying on "only one of these two maps will ever have an
   *  entry for this key" as an unstated invariant. */
  private readonly chatHubUnsubscribes = new Map<string, () => void>();
  private stopped = false;

  constructor(deps: PaneFeedDeps) {
    this.clock = deps.clock;
    this.ring = deps.ring;
    this.chatHub = deps.chatHub ?? systemChatHub;
    this.agentRunEvents = deps.agentRunEvents ?? processAgentRunEvents;
    this.pollIntervalMs = deps.pollIntervalMs ?? 2_000;
    this.metadataWatcher = new WorkspaceMetadataWatcher({
      clock: this.clock,
      userId: deps.metadataOwnerUserId,
      intervalMs: deps.metadataPollIntervalMs ?? 2_000,
      onChanged: (nodeId) => this.handleMetadataChange(nodeId),
      fetchMetadata: deps.metadataFetcher ?? getNodesMetadataByIds,
    });
  }

  /**
   * Begins watching `paneId` for `caller`, replaying any retained ring events after
   * `resumeCursor` (if resolvable) or emitting a fresh `snapshot` (design §8: "首次观察先挂
   * domain listener，再读取来源快照，暂存期间到达的事件" — this implementation registers the
   * subscriber and arms the poll/event listener BEFORE calling `inspect()` for the baseline
   * snapshot, so a change landing in that narrow window is not lost: it will simply be detected
   * by the very next poll tick / event, which re-diffs against whatever `inspect()` just
   * established as `lastEmittedContent`).
   *
   * `resync_required` is emitted (instead of a gap) when `resumeCursor` cannot be replayed — an
   * aged-out, evicted, unknown, wrong-scope, or epoch-mismatched cursor all collapse to this one
   * outcome (design §8 / brief acceptance: "旧 cursor 不可回放，必须以新 snapshot 对齐" — this
   * function follows that with an actual `snapshot` event immediately after, so the caller is
   * never left only with a resync signal and no data to resync FROM).
   */
  subscribe(caller: PaneInspectionCaller, paneId: string, resumeCursor: string | undefined, emitter: PaneFeedEmitter): void {
    if (this.stopped) return;
    const scope = scopeFor(caller);
    this.ring.registerSubscriber(paneId, scope);
    this.states.set(paneId, { lastEmittedContent: undefined, pendingOutputTimer: undefined, pendingDescriptor: null, settled: false, caller, emitter });

    if (resumeCursor) {
      // Reauthorize before replay: retained payloads are not permission grants. A fresh
      // snapshot below reconciles changes that have not yet entered the ring.
      const descriptor = this.tryAuthorizedInspect(caller, paneId, emitter);
      if (!descriptor) return;
      const resolution = this.ring.resolveCursor(resumeCursor, scope);
      if (resolution.ok && resolution.paneId === paneId) {
        for (const retained of resolution.replay) {
          emitter.emit(retained.event.payload as PaneFeedEventV1);
        }
        // Establish lastEmittedContent from a fresh authorised read so the NEXT diff has a
        // correct baseline even if the replay's own payloads don't fully reconstruct it (they
        // are opaque to the ring — see RingEvent's doc comment).
        // Always reconcile against the authoritative snapshot. A feed may have been idle,
        // or a prior partial event may not contain every section of the descriptor.
        this.emitFreshSnapshot(caller, paneId, emitter);
        this.armWatcher(caller, paneId, emitter);
        return;
      }
      const resyncCursor = this.ring.recordObservedAtRefresh(paneId, scope);
      emitter.emit({ version: 1, paneId, cursor: resyncCursor, type: 'resync_required', emittedAt: this.clock.now() });
      // Fall through to the fresh-snapshot path below — a resync is always followed by data to
      // resync FROM, never left dangling.
    }

    this.emitFreshSnapshot(caller, paneId, emitter);
    this.armWatcher(caller, paneId, emitter);
  }

  /**
   * One-shot variant for `wait_pane(until='changed')` (P3-5's seam): resolves as soon as a
   * content change is detected (or immediately, if the object already differs from
   * `sinceCursor`'s baseline), WITHOUT registering a poll loop that outlives the call — the
   * returned function tears down whatever this call armed. Does not replay retained events; a
   * one-shot wait only cares about "has it changed", not historical events, per design §7.4's own
   * wait/subscribe cursor-incompatibility note ("订阅 cursor 和正文 pageCursor 是两种不同的游标，
   * 不能互换" generalises to: a wait's cursor answers exactly one boolean, it does not resume a
   * feed). Left unimplemented in THIS task (P3-2 owns the feed and its own tests; wait_pane's own
   * acceptance table belongs to P3-5) beyond this documented entry point, which P3-5 can build on
   * without touching PaneFeed's internals — see the report.
   */
  oncePerObject(
    caller: PaneInspectionCaller,
    paneId: string,
    baselineContent: unknown,
    onChange: (descriptor: PaneDescriptorV1) => void,
    onUnavailable: () => void,
    executionRef?: import('michi-shared').ExecutionRef,
  ): () => void {
    const target = safeResolveTarget(paneId);
    if (!target) { onUnavailable(); return () => {}; }

    let done = false;
    let chatHubUnsub: (() => void) | undefined;
    let runUnsub: (() => void) | undefined;
    let pollTimer: unknown;

    const stop = (): void => {
      if (chatHubUnsub) { chatHubUnsub(); chatHubUnsub = undefined; }
      if (runUnsub) { runUnsub(); runUnsub = undefined; }
      if (pollTimer !== undefined) { this.clock.clearInterval(pollTimer); pollTimer = undefined; }
    };

    /** Re-inspects once and reports a change relative to `baselineContent` (the check the caller
     *  already performed before arming this listener — this method never re-derives its own
     *  baseline, so it agrees exactly with whatever the caller compared against). Never
     *  coalesces: `wait_pane` has no output-only throttling window (design §7.4 only speaks of
     *  changed/terminal/timed_out/unavailable, none of which are a coalescing target), and never
     *  touches the ring — recording ring events here would be observed by unrelated SSE
     *  subscribers of the SAME object as if this one-shot check were itself a feed. When
     *  `executionRef` is supplied, the re-inspect is scoped to it (design §7.4's `until:
     *  'terminal'` needs T1's OWN status, not whatever the object's current/latest attempt is —
     *  the plain unscoped read a caller with no executionRef gets is exactly what `until:
     *  'changed'` wants instead). */
    const checkOnce = (): void => {
      if (done) return;
      let descriptor: PaneDescriptorV1;
      try {
        authorizeCaller(caller, target);
        descriptor = inspect(caller, { locator: paneIdLocator(paneId), executionRef });
      } catch (err) {
        if (err instanceof PaneInspectionError && (err.code === 'NOT_FOUND' || err.code === 'NAVIGATION_DISABLED')) {
          done = true;
          stop();
          onUnavailable();
        }
        // Any other error (e.g. SOURCE_UNAVAILABLE) is transient — try again on the next trigger.
        return;
      }
      if (deepEqual(baselineContent, toContentSnapshot(descriptor))) return; // unchanged — keep waiting.
      done = true;
      stop();
      onChange(descriptor);
    };

    if (target.kind === 'agent_run' && this.agentRunEvents) {
      runUnsub = this.agentRunEvents.subscribe(target.runId, () => checkOnce());
    } else if (target.kind === 'node') {
      const observation = this.chatHub.getSnapshot(target.nodeId);
      const chatId = observation?.chatId ?? target.nodeId;
      chatHubUnsub = this.chatHub.subscribe(chatId, { send: () => checkOnce(), close: () => {} });
    }
    // Coarse poll fallback for every kind (surface/agent_run-without-bus/node), mirroring
    // `armWatcher`'s own rationale: a change whose only cause is outside the live-event source
    // (presence, metadata, or — for `surface` — the only content it ever has) must still
    // eventually be observed rather than silently missed for the whole timeout window.
    pollTimer = this.clock.setInterval(() => checkOnce(), this.pollIntervalMs);

    return () => { done = true; stop(); };
  }

  /** Detaches one object: releases the ring's subscriber ref-count, tears down its poll timer /
   *  event unsubscribe / ChatHub subscription / metadata-watcher registration, and clears any
   *  pending coalesce timer. Safe to call multiple times or for an object never subscribed. Never
   *  touches a chat turn or a Run — detaching an observer must never cancel anything (design §8 /
   *  brief acceptance: "assert no cancel call happened"). */
  unsubscribe(paneId: string): void {
    const state = this.states.get(paneId);
    if (state?.pendingOutputTimer !== undefined) this.clock.clearTimeout(state.pendingOutputTimer);
    if (state?.metadataWorkspaceId !== undefined) {
      const target = safeResolveTarget(paneId);
      if (target?.kind === 'node') this.metadataWatcher.unregister(state.metadataWorkspaceId, target.nodeId);
    }
    this.states.delete(paneId);
    const pollTimer = this.pollTimers.get(paneId);
    if (pollTimer !== undefined) { this.clock.clearInterval(pollTimer); this.pollTimers.delete(paneId); }
    this.runEventUnsubscribes.get(paneId)?.();
    this.runEventUnsubscribes.delete(paneId);
    this.chatHubUnsubscribes.get(paneId)?.();
    this.chatHubUnsubscribes.delete(paneId);
    this.ring.releaseSubscriber(paneId);
  }

  /** Tears down every subscribed object — called on transport close/error (`res.on('close')`,
   *  never `req.on('close')` — see this module's own doc comment and the route wiring). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const paneId of [...this.states.keys()]) this.unsubscribe(paneId);
    this.metadataWatcher.stopAll(); // belt-and-suspenders: unsubscribe() above already released
    // every workspace registration one nodeId at a time, so by this point every workspace's
    // member set is already empty and its timer already cleared. stopAll() is still called so a
    // future object added between the loop above and here (there shouldn't be one — `stopped` is
    // already true) can never leave a dangling timer.
  }

  // -------------------------------------------------------------------------
  // Watching
  // -------------------------------------------------------------------------

  private armWatcher(caller: PaneInspectionCaller, paneId: string, emitter: PaneFeedEmitter): void {
    const target = safeResolveTarget(paneId);

    if (target?.kind === 'agent_run' && this.agentRunEvents) {
      const unsubscribe = this.agentRunEvents.subscribe(target.runId, (event: AgentRunEventV1) => {
        this.handleAgentRunEvent(caller, paneId, event, emitter);
      });
      this.runEventUnsubscribes.set(paneId, unsubscribe);
      // AgentRun still needs a (much coarser) poll fallback for presence-only changes the event
      // bus does not model (an AgentRun has no workspace-scoped metadata check registration
      // below — runs are not node-backed — so this interval remains its ONLY secondary source).
      const timer = this.clock.setInterval(() => this.pollOnce(caller, paneId, emitter), this.pollIntervalMs);
      this.pollTimers.set(paneId, timer);
      return;
    }

    if (target?.kind === 'agent_run') {
      // No live bus configured for this process — fall back to the same interval poll P3-2 used
      // for every kind, since there is no other execution-change source available for a Run.
      const timer = this.clock.setInterval(() => this.pollOnce(caller, paneId, emitter), this.pollIntervalMs);
      this.pollTimers.set(paneId, timer);
      return;
    }

    if (target?.kind === 'node') {
      this.armChatWatcher(caller, paneId, target.nodeId, emitter);
      // A coarser poll fallback still runs alongside the ChatHub subscription and the
      // per-workspace metadata watcher. This is deliberate, not a half-finished migration: the
      // ChatHub subscription only fires on a ChatHub-originated event for the resolved chatId
      // (see `armChatWatcher`'s own doc comment on the chatId===nodeId fallback and its limits),
      // and the metadata watcher only fires on a difference in the narrow title/archived/counts
      // fingerprint it reads from the database — NEITHER source can see a content change whose
      // only cause is something outside both (e.g. a presence view arriving with no accompanying
      // ChatHub event and no metadata-row change, or — as this file's own regression-gate tests
      // exercise — a descriptor mutation injected directly for testing with no real chat turn
      // behind it at all). This poll is what makes such a change eventually observable rather
      // than silently missed; it is coarser and secondary, never the PRIMARY signal for a chat
      // execution change, which is the ChatHub subscription's job and is what makes that specific
      // class of change instant instead of up to `pollIntervalMs` late (this task's substance —
      // see the module header comment and this task's report for the measured effect).
      const timer = this.clock.setInterval(() => this.pollOnce(caller, paneId, emitter), this.pollIntervalMs);
      this.pollTimers.set(paneId, timer);
      return;
    }

    // 'surface' and any target this process could not resolve at all (e.g. a raced deletion
    // between authorisation and here) — no execution/notification source exists for a surface
    // (presence-only, design §4.2) and an unresolved target has nothing to watch. Nothing is
    // armed; the object simply never receives a post-snapshot update, which is correct: a
    // surface's only content is presence, and presence membership is picked up by whatever OTHER
    // object in the same stream next triggers a re-inspect — a surface has no source of its own
    // to trigger one, matching P3-2's original behaviour for this kind (untouched by this task).
  }

  /**
   * Chat's execution-change source (brief P3-4's substance): a real `chatHub.subscribe(chatId,
   * ...)` listener instead of a poll. `chatId` is resolved ONCE here, not re-resolved per event:
   * `chatHub.getSnapshot(nodeId)` (COMMON decision 1's lookup order — `turns.get(nodeId)` first,
   * then a scan for `log.nodeId === nodeId`) gives the authoritative chatId for whatever turn
   * ChatHub currently associates with this node, if any. When no observation exists yet (the
   * chat has never started a turn this process has seen — e.g. a brand-new or purely historical
   * node), there is nothing to subscribe to YET; `chatId` falls back to `nodeId` itself, matching
   * the verified foreground-turn invariant (COMMON decision 1: `routes/michi.ts:1417` starts
   * foreground turns with `chatId: nodeId`) — a *future* turn on this node started via that path
   * will be chatId===nodeId, so subscribing under that key now means we ARE listening in time,
   * we just replay nothing (there is nothing to replay: `subscribe()` only replays `log.events`
   * for logs that already exist). A node whose turns are ALWAYS started via a differently-scoped
   * chatId (background/self-initiated — COMMON decision 1's documented exception) will simply
   * never receive ChatHub events through this path; its content changes are then only observed
   * via the workspace metadata check below, which is coarser but not silent.
   *
   * Every raw event received is ONLY a wake-up signal — `handleChatHubEvent` re-derives the
   * descriptor exclusively via `tryAuthorizedInspect`, exactly mirroring `handleAgentRunEvent`'s
   * own contract, so a raw ChatHub event can never itself decide activity/execution/commitState.
   *
   * Also registers this node under the per-workspace metadata watcher (using the caller's own
   * workspaceId — `authorizeCaller` already proved this node belongs to it before `inspect()`
   * ever ran, and every object one `PaneFeed`/caller observes shares that same workspace scope
   * per design §11's "同一 backend/workspace 内最多 32 个 paneId").
   */
  private armChatWatcher(caller: PaneInspectionCaller, paneId: string, nodeId: string, emitter: PaneFeedEmitter): void {
    const observation = this.chatHub.getSnapshot(nodeId);
    const chatId = observation?.chatId ?? nodeId;
    const sub: HubSubscriber = {
      send: () => this.handleChatHubEvent(caller, paneId, emitter),
      close: () => {}, // ChatHub calls close() on eviction; this feed's own stop()/unsubscribe() is what tears the listener down from this side — nothing to react to here.
    };
    const unsubscribe = this.chatHub.subscribe(chatId, sub);
    this.chatHubUnsubscribes.set(paneId, unsubscribe);

    const state = this.states.get(paneId);
    if (state) state.metadataWorkspaceId = caller.workspaceId;
    this.metadataWatcher.register(caller.workspaceId, nodeId);
  }

  private handleChatHubEvent(caller: PaneInspectionCaller, paneId: string, emitter: PaneFeedEmitter): void {
    const state = this.states.get(paneId);
    if (!state || state.settled) return;
    const descriptor = this.tryAuthorizedInspect(caller, paneId, emitter);
    if (!descriptor) return;
    this.handlePotentialChange(caller, paneId, descriptor, emitter);
  }

  /** Callback from `WorkspaceMetadataWatcher` when a node's title/lineage/archived/counts
   *  fingerprint differs from the previous tick. Looks up the (caller, paneId, emitter) triple
   *  recorded in `this.states` when `nodeId` was registered — a `PaneFeed` may be observing
   *  several nodeIds in the SAME workspace, each under its own paneId, so this method must find
   *  the specific paneId that owns `nodeId`, not assume there is only one. */
  private handleMetadataChange(nodeId: string): void {
    for (const [paneId, state] of this.states) {
      if (state.settled || state.metadataWorkspaceId === undefined) continue;
      const target = safeResolveTarget(paneId);
      if (target?.kind !== 'node' || target.nodeId !== nodeId) continue;
      const descriptor = this.tryAuthorizedInspect(state.caller, paneId, state.emitter);
      if (!descriptor) return;
      this.handlePotentialChange(state.caller, paneId, descriptor, state.emitter);
      return; // paneId is unique per this.states — no second match possible.
    }
  }

  private pollOnce(caller: PaneInspectionCaller, paneId: string, emitter: PaneFeedEmitter): void {
    const state = this.states.get(paneId);
    if (!state || state.settled) return;
    const descriptor = this.tryAuthorizedInspect(caller, paneId, emitter);
    if (!descriptor) return; // access_revoked or transient failure already handled.
    this.handlePotentialChange(caller, paneId, descriptor, emitter);
  }


  private handleAgentRunEvent(caller: PaneInspectionCaller, paneId: string, event: AgentRunEventV1, emitter: PaneFeedEmitter): void {
    const state = this.states.get(paneId);
    if (!state || state.settled) return;
    const descriptor = this.tryAuthorizedInspect(caller, paneId, emitter);
    if (!descriptor) return;
    // A CancellationRequested / terminal-shaped event is exactly the kind of transition the
    // brief forbids delaying — handlePotentialChange already classifies this correctly via
    // NEVER_COALESCE_ACTIVITIES on the descriptor's own `activity`, so no special-casing of
    // `event.type` is needed here: the descriptor IS the source of truth, the event is only the
    // trigger to re-read it (design §8: "changed... 客户端按 cursor 替换，不自行重算状态机" — we
    // never derive the emitted event's shape from the AgentRun event itself, only from a fresh
    // authorised inspect()).
    void event;
    this.handlePotentialChange(caller, paneId, descriptor, emitter);
  }

  // -------------------------------------------------------------------------
  // Change detection + coalescing (the core of this task)
  // -------------------------------------------------------------------------

  /**
   * Compares `descriptor` against the last EMITTED content snapshot for this object and decides
   * whether to emit immediately, coalesce, or do nothing (unchanged).
   *
   * Coalescing rule (brief's explicit acceptance item, design §8): a change whose ONLY difference
   * from the previous content is `latestOutput` is a candidate for the `output_changed`
   * coalescing window. EVERY OTHER kind of difference — activity, execution, conversation,
   * lineage, runtime, presence membership — flushes on its own separate `changed` event
   * immediately, with NO shared timer between the two kinds: if a pure output change is already
   * pending in the coalesce timer and a status/terminal change arrives before the timer fires,
   * BOTH are flushed now (the pending output_changed first, so its own preview is not lost, then
   * the terminal/changed event) rather than the terminal event waiting on — or worse, being
   * merged into — the output timer. This is the concrete mechanism that satisfies "never
   * implement one timer for everything": there are two independent code paths (the
   * `isPureOutputChange` branch below, and the immediate-flush branch), and the immediate-flush
   * branch always drains any pending output timer first rather than skipping it.
   */
  private handlePotentialChange(caller: PaneInspectionCaller, paneId: string, descriptor: PaneDescriptorV1, emitter: PaneFeedEmitter): void {
    const state = this.states.get(paneId);
    if (!state || state.settled) return;
    const nextContent = toContentSnapshot(descriptor);

    if (state.lastEmittedContent !== undefined && deepEqual(state.lastEmittedContent, nextContent)) {
      // Nothing changed at all — a pure re-read (e.g. a metadata-poll tick that found no actual
      // difference). Record it as a sampling-only touch so LRU ordering still reflects recent
      // activity without advancing revision.
      this.ring.recordObservedAtRefresh(paneId, scopeFor(caller));
      return;
    }

    const previousContent = state.lastEmittedContent;
    const pureOutputChange = previousContent !== undefined && isPureOutputChange(previousContent, nextContent);

    if (pureOutputChange && !NEVER_COALESCE_ACTIVITIES.has(descriptor.activity)) {
      // Candidate for coalescing. Replace any already-pending descriptor (later data wins) but
      // do NOT reset an already-running timer's deadline — design's 250ms window bounds latency
      // from the FIRST unflushed change, not a rolling debounce that a fast stream could starve.
      state.pendingDescriptor = descriptor;
      if (state.pendingOutputTimer === undefined) {
        state.pendingOutputTimer = this.clock.setTimeout(() => {
          const pending = state.pendingDescriptor;
          state.pendingOutputTimer = undefined;
          state.pendingDescriptor = null;
          if (pending) this.flush(caller, paneId, pending, emitter, 'output_changed');
        }, PANE_INSPECTION_LIMITS.outputChangedCoalesceMs);
      }
      return;
    }

    // Non-coalescable change (or the very first content this object has ever reported, where
    // previousContent is undefined and there is nothing to coalesce against). Drain any pending
    // output-only change FIRST so its own preview is not silently dropped, THEN flush this one.
    if (state.pendingOutputTimer !== undefined) {
      this.clock.clearTimeout(state.pendingOutputTimer);
      const pending = state.pendingDescriptor;
      state.pendingOutputTimer = undefined;
      state.pendingDescriptor = null;
      if (pending && !deepEqual(toContentSnapshot(pending), nextContent)) {
        this.flush(caller, paneId, pending, emitter, 'output_changed');
      }
    }
    this.flush(caller, paneId, descriptor, emitter, classifyChangeKind(previousContent, nextContent, descriptor));
  }

  private flush(
    caller: PaneInspectionCaller,
    paneId: string,
    descriptor: PaneDescriptorV1,
    emitter: PaneFeedEmitter,
    kind: 'output_changed' | 'changed' | 'execution_settled',
  ): void {
    const state = this.states.get(paneId);
    if (!state || state.settled) return;
    const scope = scopeFor(caller);
    // A coalesced preview may outlive a policy change; never flush it without a fresh check.
    try { authorizeCaller(caller, resolvePaneTarget({ paneId })); }
    catch (err) {
      if (err instanceof PaneInspectionError && (err.code === 'NOT_FOUND' || err.code === 'NAVIGATION_DISABLED')) this.revoke(caller, paneId, emitter);
      return;
    }
    const content = toContentSnapshot(descriptor);
    const payloadSizeHint = utf8Bytes(descriptor);

    let event: PaneFeedEventV1;
    if (kind === 'output_changed' && descriptor.latestOutput.status === 'ready' && descriptor.latestOutput.value) {
      const preview = descriptor.latestOutput.value;
      event = {
        version: 1, paneId, cursor: '', emittedAt: this.clock.now(),
        type: 'output_changed', outputId: preview.outputId, outputRevision: preview.outputRevision, preview,
      };
    } else if (kind === 'execution_settled' && descriptor.execution.status === 'ready' && descriptor.execution.value) {
      const execution = descriptor.execution.value;
      event = {
        version: 1, paneId, cursor: '', emittedAt: this.clock.now(),
        type: 'execution_settled', execution: execution.ref, outcome: execution.status, commitState: execution.commitState, descriptor,
      };
    } else {
      event = {
        version: 1, paneId, cursor: '', emittedAt: this.clock.now(),
        type: 'changed', changedSections: diffSections(state.lastEmittedContent, content), descriptor,
      };
    }

    const cursor = this.ring.recordContentChange(paneId, scope, content, { kind: event.type as 'changed' | 'output_changed' | 'execution_settled', payload: event, sizeBytes: payloadSizeHint });
    event = { ...event, cursor };
    if ('descriptor' in event && event.descriptor) {
      event.descriptor = { ...event.descriptor, observation: { ...event.descriptor.observation, cursor } };
    }
    state.lastEmittedContent = content;
    emitter.emit(event);
  }

  private emitFreshSnapshot(caller: PaneInspectionCaller, paneId: string, emitter: PaneFeedEmitter): void {
    const descriptor = this.tryAuthorizedInspect(caller, paneId, emitter);
    if (!descriptor) return;
    const scope = scopeFor(caller);
    const content = toContentSnapshot(descriptor);
    const payload: PaneFeedEventV1 = { version: 1, paneId, cursor: '', type: 'changed',
      changedSections: Object.keys(descriptor), descriptor, emittedAt: this.clock.now() };
    const cursor = this.ring.recordSnapshot(paneId, scope, content, { kind: 'changed', payload, sizeBytes: utf8Bytes(payload) });
    const state = this.states.get(paneId);
    if (state) state.lastEmittedContent = content;
    emitter.emit({ version: 1, paneId, cursor, type: 'snapshot', descriptor: {
      ...descriptor, observation: { ...descriptor.observation, cursor },
    }, emittedAt: this.clock.now() });
  }

  /**
   * Re-authorises and re-inspects `paneId` for `caller`. Returns null (having already emitted
   * `access_revoked` and marked the object settled) when authorisation no longer holds — design
   * §10: "on a policy change emit access_revoked and stop sending"; every content-producing call
   * site in this class goes through this method rather than calling `inspect()` directly, which
   * is what makes the re-check "continuous... every send" rather than "once at subscribe time".
   */
  private tryAuthorizedInspect(caller: PaneInspectionCaller, paneId: string, emitter?: PaneFeedEmitter): PaneDescriptorV1 | null {
    const target = safeResolveTarget(paneId);
    if (!target) return this.revoke(caller, paneId, emitter);
    try {
      authorizeCaller(caller, target);
      return inspect(caller, { locator: paneIdLocator(paneId) }, { publishObservation: false });
    } catch (err) {
      if (err instanceof PaneInspectionError && (err.code === 'NOT_FOUND' || err.code === 'NAVIGATION_DISABLED')) {
        return this.revoke(caller, paneId, emitter);
      }
      // Any other error (e.g. SOURCE_UNAVAILABLE) is transient — skip this tick without
      // settling the object; the next poll/event will try again.
      return null;
    }
  }

  private revoke(caller: PaneInspectionCaller, paneId: string, emitter?: PaneFeedEmitter): null {
    const state = this.states.get(paneId);
    if (state) state.settled = true;
    if (emitter) {
      const cursor = this.ring.recordObservedAtRefresh(paneId, scopeFor(caller));
      emitter.emit({ version: 1, paneId, cursor, type: 'access_revoked', emittedAt: this.clock.now() });
    }
    // Stop watching immediately — no further poll ticks or run events should even attempt
    // another inspect() for an object we just declared inaccessible. Ring subscriber is released
    // here too, matching "drop any caller-scoped cache for it" (design §10).
    const pollTimer = this.pollTimers.get(paneId);
    if (pollTimer !== undefined) { this.clock.clearInterval(pollTimer); this.pollTimers.delete(paneId); }
    this.runEventUnsubscribes.get(paneId)?.();
    this.runEventUnsubscribes.delete(paneId);
    this.chatHubUnsubscribes.get(paneId)?.();
    this.chatHubUnsubscribes.delete(paneId);
    if (state?.metadataWorkspaceId !== undefined) {
      const target = safeResolveTarget(paneId);
      if (target?.kind === 'node') this.metadataWatcher.unregister(state.metadataWorkspaceId, target.nodeId);
    }
    this.ring.releaseSubscriber(paneId);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function scopeFor(caller: PaneInspectionCaller): AuthorizationScope {
  return { ownerUserId: caller.ownerUserId, workspaceId: caller.workspaceId, runOwnerId: caller.runOwner?.runId ?? null };
}

function safeResolveTarget(paneId: string) {
  try {
    return resolvePaneTarget({ paneId });
  } catch {
    return null;
  }
}

function paneIdLocator(paneId: string) {
  return { paneId };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Best-effort list of top-level descriptor sections that actually differ, for `changed`'s
 *  `changedSections` field (design §8: "changedSections + 最新 descriptor" — this is advisory
 *  metadata for the client to decide what to re-render; the client MUST still replace its state
 *  from the attached descriptor, not recompute from this list per §8's own "客户端按 cursor
 *  替换，不自行重算状态机"). `undefined` previous content (first-ever emission after a snapshot
 *  race) reports every top-level key as changed. */
function diffSections(previous: unknown, next: unknown): string[] {
  if (previous === undefined || typeof previous !== 'object' || previous === null) {
    return typeof next === 'object' && next ? Object.keys(next as Record<string, unknown>) : [];
  }
  const prevRecord = previous as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  const keys = new Set([...Object.keys(prevRecord), ...Object.keys(nextRecord)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(prevRecord[key]) !== JSON.stringify(nextRecord[key])) changed.push(key);
  }
  return changed;
}

/** Classifies a non-coalescable change as `execution_settled` when the transition specifically
 *  moved the `execution` section into (or within) a terminal outcome, `changed` otherwise. Only
 *  called from the non-coalescable branch — a pure output-only change never reaches here (it is
 *  always `output_changed`, handled separately in `handlePotentialChange`). */
function classifyChangeKind(previous: unknown, next: unknown, descriptor: PaneDescriptorV1): 'changed' | 'execution_settled' {
  if (descriptor.execution.status !== 'ready' || !descriptor.execution.value) return 'changed';
  const settledStatuses = new Set(['completed', 'failed', 'cancelled']);
  if (!settledStatuses.has(descriptor.execution.value.status)) return 'changed';
  const prevExecution = previous && typeof previous === 'object' ? (previous as Record<string, unknown>).execution : undefined;
  const nextExecutionJson = JSON.stringify(descriptor.execution);
  if (JSON.stringify(prevExecution) === nextExecutionJson) return 'changed'; // execution itself didn't move.
  return 'execution_settled';
}

// Re-exported so route wiring / tests can reference the shared event-classifier without a second
// import path (mirrors paneInspection.ts's own re-export pattern at its file's bottom).
export { AgentRunEventType };
