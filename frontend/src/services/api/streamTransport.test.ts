import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamTransport, configureStreamTransport, fetchStream } from './streamTransport';
import { STREAM_MAX_BODY_BYTES } from 'michi-shared';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  receive(frame: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

describe('multiplexed stream transport', () => {
  let transport: StreamTransport;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: 'ticket' })));
    vi.stubGlobal('fetch', fetchMock);
    transport = new StreamTransport('http://localhost:3000/api');
  });
  afterEach(() => {
    transport.close();
    configureStreamTransport('http://localhost:3000/api', Promise.resolve(false));
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function openSocket(expectedRequests = 1) {
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
    const socket = FakeSocket.instances.at(-1)!;
    socket.open();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(expectedRequests));
    return socket;
  }

  it('opens concurrent streams using one authenticated socket, retaining bodies and cursors', async () => {
    const first = transport.fetch('http://localhost:3000/api/chats/one/message', { method: 'POST', body: '{"turnId":"T1"}' });
    const second = transport.fetch('http://localhost:3000/api/backend-connections/remote/proxy/chats/two/stream?fromSeq=9&fromTurnId=T2');
    const socket = await openSocket(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.sent).toEqual([
      { type: 'open', id: '1', path: '/api/chats/one/message', method: 'POST', body: '{"turnId":"T1"}' },
      { type: 'open', id: '2', path: '/api/backend-connections/remote/proxy/chats/two/stream?fromSeq=9&fromTurnId=T2', method: 'GET' },
    ]);
    socket.receive({ type: 'headers', id: '1', status: 200 });
    socket.receive({ type: 'headers', id: '2', status: 403 });
    socket.receive({ type: 'data', id: '1', text: 'one' });
    socket.receive({ type: 'data', id: '2', text: '{"error":"not owner"}' });
    socket.receive({ type: 'end', id: '2' });
    socket.receive({ type: 'end', id: '1' });
    await expect((await first).text()).resolves.toBe('one');
    const denied = await second;
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({ error: 'not owner' });
  });

  it('aborting one stream does not close the socket or send a chat cancellation request', async () => {
    const controller = new AbortController();
    const first = transport.fetch('http://localhost:3000/api/chats/one/stream', { signal: controller.signal });
    const second = transport.fetch('http://localhost:3000/api/chats/two/stream');
    const socket = await openSocket(2);
    socket.receive({ type: 'headers', id: '1', status: 200 });
    socket.receive({ type: 'headers', id: '2', status: 200 });
    const reading = (await first).text();
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(socket.readyState).toBe(1);
    expect(socket.sent.at(-1)).toEqual({ type: 'cancel', id: '1' });
    socket.receive({ type: 'data', id: '2', text: 'still live' });
    socket.receive({ type: 'end', id: '2' });
    await expect((await second).text()).resolves.toBe('still live');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reader cancellation releases the channel without closing an already-cancelled controller', async () => {
    const response = transport.fetch('http://localhost:3000/api/chats/one/stream');
    const socket = await openSocket();
    socket.receive({ type: 'headers', id: '1', status: 200 });
    await expect((await response).body!.cancel()).resolves.toBeUndefined();
    expect(socket.sent.at(-1)).toEqual({ type: 'cancel', id: '1' });
  });

  it('aborting before the ticket arrives never sends the message', async () => {
    let resolveTicket!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => { resolveTicket = resolve; }));
    const controller = new AbortController();
    const pending = transport.fetch('http://localhost:3000/api/chats/one/message', { signal: controller.signal, method: 'POST', body: '{}' });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    resolveTicket(new Response(JSON.stringify({ token: 'ticket' })));
    const socket = await openSocket(0);
    expect(socket.sent).toEqual([]);
  });

  it('propagates socket loss to active readers and reconnects on the next subscription', async () => {
    const response = transport.fetch('http://localhost:3000/api/chats/one/stream');
    const firstSocket = await openSocket();
    firstSocket.receive({ type: 'headers', id: '1', status: 200 });
    const rejected = expect((await response).text()).rejects.toThrow('Stream connection closed');
    firstSocket.close();
    await rejected;
    const next = transport.fetch('http://localhost:3000/api/chats/one/stream?fromSeq=8');
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    const secondSocket = await openSocket();
    secondSocket.receive({ type: 'headers', id: '2', status: 200 });
    secondSocket.receive({ type: 'end', id: '2' });
    await expect((await next).text()).resolves.toBe('');
  });

  it('times out before response headers instead of leaving an infinite loading state', async () => {
    vi.useFakeTimers();
    const pending = transport.fetch('http://localhost:3000/api/chats/one/stream');
    const rejected = expect(pending).rejects.toThrow('Stream response timed out');
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeSocket.instances[0];
    socket.open();
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(socket.sent.at(-1)).toEqual({ type: 'cancel', id: '1' });
  });

  it('does not retry a failed connection by resending a foreground POST over HTTP', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(transport.fetch('http://localhost:3000/api/chats/one/message', { method: 'POST', body: '{}' })).rejects.toThrow('403');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('rejects an oversized request without disturbing other streams', async () => {
    const first = transport.fetch('http://localhost:3000/api/chats/one/stream');
    const socket = await openSocket();
    socket.receive({ type: 'headers', id: '1', status: 200 });
    const rejected = await transport.fetch('http://localhost:3000/api/chats/two/message', {
      method: 'POST', body: 'x'.repeat(STREAM_MAX_BODY_BYTES + 1),
    });
    expect(rejected.status).toBe(413);
    expect(socket.sent).toHaveLength(1);
    socket.receive({ type: 'data', id: '1', text: 'still live' });
    socket.receive({ type: 'end', id: '1' });
    await expect((await first).text()).resolves.toBe('still live');
  });

  it('bounds slow consumers and leaves other readers connected', async () => {
    const first = transport.fetch('http://localhost:3000/api/chats/one/stream');
    const second = transport.fetch('http://localhost:3000/api/chats/two/stream');
    const socket = await openSocket(2);
    socket.receive({ type: 'headers', id: '1', status: 200 });
    socket.receive({ type: 'headers', id: '2', status: 200 });
    const response = await first;
    socket.receive({ type: 'data', id: '1', text: 'x'.repeat(8 * 1024 * 1024 + 1) });
    socket.receive({ type: 'data', id: '1', text: 'overflow' });
    await expect(response.text()).rejects.toThrow('Stream consumer is too slow');
    expect(socket.sent.at(-1)).toEqual({ type: 'cancel', id: '1' });
    socket.receive({ type: 'data', id: '2', text: 'still live' });
    socket.receive({ type: 'end', id: '2' });
    await expect((await second).text()).resolves.toBe('still live');
  });

  it('rejects new sends when the socket is backed up without closing active streams', async () => {
    const first = transport.fetch('http://localhost:3000/api/chats/one/stream');
    const socket = await openSocket();
    socket.receive({ type: 'headers', id: '1', status: 200 });
    socket.bufferedAmount = 9 * 1024 * 1024;
    await expect(transport.fetch('http://localhost:3000/api/chats/two/message', {
      method: 'POST', body: '{}',
    })).rejects.toThrow('Stream connection is busy');
    expect(socket.sent).toHaveLength(1);
    socket.receive({ type: 'end', id: '1' });
    await expect((await first).text()).resolves.toBe('');
  });

  it('waits for the capability probe before choosing a transport', async () => {
    let available!: (value: boolean) => void;
    configureStreamTransport('http://localhost:3000/api', new Promise((resolve) => { available = resolve; }));
    const pending = fetchStream('http://localhost:3000/api/chats/one/stream');
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    available(true);
    const socket = await openSocket();
    socket.receive({ type: 'headers', id: '1', status: 200 });
    socket.receive({ type: 'end', id: '1' });
    await expect((await pending).text()).resolves.toBe('');
  });

  it('keeps native HTTP compatibility for older gateways', async () => {
    configureStreamTransport('http://localhost:3000/api', Promise.resolve(false));
    const options = { method: 'POST', body: '{}' };
    await fetchStream('http://localhost:3000/api/chats/one/message', options);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/api/chats/one/message', options);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('acquires fresh credentials when hydration reconfigures the same gateway', async () => {
    configureStreamTransport('http://localhost:3000/api', Promise.resolve(true));
    const first = fetchStream('http://localhost:3000/api/chats/one/stream');
    const socket = await openSocket();
    socket.receive({ type: 'headers', id: '1', status: 200 });
    const rejected = expect((await first).text()).rejects.toThrow('Stream connection closed');
    configureStreamTransport('http://localhost:3000/api', Promise.resolve(true));
    await rejected;
    const second = fetchStream('http://localhost:3000/api/chats/two/stream');
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    const fresh = await openSocket();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fresh.receive({ type: 'headers', id: '1', status: 200 });
    fresh.receive({ type: 'end', id: '1' });
    await expect((await second).text()).resolves.toBe('');
  });
});
