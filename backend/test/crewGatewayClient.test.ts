import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { CrewGatewayClient, createCrewGateway } from '../src/agents/crew/acp/gatewayClient';
import { CrewGatewayError, type CrewChatEvent, type CrewGatewayConfig } from '../src/agents/crew/acp/gatewayTypes';
import { CREW_APP_VERSION } from '../src/agents/crew/crewAppVersion';

const APP = 'michi-crew-runtime';
const BANNED = /timed out|response stream|connection reset|ECONNRESET/i;

test('MCP readiness rereads the configured App and Stub route without Gateway calls', async (t) => {
    const home = tempHome(t, null);
    const dir = path.join(home, 'apps', APP);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ version: CREW_APP_VERSION, mcpServers: { michi: {} } }));
    fs.writeFileSync(path.join(dir, 'installed.json'), JSON.stringify({ enabled: true }));
    const client = new CrewGatewayClient({ baseUrl: 'http://127.0.0.1:5476', appName: APP, kirocrewHome: home });
    assert.equal(await client.mcpAvailable(), false);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ mcp_gateway: { stub_servers: [`${APP}:michi`] } }));
    assert.equal(await client.mcpAvailable(), true);
    fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ version: '0.4.0', mcpServers: { michi: {} } }));
    assert.equal(await client.mcpAvailable(), false, 'Existing sessions also reject an outdated App');
    fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ version: CREW_APP_VERSION, mcpServers: { michi: {} } }));
    assert.equal(await client.mcpAvailable(), true);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ mcp_gateway: { stub_servers: [`${APP}:michi`], stub_overrides: { [`${APP}:michi`]: false } } }));
    assert.equal(await client.mcpAvailable(), false);
});

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

interface RecordedRequest {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
}

async function stubGateway(t: TestContext, handler: Handler) {
    const requests: RecordedRequest[] = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
            handler(req, res, body);
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    t.after(() => new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
    }));
    return { port, baseUrl: `http://127.0.0.1:${port}`, requests };
}

function tempHome(t: TestContext, secret: string | null): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-gw-test-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    if (secret !== null) {
        fs.mkdirSync(path.join(home, 'apps', APP), { recursive: true });
        fs.writeFileSync(path.join(home, 'apps', APP, '.app_secret'), `${secret}\n`, { mode: 0o600 });
    }
    return home;
}

function json(res: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(value));
}

/** Answers the token exchange with tok-1, tok-2, ... and delegates the rest. */
function withTokens(handler: Handler): { handler: Handler; exchanges: () => number } {
    let count = 0;
    return {
        exchanges: () => count,
        handler: (req, res, body) => {
            if (req.url === `/api/apps/${APP}/token`) {
                count += 1;
                return json(res, 200, { token: `tok-${count}` });
            }
            handler(req, res, body);
        },
    };
}

function config(t: TestContext, baseUrl: string, extra: Partial<CrewGatewayConfig> = {}): CrewGatewayConfig {
    return { baseUrl, appName: APP, kirocrewHome: tempHome(t, 's3cret'), ...extra };
}

async function collect(stream: AsyncIterable<CrewChatEvent>): Promise<CrewChatEvent[]> {
    const items: CrewChatEvent[] = [];
    for await (const item of stream) items.push(item);
    return items;
}

function frameTypes(items: CrewChatEvent[]): string[] {
    return items.map((item) => (item.kind === 'frame' ? item.frame.type : 'receipt'));
}

test('Gateway catalog filters members, settings filter foreign Apps, and fork uses a stable message id', async (t) => {
    const tokens = withTokens((req, res) => {
        if (req.url === '/api/agents/catalog') return json(res, 200, { agents: [
            { name: 'private', selection_kind: 'member' }, { name: 'code', selection_kind: 'template' },
        ] });
        if (req.url === '/api/chat/slots') return json(res, 200, [
            { key: 'own', app: APP }, { key: 'foreign', app: 'other' }, { key: 'human', app: '' },
        ]);
        if (req.url?.endsWith('/fork')) return json(res, 200, { key: 'child' });
        if (req.url?.includes('?limit=')) return json(res, 200, { key: 'own', messages: [] });
        return json(res, 200, {});
    });
    const gw = await stubGateway(t, tokens.handler);
    const client = new CrewGatewayClient(config(t, gw.baseUrl));
    assert.deepEqual(await client.listAgents('own'), [{ id: 'code', name: 'code' }]);
    assert.equal(gw.requests.at(-1)?.headers['x-session-key'], 'dashboard:own');
    assert.deepEqual(await client.listSlots(), [{ key: 'own', app: APP }]);
    await client.setAgent('own', 'code');
    assert.deepEqual(JSON.parse(gw.requests.at(-1)!.body), { agent: 'code', agent_kind: 'template' });
    assert.equal((await client.forkSlot('own', 'mid-17')).key, 'child');
    assert.deepEqual(JSON.parse(gw.requests.at(-1)!.body), { at_message_id: 'mid-17', direction: 'head' });
    await client.getSlot('own', 500, 1200);
    assert.equal(gw.requests.at(-1)?.url, '/api/chat/slots/own?limit=500&before=1200');
});

