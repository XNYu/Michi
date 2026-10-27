import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentRuntime, AgentRuntimeWithProviders } from '../src/agents/types';
import { findRemoteRuntimeDefault } from '../src/services/remoteRuntimeDefault';
import { setProviderEnvBindings } from '../src/services/secrets';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';

function runtime(id: string, available = true): AgentRuntime {
  return {
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    id, label: id,
    capabilities: { modes: false, permissions: false, models: false, providerModels: false, reasoning: false,
      supportedReasoningLevels: [], apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false },
    checkAvailability: () => ({ available }),
    warm: async () => {},
    newSession: async () => { throw new Error('not used'); },
    releaseSession: () => {}, shutdown: async () => {},
  };
}

for (const id of ['codex', 'claude']) {
}

test('a built-in API adapter requires configured provider credentials', async () => {
  const providerId = 'remote-default-test-provider';
  const envName = 'MICHI_REMOTE_DEFAULT_TEST_KEY';
  const old = process.env[envName];
  const pi: AgentRuntimeWithProviders = {
    ...runtime('pi'), capabilities: { ...runtime('pi').capabilities, apiKeys: true },
    listProviders: async () => [{ id: providerId, label: 'Test Provider', requiresUserKey: true, keyLabel: 'Test key', envVars: [envName], defaultModel: 'test', supportsReasoning: false }],
    verifyProviderKey: async () => ({ ok: true, provider: providerId, model: 'test', latencyMs: 0 }),
  };
  const codex = runtime('codex');
  setProviderEnvBindings([{ provider: providerId, envVars: [envName] }]);
  try {
    delete process.env[envName];
    assert.equal(await findRemoteRuntimeDefault([pi, codex], 'pi'), codex);
    assert.equal(await findRemoteRuntimeDefault([pi], 'pi'), undefined);
    process.env[envName] = 'test-only-placeholder';
    assert.equal(await findRemoteRuntimeDefault([pi, codex], 'pi'), pi);
    assert.equal(await findRemoteRuntimeDefault([runtime('kiro', false), pi], 'kiro'), pi);
  } finally {
    setProviderEnvBindings([]);
    if (old === undefined) delete process.env[envName]; else process.env[envName] = old;
  }
});
