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
import { CrewMcpBindings, resolveCrewMcpEndpoint, validateMichiEndpoint } from '../src/agents/crew/crewMcpBinding';
import { createCrewMcpRelay } from '../src/agents/crew/crewMcpRelay';
import { buildMcpServerForSlot, McpSlotRegistry } from '../src/services/mcpServer';

const caller = (slot: string) => ({ 'kirocrew.caller': { schemaVersion: 1, sessionKey: `dashboard:${slot}` } });
const serverConfig = (url: string) => [{ name: 'michi', type: 'http', url, headers: [] }];

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
    const app = express(); app.use(express.json());
    app.post('/api/mcp/:slot', async (req, res) => {
        const native = new McpServer({ name: 'test', version: '1' });
        native.registerTool('identify', { description: 'Identify exact test endpoint', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: req.params.slot }] }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { void transport.close(); void native.close(); });
        await native.connect(transport); await transport.handleRequest(req, res, req.body);
    });
    const http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
    const port = (http.address() as AddressInfo).port;
    await bindings.bind('one', serverConfig(`http://127.0.0.1:${port}/api/mcp/one`));
    await bindings.bind('two', serverConfig(`http://127.0.0.1:${port}/api/mcp/two`));
    const relay = createCrewMcpRelay(dir);
    const client = new Client({ name: 'official-broker-fixture', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await relay.connect(a); await client.connect(b);
    t.after(async () => { await client.close(); await relay.close(); await bindings.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await fs.rm(dir, { recursive: true, force: true }); });
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['michi_list_tools', 'michi_call_tool']);
    const discover = await client.callTool({ name: 'michi_list_tools', arguments: {}, _meta: caller('one') });
    assert.match(JSON.stringify(discover), /identify/);
    const results = await Promise.all(['one', 'two'].map(slot => client.callTool({ name: 'michi_call_tool', arguments: { tool: 'identify', arguments: {} }, _meta: caller(slot) })));
    assert.deepEqual(results.map(result => result.content), [ [{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }] ]);
    const denied = await client.callTool({ name: 'michi_call_tool', arguments: { tool: 'identify', arguments: {}, sessionKey: 'dashboard:one' } });
    assert.equal(denied.isError, true);
    assert.doesNotMatch(JSON.stringify(denied), /127\.0\.0\.1|api\/mcp/);
});

test('Crew discovers and reads real bundled Michi docs through the bound MCP relay', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crew-docs-'));
    const bindings = new CrewMcpBindings(dir);
    const slot = new McpSlotRegistry().create('crew-docs', dir, null, {
        exposedToolNames: new Set(['michi_docs']), onSpawnBranches: async () => [],
        onSaveArtifact: () => null, onUpdateArtifact: () => null,
        onShowImage: () => ({ error: 'unavailable' }),
    });
    const app = express(); app.use(express.json());
    app.post('/api/mcp/docs', async (req, res) => {
        const native = buildMcpServerForSlot(slot);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { void transport.close(); void native.close(); });
        await native.connect(transport); await transport.handleRequest(req, res, req.body);
    });
    const http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
    await bindings.bind('docs', serverConfig(`http://127.0.0.1:${(http.address() as AddressInfo).port}/api/mcp/docs`));
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
