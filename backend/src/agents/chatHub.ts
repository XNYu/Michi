import { randomUUID } from "node:crypto";
import { CHAT_STREAM_EVENTS, type ChatStreamEvent } from "michi-shared";
import type { AgentSession } from "./types";
import { createChatStreamError, toChatStreamEvent } from "../routes/chatStreamEvents";
import {
  persistCompletedTurn,
  persistNodeBranchOverview,
  persistNodeTitle,
} from "../services/chatPersistence";
import { extractBranchOverview } from "../services/messageSerialization";

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
  userText: string;
  events: LoggedEvent[];
  status: "active" | "ended" | "error";
  nextSeq: number;
  assistantChunks: string[];
}

export interface StartTurnArgs {
  chatId: string;
  nodeId: string;
  text: string;
  session: AgentSession;
  turnId?: string;
}

export interface StartedTurn {
  turnId: string;
  assistantId: string;
  done: Promise<void>;
}

export const ENDED_LOG_RETENTION_MS = 60_000;

export class ChatHub {
  private readonly turns = new Map<string, TurnLog>();
  private readonly subscribers = new Map<string, Set<HubSubscriber>>();
  private readonly activeSessions = new Map<string, AgentSession>();
  private readonly retentionMs: number;

  constructor(opts: { retentionMs?: number } = {}) {
    this.retentionMs = opts.retentionMs ?? ENDED_LOG_RETENTION_MS;
  }

  isActive(chatId: string): boolean {
    return this.turns.get(chatId)?.status === "active";
  }

  startTurn(args: StartTurnArgs): StartedTurn {
    const turnId = args.turnId ?? randomUUID();
    const assistantId = `a-${args.nodeId}-${turnId}`;
    const log: TurnLog = {
      turnId,
      assistantId,
      nodeId: args.nodeId,
      userText: args.text,
      events: [],
      status: "active",
      nextSeq: 0,
      assistantChunks: [],
    };
    this.turns.set(args.chatId, log);
    this.append(args.chatId, log, {
      event: CHAT_STREAM_EVENTS.turnStart,
      data: { turnId, assistantId, nodeId: args.nodeId, userText: args.text },
    });
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

  /**
   * Handle a self-initiated turn (agent proactive output, e.g. background
   * task completion). Unlike startTurn(), this does not send user text —
   * the turn_start payload carries `selfInitiated: true` so the frontend
   * knows not to render a user bubble.
   */
  startSelfTurn(args: StartSelfTurnArgs): void {
    const turnId = randomUUID();
    const assistantId = `self-${args.nodeId}-${turnId}`;
    const log: TurnLog = {
      turnId,
      assistantId,
      nodeId: args.nodeId,
      userText: '',
      events: [],
      status: "active",
      nextSeq: 0,
      assistantChunks: [],
    };
    this.turns.set(args.chatId, log);
    this.append(args.chatId, log, {
      event: CHAT_STREAM_EVENTS.turnStart,
      data: { turnId, assistantId, nodeId: args.nodeId, userText: '', selfInitiated: true },
    } as ChatStreamEvent);
    void this.runSelfTurn(args.chatId, log, args.events);
  }

  private async runSelfTurn(
    chatId: string,
    log: TurnLog,
    events: AsyncIterableIterator<NormalizedEvent>,
  ): Promise<void> {
    try {
      let branchOverviewPublished = false;
      for await (const ev of events) {
        if (ev.kind === "chunk") log.assistantChunks.push(ev.text);
        if (ev.kind === "title") persistNodeTitle(log.nodeId, ev.title);
        if (ev.kind === "turn_end") {
          this.publishBranchOverview(chatId, log);
          branchOverviewPublished = true;
        }
        this.append(chatId, log, toChatStreamEvent(ev));
        if (ev.kind === "turn_end") break;
      }
      if (!branchOverviewPublished) this.publishBranchOverview(chatId, log);
      if (log.assistantChunks.length > 0) {
        persistCompletedTurn(log.nodeId, '', log.assistantChunks.join(""), {
          turnId: log.turnId,
          selfInitiated: true,
        });
      }
      log.status = "ended";
    } catch (err) {
      this.append(chatId, log, createChatStreamError((err as Error).message));
      log.status = "error";
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

  private append(chatId: string, log: TurnLog, ev: ChatStreamEvent): void {
    const seq = log.nextSeq++;
    const stamped = {
      ...ev,
      data: { ...ev.data, turnId: log.turnId, seq, assistantId: log.assistantId },
    } as ChatStreamEvent;
    log.events.push({ seq, ev: stamped });
    for (const sub of this.subscribers.get(chatId) ?? []) {
      try {
        sub.send(stamped);
      } catch {
        // A broken subscriber must not stop the central runner.
      }
    }
  }

  /**
   * Branch Overview is an app-level projection of the final assistant reply,
   * rather than a runtime-specific event. Publishing it here gives the owner
   * stream, observers, and replay exactly the same ordered event.
   */
  private publishBranchOverview(chatId: string, log: TurnLog): void {
    const overview = extractBranchOverview(log.assistantChunks.join(""));
    if (!overview) return;
    persistNodeBranchOverview(log.nodeId, overview);
    this.append(chatId, log, {
      event: CHAT_STREAM_EVENTS.branchOverview,
      data: { overview },
    });
  }

  private async runTurn(chatId: string, log: TurnLog, session: AgentSession): Promise<void> {
    this.activeSessions.set(chatId, session);
    try {
      let branchOverviewPublished = false;
      for await (const ev of session.send(log.userText)) {
        if (ev.kind === "chunk") log.assistantChunks.push(ev.text);
        if (ev.kind === "title") persistNodeTitle(log.nodeId, ev.title);
        if (ev.kind === "turn_end") {
          this.publishBranchOverview(chatId, log);
          branchOverviewPublished = true;
        }
        this.append(chatId, log, toChatStreamEvent(ev));
        if (ev.kind === "turn_end") break;
      }
      if (!branchOverviewPublished) this.publishBranchOverview(chatId, log);
      persistCompletedTurn(log.nodeId, log.userText, log.assistantChunks.join(""), {
        turnId: log.turnId,
      });
      log.status = "ended";
    } catch (err) {
      this.append(chatId, log, createChatStreamError((err as Error).message));
      log.status = "error";
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

export const chatHub = new ChatHub();
