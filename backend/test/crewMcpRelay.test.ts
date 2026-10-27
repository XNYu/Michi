import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CrewMcpBindings, resolveCrewMcpEndpoint, validateMichiEndpoint } from 'michi-runtime/internal/adapters/crew/crewMcpBinding';
import { createCrewMcpRelay } from 'michi-runtime/internal/adapters/crew/crewMcpRelay';
import { McpSlotRegistry, mountMcp } from '../src/services/mcpServer';

const caller = (slot: string) => ({ 'kirocrew.caller': { schemaVersion: 1, sessionKey: `dashboard:${slot}` } });
const serverConfig = (url: string) => [{ name: 'michi', type: 'http', url, headers: [] }];

/** Michi's real MCP routes (mountMcp on the package host), mounted as server.ts mounts them. */
async function startMichiMcp(registry: McpSlotRegistry) {
    const app = express(); app.use(express.json());
    const router = express.Router(); mountMcp(router, registry); app.use('/api', router);
    const http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
    return { http, base: `http://127.0.0.1:${(http.address() as AddressInfo).port}/api` };
}

test('MCP bindings isolate forks and refuse missing, unknown and stale identities', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crew-bindings-'));
    const first = new CrewMcpBindings(dir), resumed = new CrewMcpBindings(dir);
    t.after(async () => { await first.close(); await resumed.close(); await fs.rm(dir, { recursive: true, force: true }); });
    const release = await first.bind('parent', serverConfig('http://127.0.0.1:3000/api/mcp/first'));
    await first.bind('child', serverConfig('http://127.0.0.1:3000/api/mcp/child'));
    assert.match(await resolveCrewMcpEndpoint(caller('parent'), dir), /first$/);
    assert.match(await resolveCrewMcpEndpoint(caller('child'), dir), /child$/);
    await assert.rejects(resolveCrewMcpEndpoint(undefined, dir));
    await assert.rejects(resolveCrewMcpEndpoint(caller('other'), dir));
    assert.throws(() => validateMichiEndpoint('https://example.com/api/mcp/secret'));
    assert.throws(() => validateMichiEndpoint('http://127.0.0.1:3000/api/admin'));
    await resumed.bind('parent', serverConfig('http://127.0.0.1:3000/api/mcp/resumed'));
    await release();
    assert.match(await resolveCrewMcpEndpoint(caller('parent'), dir), /resumed$/);
    await resumed.close();
    await assert.rejects(resolveCrewMcpEndpoint(caller('parent'), dir));
});

test('official caller metadata routes concurrent MCP calls to their exact endpoint', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crew-relay-'));
    const bindings = new CrewMcpBindings(dir);
    // Two real Michi slots whose save_artifact answers name the slot that ran it.
    const registry = new McpSlotRegistry();
    const slotFor = (tag: string) => registry.create(`crew-${tag}`, dir, null, {
        exposedToolNames: new Set(['save_artifact']), onSpawnBranches: async () => [],
        onSaveArtifact: (name) => ({ name: `${tag}:${name}`, filePath: `${dir}/${name}`, size: 1 }),
        onUpdateArtifact: () => null,
    });
    const slots = { one: slotFor('one'), two: slotFor('two') };
    const { http, base } = await startMichiMcp(registry);
    await bindings.bind('one', serverConfig(`${base}/mcp/${slots.one.slotId}`));
    await bindings.bind('two', serverConfig(`${base}/mcp/${slots.two.slotId}`));
    const relay = createCrewMcpRelay(dir);
    const client = new Client({ name: 'official-broker-fixture', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await relay.connect(a); await client.connect(b);
    t.after(async () => { await client.close(); await relay.close(); await bindings.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await fs.rm(dir, { recursive: true, force: true }); });
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['michi_list_tools', 'michi_call_tool']);
    const discover = await client.callTool({ name: 'michi_list_tools', arguments: {}, _meta: caller('one') });
    assert.match(JSON.stringify(discover), /save_artifact/);
    const save = { tool: 'save_artifact', arguments: { name: 'probe', body: 'x' } };
    const results = await Promise.all(['one', 'two'].map(slot => client.callTool({ name: 'michi_call_tool', arguments: save, _meta: caller(slot) })));
    assert.deepEqual(results.map(result => result.content), [
        [{ type: 'text', text: 'Saved artifact: @one:probe' }], [{ type: 'text', text: 'Saved artifact: @two:probe' }],
    ]);
    const denied = await client.callTool({ name: 'michi_call_tool', arguments: { ...save, sessionKey: 'dashboard:one' } });
    assert.equal(denied.isError, true);
    assert.doesNotMatch(JSON.stringify(denied), /127\.0\.0\.1|api\/mcp/);
});

