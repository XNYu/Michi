import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { META_AGENT_MAINTENANCE_TOOL_NAMES } from '../src/agents/maintenancePolicy';
import { assertMetaAgentToolCatalog, isMetaAgentGuardError, metaAgentToolsetOf } from '../src/agents/metaAgentGuard';
import { ensureKiroMetaAgent, kiroMetaAgentConfig, kiroMetaAgentDir } from '../src/agents/kiro/kiroMetaAgent';
import type { MaintenanceExecutionContext } from '../src/agents/types';
import { buildMcpServerForSlot, McpSlotRegistry } from '../src/services/mcpServer';
import {
  memoryExtractionBootstrapInstructions, memoryExtractionProfileHash, memoryExtractionToolProfile,
  MEMORY_EXTRACTION_TOOL_NAMES,
} from '../src/services/memory/extractionProfile';
import { createMemoryExtractionTools } from '../src/services/memory/extractionTools';

function slot(names: readonly string[], context: MaintenanceExecutionContext | null = null) {
  return new McpSlotRegistry().create('node-1', '/tmp', 'local-user', {
    owner: { mode: 'interactive', key: 'node-1' },
    maintenance: true,
    exposedToolNames: new Set(names),
    getActiveMaintenanceExecutionContext: () => context,
    isServing: () => true,
    onSpawnBranches: async () => [], onSaveArtifact: () => null, onUpdateArtifact: () => null,
    onShowImage: () => ({ error: 'unused' }),
  }, { workspaceId: 'ws-1' });
}

async function listed(names: readonly string[]): Promise<Array<{ name: string; inputSchema: any }>> {
  const server = buildMcpServerForSlot(slot(names)) as any;
  return (await server.server._requestHandlers.get('tools/list')({ method: 'tools/list', params: {} }, { signal: new AbortController().signal })).tools;
}

test('the extraction profile is a restricted Meta agent profile of exactly four host tools', () => {
  const profile = memoryExtractionToolProfile();
  assert.deepEqual(profile.allowedToolNames, ['memory_read_source', 'memory_search', 'memory_propose', 'memory_no_change']);
  assert.equal(profile.restricted, true);
  assert.equal(profile.maintenance, true);
  assert.equal(metaAgentToolsetOf(profile), 'memory');
  const config = { runtimeId: 'pi', providerId: null, modelId: null, reasoning: null };
  assert.notEqual(memoryExtractionProfileHash(config), memoryExtractionProfileHash({ ...config, modelId: 'other' }));
  // The adapters' launch-time catalog check: these four pass; anything else, including a chat memory tool or a shell, fails.
  assert.doesNotThrow(() => assertMetaAgentToolCatalog({ runtimeId: 'pi', profile, observed: [...MEMORY_EXTRACTION_TOOL_NAMES] }));
  for (const extra of ['memory_save', 'maintenance_write_page', 'bash', 'web_search']) {
    assert.throws(() => assertMetaAgentToolCatalog({ runtimeId: 'pi', profile, observed: [...MEMORY_EXTRACTION_TOOL_NAMES, extra] }),
      (error: unknown) => isMetaAgentGuardError(error) && error.message.includes(extra), extra);
  }
  // The session instructions name exactly these tools.
  const instructions = memoryExtractionBootstrapInstructions();
  for (const name of MEMORY_EXTRACTION_TOOL_NAMES) assert.ok(instructions.includes(`\`${name}\``), name);
});

test('an extraction slot serves only the extraction tools; a Pages maintenance slot serves none of them', async () => {
  const tools = await listed(MEMORY_EXTRACTION_TOOL_NAMES);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...MEMORY_EXTRACTION_TOOL_NAMES].sort());
  const propose = tools.find((tool) => tool.name === 'memory_propose')!.inputSchema;
  assert.deepEqual(Object.keys(propose.properties).sort(), ['body', 'kind', 'scopeHint', 'sourceTurnId', 'supersedesId']);
  assert.match(propose.properties.kind.description, /preference, fact, decision, convention/);
  // Required fields and enums are enforced by the host, so a malformed call is a counted, repairable error.
  assert.deepEqual(propose.required ?? [], []);

  const maintenance = await listed(META_AGENT_MAINTENANCE_TOOL_NAMES);
  assert.equal(maintenance.some((tool) => tool.name.startsWith('memory_')), false);
  assert.deepEqual(maintenance.map((tool) => tool.name).sort(), [...META_AGENT_MAINTENANCE_TOOL_NAMES].sort());
});

test('extraction tools refuse a call without a bound extraction run', async () => {
  const registered = (buildMcpServerForSlot(slot(MEMORY_EXTRACTION_TOOL_NAMES)) as any)._registeredTools as Record<string, { handler(args: unknown): Promise<any> }>;
  const result = await registered.memory_read_source!.handler({ sourceTurnId: 't' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No automatic memory run owns this tool call/);
  const pagesRun = { workspaceId: 'ws-1', ownerUserId: 'local-user', jobId: 'job', runId: 'run', claimedBy: 'x', configRevision: 1,
    planId: 'mpl-1', sources: [], execution: { nodeId: 'n', turnId: 't', assistantId: 'a', runId: 'run' } } as MaintenanceExecutionContext;
  const [readSource] = createMemoryExtractionTools(pagesRun);
  assert.match(readSource!.execute({ sourceTurnId: 't' }).content[0]!.text, /not bound to an automatic memory run/);
});

test('Kiro runs extraction as its own Meta agent with only the extraction tools', () => {
  const config = kiroMetaAgentConfig('memory', MEMORY_EXTRACTION_TOOL_NAMES) as any;
  assert.equal(config.name, 'michi-meta-agent-memory');
  assert.deepEqual(config.allowedTools, MEMORY_EXTRACTION_TOOL_NAMES.map((name) => `@michi/${name}`));
  assert.deepEqual(config.mcpServers, {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-kiro-memory-'));
  try {
    const memory = ensureKiroMetaAgent(dataDir, 'memory', MEMORY_EXTRACTION_TOOL_NAMES);
    const maintenance = ensureKiroMetaAgent(dataDir, 'maintenance', META_AGENT_MAINTENANCE_TOOL_NAMES);
    assert.equal(memory.dir, kiroMetaAgentDir(dataDir, 'memory'));
    assert.notEqual(memory.dir, maintenance.dir, 'its agent file never overwrites the Pages maintenance agent');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
