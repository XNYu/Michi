// Import FIRST: the Bedrock store captures HOME/.michi/config.json when loaded.
import { isolatedIntegrationHome } from './isolatedIntegrationEnvironment';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { setupAgentRoutes } from '../src/routes/agent';
import { closeDb, initDb } from '../src/services/db';
import { getAgentConfig, updateAgentConfig } from '../src/services/agentConfig';
import { getRuntime, registerRuntime } from '../src/agents/registry';
import { getUserProviderKey, listUserProviderKeys } from '../src/services/userKeys';
import type { AgentRuntimeWithProviders } from '../src/agents/types';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';

const credentialConfig = path.join(isolatedIntegrationHome, '.michi', 'config.json');
const operatorBedrock = {
  region: 'us-west-2', credentialSource: 'profile', profile: 'operator', authRefreshCommand: 'operator-refresh',
};
const ADMIN = 'admin@example.com';
const originalEnv = { ...process.env };
let server: ReturnType<typeof express.application.listen>;
let base: string;
let verified: Array<Record<string, unknown>>;

const runtime: AgentRuntimeWithProviders = {
  descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
  id: 'pi', label: 'Pi Test',
  capabilities: { modes: false, permissions: false, models: true, providerModels: true, reasoning: false,
    supportedReasoningLevels: [], apiKeys: true,
    warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false },
  async warm() {}, async releaseSession() {}, async shutdown() {},
  async listProviders() { return []; },
  async verifyProviderKey(input) {
    verified.push({ ...input });
    return { ok: true, provider: input.provider ?? 'none', model: 'stub', latencyMs: 0 };
  },
  async newSession() { throw new Error('not used'); },
};

function readBedrock(): Record<string, unknown> | undefined {
  return JSON.parse(fs.readFileSync(credentialConfig, 'utf8')).bedrock;
}

function readDiskKeys(): Record<string, unknown> | undefined {
  return JSON.parse(fs.readFileSync(credentialConfig, 'utf8')).providerApiKeys;
}

function seedOperatorConfig(): void {
  fs.mkdirSync(path.dirname(credentialConfig), { recursive: true });
  fs.writeFileSync(credentialConfig, JSON.stringify({ bedrock: operatorBedrock }));
}

function useCloud(): void {
  process.env.MICHI_CLOUD = '1';
  process.env.MICHI_REQUIRE_AUTH = 'true';
  process.env.MICHI_ADMIN_EMAILS = ADMIN;
}

