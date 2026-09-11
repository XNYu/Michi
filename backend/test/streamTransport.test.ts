import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { WebSocket } from 'ws';
import type { StreamTransportResponse } from 'michi-shared';
import { createStreamTransport } from '../src/services/streamTransport';

async function fixture(t: TestContext) {
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    if (req.headers.authorization !== 'Bearer fixture-token') return res.status(401).json({ error: 'unauthorized' });
    next();
  });
  const transport = createStreamTransport();
  app.use('/api', transport.router);
  const requests: Array<{ path: string; body: unknown; cookie: string | undefined }> = [];
  const active = new Set<string>();
  app.all('/api/*path', (req, res) => {
    requests.push({ path: req.originalUrl, body: req.body, cookie: req.headers.cookie });
    if (req.path.endsWith('/forbidden/stream')) return res.status(403).json({ error: 'wrong workspace owner' });
    if (req.path === '/api/control') return res.json({ ok: true });
    active.add(req.originalUrl);
    res.on('close', () => active.delete(req.originalUrl));
    if (req.path.endsWith('/pending/stream')) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    if (req.path.endsWith('/unicode/stream')) {
      const bytes = Buffer.from('event: chunk\ndata: {"text":"中文😀"}\n\n');
      res.write(bytes.subarray(0, 31));
      setImmediate(() => res.end(bytes.subarray(31)));
    } else res.write(': connected\n\n');
  });
  const server = app.listen(0, '127.0.0.1');
  transport.attach(server);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: 'Bearer fixture-token', origin: base, cookie: 'fixture=session' };
  t.after(async () => {
    transport.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const ticket = async () => {
    const response = await fetch(`${base}/api/stream-transport`, { method: 'POST', headers });
    assert.equal(response.status, 200);
    return (await response.json() as { token: string }).token;
  };
  const connect = async (token?: string) => {
    token ??= await ticket();
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/stream-transport?token=${token}`, { origin: base });
    const frames: StreamTransportResponse[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
    await once(socket, 'open');
    t.after(() => socket.terminate());
    return { socket, frames };
  };
  return { base, headers, ticket, connect, active, requests };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), 'condition did not become true');
}

test('multiplexes 24 streams and detaches one without cancelling other turns', async (t) => {
  const f = await fixture(t);
  const { socket, frames } = await f.connect();
  for (let i = 0; i < 24; i++) socket.send(JSON.stringify({ type: 'open', id: String(i), path: `/api/chats/n${i}/message`, method: 'POST', body: JSON.stringify({ text: 'hello', turnId: `turn-${i}` }) }));
  await until(() => frames.filter((frame) => frame.type === 'headers').length === 24);
  assert.equal(f.active.size, 24);
  assert.ok(f.requests.every((request) => request.cookie === 'fixture=session'));
  assert.deepEqual(f.requests[0].body, { text: 'hello', turnId: 'turn-0' });
  const response = await fetch(`${f.base}/api/control`, { headers: f.headers });
  assert.equal(response.status, 200);
  socket.send(JSON.stringify({ type: 'cancel', id: '0' }));
  await until(() => f.active.size === 23);
  assert.ok(!f.requests.some((request) => request.path.endsWith('/cancel')));
  socket.close();
  await until(() => f.active.size === 0);
});

test('forwards replay cursors and remote proxy paths without skipping route authorization', async (t) => {
  const f = await fixture(t);
  const { socket, frames } = await f.connect();
  const path = '/api/backend-connections/remote-1/proxy/chats/forbidden/stream?fromTurnId=T1&fromSeq=7';
  socket.send(JSON.stringify({ type: 'open', id: 'one', path, method: 'GET' }));
  await until(() => frames.some((frame) => frame.type === 'end'));
  assert.deepEqual(frames[0], { type: 'headers', id: 'one', status: 403 });
  assert.equal(f.requests[0].path, path);
  assert.match(frames.filter((frame) => frame.type === 'data').map((frame) => frame.text).join(''), /wrong workspace owner/);
});

test('keeps UTF-8 bytes intact across split upstream chunks', async (t) => {
  const f = await fixture(t);
  const { socket, frames } = await f.connect();
  socket.send(JSON.stringify({ type: 'open', id: 'one', path: '/api/chats/unicode/stream', method: 'GET' }));
  await until(() => frames.some((frame) => frame.type === 'end'));
  assert.equal(frames.filter((frame) => frame.type === 'data').map((frame) => frame.text).join(''), 'event: chunk\ndata: {"text":"中文😀"}\n\n');
});

test('rejects arbitrary URLs, non-stream routes and incorrect methods', async (t) => {
  const f = await fixture(t);
  const { socket, frames } = await f.connect();
  const paths = ['https://example.com/api/chats/n1/stream', '/api/workspaces', '/api/../../admin', '/api/chats/n1/cancel'];
  paths.forEach((path, i) => socket.send(JSON.stringify({ type: 'open', id: String(i), path, method: 'GET' })));
  socket.send(JSON.stringify({ type: 'open', id: 'bad-method', path: '/api/chats/n1/message', method: 'GET' }));
  await until(() => frames.length === 5);
  assert.ok(frames.every((frame) => frame.type === 'error'));
  assert.equal(f.requests.length, 0);
});

test('requires authenticated one-use tickets bound to the renderer origin', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.base}/api/stream-transport`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${f.base}/api/stream-transport`, { method: 'POST', headers: { ...f.headers, origin: 'https://untrusted.example' } })).status, 403);
  const token = await f.ticket();
  await f.connect(token);
  const reused = new WebSocket(`${f.base.replace('http:', 'ws:')}/api/stream-transport?token=${token}`, { origin: f.base });
  await assert.rejects(once(reused, 'open'), /403/);
  const wrongOrigin = new WebSocket(`${f.base.replace('http:', 'ws:')}/api/stream-transport?token=${await f.ticket()}`, { origin: 'https://untrusted.example' });
  await assert.rejects(once(wrongOrigin, 'open'), /403/);
});

test('cancellation while waiting for headers releases the upstream request', async (t) => {
  const f = await fixture(t);
  const { socket } = await f.connect();
  socket.send(JSON.stringify({ type: 'open', id: 'pending', path: '/api/chats/pending/stream', method: 'GET' }));
  await until(() => f.active.size === 1);
  socket.send(JSON.stringify({ type: 'cancel', id: 'pending' }));
  await until(() => f.active.size === 0);
});

test('excess streams receive 429 while control requests and existing streams stay usable', async (t) => {
  const f = await fixture(t);
  const { socket, frames } = await f.connect();
  for (let i = 0; i < 257; i++) {
    socket.send(JSON.stringify({ type: 'open', id: String(i), path: `/api/chats/n${i}/stream`, method: 'GET' }));
  }
  await until(() => frames.filter((frame) => frame.type === 'headers').length === 257);
  assert.equal(f.active.size, 256);
  assert.ok(frames.some((frame) => frame.type === 'headers' && frame.id === '256' && frame.status === 429));
  assert.equal((await fetch(`${f.base}/api/control`, { headers: f.headers })).status, 200);
  socket.send(JSON.stringify({ type: 'cancel', id: '0' }));
  await until(() => f.active.size === 255);
  socket.send(JSON.stringify({ type: 'open', id: 'retry', path: '/api/chats/retry/stream', method: 'GET' }));
  await until(() => frames.some((frame) => frame.type === 'headers' && frame.id === 'retry' && frame.status === 200));
});

test('expired tickets cannot open a socket', async (t) => {
  const f = await fixture(t);
  const token = await f.ticket();
  const expiredTime = Date.now() + 30_001;
  t.mock.method(Date, 'now', () => expiredTime);
  const expired = new WebSocket(`${f.base.replace('http:', 'ws:')}/api/stream-transport?token=${token}`, { origin: f.base });
  await assert.rejects(once(expired, 'open'), /403/);
});
