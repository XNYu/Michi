import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AgentCapabilityCatalogEntryV1 } from 'michi-shared';
import { AgentCapabilityCatalog, AgentRunToolCapabilitySource, BuiltinAgentCapabilitySource, type AgentCapabilityCatalogSource } from '../src/services/agentCapabilityCatalog';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function entry(overrides: Partial<AgentCapabilityCatalogEntryV1> = {}): AgentCapabilityCatalogEntryV1 {
  return {
    version: 1, id: 'skill-a', kind: 'skill', ownerUserId: 'owner-a', workspaceId: null,
    revision: '1', readiness: 'ready', publicSchema: {}, publicConfig: {},
    schemaHash: digest('schema'), contentHash: digest('content'), configHash: digest('config'),
    credentialBindingIds: ['binding-a'], ...overrides,
  };
}

class FixtureSource implements AgentCapabilityCatalogSource {
  constructor(private readonly entries: readonly AgentCapabilityCatalogEntryV1[]) {}
  list(): readonly AgentCapabilityCatalogEntryV1[] { return this.entries; }
}

describe('AgentCapabilityCatalog', () => {
  test('resolves owner-global and same-workspace entries into a secret-free immutable snapshot', () => {
    const catalog = new AgentCapabilityCatalog([new FixtureSource([
      entry(),
      entry({ id: 'mcp-a', kind: 'mcp_server', workspaceId: 'ws-a', credentialBindingIds: ['opaque-binding'] }),
      entry({ id: 'other-owner', ownerUserId: 'owner-b' }),
    ])], () => true);
    const snapshot = catalog.resolve({
      ownerUserId: 'owner-a', workspaceId: 'ws-a', definitionScope: 'workspace',
      toolRefs: [], skillRefs: ['skill-a'], mcpServerRefs: ['mcp-a'],
    });
    assert.deepEqual(snapshot.entries.map((item) => item.id), ['skill-a', 'mcp-a']);
    assert.deepEqual(snapshot.entries[1].credentialBindingIds, ['opaque-binding']);
    assert.equal(JSON.stringify(snapshot).includes('secret-value'), false);
  });

  test('rejects wrong-owner, wrong-workspace, unresolved, and unready references', () => {
    const catalog = new AgentCapabilityCatalog([new FixtureSource([
      entry({ id: 'workspace-only', workspaceId: 'ws-a' }),
      entry({ id: 'unready', readiness: 'credential_required' }),
    ])], () => true);
    const base = { ownerUserId: 'owner-a', workspaceId: 'ws-b', definitionScope: 'workspace' as const, toolRefs: [], mcpServerRefs: [] };
    assert.throws(() => catalog.resolve({ ...base, skillRefs: ['workspace-only'] }), /not found/);
    assert.throws(() => catalog.resolve({ ...base, skillRefs: ['missing'] }), /not found/);
    assert.throws(() => catalog.resolve({ ...base, skillRefs: ['unready'] }), /credential_required/);
  });

  test('global Definitions cannot reference workspace-scoped capabilities', () => {
    const catalog = new AgentCapabilityCatalog([new FixtureSource([
      entry({ id: 'workspace-only', workspaceId: 'ws-a' }),
    ])], () => true);
    assert.throws(() => catalog.resolve({
      ownerUserId: 'owner-a', workspaceId: 'ws-a', definitionScope: 'global',
      toolRefs: [], skillRefs: ['workspace-only'], mcpServerRefs: [],
    }), /global definitions/);
  });

  test('rejects secret-bearing public capability metadata and unavailable runtimes', () => {
    const secretCatalog = new AgentCapabilityCatalog([new FixtureSource([
      entry({ publicConfig: { apiKey: 'secret-value' } }),
    ])], () => false);
    assert.throws(() => secretCatalog.list('owner-a', null), /secret-bearing/);
    assert.throws(() => secretCatalog.assertRuntimeReady('pi'), /not available/);
  });

  test('Agent Run tools are opt-in and become selectable when their source is installed', () => {
    const featureOff = new AgentCapabilityCatalog([new BuiltinAgentCapabilitySource()], () => true);
    assert.equal(featureOff.list('owner-a', 'ws-a').some((item) => item.id === 'spawn_agent'), false);
    const enabled = new AgentCapabilityCatalog([
      new BuiltinAgentCapabilitySource(), new AgentRunToolCapabilitySource(),
    ], () => true);
    assert.ok(enabled.list('owner-a', 'ws-a').some((item) => item.id === 'spawn_agent'));
    const snapshot = enabled.resolve({
      ownerUserId: 'owner-a', workspaceId: 'ws-a', definitionScope: 'workspace',
      toolRefs: ['spawn_agent'], skillRefs: [], mcpServerRefs: [],
    });
    assert.equal(snapshot.entries[0].id, 'spawn_agent');
  });

  test('web search capability is visible only on Railway deployments', () => {
    const projectId = process.env.RAILWAY_PROJECT_ID;
    const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
    const serviceId = process.env.RAILWAY_SERVICE_ID;
    const searchEnabled = process.env.MICHI_WEB_SEARCH_ENABLED;
    delete process.env.RAILWAY_PROJECT_ID;
    delete process.env.RAILWAY_ENVIRONMENT_ID;
    delete process.env.RAILWAY_SERVICE_ID;
    const source = new BuiltinAgentCapabilitySource();
    try {
      assert.equal(source.list({ ownerUserId: 'owner-a', workspaceId: null })
        .some((item) => item.id === 'web_search'), false);
      process.env.RAILWAY_PROJECT_ID = 'test-project';
      assert.equal(source.list({ ownerUserId: 'owner-a', workspaceId: null })
        .some((item) => item.id === 'web_search'), true);
      process.env.MICHI_WEB_SEARCH_ENABLED = '0';
      assert.equal(source.list({ ownerUserId: 'owner-a', workspaceId: null })
        .some((item) => item.id === 'web_search'), false);
    } finally {
      if (searchEnabled !== undefined) process.env.MICHI_WEB_SEARCH_ENABLED = searchEnabled;
      else delete process.env.MICHI_WEB_SEARCH_ENABLED;
      if (projectId) process.env.RAILWAY_PROJECT_ID = projectId;
      else delete process.env.RAILWAY_PROJECT_ID;
      if (environmentId) process.env.RAILWAY_ENVIRONMENT_ID = environmentId;
      else delete process.env.RAILWAY_ENVIRONMENT_ID;
      if (serviceId) process.env.RAILWAY_SERVICE_ID = serviceId;
      else delete process.env.RAILWAY_SERVICE_ID;
    }
  });
});
