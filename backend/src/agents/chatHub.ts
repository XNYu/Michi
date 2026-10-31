import { randomUUID } from "node:crypto";
import {
  applyTurnEvent,
  CHAT_STREAM_EVENTS,
  createDurableTurn,
  isActiveToolStatus,
  userInputInteractionId,
  normalizeUserInputQuestions,
  normalizeUserInputAnswers,
  type UserInputAnswer,
  type ChatStreamEvent,
  type SteerMessageOptions,
  type DurableMessageMetadata,
  type DurableTurnSnapshot,
} from "michi-shared";
import type { AgentSession, CompactResult, SteerResult, CancelAck, MaintenanceTurnContext } from "./types";
import { getRuntime } from "./registry";
import type { NormalizedEvent } from "../services/chatEvents";
import { chatStreamErrorCode, createChatStreamError, toChatStreamEvent, withStreamErrorCode } from "../routes/chatStreamEvents";
import { decodeMichiHostEvent } from "./hostEvents";
import { beginTurn, checkpointTurn, finalizeTurn, getNode } from "../services/dbRepository";
import { BACKEND_RESTARTED_ERROR, BACKEND_RESTARTED_MESSAGE } from "../services/turnPersistence.recipes";
import { getDb } from "../services/db";
import { extractBranchOverview } from "../services/messageSerialization";
import { log as appLog } from "../services/logger";
import { ACPError } from "michi-runtime/internal/adapters/kiro/acpClient";
import { CANCEL_TIMEOUT_MS } from "../config/constants";
import { dbWorker, isDbWorkerReady } from "../services/dbWorkerClient";
import { RuntimeRecoveryRequiredError } from './runtimeLifecycle';
import { buildPageManifest } from '../services/pages/pageManifest';
import { isAssistantNode } from '../assistant/identity';
import { assistantCwd } from '../assistant/store';
import { prepareAssistantAttachments } from '../assistant/attachments';
import { ReportedRuntimeError } from 'michi-runtime/internal/contract/errors';
import { descriptorOf } from "michi-runtime/internal/core/descriptors";
import { chatNodeOf, isRunOwner } from './ownerMapping';

export interface HubSubscriber {
  send(ev: ChatStreamEvent): void;
  close(): void;
}

/** Window-scoped feed; internal consumers remain self-turn-only by default. */
export interface BackgroundSubscriber {
  send(chatId: string, ev: ChatStreamEvent, selfInitiated?: boolean): void;
  includeForeground?: boolean;
  gap?(chatId: string, durableCursor: BackgroundCursor): void;
  close(): void;
  /** Undefined in desktop mode; fixed authenticated owner in cloud mode. */
  ownerUserId?: string | null;
}

export interface BackgroundCursor {
  turnId: string;
  seq: number;
}

export interface BackgroundSubscribeOptions {
  cursors?: Readonly<Record<string, BackgroundCursor>>;
  /** Latest owner-scoped SQLite cursor, used to distinguish idle from a gap. */
  durableCursors?: Readonly<Record<string, BackgroundCursor>>;
}

interface LoggedEvent {
  seq: number;
  ev: ChatStreamEvent;
}

interface TurnLog {
  chatId: string;
  turnId: string;
  assistantId: string;
  nodeId: string;
  wireText: string;
  events: LoggedEvent[];
  status: "active" | "ended" | "error";
  nextSeq: number;
  snapshot: DurableTurnSnapshot;
  lastCheckpointAt: number;
  checkpointCount: number;
  selfInitiated: boolean;
  ownerUserId: string | null;
  /** See StartTurnArgs.humanOrigin. */
  humanOrigin?: boolean;
  /** Stops the runtime turn behind a self-turn (see StartSelfTurnArgs.cancel). */
  selfCancel?: () => Promise<CancelAck | void> | CancelAck | void;
  /** Permission handles remain transient. Keep unresolved interaction handles
   * so gap recovery can restore actionable UI alongside the durable transcript. */
  pendingPermission?: ChatStreamEvent;
  pendingUserInput?: ChatStreamEvent;
  /** Commit accepted input before done/error so queue flushing cannot resend it. */
  pendingSteers?: Set<Promise<unknown>>;
  /** Runtime completion and the cancel timeout share one durability boundary. */
  finalization?: Promise<void>;
  /**
   * Set only inside the existing finishWithPersistenceError path, beside its
   * pre-existing effects (log.status = "error", the live broadcast event).
   * This is IN-MEMORY ONLY and does not survive a process restart — nothing
   * here is written to SQLite. After a restart this process never sees the
   * turn again (getSnapshot returns null for it), so a caller must fall back
   * to the database and report commitState=unknown rather than trusting a
   * stale in-memory conclusion. Do not treat the absence of this field after
   * a restart as proof the commit succeeded.
   */
  lastPersistenceError?: { message: string; recoverable: boolean; occurredAt: number };
}

export interface TurnPersistence {
  begin(snapshot: DurableTurnSnapshot): void | Promise<void>;
  checkpoint(snapshot: DurableTurnSnapshot): void;
  finalize(snapshot: DurableTurnSnapshot): void | Promise<void>;
}

const repositoryTurnPersistence: TurnPersistence = {
  begin: (snapshot) => {
    if (isDbWorkerReady()) {
      return dbWorker.beginTurn(snapshot).then(() => {});
    }
    beginTurn(snapshot);
  },
  checkpoint: (snapshot) => {
    // Defer the write so the current tick can finish broadcasting SSE events.
    // When the worker is ready, the write happens off-thread entirely.
    // Checkpoints are idempotent and non-critical — if one is skipped due to
    // process exit, finalize will persist the canonical terminal state.
    if (isDbWorkerReady()) {
      // Fire-and-forget: the worker handles the write off-thread.
      dbWorker.checkpointTurn(snapshot).catch((err) => {
        console.warn(`[turnPersistence] worker checkpoint failed for turn ${snapshot.turnId}:`, err);
      });
    } else {
      setImmediate(() => {
        try {
          checkpointTurn(snapshot);
        } catch (err) {
          console.warn(`[turnPersistence] deferred checkpoint failed for turn ${snapshot.turnId}:`, err);
        }
      });
    }
  },
  finalize: (snapshot) => {
    if (isDbWorkerReady()) {
      return dbWorker.finalizeTurn(snapshot).then(() => {});
    }
    finalizeTurn(snapshot);
  },
};

export interface StartTurnArgs {
  chatId: string;
  nodeId: string;
  text: string;
  displayText?: string;
  enableKiroSidecarTitle?: boolean;
  userMetadata?: DurableMessageMetadata;
  session: AgentSession;
  turnId?: string;
  ownerUserId?: string | null;
  /** The text came from a person (the composer route), not from an agent. */
  humanOrigin?: boolean;
}

export interface SidecarTitleRequest {
  session: AgentSession;
  nodeId: string;
  /** The user's message as displayed, without mention expansion or attachments. */
  userText: string;
  /** Quoted/selected text the user is replying to, giving the title its subject. */
  contextText?: string;
}

/**
 * Produces a sidebar title while the main turn is still running. Resolves
 * `null` when the runtime has no cheap title path; the hub then relies on
 * the agent's own title sentinel.
 */
export type SidecarTitleGenerator = (request: SidecarTitleRequest) => Promise<string | null>;

const runtimeSidecarTitleGenerator: SidecarTitleGenerator = async ({ session, userText, contextText }) => {
  const runtime = getRuntime(session.runtimeId);
  if (!runtime?.generateTitle) return null;
  return runtime.generateTitle({ userText, contextText });
};

export interface StartedTurn {
  turnId: string;
  assistantId: string;
  done: Promise<void>;
}

/**
 * Read-only observation of a chat's most relevant turn, keyed by nodeId.
 * This is a LOCAL type owned by this task (P1-5) — the shared pane-inspection
 * DTO mapping happens elsewhere (P1-2), which maps this shape onto its own
 * contract rather than this file importing one.
 *
 * `inMemoryStatus` and `durableStatus` are DIFFERENT enums with DIFFERENT
 * meanings (see TurnLog.status vs DurableTurnSnapshot.status) — conflating
 * them is exactly how a failed commit gets reported as a success.
 * `inMemoryStatus` is this process's view of the TurnLog; `durableStatus` is
 * the last snapshot.status this process computed, which is NOT the same as
 * "committed to SQLite" — see lastPersistenceError and the restart note on
 * getSnapshot below.
 */
