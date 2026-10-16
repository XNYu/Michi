import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServerForSlot, McpSlotRegistry } from '../src/services/mcpServer';
import { BuiltinAgentCapabilitySource } from '../src/services/agentCapabilityCatalog';
import { resolveChatPolicy } from '../src/agents/permissionPolicy';

function slot(names: string[]) {
    return new McpSlotRegistry().create('docs-test', '/tmp', null, {
        exposedToolNames: new Set(names), onSpawnBranches: async () => [],
        onSaveArtifact: () => null, onUpdateArtifact: () => null,
        onShowImage: () => ({ error: 'unavailable' }),
    });
}

test('MCP discovers read-only docs and reads them through validated, session-anchored protocol', async t => {
    const server = buildMcpServerForSlot(slot(['michi_docs']), 'session-a');
    const client = new Client({ name: 'docs-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close(); await server.close(); });
    await server.connect(a); await client.connect(b);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['michi_docs']);
    assert.equal(tools[0].annotations?.readOnlyHint, true);
    assert.ok(tools[0].inputSchema.required?.includes('session_id'));
    const read = await client.callTool({ name: 'michi_docs', arguments: { action: 'read', docId: 'permissions', session_id: 'session-a' } });
    assert.notEqual(read.isError, true);
    assert.match(JSON.stringify(read), /Trust this tool/);
    for (const args of [
        { action: 'list', session_id: 'session-b' }, { action: 'list' },
        { action: 'write', session_id: 'session-a' },
        { action: 'read', docId: '../../config.json', session_id: 'session-a' },
    ]) {
        const result = await client.callTool({ name: 'michi_docs', arguments: args });
        assert.equal(result.isError, true);
    }
});

test('docs obey the MCP capability allowlist and remain read-only under ordinary Ask policy', async t => {
    const server = buildMcpServerForSlot(slot(['read_node']));
    const client = new Client({ name: 'docs-denied-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close(); await server.close(); });
    await server.connect(a); await client.connect(b);
    assert.equal((await client.listTools()).tools.some(tool => tool.name === 'michi_docs'), false);
    assert.equal((await client.callTool({ name: 'michi_docs', arguments: {} })).isError, true);
    assert.equal(resolveChatPolicy({ kind: 'chat_node', nodeId: 'docs-test' }, null, 'michi_docs', false, 'ask'), 'allow');
    const capability = new BuiltinAgentCapabilitySource().list({ ownerUserId: 'docs-test', workspaceId: null })
        .find(tool => tool.id === 'michi_docs');
    assert.equal(capability?.readiness, 'ready');
});
