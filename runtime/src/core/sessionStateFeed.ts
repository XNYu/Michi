import type { AgentSessionState } from 'michi-shared';
import type { AgentSession } from '../contract/types';
import { ownerMode } from '../contract/host';

export type SessionLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Host log sink. `scope` names the package component that emitted the record. */
export type SessionLog = (level: SessionLogLevel, scope: string, msg: string, data?: Record<string, unknown>) => void;

export type SessionStateListener = (sessionId: string, state: AgentSessionState) => void;

export type SessionStateChanged = (session: AgentSession, ownerUserId: string | null, state: AgentSessionState) => void;

export interface SessionStateFeedOptions {
  /** Called on every state change of a tracked session, before listeners. A throw is logged and listeners still run. */
  onSessionStateChanged?: SessionStateChanged;
  log?: SessionLog;
}

/**
 * Current, replaceable state of tracked sessions (mode, model, ...). It carries
 * no turn id or watermark: subscribers get the current value, not a replay.
 */
export interface SessionStateFeed {
  /** Replaces any earlier tracking of `session.id`. Agent Run sessions and sessions without state are not tracked. */
  track(session: AgentSession, ownerUserId: string | null): void;
  untrack(sessionId: string): void;
  clear(): void;
  /**
   * Replays the current state of every tracked session, then delivers later
   * changes. With `ownerUserId` (null included) only that user's sessions are
   * delivered; `undefined` receives every session.
   */
  subscribe(receive: SessionStateListener, ownerUserId?: string | null): () => void;
}

export function createSessionStateFeed(options: SessionStateFeedOptions = {}): SessionStateFeed {
  const { onSessionStateChanged } = options;
  const log: SessionLog = (level, scope, msg, data) => {
    try { options.log?.(level, scope, msg, data); } catch { /* a failing log sink must not break notification */ }
  };
  const tracked = new Map<string, { session: AgentSession; ownerUserId: string | null; detach: () => void }>();
  const listeners = new Set<{ receive: SessionStateListener; ownerUserId?: string | null }>();

  function untrack(sessionId: string): void {
    tracked.get(sessionId)?.detach();
    tracked.delete(sessionId);
  }

  return {
    track(session, ownerUserId) {
      untrack(session.id);
      if (!session.getSessionState || (session.owner && ownerMode(session.owner) === 'headless')) return;
      const notify = () => {
        if (tracked.get(session.id)?.session !== session) return;
        const state = session.getSessionState!();
        try { onSessionStateChanged?.(session, ownerUserId, state); }
        catch (error) { log('warn', 'session-state', 'could not persist session settings', { sessionId: session.id, error: String(error) }); }
        for (const listener of listeners) {
          if (listener.ownerUserId !== undefined && listener.ownerUserId !== ownerUserId) continue;
          try { listener.receive(session.id, state); } catch { /* the transport owns disconnection */ }
        }
      };
      const detach = session.onSessionState?.(notify) ?? (() => {});
      tracked.set(session.id, { session, ownerUserId, detach });
      notify();
    },
    untrack,
    clear() {
      for (const sessionId of tracked.keys()) untrack(sessionId);
    },
    subscribe(receive, ownerUserId) {
      for (const [sessionId, entry] of tracked) {
        if (ownerUserId !== undefined && ownerUserId !== entry.ownerUserId) continue;
        receive(sessionId, entry.session.getSessionState!());
      }
      const listener = { receive, ownerUserId };
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
