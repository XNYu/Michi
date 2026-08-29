import type { AgentSession, ChatMessage, RuntimeSessionOwner } from "./types";
import type { NormalizedEvent } from "../services/chatEvents";
import { getRuntimeDeps } from "./runtimeDeps";

type Entry = {
    session: AgentSession;
    ownerUserId: string | null;
    owner: RuntimeSessionOwner;
    kind: "live" | "stub";
    lastAccessedAt: number;
};

const sessions = new Map<string, Entry>();
export const HISTORY_STUB_TTL_MS = 30 * 60 * 1000;
export const HISTORY_STUB_MAX_ENTRIES = 256;

function touch(entry: Entry): void {
    if (entry.kind === "stub") entry.lastAccessedAt = Date.now();
}

export function evictHistoryStubs(opts: {
    now?: number;
    maxEntries?: number;
    protectedIds?: ReadonlySet<string>;
} = {}): number {
    const now = opts.now ?? Date.now();
    const maxEntries = Math.max(0, Math.floor(opts.maxEntries ?? HISTORY_STUB_MAX_ENTRIES));
    const protectedIds = opts.protectedIds ?? new Set<string>();
    let removed = 0;

    for (const [id, entry] of sessions) {
        if (
            entry.kind === "stub"
            && !protectedIds.has(id)
            && now - entry.lastAccessedAt > HISTORY_STUB_TTL_MS
        ) {
            sessions.delete(id);
            removed += 1;
        }
    }

    const protectedStubCount = [...protectedIds]
        .filter((id) => sessions.get(id)?.kind === "stub")
        .length;
    const unprotectedLimit = Math.max(0, maxEntries - protectedStubCount);
    const remaining = [...sessions.entries()]
        .filter(([id, entry]) => entry.kind === "stub" && !protectedIds.has(id))
        .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);
    for (let index = 0; index < remaining.length - unprotectedLimit; index += 1) {
        if (sessions.delete(remaining[index][0])) removed += 1;
    }
    return removed;
}

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
    // Sweep before loading so the chain assembled below remains intact for the
    // runtime's immediately-following getAncestors() call.
    evictHistoryStubs();
    const visited = new Set<string>();
    let cursor: string | undefined = chatId;
    while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        const existing = sessions.get(cursor);
        if (existing) {
            touch(existing);
            cursor = existing.session.parentChatId;
            continue;
        }
        try {
            const store = getRuntimeDeps().historyStore;
            const node = store.getNode(cursor);
            if (!node) break;
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
            sessions.set(cursor, {
                session: stub,
                ownerUserId: null,
                owner: { kind: "chat_node", nodeId: cursor },
                kind: "stub",
                lastAccessedAt: Date.now(),
            });
            cursor = parentChatId;
        } catch (err) {
            console.warn(`[sessionRegistry] ensureAncestorChainLoaded: failed loading ${cursor}:`, err);
            break;
        }
    }
    // Keep the just-loaded chain intact for the immediately-following
    // getAncestors() call, while evicting inactive stubs. A chain deeper than
    // the normal cap is a short-lived allowance; getAncestors() trims the
    // resident cache after copying the chain into its return value.
    evictHistoryStubs({ protectedIds: visited });
}

export function registerSession(
    session: AgentSession,
    ownerUserId?: string | null,
    owner: RuntimeSessionOwner = session.owner ?? { kind: "chat_node", nodeId: session.id },
): void {
    sessions.set(session.id, {
        session,
        ownerUserId: ownerUserId ?? null,
        owner,
        kind: "live",
        lastAccessedAt: Date.now(),
    });
    try {
        getRuntimeDeps().onSessionOwnerBound?.(session.id, owner);
    } catch {
        // Registry is also used by isolated adapter tests before runtime deps
        // are assembled; the audit hook is optional and must not change that.
    }
}

function sameOwner(left: RuntimeSessionOwner, right: RuntimeSessionOwner): boolean {
    if (left.kind !== right.kind) return false;
    return left.kind === "chat_node"
        ? left.nodeId === (right as Extract<RuntimeSessionOwner, { kind: "chat_node" }>).nodeId
        : left.runId === (right as Extract<RuntimeSessionOwner, { kind: "agent_run" }>).runId
            && left.attemptId === (right as Extract<RuntimeSessionOwner, { kind: "agent_run" }>).attemptId;
}

/**
 * Low-level lookup used by internal/runtime callers (parent-chain stitching,
 * digest generation, etc.). Does NOT enforce ownership — callers are trusted.
 */
export function getSession(chatId: string): AgentSession | undefined {
    const entry = sessions.get(chatId);
    if (!entry) return undefined;
    touch(entry);
    return entry.session;
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
    touch(e);
    return e.session;
}

/** Owner-aware lookup used by Run coordinators. It prevents a delayed action
 * for an old Attempt from reaching a replacement session. */
export function getSessionForOwner(
    sessionId: string,
    owner: RuntimeSessionOwner,
    userId: string | null,
): AgentSession | null {
    const entry = sessions.get(sessionId);
    if (!entry || !sameOwner(entry.owner, owner)) return null;
    if (process.env.MICHI_CLOUD === "1" && entry.ownerUserId !== userId) return null;
    touch(entry);
    return entry.session;
}

export function sessionMatchesOwner(sessionId: string, owner: RuntimeSessionOwner): boolean {
    const entry = sessions.get(sessionId);
    return !!entry && sameOwner(entry.owner, owner);
}

export function dropSession(chatId: string): void {
    sessions.delete(chatId);
}

export function dropSessionForOwner(sessionId: string, owner: RuntimeSessionOwner): boolean {
    if (!sessionMatchesOwner(sessionId, owner)) return false;
    return sessions.delete(sessionId);
}

/**
 * Walk parentChatId chain from root to immediate parent. Stops at missing
 * (evicted) ancestors. Returns oldest-first so callers building a transcript
 * can iterate naturally. Detects cycles via a visited set.
 */
export function getAncestors(chatId: string): AgentSession[] {
    const out: AgentSession[] = [];
    const visited = new Set<string>();
    const initial = sessions.get(chatId);
    if (initial) touch(initial);
    let cursor: string | undefined = initial?.session.parentChatId;
    while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        const e = sessions.get(cursor);
        if (!e) break;
        touch(e);
        out.unshift(e.session);
        cursor = e.session.parentChatId;
    }
    // `out` owns references to the complete chain now, so enforcing the hard
    // resident-stub cap cannot truncate the caller's current transcript.
    evictHistoryStubs();
    return out;
}

export function clearAllSessions(): void {
    sessions.clear();
}
