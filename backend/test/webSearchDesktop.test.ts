// Import FIRST: secrets.ts captures HOME/.michi/config.json when loaded.
import { isolatedIntegrationHome } from './isolatedIntegrationEnvironment';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { setupAgentRoutes } from '../src/routes/agent';
import { createLocalOriginGuard } from '../src/routes/middleware/localControl';
import { createSessionAccessMiddleware } from '../src/routes/middleware/sessionAccess';
import { resolveAccessPolicy } from '../src/services/accessPolicy';
import { loadAgentConfig, updateAgentConfig } from '../src/services/agentConfig';
import { closeDb, initDb } from '../src/services/db';
import { installLocalAccessGuards } from '../src/services/localOrigins';
import { createRemoteAccessMiddleware, remoteAccessEnabled } from '../src/services/remoteAccess';
import { listUserProviderKeys } from '../src/services/userKeys';
import { clearWebSearchApiKey, setWebSearchApiKey } from '../src/services/webSearch';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { buildPiTools } from '../src/agents/pi/piTools';

// Desktop backends (MICHI_CLOUD unset) offer web search without Railway. The
// configuration routes run behind the same guard stack server.ts mounts for
// that access mode, and the key lives in the local credential store.
const credentialConfig = path.join(isolatedIntegrationHome, '.michi', 'config.json');
const SECRET = 'jina-desktop-secret-key';
const REMOTE_TOKEN = 'remote-token-0123456789abcdef';
const LOCAL_EMAIL = 'me@example.com';
const originalEnv = { ...process.env };
const ENV_NAMES = ['MICHI_CLOUD', 'MICHI_REQUIRE_AUTH', 'MICHI_LOCAL_AUTH_EMAIL', 'MICHI_REMOTE_ACCESS', 'MICHI_REMOTE_TOKEN',
  'MICHI_BIND_HOST', 'MICHI_WEB_SEARCH_ENABLED', 'MICHI_DEFAULT_WEB_SEARCH_PROVIDER', 'RAILWAY_PROJECT_ID',
  'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID', 'JINA_API_KEY', 'TAVILY_API_KEY', 'MICHI_ENCRYPTION_KEY'];

function diskKeys(): Record<string, unknown> {
  if (!fs.existsSync(credentialConfig)) return {};
  return JSON.parse(fs.readFileSync(credentialConfig, 'utf8')).providerApiKeys ?? {};
}

before(() => { closeDb(); initDb(); });
after(() => { closeDb(); process.env = { ...originalEnv }; });

beforeEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
  // A fixed key lets the test prove nothing reaches the per-user vault.
  process.env.MICHI_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
  updateAgentConfig({ webSearchProvider: null });
  clearWebSearchApiKey('jina');
  clearWebSearchApiKey('tavily');
});