test('exchanges the secret, then sends only the port-keyed cookie with no Origin', async (t) => {
    const tokens = withTokens((req, res) => {
        if (req.url === '/api/chat/slots') return json(res, 200, { key: 'michi-1', name: 'michi-1' });
        json(res, 404, { error: 'not found' });
    });
    const gw = await stubGateway(t, tokens.handler);
    const client = createCrewGateway(config(t, gw.baseUrl));

    const slot = await client.createSlot({ name: 'michi-1' });

    assert.equal(slot.key, 'michi-1');
    const [exchange, create] = gw.requests;
    assert.equal(exchange.method, 'POST');
    assert.equal(exchange.url, `/api/apps/${APP}/token`);
    assert.equal(exchange.headers['x-app-secret'], 's3cret');
    assert.equal(create.headers.cookie, `mc_token_${gw.port}=tok-1`);
    assert.equal(create.headers['x-app-secret'], undefined);
    for (const request of gw.requests) {
        assert.equal(request.headers.origin, undefined);
        assert.doesNotMatch(request.url, /token=/);
    }
});

test('streamChat parses SSE split across chunks, skips keepalives, and stops at [DONE]', async (t) => {
    const tokens = withTokens((req, res) => {
        if (req.url !== '/api/chat') return json(res, 404, {});
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': keepalive\n\n');
        res.write('data: {"type":"ch');
        setTimeout(() => {
            res.write('unk","content":"he"}\r\n\r\n');
            res.write('data: not-json\n\n');
            res.write('data: {"type":"tool","content":"Read file\\nmore","ts":"t1","cls":"tool"}\n');
            res.write('\n: keepalive\n\ndata: [DO');
            setTimeout(() => res.write('NE]\n\n'), 5);
            // Deliberately left open: the client must stop at [DONE], not at EOF.
        }, 10);
    });
    const gw = await stubGateway(t, tokens.handler);
    const client = createCrewGateway(config(t, gw.baseUrl));

    const items = await collect(client.streamChat('michi 1', 'hello', new AbortController().signal));

    assert.deepEqual(frameTypes(items), ['chunk', 'tool']);
    assert.deepEqual(items[1], {
        kind: 'frame',
        frame: { type: 'tool', content: 'Read file\nmore', ts: 't1', cls: 'tool' },
    });
    const chat = gw.requests.at(-1)!;
    assert.equal(chat.url, '/api/chat');
    assert.deepEqual(JSON.parse(chat.body), { message: 'hello', slot: 'michi 1' });
    assert.equal(chat.headers.cookie, `mc_token_${gw.port}=tok-1`);
});

test('a 403 marked X-Auth-Required re-exchanges once and replays the request', async (t) => {
    let calls = 0;
    const tokens = withTokens((req, res) => {
        calls += 1;
        if (calls === 1) return json(res, 403, { error: 'invalid token', code: 'forbidden' }, { 'X-Auth-Required': 'true' });
        json(res, 200, { key: 'michi-1' });
    });
    const gw = await stubGateway(t, tokens.handler);
    const client = createCrewGateway(config(t, gw.baseUrl));

    await client.createSlot({ name: 'michi-1' });

    assert.equal(tokens.exchanges(), 2);
    assert.equal(calls, 2);
    assert.equal(gw.requests.at(-1)?.headers.cookie, `mc_token_${gw.port}=tok-2`);
});

test('a missing app secret says the app is not installed without leaking anything', async (t) => {
    const gw = await stubGateway(t, (_req, res) => json(res, 500, {}));
    const client = createCrewGateway({ baseUrl: gw.baseUrl, appName: APP, kirocrewHome: tempHome(t, null) });

    await assert.rejects(client.listModels(), (error: unknown) => {
        assert.ok(error instanceof CrewGatewayError);
        assert.match(error.message, /not installed/);
        assert.match(error.message, new RegExp(APP));
        return true;
    });
    assert.equal(gw.requests.length, 0);
});

