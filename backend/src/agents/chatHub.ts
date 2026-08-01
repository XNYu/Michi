import { randomUUID } from "node:crypto";
import {
  applyTurnEvent,
  CHAT_STREAM_EVENTS,
  createDurableTurn,
  isActiveToolStatus,
  type ChatStreamEvent,
  type DurableMessageMetadata,
  type DurableTurnSnapshot,
} from "michi-shared";
import type { AgentSession } from "./types";
import type { NormalizedEvent } from "../services/chatEvents";
import { createChatStreamError, toChatStreamEvent } from "../routes/chatStreamEvents";
import { beginTurn, checkpointTurn, finalizeTurn, getNode } from "../services/dbRepository";
import { extractBranchOverview } from "../services/messageSerialization";
import { log as appLog } from "../services/logger";
import { ACPError } from "../services/acpClient";

export interface HubSubscriber {
  send(ev: ChatStreamEvent): void;
  close(): void;
}

/** Window-scoped feed for runtime-initiated turns only. */
export interface BackgroundSubscriber {
  send(chatId: string, ev: ChatStreamEvent): void;
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
  /** Interaction cards are transient UI state and are not represented by the
   * durable message snapshot. Keep the currently-unresolved request so a gap
   * reconciliation can restore it after installing the SQLite projection. */
  pendingPermission?: ChatStreamEvent;
  pendingUserInput?: ChatStreamEvent;
}

export interface TurnPersistence {
  begin(snapshot: DurableTurnSnapshot): void;
  checkpoint(snapshot: DurableTurnSnapshot): void;
  finalize(snapshot: DurableTurnSnapshot): void;
}

const repositoryTurnPersistence: TurnPersistence = {
  begin: (snapshot) => { beginTurn(snapshot); },
  checkpoint: (snapshot) => { checkpointTurn(snapshot); },
  finalize: (snapshot) => { finalizeTurn(snapshot); },
};

export interface StartTurnArgs {
  chatId: string;
  nodeId: string;
  text: string;
  displayText?: string;
  userMetadata?: DurableMessageMetadata;
  session: AgentSession;
  turnId?: string;
  ownerUserId?: string | null;
}

export interface StartedTurn {
  turnId: string;
  assistantId: string;
  done: Promise<void>;
}

