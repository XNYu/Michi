import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { setupMichiRoutes } from '../src/routes/michi';
import { setupAgentRoutes } from '../src/routes/agent';
import { ChatManager } from '../src/services/chatManager';
import { initDb, closeDb, getDb } from '../src/services/db';
import { getAgentConfig, loadAgentConfig, updateAgentConfig } from '../src/services/agentConfig';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions } from '../src/agents/sessionRegistry';
import { getModelReasoningOptions } from '../src/agents/modelReasoning';
import * as dbRepository from '../src/services/dbRepository';
import * as dbWorkerClient from '../src/services/dbWorkerClient';
import type { AgentRuntimeWithProviders, ModelInfo, NewAgentSessionOptions } from '../src/agents/types';

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

beforeEach(() => {
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
  server = app.listen(0);
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

test('a pane selection reaches the chosen runtime/model with a valid fallback effort', async () => {
  updateAgentConfig({ runtime: 'unregistered-global-runtime' });
  const result = await post('/nodes/node/ensure-session', { workspaceId: 'ws', cwd: directory, runtimeId: runtime.id, providerId: 'enabled', modelId: 'limited', reasoning: 'max' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(captured.length, 1);
  assert.equal(captured[0].model, 'limited');
  assert.equal(captured[0].provider, 'enabled');
  assert.equal(captured[0].reasoning, 'low');
  assert.equal(result.body.reasoning, 'low');
  assert.equal(getAgentConfig().runtime, 'unregistered-global-runtime');
});

test('unsupported models clear effort in the session and durable binding', async () => {
  const result = await post('/nodes/node/ensure-session', { workspaceId: 'ws', cwd: directory, modelId: 'instant', reasoning: 'max' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(captured[0].reasoning, null);
  assert.equal(result.body.reasoning, null);
  const row = getDb().prepare('SELECT reasoning FROM nodes WHERE id=?').get('node') as { reasoning: string | null };
  assert.equal(row.reasoning, null);
});

test('unchanged live follow-ups do not wait on catalogs, history, or redundant binding writes', async (t) => {
  const first = await post('/nodes/node/ensure-session', {
    workspaceId: 'ws', cwd: directory, providerId: 'enabled', modelId: 'limited', reasoning: 'max',
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.reasoning, 'low');
  const unavailable = async () => { throw new Error('catalog unavailable'); };
  const providers = t.mock.method(runtime, 'listProviders', unavailable);
  const catalog = t.mock.method(runtime, 'listModels', unavailable);
  const history = t.mock.method(dbRepository, 'listMessages', () => { throw new Error('history must remain lazy'); });
  t.mock.method(dbWorkerClient, 'isDbWorkerReady', () => true);
  const persistence = t.mock.method(dbWorkerClient.dbWorker, 'persistResumeBinding', async () => { throw new Error('worker busy'); });

  const followUp = await post('/nodes/node/ensure-session', {
    workspaceId: 'ws', cwd: directory, providerId: 'enabled', modelId: 'limited', reasoning: 'low',
  });
  assert.equal(followUp.status, 200, JSON.stringify(followUp.body));
  assert.equal(followUp.body.resumeStrategy, 'live');
  assert.equal(followUp.body.reasoning, 'low');
  assert.equal(captured.length, 1);
  for (const operation of [providers, catalog, history, persistence]) {
    assert.equal(operation.mock.callCount(), 0);
  }
});

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

test('a cold fallback restores durable history when the renderer omits its transcript', async (t) => {
  await post('/nodes/node/ensure-session', {
    workspaceId: 'ws', cwd: directory, providerId: 'enabled', modelId: 'limited', reasoning: 'low',
  });
  getDb().prepare(`INSERT INTO messages (id,node_id,role,content,seq,created_at)
    VALUES ('prior-user','node','user','Remember the original decision',0,1),
           ('prior-answer','node','assistant','The decision was to keep SQLite',1,1)`).run();
  clearAllSessions();
  const catalog = t.mock.method(runtime, 'listModels', async () => models);

  const restored = await post('/nodes/node/ensure-session', {
    workspaceId: 'ws', cwd: directory, providerId: 'enabled', modelId: 'limited', reasoning: 'low',
  });

  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.resumeStrategy, 'compatible');
  assert.equal(catalog.mock.callCount(), 1);
  assert.equal(captured.length, 2);
  assert.match(captured[1].mergeContexts?.join('\n') ?? '', /Remember the original decision/);
  assert.match(captured[1].mergeContexts?.join('\n') ?? '', /The decision was to keep SQLite/);
});

test('provider opt-out hides effort even for a reasoning-capable model', async () => {
  const result = await post('/nodes/node/ensure-session', { workspaceId: 'ws', cwd: directory, providerId: 'disabled', modelId: 'flexible', reasoning: 'high' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(captured[0].reasoning, null);
  const fixed = await getModelReasoningOptions(runtime, 'fixed', 'enabled', 'max');
  assert.equal(fixed.adjustable, false);
  assert.equal(fixed.value, 'high');
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

test('a pane send records its provider + model as the runtime last-used pair', async () => {
  const result = await post('/nodes/node/ensure-session', { workspaceId: 'ws', cwd: directory, providerId: 'disabled', modelId: 'limited' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const cfg = getAgentConfig();
  assert.equal(cfg.providerByRuntime[runtime.id], 'disabled');
  assert.equal(cfg.modelByRuntime[runtime.id], 'limited');
  // The global active runtime/provider are untouched — only the per-runtime memory moves.
  assert.equal(cfg.provider, 'enabled');
});

test('a fresh pane switched to the runtime resolves to the last-used pair, not the built-in fallback', async () => {
  updateAgentConfig({ runtime: 'unregistered-global-runtime', provider: 'enabled', providerByRuntime: { [runtime.id]: 'disabled' }, modelByRuntime: { [runtime.id]: 'limited' } });
  const result = await post('/nodes/node/ensure-session', { workspaceId: 'ws', cwd: directory, runtimeId: runtime.id });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(captured[0].provider, 'disabled');
  assert.equal(captured[0].model, 'limited');
});

test('switching to a non-provider runtime does not pollute providerByRuntime', async () => {
  registerRuntime({ ...runtime, id: 'plain-test', capabilities: { ...runtime.capabilities, providerModels: false, apiKeys: false } });
  const result = await post('/agent/options', { runtime: 'plain-test' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(getAgentConfig().providerByRuntime['plain-test'], undefined);
  assert.equal(getAgentConfig().providerByRuntime[runtime.id], 'enabled');
});

for (const runtimeId of ['codex', 'claude', 'kiro']) {
  test(`capacity errors identify ${runtimeId} without the historical Claude code`, async (t) => {
    const label = runtimeId[0].toUpperCase() + runtimeId.slice(1);
    t.mock.method(runtime, 'newSession', async () => {
      throw Object.assign(new Error(`${label} concurrency cap reached`), { name: `${label}ConcurrencyError` });
    });
    const result = await post('/nodes/node/ensure-session', {
      workspaceId: 'ws', cwd: directory, runtimeId: runtime.id, modelId: 'flexible',
    });
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, {
      code: 'RUNTIME_SESSIONS_BUSY', runtimeId, error: `${label} concurrency cap reached`,
    });
  });
}
