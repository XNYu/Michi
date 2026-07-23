import {
  CHAT_STREAM_EVENTS,
  dispatchChatStreamEvent,
  parseChatStreamEvent,
} from '../chatStreamEvents';
import type { StreamHandlers } from '../chatStreamEvents';
import { startupMark } from '../startupTrace';
import { API_BASE_URL } from '../../config/env';
import { SseHttpError, readSseStream } from './sseParser';

let cachedStreamProbeEnabled: boolean | null = null;

function streamProbeEnabled(): boolean {
  if (cachedStreamProbeEnabled !== null) return cachedStreamProbeEnabled;
  if (typeof window === 'undefined') return false;
  try {
    cachedStreamProbeEnabled = window.localStorage.getItem('michi:stream-probe') === '1';
    return cachedStreamProbeEnabled;
  } catch {
    cachedStreamProbeEnabled = false;
    return false;
  }
}

function writeStreamProbe(row: Record<string, unknown>): void {
  if (!streamProbeEnabled()) return;
  // eslint-disable-next-line no-console
  console.info(JSON.stringify({ type: 'stream_probe', source: 'renderer', ...row }));
}

export interface ExportRequestPayload {
  workspace: {
    name: string;
    cwd?: string;
    createdAt: number;
  };
  rootTitle: string;
  nodes: Array<{
    nodeId: string;
    parentNodeId?: string;
    title?: string;
    depth: number;
    messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  }>;
  cwd?: string;
  nodeIds?: string[];
}

function createClientTurnId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Web Crypto is available in every supported renderer, but retaining a
  // fallback keeps the transport usable in stripped-down test/webview hosts.
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Consume an SSE stream produced by the backend. Returns a cancel function
 * that aborts the fetch (also calls /cancel on the backend).
 */
