import type { AgentSessionState } from 'michi-shared';
import type { AgentSession } from './types';
import { getRuntimeDeps } from './runtimeDeps';
import { log } from '../services/logger';

type Listener = (nodeId: string, state: AgentSessionState) => void;
const sessions = new Map<string, { session: AgentSession; ownerUserId: string | null; detach: () => void }>();
const listeners = new Set<{ receive: Listener; ownerUserId?: string | null }>();

export function trackSessionState(session: AgentSession, ownerUserId: string | null): void {
    untrackSessionState(session.id);
    if (!session.getSessionState || session.owner?.kind === 'agent_run') return;
    const notify = () => {
        if (sessions.get(session.id)?.session !== session) return;
        const state = session.getSessionState!();
        let persist: ReturnType<typeof getRuntimeDeps>['onSessionStateChanged'];
        try { persist = getRuntimeDeps().onSessionStateChanged; } catch { /* standalone adapter */ }
        try { persist?.(session, ownerUserId, state); }
        catch (error) { log.warn('acp', 'could not persist session settings', { nodeId: session.id, error: String(error) }); }
        for (const listener of listeners) {
            if (listener.ownerUserId !== undefined && listener.ownerUserId !== ownerUserId) continue;
            try { listener.receive(session.id, state); } catch { /* the transport owns disconnection */ }
        }
    };
    const detach = session.onSessionState?.(notify) ?? (() => {});
    sessions.set(session.id, { session, ownerUserId, detach });
    notify();
}

export function untrackSessionState(nodeId: string): void {
    sessions.get(nodeId)?.detach(); sessions.delete(nodeId);
}

export function clearSessionStates(): void {
    for (const nodeId of sessions.keys()) untrackSessionState(nodeId);
}

/** No turn ID or watermark: these are current replaceable state, not replayed text. */
export function subscribeSessionStates(receive: Listener, ownerUserId?: string | null): () => void {
    for (const [nodeId, entry] of sessions) {
        if (ownerUserId !== undefined && ownerUserId !== entry.ownerUserId) continue;
        receive(nodeId, entry.session.getSessionState!());
    }
    const listener = { receive, ownerUserId }; listeners.add(listener);
    return () => { listeners.delete(listener); };
}
