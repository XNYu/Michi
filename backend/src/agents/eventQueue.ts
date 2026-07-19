import type { NormalizedEvent } from '../services/chatEvents';
import { HEARTBEAT_INTERVAL_MS } from '../config/constants';

// ---- Internal queue ----------------------------------------------------------

export class EventQueue {
  private buf: Array<NormalizedEvent | null> = [];
  private waiter: ((v: NormalizedEvent | null) => void) | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private lastPushMs = Date.now();
  private readonly onHeartbeat: (idleMs: number) => void;
  private _disposed = false;

  constructor(onHeartbeat: (idleMs: number) => void) {
    this.onHeartbeat = onHeartbeat;
    this.startHeartbeat();
  }

  get isDisposed(): boolean { return this._disposed; }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const idleMs = Date.now() - this.lastPushMs;
      this.onHeartbeat(idleMs);
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  push(ev: NormalizedEvent | null): void {
    this.lastPushMs = Date.now();
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w(ev);
    } else {
      this.buf.push(ev);
    }
  }

  async pull(): Promise<NormalizedEvent | null> {
    if (this.buf.length > 0) return this.buf.shift()!;
    return new Promise<NormalizedEvent | null>((resolve) => {
      this.waiter = resolve;
    });
  }

  async *drainUntilTurnEnd(): AsyncIterableIterator<NormalizedEvent> {
    while (true) {
      const ev = await this.pull();
      if (ev === null) return;
      yield ev;
      if (ev.kind === 'turn_end') return;
    }
  }

  /** Resolve any pending pull() with null without disposing the queue.
   *  Used by send() to kick the idle pump out of its blocking pull() so
   *  it can re-check the gate and yield control. */
  interruptWaiter(): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w(null);
    }
  }

  dispose(): void {
    this._disposed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.interruptWaiter();
  }
}