test('the constructor refuses a non-loopback gateway', () => {
    for (const baseUrl of ['http://gateway.example.com:5476', 'https://10.0.0.5:5476', 'http://127.0.0.2:5476', 'ftp://127.0.0.1']) {
        assert.throws(
            () => createCrewGateway({ baseUrl, appName: APP, kirocrewHome: '/nonexistent' }),
            CrewGatewayError,
            baseUrl,
        );
    }
    for (const baseUrl of ['http://127.0.0.1:5476', 'http://localhost:5476', 'http://[::1]:5476']) {
        assert.doesNotThrow(() => createCrewGateway({ baseUrl, appName: APP, kirocrewHome: '/nonexistent' }), baseUrl);
    }
});

test('the cookie port defaults to the scheme port', () => {
    const plain = new CrewGatewayClient({ baseUrl: 'http://localhost', appName: APP, kirocrewHome: '/x' });
    const tls = new CrewGatewayClient({ baseUrl: 'https://localhost/', appName: APP, kirocrewHome: '/x' });
    assert.equal((plain as unknown as { cookieName: string }).cookieName, 'mc_token_80');
    assert.equal((tls as unknown as { cookieName: string }).cookieName, 'mc_token_443');
});

test('a 403 whose body says token expired also re-exchanges once', async (t) => {
    let calls = 0;
    const tokens = withTokens((_req, res) => {
        calls += 1;
        if (calls === 1) return json(res, 403, { error: 'token expired' });
        json(res, 200, [{ model_name: 'auto' }]);
    });
    const gw = await stubGateway(t, tokens.handler);
    const client = createCrewGateway(config(t, gw.baseUrl));

    assert.deepEqual(await client.listModels(), [{ modelId: 'auto', name: 'auto' }]);
    assert.equal(tokens.exchanges(), 2);
});

test('auth refusals retry exactly once, and an ordinary 403 is not retried', async (t) => {
    const tokens = withTokens((req, res) => {
        if (req.url?.endsWith('/project')) return json(res, 403, { error: 'Access denied' });
        json(res, 401, { error: 'unauthorized', code: 'unauthorized' });
    });
    const gw = await stubGateway(t, tokens.handler);
    const client = createCrewGateway(config(t, gw.baseUrl));

    await assert.rejects(client.setModel('s1', 'auto'), (error: unknown) => {
        assert.ok(error instanceof CrewGatewayError);
        assert.equal(error.status, 401);
        assert.equal(error.code, 'unauthorized');
        return true;
    });
    assert.equal(tokens.exchanges(), 2);
    assert.equal(gw.requests.filter((r) => r.url.endsWith('/model')).length, 2);

    await assert.rejects(client.setProject('s1', '/etc'), (error: unknown) => {
        assert.ok(error instanceof CrewGatewayError);
        assert.equal(error.status, 403);
        assert.match(error.message, /Access denied/);
        return true;
    });
    assert.equal(tokens.exchanges(), 2);
    assert.equal(gw.requests.filter((r) => r.url.endsWith('/project')).length, 1);
});

test('the token is re-exchanged once it is 50 minutes old', async (t) => {
    let clock = 1_000_000;
    const tokens = withTokens((_req, res) => json(res, 200, {}));
    const gw = await stubGateway(t, tokens.handler);
    const client = new CrewGatewayClient(config(t, gw.baseUrl), { now: () => clock });

    await client.stop('s1');
    clock += 49 * 60 * 1000;
    await client.stop('s1');
    assert.equal(tokens.exchanges(), 1);
    clock += 60 * 1000;
    await client.stop('s1');
    assert.equal(tokens.exchanges(), 2);
    assert.equal(gw.requests.at(-1)?.headers.cookie, `mc_token_${gw.port}=tok-2`);
});

test('concurrent first requests share one token exchange', async (t) => {
    const tokens = withTokens((_req, res) => json(res, 200, {}));
    const gw = await stubGateway(t, tokens.handler);
    const client = createCrewGateway(config(t, gw.baseUrl));

    await Promise.all([client.stop('a'), client.stop('b'), client.stop('c')]);

    assert.equal(tokens.exchanges(), 1);
});

