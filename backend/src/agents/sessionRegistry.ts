import type { AgentSession, ChatMessage } from "./types";
import type { NormalizedEvent } from "../services/chatEvents";
import { getRuntimeDeps } from "./runtimeDeps";

type Entry = { session: AgentSession; ownerUserId: string | null };

const sessions = new Map<string, Entry>();

/**
 * Lightweight read-only session stub used solely for ancestor-chain stitching.
 * Holds history loaded from SQLite; send() throws because this is not a live session.
 */
class HistoryStubSession implements AgentSession {
    public readonly runtimeId = "stub";
    public readonly parentChatId?: string;
    public readonly currentModeId = null;
    public readonly currentModelId = null;
    private readonly history: ChatMessage[];

    constructor(public readonly id: string, history: ChatMessage[], parentChatId?: string) {
        this.history = history;
        this.parentChatId = parentChatId;
    }

    getHistory(): ChatMessage[] { return this.history; }
    getPendingAssistant(): string | undefined { return undefined; }
    async *send(_text: string): AsyncIterableIterator<NormalizedEvent> {
        throw new Error("HistoryStubSession is read-only");
    }
    cancel(): void {}
}

/**
 * Walk a chatId's parent chain, loading any session missing from the in-memory
 * registry from SQLite as a read-only stub. This ensures ancestor preamble
 * stitching works even after a backend restart when sessions are no longer live.
 *
 * Safe to call repeatedly — already-registered sessions are skipped.
 */
export function ensureAncestorChainLoaded(chatId: string): void {
    const visited = new Set<string>();
    let cursor: string | undefined = chatId;
    while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        const existing = sessions.get(cursor);
        if (existing) {
            cursor = existing.session.parentChatId;
            continue;
        }
        try {
            const store = getRuntimeDeps().historyStore;
            const node = store.getNode(cursor);
            if (!node) return;
            const rows = store.listMessages(cursor);
            const history: ChatMessage[] = [];
            for (const row of rows) {
                if (row.role !== "user" && row.role !== "assistant") continue;
                const text = row.content ?? "";
                if (text.length === 0) continue;
                history.push({ role: row.role, content: text });
            }
            const parentChatId = node.parent_node_id ?? undefined;
            const stub = new HistoryStubSession(cursor, history, parentChatId);
            sessions.set(cursor, { session: stub, ownerUserId: null });
            cursor = parentChatId;
        } catch (err) {
            console.warn(`[sessionRegistry] ensureAncestorChainLoaded: failed loading ${cursor}:`, err);
            return;
        }
    }
}

export function registerSession(session: AgentSession, ownerUserId?: string | null): void {
    sessions.set(session.id, { session, ownerUserId: ownerUserId ?? null });
}

/**
 * Low-level lookup used by internal/runtime callers (parent-chain stitching,
 * digest generation, etc.). Does NOT enforce ownership — callers are trusted.
 */
export function getSession(chatId: string): AgentSession | undefined {
    return sessions.get(chatId)?.session;
}

/**
 * User-facing lookup that enforces ownership in cloud mode.
 *
 * In cloud mode (MICHI_CLOUD=1):
 *   - Returns null if the entry is absent.
 *   - Returns null if ownerUserId doesn't match (including null-owner entries).
 *
 * In desktop mode:
 *   - Returns the session regardless of ownerUserId (single-user process).
 */
export function getSessionForUser(chatId: string, userId: string | null): AgentSession | null {
    const e = sessions.get(chatId);
    if (!e) return null;
    if (process.env.MICHI_CLOUD === '1') {
        if (e.ownerUserId !== userId) return null;  // null owner also rejected
    }
    return e.session;
}

export function dropSession(chatId: string): void {
    sessions.delete(chatId);
}

export function listSessions(): AgentSession[] {
    return [...sessions.values()].map((e) => e.session);
}

/**
 * Walk parentChatId chain from root to immediate parent. Stops at missing
 * (evicted) ancestors. Returns oldest-first so callers building a transcript
 * can iterate naturally. Detects cycles via a visited set.
 */
export function getAncestors(chatId: string): AgentSession[] {
    const out: AgentSession[] = [];
    const visited = new Set<string>();
    let cursor: string | undefined = sessions.get(chatId)?.session.parentChatId;
    while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        const e = sessions.get(cursor);
        if (!e) break;
        out.unshift(e.session);
        cursor = e.session.parentChatId;
    }
    return out;
}

export function clearAllSessions(): void {
    sessions.clear();
}
