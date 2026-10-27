import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { resolveAccessPolicy, requestOwnerUserId } from '../src/services/accessPolicy';
import { createSessionAccessMiddleware } from '../src/routes/middleware/sessionAccess';
import { setupPersistenceRoutes } from '../src/routes/persistence';
import { setupAdminRoutes } from '../src/routes/admin';
import { closeDb, getDb, initDb } from '../src/services/db';
import { getAuthForHost, runAuthMigrations } from '../src/services/auth';
import { getWorkspace, listMessages, listWorkspaces, loadAllWorkspaces, loadAllWorkspacesMeta } from '../src/services/dbRepository';
import { getProviderApiKey, setProviderEnvBindings } from '../src/services/secrets';
import { getUserProviderKey, setUserProviderKey } from '../src/services/userKeys';
import { McpSlotRegistry, mountMcp } from '../src/services/mcpServer';
import { isInternalRuntimeRequest } from '../src/services/remoteAccess';

const originalEnv = { ...process.env };
const secret = 'isolated-access-test-secret-with-at-least-32-characters';
const users = [
  { id: 'alice', email: 'alice@example.com', verified: true },
  { id: 'bob', email: 'bob@example.com', verified: true },
  { id: 'unverified', email: 'unverified@example.com', verified: false },
];
let directory: string;
let server: ReturnType<typeof express.application.listen> | undefined;
let base: string;
let mcpSlotId: string;
let mcpGroupId: string;
const cookies = new Map<string, string>();

function mode(auth: boolean, cloud: boolean, localEmail?: string): void {
  process.env.MICHI_REQUIRE_AUTH = String(auth);
  process.env.MICHI_CLOUD = cloud ? '1' : '0';
  delete process.env.MICHI_LOCAL_AUTH_EMAIL;
  if (localEmail) process.env.MICHI_LOCAL_AUTH_EMAIL = localEmail;
  process.env.MICHI_ADMIN_EMAILS = 'alice@example.com';
}