test('Crew discovers and reads real bundled Michi docs through the bound MCP relay', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crew-docs-'));
    const bindings = new CrewMcpBindings(dir);
    const registry = new McpSlotRegistry();
    const slot = registry.create('crew-docs', dir, null, {
        exposedToolNames: new Set(['michi_docs']), onSpawnBranches: async () => [],
        onSaveArtifact: () => null, onUpdateArtifact: () => null,
        onShowImage: () => ({ error: 'unavailable' }),
    });
    const { http, base } = await startMichiMcp(registry);
    await bindings.bind('docs', serverConfig(`${base}/mcp/${slot.slotId}`));
    const relay = createCrewMcpRelay(dir);
    const client = new Client({ name: 'crew-docs-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    t.after(async () => {
        await client.close(); await relay.close(); await bindings.close(); http.closeAllConnections();
        await new Promise<void>(resolve => http.close(() => resolve())); await fs.rm(dir, { recursive: true, force: true });
    });
    await relay.connect(a); await client.connect(b);
    assert.match(JSON.stringify((await client.listTools()).tools), /michi_docs/);
    const discovered = await client.callTool({ name: 'michi_list_tools', arguments: {}, _meta: caller('docs') });
    assert.match(JSON.stringify(discovered), /michi_docs/);
    const result = await client.callTool({ name: 'michi_call_tool',
        arguments: { tool: 'michi_docs', arguments: { action: 'read', docId: 'crew', startLine: 105, limit: 20 } }, _meta: caller('docs') });
    assert.notEqual(result.isError, true);
    assert.match(JSON.stringify(result), /Use global permissions/);
    const denied = await client.callTool({ name: 'michi_call_tool',
        arguments: { tool: 'michi_docs', arguments: { action: 'list' } }, _meta: caller('unbound') });
    assert.equal(denied.isError, true);
});

test('Crew real HTTP handshake observes request cancellation and closes its connection', async t => {
    const { createCrewMcpHandlers } = await import('michi-runtime/internal/adapters/crew/crewMcpRelay');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crew-cancelled-handshake-'));
    const bindings = new CrewMcpBindings(dir);
    const app = express(); app.use(express.json());
    let started!: () => void, disconnected!: () => void;
    const connected = new Promise<void>(resolve => { started = resolve; });
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    app.post('/api/mcp/cancel', (_req, res) => { res.on('close', disconnected); started(); });
    const http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
    await bindings.bind('cancel', serverConfig(`http://127.0.0.1:${(http.address() as AddressInfo).port}/api/mcp/cancel`));
    t.after(async () => { await bindings.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await fs.rm(dir, { recursive: true, force: true }); });
    const signal = new AbortController();
    const work = createCrewMcpHandlers(dir).callTool({ method: 'tools/call', params: { name: 'michi_list_tools', arguments: {}, _meta: caller('cancel') } }, signal.signal);
    const rejected = assert.rejects(work, { name: 'AbortError' });
    await connected; signal.abort(); await rejected;
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('HTTP handshake was not disconnected')), 1000))]);
});

test('Crew setup deadline bounds a real unresponsive HTTP MCP initialize', async t => {
    const { createCrewMcpHandlers } = await import('michi-runtime/internal/adapters/crew/crewMcpRelay');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crew-deadline-'));
    const bindings = new CrewMcpBindings(dir);
    const app = express(); app.use(express.json());
    let calls = 0;
    app.post('/api/mcp/deadline', (_req, _res) => { calls++; });
    const http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
    await bindings.bind('deadline', serverConfig(`http://127.0.0.1:${(http.address() as AddressInfo).port}/api/mcp/deadline`));
    t.after(async () => { await bindings.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await fs.rm(dir, { recursive: true, force: true }); });
    const start = Date.now();
    const result = await createCrewMcpHandlers(dir, { setupTimeoutMs: 500 }).callTool({ method: 'tools/call', params: { name: 'michi_list_tools', arguments: {}, _meta: caller('deadline') } }, new AbortController().signal);
    assert.equal(result.isError, true); assert.equal(calls, 1);
    assert.match(JSON.stringify(result), /Michi connection/); assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|api\/mcp/);
    assert.ok(Date.now() - start < 2000, 'initialize deadline must finish without SDK default timeout');
});

test('Crew bounds a hanging SDK close after a real HTTP tool round trip', async t => {
    const { createCrewMcpHandlers } = await import('michi-runtime/internal/adapters/crew/crewMcpRelay');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crew-close-deadline-'));
    const bindings = new CrewMcpBindings(dir);
    const app = express(); app.use(express.json());
    app.post('/api/mcp/close', async (req, res) => {
        const native = new McpServer({ name: 'close-fixture', version: '1' });
        native.registerTool('identify', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'closed-fixture' }] }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { void transport.close(); void native.close(); });
        await native.connect(transport); await transport.handleRequest(req, res, req.body);
    });
    const http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
    await bindings.bind('close', serverConfig(`http://127.0.0.1:${(http.address() as AddressInfo).port}/api/mcp/close`));
    t.after(async () => { await bindings.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await fs.rm(dir, { recursive: true, force: true }); });
    // Only cleanup is made unresponsive; discovery uses the actual SDK/HTTP transport.
    t.mock.method(Client.prototype, 'close', async () => new Promise<void>(() => {}));
    const start = Date.now();
    const result = await createCrewMcpHandlers(dir, { cleanupTimeoutMs: 50 }).callTool({ method: 'tools/call', params: { name: 'michi_list_tools', arguments: {}, _meta: caller('close') } }, new AbortController().signal);
    assert.notEqual(result.isError, true); assert.match(JSON.stringify(result), /identify/);
    assert.ok(Date.now() - start < 2000, 'unresponsive close must not hold the broker request');
});
