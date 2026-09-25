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
import { closeDb, getDb, initDb } from '../src/services/db';
import { getAgentConfig, resolveModel, resolveProvider, resolveReasoning, updateAgentConfig } from '../src/services/agentConfig';
import {
  getNode,
  getWorkspace,
  getWorkspaceInstructions,
  grantPermission,
  hasGrant,
  listMessages,
} from '../src/services/dbRepository';
import { __resetRuntimeDeps, configureRuntimeDeps } from '../src/agents/runtimeDeps';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions } from '../src/agents/sessionRegistry';
import { getModelReasoningOptions } from '../src/agents/modelReasoning';
import { getProviderInfo, OPENROUTER_FREE_PRIMARY_MODEL } from '../src/agents/pi/piProviders';
import type { AgentRuntimeWithProviders, NewAgentSessionOptions } from '../src/agents/types';

let directory: string;
let server: ReturnType<typeof express.application.listen>;
let base: string;
let captured: NewAgentSessionOptions[];
let catalogProviders: Array<string | undefined>;
const originalEnv = { ...process.env };
const runtime: AgentRuntimeWithProviders = {
  id: 'pi', label: 'Pi Test',
  capabilities: { modes: false, permissions: false, models: true, providerModels: true, reasoning: true,
    supportedReasoningLevels: ['low', 'high'], apiKeys: true,
    warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false },
  async warm() {}, async releaseSession() {}, async shutdown() {},
  async listModels(options) {
    catalogProviders.push(options?.provider);
    const provider = options?.provider ?? 'openrouter-free';
    return [{ id: provider === 'deepseek' ? 'deepseek-v4-flash' : getProviderInfo(provider)!.defaultModel, isDefault: true }];
  },
  async listProviders() {
    return ['deepseek', 'openai', 'openrouter-free'].map((id) => {
      const info = getProviderInfo(id)!;
      return { ...info, label: info.name, keyLabel: info.apiKeyLabel };
    });
  },
  async verifyProviderKey() { return { ok: true, provider: 'deepseek', model: 'deepseek-v4-flash', latencyMs: 0 }; },
  async newSession(options) {
    captured.push(options);
    return { id: options.sessionId!, runtimeId: 'pi', currentModelId: options.model,
      getHistory: () => [], getPendingAssistant: () => undefined, async *send() {}, async cancel() {} };
  },
};

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-cloud-provider-routes-'));
  process.env.MICHI_DATA_DIR = directory;
  process.env.MICHI_CLOUD = '1';
  closeDb(); initDb(); clearAllSessions(); captured = []; catalogProviders = [];
  configureRuntimeDeps({
    historyStore: { getNode, listMessages, getWorkspace, getWorkspaceInstructions, hasGrant, grantPermission },
    dataDir: directory,
    providerKeys: { getProviderApiKey: () => null },
    agentConfig: { getAgentConfig, resolveModel, resolveReasoning },
  });
  registerRuntime(runtime);
  updateAgentConfig({ runtime: 'pi', provider: 'openrouter-free' }, 'alice');
  updateAgentConfig({ runtime: 'pi', provider: 'openrouter-free' }, 'bob');
  getDb().prepare('INSERT INTO workspaces (id,name,owner_user_id,cwd,created_at,updated_at) VALUES (?,?,?,?,1,1)')
    .run('ws', 'Cloud Test', 'alice', directory);
  getDb().prepare("INSERT INTO nodes (id,workspace_id,kind,status,minimized,spawned_by_agent,created_at) VALUES ('node','ws','chat','idle',0,0,1)").run();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { user: { id: req.header('x-test-user') ?? 'alice' } }); next(); });
  app.use('/api', setupAgentRoutes());
  app.use('/api', setupMichiRoutes(new ChatManager(undefined, directory)));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearAllSessions(); __resetRuntimeDeps(); closeDb();
  process.env = { ...originalEnv };
  fs.rmSync(directory, { recursive: true, force: true });
});

async function post(endpoint: string, body: unknown, user = 'alice') {
  const response = await fetch(`${base}${endpoint}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': user }, body: JSON.stringify(body) });
  const json = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200, JSON.stringify(json));
  return json;
}

test('a fresh cloud session resolves the account provider, not the server default', async () => {
  const provider = resolveProvider('pi') === 'deepseek' ? 'openai' : 'deepseek';
  const model = provider === 'deepseek' ? 'deepseek-v4-flash' : getProviderInfo(provider)!.defaultModel;
  await post('/agent/options', { provider, model });
  closeDb(); initDb();
  const result = await post('/nodes/node/ensure-session', { workspaceId: 'ws', runtimeId: 'pi' });
  assert.equal(result.providerId, provider);
  assert.equal(result.modelId, model);
  assert.equal(captured[0].provider, provider);
  assert.equal(captured[0].ownerUserId, 'alice');
  assert.equal(resolveProvider('pi', 'bob'), 'openrouter-free');
});

test('legacy free-provider/DeepSeek mismatch is normalized in session, response and persisted binding', async () => {
  getDb().prepare("UPDATE nodes SET runtime_id='pi', provider_id='openrouter-free', model_id='deepseek-v4-flash', acp_session_id='node' WHERE id='node'").run();
  const result = await post('/nodes/node/ensure-session', { workspaceId: 'ws', providerId: 'openrouter-free', modelId: 'deepseek-v4-flash' });
  assert.equal(result.modelId, OPENROUTER_FREE_PRIMARY_MODEL);
  assert.equal(captured[0].model, OPENROUTER_FREE_PRIMARY_MODEL);
  assert.equal(captured[0].provider, 'openrouter-free');
  assert.equal(getDb().prepare("SELECT model_id FROM nodes WHERE id='node'").get()!.model_id, OPENROUTER_FREE_PRIMARY_MODEL);
  const status = await (await fetch(`${base}/agent/status`)).json() as { model: string };
  assert.equal(status.model, OPENROUTER_FREE_PRIMARY_MODEL);
});

test('locked models are normalized even on a runtime without reasoning support', async () => {
  const options = await getModelReasoningOptions({ ...runtime, capabilities: { ...runtime.capabilities, reasoning: false } }, 'deepseek-v4-flash', 'openrouter-free');
  assert.equal(options.modelId, OPENROUTER_FREE_PRIMARY_MODEL);
});

test('cloud model catalogs use account defaults and browsing another provider does not replace model memory', async () => {
  await post('/agent/options', { provider: 'deepseek', model: 'deepseek-v4-flash' });
  await fetch(`${base}/agent/runtime-catalog?runtime=pi`);
  await fetch(`${base}/agent/models`);
  assert.deepEqual(catalogProviders, ['deepseek', 'deepseek']);
  await fetch(`${base}/agent/models?provider=openrouter-free`);
  assert.equal(getAgentConfig('alice').modelByRuntime.pi, 'deepseek-v4-flash');
  assert.equal(getAgentConfig('alice').providerByRuntime.pi, 'deepseek');
});

test('changing providers in Settings without a model resets the previous provider model', async () => {
  await post('/agent/options', { provider: 'deepseek', model: 'deepseek-v4-flash' });
  await post('/agent/options', { provider: 'openai' });
  assert.equal(getAgentConfig('alice').modelByRuntime.pi, getProviderInfo('openai')!.defaultModel);
});

test('a second cloud user cannot repair or reuse another account node', async () => {
  const response = await fetch(`${base}/nodes/node/ensure-session`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'bob' }, body: JSON.stringify({ workspaceId: 'ws' }) });
  assert.equal(response.status, 404);
  assert.equal(captured.length, 0);
});
