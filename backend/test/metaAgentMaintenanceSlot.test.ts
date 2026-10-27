import assert from 'node:assert/strict';
import { test } from 'node:test';
import { META_AGENT_MAINTENANCE_TOOL_NAMES } from '../src/agents/maintenancePolicy';
import { buildMcpServerForSlot, McpSlotRegistry } from '../src/services/mcpServer';
import { createMaintenanceTools } from '../src/services/pages/maintenanceTools';
import type { MaintenanceExecutionContext } from '../src/agents/types';

const HOME_TOOLS = ['list_threads', 'read_node_overview', 'read_node', 'maintenance_read_workspace_home'];

function maintenanceSlot(context: MaintenanceExecutionContext | null) {
  return new McpSlotRegistry().create('node-1', '/tmp', 'local-user', {
    owner: { mode: 'interactive', key: 'node-1' },
    maintenance: true,
    exposedToolNames: new Set(META_AGENT_MAINTENANCE_TOOL_NAMES),
    getActiveMaintenanceExecutionContext: () => context,
    isServing: () => true,
    onSpawnBranches: async () => [], onSaveArtifact: () => null, onUpdateArtifact: () => null,
    onShowImage: () => ({ error: 'unused' }),
  }, { workspaceId: 'ws-1' });
}

test('the maintenance slot serves the whole Meta agent maintenance toolset and nothing else', async () => {
  const server = buildMcpServerForSlot(maintenanceSlot(null)) as any;
  const listed = await server.server._requestHandlers.get('tools/list')({ method: 'tools/list', params: {} }, { signal: new AbortController().signal });
  assert.deepEqual(listed.tools.map((tool: { name: string }) => tool.name).sort(), [...META_AGENT_MAINTENANCE_TOOL_NAMES].sort());
  const schemas = Object.fromEntries(listed.tools.map((tool: any) => [tool.name, tool.inputSchema]));
  assert.deepEqual(schemas.read_node.required, ['nodeId']);
  assert.equal(schemas.list_threads.properties.limit.maximum, 50);
  assert.equal(schemas.list_threads.properties.workspaceId, undefined, 'history stays inside the run\'s workspace');
  assert.equal(schemas.maintenance_read_workspace_home.properties.limit.maximum, 20);
});

test('history and workspace-home tools refuse a send without a home run', async () => {
  const incremental = { workspaceId: 'ws-1', ownerUserId: 'local-user', jobId: 'job', runId: 'run', claimedBy: 'x', configRevision: 1,
    planId: 'mpl-1', sources: [], execution: { nodeId: 'n', turnId: 't', assistantId: 'a', runId: 'run' } } as MaintenanceExecutionContext;
  for (const context of [null, incremental]) {
    const tools = (buildMcpServerForSlot(maintenanceSlot(context)) as any)._registeredTools as Record<string, { handler(args: unknown): Promise<any> }>;
    for (const name of HOME_TOOLS) {
      const result = await tools[name]!.handler({ nodeId: 'n' });
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text, /only available while the Meta agent writes a home page/, name);
    }
  }
  assert.deepEqual(createMaintenanceTools(incremental).slice(-4).map((tool) => tool.name), HOME_TOOLS);
});