export interface ChatObservationSnapshot {
  chatId: string;
  nodeId: string;
  turnId: string;
  assistantId: string;
  /** TurnLog['status'] — this process's in-memory view of the turn. */
  inMemoryStatus: "active" | "ended" | "error";
  /** log.snapshot.status — the durable-shaped status as last computed by
   * applyTurnEvent in this process. NOT proof of a committed SQLite row;
   * see lastPersistenceError and the restart-honesty note on getSnapshot. */
  durableStatus: DurableTurnSnapshot["status"];
  stopReason?: string;
  error?: string;
  /** Structurally-copied DurableTurnSnapshot — safe for the caller to hold
   * and mutate without affecting ChatHub's own state. */
  snapshot: DurableTurnSnapshot;
  /** Last ASSIGNED seq for this turn (log.nextSeq - 1), in the same shape as
   * BackgroundCursor so a snapshot-then-subscribe handoff can use it as the
   * native watermark without inventing a second cursor shape. -1 when no
   * event has been assigned a seq yet. */
  cursor: { turnId: string; seq: number };
  startedAt: number;
  completedAt?: number;
  /** True when a permission or user-input card is currently unresolved.
   * Only a boolean + a human-readable reason are exposed — never the raw
   * ChatStreamEvent, which may carry permission options / executable
   * actions (design §10 forbids those from reaching an observer). */
  pendingInteraction: { waiting: false } | { waiting: true; reason: string };
  /** Wall-clock time cancel() was invoked for this turn, or null if no
   * cancellation has been requested. Cleared once the turn ends (naturally
   * or via force-finish) or is evicted before it started. */
  cancelRequestedAt: number | null;
  /** Set only by the existing finishWithPersistenceError path. IN-MEMORY
   * ONLY — see the doc-comment on TurnLog.lastPersistenceError. null does
   * NOT mean "committed successfully"; it only means this process never
   * recorded a persistence failure for this turn (which is also true for a
   * turn this process never saw at all, e.g. after a restart). */
  lastPersistenceError: { message: string; recoverable: boolean; occurredAt: number } | null;
  selfInitiated: boolean;
}

export interface StartSelfTurnArgs {
  chatId: string;
  nodeId: string;
  /**
   * Stops the runtime's own turn when the user presses Stop and no session
   * is attached (see session). Without either, Stop only force-finishes the
   * turn in Michi after the cancel timeout.
   */
  cancel?: () => Promise<CancelAck | void> | CancelAck | void;
  ownerUserId?: string | null;
  events: AsyncIterableIterator<NormalizedEvent>;
  /** The manager attaches the native owner so Stop also interrupts work
   * initiated while the runtime was idle. */
  session?: AgentSession;
}

export interface StartRequestedSelfTurnArgs {
  chatId: string;
  nodeId: string;
  ownerUserId?: string | null;
  turnId: string;
  text: string;
  session: AgentSession;
  /** When non-empty, the turn keeps a visible, persisted user message with
   * this text (cross-thread messages). Keep it equivalent to `text` so
   * history reconstruction matches what the runtime received. Retries with
   * the same turnId must pass the same value. */
  displayText?: string;
  userMetadata?: DurableMessageMetadata;
  /** Trusted, server-created maintenance plan bindings for an isolated scheduled session. */
  maintenanceContext?: MaintenanceTurnContext;
}

export interface StartedRequestedSelfTurn extends StartedTurn {
  existing: boolean;
}

interface DurableTurnIdentity {
  turnId: string;
  nodeId: string;
  assistantId: string;
  status: "active" | "completed" | "cancelled" | "error";
}

export const ENDED_LOG_RETENTION_MS = 60_000;
export const TURN_CHECKPOINT_INTERVAL_MS = 1_500;

const STRUCTURAL_EVENTS = new Set<ChatStreamEvent['event']>([
  CHAT_STREAM_EVENTS.plan,
  CHAT_STREAM_EVENTS.toolCall,
  CHAT_STREAM_EVENTS.image,
  CHAT_STREAM_EVENTS.title,
  CHAT_STREAM_EVENTS.followUps,
  CHAT_STREAM_EVENTS.branchOverview,
  CHAT_STREAM_EVENTS.steerAccepted,
  CHAT_STREAM_EVENTS.userInputRequest,
  CHAT_STREAM_EVENTS.userInputResolved,
  CHAT_STREAM_EVENTS.usageSummary,
  CHAT_STREAM_EVENTS.warning,
]);

/** The runtime reported a non-empty branch overview (set_branch_overview), so the turn need not derive one. */
function reportsBranchOverview(ev: NormalizedEvent): boolean {
  if (ev.kind !== "host_event" || ev.type !== "branch_overview") return false;
  const product = decodeMichiHostEvent(ev);
  return product?.type === "branch_overview" && product.payload.overview.trim().length > 0;
}

/** What a turn stops with on a runtime_error event; ReportedRuntimeError keeps its code. */
function runtimeEventError(ev: Extract<NormalizedEvent, { kind: "runtime_error" }>): Error {
  return ev.recoveryRequired ? new RuntimeRecoveryRequiredError(ev.error) : new ReportedRuntimeError(ev);
}

/**
 * The wire error codes a runtime_error code may set: the error kinds Michi's
 * UI shows a banner for. Other wire codes (turn_active, turn_persistence_failed
 * and the like) change what the client does, so a runtime's own code never
 * reaches them.
 */
const RUNTIME_ERROR_KINDS: ReadonlySet<string> = new Set(["connection", "auth", "generic"]);

export class ChatHub {
  private readonly turns = new Map<string, TurnLog>();
  /** Recently completed logs kept in order so reconnect can cross turn ids. */
  private readonly retainedTurns = new Map<string, TurnLog[]>();
  private readonly subscribers = new Map<string, Set<HubSubscriber>>();
  private readonly backgroundSubscribers = new Set<BackgroundSubscriber>();
  private readonly activeSessions = new Map<string, AgentSession>();
  private readonly activeTurnCompletions = new Map<string, Promise<void>>();
  private readonly selfTurnQueues = new Map<string, Promise<void>>();
  private readonly pendingSelfTurns = new Set<string>();
  private readonly requestedSelfTurnCompletions = new Map<string, Promise<void>>();
  /** Turn-scoped cancellation prevents a delayed Stop for turn A from
   * cancelling turn B on the same chat. Entries may also reserve a
   * client-minted turn id when cancel wins the race against POST /message. */
  private readonly cancelledTurnIds = new Set<string>();
  /** Parallel to cancelledTurnIds, recording when cancellation was requested
   * so a read-only observer can derive a "cancelling" activity state and
   * apply a cancel-timeout rule without a dedicated ChatHub state machine.
   * Written/cleared at every site that adds/removes from cancelledTurnIds —
   * never read by cancel()/finish*() themselves, so it cannot perturb the
   * existing cancellation behaviour. */
  private readonly cancelRequestedAt = new Map<string, number>();
  /** Force-finish timers keyed by chatId. Cleared when the turn ends naturally. */
  private readonly cancelTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private shuttingDown = false;
  private readonly retentionMs: number;
  private readonly persistence: TurnPersistence;
  private readonly checkpointIntervalMs: number;
  private readonly workspaceIdForNode: (nodeId: string) => string | null;
  private readonly lookupDurableTurn: (turnId: string) => DurableTurnIdentity | null;
  private readonly titleGenerator: SidecarTitleGenerator | null;
  private readonly nodeTitle: (nodeId: string) => string | null;
  private readonly pageManifestBuilder: typeof buildPageManifest;

  constructor(opts: {
    retentionMs?: number;
    persistence?: TurnPersistence;
    checkpointIntervalMs?: number;
    workspaceIdForNode?: (nodeId: string) => string | null;
    lookupDurableTurn?: (turnId: string) => DurableTurnIdentity | null;
    /** `null` disables sidecar title generation (tests, agent-run-only hubs). */
    titleGenerator?: SidecarTitleGenerator | null;
    nodeTitle?: (nodeId: string) => string | null;
    /** Injectable so focused turn tests can verify model-only context wiring. */
    pageManifestBuilder?: typeof buildPageManifest;
  } = {}) {
    this.retentionMs = opts.retentionMs ?? ENDED_LOG_RETENTION_MS;
    this.persistence = opts.persistence ?? repositoryTurnPersistence;
    this.checkpointIntervalMs = opts.checkpointIntervalMs ?? TURN_CHECKPOINT_INTERVAL_MS;
    this.workspaceIdForNode = opts.workspaceIdForNode
      ?? ((nodeId) => getNode(nodeId)?.workspace_id ?? null);
    this.pageManifestBuilder = opts.pageManifestBuilder ?? buildPageManifest;
    // A hub built with injected persistence is a test harness; it must not
    // reach into the runtime registry unless the test asks for it.
    this.titleGenerator = opts.titleGenerator === undefined
      ? (opts.persistence ? null : runtimeSidecarTitleGenerator)
      : opts.titleGenerator;
    this.nodeTitle = opts.nodeTitle ?? ((nodeId) => getNode(nodeId)?.title ?? null);
    this.lookupDurableTurn = opts.lookupDurableTurn ?? ((turnId) => {
      const row = getDb().prepare(`SELECT turn_id, node_id, assistant_message_id, status
        FROM turns WHERE turn_id = ?`).get(turnId) as {
          turn_id: string;
          node_id: string;
          assistant_message_id: string;
          status: DurableTurnIdentity['status'];
        } | undefined;
      return row ? {
        turnId: row.turn_id,
        nodeId: row.node_id,
        assistantId: row.assistant_message_id,
        status: row.status,
      } : null;
    });
  }

  /** Mark intentional teardown before disposing runtime sessions. Their exit
   * errors must retain the restart reason in the durable receipt. */
  prepareForShutdown(): void {
    this.shuttingDown = true;
  }

  isActive(chatId: string): boolean {
    return this.turns.get(chatId)?.status === "active";
  }

  isOwnerTurnActive(chatId: string): boolean {
    return this.activeSessions.has(chatId);
  }

  /** A backend-requested or runtime self-turn is queued or running for this
   * chat. startTurn rejects while this holds, so callers can report a busy
   * chat as `turn_active` instead of a begin failure. */
  hasPendingSelfTurn(chatId: string): boolean {
    return this.pendingSelfTurns.has(chatId);
  }