async function call(method: string, route: string, opts: { user?: string; email?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.user) headers['x-test-user'] = opts.user;
  if (opts.email) headers['x-test-email'] = opts.email;
  const response = await fetch(`${base}${route}`, {
    method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

beforeEach(async () => {
  for (const key of ['MICHI_CLOUD', 'MICHI_REQUIRE_AUTH', 'MICHI_ADMIN_EMAILS', 'AWS_PROFILE', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID',
    'DEEPSEEK_API_KEY', 'TAVILY_API_KEY']) {
    delete process.env[key];
  }
  verified = [];
  closeDb(); initDb();
  registerRuntime(runtime);
  seedOperatorConfig();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = req.header('x-test-user');
    if (id) Object.assign(req, { user: { id, email: req.header('x-test-email') ?? `${id}@example.com`, emailVerified: true } });
    next();
  });
  app.use('/api', setupAgentRoutes());
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  process.env = { ...originalEnv };
});

describe('Bedrock config routes in cloud mode', () => {
  test('a non-admin gets 404 on every Bedrock config route and the operator config is untouched', async () => {
    useCloud();
    const user = { user: 'bob' };
    assert.equal((await call('GET', '/agent/bedrock-config', user)).status, 404);
    assert.equal((await call('POST', '/agent/bedrock-config', { ...user, body: {
      region: 'eu-west-1', credentialSource: 'auto', authRefreshCommand: 'user-refresh',
    } })).status, 404);
    assert.equal((await call('DELETE', '/agent/bedrock-config', user)).status, 404);
    assert.equal((await call('POST', '/agent/bedrock-config/verify', { ...user, body: {} })).status, 404);
    assert.deepEqual(readBedrock(), operatorBedrock);
    assert.deepEqual(verified, []);
  });

  test('an admin can read, save and verify, and a save keeps the refresh command on disk', async () => {
    useCloud();
    const admin = { user: 'alice', email: ADMIN };
    const read = await call('GET', '/agent/bedrock-config', admin);
    assert.equal(read.status, 200);
    assert.equal(read.body.hasAuthRefresh, true);

    const saved = await call('POST', '/agent/bedrock-config', { ...admin, body: {
      region: 'eu-west-1', credentialSource: 'auto', authRefreshCommand: 'replacement-refresh',
    } });
    assert.equal(saved.status, 200);
    assert.deepEqual(readBedrock(), { region: 'eu-west-1', credentialSource: 'auto', authRefreshCommand: 'operator-refresh' });

    // Omitting the field does not drop the operator's value either.
    assert.equal((await call('POST', '/agent/bedrock-config', { ...admin, body: { region: 'us-east-2', credentialSource: 'auto' } })).status, 200);
    assert.deepEqual(readBedrock(), { region: 'us-east-2', credentialSource: 'auto', authRefreshCommand: 'operator-refresh' });

    // Verification uses the admin's own runtime selection, not the desktop singleton.
    updateAgentConfig({ runtime: 'desktop-only-runtime' });
    assert.equal(getRuntime(getAgentConfig().runtime), undefined);
    updateAgentConfig({ runtime: 'pi' }, 'alice');
    const verify = await call('POST', '/agent/bedrock-config/verify', { ...admin, body: {} });
    assert.equal(verify.status, 200, JSON.stringify(verify.body));
    assert.deepEqual(verified, [{ provider: 'amazon-bedrock' }]);

    assert.equal((await call('DELETE', '/agent/bedrock-config', admin)).status, 200);
    assert.equal(readBedrock(), undefined);
  });

  test('provider key verification uses the requesting user\'s runtime', async () => {
    useCloud();
    updateAgentConfig({ runtime: 'desktop-only-runtime' });
    assert.equal(getRuntime(getAgentConfig().runtime), undefined);
    updateAgentConfig({ runtime: 'pi' }, 'bob');
    const verify = await call('POST', '/agent/provider-key/verify', { user: 'bob', body: { provider: 'deepseek', key: 'sk-test' } });
    assert.equal(verify.status, 200, JSON.stringify(verify.body));
    assert.deepEqual(verified, [{ provider: 'deepseek', key: 'sk-test' }]);
  });
});

describe('Bedrock config routes on the desktop', () => {
  test('need no admin and still save the refresh command from the request', async () => {
    updateAgentConfig({ runtime: 'pi' });
    assert.equal((await call('GET', '/agent/bedrock-config')).status, 200);
    const saved = await call('POST', '/agent/bedrock-config', { body: {
      region: 'eu-west-1', credentialSource: 'auto', authRefreshCommand: 'desktop-refresh',
    } });
    assert.equal(saved.status, 200);
    assert.deepEqual(readBedrock(), { region: 'eu-west-1', credentialSource: 'auto', authRefreshCommand: 'desktop-refresh' });

    // As before, a save without the field replaces the whole Bedrock entry.
    assert.equal((await call('POST', '/agent/bedrock-config', { body: { region: 'eu-west-1', credentialSource: 'auto' } })).status, 200);
    assert.deepEqual(readBedrock(), { region: 'eu-west-1', credentialSource: 'auto' });

    assert.equal((await call('POST', '/agent/bedrock-config/verify', { body: {} })).status, 200);
    assert.deepEqual(verified, [{ provider: 'amazon-bedrock' }]);
    assert.equal((await call('DELETE', '/agent/bedrock-config')).status, 200);
    assert.equal(readBedrock(), undefined);
  });
});

describe('Provider and search key routes', () => {
  const encryptionKey = Buffer.alloc(32, 7).toString('base64');

  test('in cloud mode keys go to the requesting user\'s slot and never to the disk store', async () => {
    useCloud();
    process.env.MICHI_ENCRYPTION_KEY = encryptionKey;
    process.env.RAILWAY_PROJECT_ID = 'test-project';
    const alice = { user: 'alice' };
    assert.equal((await call('POST', '/agent/provider-key', { ...alice, body: { provider: 'deepseek', key: ' sk-alice-key ' } })).status, 200);
    assert.equal((await call('POST', '/agent/search-key', { ...alice, body: { provider: 'tavily', key: 'tvly-alice-key' } })).status, 200);
    assert.equal(getUserProviderKey('alice', 'deepseek'), 'sk-alice-key');
    assert.equal(getUserProviderKey('alice', 'web-search:tavily'), 'tvly-alice-key');
    assert.deepEqual(listUserProviderKeys('bob'), []);
    assert.equal(readDiskKeys(), undefined);

    assert.equal((await call('DELETE', '/agent/provider-key/deepseek', alice)).status, 200);
    assert.equal((await call('DELETE', '/agent/search-key/tavily', alice)).status, 200);
    assert.deepEqual(listUserProviderKeys('alice'), []);
    assert.equal(readDiskKeys(), undefined);
  });

  test('on the desktop keys go to the disk store', async () => {
    process.env.RAILWAY_PROJECT_ID = 'test-project';
    assert.equal((await call('POST', '/agent/provider-key', { body: { provider: 'deepseek', key: 'sk-desktop-key' } })).status, 200);
    assert.equal((await call('POST', '/agent/search-key', { body: { provider: 'tavily', key: 'tvly-desktop-key' } })).status, 200);
    const disk = JSON.parse(fs.readFileSync(credentialConfig, 'utf8'));
    assert.deepEqual(disk.providerApiKeys, { deepseek: 'sk-desktop-key', 'web-search:tavily': 'tvly-desktop-key' });
    assert.equal(disk.deepseekApiKey, 'sk-desktop-key', 'the legacy deepseek slot is kept in step');
    assert.deepEqual(disk.bedrock, operatorBedrock);

    assert.equal((await call('DELETE', '/agent/provider-key/deepseek')).status, 200);
    assert.equal((await call('DELETE', '/agent/search-key/tavily')).status, 200);
    const cleared = JSON.parse(fs.readFileSync(credentialConfig, 'utf8'));
    assert.deepEqual(cleared.providerApiKeys, {});
    assert.equal(cleared.deepseekApiKey, undefined);
  });
});
