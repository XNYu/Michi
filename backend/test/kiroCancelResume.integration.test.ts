import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { setupMichiRoutes } from '../src/routes/michi';
import { ChatManager } from '../src/services/chatManager';
import { initDb, closeDb, getDb } from '../src/services/db';
import { getNode, listMessages, saveNode, updateNodeResumeBinding } from '../src/services/dbRepository';
import * as dbWorkerClient from '../src/services/dbWorkerClient';
import { loadAgentConfig, updateAgentConfig } from '../src/services/agentConfig';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions, getSession } from '../src/agents/sessionRegistry';
import { KiroSession } from '../src/agents/kiro/KiroSession';
import type { KiroRuntime } from '../src/agents/kiro/KiroRuntime';
import type { AgentRuntime, LoadAgentSessionOptions, NewAgentSessionOptions } from '../src/agents/types';
import { AcpClient } from '../src/services/acpClient';
import { NativeResumeUnavailableError } from '../src/services/nativeResume';

let directory: string;
let server: ReturnType<typeof express.application.listen>;
let base: string;
let created: NewAgentSessionOptions[];
let prompts: Array<{ sessionId: string; text: string }>;
let releases: string[];
let completePrompt: () => void;
let promptStarted: Promise<void>;
let client: AcpClient;
let runtime: AgentRuntime;
let manager: ChatManager;
let loaded: LoadAgentSessionOptions[];
let loadFailures: Error[];
let currentModel: string;
const originalDataDir = process.env.MICHI_DATA_DIR;
const originalCloud = process.env.MICHI_CLOUD;

beforeEach(async (t) => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-cancel-route-'));
  const writeFile = fs.writeFileSync;
  (t as TestContext).mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    if (args[0] === path.join(os.homedir(), '.michi', 'config.json')) return;
    return writeFile(...args);
  });
  process.env.MICHI_DATA_DIR = directory;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  loadAgentConfig();
  clearAllSessions();
  created = [];
  prompts = [];
  releases = [];
  loaded = [];
  loadFailures = [];
  currentModel = 'original-model';
  completePrompt = () => {};
  let notifyPromptStarted: () => void;
  promptStarted = new Promise<void>((resolve) => { notifyPromptStarted = resolve; });
  client = new AcpClient('/bin/false', directory);
  const internals = client as any;
  internals.send = async (method: string, params: any) => {
    if (method === 'session/new') return { sessionId: `native-${created.length}` };
    assert.equal(method, 'session/prompt');
    prompts.push({ sessionId: params.sessionId, text: params.prompt[0].text });
    if (prompts.length === 1) {
      notifyPromptStarted();
      return new Promise((resolve) => {
        completePrompt = () => resolve({ stopReason: 'cancelled' });
      });
    }
    client.injectUpdate(params.sessionId, {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Continued on the original session.' },
    });
    return { stopReason: 'end_turn' };
  };
  internals.notify = async (method: string) => {
    assert.equal(method, 'session/cancel');
    completePrompt();
  };
  const adapter = {
    ensureClient: async () => client,
    getClient: () => client,
    getCurrentMode: () => null,
    getCurrentModel: () => currentModel,
    setModel: async (_id: string, model: string) => { currentModel = model; },
    recoverSession: async () => { throw new Error('cancel must not recover'); },
  } as unknown as KiroRuntime;
  runtime = {
    id: 'kiro', label: 'Kiro cancellation test',
    capabilities: { modes: false, permissions: false, models: true, providerModels: false, reasoning: false,
      supportedReasoningLevels: [], apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: true },
    async warm() {}, async shutdown() {},
    async releaseSession(id) { releases.push(id); },
    async loadSession(options) {
      loaded.push(options);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const failure = loadFailures.shift();
      if (failure) throw failure;
      currentModel = options.model ?? currentModel;
      return new KiroSession(options.nodeId!, getNode(options.nodeId!)!.acp_session_id!, adapter, directory);
    },
    async newSession(options) {
      created.push(options);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const { sessionId } = await client.newSession();
      const session = new KiroSession(options.sessionId!, sessionId, adapter, directory, { enableFollowUps: false });
      session.primeFirstMessage('FIRST-TURN-ONLY');
      return session;
    },
  };
  registerRuntime(runtime);
  updateAgentConfig({ runtime: 'kiro', modelByRuntime: { kiro: 'original-model' } });
  getDb().prepare('INSERT INTO workspaces (id,name,owner_user_id,cwd,created_at,updated_at) VALUES (?,?,NULL,?,1,1)').run('ws', 'Cancel Test', directory);
  getDb().prepare("INSERT INTO nodes (id,workspace_id,title,kind,status,minimized,spawned_by_agent,created_at) VALUES ('cancel-node','ws','Cancel node','chat','idle',0,0,1)").run();
  const app = express();
  app.use(express.json());
  manager = new ChatManager(undefined, directory);
  app.use('/api', setupMichiRoutes(manager));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  completePrompt();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearAllSessions();
  closeDb();
  fs.rmSync(directory, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.MICHI_DATA_DIR;
  else process.env.MICHI_DATA_DIR = originalDataDir;
  if (originalCloud === undefined) delete process.env.MICHI_CLOUD;
  else process.env.MICHI_CLOUD = originalCloud;
});

