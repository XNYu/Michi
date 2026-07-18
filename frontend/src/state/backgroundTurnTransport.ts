import { subscribeBackground } from '../services/api';
import type { BackgroundDisconnect } from '../services/api';
import type { StreamHandlers } from '../services/chatStreamEvents';

/**
 * One reconnecting SSE feed per ChatProvider. Unlike the retired pane
 * observer transport it has no membership list: self-initiated turns are
 * discovered by their chatId / turn_start envelope, including for closed
 * panes.
 */
export function createBackgroundTurnTransport(opts: {
  handlersForChat: (chatId: string, nodeId?: string) => StreamHandlers;
  cursorSnapshot?: () => Record<string, { turnId: string; seq: number }>;
  onReplayGap?: (
    gap: { chatId: string; nodeId?: string; turnId: string; seq: number },
    signal: AbortSignal,
  ) => void | Promise<void>;
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
    cancel = subscribeBackground(opts.handlersForChat, {
      cursors: opts.cursorSnapshot?.() ?? {},
      onReplayGap: opts.onReplayGap,
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
    });
  };

  return {
    start() {
      // Focused ChatProvider tests intentionally mock only foreground APIs.
      // Treat an omitted background transport mock as disabled rather than
      // coupling unrelated reducer tests to this connection lifecycle.
      if (typeof subscribeBackground !== 'function') return;
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
    },
  };
}
