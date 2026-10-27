// Must stay first: agentConfig would otherwise persist these fixtures to ~/.michi/config.json.
import { isolatedConfigDir } from './isolatedConfigDir';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { setupAgentRoutes } from '../src/routes/agent';
import { getAgentConfig, loadAgentConfig, updateAgentConfig } from '../src/services/agentConfig';
import { registerRuntime } from '../src/agents/registry';
import type { AgentCapabilities, AgentRuntime, AgentRuntimeWithProviders, ModelInfo } from '../src/agents/types';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';

// Model ids belong to one runtime. These tests cover the two ways an id from
// one runtime ended up stored under another: a save that raced a runtime
// switch, and a catalog that never healed the stored value afterwards.

const capabilities = (providerModels: boolean): AgentCapabilities => ({
  modes: false, permissions: false, models: true, providerModels, reasoning: true,
  supportedReasoningLevels: ['low', 'medium', 'high'], apiKeys: providerModels,
  warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false,
});

function runtimeWith(id: string, label: string, models: ModelInfo[], extra: Partial<AgentRuntime> = {}) {
  const runtime: AgentRuntime & { listModels(opts?: { provider?: string }): Promise<ModelInfo[]> } = {
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    id, label, capabilities: capabilities(false),
    async warm() {}, async releaseSession() {}, async shutdown() {},
    async newSession() { throw new Error('sessions are not used by these tests'); },
    async listModels() { return models; },
    ...extra,
  };
  return runtime;
}

// Kiro-like: a global catalog that ignores any provider argument.
const kiro = runtimeWith('scope-kiro', 'Scope Kiro', [
  { id: 'auto', supportsReasoning: false, supportedReasoningLevels: [] },
  { id: 'opus-5.5', supportedReasoningLevels: ['low', 'medium', 'high'] },
]);
// Claude-like: legacy aliases canonicalize onto listed ids.
const claude = runtimeWith('scope-claude', 'Scope Claude', [
  { id: 'claude-default', isDefault: true, supportedReasoningLevels: ['low', 'medium', 'high'] },
  { id: 'arn:router', supportsReasoning: false, supportedReasoningLevels: [] },
], { canonicalModelId: (modelId: string) => (modelId === 'sonnet' ? 'claude-default' : modelId) });
// Pi-like: provider-scoped catalogs.
const pi: AgentRuntimeWithProviders & { listModels(opts?: { provider?: string }): Promise<ModelInfo[]> } = {
  ...runtimeWith('scope-pi', 'Scope Pi', []),
  capabilities: capabilities(true),
  async listModels(opts) {
    return opts?.provider === 'p2' ? [{ id: 'p2-listed' }] : [{ id: 'p1-default' }, { id: 'p1-other' }];
  },
  async listProviders() {
    return [
      { id: 'p1', label: 'P1', keyLabel: '', envVars: [], defaultModel: 'p1-default', supportsReasoning: false },
      // A provider default the live catalog does not list (e.g. a dynamic catalog).
      { id: 'p2', label: 'P2', keyLabel: '', envVars: [], defaultModel: 'p2-hidden', supportsReasoning: false },
    ];
  },
  async verifyProviderKey() { return { ok: true, provider: 'p1', model: 'p1-default', latencyMs: 0 }; },
};

let server: ReturnType<typeof express.application.listen>;
let base: string;

before(async () => {
  for (const runtime of [kiro, claude, pi]) registerRuntime(runtime);
  const app = express();
  app.use(express.json());
  app.use('/api', setupAgentRoutes());
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  delete process.env.MICHI_CLOUD;
  fs.rmSync(path.join(isolatedConfigDir, 'config.json'), { force: true });
  loadAgentConfig();
});

async function post(body: unknown) {
  const response = await fetch(`${base}/agent/options`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function listModels(provider?: string) {
  const url = new URL(`${base}/agent/models`);
  if (provider) url.searchParams.set('provider', provider);
  const response = await fetch(url);
  return await response.json() as { models: ModelInfo[]; sanitizedModel: string | null };
}

test('/agent/models heals a model saved from another runtime even when the client sends a provider', async () => {
  // Clients pass the global provider for every runtime; Kiro ignores it.
  updateAgentConfig({ runtime: kiro.id, provider: 'anthropic', modelByRuntime: { [kiro.id]: 'arn:router' } });
  const result = await listModels('anthropic');
  assert.equal(result.sanitizedModel, 'auto');
  assert.equal(getAgentConfig().modelByRuntime[kiro.id], 'auto');
});

test('/agent/options rejects model and effort saves made for a runtime that is no longer active', async () => {
  updateAgentConfig({ runtime: claude.id, modelByRuntime: { [claude.id]: 'claude-default' }, reasoningByRuntime: { [claude.id]: 'medium' } });
  for (const body of [{ model: 'opus-5.5' }, { reasoning: 'high' }, { model: 'opus-5.5', reasoning: 'high' }]) {
    const result = await post({ ...body, expectedRuntime: kiro.id });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.ok, false);
    assert.equal(result.body.code, 'runtime_mismatch');
    assert.match(String(result.body.error), /Scope Claude/);
  }
  const cfg = getAgentConfig();
  assert.equal(cfg.modelByRuntime[claude.id], 'claude-default');
  assert.equal(cfg.reasoningByRuntime[claude.id], 'medium');
  assert.equal(cfg.modelByRuntime[kiro.id], undefined);
});

test('/agent/options rejects a model the active runtime does not list, with or without expectedRuntime', async () => {
  updateAgentConfig({ runtime: kiro.id, modelByRuntime: { [kiro.id]: 'opus-5.5' } });
  for (const body of [{ model: 'arn:router' }, { model: 'arn:router', expectedRuntime: kiro.id }]) {
    const result = await post(body);
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.match(String(result.body.error), /not available for Scope Kiro/);
  }
  assert.equal(getAgentConfig().modelByRuntime[kiro.id], 'opus-5.5');
});

test('/agent/models rejects a catalog labelled with a stale runtime before discovery or sanitization', async () => {
  updateAgentConfig({ runtime: claude.id, modelByRuntime: { [claude.id]: 'missing' } });
  const response = await fetch(`${base}/agent/models?expectedRuntime=${kiro.id}`);
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { code: string }).code, 'runtime_changed');
  assert.equal(getAgentConfig().modelByRuntime[claude.id], 'missing');
  const same = await fetch(`${base}/agent/models?expectedRuntime=${claude.id}`);
  assert.equal(same.status, 200);
  assert.equal((await same.json() as { sanitizedModel: string }).sanitizedModel, 'claude-default');
  assert.equal(getAgentConfig().modelByRuntime[claude.id], 'claude-default');
});