  activeOwnerTurnId(chatId: string): string | undefined {
    return this.activeSessions.has(chatId) ? this.turns.get(chatId)?.turnId : undefined;
  }

  activeDurableTurnIds(): ReadonlySet<string> {
    return new Set([...this.turns.values()]
      .filter((turn) => turn.status === 'active')
      .map((turn) => turn.turnId));
  }

  requestedTurnStatus(turnId: string): DurableTurnIdentity['status'] | null {
    return this.lookupDurableTurn(turnId)?.status ?? null;
  }

  resolveActiveInvocationAnchor(input: {
    runtimeSessionId: string | null;
    nodeId: string;
    ownerUserId: string;
    runtimeToolCallId: string | null;
  }): { turnId: string; messageId: string; toolCallId: string | null } | null {
    const candidates = [...new Set([input.runtimeSessionId, input.nodeId].filter((value): value is string => !!value))];
    for (const chatId of candidates) {
      const log = this.turns.get(chatId);
      if (!log || log.status !== 'active' || log.nodeId !== input.nodeId) continue;
      if (log.ownerUserId !== null && log.ownerUserId !== input.ownerUserId) continue;
      return {
        turnId: log.turnId,
        messageId: log.assistantId,
        toolCallId: input.runtimeToolCallId,
      };
    }
    return null;
  }

  /**
   * Read-only observation entry point. Does NOT stamp an event, touch
   * nextSeq, checkpoint, notify subscribers, or delete from any map — a
   * turn streaming concurrently is completely unaffected by this call.
   *
   * Lookup order (COMMON decision 1): this.turns.get(nodeId) first — verified
   * that routes/michi.ts:1417 starts foreground turns with
   * `chatId: nodeId, nodeId`, so chatId===nodeId in that path but is NOT a
   * type-enforced invariant elsewhere (resolveActiveInvocationAnchor above
   * treats them as separate candidates). Falls back to scanning
   * this.turns.values() for log.nodeId === nodeId, then this.retainedTurns,
   * preferring an active log over an ended one, and the most recently ended
   * one otherwise.
   *
   * Returns null when this ChatHub instance (this process) has no in-memory
   * knowledge of the node. null means exactly that — NOT "no turn ever
   * existed for this node". In particular, after a process restart every
   * turn this process previously knew about is gone (ChatHub has no
   * boot-time reconstruction), so getSnapshot correctly returns null for a
   * turn that may well have committed successfully to SQLite before the
   * restart. The caller is responsible for falling back to the database and
   * reporting commitState=unknown in that case — this method must not be
   * used to conclude a turn failed or never happened.
   */
  getSnapshot(nodeId: string): ChatObservationSnapshot | null {
    const direct = this.turns.get(nodeId);
    const log = direct && direct.nodeId === nodeId ? direct : this.findLogByNodeId(nodeId);
    if (!log) return null;
    return this.toObservationSnapshot(log);
  }

  private findLogByNodeId(nodeId: string): TurnLog | null {
    let bestActive: TurnLog | null = null;
    for (const candidate of this.turns.values()) {
      if (candidate.nodeId !== nodeId) continue;
      if (candidate.status === "active") return candidate;
      if (!bestActive) bestActive = candidate;
    }
    if (bestActive) return bestActive;
    let bestEnded: TurnLog | null = null;
    for (const candidates of this.retainedTurns.values()) {
      for (const candidate of candidates) {
        if (candidate.nodeId !== nodeId) continue;
        if (!bestEnded || candidate.snapshot.startedAt > bestEnded.snapshot.startedAt) {
          bestEnded = candidate;
        }
      }
    }
    return bestEnded;
  }

  private toObservationSnapshot(log: TurnLog): ChatObservationSnapshot {
    const pendingInteraction: ChatObservationSnapshot["pendingInteraction"] = log.pendingPermission
      ? { waiting: true, reason: this.permissionReason(log.pendingPermission) }
      : log.pendingUserInput
        ? { waiting: true, reason: this.userInputReason(log.pendingUserInput) }
        : { waiting: false };
    return {
      chatId: log.chatId,
      nodeId: log.nodeId,
      turnId: log.turnId,
      assistantId: log.assistantId,
      inMemoryStatus: log.status,
      durableStatus: log.snapshot.status,
      stopReason: log.snapshot.stopReason,
      error: log.snapshot.error,
      snapshot: structuredClone(log.snapshot),
      cursor: { turnId: log.turnId, seq: log.nextSeq - 1 },
      startedAt: log.snapshot.startedAt,
      completedAt: log.snapshot.completedAt,
      pendingInteraction,
      cancelRequestedAt: this.cancelRequestedAt.get(log.turnId) ?? null,
      lastPersistenceError: log.lastPersistenceError
        ? { ...log.lastPersistenceError }
        : null,
      selfInitiated: log.selfInitiated,
    };
  }

  private permissionReason(event: ChatStreamEvent): string {
    return event.event === CHAT_STREAM_EVENTS.permissionRequest && event.data.title
      ? event.data.title
      : "waiting for permission";
  }

  private userInputReason(event: ChatStreamEvent): string {
    if (event.event === CHAT_STREAM_EVENTS.userInputRequest) {
      const first = event.data.questions?.[0]?.question;
      if (first) return first;
    }
    return "waiting for user input";
  }

  async startTurn(args: StartTurnArgs): Promise<StartedTurn> {
    if (this.isActive(args.chatId) || this.isOwnerTurnActive(args.chatId) || this.pendingSelfTurns.has(args.chatId)) {
      throw new Error('a turn is already active for this chat');
    }
    // Claim the chat before the first await: a self-turn that starts while
    // this turn persists its first rows must wait for it, not begin beside
    // it (the later log would replace this one and leave it unfinished).
    let settleStart!: (completion?: Promise<void>) => void;
    const starting = new Promise<void>((resolve) => { settleStart = (completion) => resolve(completion); });
    this.activeTurnCompletions.set(args.chatId, starting);
    // In the same step, let a turn the runtime started on its own (and has
    // not shown yet) give way, so it cannot begin showing behind this turn.
    const releaseClaim = args.session.claimTurn?.();
    try {
      const started = await this.beginTurn(args, (done) => settleStart(done.catch(() => {})));
      void started.done.then(() => releaseClaim?.(), () => releaseClaim?.());
      return started;
    } catch (error) {
      if (this.activeTurnCompletions.get(args.chatId) === starting) this.activeTurnCompletions.delete(args.chatId);
      settleStart();
      releaseClaim?.();
      throw error;
    }
  }

  private async beginTurn(args: StartTurnArgs, started: (done: Promise<void>) => void): Promise<StartedTurn> {
    const turnId = args.turnId ?? randomUUID();
    if (this.cancelledTurnIds.delete(turnId)) {
      this.cancelRequestedAt.delete(turnId);
      throw new Error(`turn ${turnId} was cancelled before it started`);
    }
    const assistantId = `a-${args.nodeId}-${turnId}`;
    const log = this.createLog({
      chatId: args.chatId,
      turnId,
      assistantId,
      nodeId: args.nodeId,
      wireText: args.text,
      displayText: args.displayText ?? args.text,
      userMetadata: args.userMetadata,
      selfInitiated: false,
      ownerUserId: args.ownerUserId ?? null,
    });
    if (args.humanOrigin) log.humanOrigin = true;
    // The durable provisional rows are the prerequisite for both runtime
    // execution and the visible turn_start frame.
    const persistStartedAt = Date.now();
    await this.persistence.begin(log.snapshot);
    logInfo('turn begin committed', log, {
      durationMs: Date.now() - persistStartedAt,
      runtimeId: args.session.runtimeId,
      nativeSessionId: args.session.nativeSessionId ?? args.session.id,
    });
    this.turns.set(args.chatId, log);
    this.activeSessions.set(args.chatId, args.session);
    this.append(args.chatId, log, {
      event: CHAT_STREAM_EVENTS.turnStart,
      data: {
        turnId,
        assistantId,
        nodeId: args.nodeId,
        userText: args.displayText ?? args.text,
        ...(args.userMetadata ? { userMetadata: args.userMetadata } : {}),
        startedAt: log.snapshot.startedAt,
      },
    }, false);
    if (!this.cancelledTurnIds.has(turnId)) this.maybeGenerateTitle(args, log);
    const done = this.runTurn(args.chatId, log, args.session);
    this.activeTurnCompletions.set(args.chatId, done);
    started(done);
    void done.then(() => {
      if (this.activeTurnCompletions.get(args.chatId) === done) {
        this.activeTurnCompletions.delete(args.chatId);
      }
    }, () => {
      if (this.activeTurnCompletions.get(args.chatId) === done) {
        this.activeTurnCompletions.delete(args.chatId);
      }
    });
    return { turnId, assistantId, done };
  }

  subscribe(
    chatId: string,
    sub: HubSubscriber,
    opts: { fromTurnId?: string; fromSeq?: number } = {},
  ): () => void {
    const set = this.subscribersFor(chatId);
    set.add(sub);
    // Generic internal subscribers retain historical all-turn semantics.
    // Public foreground routes use subscribeTurn() below, which is strictly
    // foreground-only and pinned to a concrete turn id.
    const logs = this.replayableLogs(chatId);
    if (logs.length > 0) {
      const matchingIndex = opts.fromTurnId
        ? logs.findIndex((log) => log.turnId === opts.fromTurnId)
        : -1;
      const startIndex = matchingIndex >= 0 ? matchingIndex : logs.length - 1;
      for (let index = startIndex; index < logs.length; index += 1) {
        const log = logs[index];
        const fromSeq = index === matchingIndex ? opts.fromSeq ?? 0 : 0;
        for (const { seq, ev } of log.events) {
          if (seq >= fromSeq) sub.send(ev);
        }
      }
    }
    return () => {
      set.delete(sub);
      if (set.size === 0) this.subscribers.delete(chatId);
    };
  }