function post(endpoint: string, body: unknown) {
  return fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function ensure(extra: Record<string, unknown> = {}) {
  const response = await post('/nodes/cancel-node/ensure-session', { workspaceId: 'ws', cwd: directory, ...extra });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<{ resumeStrategy: string; modelId: string }>;
}

async function cancelFirstTurn() {
  const first = await ensure();
  assert.equal(first.resumeStrategy, 'fresh');
  const response = post('/chats/cancel-node/message', { text: 'remember earlier work', turnId: 'cancel-route-first' });
  await promptStarted;
  const cancelled = await post('/chats/cancel-node/cancel', { turnId: 'cancel-route-first' });
  assert.equal(cancelled.status, 200);
  const body = await (await response).text();
  assert.match(body, /"stopReason":"cancelled"/);
  assert.doesNotMatch(body, /event: error/);
}

test('legacy create shares the durable ensure path and cold native resume', async () => {
  const request = () => post('/chats', { nodeId: 'cancel-node', workspaceId: 'ws', cwd: directory });
  const responses = await Promise.all(Array.from({ length: 4 }, request));
  for (const response of responses) assert.equal(response.status, 200, await response.text());
  assert.equal(created.length, 1);
  assert.equal(getNode('cancel-node')?.acp_session_id, 'native-1');
  clearAllSessions();
  const resumed = await request();
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json() as any).resumeStrategy, 'exact');
  assert.equal(loaded.length, 1);
  assert.equal(created.length, 1);
});

test('legacy create rejects missing durable nodes and mismatched workspace ownership', async () => {
  for (const body of [
    { workspaceId: 'ws', cwd: directory },
    { nodeId: 'missing', workspaceId: 'ws', cwd: directory },
    { nodeId: 'cancel-node', workspaceId: 'wrong', cwd: directory },
  ]) assert.equal((await post('/chats', body)).status, 409);
  assert.equal(created.length, 0);
});

test('legacy create awaits worker commit and tears down an uncommitted session', async (t) => {
  t.mock.method(dbWorkerClient, 'isDbWorkerReady', () => true);
  t.mock.method(dbWorkerClient.dbWorker, 'persistResumeBinding', async () => { throw new Error('disk unavailable'); });
  const response = await post('/chats', { nodeId: 'cancel-node', workspaceId: 'ws', cwd: directory });
  assert.equal(response.status, 500);
  assert.equal(getNode('cancel-node')?.acp_session_id, null);
  assert.equal(getSession('cancel-node'), undefined);
  assert.deepEqual(releases, ['cancel-node']);
});

test('HTTP cancel then follow-up reuses the native ACP session without re-priming', async () => {
  await cancelFirstTurn();
  assert.equal((await ensure()).resumeStrategy, 'live');
  const response = await post('/chats/cancel-node/message', { text: 'continue', turnId: 'cancel-route-next' });
  assert.match(await response.text(), /Continued on the original session/);
  assert.deepEqual(prompts.map((prompt) => prompt.sessionId), ['native-1', 'native-1']);
  assert.match(prompts[0].text, /FIRST-TURN-ONLY/);
  assert.doesNotMatch(prompts[1].text, /FIRST-TURN-ONLY|Compatible resume/);
  assert.equal(created.length, 1);
  assert.deepEqual(releases, []);
  assert.equal(getNode('cancel-node')?.acp_session_id, 'native-1');
  assert.equal(listMessages('cancel-node').filter((message) => message.role === 'user').length, 2);
});