export function streamMessage(
  nodeId: string,
  text: string,
  handlers: StreamHandlers,
  ownerToken?: string,
  durable?: {
    /** Generated before POST so replay is possible before the first frame. */
    turnId?: string;
    displayText?: string;
    userMetadata?: {
      quotedText?: string;
      attachments?: Array<{ name: string; absPath: string }>;
      comments?: Array<Record<string, unknown>>;
    };
  },
): () => void {
  const controller = new AbortController();
  const probeEnabled = streamProbeEnabled();

  // ── Terminal-state safety net ──
  // The assistant node leaves `status: 'streaming'` only when a `done`/`error`
  // event reaches the reducer. If the connection ends or silently stalls
  // without one, we MUST still finalize the node — otherwise it stays pinned in
  // "streaming" forever (frozen, no spinner, Stop does nothing).
  const STREAM_SILENCE_TIMEOUT_MS = 30_000; // 3× the backend's 10s heartbeat
  let terminalSeen = false; // a done/error frame was dispatched to the reducer
  let settled = false;      // a synthetic terminal handler has fired
  let watchdogTimedOut = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  // Do not wait for turn_start to learn this: a broken response can occur
  // after the server began the turn but before any SSE bytes reach us.
  // The server requires nodeId for a durable foreground turn. Preserve the
  // legacy no-node helper behavior used by a few lightweight callers/tests.
  const clientTurnId = nodeId ? (durable?.turnId ?? createClientTurnId()) : '';
  let resumeTurnId = clientTurnId;
  let resumeSeq = -1;
  let resumeCancel: (() => void) | null = null;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  let resumeAttempt = 0;
  let cancelledByUser = false;
  let sawFirstByte = false;
  const resumeForeground = (): boolean => {
    if (!resumeTurnId || cancelledByUser || resumeCancel || resumeTimer) return false;
    resumeCancel = subscribeChat(nodeId, {
      ...handlers,
      onEnvelope: (envelope) => {
        if (envelope.turnId) resumeTurnId = envelope.turnId;
        if (typeof envelope.seq === 'number') resumeSeq = Math.max(resumeSeq, envelope.seq);
        return handlers.onEnvelope?.(envelope);
      },
      onDone: (...args) => { terminalSeen = true; handlers.onDone?.(...args); },
      onError: (...args) => { terminalSeen = true; handlers.onError?.(...args); },
    }, { turnId: resumeTurnId, seq: resumeSeq + 1 }, {
      onOpen: () => { resumeAttempt = 0; },
      onDisconnect: (result) => {
        resumeCancel = null;
        if (terminalSeen || cancelledByUser || settled) return;
        if (!result.retryable) {
          settleError(result.error?.message ?? 'turn replay unavailable');
          return;
        }
        const delay = Math.min(5_000, 250 * (2 ** resumeAttempt++));
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
          if (!resumeForeground()) settleError('turn replay ended before completion');
        }, delay);
      },
    });
    return true;
  };

  const clearWatchdog = () => {
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
  };
  function settleError(message: string): void {
    if (settled || terminalSeen) return;
    settled = true;
    clearWatchdog();
    handlers.onError?.(message);
  }
  function settleAborted(): void {
    if (settled || terminalSeen) return;
    settled = true;
    clearWatchdog();
    handlers.onAborted?.();
  }
  const armWatchdog = () => {
    clearWatchdog();
    watchdog = setTimeout(() => {
      watchdogTimedOut = true;
      controller.abort(); // unstick a half-open reader.read() that never resolves
      if (!resumeTurnId) settleError('stream stalled — no data received');
    }, STREAM_SILENCE_TIMEOUT_MS);
  };

  (async () => {
    try {
      const payload: Record<string, unknown> = { text };
      if (clientTurnId) payload.turnId = clientTurnId;
      if (nodeId) payload.nodeId = nodeId;
      if (ownerToken) payload.ownerToken = ownerToken;
      if (durable?.displayText !== undefined) payload.displayText = durable.displayText;
      if (durable?.userMetadata) payload.userMetadata = durable.userMetadata;
      const startedAt = Date.now();
      startupMark('stream_request_start', { chatId: nodeId, nodeId, textLen: text.length });
      const res = await fetch(`${API_BASE_URL}/chats/${nodeId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
      sawFirstByte = true;
      startupMark('stream_response_headers', { chatId: nodeId, nodeId, status: res.status, durMs: Date.now() - startedAt });

      const reader = res.body.getReader();
      let sawFirstEvent = false;
      let sawFirstChunk = false;
      let chunkSeq = 0;
      let prevChunkAt = 0;

      armWatchdog();
      await readSseStream(reader, (evt, data) => {
        const parsed = parseChatStreamEvent(evt, data);
        if (!parsed) return;
        if (parsed.data.turnId) resumeTurnId = parsed.data.turnId;
        if (typeof parsed.data.seq === 'number') resumeSeq = Math.max(resumeSeq, parsed.data.seq);
        if (!sawFirstEvent) {
          sawFirstEvent = true;
          startupMark('first_sse_event', { chatId: nodeId, nodeId, event: parsed.event, durMs: Date.now() - startedAt });
        }
        if (!sawFirstChunk && parsed.event === 'chunk') {
          sawFirstChunk = true;
          startupMark('first_sse_chunk', { chatId: nodeId, nodeId, durMs: Date.now() - startedAt });
        }
        if (probeEnabled && parsed.event === CHAT_STREAM_EVENTS.chunk) {
          const now = Date.now();
          chunkSeq += 1;
          writeStreamProbe({
            phase: 'sse_chunk',
            chatId: nodeId,
            nodeId,
            seq: chunkSeq,
            chars: parsed.data.text.length,
            bytes: new TextEncoder().encode(parsed.data.text).length,
            dtMs: prevChunkAt === 0 ? 0 : now - prevChunkAt,
            sinceStartMs: now - startedAt,
          });
          prevChunkAt = now;
        }
        if (
          parsed.event === CHAT_STREAM_EVENTS.done ||
          parsed.event === CHAT_STREAM_EVENTS.error
        ) {
          terminalSeen = true;
          clearWatchdog();
        }
        dispatchChatStreamEvent(parsed, handlers);
      }, { onRead: () => armWatchdog() }); // bytes arrived (incl. heartbeats) — reset the silence timer
      // A foreground runner can outlive its first HTTP response. Reattach to
      // the same immutable turn/cursor rather than handing it to background
      // SSE (which intentionally never carries user turns).
      if (!terminalSeen && resumeForeground()) return;
      // Connection closed before we received a turn id, so no safe replay is
      // possible. Surface a terminal error rather than silently mixing feeds.
      settleError('stream closed before completion');
    } catch (err: any) {
      // Only attempt foreground resume if we received a successful HTTP
      // response (the turn was started on the backend). When the POST itself
      // fails (409 turn-already-active, 404, etc.) the turn was never started
      // and subscribing to it always 410s — surface the real error instead.
      if (!terminalSeen && !cancelledByUser && sawFirstByte && resumeForeground()) return;
      if (err?.name === 'AbortError') {
        // A user/navigation abort finalizes as aborted. A watchdog abort with
        // no stamped turn id cannot safely resume.
        if (watchdogTimedOut) settleError('stream stalled — no data received');
        else settleAborted();
      } else {
        settleError(err?.message || String(err));
      }
    } finally {
      clearWatchdog();
    }
  })();

  return () => {
    cancelledByUser = true;
    settleAborted();
    clearWatchdog();
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = null;
    controller.abort();
    resumeCancel?.();
    cancelChat(nodeId, ownerToken, resumeTurnId || clientTurnId).catch(() => {});
  };
}

export async function cancelChat(chatId: string, ownerToken?: string, turnId?: string): Promise<void> {
  await fetch(`${API_BASE_URL}/chats/${chatId}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(ownerToken ? { ownerToken } : {}),
      ...(turnId ? { turnId } : {}),
    }),
  });
}

