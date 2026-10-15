import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { CrewEventStream } from '../src/agents/crew/acp/gatewayEvents';

async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 1500;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('Expected socket event was not received');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
async function fixture(t: TestContext, refuse?: (attempt: number) => number | undefined) {
    const server = http.createServer();
    const wss = new WebSocketServer({ noServer: true });
    const sockets: WebSocket[] = [];
    const requests: http.IncomingMessage[] = [];
    server.on('upgrade', (req, socket, head) => {
        requests.push(req);
        const code = refuse?.(requests.length);
        if (code) { socket.end(`HTTP/1.1 ${code} Refused\r\nContent-Length: 0\r\n\r\n`); return; }
        wss.handleUpgrade(req, socket, head, (ws) => { sockets.push(ws); });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let refresh = 0;
    const stream = new CrewEventStream({
        url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws`,
        cookie: async () => `mc_token_test=token-${refresh}`,
        invalidate: () => { refresh++; }, connectMs: 100, retryMs: 10,
    });
    t.after(async () => {
        stream.close();
        for (const ws of sockets) ws.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const send = (ws: WebSocket, type: string, data: unknown) => ws.send(JSON.stringify({ type, data }));
    return { stream, sockets, requests, send, refresh: () => refresh };
}

test('waits for registration, shares one cookie-authenticated socket and routes only exact slots', async (t) => {
    const f = await fixture(t);
    const a: any[] = [], b: any[] = [];
    let ready = false;
    const pa = f.stream.subscribe('a', (event) => a.push(event)).then((stop) => { ready = true; return stop; });
    const pb = f.stream.subscribe('b', (event) => b.push(event));
    await until(() => f.sockets.length === 1);
    assert.equal(ready, false);
    f.send(f.sockets[0], 'slots', []);
    const [stopA, stopB] = await Promise.all([pa, pb]);
    assert.equal(f.requests[0].headers.cookie, 'mc_token_test=token-0');
    assert.equal(f.requests[0].headers.origin, undefined);
    assert.equal(f.requests[0].url, '/api/ws');
    f.sockets[0].send('bad json');
    f.send(f.sockets[0], 'tool_call', { slot: 'a', tool_call_id: 'one' });
    f.send(f.sockets[0], 'slot_title', { key: 'b', title: 'B' });
    f.send(f.sockets[0], 'tool_result', { slot: 'c', tool_call_id: 'secret' });
    f.send(f.sockets[0], 'context_usage', { slot: 'a', pct: 22 });
    f.send(f.sockets[0], 'todo_update', { slot: 'a', todo: { tasks: [] } });
    f.send(f.sockets[0], 'context_usage', { slot: 'c', pct: 90 });
    await until(() => a.length === 4 && b.length === 2);
    assert.deepEqual(a.map((e) => e.type), ['reconnected', 'tool_call', 'context_usage', 'todo_update']);
    assert.deepEqual(b.map((e) => e.type), ['reconnected', 'slot_title']);
    stopA();
    assert.equal(f.sockets[0].readyState, WebSocket.OPEN);
    stopB();
    await until(() => f.sockets[0].readyState === WebSocket.CLOSED);
});

test('reconnects after a dropped socket and tells each active turn to reconcile', async (t) => {
    const f = await fixture(t);
    const events: any[] = [];
    const ready = f.stream.subscribe('a', (event) => events.push(event));
    await until(() => f.sockets.length === 1);
    f.send(f.sockets[0], 'slots', []);
    await ready;
    f.sockets[0].terminate();
    await until(() => f.sockets.length === 2);
    f.send(f.sockets[1], 'dashboard', {});
    await until(() => events.length === 2);
    assert.deepEqual(events.map((e) => e.type), ['reconnected', 'reconnected']);
});

test('expired authentication refreshes once; plain forbidden responses do not retry', async (t) => {
    const f = await fixture(t, (attempt) => attempt === 1 ? 401 : undefined);
    const events: any[] = [];
    await f.stream.subscribe('a', (event) => events.push(event));
    await until(() => f.sockets.length === 1);
    f.send(f.sockets[0], 'slots', []);
    await until(() => events.length === 1);
    assert.equal(f.refresh(), 1);
    assert.equal(f.requests[1].headers.cookie, 'mc_token_test=token-1');
    const forbidden = await fixture(t, () => 403);
    await forbidden.stream.subscribe('a', () => {});
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(forbidden.requests.length, 1);
});

test('disabled app close and repeated authentication refusal stop reconnecting', async (t) => {
    const f = await fixture(t);
    const ready = f.stream.subscribe('a', () => {});
    await until(() => f.sockets.length === 1);
    f.send(f.sockets[0], 'slots', []);
    await ready;
    f.sockets[0].close(1008, 'disabled');
    await until(() => f.sockets[0].readyState === WebSocket.CLOSED);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(f.requests.length, 1);
    const refused = await fixture(t, () => 401);
    await refused.stream.subscribe('a', () => {});
    await until(() => refused.requests.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(refused.requests.length, 2);
});

test('missing registration snapshot falls back within the connection deadline', async (t) => {
    const f = await fixture(t);
    const started = Date.now();
    const stop = await f.stream.subscribe('a', () => {});
    assert.ok(Date.now() - started < 1000);
    assert.equal(f.requests.length, 1);
    stop();
});
