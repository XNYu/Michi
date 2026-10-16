import { expect, it } from 'vitest';
import { localDiagnosticRuntime, remoteDiagnosticPrompt } from './remoteDiagnosticAgent';
import type { AgentStatus } from './api/agentRuntime';

it('chooses a configured local runtime without reusing an unavailable selection or provider', () => {
  const status: AgentStatus = { label: 'Pi', capabilities: { modes: false, permissions: false, providerModels: true, reasoning: false, apiKeys: true, warmSessions: false, saveContext: false, spawnBranches: false }, runtime: 'pi', hasRequiredKey: false, provider: 'unconfigured-provider',
    availableRuntimes: [{ id: 'pi', label: 'Pi', available: true, requiresApiKey: true }, { id: 'codex', label: 'Codex', available: true, requiresApiKey: false }],
    modelByRuntime: { codex: 'saved-codex-model' } };
  expect(localDiagnosticRuntime(status)).toEqual({ label: 'Codex', binding: { runtimeId: 'codex', providerId: undefined, modelId: 'saved-codex-model', reasoning: undefined } });
  expect(localDiagnosticRuntime({ ...status, availableRuntimes: status.availableRuntimes.slice(0, 1) })).toBeNull();
});

it('labels a bounded agent excerpt and retains the report path and final error', () => {
  const prompt = remoteDiagnosticPrompt({ id: 'test', host: 'build+', startedAt: 'now', stage: 'build', localLogPath: '/private/diagnostic.json', log: 'x'.repeat(100_000) + '\nFINAL_BUILD_ERROR', truncated: false });
  expect(prompt.length).toBeLessThan(64_000);
  expect(prompt).toContain('middle omitted');
  expect(prompt).toContain('/private/diagnostic.json');
  expect(prompt).toContain('FINAL_BUILD_ERROR');
  expect(prompt).toContain('untrusted log data');
});

it('describes a connected machine with a warning accurately', () => {
  const prompt = remoteDiagnosticPrompt({ id: 'warning', host: 'build+', startedAt: 'now', stage: 'runtime', severity: 'warning', code: 'runtime_warning', message: 'Codex needs sign-in', log: 'remote connected', truncated: false });
  expect(prompt).toContain('The machine connected');
  expect(prompt).toContain('Warning: runtime_warning');
  expect(prompt).not.toContain('this failed Michi remote connection');
});
