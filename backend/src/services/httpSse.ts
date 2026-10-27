const MAX_SSE_BUFFER_BYTES = 1_048_576;

/** Small writable surface shared by Express, multiplexed responses and tests. */
export interface SseWritableResponse {
  writableEnded: boolean;
  destroyed: boolean;
  writableLength: number;
  write(frame: string): unknown;
  destroy(error?: Error): unknown;
  once?(event: 'error', listener: () => void): unknown;
}

function disconnect(response: SseWritableResponse, message: string): void {
  try {
    // Standalone writer callers also need to consume async destroy(error) events.
    response.once?.('error', () => {});
    response.destroy(new Error(message));
  } catch { /* peer already gone */ }
}

/** Bound this observer's outgoing bytes; never cancel the producer or its turn. */
export function writeSseFrame(response: SseWritableResponse, frame: string): boolean {
  if (response.writableEnded || response.destroyed) return false;
  if (response.writableLength > MAX_SSE_BUFFER_BYTES) {
    disconnect(response, 'SSE client exceeded buffer limit');
    return false;
  }
  try {
    response.write(frame);
  } catch {
    disconnect(response, 'SSE write failed');
    return false;
  }
  if (response.writableLength > MAX_SSE_BUFFER_BYTES) {
    disconnect(response, 'SSE client exceeded buffer limit');
    return false;
  }
  return true;
}

interface SseObserverResponse extends SseWritableResponse {
  on(event: 'close' | 'error', listener: () => void): unknown;
  off(event: 'close' | 'error', listener: () => void): unknown;
}

/** Owns only subscription/heartbeat cleanup, including failed synchronous replay. */
export function createSseObserver(response: SseObserverResponse) {
  let closed = false;
  const cleanups = new Set<() => void>();
  const close = (): void => {
    if (closed) return;
    closed = true;
    response.off('close', close);
    // Keep the error listener until the response is collected: destroy(error) may
    // emit asynchronously after failed-write cleanup has already run.
    for (const cleanup of cleanups) {
      try { cleanup(); } catch { /* cleanup of another observer resource must continue */ }
    }
    cleanups.clear();
  };
  response.on('close', close);
  response.on('error', close);
  if (response.writableEnded || response.destroyed) close();
  const addCleanup = (cleanup: () => void): void => {
    if (closed) cleanup();
    else cleanups.add(cleanup);
  };
  const write = (frame: string): boolean => {
    if (closed) return false;
    if (writeSseFrame(response, frame)) return true;
    close();
    return false;
  };
  return {
    get closed() { return closed; },
    close,
    write,
    addCleanup,
    heartbeat(frame: string | (() => string), intervalMs: number): void {
      if (closed) return;
      const timer = setInterval(() => write(typeof frame === 'function' ? frame() : frame), intervalMs);
      timer.unref?.();
      addCleanup(() => clearInterval(timer));
    },
  };
}