test('createSlot omits absent fields and falls back to the configured agent', async (t) => {
    const tokens = withTokens((_req, res, body) => json(res, 200, { key: JSON.parse(body).name }));
    const gw = await stubGateway(t, tokens.handler);
    const bare = createCrewGateway(config(t, gw.baseUrl));
    const withAgent = createCrewGateway(config(t, gw.baseUrl, { agent: 'kirocrew' }));

    await bare.createSlot({ name: 's1', agent: undefined, model: undefined });
    await bare.createSlot({ name: 's2', model: 'claude-sonnet-4.5' });
    await withAgent.createSlot({ name: 's3' });
    await withAgent.createSlot({ name: 's4', agent: 'other' });
    await bare.createSlot({ name: 's5', memory_mode: 'incognito' });

    const bodies = gw.requests.filter((r) => r.url === '/api/chat/slots').map((r) => JSON.parse(r.body));
    assert.deepEqual(bodies, [
        { name: 's1' },
        { name: 's2', model: 'claude-sonnet-4.5' },
        { name: 's3', agent: 'kirocrew' },
        { name: 's4', agent: 'other' },
        { name: 's5', memory_mode: 'incognito' },
    ]);
});

test('slot calls use encoded paths and the documented bodies', async (t) => {
    const tokens = withTokens((req, res) => {
        if (req.url?.startsWith('/api/chat/slots/gone')) return json(res, 404, { error: 'not found' });
        if (req.url?.startsWith('/api/chat/slots/broken')) return json(res, 500, { error: 'boom', code: 'internal' });
        json(res, 200, { ok: true });
    });
    const gw = await stubGateway(t, tokens.handler);
    const client = createCrewGateway(config(t, gw.baseUrl));

    assert.equal(await client.slotExists('a/b c'), true);
    assert.equal(await client.slotExists('gone'), false);
    await assert.rejects(client.slotExists('broken'), (error: unknown) => {
        assert.ok(error instanceof CrewGatewayError);
        assert.equal(error.status, 500);
        assert.equal(error.code, 'internal');
        return true;
    });
    await client.setProject('a/b c', '/tmp/project');
    await client.setModel('a/b c', 'auto');
    await client.setReasoningEffort('a/b c', 'high');
    await client.stop('a/b c');
    await client.deleteSlot('a/b c');

    const calls = gw.requests.slice(1).map((r) => [r.method, r.url, r.body ? JSON.parse(r.body) : null]);
    assert.deepEqual(calls, [
        ['GET', '/api/chat/slots/a%2Fb%20c?limit=1', null],
        ['GET', '/api/chat/slots/gone?limit=1', null],
        ['GET', '/api/chat/slots/broken?limit=1', null],
        ['POST', '/api/chat/slots/a%2Fb%20c/project', { project: '/tmp/project' }],
        ['POST', '/api/chat/slots/a%2Fb%20c/model', { model: 'auto' }],
        ['POST', '/api/chat/slots/a%2Fb%20c/reasoning-effort', { reasoning_effort: 'high' }],
        ['POST', '/api/chat/slots/a%2Fb%20c/stop', null],
        ['DELETE', '/api/chat/slots/a%2Fb%20c', null],
    ]);
});

test('waitUntilIdle polls slot state until running becomes false and stops when aborted', async (t) => {
    let reads = 0;
    const tokens = withTokens((req, res) => {
        if (req.url === '/api/chat/slots/a%2Fb?limit=1') {
            reads += 1;
            return json(res, 200, { running: reads < 3 });
        }
        if (req.url === '/api/chat/slots/forever?limit=1') return json(res, 200, { running: true });
        json(res, 404, {});
    });
    const gw = await stubGateway(t, tokens.handler);
    const client = createCrewGateway(config(t, gw.baseUrl));

    await client.waitUntilIdle('a/b', new AbortController().signal);
    assert.equal(reads, 3);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);
    await client.waitUntilIdle('forever', controller.signal);
    assert.ok(gw.requests.some((request) => request.url === '/api/chat/slots/forever?limit=1'));
});

test('listModels maps Gateway rows to CrewModel', async (t) => {
    const tokens = withTokens((_req, res) => json(res, 200, [
        { model_name: 'auto', display_name: 'Auto', description: 'Backend default', context_window: 200000 },
        { model_name: 'claude-sonnet-4.5', model_id: 'CLAUDE_SONNET_4_5', description: '' },
        { display_name: 'no id' },
        'garbage',
    ]));
    const gw = await stubGateway(t, tokens.handler);
    const client = createCrewGateway(config(t, gw.baseUrl));

    assert.deepEqual(await client.listModels(), [
        { modelId: 'auto', name: 'Auto', description: 'Backend default' },
        { modelId: 'claude-sonnet-4.5', name: 'claude-sonnet-4.5' },
    ]);
    assert.equal(gw.requests.at(-1)?.url, '/api/models');
});