describe('web search configuration routes on a desktop backend', () => {
  let server: ReturnType<typeof express.application.listen> | undefined;
  let base = '';

  /** The /api stack server.ts mounts for the selected desktop access mode. */
  async function start(mode: 'local' | 'local-auth'): Promise<void> {
    const app = express();
    if (mode === 'local') {
      installLocalAccessGuards(app, { remoteAccess: remoteAccessEnabled() });
      app.use(express.json());
      app.use('/api', createRemoteAccessMiddleware());
      app.use('/api', createLocalOriginGuard({ loopbackListener: true }));
    } else {
      app.use(express.json());
      app.use('/api', createRemoteAccessMiddleware());
      app.use('/api', createSessionAccessMiddleware(resolveAccessPolicy(), async (req) => {
        const email = req.header('x-test-session');
        return email ? { user: { id: 'account-1', email, emailVerified: true }, session: { id: 'session-1' } } : null;
      }));
    }
    app.use('/api', setupAgentRoutes());
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  }

  async function call(method: string, route: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...opts.headers },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    const text = await response.text();
    assert.equal(text.includes(SECRET), false, `${method} ${route} must not return the key`);
    return { status: response.status, body: JSON.parse(text) as Record<string, any> };
  }

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  test('the local app configures a provider and key; the key stays in the local credential store', async () => {
    await start('local');
    const initial = await call('GET', '/agent/status');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.webSearchProvider, null);
    assert.deepEqual(initial.body.webSearchProviders.map((provider: any) => [provider.id, provider.hasKey]),
      [['jina', false], ['tavily', false]]);

    assert.equal((await call('POST', '/agent/options', { body: { webSearchProvider: 'jina' } })).status, 200);
    assert.equal((await call('POST', '/agent/search-key', { body: { provider: 'jina', key: ` ${SECRET} ` } })).status, 200);
    assert.deepEqual(diskKeys(), { 'web-search:jina': SECRET });
    assert.deepEqual(listUserProviderKeys('local-user'), [], 'desktop keys never go to the per-user vault');

    const configured = await call('GET', '/agent/status');
    assert.equal(configured.body.webSearchProvider, 'jina');
    const jina = configured.body.webSearchProviders.find((provider: any) => provider.id === 'jina');
    assert.deepEqual(Object.keys(jina).sort(), ['description', 'hasKey', 'id', 'keyLabel', 'keyUrl', 'label']);
    assert.equal(jina.hasKey, true);

    assert.equal((await call('DELETE', '/agent/search-key/jina')).status, 200);
    assert.deepEqual(diskKeys(), {});
  });

  test('a foreign web page cannot read or change the configuration', async () => {
    await start('local');
    const evil = { origin: 'https://evil.example' };
    assert.equal((await call('GET', '/agent/status', { headers: evil })).status, 403);
    assert.equal((await call('POST', '/agent/options', { headers: evil, body: { webSearchProvider: 'jina' } })).status, 403);
    assert.equal((await call('POST', '/agent/search-key', { headers: evil, body: { provider: 'jina', key: SECRET } })).status, 403);
    const crossSite = { 'sec-fetch-site': 'cross-site' };
    assert.equal((await call('POST', '/agent/search-key', { headers: crossSite, body: { provider: 'jina', key: SECRET } })).status, 403);
    assert.deepEqual(diskKeys(), {});
  });

  test('remote access to a desktop backend keeps requiring its bearer token', async () => {
    process.env.MICHI_REMOTE_ACCESS = '1';
    process.env.MICHI_REMOTE_TOKEN = REMOTE_TOKEN;
    await start('local');
    assert.equal((await call('GET', '/agent/status')).status, 401);
    assert.equal((await call('POST', '/agent/options', { body: { webSearchProvider: 'jina' } })).status, 401);
    const wrong = { authorization: 'Bearer wrong-token-0123456789' };
    assert.equal((await call('POST', '/agent/search-key', { headers: wrong, body: { provider: 'jina', key: SECRET } })).status, 401);
    assert.equal((await call('DELETE', '/agent/search-key/jina')).status, 401);
    assert.deepEqual(diskKeys(), {});

    const bearer = { authorization: `Bearer ${REMOTE_TOKEN}` };
    assert.equal((await call('POST', '/agent/search-key', { headers: bearer, body: { provider: 'jina', key: SECRET } })).status, 200);
    const status = await call('GET', '/agent/status', { headers: bearer });
    assert.equal(status.body.webSearchProviders.find((provider: any) => provider.id === 'jina').hasKey, true);
    assert.deepEqual(diskKeys(), { 'web-search:jina': SECRET });
  });

  test('local authenticated mode requires the selected account and keeps the desktop key store', async () => {
    process.env.MICHI_REQUIRE_AUTH = 'true';
    process.env.MICHI_LOCAL_AUTH_EMAIL = LOCAL_EMAIL;
    await start('local-auth');
    assert.equal((await call('GET', '/agent/status')).status, 401);
    const other = { 'x-test-session': 'someone@example.com' };
    assert.equal((await call('POST', '/agent/search-key', { headers: other, body: { provider: 'tavily', key: SECRET } })).status, 401);
    assert.deepEqual(diskKeys(), {});

    const owner = { 'x-test-session': LOCAL_EMAIL };
    assert.equal((await call('POST', '/agent/search-key', { headers: owner, body: { provider: 'tavily', key: SECRET } })).status, 200);
    assert.deepEqual(diskKeys(), { 'web-search:tavily': SECRET });
    assert.deepEqual(listUserProviderKeys('account-1'), []);
  });

  test('the kill switch hides the configuration and rejects changes', async () => {
    process.env.MICHI_WEB_SEARCH_ENABLED = '0';
    await start('local');
    const status = await call('GET', '/agent/status');
    assert.equal('webSearchProviders' in status.body, false);
    assert.equal('webSearchProvider' in status.body, false);
    assert.equal((await call('POST', '/agent/options', { body: { webSearchProvider: 'jina' } })).status, 404);
    assert.equal((await call('POST', '/agent/search-key', { body: { provider: 'jina', key: SECRET } })).status, 404);
    assert.equal((await call('DELETE', '/agent/search-key/jina')).status, 404);
    assert.deepEqual(diskKeys(), {});
  });
});

