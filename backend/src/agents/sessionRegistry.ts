import { trackSessionState, untrackSessionState, clearSessionStates, subscribeSessionStates } from './sessionStateFeed';
import type { AgentSession, ChatMessage, RuntimeSessionOwner } from "./types";
import type { NormalizedEvent } from "../services/chatEvents";
import { getRuntimeDeps } from "./runtimeDeps";
import {
    HISTORY_STUB_MAX_ENTRIES as STUB_MAX_ENTRIES,
    HISTORY_STUB_TTL_MS as STUB_TTL_MS,
    createSessionDirectory,
} from "michi-runtime/internal/core/sessionDirectory";
import { createRuntimeManager, type RuntimeManager } from "michi-runtime/internal/core/runtimeManager";
import type { RuntimeHost } from "michi-runtime/internal/contract/host";
import { interactiveOwner } from "michi-runtime/internal/contract/types";

export const HISTORY_STUB_TTL_MS = STUB_TTL_MS;
export const HISTORY_STUB_MAX_ENTRIES = STUB_MAX_ENTRIES;

let manager: RuntimeManager | undefined;

// Michi's process-wide session directory lives in its runtime manager. The
// exports below are thin accessors over it, so their callers and test stubs
// keep working unchanged.
function createMichiRuntimeManager(enforceUserOwnership: () => boolean, host?: RuntimeHost): RuntimeManager {
    const sessions = createSessionDirectory({
        enforceUserOwnership,
        // Through ./sessionStateFeed, which owns the persistence and log hooks.
        stateFeed: {
            track: (session, ownerUserId) => trackSessionState(session, ownerUserId),
            untrack: (sessionId) => untrackSessionState(sessionId),
            clear: () => clearSessionStates(),
            subscribe: (receive, ownerUserId) => subscribeSessionStates(receive, ownerUserId),
        },
    });
    return createRuntimeManager({ sessions, host });
}

/**
 * Builds Michi's runtime manager over the server's runtime host: session
 * ownership is then read from host.principal on every lookup. server.ts calls
 * it once, after configureRuntimeDeps and before the first runtime is
 * registered. A manager already in use is never replaced, since that would
 * drop its runtimes and sessions.
 */
export function configureRuntimeManager(host: RuntimeHost): RuntimeManager {
    if (manager) {
        throw new Error(
            "configureRuntimeManager: the runtime manager is already in use. Call it once, in server.ts "
            + "before anything reads agents/registry or agents/sessionRegistry, and do not call it again.",
        );
    }
    manager = createMichiRuntimeManager(() => host.principal.enforceUserOwnership(), host);
    return manager;
}

/**
 * @internal Michi's single runtime manager. Read it through ./registry and the
 * accessors below. Without configureRuntimeManager (tests, scripts), the first
 * use builds one that reads MICHI_CLOUD on every lookup, as Michi's host does;
 * not once, since tests switch MICHI_CLOUD at runtime.
 */
export function getRuntimeManager(): RuntimeManager {
    return manager ??= createMichiRuntimeManager(() => process.env.MICHI_CLOUD === '1');
}

/** Test helper: drops the manager and its sessions; the next use or configureRuntimeManager builds a new one. */
export function __resetRuntimeManager(): void {
    manager?.sessions.clear();
    manager = undefined;
}

const sessions = () => getRuntimeManager().sessions;

export function evictHistoryStubs(opts: {
    now?: number;
    maxEntries?: number;
    protectedIds?: ReadonlySet<string>;
} = {}): number {
    return sessions().evictStubs(opts);
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
        const existing = sessions().get(cursor);
        if (existing) {
            cursor = existing.parentChatId;
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
            sessions().insertStub(new HistoryStubSession(cursor, history, parentChatId), interactiveOwner(cursor));
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

/** Without an owner the directory uses the session's own, else the interactive owner of its id. */
export function registerSession(
    session: AgentSession,
    ownerUserId?: string | null,
    owner?: RuntimeSessionOwner,
): void {
    sessions().register(session, ownerUserId, owner);
}

/**
 * Low-level lookup used by internal/runtime callers (parent-chain stitching,
 * digest generation, etc.). Does NOT enforce ownership — callers are trusted.
 */
export function getSession(chatId: string): AgentSession | undefined {
    return sessions().get(chatId);
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
    return sessions().getForUser(chatId, userId);
}

/** Owner-aware lookup used by Run coordinators. It prevents a delayed action
 * for an old Attempt from reaching a replacement session. */
export function getSessionForOwner(
    sessionId: string,
    owner: RuntimeSessionOwner,
    userId: string | null,
): AgentSession | null {
    return sessions().getForOwner(sessionId, owner, userId);
}

export function sessionMatchesOwner(sessionId: string, owner: RuntimeSessionOwner): boolean {
    return sessions().matchesOwner(sessionId, owner);
}

export function dropSession(chatId: string): void {
    sessions().drop(chatId);
}

export function dropSessionForOwner(sessionId: string, owner: RuntimeSessionOwner): boolean {
    return sessions().dropForOwner(sessionId, owner);
}

/**
 * Walk parentChatId chain from root to immediate parent. Stops at missing
 * (evicted) ancestors. Returns oldest-first so callers building a transcript
 * can iterate naturally. Detects cycles via a visited set.
 */
export function getAncestors(chatId: string): AgentSession[] {
    const out: AgentSession[] = [];
    const visited = new Set<string>();
    let cursor: string | undefined = sessions().get(chatId)?.parentChatId;
    while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        const session = sessions().get(cursor);
        if (!session) break;
        out.unshift(session);
        cursor = session.parentChatId;
    }
    // `out` owns references to the complete chain now, so enforcing the hard
    // resident-stub cap cannot truncate the caller's current transcript.
    evictHistoryStubs();
    return out;
}

export function clearAllSessions(): void {
    sessions().clear();
}