test('streamChat yields one receipt when the Gateway answers JSON', async (t) => {
    const tokens = withTokens((_req, res) => json(res, 200, { ok: true, queued: true, queue_id: 'q1' }));
    const gw = await stubGateway(t, tokens.handler);
    const client = createCrewGateway(config(t, gw.baseUrl));

    const items = await collect(client.streamChat('s1', 'hello', new AbortController().signal));

    assert.deepEqual(items, [{ kind: 'receipt', receipt: { ok: true, queued: true, queue_id: 'q1' } }]);
});

test('streamChat throws when the stream closes before [DONE]', async (t) => {
    const tokens = withTokens((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: {"type":"chunk","content":"partial"}\n\n');
    });
    const gw = await stubGateway(t, tokens.handler);
    const client = createCrewGateway(config(t, gw.baseUrl));
    const items: CrewChatEvent[] = [];

    await assert.rejects(async () => {
        for await (const item of client.streamChat('s1', 'hello', new AbortController().signal)) items.push(item);
    }, (error: unknown) => {
        assert.ok(error instanceof CrewGatewayError);
        assert.match(error.message, /before \[DONE\]/);
        return true;
    });
    assert.deepEqual(frameTypes(items), ['chunk']);
});

test('streamChat throws with status and code on a non-2xx answer', async (t) => {
    const tokens = withTokens((_req, res) => json(res, 409, { error: 'slot busy', code: 'slot_busy' }));
    const gw = await stubGateway(t, tokens.handler);
    const client = createCrewGateway(config(t, gw.baseUrl));

    await assert.rejects(collect(client.streamChat('s1', 'hello', new AbortController().signal)), (error: unknown) => {
        assert.ok(error instanceof CrewGatewayError);
        assert.equal(error.status, 409);
        assert.equal(error.code, 'slot_busy');
        return true;
    });
});

test('aborting streamChat mid-stream ends iteration quietly', async (t) => {
    const tokens = withTokens((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"chunk","content":"first"}\n\n');
        // Never finishes: only the abort can end the turn.
    });
    const gw = await stubGateway(t, tokens.handler);
    const client = createCrewGateway(config(t, gw.baseUrl));
    const controller = new AbortController();
    const items: CrewChatEvent[] = [];

    for await (const item of client.streamChat('s1', 'hello', controller.signal)) {
        items.push(item);
        setTimeout(() => controller.abort(), 10);
    }

    assert.deepEqual(frameTypes(items), ['chunk']);
});

test('aborting before the Gateway answers ends iteration quietly', async (t) => {
    const tokens = withTokens(() => undefined);
    const gw = await stubGateway(t, tokens.handler);
    const client = createCrewGateway(config(t, gw.baseUrl));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    assert.deepEqual(await collect(client.streamChat('s1', 'hello', controller.signal)), []);
});

test('error messages never carry phrases Michi reads as process death', async (t) => {
    const tokens = withTokens((req, res) => {
        if (req.url === '/api/models') return json(res, 503, { error: 'model list timed out' });
        if (req.url?.endsWith('/stop')) return undefined; // never answers
        if (req.url === '/api/chat') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: {"type":"chunk","content":"x"}\n\n');
            setTimeout(() => res.socket?.destroy(), 10);
            return undefined;
        }
        res.socket?.destroy();
    });
    const gw = await stubGateway(t, tokens.handler);
    const client = createCrewGateway(config(t, gw.baseUrl, { requestTimeoutMs: 100 }));
    const messages: string[] = [];
    const capture = async (run: () => Promise<unknown>) => {
        await assert.rejects(run(), (error: unknown) => {
            assert.ok(error instanceof CrewGatewayError, String(error));
            messages.push(error.message);
            return true;
        });
    };

    await capture(() => client.listModels());
    await capture(() => client.stop('s1'));
    await capture(() => client.setModel('s1', 'auto'));
    await capture(() => collect(client.streamChat('s1', 'hello', new AbortController().signal)));
    const closed = http.createServer().listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const refused = createCrewGateway({ baseUrl: `http://127.0.0.1:${closedPort}`, appName: APP, kirocrewHome: tempHome(t, 'x') });
    await capture(() => refused.stop('s1'));

    assert.equal(messages.length, 5);
    for (const message of messages) assert.doesNotMatch(message, BANNED, message);
    assert.match(messages[0], /\(HTTP 503\): model list took too long/);
    assert.match(messages[1], /no answer to POST \/api\/chat\/slots\/s1\/stop within 100 ms/);
    assert.match(messages[2], /network error/);
    assert.match(messages[3], /broke before \[DONE\]/);
    assert.match(messages[4], /nothing is listening/);
});

