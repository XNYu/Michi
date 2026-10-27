/**
 * mountMcp end to end on the runtime package's MCP host, behind express.json
 * as in server.ts: a real MCP client calls a tool through /api/mcp/<slot> and
 * through the session group at /api/mcp-session/<group>, and the Codex Stop
 * Hook posts to /api/codex-hooks/<slot>/stop. Also covers the host's HTTP
 * gates as Michi mounts them.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpSlotProvider } from 'michi-runtime';
import { mcpSlotProviderInternals } from 'michi-runtime/internal/mcp-host/slotProviderInternals';
import * as dbRepository from '../src/services/dbRepository';
import { McpSlotRegistry, mountMcp } from '../src/services/mcpServer';
import { JSON_BODY_LIMIT_BYTES } from '../src/services/requestBodyLimit';

type CallResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const textOf = (result: CallResult) => result.content.map((part) => part.text ?? '').join('');

/**
 * An express app with express.json and mountMcp under /api, as server.ts
 * mounts them. `logged` records `${method} ${req.path}` at 'finish', where
 * server.ts's access log reads it. With spoofRemoteAddress, a request's
 * x-test-remote-address header stands in for its peer address.
 */
async function startMcpApp(t: TestContext, registry: McpSlotRegistry, options: { spoofRemoteAddress?: boolean } = {}) {
    const app = express();
    const logged: string[] = [];
    if (options.spoofRemoteAddress) {
        app.use((req, res, next) => {
            const spoofed = req.headers['x-test-remote-address'];
            if (typeof spoofed === 'string') {
                Object.defineProperty(req.socket, 'remoteAddress', { value: spoofed, configurable: true });
                // Back to the socket's own getter for the next request on this connection.
                res.on('finish', () => { delete (req.socket as { remoteAddress?: string }).remoteAddress; });
            }
            next();
        });
    }
    app.use((req, res, next) => {
        res.on('finish', () => logged.push(`${req.method} ${req.path}`));
        next();
    });
    app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));
    const router = express.Router();
    mountMcp(router, registry);
    app.use('/api', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const connect = async (route: string) => {
        const client = new Client({ name: 'michi-mount-e2e', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${route}`)));
        t.after(() => client.close());
        return client;
    };
    return { base, connect, logged };
}

test('mountMcp serves slot and session-group tool calls and the Codex Stop Hook through the package host', async (t) => {
    const registry = new McpSlotRegistry();
    const saved: Array<{ name: string; size: number }> = [];
    const slot = registry.create('chat-a', '/tmp', null, {
        onSpawnBranches: async () => [],
        onSaveArtifact: (name, body) => {
            saved.push({ name, size: body.length });
            return { name, filePath: `/tmp/${name}`, size: body.length };
        },
        onUpdateArtifact: () => null,
        onValidateFollowUps: () => ({ decision: 'block', reason: 'Call set_follow_ups first.' }),
    }, { nodeId: 'node-a' });
    const group = registry.createSessionGroup(slot);
    registry.bindSession(group, 'chat-a', slot.slotId);
    const endTurn = registry.beginSessionTurn(group, 'chat-a');
    t.after(endTurn);
    const { base, connect, logged } = await startMcpApp(t, registry);

    // /api/mcp/<slot>
    const direct = await connect(`/mcp/${slot.slotId}`);
    assert.deepEqual(direct.getServerVersion(), { name: 'michi-tools', version: '1.0.0' });
    assert.deepEqual(direct.getServerCapabilities(), { tools: {} });
    const viaSlot = await direct.callTool({ name: 'save_artifact', arguments: { name: 'direct', body: 'one' } }) as CallResult;
    assert.notEqual(viaSlot.isError, true, textOf(viaSlot));
    assert.equal(textOf(viaSlot), 'Saved artifact: @direct');
    // Arguments are validated against the tool's schema before the handler runs.
    const invalid = await direct.callTool({ name: 'save_artifact', arguments: { name: 'bad', body: 7 } }) as CallResult;
    assert.equal(invalid.isError, true);
    assert.match(textOf(invalid), /Input validation error: Invalid arguments for tool save_artifact/);
    // A body over the package default of 4 MB still fits Michi's 50 MB limit.
    const large = await direct.callTool({ name: 'save_artifact', arguments: { name: 'large', body: 'x'.repeat(5 * 1024 * 1024) } }) as CallResult;
    assert.equal(textOf(large), 'Saved artifact: @large');

    // /api/mcp-session/<group>
    const shared = await connect(`/mcp-session/${group}`);
    const viaGroup = await shared.callTool({ name: 'save_artifact', arguments: { session_id: 'chat-a', name: 'routed', body: 'two' } }) as CallResult;
    assert.notEqual(viaGroup.isError, true, textOf(viaGroup));
    assert.equal(textOf(viaGroup), 'Saved artifact: @routed');
    assert.deepEqual(saved, [{ name: 'direct', size: 3 }, { name: 'large', size: 5 * 1024 * 1024 }, { name: 'routed', size: 3 }]);

    // /api/codex-hooks/<slot>/stop
    const hook = async (slotId: string, body: unknown, headers: Record<string, string> = {}) => {
        const response = await fetch(`${base}/codex-hooks/${slotId}/stop`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    };
    assert.deepEqual(await hook(slot.slotId, { hook_event_name: 'Stop', stop_hook_active: false }),
        { status: 200, body: { decision: 'block', reason: 'Call set_follow_ups first.' } });
    assert.deepEqual(await hook(slot.slotId, { hook_event_name: 'PostToolUse' }), { status: 200, body: {} });
    assert.deepEqual(await hook('f'.repeat(32), { hook_event_name: 'Stop' }), { status: 200, body: {} },
        'an unknown slot still fails open with {}');
    assert.equal((await hook(slot.slotId, { hook_event_name: 'Stop' }, { origin: 'http://evil.example' })).status, 403);
    // Requests the host served keep their Express path for the access log.
    assert.ok(logged.includes(`POST /codex-hooks/${slot.slotId}/stop`), logged.join('\n'));
    assert.ok(logged.includes(`POST /mcp/${slot.slotId}`), logged.join('\n'));
    assert.ok(logged.includes(`POST /mcp-session/${group}`), logged.join('\n'));
    assert.ok(!logged.some((line) => line.includes('/mcp-hooks/')), logged.join('\n'));

    // The host's gates and method rules on the MCP routes.
    const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
    for (const route of [`/mcp/${slot.slotId}`, `/mcp-session/${group}`]) {
        const gated: Array<Record<string, string>> = [
            { origin: 'http://evil.example' }, { 'x-forwarded-for': '203.0.113.7' }, { forwarded: 'for=203.0.113.7' },
            { 'x-real-ip': '203.0.113.7' }, { via: '1.1 proxy.example' }, { 'x-forwarded-host': 'michi.example' },
            { 'x-forwarded-proto': 'https' },
        ];
        for (const headers of gated) {
            const response = await fetch(`${base}${route}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
                body: initialize,
            });
            assert.equal(response.status, 403, `${route} ${JSON.stringify(headers)}`);
            await response.body?.cancel();
        }
        for (const method of ['GET', 'DELETE']) {
            const response = await fetch(`${base}${route}`, { method, headers: { accept: 'text/event-stream' } });
            assert.equal(response.status, 405, `${method} ${route}`);
            assert.equal(response.headers.get('allow'), 'POST');
            await response.body?.cancel();
        }
    }
    // The session group's catalog copy cannot be reached as a slot of its own.
    const catalogSlotId = mcpSlotProviderInternals((registry as unknown as {
        provider: McpSlotProvider;
    }).provider).sessionGroupCatalog(group)!.slotId;
    const catalogCopy = await fetch(`${base}/mcp/${catalogSlotId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save_artifact', arguments: { name: 'copy', body: 'x' } } }),
    });
    assert.equal(catalogCopy.status, 404);
    assert.deepEqual(await catalogCopy.json(), { error: 'unknown mcp slot' });
    assert.equal(saved.length, 3, 'nothing ran through the catalog copy');
    const unknown = await fetch(`${base}/mcp/unknown-slot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: initialize });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: 'unknown mcp slot' });
});

