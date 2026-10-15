import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as repository from '../src/services/dbRepository';
import { openUrlTool } from '../src/agents/openUrlTool';
import { urlOpenRequests } from '../src/services/urlOpenRequests';
import { buildMcpServerForSlot } from '../src/services/mcpServer';
const original = { getWorkspace: repository.getWorkspace, getNode: repository.getNode, getNodeSessionBinding: repository.getNodeSessionBinding };
const oldCloud = process.env.MICHI_CLOUD;
const scope = { workspaceId: 'w', treeId: 't', ownerUserId: 'alice' };
beforeEach(() => {
  process.env.MICHI_CLOUD = '1';
  Object.assign(repository, {
    getWorkspace: (id: string, owner: string) => id === 'w' && owner === 'alice' ? { id: 'w' } : null,
    getNode: (id: string) => ({ id, workspace_id: id === 'n' ? 'w' : 'other', tree_id: 't' }),
    getNodeSessionBinding: () => ({ nodeId: 'n', workspaceId: 'w' }),
  });
});
afterEach(() => {
  Object.assign(repository, original);
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  while (urlOpenRequests.claim(scope)) { /* Drain test requests. */ }
});
describe('open_url session binding', () => {
  it('uses the session node tree and rejects another owner or workspace', () => {
    openUrlTool({ ...scope, nodeId: 'n' }, 'https://example.com');
    assert.equal(urlOpenRequests.claim(scope)?.url, 'https://example.com/');
    assert.throws(() => openUrlTool({ ...scope, ownerUserId: 'bob', nodeId: 'n' }, 'https://example.com'));
    assert.throws(() => openUrlTool({ ...scope, nodeId: 'foreign' }, 'https://example.com'));
    assert.throws(() => openUrlTool({ ...scope, ownerUserId: null }, 'https://example.com'));
  });
  it('MCP resolves the bound node and ignores model-supplied owner overrides', async () => {
    const slot = { slotId: 'slot', nodeId: 'n', workspaceId: null, ownerUserId: 'alice', parentChatId: 'runtime', cwd: '/tmp', exposedToolNames: new Set(['open_url']) };
    const server = buildMcpServerForSlot(slot as any);
    const tool = (server as any)._registeredTools.open_url;
    assert.ok(tool);
    await tool.handler({ url: 'https://example.com/mcp', workspaceId: 'other', ownerUserId: 'bob' });
    assert.equal(urlOpenRequests.claim(scope)?.url, 'https://example.com/mcp');
    await server.close();
  });
});
