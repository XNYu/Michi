import type { AgentSession } from "./types";

type Entry = { session: AgentSession; ownerUserId: string | null };

const sessions = new Map<string, Entry>();

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
