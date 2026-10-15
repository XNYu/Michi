import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CrewMcpBindings } from '../src/agents/crew/crewMcpBinding';
import manifest from '../../crew-app/app.json';

const python = process.env.MICHI_CREW_TEST_PYTHON || 'python3';
const pythonCheck = spawnSync(python, ['--version'], { encoding: 'utf8' });
const root = path.resolve(__dirname, '../..');

test('production manifest launches stdio MCP from default home with spaces and no Node PATH, and updates the same connection',
    { skip: pythonCheck.status !== 0, timeout: 30000 }, async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'crew default account with spaces '));
    const install = path.join(home, '.michi');
    const dist = path.join(install, 'backend/dist');
    await fs.mkdir(dist, { recursive: true });
    await fs.cp(path.join(root, 'crew-app'), path.join(install, 'crew-app'), { recursive: true, filter: p => !p.includes('__pycache__') });
    // The normal backend suite builds shared, not dist. Bundle current source so
    // this check never tests a stale build or changes the checkout's dist.
    const { build } = await import('esbuild');
    for (const [source, output] of [['crewMcpMain.ts', 'crewMcp.js'], ['crewMcpHost.ts', 'crewMcpHost.js']]) {
        await build({ entryPoints: [path.join(root, 'backend/src/agents/crew', source)], outfile: path.join(dist, output),
            bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['node:*'], logLevel: 'silent' });
    }
    await fs.writeFile(path.join(dist, 'crew-node.json'), JSON.stringify({ schemaVersion: 1, node: process.execPath }));
    const bindings = new CrewMcpBindings(path.join(install, 'crew-mcp'));
    const app = express(); app.use(express.json());
    app.post('/api/mcp/:slot', async (req, res) => {
        const server = new McpServer({ name: 'real-http-fixture', version: '1' });
        server.registerTool('identify', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: req.params.slot }] }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { void transport.close(); void server.close(); });
        await server.connect(transport); await transport.handleRequest(req, res, req.body);
    });
    const http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
    const port = (http.address() as AddressInfo).port;
    await bindings.bind('stdio-one', [{ name: 'michi', url: `http://127.0.0.1:${port}/api/mcp/one`, headers: [] }]);
    await bindings.bind('stdio-two', [{ name: 'michi', url: `http://127.0.0.1:${port}/api/mcp/two`, headers: [] }]);
    // Resolve Python before removing PATH, exactly as Crew's bridge does.
    const absolutePython = spawnSync(python, ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    for (const key of ['MICHI_CREW_INSTALL_DIR', 'MICHI_CREW_MCP_DIR', 'MICHI_CREW_NODE']) delete env[key];
    const transport = new StdioClientTransport({ command: absolutePython, args: manifest.mcpServers.michi.args,
        env: { ...env, HOME: home, PATH: '' }, stderr: 'pipe' });
    const client = new Client({ name: 'official-caller-fixture', version: '1' });
    let stderr = '';
    t.after(async () => {
        await client.close(); await bindings.close(); http.closeAllConnections();
        await new Promise<void>(resolve => http.close(() => resolve()));
        await fs.rm(home, { recursive: true, force: true });
    });
    await client.connect(transport);
    transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['michi_list_tools', 'michi_call_tool']);
    const call = (slot: string) => client.callTool({ name: 'michi_call_tool', arguments: { tool: 'identify', arguments: {} },
        _meta: { 'kirocrew.caller': { schemaVersion: 1, sessionKey: `dashboard:stdio-${slot}` } } });
    const results = await Promise.all(['one', 'two'].map(call));
    assert.deepEqual(results.map(result => result.content), [[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]]);
    const denied = await client.callTool({ name: 'michi_list_tools' });
    assert.equal(denied.isError, true);
    const pid = transport.pid;
    assert.ok(pid);
    const relay = path.join(dist, 'crewMcp.js');
    const generation = (value: string, delay = 0) => `exports.CREW_MCP_HANDLER_API=1;exports.createCrewMcpHandlers=()=>({
        listTools:async()=>({tools:[{name:'probe',inputSchema:{type:'object'}}]}),
        callTool:async()=>{await new Promise(r=>setTimeout(r,${delay}));return {content:[{type:'text',text:${JSON.stringify(value)}}]}}});`;
    await fs.writeFile(relay, generation('old', 200));
    const old = client.callTool({ name: 'probe' });
    // listTools confirms the host captured the old generation before replacement.
    await client.listTools();
    await fs.writeFile(relay + '.next', generation('new'));
    await fs.rename(relay + '.next', relay);
    const current = await client.callTool({ name: 'probe' });
    assert.deepEqual(current.content, [{ type: 'text', text: 'new' }], stderr);
    assert.deepEqual((await old).content, [{ type: 'text', text: 'old' }]);
    await fs.unlink(relay);
    assert.deepEqual((await client.callTool({ name: 'probe' })).content, current.content);
    await fs.writeFile(relay, 'invalid incomplete(');
    assert.deepEqual((await client.callTool({ name: 'probe' })).content, current.content);
    await fs.writeFile(relay, generation('recovered'));
    assert.deepEqual((await client.callTool({ name: 'probe' })).content, [{ type: 'text', text: 'recovered' }]);
    assert.equal(transport.pid, pid, 'Update must not restart approved transport');
    assert.equal(stderr, '');
});
