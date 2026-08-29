import type { AgentRunEventV1 } from 'michi-shared';
import type { AgentRunClock } from './ports';
import { systemAgentRunClock } from './ports';

type Listener = (event: AgentRunEventV1) => void;

/** Instance-scoped live fanout. Callers may publish only repository-returned
 * events, which guarantees commit-before-broadcast ordering. */
export class AgentRunEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly allListeners = new Set<Listener>();

  publishCommitted(event: AgentRunEventV1): void {
    for (const listener of this.listeners.get(event.runId) ?? []) listener(event);
    for (const listener of this.allListeners) listener(event);
  }

  subscribeAll(listener: Listener): () => void {
    this.allListeners.add(listener);
    return () => { this.allListeners.delete(listener); };
  }

  subscribe(runId: string, listener: Listener): () => void {
    const set = this.listeners.get(runId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(runId);
    };
  }

  waitForEvent(runId: string, afterSeq: number, timeoutMs: number,
    clock: AgentRunClock = systemAgentRunClock): Promise<AgentRunEventV1 | null> {
    return new Promise((resolve) => {
      let settled = false;
      const stop = this.subscribe(runId, (event) => {
        if (event.seq <= afterSeq || settled) return;
        settled = true;
        clock.clearTimeout(timer);
        stop();
        resolve(event);
      });
      const timer = clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        stop();
        resolve(null);
      }, timeoutMs);
    });
  }
}
