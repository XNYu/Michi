// Shared Server-Sent-Events frame parser.
//
// The backend speaks newline-delimited SSE: frames separated by a blank line
// (`\n\n`), each frame a set of `event:` / `data:` lines. Three transports
// (foreground `streamMessage`, foreground replay `subscribeChat`, and the
// window-lifetime `subscribeBackground`) all consumed this byte stream with an
// identical hand-written read+frame loop. This module collapses that loop into
// one place; the per-frame semantics stay with each caller via `onFrame`.

/**
 * A non-2xx HTTP response on an SSE subscribe endpoint. Callers inspect
 * `.status` to decide whether a reconnect is worthwhile.
 */
export class SseHttpError extends Error {
  constructor(public readonly status: number, prefix = 'subscribe failed') {
    super(`${prefix}: ${status}`);
  }
}

export interface ReadSseStreamOptions {
  /**
   * Fired after every non-terminal read (including heartbeat-only reads),
   * before the chunk is framed. Callers use it to re-arm a silence watchdog.
   */
  onRead?: () => void;
  /**
   * Checked immediately after each read. When it returns true the loop exits
   * without processing the just-read chunk — matches the legacy `if (stopped)
   * break;` guard on the background feed.
   */
  shouldStop?: () => boolean;
}

/**
 * Drain an SSE byte stream, invoking `onFrame(event, data)` once per frame that
 * carries non-empty data. `onFrame` may return a promise; when it does the loop
 * awaits it, turning a frame into a real ordering barrier (used by the
 * background feed's replay-gap reconciliation). When it returns void the loop
 * stays fully synchronous, preserving legacy frame-dispatch timing.
 *
 * SSE `data:` handling matches the spec: strip exactly ONE leading space if
 * present, then concatenate verbatim. Never `.trim()` — that ate whitespace
 * inside JSON payloads and corrupted multi-byte UTF-8 frames whose first byte
 * happened to be ASCII whitespace.
 */
export async function readSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onFrame: (event: string, data: string) => void | Promise<void>,
  opts: ReadSseStreamOptions = {},
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (opts.shouldStop?.()) break;
    opts.onRead?.();
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = block.split('\n');
      let evt = 'message';
      let data = '';
      for (const l of lines) {
        if (l.startsWith('event:')) evt = l.slice(6).trim();
        else if (l.startsWith('data:')) {
          const rest = l.slice(5);
          data += rest.startsWith(' ') ? rest.slice(1) : rest;
        }
      }
      if (!data) continue;
      const maybe = onFrame(evt, data);
      if (maybe) await maybe;
    }
  }
}
