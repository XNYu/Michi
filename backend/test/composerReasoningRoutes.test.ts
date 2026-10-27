// Must stay first: agentConfig would otherwise persist these fixtures to ~/.michi/config.json.
import './isolatedConfigDir';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { setupMichiRoutes } from '../src/routes/michi';
import { setupAgentRoutes } from '../src/routes/agent';
import { ChatManager } from '../src/services/chatManager';
import { initDb, closeDb, getDb } from '../src/services/db';
import { getAgentConfig, loadAgentConfig, updateAgentConfig } from '../src/services/agentConfig';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions } from '../src/agents/sessionRegistry';

import type { AgentRuntimeWithProviders, ModelInfo, NewAgentSessionOptions } from '../src/agents/types';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';

let directory: string;
let server: ReturnType<typeof express.application.listen>;
let base: string;
let captured: NewAgentSessionOptions[];
const originalDataDir = process.env.MICHI_DATA_DIR;
const originalCloud = process.env.MICHI_CLOUD;
const models: ModelInfo[] = [
  { id: 'flexible', supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoning: 'high' },
  { id: 'limited', supportedReasoningLevels: ['low', 'medium'], defaultReasoning: 'low' },
  { id: 'fixed', supportedReasoningLevels: ['high'] },
  { id: 'instant', supportsReasoning: false, supportedReasoningLevels: [] },
];
const runtime: AgentRuntimeWithProviders & { listModels(): Promise<ModelInfo[]> } = {
  descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
  id: 'composer-test', label: 'Composer Test',
  capabilities: { modes: false, permissions: false, models: true, providerModels: true, reasoning: true,
    supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'], apiKeys: true,
    warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false },
  async warm() {}, async releaseSession() {}, async shutdown() {},
  async listModels() { return models; },
  async listProviders() { return ['enabled', 'disabled'].map((id) => ({ id, label: id, defaultModel: 'flexible', supportsReasoning: id === 'enabled', keyLabel: '', envVars: [] })); },
  async verifyProviderKey() { return { ok: true, provider: 'enabled', model: 'flexible', latencyMs: 0 }; },
  async newSession(options) {
    captured.push(options);
    return { id: options.sessionId!, runtimeId: runtime.id, currentModelId: options.model, getHistory: () => [], getPendingAssistant: () => undefined, async *send() {}, async cancel() {} };
  },
};

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-composer-reasoning-'));
  process.env.MICHI_DATA_DIR = directory;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb(); loadAgentConfig(); clearAllSessions(); captured = [];
  registerRuntime(runtime);
  updateAgentConfig({ runtime: runtime.id, provider: 'enabled', providerByRuntime: { [runtime.id]: 'enabled' },
    modelByRuntime: { [runtime.id]: 'flexible' }, reasoningByRuntime: { [runtime.id]: 'max' } });
  getDb().prepare('INSERT INTO workspaces (id,name,owner_user_id,cwd,created_at,updated_at) VALUES (?,?,NULL,?,1,1)').run('ws', 'Composer Test', directory);
  getDb().prepare("INSERT INTO nodes (id,workspace_id,kind,status,minimized,spawned_by_agent,created_at) VALUES ('node','ws','chat','idle',0,0,1)").run();
  const app = express();
  app.use(express.json());
  app.use('/api', setupAgentRoutes());
  app.use('/api', setupMichiRoutes(new ChatManager(undefined, directory)));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearAllSessions(); closeDb();
  fs.rmSync(directory, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = originalDataDir;
  if (originalCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = originalCloud;
});

async function post(endpoint: string, body: unknown) {
  const response = await fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test('changing live settings still validates the selected model and effort', async (t) => {
  await post('/nodes/node/ensure-session', {
    workspaceId: 'ws', cwd: directory, providerId: 'enabled', modelId: 'flexible', reasoning: 'high',
  });
  const catalog = t.mock.method(runtime, 'listModels', async () => models);
  const changed = await post('/nodes/node/ensure-session', {
    workspaceId: 'ws', cwd: directory, providerId: 'enabled', modelId: 'limited', reasoning: 'max',
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.modelId, 'limited');
  assert.equal(changed.body.reasoning, 'low');
  assert.equal(catalog.mock.callCount(), 1);
  assert.equal(captured.at(-1)?.reasoning, 'low');
});

test('changing provider without a model uses that provider default instead of the old binding', async () => {
  updateAgentConfig({ modelByRuntime: { [runtime.id]: 'limited' } });
  const result = await post('/nodes/node/ensure-session', { workspaceId: 'ws', cwd: directory, providerId: 'disabled' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(captured[0].provider, 'disabled');
  assert.equal(captured[0].model, 'flexible');
  assert.equal(captured[0].reasoning, null);
});

test('effort saves validate the target model before changing any defaults', async () => {
  const rejected = await post('/agent/options', { model: 'limited', reasoning: 'max' });
  assert.equal(rejected.status, 400);
  assert.equal(getAgentConfig().modelByRuntime[runtime.id], 'flexible');
  const accepted = await post('/agent/options', { model: 'limited', reasoning: 'low' });
  assert.equal(accepted.status, 200);
  assert.equal(getAgentConfig().reasoningByRuntime[runtime.id], 'low');
});

test('switching to a non-provider runtime does not pollute providerByRuntime', async () => {
  registerRuntime({ ...runtime, id: 'plain-test', capabilities: { ...runtime.capabilities, providerModels: false, apiKeys: false } });
  const result = await post('/agent/options', { runtime: 'plain-test' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(getAgentConfig().providerByRuntime['plain-test'], undefined);
  assert.equal(getAgentConfig().providerByRuntime[runtime.id], 'enabled');
});

for (const runtimeId of ['codex', 'claude', 'kiro']) {
}