test('MICHI_DEFAULT_WEB_SEARCH_PROVIDER is read when the config loads, after server.ts loads .env', () => {
  // Set after every module was imported, as dotenv does in server.ts.
  process.env.MICHI_DEFAULT_WEB_SEARCH_PROVIDER = 'tavily';
  assert.equal(loadAgentConfig().webSearchProvider, 'tavily', 'a desktop backend');
  process.env.MICHI_CLOUD = '1';
  process.env.MICHI_REQUIRE_AUTH = 'true';
  assert.equal(loadAgentConfig().webSearchProvider, null, 'a hosted deployment outside Railway');
  process.env.RAILWAY_SERVICE_ID = 'svc';
  assert.equal(loadAgentConfig().webSearchProvider, 'tavily', 'Railway');
  for (const name of ['MICHI_CLOUD', 'MICHI_REQUIRE_AUTH', 'RAILWAY_SERVICE_ID', 'MICHI_DEFAULT_WEB_SEARCH_PROVIDER']) delete process.env[name];
  assert.equal(loadAgentConfig().webSearchProvider, null);
});

describe('Pi web tools on a desktop backend', () => {
  beforeEach(() => {
    const store = { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null };
    const agentConfig = { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined };
    configureRuntimeDeps({ historyStore: store as any, agentConfig: agentConfig as any, dataDir: path.join(isolatedIntegrationHome, 'runtime') });
  });
  afterEach(() => __resetRuntimeDeps());

  /** Names of the web tools a Pi session gets: a chat has no owner; an Agent Run has the synthetic local owner. */
  function webTools(ownerUserId: string | null): string[] {
    const Type: any = new Proxy({}, { get: () => (..._a: any[]) => ({}) });
    return buildPiTools({
      bridge: {} as any, cwd: '/tmp', parentChatId: 'p', workspaceId: null, enableFollowUps: true,
      imageQuota: { usedBytes: 0, limitBytes: 1 } as any, seenPaths: new Set<string>(), Type, ownerUserId,
    } as any).map((tool: any) => tool.name).filter((name: string) => name === 'web_search' || name === 'fetch_content');
  }

  test('are offered once a provider and key are configured, without Railway', () => {
    assert.deepEqual(webTools(null), [], 'off until the user configures web search');
    updateAgentConfig({ webSearchProvider: 'jina' });
    assert.deepEqual(webTools(null), [], 'a provider without a key is not enough');

    setWebSearchApiKey('jina', SECRET);
    assert.deepEqual(webTools(null), ['web_search', 'fetch_content']);
    assert.deepEqual(webTools('local-user'), ['web_search', 'fetch_content'], 'Agent Runs read the same local key');

    updateAgentConfig({ webSearchProvider: null });
    assert.deepEqual(webTools(null), [], 'Disabled removes both tools');
  });

  test('accept the provider key from the backend environment', () => {
    updateAgentConfig({ webSearchProvider: 'tavily' });
    process.env.TAVILY_API_KEY = 'tavily-env-key';
    assert.deepEqual(webTools(null), ['web_search', 'fetch_content']);
    process.env.MICHI_WEB_SEARCH_ENABLED = '0';
    assert.deepEqual(webTools(null), [], 'the kill switch removes both tools');
  });
});
