import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpSlotRegistry, mountMcp, type McpSlotCallbacks } from '../src/services/mcpServer';

test('shared MCP endpoint routes explicit SessionIDs, keeps warm catalog stable, and rejects inactive bindings', async () => {
    const registry = new McpSlotRegistry();
    const calls: Array<{ session: string; name: string; body: string }> = [];
    const overviews: Array<{ session: string; overview: string }> = [];
    const notifications: Array<{ session: string; name: string; result: unknown }> = [];
    const agentCalls: Array<{ session: string; args: Record<string, unknown> }> = [];
    const callbacks = (session: string): McpSlotCallbacks => ({
        onSpawnBranches: async () => [],
        onMcpToolResult: (name, result) => {
            notifications.push({ session, name, result });
            if (session === 'B') throw new Error('UI callback unavailable');
        },
        onSaveArtifact: (name, body) => {
            calls.push({ session, name, body });
            return { name, filePath: `${session}/${name}`, size: body.length };
        },
        onUpdateArtifact: () => null,
        onShowImage: () => ({ error: 'unsupported' }),
        onSetBranchOverview: overview => { overviews.push({ session, overview }); },
        agentRuns: { invoke: async (_name, args) => {
            agentCalls.push({ session, args });
            return { session };
        } },
    });
    const catalog = registry.create('__pending__', '/tmp', null, callbacks('warm'));
    const group = registry.createSessionGroup(catalog);
    const a = registry.create('A', '/tmp', null, callbacks('A'), { nodeId: 'node-a' });
    const b = registry.create('B', '/tmp', null, callbacks('B'), { nodeId: 'node-b' });
    registry.bindSession(group, 'A', a.slotId);
    registry.bindSession(group, 'B', b.slotId);
    const endA = registry.beginSessionTurn(group, 'A');
    const endB = registry.beginSessionTurn(group, 'B');
    const app = express(); app.use(express.json());
    const router = express.Router(); mountMcp(router, registry); app.use('/api', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const client = new Client({ name: 'michi-anchor-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp-session/${group}`,
    )));
    const save = (sid: string, name: string) => client.callTool({ name: 'save_artifact',
        arguments: { session_id: sid, name, body: `from-${sid}` } });
    try {
        const initial = await client.listTools();
        assert.ok(initial.tools.length > 5);
        for (const tool of initial.tools) {
            assert.ok(tool.inputSchema.required?.includes('session_id'), `${tool.name} must require session_id`);
            assert.equal((tool.inputSchema.properties?.session_id as any)?.type, 'string');
        }
        await save('A', 'before-warm');
        await save('B', 'from-b');
        registry.create('__pending__', '/tmp', null, callbacks('unused-W'));
        assert.deepEqual(await client.listTools(), initial, 'unused warm slot must not change the shared catalog');
        await save('A', 'after-warm');
        await Promise.all(Array.from({ length: 12 }, (_, i) => save(i % 2 ? 'B' : 'A', `parallel-${i}`)));
        assert.equal(calls.length, 15);
        await new Promise<void>(resolve => setImmediate(resolve));
        const saved = notifications.filter(item => item.name === 'save_artifact');
        assert.equal(saved.length, 15, 'each routed result reaches its own UI callback once');
        assert.deepEqual(saved.map(item => item.session).sort(), calls.map(item => item.session).sort());
        assert.ok(saved.every(item => (item.result as { isError?: boolean }).isError !== true),
            'a UI notification failure must not change the tool response');
        assert.ok(calls.every(call => call.body === `from-${call.session}`));
        assert.deepEqual(calls.slice(0, 3).map(call => call.session), ['A', 'B', 'A']);
        await client.callTool({ name: 'set_branch_overview', arguments: { session_id: 'B', overview: 'B journal' } });
        assert.deepEqual(overviews, [{ session: 'B', overview: 'B journal' }]);
        await client.callTool({ name: 'list_agents', arguments: { session_id: 'A' } });
        await client.callTool({ name: 'list_agents', arguments: { session_id: 'B' } });
        assert.deepEqual(agentCalls, [{ session: 'A', args: {} }, { session: 'B', args: {} }],
            'orchestration calls must use the chosen slot invoker and strip the routing field');
        const n = calls.length;
        for (const sid of ['', 'unused-W', 'unknown', '__pending__']) await assert.rejects(save(sid, 'rejected'));
        await assert.rejects(client.callTool({ name: 'save_artifact', arguments: { name: 'missing-id', body: 'x' } }));
        assert.equal(calls.length, n);
        endA();
        await assert.rejects(save('A', 'after-turn'));
        await save('B', 'peer-still-active');
        const endOld = registry.beginSessionTurn(group, 'A');
        const endNew = registry.beginSessionTurn(group, 'A');
        endOld();
        await save('A', 'new-turn-survives-old-finally');
        endNew();
        await assert.rejects(save('A', 'old-turn-finished'));
        registry.beginSessionTurn(group, 'A');
        registry.endSessionTurn(group, 'A');
        await assert.rejects(save('A', 'cancelled'));
        registry.beginSessionTurn(group, 'A');
        await registry.dispose(a.slotId);
        await assert.rejects(save('A', 'released'));
        await save('B', 'release-preserves-peer');
        const foreign = registry.create('C', '/tmp', null, callbacks('C'), { nodeId: 'node-c' });
        const otherGroup = registry.createSessionGroup(foreign);
        registry.bindSession(otherGroup, 'C', foreign.slotId);
        registry.beginSessionTurn(otherGroup, 'C');
        await assert.rejects(save('C', 'wrong-group'));
        b.exposedToolNames = new Set(['set_branch_overview']);
        const denied = await save('B', 'hidden-tool');
        assert.equal(denied.isError, true, 'each target retains its own exposed-tool gate');
        registry.disposeSessionGroup(group);
        await assert.rejects(save('B', 'disposed-group'));
    } finally {
        endA(); endB();
        await client.close(); server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
