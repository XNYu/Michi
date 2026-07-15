import { randomUUID } from "node:crypto";
import {
  applyTurnEvent,
  CHAT_STREAM_EVENTS,
  createDurableTurn,
  type ChatStreamEvent,
  type DurableMessageMetadata,
  type DurableTurnSnapshot,
} from "michi-shared";
import type { AgentSession } from "./types";
import { createChatStreamError, toChatStreamEvent } from "../routes/chatStreamEvents";
import { beginTurn, checkpointTurn, finalizeTurn, getNode } from "../services/dbRepository";
import { extractBranchOverview } from "../services/messageSerialization";
import { log as appLog } from "../services/logger";

export interface HubSubscriber {
  send(ev: ChatStreamEvent): void;
  close(): void;
}

interface LoggedEvent {
  seq: number;
  ev: ChatStreamEvent;
}

interface TurnLog {
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
}

export interface StartedTurn {
  turnId: string;
  assistantId: string;
  done: Promise<void>;
}

export const ENDED_LOG_RETENTION_MS = 60_000;
export const TURN_CHECKPOINT_INTERVAL_MS = 1_500;

const STRUCTURAL_EVENTS = new Set<ChatStreamEvent['event']>([
  CHAT_STREAM_EVENTS.plan,
  CHAT_STREAM_EVENTS.toolCall,
  CHAT_STREAM_EVENTS.toolCallUpdate,
  CHAT_STREAM_EVENTS.image,
  CHAT_STREAM_EVENTS.title,
  CHAT_STREAM_EVENTS.followUps,
  CHAT_STREAM_EVENTS.branchOverview,
]);

export class ChatHub {
  private readonly turns = new Map<string, TurnLog>();
  private readonly subscribers = new Map<string, Set<HubSubscriber>>();
  private readonly activeSessions = new Map<string, AgentSession>();
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

  startTurn(args: StartTurnArgs): StartedTurn {
    const turnId = args.turnId ?? randomUUID();
    const assistantId = `a-${args.nodeId}-${turnId}`;
    const log = this.createLog({
      turnId,
      assistantId,
      nodeId: args.nodeId,
      wireText: args.text,
      displayText: args.displayText ?? args.text,
      userMetadata: args.userMetadata,
      selfInitiated: false,
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
    return { turnId, assistantId, done };
  }

  subscribe(
    chatId: string,
    sub: HubSubscriber,
    opts: { fromTurnId?: string; fromSeq?: number } = {},
  ): () => void {
    const set = this.subscribersFor(chatId);
    set.add(sub);
    const log = this.turns.get(chatId);
    if (log) {
      const fromSeq = opts.fromTurnId === log.turnId ? opts.fromSeq ?? 0 : 0;
      for (const { seq, ev } of log.events) {
        if (seq >= fromSeq) sub.send(ev);
      }
    }
    return () => {
      set.delete(sub);
      if (set.size === 0) this.subscribers.delete(chatId);
    };
  }

  cancel(chatId: string): void {
    const log = this.turns.get(chatId);
    if (!log || log.status !== "active") return;
    void Promise.resolve(this.activeSessions.get(chatId)?.cancel()).catch(() => {});
  }

  startSelfTurn(args: StartSelfTurnArgs): void {
    const turnId = randomUUID();
    const assistantId = `self-${args.nodeId}-${turnId}`;
    const log = this.createLog({
      turnId,
      assistantId,
      nodeId: args.nodeId,
      wireText: '',
      displayText: '',
      selfInitiated: true,
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
    void this.runSelfTurn(args.chatId, log, args.events);
  }

  private createLog(input: {
    turnId: string;
    assistantId: string;
    nodeId: string;
    wireText: string;
    displayText: string;
    userMetadata?: DurableMessageMetadata;
    selfInitiated: boolean;
  }): TurnLog {
    const workspaceId = this.workspaceIdForNode(input.nodeId);
    if (!workspaceId) throw new Error(`node ${input.nodeId} does not exist`);
    const startedAt = Date.now();
    return {
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
        if (ev.kind === "turn_end") {
          if (!branchOverviewPublished) {
            branchOverviewPublished = this.publishBranchOverview(chatId, log);
          }
          this.finishWithDone(chatId, log, ev.stopReason);
          break;
        }
        this.append(chatId, log, toChatStreamEvent(ev));
      }
      if (log.status === 'active') {
        if (!branchOverviewPublished) this.publishBranchOverview(chatId, log);
        this.finishWithDone(chatId, log, 'end_turn');
      }
    } catch (err) {
      this.finishWithError(chatId, log, err);
    } finally {
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
        data: { ...ev.data, turnId: log.turnId, seq, assistantId: log.assistantId },
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
    this.broadcast(chatId, stamped.ev);
    if (checkpoint) this.maybeCheckpoint(log, stamped.ev.event);
  }

  private maybeCheckpoint(log: TurnLog, eventName: ChatStreamEvent['event']): void {
    const now = Date.now();
    if (!STRUCTURAL_EVENTS.has(eventName) && now - log.lastCheckpointAt < this.checkpointIntervalMs) return;
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

  private broadcast(chatId: string, event: ChatStreamEvent): void {
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
    log.status = "ended";
    logInfo('turn finalized', log, {
      durationMs: Date.now() - persistStartedAt,
      status: terminalSnapshot.status,
      payloadBytes: Buffer.byteLength(JSON.stringify(terminalSnapshot)),
    });
    this.broadcast(chatId, stamped.ev);
  }

  private finishWithError(chatId: string, log: TurnLog, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const stamped = this.stamp(log, {
        event: CHAT_STREAM_EVENTS.error,
        data: { message, completedAt: Date.now() },
      });
      const terminalSnapshot = applyTurnEvent(log.snapshot, stamped.ev);
      this.persistence.finalize(terminalSnapshot);
      log.snapshot = terminalSnapshot;
      log.events.push(stamped);
      log.status = "error";
      this.broadcast(chatId, stamped.ev);
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
    this.broadcast(chatId, persistenceError.ev);
  }

  private async runTurn(chatId: string, log: TurnLog, session: AgentSession): Promise<void> {
    try {
      let terminalSeen = false;
      let branchOverviewPublished = false;
      for await (const ev of session.send(log.wireText)) {
        if (ev.kind === "branch_overview") {
          branchOverviewPublished = ev.overview.trim().length > 0 || branchOverviewPublished;
        }
        if (ev.kind === "turn_end") {
          if (!branchOverviewPublished) {
            branchOverviewPublished = this.publishBranchOverview(chatId, log);
          }
          this.finishWithDone(chatId, log, ev.stopReason);
          terminalSeen = true;
          break;
        }
        this.append(chatId, log, toChatStreamEvent(ev));
      }
      if (!terminalSeen) {
        if (!branchOverviewPublished) this.publishBranchOverview(chatId, log);
        this.finishWithDone(chatId, log, 'end_turn');
      }
    } catch (err) {
      this.finishWithError(chatId, log, err);
    } finally {
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
    const timer = setTimeout(() => {
      if (this.turns.get(chatId) === log) this.turns.delete(chatId);
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
