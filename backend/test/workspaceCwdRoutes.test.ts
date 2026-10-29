import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setupMichiRoutes } from '../src/routes/michi';
import type { ChatManager } from '../src/services/chatManager';
import type { AgentSession, LoadAgentSessionOptions } from '../src/agents/types';
import { clearAllSessions } from '../src/agents/sessionRegistry';
import { closeDb, getDb, initDb } from '../src/services/db';
import * as repository from '../src/services/dbRepository';
import * as config from '../src/services/agentConfig';
import * as registry from '../src/agents/registry';
import { __resetRuntimeDeps, configureRuntimeDeps } from '../src/agents/runtimeDeps';

const originalEnv = { ...process.env };
let directory: string;
let server: Server;
let base: string;
let warmed: string[];
let discovered: string[];
let loaded: LoadAgentSessionOptions[];
const catalog = { availableModes: [{ id: 'default', name: 'Default' }], defaultModeId: 'default' };

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-workspace-cwd-'));
  process.env.MICHI_DATA_DIR = directory;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb(); clearAllSessions();
  warmed = []; discovered = []; loaded = [];
  const runtime = { id: 'kiro', capabilities: { modes: true, warmSessions: true, nativeResume: false },
    warm: async (cwd: string) => { warmed.push(cwd); },
    async releaseSession() {},
    loadSession: async (options: LoadAgentSessionOptions): Promise<AgentSession> => {
      loaded.push(options);
      return { id: options.sessionId, runtimeId: 'kiro', getHistory: () => [],
        getPendingAssistant: () => undefined, async *send() {}, async cancel() {} };
    } };
  const agentConfig = config.getAgentConfig();
  mock.method(config, 'getAgentConfig', () => ({ ...agentConfig, runtime: 'kiro' }));
  mock.method(registry, 'getRuntime', () => runtime);
  const manager = { getRuntime: () => runtime, getModeCatalog: async (cwd: string) => {
    discovered.push(cwd); return catalog;
  }, resolvePrimaryAgentBinding: async () => null } as unknown as ChatManager;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { user: { id: req.header('x-user') ?? 'alice' } }); next(); });
  app.use('/api', setupMichiRoutes(manager));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  clearAllSessions(); __resetRuntimeDeps(); closeDb();
  mock.restoreAll();
  for (const key of ['MICHI_DATA_DIR', 'MICHI_CLOUD']) {
    if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

function saveWorkspace(cwd: string) {
  repository.saveWorkspace({ id: 'ws', name: 'Workspace', cwd, owner_user_id: 'alice', created_at: 1, updated_at: 1 });
}
function postWarm(body: unknown, user = 'alice') {
  return fetch(`${base}/warm`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': user }, body: JSON.stringify(body) });
}

test('missing and non-directory cwd return actionable 400 errors without starting a runtime', async () => {
  const file = path.join(directory, 'file');
  fs.writeFileSync(file, 'not a directory');
  for (const cwd of [path.join(directory, 'deleted-workspace'), file]) {
    saveWorkspace(cwd);
    for (const response of [await postWarm({ cwd }), await fetch(`${base}/workspaces/ws/modes`)]) {
      assert.equal(response.status, 400);
      const body = await response.json() as { code: string; error: string };
      assert.equal(body.code, 'WORKSPACE_CWD_INVALID');
      assert.ok(body.error.includes(cwd));
      assert.match(body.error, /Select an existing folder/);
    }
  }
  for (const cwd of [undefined, '', 'relative']) {
    const response = await postWarm({ cwd });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, 'WORKSPACE_CWD_INVALID');
  }
  assert.deepEqual(warmed, []);
  assert.deepEqual(discovered, []);
});

test('both requests succeed after a missing folder is restored', async () => {
  const cwd = path.join(directory, 'restored');
  saveWorkspace(cwd);
  assert.equal((await postWarm({ cwd })).status, 400);
  assert.equal((await fetch(`${base}/workspaces/ws/modes`)).status, 400);
  fs.mkdirSync(cwd);
  assert.equal((await postWarm({ cwd })).status, 200);
  const modes = await fetch(`${base}/workspaces/ws/modes`);
  assert.equal(modes.status, 200);
  assert.deepEqual(await modes.json(), catalog);
  assert.deepEqual(warmed, [cwd]);
  assert.deepEqual(discovered, [fs.realpathSync.native(cwd)]);
});

function enableCloud() {
  process.env.MICHI_CLOUD = '1';
  configureRuntimeDeps({
    historyStore: { getNode: repository.getNode, listMessages: repository.listMessages,
      getWorkspace: repository.getWorkspace, getWorkspaceInstructions: repository.getWorkspaceInstructions },
    dataDir: directory, providerKeys: { getProviderApiKey: () => null },
    agentConfig: { getAgentConfig: config.getAgentConfig, resolveModel: config.resolveModel, resolveReasoning: config.resolveReasoning },
  });
}

test('cloud requests retain owner isolation and derive cwd from the owned Workspace', async () => {
  enableCloud();
  saveWorkspace('/ignored/client/path');
  assert.equal((await postWarm({ workspaceId: 'ws' }, 'bob')).status, 404);
  assert.equal((await fetch(`${base}/workspaces/ws/modes`, { headers: { 'x-user': 'bob' } })).status, 404);
  assert.deepEqual(warmed, []);
  assert.deepEqual(discovered, []);
  assert.equal((await postWarm({ workspaceId: 'ws', cwd: '/untrusted' })).status, 200);
  assert.equal((await fetch(`${base}/workspaces/ws/modes`)).status, 200);
  const expected = path.join(directory, 'user-cwds', 'alice', 'ws-ws');
  assert.deepEqual(warmed, [expected]);
  assert.deepEqual(discovered, [expected]);
});

test('cloud session reload derives cwd and Workspace from the owned node, not the request body', async () => {
  enableCloud();
  saveWorkspace('/ignored/client/path');
  repository.saveWorkspace({ id: 'foreign', name: 'Foreign', cwd: directory, owner_user_id: 'bob', created_at: 1, updated_at: 1 });
  getDb().prepare("INSERT INTO nodes (id,workspace_id,kind,status,created_at) VALUES ('node-a','ws','chat','idle',1)").run();
  const response = await fetch(`${base}/chats/node-a/load`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-user': 'alice' },
    body: JSON.stringify({ nodeId: 'node-a', cwd: directory, workspaceId: 'foreign' }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].cwd, fs.realpathSync.native(path.join(directory, 'user-cwds', 'alice', 'ws-ws')));
  assert.equal(loaded[0].workspaceId, 'ws');
  assert.equal(loaded[0].ownerUserId, 'alice');
});