async function startApp(options: { sessionGate?: boolean } = {}): Promise<void> {
  const policy = options.sessionGate === false ? undefined : resolveAccessPolicy();
  const app = express();
  app.use(express.json());
  if (policy) app.use('/api', createSessionAccessMiddleware(policy,
    req => getAuthForHost(req.headers.host).api.getSession({ headers: fromNodeHeaders(req.headers) })));
  const mcp = express.Router();
  const registry = new McpSlotRegistry();
  const slot = registry.create('local-auth-test', directory, null, {
    onSpawnBranches: async () => [], onSaveArtifact: () => null, onUpdateArtifact: () => null,
  });
  mcpSlotId = slot.slotId;
  mcpGroupId = registry.createSessionGroup(slot);
  mountMcp(mcp, registry);
  app.use('/api', mcp);
  // Mount the actual admin router without an outer guard: it owns its policy.
  app.use('/api/admin', setupAdminRoutes());
  app.use('/api', setupPersistenceRoutes());
  app.get('/api/test/access', (req, res) => res.json({
    principal: req.authUser?.id ?? null, owner: requestOwnerUserId(req) ?? null,
    key: getProviderApiKey('access-test-provider', req.user?.id),
  }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

async function request(route: string, user?: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}${route}`, { method,
    headers: { 'content-type': 'application/json', ...(user ? { cookie: cookies.get(user)! } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
}

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-access-http-'));
  process.env.MICHI_DATA_DIR = directory;
  process.env.MICHI_CONFIG_DIR = directory;
  process.env.NODE_ENV = 'test';
  process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3000';
  process.env.BETTER_AUTH_SECRET = secret;
  process.env.GOOGLE_CLIENT_ID = 'isolated-client-no-network';
  process.env.GOOGLE_CLIENT_SECRET = 'isolated-client-secret';
  process.env.MICHI_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  delete process.env.MICHI_CORS_ORIGINS;
  closeDb(); initDb();
  await runAuthMigrations();
  const authDb = new DatabaseSync(path.join(directory, 'auth.sqlite'));
  const now = Date.now();
  for (const user of users) {
    // Real Better Auth schema and signed cookies. No live OAuth account or
    // network request is needed to exercise production getSession resolution.
    authDb.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
      .run(user.id, user.id, user.email, Number(user.verified), now, now);
    const token = `isolated-session-${user.id}`;
    authDb.prepare('INSERT INTO "session" (id,token,userId,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
      .run(`session-${user.id}`, token, user.id, now + 3_600_000, now, now);
    const signature = createHmac('sha256', secret).update(token).digest('base64');
    cookies.set(user.id, `michi.session_token=${encodeURIComponent(`${token}.${signature}`)}`);
  }
  authDb.close();
  for (const owner of ['alice', 'bob', null]) {
    const id = owner ?? 'legacy';
    getDb().prepare('INSERT INTO workspaces (id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)')
      .run(`ws-${id}`, `${id} private workspace`, owner);
    getDb().prepare('INSERT INTO trees (id,workspace_id,root_node_id,created_at,last_active_at) VALUES (?,?,?,1,1)')
      .run(`tree-${id}`, `ws-${id}`, `node-${id}`);
    getDb().prepare("INSERT INTO nodes (id,workspace_id,tree_id,kind,status,minimized,spawned_by_agent,created_at) VALUES (?,?,?,'chat','idle',0,0,1)")
      .run(`node-${id}`, `ws-${id}`, `tree-${id}`);
    getDb().prepare("INSERT INTO messages (id,node_id,role,content,seq,created_at) VALUES (?,?,'assistant',?,0,1)")
      .run(`message-${id}`, `node-${id}`, `private-message-${id}`);
  }
  process.env.ACCESS_TEST_PROVIDER_KEY = 'desktop-provider-key';
  setProviderEnvBindings([{ provider: 'access-test-provider', envVars: ['ACCESS_TEST_PROVIDER_KEY'] }]);
  setUserProviderKey('alice', 'access-test-provider', 'encrypted-alice-provider-key');
  setUserProviderKey('bob', 'access-test-provider', 'encrypted-bob-provider-key');
});

afterEach(async () => {
  if (server) {
    const current = server; server = undefined;
    current.closeAllConnections();
    await new Promise<void>(resolve => current.close(() => resolve()));
  }
});
after(() => { closeDb(); process.env = originalEnv; fs.rmSync(directory, { recursive: true, force: true }); });

describe('access-mode contract through real HTTP routers and temporary SQLite', () => {
  test('AUTH=0 CLOUD=0 keeps desktop ownerless history and shared provider keys', async () => {
    mode(false, false); await startApp();
    const listed = await request('/workspaces');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.workspaces.length, 3);
    assert.equal((await request('/workspaces/all')).body.workspaces.length, 3);
    assert.equal((await request('/workspaces/ws-legacy')).body.messages[0].content, 'private-message-legacy');
    assert.equal((await request('/workspaces/ws-bob/trees/tree-bob/messages')).body.messages[0].content, 'private-message-bob');
    assert.deepEqual((await request('/test/access')).body, { principal: null, owner: null, key: 'desktop-provider-key' });
    assert.equal((await request('/admin/users', 'alice')).status, 404);
  });

  test('AUTH=0 CLOUD=1 is rejected before starting an app; standalone data routers fail closed', async () => {
    mode(false, true);
    await assert.rejects(startApp(), /MICHI_CLOUD=1 requires MICHI_REQUIRE_AUTH=true/);
    await startApp({ sessionGate: false });
    for (const route of ['/workspaces', '/workspaces/all', '/workspaces/all?meta=1', '/workspaces/ws-alice', '/workspaces/ws-alice/trees/tree-alice/messages', '/nodes/node-alice/messages']) {
      assert.equal((await request(route)).status, 401, route);
    }
    assert.equal((await request('/admin/users')).status, 404);
  });

  test('AUTH=1 CLOUD=0 requires an explicit single verified account; preserves desktop data/key semantics', async () => {
    mode(true, false);
    await assert.rejects(startApp(), /MICHI_LOCAL_AUTH_EMAIL/);
    process.env.MICHI_LOCAL_AUTH_EMAIL = 'alice@example.com,bob@example.com';
    await assert.rejects(startApp(), /MICHI_LOCAL_AUTH_EMAIL/);
    mode(true, false, ' ALICE@example.com '); await startApp();
    for (const user of [undefined, 'bob']) {
      for (const route of ['/workspaces', '/workspaces/all', '/workspaces/ws-legacy', '/nodes/node-legacy/messages', '/admin/users']) {
        assert.equal((await request(route, user)).status, 401, `${user} ${route}`);
      }
    }
    assert.equal((await request('/workspaces', 'alice')).body.workspaces.length, 3);
    assert.equal((await request('/workspaces/all?meta=1', 'alice')).body.workspaces.length, 3);
    assert.equal((await request('/workspaces/ws-legacy', 'alice')).body.messages[0].content, 'private-message-legacy');
    assert.equal((await request('/workspaces/ws-legacy/trees/tree-legacy/messages', 'alice')).body.messages[0].content, 'private-message-legacy');
    assert.deepEqual((await request('/test/access', 'alice')).body, { principal: 'alice', owner: null, key: 'desktop-provider-key' });
    assert.equal((await request('/workspaces/ws-local-created', 'alice', 'PUT', { name: 'Local' })).status, 200);
    assert.equal(getWorkspace('ws-local-created')?.owner_user_id, null);
    getDb().prepare('DELETE FROM workspaces WHERE id = ?').run('ws-local-created');
    assert.equal((await request('/admin/users', 'alice')).status, 200);
    process.env.MICHI_ADMIN_EMAILS = '';
    assert.equal((await request('/admin/users', 'alice')).status, 404);
  });

  test('local authentication rejects a real unverified Better Auth session for the configured email', async () => {
    mode(true, false, 'unverified@example.com'); await startApp();
    assert.equal((await request('/workspaces/all', 'unverified')).status, 401);
  });

  test('local auth permits cookie-free loopback MCP capabilities while preserving slot validation and data auth', async () => {
    mode(true, false, 'alice@example.com'); await startApp();
    for (const route of [`/mcp/${mcpSlotId}`, `/mcp-session/${mcpGroupId}`]) {
      const result = await fetch(`${base}${route}`, { method: 'POST',
        headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
          protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'access-test', version: '1' },
        } }),
      });
      assert.equal(result.status, 200, route);
      await result.text();
    }
    assert.equal((await request('/mcp/unknown', undefined, 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 404);
    assert.equal((await request('/workspaces/all')).status, 401);
    assert.equal(isInternalRuntimeRequest(`/mcp/${mcpSlotId}`, '10.0.0.1'), false);
    assert.equal(isInternalRuntimeRequest('/workspaces/all', '127.0.0.1'), false);
  });

  test('AUTH=1 CLOUD=1 isolates both users across list/all/meta/single/tree/node messages and writes', async () => {
    mode(true, true); await startApp();
    assert.equal((await request(`/mcp/${mcpSlotId}`, undefined, 'POST', {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    })).status, 401, 'cloud MCP does not inherit the local-auth cookie exception');
    for (const owner of ['alice', 'bob']) {
      const other = owner === 'alice' ? 'bob' : 'alice';
      for (const route of ['/workspaces', '/workspaces/all', '/workspaces/all?meta=1']) {
        const result = await request(route, owner);
        assert.equal(result.status, 200, route);
        assert.equal(result.body.workspaces.length, 1, route);
        const first = result.body.workspaces[0];
        assert.equal(first.workspace?.id ?? first.id, `ws-${owner}`);
        assert.equal(JSON.stringify(result.body).includes(`private-message-${other}`), false);
        assert.equal(JSON.stringify(result.body).includes('ws-legacy'), false);
      }
      const own = await request(`/workspaces/ws-${owner}`, owner);
      assert.equal(own.status, 200);
      assert.equal(own.body.messages[0].content, `private-message-${owner}`);
      assert.equal((await request(`/nodes/node-${owner}/workspace`, owner)).body.workspaceId, `ws-${owner}`);
      assert.equal((await request(`/workspaces/ws-${owner}/trees/tree-${owner}/messages`, owner)).body.messages[0].content, `private-message-${owner}`);
      for (const target of [other, 'legacy']) {
        for (const route of [`/workspaces/ws-${target}`, `/workspaces/ws-${target}/trees/tree-${target}/messages`, `/nodes/node-${target}/workspace`]) {
          assert.equal((await request(route, owner)).status, 404, route);
        }
        assert.equal((await request(`/workspaces/ws-${target}`, owner, 'PUT', { name: 'stolen' })).status, 404);
        assert.equal((await request(`/nodes/node-${target}/messages`, owner, 'POST', { id: 'forbidden-message', role: 'user', content: 'stolen' })).status, 404);
      }
      const created = `ws-created-${owner}`;
      assert.equal((await request(`/workspaces/${created}`, owner, 'PUT', { name: 'Created' })).status, 200);
      assert.equal(getWorkspace(created)?.owner_user_id, owner);
      getDb().prepare('DELETE FROM workspaces WHERE id = ?').run(created);
      assert.equal((await request('/test/access', owner)).body.key, `encrypted-${owner}-provider-key`);
    }
    for (const route of ['/workspaces', '/workspaces/all', '/workspaces/ws-alice', '/nodes/node-alice/messages', '/admin/users']) {
      assert.equal((await request(route)).status, 401, route);
    }
    const admin = await request('/admin/users', 'alice');
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    assert.deepEqual(admin.body.map((u: any) => u.id).sort(), ['alice', 'bob', 'unverified']);
    assert.equal((await request('/admin/users', 'bob')).status, 404);
    process.env.MICHI_ADMIN_EMAILS = 'unverified@example.com';
    assert.equal((await request('/admin/users', 'unverified')).status, 404);
    assert.equal(getUserProviderKey('alice', 'access-test-provider'), 'encrypted-alice-provider-key');
    assert.equal(listWorkspaces().length, 3, 'trusted background inventory remains available');
    assert.equal(loadAllWorkspaces().length, 3);
    assert.deepEqual(listWorkspaces(''), []);
    assert.deepEqual(loadAllWorkspaces(''), []);
    assert.deepEqual(loadAllWorkspacesMeta(''), []);
    assert.deepEqual(listMessages('node-alice', ''), []);
    assert.equal(getWorkspace('ws-alice', ''), null);
    assert.throws(() => requestOwnerUserId({}), /Authenticated owner/);
  });

  test('an independently mounted cloud data router requires an owner even for creation', async () => {
    mode(true, true); await startApp({ sessionGate: false });
    for (const [route, body] of [
      ['/workspaces/new', { name: 'Missing owner' }],
      ['/workspaces/new/graph/nodes/ensure', { workspace: { id: 'new' }, node: { id: 'node-new' } }],
      ['/workspaces/new/commands', { operationId: 'op', commands: [] }],
    ] as const) {
      const result = await request(route, undefined, route.endsWith('/new') ? 'PUT' : 'POST', body);
      assert.equal(result.status, 401);
    }
    assert.equal(getWorkspace('new'), null);
  });

  test('explicit ownerless-workspace migration reveals history only to the assigned cloud user and preserves encrypted keys', async () => {
    mode(true, true); await startApp();
    assert.equal((await request('/workspaces/ws-legacy', 'alice')).status, 404);
    getDb().exec('BEGIN IMMEDIATE');
    const result = getDb().prepare('UPDATE workspaces SET owner_user_id = ? WHERE id = ? AND owner_user_id IS NULL')
      .run('alice', 'ws-legacy');
    assert.equal(result.changes, 1);
    getDb().exec('COMMIT');
    assert.equal((await request('/workspaces', 'alice')).body.workspaces.length, 2);
    assert.equal((await request('/workspaces/ws-legacy', 'alice')).body.messages[0].content, 'private-message-legacy');
    assert.equal((await request('/workspaces/ws-legacy/trees/tree-legacy/messages', 'alice')).body.messages[0].content, 'private-message-legacy');
    assert.equal((await request('/workspaces/ws-legacy', 'bob')).status, 404);
    assert.equal((await request('/workspaces', 'bob')).body.workspaces.length, 1);
    assert.equal(getUserProviderKey('alice', 'access-test-provider'), 'encrypted-alice-provider-key');
    assert.equal(getUserProviderKey('bob', 'access-test-provider'), 'encrypted-bob-provider-key');
  });
});
