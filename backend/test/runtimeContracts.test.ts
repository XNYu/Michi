import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAPABILITY_KEYS, invisibleSlot, normalizeAgentStatus, normalizeRuntimeCatalog,
  normalizeAgentModels, REASONING_LEVELS, parseAgentRunAttemptDtoV1,
} from 'michi-shared';
import type {
  AgentCapabilities, AgentProviderInfo, AgentStatus, AgentModelInfo, CapabilityDescriptor,
} from 'michi-shared';
import type {
  AgentCapabilities as BackendCapabilities, AgentProviderInfo as BackendProvider,
  AgentStatus as BackendStatus, ModelInfo,
} from '../src/agents/types';

// If a backend wire DTO forks from shared, this test must fail compilation.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const contracts: [Equal<BackendCapabilities, AgentCapabilities>, Equal<BackendProvider, AgentProviderInfo>, Equal<BackendStatus, AgentStatus>, Equal<ModelInfo, AgentModelInfo>] = [true, true, true, true];

const capabilities: AgentCapabilities = {
  modes: true, permissions: true, models: true, providerModels: false,
  reasoning: true, supportedReasoningLevels: ['low', 'high'], apiKeys: false,
  warmSessions: true, saveContext: true, spawnBranches: true, nativeResume: true,
  nativeResumeSettings: ['model', 'reasoning'],
};

test('current status round trips without losing runtime resume settings or capability provenance', () => {
  assert.ok(contracts.every(Boolean));
  const status: AgentStatus = {
    runtime: 'runtime', label: 'Runtime', customAgentsEnabled: true, capabilities,
    availableRuntimes: [{ id: 'runtime', label: 'Runtime', available: false, unavailableReason: 'login required', requiresApiKey: false }],
    providers: [{ id: 'provider', label: 'Provider', keyLabel: 'API key', envVars: ['KEY'], defaultModel: 'm', keyUrl: 'https://example.test', supportsReasoning: true, supportedReasoningLevels: ['low'], defaultReasoning: 'low', requiresUserKey: false, hasKey: true, modelLocked: true }],
    webSearchProviders: [{ id: 'search', label: 'Search', keyLabel: 'Key', keyUrl: 'https://example.test', description: 'Search', hasKey: true }],
    provider: 'provider', model: 'm', reasoning: 'high', hasRequiredKey: true,
    providerByRuntime: { runtime: 'provider' }, modelByRuntime: { runtime: 'm' }, reasoningByRuntime: { runtime: 'high' },
    nativeResumeByRuntime: { runtime: false }, nativeForkByRuntime: { runtime: true }, webSearchProvider: null,
    capabilityDescriptor: Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, invisibleSlot('not exposed')])) as CapabilityDescriptor,
  };
  assert.deepEqual(normalizeAgentStatus(JSON.parse(JSON.stringify(status))), status);
});

test('old gateway omissions normalize conservatively while optional feature flags stay absent', () => {
  const { models: _models, nativeResume: _resume, supportedReasoningLevels: _levels, nativeResumeSettings: _settings, ...legacy } = capabilities;
  const status = normalizeAgentStatus({ runtime: 'legacy', label: 'Legacy', capabilities: legacy, availableRuntimes: [], hasRequiredKey: true });
  assert.equal(status.capabilities.models, false);
  assert.equal(status.capabilities.nativeResume, false);
  assert.deepEqual(status.capabilities.supportedReasoningLevels, []);
  assert.equal(status.customAgentsEnabled, undefined);
  assert.equal(status.nativeResumeByRuntime, undefined);
  assert.equal(status.capabilityDescriptor, undefined);
});

test('malformed catalog payloads stay retryable and cannot advertise arbitrary reasoning values', () => {
  for (const value of [null, [], {}, { models: 'yes' }]) assert.equal(normalizeRuntimeCatalog({ capabilities: value }).capabilities, null);
  const catalog = normalizeRuntimeCatalog({
    capabilities: { ...capabilities, supportedReasoningLevels: ['high', 'future', 'high'], nativeResumeSettings: ['reasoning', 'unknown', 'reasoning'] },
    models: [null, {}, { id: 'm', supportsReasoning: true, supportedReasoningLevels: ['low', 'invalid'], defaultReasoning: 'invalid' }],
    providers: [null, { id: 'p', label: 'P', supportsReasoning: true, supportedReasoningLevels: [] }],
  });
  assert.deepEqual(catalog.capabilities?.supportedReasoningLevels, ['high']);
  assert.deepEqual(catalog.capabilities?.nativeResumeSettings, ['reasoning']);
  assert.deepEqual(catalog.models, [{ id: 'm', supportsReasoning: true, supportedReasoningLevels: ['low'] }]);
  assert.deepEqual(catalog.providers[0].supportedReasoningLevels, []);
  assert.throws(() => normalizeAgentStatus({ runtime: 'x', label: 'X', capabilities: [] }), /Invalid agent status/);
});

test('active model boundary retains explicit unsupported/unknown reasoning distinctions', () => {
  assert.deepEqual(normalizeAgentModels({ models: [{ id: 'm', supportsReasoning: false, supportedReasoningLevels: [] }, { id: 'legacy' }, { id: 1 }], sanitizedModel: 'm' }), {
    models: [{ id: 'm', supportsReasoning: false, supportedReasoningLevels: [] }, { id: 'legacy' }], sanitizedModel: 'm',
  });
});

test('Agent Run profile validator accepts exactly the shared reasoning vocabulary', () => {
  const attempt = (reasoning: string) => ({
    version: 1, id: 'a', runId: 'r', attemptIndex: 0, profileIndex: 0,
    runtimeProfile: { version: 1, runtimeId: 'r', reasoning }, status: 'running',
    publicSessionId: 's', recoveryEnvelope: null, startedAt: 1,
    checkpointAt: null, completedAt: null, error: null,
  });
  for (const reasoning of REASONING_LEVELS) assert.equal(parseAgentRunAttemptDtoV1(attempt(reasoning)).runtimeProfile.reasoning, reasoning);
  assert.throws(() => parseAgentRunAttemptDtoV1(attempt('future')), /reasoning/);
});