test('official approval route refuses foreign slots and rechecks the live card', async (t) => {
    let mid = 'card-1';
    const gw = await stubGateway(t, withTokens((req, res) => {
        if (req.url === '/api/chat/slots') return json(res, 200, [{ key: 'own', app: APP, pending_approval: true, pending_approval_info: { request_id: '7' } }]);
        if (req.method === 'GET') return json(res, 200, { key: 'own', running: true, messages: [
            { role: 'permission', content: 'write', cls: JSON.stringify({ request_id: '7', tool_input: 'probe.txt' }), meta: { mid } },
        ] });
        return json(res, 200, { ok: true });
    }).handler);
    const client = new CrewGatewayClient(config(t, gw.baseUrl));
    await assert.rejects(client.prepareApprovals('foreign'), /not owned/);
    await client.prepareApprovals('own');
    assert.deepEqual(JSON.parse(gw.requests.at(-1)!.body), { slot: 'own', mode: 'normal' });
    const [request] = await client.pendingApprovals('own');
    await client.approve('own', request, false);
    assert.equal(gw.requests.at(-1)?.url, '/api/chat/slots/own/approve');
    assert.deepEqual(JSON.parse(gw.requests.at(-1)!.body), { request_id: '7', action: 'rejected' });
    mid = 'card-2';
    const posts = () => gw.requests.filter(r => r.url.endsWith('/approve')).length;
    await client.approve('own', request, true);
    assert.equal(posts(), 1, 'a recycled native ID cannot reuse a stale card');
    assert.equal(gw.requests.some(r => r.url.includes('/app-runtime')), false);
});

test('App-tagged linked and remote sessions cannot enter the approval scope', async (t) => {
    const gw = await stubGateway(t, withTokens((_req, res) => json(res, 200, [
        { key: 'own', app: APP, linked_session_key: 'dashboard:own', executor: 'local' },
        { key: 'linked', app: APP, linked_session_key: 'dashboard:user-chat' },
        { key: 'remote', app: APP, instance_id: 'another-crew' },
        { key: 'executor', app: APP, executor: 'remote' },
        { key: 'foreign', app: 'another-app' },
    ])).handler);
    const client = new CrewGatewayClient(config(t, gw.baseUrl));
    assert.deepEqual((await client.listSlots()).map(row => row.key), ['own']);
    for (const slot of ['linked', 'remote', 'executor', 'foreign']) {
        await assert.rejects(client.prepareApprovals(slot), /not owned/);
    }
    assert.equal(gw.requests.some(req => req.method === 'POST' && req.url === '/api/chat/mode'), false);
});

test('official permission cards without meta.mid use their timestamp and native tool identity', async (t) => {
    let ts = '2026-10-07T20:20:31.141305+00:00';
    const gw = await stubGateway(t, withTokens((req, res) => {
        if (req.url === '/api/chat/slots') return json(res, 200, [{ key: 'own', app: APP, pending_approval: true, pending_approval_info: { request_id: 'uuid' } }]);
        if (req.method === 'GET') return json(res, 200, { running: true, messages: [{ role: 'permission', ts,
            cls: JSON.stringify({ request_id: 'uuid', tool_call_id: 'tool-1', tool_title: 'Write', tool_name: 'fs_write' }), meta: { approval_id: 'uuid' } }] });
        return json(res, 200, { ok: true });
    }).handler);
    const client = new CrewGatewayClient(config(t, gw.baseUrl));
    const [request] = await client.pendingApprovals('own');
    assert.equal(request.tool, 'Write');
    assert.equal(request.tool_name, 'fs_write');
    await client.approve('own', request, true);
    assert.equal(gw.requests.filter(r => r.url.endsWith('/approve')).length, 1);
    ts = '2026-10-07T20:21:31.141305+00:00';
    await client.approve('own', request, true);
    assert.equal(gw.requests.filter(r => r.url.endsWith('/approve')).length, 1, 'a new transcript card is never substituted');
});
