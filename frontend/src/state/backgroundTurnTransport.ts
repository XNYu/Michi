import { subscribeBackground } from '../services/api';
import type { BackgroundDisconnect } from '../services/api';
import type { StreamHandlers } from '../services/chatStreamEvents';
import type { ScheduledJobRunEvent, ScheduledJobsChangedEvent } from 'michi-shared';
import { BACKEND_CONNECTION_READY } from '../config/backendConnectionState';

/**
 * One reconnecting SSE feed per ChatProvider. Unlike the retired pane
 * observer transport it has no membership list: turns from other clients and
 * self-initiated turns are
 * discovered by their chatId / turn_start envelope, including for closed
 * panes.
 */
export function createBackgroundTurnTransport(opts: {
  connectionId?: string;
  handlersForChat: (chatId: string, nodeId?: string) => StreamHandlers;
  cursorSnapshot?: () => Record<string, { turnId: string; seq: number }>;
  onReplayGap?: (
    gap: { chatId: string; nodeId?: string; turnId: string; seq: number },
    signal: AbortSignal,
  ) => void | Promise<void>;
  onScheduledJobRun?: (event: ScheduledJobRunEvent) => void;
  onScheduledJobsChanged?: (event: ScheduledJobsChangedEvent) => void;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  random?: () => number;
}): { start(): void; stop(): void } {
  const base = opts.reconnectDelayMs ?? 500;
  const max = opts.maxReconnectDelayMs ?? 10_000;
  const random = opts.random ?? Math.random;
  let stopped = false;
  let attempt = 0;
  let cancel: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let healthyTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (stopped) return;
    timer = null;
    cancel = subscribeBackground(opts.handlersForChat, {
      cursors: opts.cursorSnapshot?.() ?? {},
      onReplayGap: opts.onReplayGap,
      onScheduledJobRun: opts.onScheduledJobRun,
      onScheduledJobsChanged: opts.onScheduledJobsChanged,
      onOpen: () => {
        if (healthyTimer) clearTimeout(healthyTimer);
        // Do not erase backoff merely because HTTP headers arrived. A replay
        // barrier can still fail immediately after 200; only a connection
        // that stays healthy for a short window resets the retry budget.
        healthyTimer = setTimeout(() => { attempt = 0; }, Math.max(1_000, base * 4));
      },
      onDisconnect: (result: BackgroundDisconnect) => {
        if (healthyTimer) clearTimeout(healthyTimer);
        healthyTimer = null;
        cancel = null;
        if (stopped || !result.retryable) return;
        const delay = Math.min(max, base * (2 ** attempt++));
        timer = setTimeout(connect, Math.round(delay * (0.75 + random() * 0.5)));
      },
    }, opts.connectionId);
  };

  const wake = (event: Event) => {
    if (stopped) return;
    if (event.type === BACKEND_CONNECTION_READY
      && (event as CustomEvent<{ connectionId: string }>).detail?.connectionId !== opts.connectionId) return;
    if (cancel) return; // A live subscription owns its cursor; do not overlap it.
    if (timer) clearTimeout(timer);
    timer = null;
    connect();
  };

  return {
    start() {
      // Focused ChatProvider tests intentionally mock only foreground APIs.
      // Treat an omitted background transport mock as disabled rather than
      // coupling unrelated reducer tests to this connection lifecycle.
      if (typeof subscribeBackground !== 'function') return;
      if (typeof window !== 'undefined') {
        window.addEventListener('online', wake);
        window.addEventListener(BACKEND_CONNECTION_READY, wake);
      }
      if (!stopped && !cancel && !timer) connect();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (healthyTimer) clearTimeout(healthyTimer);
      timer = null;
      healthyTimer = null;
      cancel?.();
      cancel = null;
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', wake);
        window.removeEventListener(BACKEND_CONNECTION_READY, wake);
      }
    },
  };
}
