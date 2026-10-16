// Must stay first: agentConfig would otherwise persist these fixtures to ~/.michi/config.json.
import { isolatedConfigDir } from './isolatedConfigDir';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { setupAgentRoutes } from '../src/routes/agent';
import { getAgentConfig, loadAgentConfig, updateAgentConfig } from '../src/services/agentConfig';
import { registerRuntime } from '../src/agents/registry';
import type { AgentCapabilities, AgentRuntime, AgentRuntimeWithProviders, ModelInfo } from '../src/agents/types';

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

before(() => {
  for (const runtime of [kiro, claude, pi]) registerRuntime(runtime);
  const app = express();
  app.use(express.json());
  app.use('/api', setupAgentRoutes());
  server = app.listen(0);
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

test('/agent/models leaves a listed model alone', async () => {
  updateAgentConfig({ runtime: kiro.id, provider: 'anthropic', modelByRuntime: { [kiro.id]: 'opus-5.5' } });
  const result = await listModels('anthropic');
  assert.equal(result.sanitizedModel, null);
  assert.equal(getAgentConfig().modelByRuntime[kiro.id], 'opus-5.5');
});

test('/agent/models does not rewrite a provider runtime model while another provider is listed', async () => {
  updateAgentConfig({ runtime: pi.id, provider: 'p1', providerByRuntime: { [pi.id]: 'p1' }, modelByRuntime: { [pi.id]: 'p1-other' } });
  const result = await listModels('p2');
  assert.equal(result.sanitizedModel, null);
  assert.equal(getAgentConfig().modelByRuntime[pi.id], 'p1-other');
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

test('/agent/options saves model and effort to the runtime the client saw', async () => {
  updateAgentConfig({ runtime: kiro.id });
  const result = await post({ model: 'opus-5.5', reasoning: 'high', expectedRuntime: kiro.id });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(getAgentConfig().modelByRuntime[kiro.id], 'opus-5.5');
  assert.equal(getAgentConfig().reasoningByRuntime[kiro.id], 'high');
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

test('/agent/options accepts a legacy alias the runtime canonicalizes', async () => {
  updateAgentConfig({ runtime: claude.id });
  const result = await post({ model: 'sonnet', expectedRuntime: claude.id });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(getAgentConfig().modelByRuntime[claude.id], 'sonnet');
});

test('/agent/options checks provider runtime models against the selected provider catalog', async () => {
  updateAgentConfig({ runtime: pi.id, provider: 'p1', providerByRuntime: { [pi.id]: 'p1' }, modelByRuntime: { [pi.id]: 'p1-default' } });
  const wrongProvider = await post({ provider: 'p2', model: 'p1-other', expectedRuntime: pi.id });
  assert.equal(wrongProvider.status, 400, JSON.stringify(wrongProvider.body));
  assert.equal(getAgentConfig().providerByRuntime[pi.id], 'p1');
  // Settings sends the provider default on a provider switch; keep it even
  // when that provider's live catalog does not list it.
  const providerDefault = await post({ provider: 'p2', model: 'p2-hidden', expectedRuntime: pi.id });
  assert.equal(providerDefault.status, 200, JSON.stringify(providerDefault.body));
  assert.equal(getAgentConfig().modelByRuntime[pi.id], 'p2-hidden');
});

test('/agent/options keeps saving when the catalog is empty and asks for a retry when it fails', async (t) => {
  updateAgentConfig({ runtime: kiro.id });
  const empty = t.mock.method(kiro, 'listModels', async () => []);
  const unverified = await post({ model: 'new-model', expectedRuntime: kiro.id });
  assert.equal(unverified.status, 200, JSON.stringify(unverified.body));
  assert.equal(getAgentConfig().modelByRuntime[kiro.id], 'new-model');
  empty.mock.restore();

  t.mock.method(kiro, 'listModels', async () => { throw new Error('catalog unavailable'); });
  const failed = await post({ model: 'opus-5.5', expectedRuntime: kiro.id });
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(getAgentConfig().modelByRuntime[kiro.id], 'new-model');
});

test('a runtime switch during validation does not move the saved model to the new runtime', async (t) => {
  updateAgentConfig({ runtime: kiro.id, modelByRuntime: { [claude.id]: 'claude-default' }, reasoningByRuntime: { [claude.id]: 'medium' } });
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const models = await kiro.listModels();
  t.mock.method(kiro, 'listModels', async () => { await gate; return models; });

  const save = post({ model: 'opus-5.5', reasoning: 'high', expectedRuntime: kiro.id });
  // The save is waiting on Kiro's catalog when another client switches runtime.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const switched = await post({ runtime: claude.id });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  release();
  const saved = await save;

  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const cfg = getAgentConfig();
  assert.equal(cfg.runtime, claude.id);
  assert.equal(cfg.modelByRuntime[kiro.id], 'opus-5.5');
  assert.equal(cfg.reasoningByRuntime[kiro.id], 'high');
  assert.equal(cfg.modelByRuntime[claude.id], 'claude-default');
  assert.equal(cfg.reasoningByRuntime[claude.id], 'medium');
});
