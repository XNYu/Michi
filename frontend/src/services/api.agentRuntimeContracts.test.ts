import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import { normalizeAgentStatus, type AgentStatus as SharedStatus, type RuntimeCatalogResponse as SharedCatalog } from 'michi-shared';
import { fetchAgentStatus, fetchRuntimeCatalog, type AgentStatus, type RuntimeCatalogResponse } from './api/agentRuntime';

afterEach(() => vi.unstubAllGlobals());

it('frontend status and catalog public types remain exactly the shared DTOs', () => {
  expectTypeOf<AgentStatus>().toEqualTypeOf<SharedStatus>();
  expectTypeOf<RuntimeCatalogResponse>().toEqualTypeOf<SharedCatalog>();
});

it('fetchAgentStatus normalizes an old remote gateway before exposing state', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    runtime: 'legacy', label: 'Legacy', availableRuntimes: [], hasRequiredKey: true,
    capabilities: { modes: false, permissions: false, providerModels: false, reasoning: true, apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false },
  }))));
  const status = await fetchAgentStatus('local');
  expect(status.capabilities).toMatchObject({ models: false, nativeResume: false, supportedReasoningLevels: [] });
  expect(status.customAgentsEnabled).toBeUndefined();
});

it('fetchAgentStatus rejects malformed capabilities instead of hydrating them as a live runtime', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ runtime: 'x', label: 'X', capabilities: [] }))));
  await expect(fetchAgentStatus('local')).rejects.toThrow('Invalid agent status');
});

it('fetchRuntimeCatalog retains unknown capability status so a warming gateway can be fetched again', async () => {
  const current = normalizeAgentStatus({ runtime: 'r', label: 'R', capabilities: { models: true }, availableRuntimes: [], hasRequiredKey: true });
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ providers: [], models: [], capabilities: {} })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ providers: [], models: [{ id: 'm', supportsReasoning: false }], capabilities: current.capabilities })));
  vi.stubGlobal('fetch', fetch);
  expect((await fetchRuntimeCatalog('contract-warming')).capabilities).toBeNull();
  expect((await fetchRuntimeCatalog('contract-warming')).models).toEqual([{ id: 'm', supportsReasoning: false }]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