test('cancelled session keeps its model when global defaults changed and the client omits modelId', async () => {
  await cancelFirstTurn();
  updateAgentConfig({ modelByRuntime: { kiro: 'different-global-default' } });
  const result = await ensure();
  assert.equal(result.resumeStrategy, 'live');
  assert.equal(result.modelId, 'original-model');
  assert.equal(created.length, 1);
  assert.deepEqual(releases, []);
  assert.equal(getNode('cancel-node')?.acp_session_id, 'native-1');
});

test('explicitly selecting a different model still replaces an incompatible session', async () => {
  await cancelFirstTurn();
  const result = await ensure({ modelId: 'explicit-new-model' });
  assert.equal(result.resumeStrategy, 'compatible');
  assert.equal(result.modelId, 'explicit-new-model');
  assert.equal(created.length, 2);
  assert.deepEqual(releases, ['cancel-node']);
});

test('a stale graph save between cancel and follow-up cannot change the native session binding', async () => {
  await cancelFirstTurn();
  saveNode({
    id: 'cancel-node', workspace_id: 'ws', title: 'Cancel node', kind: 'chat', status: 'idle', minimized: 0,
    spawned_by_agent: 0, created_at: 1, model_id: 'stale-model', reasoning: 'high',
  } as Parameters<typeof saveNode>[0]);
  const result = await ensure({ modelId: 'original-model' });
  assert.equal(result.resumeStrategy, 'live');
  assert.equal(created.length, 1);
  assert.deepEqual(releases, []);
  assert.equal(getNode('cancel-node')?.acp_session_id, 'native-1');
});

test('ensure-session does not acknowledge a binding before its worker write commits', async (t) => {
  let entered!: () => void;
  let commit!: () => void;
  const enteredWrite = new Promise<void>((resolve) => { entered = resolve; });
  const commitGate = new Promise<void>((resolve) => { commit = resolve; });
  t.mock.method(dbWorkerClient, 'isDbWorkerReady', () => true);
  t.mock.method(dbWorkerClient.dbWorker, 'persistResumeBinding', async (fields: any) => {
    entered();
    await commitGate;
    updateNodeResumeBinding(fields.nodeId, fields);
  });
  let acknowledged = false;
  const result = ensure().then((value) => { acknowledged = true; return value; });
  await enteredWrite;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const acknowledgedBeforeCommit = acknowledged;
  commit();
  await result;
  assert.equal(acknowledgedBeforeCommit, false);
  assert.equal(getNode('cancel-node')?.acp_session_id, 'native-1');
});

test('a cold restore failure keeps the original native binding and never creates a replacement', async () => {
  await ensure();
  clearAllSessions();
  loadFailures.push(new Error('MCP configuration not found'));
  const response = await post('/nodes/cancel-node/ensure-session', { workspaceId: 'ws', cwd: directory });
  assert.equal(response.status, 503);
  assert.equal((await response.json() as any).code, 'NATIVE_RESUME_FAILED');
  assert.equal(getNode('cancel-node')?.acp_session_id, 'native-1');
  assert.equal(created.length, 1);
  assert.equal((await ensure()).resumeStrategy, 'exact');
  assert.equal(created.length, 1);
});

test('concurrent cold restore requests perform one native load', async () => {
  await ensure();
  clearAllSessions();
  const responses = await Promise.all(Array.from({ length: 6 }, () => ensure()));
  assert.equal(responses.filter((result) => result.resumeStrategy === 'exact').length, 1);
  assert.equal(responses.filter((result) => result.resumeStrategy === 'live').length, 5);
  assert.equal(loaded.length, 1);
  assert.equal(created.length, 1);
  assert.equal(getNode('cancel-node')?.acp_session_id, 'native-1');
});

test('concurrent fresh ensures create only one native session', async () => {
  await Promise.all(Array.from({ length: 6 }, () => ensure()));
  assert.equal(created.length, 1);
  assert.equal(getNode('cancel-node')?.acp_session_id, 'native-1');
});

test('background parent restore also retains the binding on unknown native failure', async () => {
  await ensure();
  clearAllSessions();
  loadFailures.push(new Error('authentication unavailable'));
  await assert.rejects(manager.ensureParentSession({ nodeId: 'cancel-node', workspaceId: 'ws', ownerUserId: 'local-user' }));
  assert.equal(created.length, 1);
  assert.equal(getNode('cancel-node')?.acp_session_id, 'native-1');
});

test('known missing native state permits one explicit compatible replacement', async () => {
  await ensure();
  clearAllSessions();
  loadFailures.push(new NativeResumeUnavailableError('native state missing'));
  assert.equal((await ensure()).resumeStrategy, 'compatible');
  assert.equal(created.length, 2);
  assert.equal(loaded.length, 1);
  assert.equal(getNode('cancel-node')?.acp_session_id, 'native-2');
});

