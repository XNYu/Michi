import { expect, it } from 'vitest';
import { localDiagnosticRuntime } from './remoteDiagnosticAgent';
import type { AgentStatus } from './api/agentRuntime';

it('chooses a configured local runtime without reusing an unavailable selection or provider', () => {
  const status: AgentStatus = { label: 'Pi', capabilities: { models: false, nativeResume: false, supportedReasoningLevels: [], modes: false, permissions: false, providerModels: true, reasoning: false, apiKeys: true, warmSessions: false, saveContext: false, spawnBranches: false }, runtime: 'pi', hasRequiredKey: false, provider: 'unconfigured-provider',
    availableRuntimes: [{ id: 'pi', label: 'Pi', available: true, requiresApiKey: true }, { id: 'codex', label: 'Codex', available: true, requiresApiKey: false }],
    modelByRuntime: { codex: 'saved-codex-model' } };
  expect(localDiagnosticRuntime(status)).toEqual({ label: 'Codex', binding: { runtimeId: 'codex', providerId: undefined, modelId: 'saved-codex-model', reasoning: undefined } });
  expect(localDiagnosticRuntime({ ...status, availableRuntimes: status.availableRuntimes.slice(0, 1) })).toBeNull();
});
