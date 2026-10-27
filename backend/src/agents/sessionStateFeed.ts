import type { AgentSessionState } from 'michi-shared';
import { createSessionStateFeed } from 'michi-runtime/internal/core/sessionStateFeed';
import type { AgentSession } from './types';
import { getRuntimeDeps } from './runtimeDeps';
import { log } from '../services/logger';

type Listener = (nodeId: string, state: AgentSessionState) => void;

// Michi's state feed: persists through the configured runtime deps and logs to
// the backend log. The session directory in ./sessionRegistry tracks through
// the exports below, so this module never needs to import it.
const feed = createSessionStateFeed({
    onSessionStateChanged(session, ownerUserId, state) {
        let persist: ReturnType<typeof getRuntimeDeps>['onSessionStateChanged'];
        try { persist = getRuntimeDeps().onSessionStateChanged; } catch { /* standalone adapter */ }
        persist?.(session, ownerUserId, state);
    },
    log: (level, _scope, msg, data) => log[level]('acp', msg, withNodeId(data)),
});

/** Michi's log records name the session `nodeId`; the package calls it `sessionId`. */
function withNodeId(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!data || !('sessionId' in data)) return data;
    const { sessionId, ...rest } = data;
    return { nodeId: sessionId, ...rest };
}

export function trackSessionState(session: AgentSession, ownerUserId: string | null): void {
    feed.track(session, ownerUserId);
}

export function untrackSessionState(nodeId: string): void {
    feed.untrack(nodeId);
}

export function clearSessionStates(): void {
    feed.clear();
}

/** No turn ID or watermark: these are current replaceable state, not replayed text. */
export function subscribeSessionStates(receive: Listener, ownerUserId?: string | null): () => void {
    return feed.subscribe(receive, ownerUserId);
}
