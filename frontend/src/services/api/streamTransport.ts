import {
  STREAM_TRANSPORT_PATH,
  STREAM_MAX_BODY_BYTES,
  STREAM_MAX_FRAME_BYTES,
  type StreamTransportRequest,
  type StreamTransportResponse,
} from 'michi-shared';

const HEADER_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

interface Channel {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  cleanup: () => void;
  sent: boolean;
  socket?: WebSocket;
}

/** One socket per gateway/window, including that gateway's remote proxies. */
export class StreamTransport {
  private socket: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private channels = new Map<string, Channel>();
  private nextId = 0;
  private closed = false;
  private connectAbort = new AbortController();

  constructor(private readonly apiBase: string) {}

  private finish(id: string, error?: Error): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    this.channels.delete(id);
    channel.cleanup();
    if (error) {
      if (channel.controller) channel.controller.error(error);
      else channel.reject(error);
    } else if (channel.controller) channel.controller.close();
    else channel.reject(new Error('Stream ended before response headers'));
  }

  private send(frame: StreamTransportRequest): void {
    const socket = this.channels.get(frame.id)?.socket ?? this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify(frame);
    if (frame.type === 'open') {
      if (payload.length > STREAM_MAX_FRAME_BYTES || new TextEncoder().encode(payload).byteLength > STREAM_MAX_FRAME_BYTES) {
        throw new Error('Stream request is too large');
      }
      if (socket.bufferedAmount > MAX_BUFFER_BYTES) throw new Error('Stream connection is busy; retry shortly');
    }
    socket.send(payload);
  }

  private async connect(): Promise<WebSocket> {
    if (this.closed) throw new Error('Stream transport closed');
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (this.connecting) return this.connecting;
    const connecting = (async () => {
      const response = await fetch(`${this.apiBase}${STREAM_TRANSPORT_PATH}`, {
        method: 'POST', signal: AbortSignal.any([this.connectAbort.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) throw new Error(`Stream connection failed: ${response.status}`);
      const body = await response.json() as { token?: unknown };
      if (this.closed) throw new Error('Stream transport closed');
      if (typeof body.token !== 'string') throw new Error('Invalid stream connection ticket');
      const url = new URL(`${this.apiBase}${STREAM_TRANSPORT_PATH}`, window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('token', body.token);
      return new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(url);
        const onAbort = () => socket.close();
        this.connectAbort.signal.addEventListener('abort', onAbort, { once: true });
        const timeout = setTimeout(() => {
          reject(new Error('Stream connection timed out'));
          socket.close();
        }, 10_000);
        socket.onopen = () => {
          clearTimeout(timeout);
          this.socket = socket;
          resolve(socket);
        };
        socket.onerror = () => {
          clearTimeout(timeout);
          reject(new Error('Stream connection failed'));
          socket.close();
        };
        socket.onclose = () => {
          clearTimeout(timeout);
          this.connectAbort.signal.removeEventListener('abort', onAbort);
          reject(new Error('Stream connection closed'));
          if (this.socket === socket) this.socket = null;
          for (const [id, channel] of this.channels) {
            if (channel.socket === socket) this.finish(id, new Error('Stream connection closed'));
          }
        };
        socket.onmessage = (event) => {
          let frame: StreamTransportResponse;
          try {
            frame = JSON.parse(event.data) as StreamTransportResponse;
            if (!frame || typeof frame !== 'object') throw new Error();
          }
          catch { socket.close(1008, 'Invalid stream frame'); return; }
          const channel = this.channels.get(frame.id);
          if (!channel) return;
          if (frame.type === 'headers') {
            if (channel.controller || !Number.isInteger(frame.status) || frame.status < 200 || frame.status > 599) {
              socket.close(1008, 'Invalid stream headers'); return;
            }
            const stream = new ReadableStream<Uint8Array>({
              start: (controller) => { channel.controller = controller; },
              cancel: () => {
                this.send({ type: 'cancel', id: frame.id });
                channel.controller = undefined;
                this.finish(frame.id, new DOMException('Aborted', 'AbortError'));
              },
            }, { highWaterMark: MAX_BUFFER_BYTES, size: (chunk) => chunk.byteLength });
            channel.resolve(new Response([204, 205, 304].includes(frame.status) ? null : stream, {
              status: frame.status, headers: { 'Content-Type': 'text/event-stream' },
            }));
          } else if (frame.type === 'data') {
            if (!channel.controller || typeof frame.text !== 'string') {
              this.finish(frame.id, new Error('Invalid stream data'));
              this.send({ type: 'cancel', id: frame.id });
            } else if ((channel.controller.desiredSize ?? 0) < 0) {
              this.finish(frame.id, new Error('Stream consumer is too slow; reconnect to replay'));
              this.send({ type: 'cancel', id: frame.id });
            } else channel.controller.enqueue(new TextEncoder().encode(frame.text));
          } else if (frame.type === 'end') this.finish(frame.id);
          else if (frame.type === 'error') this.finish(frame.id, new Error(frame.message));
        };
      });
    })();
    this.connecting = connecting;
    try { return await connecting; }
    finally { if (this.connecting === connecting) this.connecting = null; }
  }

  fetch(url: string, options: RequestInit = {}): Promise<Response> {
    const target = new URL(url, window.location.href);
    const base = new URL(this.apiBase, window.location.href);
    if (target.origin !== base.origin || !target.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/`)) {
      return Promise.reject(new Error('Stream URL is outside the backend gateway'));
    }
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (options.body !== undefined && options.body !== null && typeof options.body !== 'string') {
      return Promise.reject(new Error('Stream request body must be JSON text'));
    }
    if (typeof options.body === 'string' && (options.body.length > STREAM_MAX_BODY_BYTES
      || new TextEncoder().encode(options.body).byteLength > STREAM_MAX_BODY_BYTES)) {
      return Promise.resolve(new Response(null, { status: 413 }));
    }
    const id = String(++this.nextId);
    return new Promise<Response>((resolve, reject) => {
      const abort = () => {
        if (this.channels.get(id)?.sent) this.send({ type: 'cancel', id });
        this.finish(id, options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        this.send({ type: 'cancel', id });
        this.finish(id, new Error('Stream response timed out'));
      }, HEADER_TIMEOUT_MS);
      const channel: Channel = {
        resolve: (response) => { clearTimeout(timer); resolve(response); },
        reject,
        sent: false,
        cleanup: () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); },
      };
      this.channels.set(id, channel);
      options.signal?.addEventListener('abort', abort, { once: true });
      void this.connect().then((socket) => {
        if (!this.channels.has(id)) return;
        if (socket.readyState !== WebSocket.OPEN) throw new Error('Stream connection closed');
        channel.socket = socket;
        channel.sent = true;
        this.send({ type: 'open', id, path: target.pathname + target.search,
          method: (options.method ?? 'GET') as 'GET' | 'POST',
          ...(typeof options.body === 'string' ? { body: options.body } : {}),
        });
      }).catch((error: Error) => this.finish(id, error));
    });
  }

  close(): void {
    this.closed = true;
    this.connectAbort.abort();
    this.socket?.close();
    this.socket = null;
    for (const id of this.channels.keys()) this.finish(id, new Error('Stream transport closed'));
  }
}

let gateway: { base: string; available: Promise<boolean>; transport: StreamTransport } | undefined;

/** Install the existing boot capability probe as a barrier before opening feeds. */
export function configureStreamTransport(base: string, available: Promise<boolean>): void {
  // A new hydration can follow an account change. Acquire fresh credentials
  // instead of retaining the previous session's authenticated socket.
  gateway?.transport.close();
  gateway = { base, available: available.catch(() => false), transport: new StreamTransport(base) };
}

export async function fetchStream(url: string, options: RequestInit = {}): Promise<Response> {
  const current = gateway;
  if (current && typeof WebSocket !== 'undefined' && url.startsWith(`${current.base}/`)
    && await current.available) {
    return current.transport.fetch(url, options);
  }
  // Older gateways and isolated SSE mocks retain the original HTTP transport.
  return fetch(url, options);
}