export interface ChatStreamDisconnect {
  retryable: boolean;
  error?: Error;
}

export function subscribeChat(
  chatId: string,
  handlers: StreamHandlers,
  from: { turnId?: string; seq?: number } = {},
  opts: {
    onOpen?: () => void;
    onDisconnect?: (result: ChatStreamDisconnect) => void;
    onError?: (err: Error) => void;
  } = {},
): () => void {
  const controller = new AbortController();
  let stopped = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimedOut = false;
  const clearWatchdog = () => {
    if (watchdog === null) return;
    clearTimeout(watchdog);
    watchdog = null;
  };
  const armWatchdog = () => {
    clearWatchdog();
    watchdog = setTimeout(() => {
      watchdogTimedOut = true;
      controller.abort();
    }, 30_000);
  };
  (async () => {
    let disconnect: ChatStreamDisconnect = { retryable: true };
    try {
      const query = new URLSearchParams();
      query.set('fromSeq', String(from.seq ?? 0));
      if (from.turnId) query.set('fromTurnId', from.turnId);
      const res = await fetch(`${API_BASE_URL}/chats/${chatId}/stream?${query.toString()}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new SseHttpError(res.status);
      if (!res.body) throw new Error('subscribe response has no body');
      opts.onOpen?.();
      const reader = res.body.getReader();
      armWatchdog();
      await readSseStream(reader, (evt, data) => {
        const parsed = parseChatStreamEvent(evt, data);
        if (parsed) dispatchChatStreamEvent(parsed, handlers);
      }, { onRead: () => armWatchdog() });
    } catch (err) {
      const original = err instanceof Error ? err : new Error(String(err));
      const error = watchdogTimedOut ? new Error('turn replay stalled — no data received') : original;
      disconnect = {
        retryable: !(original instanceof SseHttpError)
          || original.status >= 500
          || original.status === 408
          || original.status === 429,
        error,
      };
      if (!stopped) opts.onError?.(error);
    } finally {
      clearWatchdog();
      if (!stopped) opts.onDisconnect?.(disconnect);
    }
  })();
  return () => {
    stopped = true;
    clearWatchdog();
    controller.abort();
  };
}

export interface BackgroundDisconnect {
  retryable: boolean;
  error?: Error;
}

export interface SubscribeBackgroundOptions {
  onOpen?: () => void;
  onDisconnect?: (result: BackgroundDisconnect) => void;
  onError?: (err: Error) => void;
  cursors?: Record<string, { turnId: string; seq: number }>;
  /**
   * Reconcile an evicted replay cursor before any later frame is delivered.
   * The parser awaits this callback, turning the control frame into a real
   * ordering barrier instead of racing a stale snapshot against live data.
   */
  onReplayGap?: (
    gap: { chatId: string; nodeId?: string; turnId: string; seq: number },
    signal: AbortSignal,
  ) => void | Promise<void>;
}

const OBSERVER_SILENCE_TIMEOUT_MS = 30_000;

function observerDisconnectFor(error: Error): BackgroundDisconnect {
  return {
    retryable: !(error instanceof SseHttpError) || error.status >= 500,
    error,
  };
}

/**
 * The one Window-lifetime background feed. It carries runtime self-turns
 * only; user initiated turns stay on their own direct /message stream.
 */
export function subscribeBackground(
  handlersForChat: (chatId: string, nodeId?: string) => StreamHandlers,
  opts: SubscribeBackgroundOptions = {},
): () => void {
  const controller = new AbortController();
  let stopped = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const clearWatchdog = () => {
    if (watchdog === null) return;
    clearTimeout(watchdog);
    watchdog = null;
  };
  const armWatchdog = () => {
    clearWatchdog();
    watchdog = setTimeout(() => controller.abort(), OBSERVER_SILENCE_TIMEOUT_MS);
  };

  (async () => {
    let disconnect: BackgroundDisconnect = { retryable: true };
    try {
      const res = await fetch(`${API_BASE_URL}/chats/background/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cursors: opts.cursors ?? {} }),
        signal: controller.signal,
      });
      if (!res.ok) throw new SseHttpError(res.status);
      if (!res.body) throw new Error('subscribe response has no body');
      opts.onOpen?.();
      const reader = res.body.getReader();
      armWatchdog();
      await readSseStream(reader, (evt, data) => {
        if (evt === 'background_sync_required') {
          let gap: Record<string, unknown> | null = null;
          try {
            gap = JSON.parse(data) as Record<string, unknown>;
          } catch {
            // Malformed control frames are ignored like malformed events.
          }
          if (
            gap
            && typeof gap.chatId === 'string'
            && typeof gap.turnId === 'string'
            && typeof gap.seq === 'number'
          ) {
            // Deliberately returned (awaited by readSseStream): reconciliation
            // failures must close this feed so the transport reconnects and
            // retries the same durable gap instead of silently moving on.
            return opts.onReplayGap?.({
              chatId: gap.chatId,
              nodeId: typeof gap.nodeId === 'string' ? gap.nodeId : undefined,
              turnId: gap.turnId,
              seq: gap.seq,
            }, controller.signal);
          }
          return;
        }
        const parsed = parseChatStreamEvent(evt, data);
        const chatId = parsed?.data.chatId;
        if (!parsed || !chatId) return;
        dispatchChatStreamEvent(parsed, handlersForChat(chatId, parsed.data.nodeId));
      }, { onRead: () => armWatchdog(), shouldStop: () => stopped });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      disconnect = observerDisconnectFor(error);
      if (!stopped) {
        controller.abort();
        opts.onError?.(error);
      }
    } finally {
      clearWatchdog();
      if (!stopped) opts.onDisconnect?.(disconnect);
    }
  })();
  return () => {
    stopped = true;
    clearWatchdog();
    controller.abort();
  };
}