  subscribeBackground(
    sub: BackgroundSubscriber,
    opts: BackgroundSubscribeOptions = {},
  ): () => void {
    const cursors = opts.cursors ?? {};
    const durableCursors = opts.durableCursors ?? {};
    const chatIds = new Set([
      ...this.retainedTurns.keys(),
      ...this.turns.keys(),
      ...Object.keys(cursors),
    ]);
    const gaps: Array<{ chatId: string; cursor: BackgroundCursor }> = [];
    const replayPlans: Array<{
      chatId: string;
      logs: TurnLog[];
      replayCursor?: BackgroundCursor;
      startIndex: number;
    }> = [];
    for (const chatId of chatIds) {
      // retainedTurns is append-only oldest→newest. Current is newer than a
      // retained predecessor; preserve that order so reconnect never sends a
      // prior turn after a later turn has advanced the reducer watermark.
      const logs = [...(this.retainedTurns.get(chatId) ?? [])];
      const current = this.turns.get(chatId);
      if (current && !logs.includes(current)) logs.push(current);
      const cursor = cursors[chatId];
      let replayCursor = cursor;
      let startIndex = 0;
      if (cursor) {
        const matchingIndex = logs.findIndex((log) => log.turnId === cursor.turnId);
        if (matchingIndex < 0) {
          const durable = durableCursors[chatId];
          const durableIsNotAhead = durable
            && durable.turnId === cursor.turnId
            && durable.seq <= cursor.seq;
          if (!durable || durableIsNotAhead) continue;
          gaps.push({ chatId, cursor: durable });

          // SQLite is authoritative through durable.seq. Continue with any
          // newer in-memory frames after the frontend has installed that
          // snapshot. If the durable turn itself has already left the ring,
          // there is no safe tail to replay.
          const durableIndex = logs.findIndex((log) => log.turnId === durable.turnId);
          if (durableIndex < 0) continue;
          startIndex = durableIndex;
          replayCursor = durable;
        } else {
          startIndex = matchingIndex;
        }
      }
      replayPlans.push({ chatId, logs, replayCursor, startIndex });
    }

    // Gap is a graph/state barrier, not merely another chat event. Emit every
    // barrier before any ordinary replay frame so a newly discovered child is
    // installed by the frontend before that child's turn/interaction frames
    // can arrive. This also makes cross-chat replay independent of Map
    // insertion order.
    for (const { chatId, cursor } of gaps) {
      sub.gap?.(chatId, cursor);
    }

    for (const { chatId, logs, replayCursor, startIndex } of replayPlans) {
      if (replayCursor) {
        const cursorLog = logs.find((log) =>
          log.turnId === replayCursor!.turnId
          && (log.selfInitiated || sub.includeForeground)
          && log.status === 'active'
          && (sub.ownerUserId === undefined || sub.ownerUserId === log.ownerUserId),
        );
        if (cursorLog) {
          for (const event of this.pendingInteractionRecovery(cursorLog, replayCursor.seq)) {
            sub.send(chatId, event, cursorLog.selfInitiated);
          }
        }
      }
      for (let index = startIndex; index < logs.length; index += 1) {
        const log = logs[index];
        if (!log.selfInitiated && !sub.includeForeground) continue;
        if (sub.ownerUserId !== undefined && sub.ownerUserId !== log.ownerUserId) continue;
        const fromSeq = replayCursor && index === startIndex ? replayCursor.seq + 1 : 0;
        for (const { seq, ev } of log.events) {
          if (seq >= fromSeq) sub.send(chatId, ev, log.selfInitiated);
        }
      }
    }
    // Replay is synchronous; registering only after it succeeds avoids
    // leaking a subscriber when its writer throws before a detach callback can
    // be returned to the route.
    this.backgroundSubscribers.add(sub);
    return () => this.backgroundSubscribers.delete(sub);
  }

  /** Attach to exactly one foreground turn. Used by /message resumption. */
  subscribeTurn(
    chatId: string,
    turnId: string,
    sub: HubSubscriber,
    fromSeq = 0,
  ): (() => void) | null {
    const log = this.replayableLogs(chatId).find((candidate) =>
      candidate.turnId === turnId && !candidate.selfInitiated,
    );
    if (!log) return null;
    const guarded: HubSubscriber = {
      send: (event) => {
        if (event.data.turnId === turnId) sub.send(event);
      },
      close: () => sub.close(),
    };
    const set = this.subscribersFor(chatId);
    set.add(guarded);
    for (const { seq, ev } of log.events) {
      if (seq >= fromSeq) guarded.send(ev);
    }
    if (log.status !== 'active') guarded.close();
    return () => {
      set.delete(guarded);
      if (set.size === 0) this.subscribers.delete(chatId);
    };
  }

  private replayableLogs(chatId: string): TurnLog[] {
    const retained = this.retainedTurns.get(chatId) ?? [];
    const current = this.turns.get(chatId);
    if (!current || retained.includes(current)) return [...retained];
    return [...retained, current];
  }

  cancel(chatId: string, requestedTurnId?: string): boolean {
    const log = this.turns.get(chatId);
    if (!log || log.status !== "active") {
      if (requestedTurnId) {
        this.cancelledTurnIds.add(requestedTurnId);
        this.cancelRequestedAt.set(requestedTurnId, Date.now());
        const expiry = setTimeout(() => {
          this.cancelledTurnIds.delete(requestedTurnId);
          this.cancelRequestedAt.delete(requestedTurnId);
        }, this.retentionMs);
        expiry.unref?.();
      }
      return false;
    }
    const turnId = requestedTurnId ?? log.turnId;
    if (turnId !== log.turnId) return false;
    this.cancelledTurnIds.add(log.turnId);
    this.cancelRequestedAt.set(log.turnId, Date.now());
    this.append(chatId, log, {
      event: CHAT_STREAM_EVENTS.cancelPhase,
      data: {
        phase: "requested",
        source: "michi_simulated",
        confidence: "projected",
        nativeMethod: "cancel",
      },
    });
    const session = this.activeSessions.get(chatId);
    void Promise.resolve(session ? session.cancel() : log.selfCancel?.()).then((ack) => {
      const current = this.turns.get(chatId);
      if (!current || current.turnId !== log.turnId || current.status !== "active") return;
      if (ack && typeof ack === "object" && ack.acknowledged === true) {
        this.append(chatId, current, {
          event: CHAT_STREAM_EVENTS.cancelPhase,
          data: {
            phase: "acknowledged",
            // Provenance comes from the runtime, not from the fact that an ack
            // arrived. Kiro's ACP notify and Claude's confirmed process death
            // are `inferred`; only Codex/Pi have a real interrupt response.
            source: ack.source ?? "native",
            confidence: ack.confidence ?? "native",
            nativeMethod: ack.nativeMethod ?? "cancel",
          },
        });
      }
    }).catch(() => {});
    // Start a force-finish timer: if the streaming generator does not end
    // within the deadline, force the turn into a terminal state so the chat
    // is never stuck on "Cancel requested" indefinitely.
    this.scheduleCancelTimeout(chatId, log);
    return true;
  }