test('a tool catalog that fails to build fails tools/list instead of serving an empty catalog', async (t) => {
    const registry = new McpSlotRegistry();
    const slot = registry.create('chat-b', '/tmp', null, {
        onSpawnBranches: async () => [], onSaveArtifact: () => null, onUpdateArtifact: () => null,
    }, { nodeId: 'node-b' });
    // The catalog reads the slot's node binding from SQLite on every request.
    t.mock.method(dbRepository, 'getNodeSessionBinding', () => { throw new Error('SQLITE_BUSY: database is locked'); });
    const { base, connect } = await startMcpApp(t, registry);

    const client = await connect(`/mcp/${slot.slotId}`);
    await assert.rejects(client.listTools(), /tool catalog unavailable/);
    const raw = await fetch(`${base}/mcp/${slot.slotId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    assert.equal(raw.status, 500);
    assert.deepEqual(await raw.json(), { jsonrpc: '2.0', error: { code: -32603, message: 'tool catalog unavailable' }, id: 3 });
    const call = await client.callTool({ name: 'save_artifact', arguments: { name: 'x', body: 'y' } }) as CallResult;
    assert.equal(call.isError, true);
    assert.equal(textOf(call), 'tool catalog unavailable');
});

test('a Codex Stop Hook request from a non-loopback peer is refused, for an unknown slot too', async (t) => {
    const registry = new McpSlotRegistry();
    const slot = registry.create('chat-c', '/tmp', null, {
        onSpawnBranches: async () => [], onSaveArtifact: () => null, onUpdateArtifact: () => null,
        onValidateFollowUps: () => ({ decision: 'block', reason: 'Call set_follow_ups first.' }),
    }, { nodeId: 'node-c' });
    const { base } = await startMcpApp(t, registry, { spoofRemoteAddress: true });
    const hook = async (slotId: string, remote?: string) => {
        const response = await fetch(`${base}/codex-hooks/${slotId}/stop`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(remote ? { 'x-test-remote-address': remote } : {}) },
            body: JSON.stringify({ hook_event_name: 'Stop' }),
        });
        return { status: response.status, body: await response.json() };
    };
    const unknownSlot = 'f'.repeat(32);
    for (const remote of ['10.0.0.5', '::ffff:192.168.1.2']) {
        assert.deepEqual(await hook(unknownSlot, remote), { status: 403, body: {} }, remote);
        assert.equal((await hook(slot.slotId, remote)).status, 403, remote);
    }
    // From loopback an unknown slot still fails open, and a known one validates.
    assert.deepEqual(await hook(unknownSlot), { status: 200, body: {} });
    assert.deepEqual(await hook(slot.slotId), { status: 200, body: { decision: 'block', reason: 'Call set_follow_ups first.' } });
});
