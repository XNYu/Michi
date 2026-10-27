import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeRunAdapterRegistry } from '../src/agents/runs/runtimeRunAdapterRegistry';
import { PiRunAdapter } from '../src/agents/runs/piRunAdapter';
import { ClaudeRunAdapter } from '../src/agents/runs/claudeRunAdapter';
import { KiroRunAdapter } from '../src/agents/runs/kiroRunAdapter';
import { CodexRunAdapter } from '../src/agents/runs/codexRunAdapter';

test('registry rejects duplicate adapter registration', () => {
  assert.throws(
    () => new RuntimeRunAdapterRegistry([new PiRunAdapter(), new PiRunAdapter()]),
    /Duplicate Run adapter for runtime pi/,
  );
});

// ---------------------------------------------------------------------------
// Adapter assertCompatible — negative cases
// ---------------------------------------------------------------------------

test('Kiro adapter rejects wrong runtime id', () => {
  const adapter = new KiroRunAdapter();
  const fakeRuntime = { id: 'pi', capabilities: { nativeResume: true } };
  assert.throws(
    () => adapter.assertCompatible(fakeRuntime as never),
    /Kiro Run adapter cannot execute runtime pi/,
  );
});

test('Codex adapter rejects wrong runtime id', () => {
  const adapter = new CodexRunAdapter();
  const fakeRuntime = { id: 'claude', capabilities: { nativeResume: true } };
  assert.throws(
    () => adapter.assertCompatible(fakeRuntime as never),
    /Codex Run adapter cannot execute runtime claude/,
  );
});

test('Enable validates stored reasoning for both primary and fallback while drafts remain savable', async (t) => {
  const { registerRuntime } = require('../src/agents/registry') as typeof import('../src/agents/registry');
  const { AgentDefinitionService, AgentEnableBlockedError } = require('../src/services/agentDefinitionService') as typeof import('../src/services/agentDefinitionService');
  const { AgentCapabilityCatalog } = require('../src/services/agentCapabilityCatalog') as typeof import('../src/services/agentCapabilityCatalog');
  const shared = require('michi-shared') as typeof import('michi-shared');
  const runtime = {
    id: 'pi', label: 'fixture', capabilities: { modes: false, permissions: true, models: true, providerModels: false,
      reasoning: true, supportedReasoningLevels: ['low', 'max'], apiKeys: false, warmSessions: false,
      nativeResume: false, saveContext: false, spawnBranches: false },
    listModels: async () => [{ id: 'model', label: 'Model', supportedReasoningLevels: ['low'], supportsReasoning: true }],
    warm: async () => {}, newSession: async () => { throw new Error('must not execute'); }, releaseSession: async () => {}, shutdown: async () => {},
  };
  registerRuntime(runtime as never);
  const definition = shared.parseAgentDefinitionDtoV1({
    version: 1, id: 'agent', ownerUserId: 'owner', status: shared.AgentDefinitionStatus.Draft, revision: 1,
    createdAt: 1, updatedAt: 1, scope: 'global', workspaceId: null, name: 'Worker', description: '', instructions: '',
    runtimeProfile: { version: 1, runtimeId: 'pi', modelId: 'model', reasoning: 'max' },
    fallbackChain: [{ version: 1, runtimeId: 'pi', modelId: 'model', reasoning: 'max' }],
    toolRefs: [], skillRefs: [], mcpServerRefs: [], permissionPolicy: null,
    contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true,
      allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 1000 }, defaultRunTtlMs: null,
  });
  let creates = 0; let enables = 0;
  const repository = { get: () => definition, create: () => { creates++; return definition; },
    enable: () => { enables++; return { ...definition, status: shared.AgentDefinitionStatus.Enabled }; } };
  const service = new AgentDefinitionService({ repository: repository as never, capabilityCatalog: new AgentCapabilityCatalog([]) });
  await service.create('owner', definition);
  assert.equal(creates, 1, 'an incompatible historical profile may still be saved as a draft');
  await assert.rejects(service.enable('owner', 'agent'), (error: unknown) => {
    assert.ok(error instanceof AgentEnableBlockedError);
    assert.deepEqual(error.blockers.map((blocker) => blocker.code), ['runtime', 'fallback']);
    assert.ok(error.blockers.every((blocker) => /does not support reasoning level max/.test(blocker.message)));
    return true;
  });
  assert.equal(enables, 0);
  definition.runtimeProfile.reasoning = 'low';
  definition.fallbackChain[0].reasoning = 'low';
  assert.equal((await service.enable('owner', 'agent'))?.status, shared.AgentDefinitionStatus.Enabled);
  assert.equal(enables, 1);
  t.mock.restoreAll();
});