test('transient native load retries succeed without replacing the original session', async () => {
  await ensure();
  clearAllSessions();
  runtime.isNativeResumeRetryable = () => true;
  loadFailures.push(new Error('transient'), new Error('transient'));
  assert.equal((await ensure()).resumeStrategy, 'exact');
  assert.equal(loaded.length, 3);
  assert.equal(created.length, 1);
  assert.equal(getNode('cancel-node')?.acp_session_id, 'native-1');
});

test('foreground and background native restoration share the same lock', async () => {
  await ensure();
  clearAllSessions();
  await Promise.all([ensure(), manager.ensureParentSession({ nodeId: 'cancel-node', workspaceId: 'ws', ownerUserId: 'local-user' })]);
  assert.equal(loaded.length, 1);
  assert.equal(created.length, 1);
});

test('model-capable live and cold native continuations retain their original ID', async () => {
  runtime.capabilities.nativeResumeSettings = ['model'];
  await ensure();
  assert.equal((await ensure({ modelId: 'new-model' })).resumeStrategy, 'live');
  assert.equal(currentModel, 'new-model');
  clearAllSessions();
  assert.equal((await ensure({ modelId: 'another-model' })).resumeStrategy, 'exact');
  assert.equal(currentModel, 'another-model');
  assert.equal(created.length, 1);
  assert.equal(getNode('cancel-node')?.acp_session_id, 'native-1');
  assert.equal(getNode('cancel-node')?.model_id, 'another-model');
});

test('explicit set-model persists the setting used by the next native restore', async () => {
  runtime.capabilities.nativeResumeSettings = ['model'];
  await ensure();
  const response = await post('/chats/cancel-node/set-model', { modelId: 'new-model' });
  assert.equal(response.status, 200);
  assert.equal(getNode('cancel-node')?.model_id, 'new-model');
  clearAllSessions();
  assert.equal((await ensure()).resumeStrategy, 'exact');
  assert.equal(loaded[0].model, 'new-model');
  assert.equal(created.length, 1);
});

test('an explicit load and foreground ensure cannot load the same native session twice', async () => {
  await ensure();
  clearAllSessions();
  const [response] = await Promise.all([
    post('/chats/cancel-node/load', { cwd: directory }), ensure(),
  ]);
  assert.equal(response.status, 200, await response.text());
  assert.equal(loaded.length, 1);
  assert.equal(created.length, 1);
});

test('a failed binding commit releases the uncommitted session instead of acknowledging success', async (t) => {
  await ensure();
  clearAllSessions();
  const workerReady = t.mock.method(dbWorkerClient, 'isDbWorkerReady', () => true);
  const persistence = t.mock.method(dbWorkerClient.dbWorker, 'persistResumeBinding', async () => { throw new Error('disk unavailable'); });
  const response = await post('/nodes/cancel-node/ensure-session', { workspaceId: 'ws', cwd: directory });
  assert.equal(response.status, 500);
  assert.equal(getNode('cancel-node')?.acp_session_id, 'native-1');
  assert.deepEqual(releases, ['cancel-node']);
  persistence.mock.restore();
  workerReady.mock.mockImplementation(() => false);
  assert.equal((await ensure()).resumeStrategy, 'exact');
  assert.equal(created.length, 1);
});

test('failed teardown cannot be ignored when reloading a native session with new settings', async () => {
  runtime.capabilities.nativeResumeSettings = ['model'];
  await ensure();
  getSession('cancel-node')!.setModel = undefined;
  runtime.releaseSession = async () => { throw new Error('session teardown failed'); };
  const response = await post('/nodes/cancel-node/ensure-session', { workspaceId: 'ws', cwd: directory, modelId: 'new-model' });
  assert.equal(response.status, 503);
  assert.equal(loaded.length, 0);
  assert.equal(created.length, 1);
  assert.equal(getNode('cancel-node')?.model_id, 'original-model');
});

test('explicit load retains support for runtimes whose load restores transcript history rather than native state', async () => {
  await ensure();
  clearAllSessions();
  runtime.capabilities.nativeResume = false;
  const response = await post('/chats/cancel-node/load', { cwd: directory });
  assert.equal(response.status, 200, await response.text());
  assert.equal(loaded.length, 1);
  assert.equal(created.length, 1);
});
