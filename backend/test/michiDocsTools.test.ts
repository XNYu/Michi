import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServerForSlot, McpSlotRegistry } from '../src/services/mcpServer';

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