export interface StartSelfTurnArgs {
  chatId: string;
  nodeId: string;
  ownerUserId?: string | null;
  events: AsyncIterableIterator<NormalizedEvent>;
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
]);

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
  /** Turn-scoped cancellation prevents a delayed Stop for turn A from
   * cancelling turn B on the same chat. Entries may also reserve a
   * client-minted turn id when cancel wins the race against POST /message. */
  private readonly cancelledTurnIds = new Set<string>();
  private readonly retentionMs: number;
  private readonly persistence: TurnPersistence;
  private readonly checkpointIntervalMs: number;
  private readonly workspaceIdForNode: (nodeId: string) => string | null;

  constructor(opts: {
    retentionMs?: number;
    persistence?: TurnPersistence;
    checkpointIntervalMs?: number;
    workspaceIdForNode?: (nodeId: string) => string | null;
  } = {}) {
    this.retentionMs = opts.retentionMs ?? ENDED_LOG_RETENTION_MS;
    this.persistence = opts.persistence ?? repositoryTurnPersistence;
    this.checkpointIntervalMs = opts.checkpointIntervalMs ?? TURN_CHECKPOINT_INTERVAL_MS;
    this.workspaceIdForNode = opts.workspaceIdForNode
      ?? ((nodeId) => getNode(nodeId)?.workspace_id ?? null);
  }

  isActive(chatId: string): boolean {
    return this.turns.get(chatId)?.status === "active";
  }

  isOwnerTurnActive(chatId: string): boolean {
    return this.activeSessions.has(chatId);
  }

  activeOwnerTurnId(chatId: string): string | undefined {
    return this.activeSessions.has(chatId) ? this.turns.get(chatId)?.turnId : undefined;
  }

  startTurn(args: StartTurnArgs): StartedTurn {
    if (this.isActive(args.chatId) || this.pendingSelfTurns.has(args.chatId)) {
      throw new Error('a turn is already active for this chat');
    }
    const turnId = args.turnId ?? randomUUID();
    if (this.cancelledTurnIds.delete(turnId)) {
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
    // The durable provisional rows are the prerequisite for both runtime
    // execution and the visible turn_start frame.
    const persistStartedAt = Date.now();
    this.persistence.begin(log.snapshot);
    logInfo('turn begin committed', log, { durationMs: Date.now() - persistStartedAt });
    this.turns.set(args.chatId, log);
    this.activeSessions.set(args.chatId, args.session);
    this.append(args.chatId, log, {
      event: CHAT_STREAM_EVENTS.turnStart,
      data: {
        turnId,
        assistantId,
        nodeId: args.nodeId,
        userText: args.displayText ?? args.text,
        startedAt: log.snapshot.startedAt,
      },
    }, false);
    const done = this.runTurn(args.chatId, log, args.session);
    this.activeTurnCompletions.set(args.chatId, done);
    void done.finally(() => {
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
          && log.selfInitiated
          && log.status === 'active'
          && (sub.ownerUserId === undefined || sub.ownerUserId === log.ownerUserId),
        );
        if (cursorLog) {
          for (const event of this.pendingInteractionRecovery(cursorLog, replayCursor.seq)) {
            sub.send(chatId, event);
          }
        }
      }
      for (let index = startIndex; index < logs.length; index += 1) {
        const log = logs[index];
        if (!log.selfInitiated) continue;
        if (sub.ownerUserId !== undefined && sub.ownerUserId !== log.ownerUserId) continue;
        const fromSeq = replayCursor && index === startIndex ? replayCursor.seq + 1 : 0;
        for (const { seq, ev } of log.events) {
          if (seq >= fromSeq) sub.send(chatId, ev);
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
        const expiry = setTimeout(() => this.cancelledTurnIds.delete(requestedTurnId), this.retentionMs);
        expiry.unref?.();
      }
      return false;
    }
    const turnId = requestedTurnId ?? log.turnId;
    if (turnId !== log.turnId) return false;
    this.cancelledTurnIds.add(log.turnId);
    void Promise.resolve(this.activeSessions.get(chatId)?.cancel()).catch(() => {});
    return true;
  }

  resolvePermission(chatId: string, requestId: number): void {
    const log = this.turns.get(chatId);
    const pending = log?.pendingPermission;
    if (pending?.event !== CHAT_STREAM_EVENTS.permissionRequest) return;
    if (pending.data.requestId === requestId) log!.pendingPermission = undefined;
  }

  resolveUserInput(chatId: string, requestId: number): void {
    const log = this.turns.get(chatId);
    const pending = log?.pendingUserInput;
    if (pending?.event !== CHAT_STREAM_EVENTS.userInputRequest) return;
    if (pending.data.requestId === requestId) log!.pendingUserInput = undefined;
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
    void queued.finally(() => {
      if (this.selfTurnQueues.get(args.chatId) === queued) {
        this.selfTurnQueues.delete(args.chatId);
        this.pendingSelfTurns.delete(args.chatId);
      }
    });
  }

  private async beginSelfTurn(args: StartSelfTurnArgs): Promise<void> {
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
    const persistStartedAt = Date.now();
    this.persistence.begin(log.snapshot);
    logInfo('self turn begin committed', log, { durationMs: Date.now() - persistStartedAt });
    this.turns.set(args.chatId, log);
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
    await this.runSelfTurn(args.chatId, log, args.events);
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
  ): Promise<void> {
    try {
      let branchOverviewPublished = false;
      for await (const ev of events) {
        if (ev.kind === "branch_overview") {
          branchOverviewPublished = ev.overview.trim().length > 0 || branchOverviewPublished;
        }
        if (ev.kind === "runtime_error") {
          throw new Error(ev.error);
        }
        if (ev.kind === "turn_end") {
          if (!branchOverviewPublished) {
            branchOverviewPublished = this.publishBranchOverview(chatId, log);
          }
          this.finishWithDone(
            chatId,
            log,
            this.cancelledTurnIds.has(log.turnId) ? 'cancelled' : ev.stopReason,
          );
          break;
        }
        this.append(chatId, log, toChatStreamEvent(ev));
      }
      if (log.status === 'active') {
        if (!branchOverviewPublished) this.publishBranchOverview(chatId, log);
        this.finishWithDone(
          chatId,
          log,
          this.cancelledTurnIds.has(log.turnId) ? 'cancelled' : 'end_turn',
        );
      }
    } catch (err) {
      if (this.cancelledTurnIds.has(log.turnId)) {
        this.finishWithDone(chatId, log, 'cancelled');
      } else {
        this.finishWithError(chatId, log, err);
      }
    } finally {
      this.cancelledTurnIds.delete(log.turnId);
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
    return {
      seq,
      ev: {
        ...ev,
        data: {
          ...ev.data,
          chatId: log.chatId,
          nodeId: log.nodeId,
          turnId: log.turnId,
          seq,
          assistantId: log.assistantId,
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
    } else if (event.event === CHAT_STREAM_EVENTS.userInputRequest) {
      log.pendingUserInput = event;
    } else if (
      event.event === CHAT_STREAM_EVENTS.userInputResolved
      && log.pendingUserInput?.event === CHAT_STREAM_EVENTS.userInputRequest
      && log.pendingUserInput.data.requestId === event.data.requestId
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
    if (log.selfInitiated) {
      for (const sub of this.backgroundSubscribers) {
        try {
          if (sub.ownerUserId !== undefined && sub.ownerUserId !== log.ownerUserId) continue;
          sub.send(chatId, event);
        } catch {
          // A broken background window must not stop the central runner.
        }
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

  private finishWithDone(chatId: string, log: TurnLog, stopReason?: string): void {
    const stamped = this.stamp(log, {
      event: CHAT_STREAM_EVENTS.done,
      data: { stopReason, persisted: true, completedAt: Date.now() },
    });
    const terminalSnapshot = applyTurnEvent(log.snapshot, stamped.ev);
    // This is the durability boundary: successful done is not observable until
    // the transaction containing messages + node metadata + turn receipt commits.
    const persistStartedAt = Date.now();
    try {
      this.persistence.finalize(terminalSnapshot);
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

  private finishWithError(chatId: string, log: TurnLog, err: unknown): void {
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
    // can show a class-appropriate banner (retry vs. re-login vs. raw). Absent
    // for non-Kiro runtimes / non-classified errors — the UI falls back to a
    // plain error tail.
    const acpErrorKind = (err as { acpErrorKind?: string })?.acpErrorKind;
    try {
      const stamped = this.stamp(log, {
        event: CHAT_STREAM_EVENTS.error,
        data: { message, completedAt: Date.now(), ...(acpErrorKind ? { code: acpErrorKind } : {}) },
      });
      const terminalSnapshot = applyTurnEvent(log.snapshot, stamped.ev);
      this.persistence.finalize(terminalSnapshot);
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

  private async runTurn(chatId: string, log: TurnLog, session: AgentSession): Promise<void> {
    try {
      let terminalSeen = false;
      let branchOverviewPublished = false;
      for await (const ev of session.send(log.wireText, {
        attachments: log.snapshot.userMessage?.metadata?.attachments,
      })) {
        if (ev.kind === "branch_overview") {
          branchOverviewPublished = ev.overview.trim().length > 0 || branchOverviewPublished;
        }
        if (ev.kind === "runtime_error") {
          throw new Error(ev.error);
        }
        if (ev.kind === "turn_end") {
          if (!branchOverviewPublished) {
            branchOverviewPublished = this.publishBranchOverview(chatId, log);
          }
          this.finishWithDone(
            chatId,
            log,
            this.cancelledTurnIds.has(log.turnId) ? 'cancelled' : ev.stopReason,
          );
          terminalSeen = true;
          break;
        }
        this.append(chatId, log, toChatStreamEvent(ev));
      }
      if (!terminalSeen) {
        if (!branchOverviewPublished) this.publishBranchOverview(chatId, log);
        this.finishWithDone(
          chatId,
          log,
          this.cancelledTurnIds.has(log.turnId) ? 'cancelled' : 'end_turn',
        );
      }
    } catch (err) {
      if (this.cancelledTurnIds.has(log.turnId)) {
        // Cancel was requested — treat the resulting runtime error as a
        // graceful cancellation rather than a hard error.
        this.finishWithDone(chatId, log, 'cancelled');
      } else {
        this.finishWithError(chatId, log, err);
      }
    } finally {
      this.cancelledTurnIds.delete(log.turnId);
      this.activeSessions.delete(chatId);
      for (const sub of this.subscribers.get(chatId) ?? []) {
        try {
          sub.close();
        } catch {
          // ignore subscriber teardown failures
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
