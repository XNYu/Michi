import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeSpawnPolicy } from '../src/assistant/policy';
import { maintenancePromptPrefix, maintenanceRuntimeAvailability, maintenanceToolProfile, MAINTENANCE_TOOL_NAMES, MAINTENANCE_BOOTSTRAP_INSTRUCTIONS } from '../src/agents/maintenancePolicy';
import { claudeInitCatalog } from 'michi-runtime/internal/adapters/claude/claudeMcpConfig';
import { checkMetaAgentToolCatalog } from '../src/agents/metaAgentGuard';
import { buildMcpServerForSlot, McpSlotRegistry } from '../src/services/mcpServer';
import { PAGE_BLOCK_CATALOG, PAGE_BLOCK_TYPES } from 'michi-shared';

describe('scheduled maintenance runtime isolation', () => {
  test('maintenance bootstrap treats one successful resource write as final, including proposals', () => {
    assert.match(MAINTENANCE_BOOTSTRAP_INSTRUCTIONS, /one final atomic write call/);
    assert.match(MAINTENANCE_BOOTSTRAP_INSTRUCTIONS, /result\.proposed/);
    assert.match(MAINTENANCE_BOOTSTRAP_INSTRUCTIONS, /do not call the writer again or record no-change/);
    assert.match(MAINTENANCE_BOOTSTRAP_INSTRUCTIONS, /Only an exact retry/);
    assert.match(MAINTENANCE_BOOTSTRAP_INSTRUCTIONS, /updating a matching existing block or row over inserting a duplicate/);
  });

  test('availability is an explicit allow-list and Claude cannot start native tools or inherit user MCP/settings', () => {
    for (const runtime of ['pi', 'claude', 'codex', 'kiro']) {
      assert.deepEqual(maintenanceRuntimeAvailability(runtime), { available: true }, runtime);
    }
    for (const runtime of ['crew', 'unknown']) {
      assert.equal(maintenanceRuntimeAvailability(runtime).available, false, runtime);
      assert.ok(maintenanceRuntimeAvailability(runtime).reason);
    }
    assert.match(maintenanceRuntimeAvailability('crew').reason ?? '', /Kiro Crew/);

    const policy = claudeSpawnPolicy({ ownerMode: 'interactive', permissionMode: 'yolo', toolProfile: maintenanceToolProfile() });
    assert.equal(policy.permissionMode, 'default');
    assert.deepEqual(policy.tools, []);
    assert.equal(policy.strictMcpConfig, true);
    assert.equal(policy.isolateSettings, true);
    assert.equal(policy.restrictedMode, true);
    const safeInit = { tools: MAINTENANCE_TOOL_NAMES.map((name) => `mcp____michi_internal____${name}`),
      mcp_servers: [{ name: '__michi_internal__' }], permissionMode: 'default' };
    const check = (envelope: Record<string, unknown>) => checkMetaAgentToolCatalog({
      runtimeId: 'claude', toolset: 'maintenance', allowed: maintenanceToolProfile().allowedToolNames ?? [], observed: claudeInitCatalog(envelope),
    });
    assert.equal(check(safeInit), null);
    const widened = { ...safeInit, tools: [...safeInit.tools, 'Bash', 'mcp__user__search'] };
    assert.deepEqual(check(widened)?.unexpectedTools, ['native:Bash', 'native:mcp__user__search']);
  });

  test('Claude MCP maintenance slots expose only the dedicated catalog and refuse calls without an active send', async () => {
    const registry = new McpSlotRegistry();
    const slot = registry.create('node-1', '/tmp', 'alice', {
      owner: { mode: 'interactive', key: 'node-1' },
      maintenance: true,
      exposedToolNames: new Set(MAINTENANCE_TOOL_NAMES),
      getActiveMaintenanceExecutionContext: () => null,
      isServing: () => true,
      onSpawnBranches: async () => [], onSaveArtifact: () => null, onUpdateArtifact: () => null,
      onShowImage: () => ({ error: 'unused' }),
    });
    const tools = (buildMcpServerForSlot(slot) as any)._registeredTools as Record<string, { handler(args: unknown): Promise<any> }>;
    assert.deepEqual(Object.keys(tools).sort(), [...MAINTENANCE_TOOL_NAMES].sort());
    const result = await tools.maintenance_read_source.handler({ sourceTurnId: 'source-1' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No active maintenance send/);
  });

  test('maintenance MCP catalog preserves operation unions, nullable values, dynamic columns, and bounds', async () => {
    const slot = new McpSlotRegistry().create('node-1', '/tmp', 'alice', {
      owner: { mode: 'interactive', key: 'node-1' },
      maintenance: true,
      exposedToolNames: new Set(MAINTENANCE_TOOL_NAMES),
      getActiveMaintenanceExecutionContext: () => null,
      onSpawnBranches: async () => [], onSaveArtifact: () => null, onUpdateArtifact: () => null,
      onShowImage: () => ({ error: 'unused' }),
    }, { workspaceId: 'ws-1' });
    const mcpServer = buildMcpServerForSlot(slot) as any;
    const tools = mcpServer._registeredTools;
    const listed = await mcpServer.server._requestHandlers.get('tools/list')({ method: 'tools/list', params: {} }, { signal: new AbortController().signal });
    const emitted = Object.fromEntries(listed.tools.map((tool: any) => [tool.name, tool.inputSchema]));
    const page = emitted.maintenance_write_page as any;
    const pageOps = page.properties.ops;
    assert.equal(pageOps.minItems, 1);
    assert.equal(pageOps.maxItems, 50);
    assert.ok(pageOps.items.anyOf?.length >= 4, 'page operations retain their discriminated union');
    const insert = pageOps.items.anyOf.find((branch: any) => branch.properties?.op?.enum?.includes('insert'));
    assert.ok(insert, `insert branch is represented in the emitted schema: ${JSON.stringify(pageOps.items)}`);
    assert.deepEqual(insert.properties.after.anyOf.map((item: any) => item.type).sort(), ['null', 'string']);
    const update = pageOps.items.anyOf.find((branch: any) => branch.properties?.op?.enum?.includes('update'));
    assert.equal(update.properties.expectRev.minimum, 1, 'revision bounds survive conversion');
    assert.equal(update.properties.id.minLength, 1);

    const database = emitted.maintenance_write_database as any;
    const databaseOps = database.properties.ops;
    assert.equal(databaseOps.items.anyOf?.length, 5, 'database write variants remain distinct');
    const add = databaseOps.items.anyOf.find((branch: any) => branch.properties?.op?.enum?.includes('row.add'));
    assert.ok(add);
    assert.equal(add.properties.body.maxLength, 100000);
    const cell = add.properties.values.additionalProperties;
    assert.ok(cell.anyOf.some((item: any) => item.type === 'null'), 'cell values retain null');
    assert.ok(cell.anyOf.some((item: any) => item.type === 'array' && item.maxItems === 50));
    assert.ok(cell.anyOf.some((item: any) => item.type === 'object' && item.properties?.start));

    const pageInput = {
      sourceTurnId: 'source', pageId: 'page',
      ops: [{ op: 'insert', block: { type: 'heading', text: 'Launch' }, after: null }],
    };
    assert.deepEqual(tools.maintenance_write_page.inputSchema.parse(pageInput), pageInput,
      'MCP argument validation preserves the discriminated operation and nullable anchor');
    for (const type of PAGE_BLOCK_TYPES) {
      const example = PAGE_BLOCK_CATALOG[type].example;
      if (!example) continue;
      const input = { sourceTurnId: 'source', pageId: 'page', ops: [{ op: 'insert', block: example, after: null }] };
      assert.deepEqual(tools.maintenance_write_page.inputSchema.parse(input), input, `the emitted schema takes a ${type} block as the catalog writes it`);
    }
    const call = (name: string, args: unknown) => mcpServer.server._requestHandlers.get('tools/call')(
      { method: 'tools/call', params: { name, arguments: args } }, { signal: new AbortController().signal });
    const pageResult = await call('maintenance_write_page', pageInput);
    assert.match(pageResult.content[0].text, /No active maintenance send/,
      'the emitted MCP invocation validates the page union and reaches its bound handler');
    const databaseInput = {
      sourceTurnId: 'source', databaseId: 'database',
      ops: [{ op: 'row.add', values: { 'col-runtime-id': ['one', 'two'], 'col-null': null } }],
    };
    assert.deepEqual(tools.maintenance_write_database.inputSchema.parse(databaseInput), databaseInput,
      'MCP argument validation preserves dynamic column IDs and typed values');
    const databaseResult = await call('maintenance_write_database', databaseInput);
    assert.match(databaseResult.content[0].text, /No active maintenance send/,
      'the emitted MCP invocation validates the dynamic database values and reaches its bound handler');
  });
});

describe('maintenance context prompt', () => {
  const context = (sources: Array<{ sourceTurnId: string; evidence: { nodeId: string; turnId: string; assistantId: string } }>) => ({
    workspaceId: 'ws', ownerUserId: 'local-user', jobId: 'job', runId: 'run', claimedBy: 'w', configRevision: 1, planId: 'plan',
    sources: sources.map((source) => ({ ...source, manifest: [] })),
  });

  test('a batch of sources leads the turn with their index and a separator', () => {
    const prefix = maintenancePromptPrefix(context([{ sourceTurnId: 't1', evidence: { nodeId: 'n1', turnId: 't1', assistantId: 'a1' } }]));
    assert.match(prefix, /^Trusted maintenance source index \(eligible turn IDs only\):\n\[\{"sourceTurnId":"t1"/);
    assert.ok(prefix.endsWith('\n\n---\n\n'));
  });

  test('a run with no sources (a first read or the Spaces Home summary) gets no empty index', () => {
    assert.equal(maintenancePromptPrefix(context([])), '');
    assert.equal(maintenancePromptPrefix(undefined), '');
  });
});