  /**
   * Cancel the active turn and wait for it to finish (with a timeout).
   * Returns once the turn is no longer active, either because it ended
   * naturally, was force-finished by the timeout, or was not active to
   * begin with.
   */
  async cancelAndWait(chatId: string, timeoutMs = CANCEL_TIMEOUT_MS): Promise<void> {
    const log = this.turns.get(chatId);
    if (!log || log.status !== "active") return;
    const turnId = log.turnId;
    this.cancel(chatId, turnId);

    // Wait for the active turn to complete (or the force-finish timer to fire).
    const done = this.activeTurnCompletions.get(chatId)
      ?? this.selfTurnQueues.get(chatId);
    if (!done) return;
    await Promise.race([
      done.catch(() => {}),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    // If the turn is still active after the race, the force-finish timer
    // from cancel() will handle it. Either way, the caller can proceed.
  }

  private scheduleCancelTimeout(chatId: string, log: TurnLog): void {
    // Clear any previous timer for this chat (idempotent cancel).
    const prev = this.cancelTimers.get(chatId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(async () => {
      this.cancelTimers.delete(chatId);
      const current = this.turns.get(chatId);
      if (!current || current.turnId !== log.turnId || current.status !== "active") return;
      appLog.warn('chat', 'cancel timeout: force-finishing stuck turn', {
        turnId: log.turnId,
        nodeId: log.nodeId,
        elapsedMs: Date.now() - (log.snapshot.startedAt ?? 0),
      });
      try {
        await this.finishWithDone(chatId, current, 'cancelled');
      } catch (err) {
        appLog.warn('chat', 'cancel timeout force-finish failed', {
          turnId: log.turnId,
          nodeId: log.nodeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (this.turns.get(chatId) !== current) return;
      // Clean up the active session reference so isActive() returns false.
      this.activeSessions.delete(chatId);
      for (const sub of this.subscribers.get(chatId) ?? []) {
        try { sub.close(); } catch { /* ignore */ }
      }
      this.scheduleEvict(chatId, current);
    }, CANCEL_TIMEOUT_MS);
    timer.unref?.();
    this.cancelTimers.set(chatId, timer);
  }

  private clearCancelTimer(chatId: string): void {
    const timer = this.cancelTimers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      this.cancelTimers.delete(chatId);
    }
  }

  async steer(chatId: string, text: string, options: SteerMessageOptions = {}): Promise<SteerResult & {
    message?: Extract<ChatStreamEvent, { event: 'steer_accepted' }>['data'];
  }> {
    const session = this.activeSessions.get(chatId);
    const log = this.turns.get(chatId);
    if (!session?.steer || !log || log.status !== 'active' || log.finalization) {
      return { accepted: false, reason: 'invisible' };
    }
    const steer = session.steer.bind(session);
    const operation = (async () => {
      const result = await steer(text);
      if (result.accepted) {
        const message = {
          text: options.displayText ?? text,
          pending: result.pending ?? true,
          messageId: `u-steer-${randomUUID()}`,
          createdAt: Date.now(),
          userMetadata: options.userMetadata,
          queueId: options.queueId,
          assistantId: log.assistantId,
          turnId: log.turnId,
        };
        this.append(chatId, log, {
          event: CHAT_STREAM_EVENTS.steerAccepted,
          data: {
            ...message,
            source: "native",
            confidence: "native",
            nativeMethod: "steer",
          },
        });
        return { ...result, message };
      }
      return result;
    })();
    (log.pendingSteers ??= new Set()).add(operation);
    try { return await operation; }
    finally { log.pendingSteers.delete(operation); }
  }

  async followUp(chatId: string, text: string): Promise<SteerResult> {
    return this.callOptionalControl(chatId, "followUp", async (session, log) => {
      if (!session.followUp) return { accepted: false, reason: "invisible" };
      const result = await session.followUp(text);
      if (result.accepted) {
        this.append(chatId, log, {
          event: CHAT_STREAM_EVENTS.queueUpdate,
          data: {
            steering: [],
            followUp: [text],
            source: "native",
            confidence: "native",
            nativeMethod: "followUp",
          },
        });
      }
      return result;
    }, { accepted: false, reason: "invisible" });
  }

  async clearQueue(chatId: string): Promise<{ cleared: boolean; reason?: string }> {
    const session = this.activeSessions.get(chatId);
    if (!session?.clearQueue) return { cleared: false, reason: "invisible" };
    await session.clearQueue();
    return { cleared: true };
  }

  /**
   * Compaction is normally requested *between* turns, so this must not require
   * an active turn — it previously did, which made the whole path unreachable
   * in the one state users actually invoke it from. Stream events are only
   * appended when a turn is live to carry them; an idle compaction still runs
   * and reports its result through the HTTP response.
   */
  async compact(
    chatId: string,
    instructions?: string,
    idleSession?: AgentSession,
  ): Promise<CompactResult> {
    // activeSessions only holds a session for the duration of a turn, so an
    // idle compaction has to be handed the live session by the caller (which
    // resolves it from sessionRegistry). Prefer the in-turn session when both
    // are present — they are the same object during a turn.
    const session = this.activeSessions.get(chatId) ?? idleSession;
    if (!session?.compact) return { started: false, detail: "unsupported" };
    const result = await session.compact(instructions);
    const log = this.turns.get(chatId);
    const live = log && log.status === "active" ? log : null;
    if (result.started && live) {
      this.append(chatId, live, {
        event: CHAT_STREAM_EVENTS.compactionStart,
        data: {
          detail: instructions ?? result.detail,
          source: "native",
          confidence: "native",
          nativeMethod: "compact",
        },
      });
      // Runtimes whose compact call resolves on completion (Kiro) have no
      // follow-up event to close the lifecycle, so emit the end here. Codex
      // leaves `completed` unset and its translator emits compaction_end.
      if (result.completed) {
        this.append(chatId, live, {
          event: CHAT_STREAM_EVENTS.compactionEnd,
          data: {
            detail: result.detail,
            source: "native",
            confidence: "native",
            nativeMethod: "compact",
          },
        });
      }
    }
    return result;
  }

  private async callOptionalControl<T>(
    chatId: string,
    _method: string,
    fn: (session: AgentSession, log: TurnLog) => Promise<T>,
    missing: T,
  ): Promise<T> {
    const session = this.activeSessions.get(chatId);
    const log = this.turns.get(chatId);
    if (!session || !log || log.status !== "active") return missing;
    return fn(session, log);
  }

  resolvePermission(chatId: string, requestId: number): void {
    const log = this.turns.get(chatId);
    const pending = log?.pendingPermission;
    if (pending?.event !== CHAT_STREAM_EVENTS.permissionRequest) return;
    if (pending.data.requestId === requestId) log!.pendingPermission = undefined;
  }

  getPendingPermission(chatId: string) {
    const event = this.turns.get(chatId)?.pendingPermission;
    return event?.event === CHAT_STREAM_EVENTS.permissionRequest ? event.data : null;
  }

  getPendingUserInput(chatId: string) {
    const event = this.turns.get(chatId)?.pendingUserInput;
    return event?.event === CHAT_STREAM_EVENTS.userInputRequest ? event.data : null;
  }

  resolveUserInput(chatId: string, requestId: number, answers: UserInputAnswer[] = [], skipped = answers.length === 0): void {
    const log = this.turns.get(chatId);
    const pending = log?.pendingUserInput;
    if (!log || pending?.event !== CHAT_STREAM_EVENTS.userInputRequest || pending.data.requestId !== requestId) return;
    this.append(chatId, log, { event: CHAT_STREAM_EVENTS.userInputResolved, data: {
      requestId, interactionId: pending.data.interactionId,
      answers: normalizeUserInputAnswers(pending.data.questions, answers), outcome: skipped ? 'skipped' : 'answered',
    } });
  }

  startSelfTurn(args: StartSelfTurnArgs): void {
    this.pendingSelfTurns.add(args.chatId);
    const previous = this.selfTurnQueues.get(args.chatId) ?? Promise.resolve();
    const queued = previous
      .catch(() => {})
      .then(async () => {
        // A Claude idle callback can race a user submission. Let the user
        // turn finish before consuming the self-turn iterator, so its log is
        // never overwritten and the two turn histories remain serial.
        const activeForeground = this.activeTurnCompletions.get(args.chatId);
        if (activeForeground) await activeForeground.catch(() => {});
        await this.beginSelfTurn(args);
      })
      .catch(async (err) => {
        // Claude's idle pump has already claimed the first runtime frame and
        // waits for this iterator to finish. If durable setup fails (for
        // example the node was deleted), drain the claimed turn so the pump's
        // single EventQueue waiter and runtime mutex are always released.
        // A runtime that can stop its turn does so first: nobody will see
        // it, so nothing it asks for (approvals) could be answered.
        try { await args.cancel?.(); } catch { /* draining still ends it */ }
        try {
          for await (const discarded of args.events) void discarded;
        } catch {
          // The original initialization error is the actionable one.
        }
        appLog.warn('chat', 'self turn discarded before durable begin', {
          nodeId: args.nodeId,
          errorClass: err instanceof Error ? err.name : 'Error',
          error: err instanceof Error ? err.message : String(err),
        });
      });
    this.selfTurnQueues.set(args.chatId, queued);
    void queued.then(() => {
      if (this.selfTurnQueues.get(args.chatId) === queued) {
        this.selfTurnQueues.delete(args.chatId);
        this.pendingSelfTurns.delete(args.chatId);
      }
    }, () => {
      if (this.selfTurnQueues.get(args.chatId) === queued) {
        this.selfTurnQueues.delete(args.chatId);
        this.pendingSelfTurns.delete(args.chatId);
      }
    });
  }

  /**
   * Starts a backend-requested Parent continuation with a caller-supplied
   * durable turn id. Committing that identity happens before the runtime
   * iterator is consumed. A retry returns the existing terminal turn, or
   * resumes an active turn that survived a crash but is absent in memory.
   */
  async startRequestedSelfTurn(args: StartRequestedSelfTurnArgs): Promise<StartedRequestedSelfTurn> {
    const durable = this.lookupDurableTurn(args.turnId);
    if (durable) {
      this.assertRequestedTurnIdentity(durable, args);
      if (durable.status !== 'active') {
        return { turnId: durable.turnId, assistantId: durable.assistantId, done: Promise.resolve(), existing: true };
      }
      const inMemory = this.turns.get(args.chatId);
      const completion = this.requestedSelfTurnCompletions.get(args.turnId);
      if (inMemory?.turnId === args.turnId && completion) {
        return { turnId: durable.turnId, assistantId: durable.assistantId, done: completion, existing: true };
      }
    }

    this.pendingSelfTurns.add(args.chatId);
    // Queued now, this turn will prompt the session: a turn the runtime
    // starts on its own meanwhile must give way rather than queue behind it
    // (its prompt would then wait for that turn). See startTurn.
    const releaseClaim = args.session.claimTurn?.();
    const previous = this.selfTurnQueues.get(args.chatId) ?? Promise.resolve();
    let started!: StartedRequestedSelfTurn;
    const began = new Promise<void>((resolve, reject) => {
      const queued = previous
        .catch(() => {})
        .then(async () => {
          const activeForeground = this.activeTurnCompletions.get(args.chatId);
          if (activeForeground) await activeForeground.catch(() => {});
          await this.runRequestedSelfTurn(args, (value) => { started = value; resolve(); });
        })
        .finally(() => releaseClaim?.())
        .catch((error) => {
          reject(error);
        });
      this.selfTurnQueues.set(args.chatId, queued);
      void queued.then(() => {
        if (this.selfTurnQueues.get(args.chatId) === queued) {
          this.selfTurnQueues.delete(args.chatId);
          this.pendingSelfTurns.delete(args.chatId);
        }
      }, () => {
        if (this.selfTurnQueues.get(args.chatId) === queued) {
          this.selfTurnQueues.delete(args.chatId);
          this.pendingSelfTurns.delete(args.chatId);
        }
      });
    });
    await began;
    return started;
  }

  /** The body of a requested self-turn once its queue position is reached. */
  private async runRequestedSelfTurn(
    args: StartRequestedSelfTurnArgs,
    onStarted: (started: StartedRequestedSelfTurn) => void,
  ): Promise<void> {
    const existing = this.lookupDurableTurn(args.turnId);
    if (existing) this.assertRequestedTurnIdentity(existing, args);
    const assistantId = existing?.assistantId ?? `self-${args.nodeId}-${args.turnId}`;
    const displayText = args.displayText ?? '';
    const keepUserMessage = displayText.length > 0;
    const log = this.createLog({
      chatId: args.chatId,
      turnId: args.turnId,
      assistantId,
      nodeId: args.nodeId,
      wireText: args.text,
      displayText,
      userMetadata: keepUserMessage ? args.userMetadata : undefined,
      selfInitiated: true,
      keepUserMessage,
      ownerUserId: args.ownerUserId ?? null,
    });
    await this.persistence.begin(log.snapshot);
    this.turns.set(args.chatId, log);
    this.activeSessions.set(args.chatId, args.session);
    this.append(args.chatId, log, {
      event: CHAT_STREAM_EVENTS.turnStart,
      data: {
        turnId: args.turnId,
        assistantId,
        nodeId: args.nodeId,
        userText: displayText,
        selfInitiated: true,
        startedAt: log.snapshot.startedAt,
        ...(keepUserMessage && args.userMetadata ? { userMetadata: args.userMetadata } : {}),
      },
    } as ChatStreamEvent, false);
    const cancelledTurnIds = this.cancelledTurnIds;
    const pageContext = keepUserMessage && !args.maintenanceContext ? this.pageManifestBuilder({
      workspaceId: log.snapshot.workspaceId, nodeId: log.nodeId, ownerUserId: log.ownerUserId,
      now: Date.now(), turnId: log.turnId,
    }) : '';
    const events = (async function* (): AsyncIterableIterator<NormalizedEvent> {
      // Stop can reserve this id while begin() commits, or arrive from
      // a synchronous turn_start subscriber. Never dispatch that work.
      if (cancelledTurnIds.has(log.turnId)) {
        yield { kind: 'turn_end', stopReason: 'cancelled' };
        return;
      }
      yield* args.session.send(args.text, {
        assistantMessageId: assistantId,
        ...(log.snapshot.userMessage?.id ? { userMessageId: log.snapshot.userMessage.id } : {}),
        ...(pageContext ? { pageContext } : {}),
        ...(args.maintenanceContext ? { maintenanceContext: args.maintenanceContext } : {}),
        turnId: log.turnId,
      });
    })();
    const done = this.runSelfTurn(args.chatId, log, events, args.session);
    this.requestedSelfTurnCompletions.set(args.turnId, done);
    void done.then(
      () => this.requestedSelfTurnCompletions.delete(args.turnId),
      () => this.requestedSelfTurnCompletions.delete(args.turnId),
    );
    onStarted({ turnId: args.turnId, assistantId, done, existing: !!existing });
    await done;
  }

  private assertRequestedTurnIdentity(durable: DurableTurnIdentity, args: StartRequestedSelfTurnArgs): void {
    const expectedAssistantId = `self-${args.nodeId}-${args.turnId}`;
    if (durable.nodeId !== args.nodeId || durable.assistantId !== expectedAssistantId) {
      throw new Error(`requested Parent turn ${args.turnId} was reused with a different durable identity`);
    }
  }

  private async beginSelfTurn(args: StartSelfTurnArgs): Promise<void> {
    if (args.session && (
      args.session.id !== args.chatId
      || chatNodeOf(args.session.owner) !== args.nodeId
    )) {
      throw new Error('self turn runtime does not match its chat node owner');
    }
    const turnId = randomUUID();
    const assistantId = `self-${args.nodeId}-${turnId}`;
    const log = this.createLog({
      chatId: args.chatId,
      turnId,
      assistantId,
      nodeId: args.nodeId,
      wireText: '',
      displayText: '',
      selfInitiated: true,
      ownerUserId: args.ownerUserId ?? null,
    });
    if (args.cancel) log.selfCancel = args.cancel;
    const persistStartedAt = Date.now();
    await this.persistence.begin(log.snapshot);
    logInfo('self turn begin committed', log, { durationMs: Date.now() - persistStartedAt });
    this.turns.set(args.chatId, log);
    if (args.session) this.activeSessions.set(args.chatId, args.session);
    this.append(args.chatId, log, {
      event: CHAT_STREAM_EVENTS.turnStart,
      data: {
        turnId,
        assistantId,
        nodeId: args.nodeId,
        userText: '',
        selfInitiated: true,
        startedAt: log.snapshot.startedAt,
      },
    } as ChatStreamEvent, false);
    await this.runSelfTurn(args.chatId, log, args.events, args.session);
  }

  private createLog(input: {
    chatId: string;
    turnId: string;
    assistantId: string;
    nodeId: string;
    wireText: string;
    displayText: string;
    userMetadata?: DurableMessageMetadata;
    selfInitiated: boolean;
    keepUserMessage?: boolean;
    ownerUserId: string | null;
  }): TurnLog {
    const workspaceId = this.workspaceIdForNode(input.nodeId);
    if (!workspaceId) throw new Error(`node ${input.nodeId} does not exist`);
    const startedAt = Date.now();
    return {
      chatId: input.chatId,
      turnId: input.turnId,
      assistantId: input.assistantId,
      nodeId: input.nodeId,
      wireText: input.wireText,
      events: [],
      status: "active",
      nextSeq: 0,
      snapshot: createDurableTurn({
        turnId: input.turnId,
        assistantId: input.assistantId,
        nodeId: input.nodeId,
        workspaceId,
        displayUserText: input.displayText,
        userMetadata: input.userMetadata,
        selfInitiated: input.selfInitiated,
        keepUserMessage: input.keepUserMessage,
        startedAt,
      }),
      lastCheckpointAt: startedAt,
      checkpointCount: 0,
      selfInitiated: input.selfInitiated,
      ownerUserId: input.ownerUserId,
    };
  }

  private async runSelfTurn(
    chatId: string,
    log: TurnLog,
    events: AsyncIterableIterator<NormalizedEvent>,
    session?: AgentSession,
  ): Promise<void> {
    try {
      let branchOverviewPublished = false;
      for await (const ev of events) {
        if (log.status !== 'active' || this.turns.get(chatId) !== log) break;
        if (log.finalization) { await log.finalization; break; }
        if (reportsBranchOverview(ev)) branchOverviewPublished = true;
        if (ev.kind === "runtime_error") throw runtimeEventError(ev);
        if (ev.kind === "turn_end") {
          if (!branchOverviewPublished) {
            branchOverviewPublished = this.publishBranchOverview(chatId, log);
          }
          await this.finishWithDone(
            chatId,
            log,
            this.cancelledTurnIds.has(log.turnId) ? 'cancelled' : ev.stopReason,
          );
          break;
        }
        const wire = toChatStreamEvent(ev);
        if (wire) this.append(chatId, log, wire);
      }
      if (log.finalization) await log.finalization;
      if (log.status === 'active' && this.turns.get(chatId) === log) {
        if (!branchOverviewPublished) this.publishBranchOverview(chatId, log);
        await this.finishWithDone(
          chatId,
          log,
          this.cancelledTurnIds.has(log.turnId) ? 'cancelled' : 'end_turn',
        );
      }
    } catch (err) {
      if (this.cancelledTurnIds.has(log.turnId) && !(err instanceof RuntimeRecoveryRequiredError)) {
        await this.finishWithDone(chatId, log, 'cancelled');
      } else {
        await this.finishWithError(chatId, log, err);
      }
    } finally {
      this.cancelledTurnIds.delete(log.turnId);
      this.cancelRequestedAt.delete(log.turnId);
      if (this.turns.get(chatId) === log) {
        this.clearCancelTimer(chatId);
        if (session && this.activeSessions.get(chatId) === session) this.activeSessions.delete(chatId);
      }
      this.scheduleEvict(chatId, log);
    }
  }

  private subscribersFor(chatId: string): Set<HubSubscriber> {
    let set = this.subscribers.get(chatId);
    if (!set) {
      set = new Set();
      this.subscribers.set(chatId, set);
    }
    return set;
  }

  private stamp(log: TurnLog, ev: ChatStreamEvent): { seq: number; ev: ChatStreamEvent } {
    const seq = log.nextSeq++;
    if (ev.event === CHAT_STREAM_EVENTS.userInputRequest) {
      const interactionId = ev.data.interactionId ?? `${userInputInteractionId(log.turnId, ev.data.requestId)}:${seq}`;
      ev = { ...ev, data: { ...ev.data, interactionId, questions: normalizeUserInputQuestions(interactionId, ev.data.questions) } };
    } else if (ev.event === CHAT_STREAM_EVENTS.userInputResolved) {
      const pending = log.pendingUserInput;
      const requestId = ev.data.requestId;
      const prior = [...log.snapshot.assistantMessage.blocks].reverse().find(block => block.kind === 'user-input' && block.requestId === requestId);
      const priorInteractionId = prior?.kind === 'user-input' ? prior.interaction?.interactionId : undefined;
      const interactionId = ev.data.interactionId ?? (pending?.event === CHAT_STREAM_EVENTS.userInputRequest && pending.data.requestId === ev.data.requestId
        ? pending.data.interactionId : undefined) ?? priorInteractionId ?? userInputInteractionId(log.turnId, ev.data.requestId);
      ev = { ...ev, data: { ...ev.data, interactionId } };
    }
    return {
      seq,
      ev: {
        ...ev,
        data: {
          ...ev.data,
          observedAt: ev.data.observedAt ?? Date.now(),
          chatId: log.chatId,
          nodeId: log.nodeId,
          turnId: log.turnId,
          seq,
          assistantId: log.assistantId,
          source: ev.data.source ?? "michi_simulated",
          confidence: ev.data.confidence ?? "projected",
        },
      } as ChatStreamEvent,
    };
  }

  private append(
    chatId: string,
    log: TurnLog,
    ev: ChatStreamEvent,
    checkpoint = true,
  ): void {
    const stamped = this.stamp(log, ev);
    log.snapshot = applyTurnEvent(log.snapshot, stamped.ev);
    log.events.push(stamped);
    this.trackPendingInteraction(log, stamped.ev);
    this.broadcast(chatId, log, stamped.ev);
    if (checkpoint) this.maybeCheckpoint(log, stamped.ev);
  }

  private trackPendingInteraction(log: TurnLog, event: ChatStreamEvent): void {
    if (event.event === CHAT_STREAM_EVENTS.permissionRequest) {
      log.pendingPermission = event;
    } else if (event.event === CHAT_STREAM_EVENTS.permissionResolved) {
      if (log.pendingPermission?.event === CHAT_STREAM_EVENTS.permissionRequest && log.pendingPermission.data.requestId === event.data.requestId) log.pendingPermission = undefined;
    } else if (event.event === CHAT_STREAM_EVENTS.userInputRequest) {
      log.pendingUserInput = event;
    } else if (
      event.event === CHAT_STREAM_EVENTS.userInputResolved
      && log.pendingUserInput?.event === CHAT_STREAM_EVENTS.userInputRequest
      && log.pendingUserInput.data.requestId === event.data.requestId
      && (!event.data.interactionId || log.pendingUserInput.data.interactionId === event.data.interactionId)
    ) {
      log.pendingUserInput = undefined;
    } else if (event.event === CHAT_STREAM_EVENTS.done || event.event === CHAT_STREAM_EVENTS.error) {
      log.pendingPermission = undefined;
      log.pendingUserInput = undefined;
    }
  }

  private pendingInteractionRecovery(log: TurnLog, throughSeq: number): ChatStreamEvent[] {
    return [log.pendingPermission, log.pendingUserInput].flatMap((event) => {
      if (!event) return [];
      if (typeof event.data.seq === 'number' && event.data.seq > throughSeq) return [];
      // An unsequenced recovery frame deliberately does not advance the
      // durable cursor. It restores transient UI state while normal tail
      // replay continues from durable.seq + 1.
      return [{
        ...event,
        data: { ...event.data, seq: undefined },
      } as ChatStreamEvent];
    });
  }

  private maybeCheckpoint(log: TurnLog, event: ChatStreamEvent): void {
    const now = Date.now();
    const immediate = STRUCTURAL_EVENTS.has(event.event)
      || (event.event === CHAT_STREAM_EVENTS.toolCallUpdate && !isActiveToolStatus(event.data.status));
    if (!immediate && now - log.lastCheckpointAt < this.checkpointIntervalMs) return;
    log.lastCheckpointAt = now;
    try {
      this.persistence.checkpoint(log.snapshot);
      log.checkpointCount += 1;
    } catch (err) {
      appLog.warn('chat', 'turn checkpoint failed; continuing to finalization', {
        turnId: log.turnId,
        nodeId: log.nodeId,
        eventCount: log.events.length,
        checkpointCount: log.checkpointCount,
        errorClass: err instanceof Error ? err.name : 'Error',
      });
    }
  }

  private broadcast(chatId: string, log: TurnLog, event: ChatStreamEvent): void {
    for (const sub of this.backgroundSubscribers) {
      if (!log.selfInitiated && !sub.includeForeground) continue;
      try {
        if (sub.ownerUserId !== undefined && sub.ownerUserId !== log.ownerUserId) continue;
        sub.send(chatId, event, log.selfInitiated);
      } catch {
        // A broken background window must not stop the central runner.
      }
    }
    for (const sub of this.subscribers.get(chatId) ?? []) {
      try {
        sub.send(event);
      } catch {
        // A broken subscriber must not stop the central runner or persistence.
      }
    }
  }

  private rawAnswer(log: TurnLog): string {
    return log.snapshot.assistantMessage.blocks
      .map((block) => block.kind === 'answer' ? block.rawText : '')
      .join('');
  }

  private publishBranchOverview(chatId: string, log: TurnLog): boolean {
    const overview = extractBranchOverview(this.rawAnswer(log));
    if (!overview) return false;
    this.append(chatId, log, {
      event: CHAT_STREAM_EVENTS.branchOverview,
      data: { overview },
    });
    return true;
  }

  private emitCancelSettled(chatId: string, log: TurnLog): void {
    if (!this.cancelledTurnIds.has(log.turnId)) return;
    if (log.events.some((entry) =>
      entry.ev.event === CHAT_STREAM_EVENTS.cancelPhase && entry.ev.data.phase === "settled"
    )) return;
    this.append(chatId, log, {
      event: CHAT_STREAM_EVENTS.cancelPhase,
      data: {
        phase: "settled",
        source: "michi_simulated",
        confidence: "projected",
        nativeMethod: "cancel",
      },
    }, false);
  }

  private finalizeOnce(log: TurnLog, finalize: () => Promise<void>): Promise<void> {
    if (log.finalization) return log.finalization;
    if (log.status !== 'active') return Promise.resolve();
    log.finalization = Promise.resolve().then(finalize);
    return log.finalization;
  }

  private finishWithDone(chatId: string, log: TurnLog, stopReason?: string): Promise<void> {
    return this.finalizeOnce(log, () => this.persistDone(chatId, log, stopReason));
  }

  private async persistDone(chatId: string, log: TurnLog, stopReason?: string): Promise<void> {
    await Promise.allSettled(log.pendingSteers ?? []);
    this.emitCancelSettled(chatId, log);
    const stamped = this.stamp(log, {
      event: CHAT_STREAM_EVENTS.done,
      data: { stopReason, persisted: true, completedAt: Date.now() },
    });
    const terminalSnapshot = applyTurnEvent(log.snapshot, stamped.ev);
    // This is the durability boundary: successful done is not observable until
    // the transaction containing messages + node metadata + turn receipt commits.
    const persistStartedAt = Date.now();
    try {
      await this.persistence.finalize(terminalSnapshot);
    } catch (err) {
      this.finishWithPersistenceError(chatId, log, err);
      return;
    }
    log.snapshot = terminalSnapshot;
    log.events.push(stamped);
    this.trackPendingInteraction(log, stamped.ev);
    log.status = "ended";
    logInfo('turn finalized', log, {
      durationMs: Date.now() - persistStartedAt,
      status: terminalSnapshot.status,
      payloadBytes: Buffer.byteLength(JSON.stringify(terminalSnapshot)),
    });
    this.broadcast(chatId, log, stamped.ev);
  }

  private finishWithError(chatId: string, log: TurnLog, err: unknown): Promise<void> {
    return this.finalizeOnce(log, () => this.persistError(chatId, log, err));
  }

  private async persistError(chatId: string, log: TurnLog, err: unknown): Promise<void> {
    const interruptedByShutdown = this.shuttingDown;
    await Promise.allSettled(log.pendingSteers ?? []);
    let message = err instanceof Error ? err.message : String(err);
    // Surface the rpcData detail so the user sees the real reason (e.g.
    // "The model you've selected is temporarily unavailable") instead of the
    // opaque JSON-RPC envelope message (e.g. "Internal error").
    if (err instanceof ACPError && err.rpcData != null) {
      const detail =
        typeof err.rpcData === "string"
          ? err.rpcData
          : JSON.stringify(err.rpcData);
      if (detail && !message.includes(detail.slice(0, 40))) {
        message = detail;
      }
    }
    // KiroSession tags connection/auth/generic on the thrown error so the UI
    // can show a class-appropriate banner (retry vs. re-login vs. raw). Failing
    // that, a runtime_error event's own code is used if it is one of those
    // kinds. Absent for unclassified errors — the UI falls back to a plain
    // error tail. Whether the runtime called the failure retryable is not
    // sent: `recoverable` means the turn's output could not be saved, which
    // is a different thing.
    const acpErrorKind = (err as { acpErrorKind?: string })?.acpErrorKind;
    const reportedKind = err instanceof ReportedRuntimeError && err.code !== undefined && RUNTIME_ERROR_KINDS.has(err.code)
      ? err.code
      : undefined;
    const code = interruptedByShutdown ? BACKEND_RESTARTED_ERROR : chatStreamErrorCode(err) ?? acpErrorKind ?? reportedKind;
    if (interruptedByShutdown) {
      message = BACKEND_RESTARTED_MESSAGE;
    }
    try {
      this.emitCancelSettled(chatId, log);
      const stamped = this.stamp(log, {
        event: CHAT_STREAM_EVENTS.error,
        data: { message, completedAt: Date.now(), ...(code ? { code } : {}) },
      });
      const terminalSnapshot = applyTurnEvent(log.snapshot, stamped.ev);
      // Keep the durable restart marker used by startup recovery and replay;
      // the live event above carries the human-readable explanation.
      if (interruptedByShutdown) terminalSnapshot.error = BACKEND_RESTARTED_ERROR;
      await this.persistence.finalize(terminalSnapshot);
      log.snapshot = terminalSnapshot;
      log.events.push(stamped);
      this.trackPendingInteraction(log, stamped.ev);
      log.status = "error";
      this.broadcast(chatId, log, stamped.ev);
    } catch (persistErr) {
      this.finishWithPersistenceError(chatId, log, persistErr);
    }
  }

  private finishWithPersistenceError(chatId: string, log: TurnLog, err: unknown): void {
    const persistError = err instanceof Error ? err : new Error(String(err));
    log.status = "error";
    // Dedicated field beside the existing effects above/below (status, log,
    // broadcast) — none of those are altered. This is the only durable-ish
    // record of the failure and it is IN-MEMORY ONLY; see the TurnLog field
    // doc-comment for why it must never be treated as surviving a restart.
    log.lastPersistenceError = {
      message: persistError.message,
      recoverable: true,
      occurredAt: Date.now(),
    };
    appLog.error('chat', 'turn persistence finalize failed', {
      turnId: log.turnId,
      nodeId: log.nodeId,
      eventCount: log.events.length,
      checkpointCount: log.checkpointCount,
      errorClass: persistError.name,
    });
    const persistenceError = this.stamp(log, createChatStreamError(
      `Turn output was produced but could not be committed: ${persistError.message}`,
    ));
    persistenceError.ev = {
      ...persistenceError.ev,
      data: {
        ...persistenceError.ev.data,
        code: 'turn_persistence_failed',
        recoverable: true,
        completedAt: Date.now(),
      },
    } as ChatStreamEvent;
    log.events.push(persistenceError);
    this.trackPendingInteraction(log, persistenceError.ev);
    this.broadcast(chatId, log, persistenceError.ev);
  }

  /**
   * Kick off sidecar title generation for an untitled chat node. Runs beside
   * the main turn and never awaits it: whichever title arrives first wins
   * because both the durable projection (`setTitleIfEmpty`) and the renderer
   * lock the first non-blank title. A result that lands after the turn ended
   * is dropped — the agent's sentinel or the stored first sentence covers it.
   */
  private maybeGenerateTitle(args: StartTurnArgs, log: TurnLog): void {
    const runtime = getRuntime(args.session.runtimeId);
    if (runtime && descriptorOf(runtime).topology.hostTitleRequiresOptIn === true && args.enableKiroSidecarTitle !== true) return;
    const generator = this.titleGenerator;
    if (!generator) return;
    if (isRunOwner(args.session.owner)) return;
    const userText = (args.displayText ?? args.text).trim();
    if (!userText) return;
    const contextText = args.userMetadata?.quotedText?.trim() || undefined;
    let existing: string | null;
    try {
      existing = this.nodeTitle(log.nodeId);
    } catch {
      return;
    }
    if (existing && existing.trim().length > 0) return;

    const startedAt = Date.now();
    let pending: Promise<string | null>;
    try {
      pending = Promise.resolve(generator({ session: args.session, nodeId: log.nodeId, userText, contextText }));
    } catch (err) {
      pending = Promise.reject(err);
    }
    void pending.then((title) => {
      const trimmed = title?.trim() ?? '';
      if (!trimmed) return;
      if (this.turns.get(args.chatId) !== log || log.status !== 'active') {
        logInfo('sidecar title arrived after turn ended; dropped', log, {
          durationMs: Date.now() - startedAt,
          runtimeId: args.session.runtimeId,
        });
        return;
      }
      if (log.snapshot.nodeMetadata.title) return;
      this.append(args.chatId, log, {
        event: CHAT_STREAM_EVENTS.title,
        data: { title: trimmed },
      });
      logInfo('sidecar title applied', log, {
        durationMs: Date.now() - startedAt,
        runtimeId: args.session.runtimeId,
        titleChars: trimmed.length,
      });
    }, (err: unknown) => {
      appLog.warn('chat', 'sidecar title generation failed', {
        turnId: log.turnId,
        nodeId: log.nodeId,
        runtimeId: args.session.runtimeId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async runTurn(chatId: string, log: TurnLog, session: AgentSession): Promise<void> {
    try {
      // Stop may arrive while the provisional rows are committing, before
      // activeSessions is installed. Preserve that cancellation before send().
      if (this.cancelledTurnIds.has(log.turnId)) {
        await this.finishWithDone(chatId, log, 'cancelled');
        return;
      }
      let terminalSeen = false;
      let branchOverviewPublished = false;
      const pageContext = this.pageManifestBuilder({
        workspaceId: log.snapshot.workspaceId,
        nodeId: log.nodeId,
        ownerUserId: log.ownerUserId,
        now: Date.now(),
        turnId: log.turnId,
      });
      const uploaded = log.snapshot.userMessage?.metadata?.attachments;
      const input = uploaded?.length && isAssistantNode(log.nodeId)
        ? prepareAssistantAttachments(log.wireText, uploaded, assistantCwd())
        : { text: log.wireText, attachments: uploaded };
      for await (const ev of session.send(input.text, {
        attachments: input.attachments,
        assistantMessageId: log.assistantId,
        userMessageId: log.snapshot.userMessage?.id,
        ...(pageContext ? { pageContext } : {}),
        turnId: log.turnId,
        ...(log.humanOrigin ? { humanOrigin: true } : {}),
      })) {
        if (log.status !== 'active' || this.turns.get(chatId) !== log) return;
        if (log.finalization) { await log.finalization; return; }
        if (reportsBranchOverview(ev)) branchOverviewPublished = true;
        if (ev.kind === "runtime_error") throw runtimeEventError(ev);
        if (ev.kind === "turn_end") {
          if (!branchOverviewPublished) {
            branchOverviewPublished = this.publishBranchOverview(chatId, log);
          }
          await this.finishWithDone(
            chatId,
            log,
            this.cancelledTurnIds.has(log.turnId) ? 'cancelled' : ev.stopReason,
          );
          terminalSeen = true;
          break;
        }
        const wire = toChatStreamEvent(ev);
        if (wire) this.append(chatId, log, wire);
      }
      if (!terminalSeen) {
        if (log.status !== 'active' || this.turns.get(chatId) !== log) return;
        if (log.finalization) { await log.finalization; return; }
        if (!branchOverviewPublished) this.publishBranchOverview(chatId, log);
        await this.finishWithDone(
          chatId,
          log,
          this.cancelledTurnIds.has(log.turnId) ? 'cancelled' : 'end_turn',
        );
      }
    } catch (err) {
      if (this.cancelledTurnIds.has(log.turnId) && !(err instanceof RuntimeRecoveryRequiredError)) {
        // Cancel was requested — treat the resulting runtime error as a
        // graceful cancellation rather than a hard error.
        await this.finishWithDone(chatId, log, 'cancelled');
      } else {
        await this.finishWithError(chatId, log, err);
      }
    } finally {
      this.cancelledTurnIds.delete(log.turnId);
      this.cancelRequestedAt.delete(log.turnId);
      // A timed-out cancellation can finish after the next turn has started.
      // Only the current turn owns chat-scoped timers, sessions and subscribers.
      if (this.turns.get(chatId) === log) {
        this.clearCancelTimer(chatId);
        this.activeSessions.delete(chatId);
        for (const sub of this.subscribers.get(chatId) ?? []) {
          try {
            sub.close();
          } catch {
            // ignore subscriber teardown failures
          }
        }
      }
      this.scheduleEvict(chatId, log);
    }
  }

  private scheduleEvict(chatId: string, log: TurnLog): void {
    const retained = this.retainedTurns.get(chatId) ?? [];
    if (!retained.includes(log)) {
      retained.push(log);
      this.retainedTurns.set(chatId, retained);
    }
    const timer = setTimeout(() => {
      if (this.turns.get(chatId) === log) this.turns.delete(chatId);
      const remaining = (this.retainedTurns.get(chatId) ?? []).filter((entry) => entry !== log);
      if (remaining.length > 0) this.retainedTurns.set(chatId, remaining);
      else this.retainedTurns.delete(chatId);
    }, this.retentionMs);
    timer.unref?.();
  }
}

function logInfo(
  message: string,
  turn: TurnLog,
  extra: Record<string, unknown>,
): void {
  appLog.info('chat', message, {
    turnId: turn.turnId,
    nodeId: turn.nodeId,
    eventCount: turn.events.length,
    checkpointCount: turn.checkpointCount,
    ...extra,
  });
}

export const chatHub = new ChatHub();
