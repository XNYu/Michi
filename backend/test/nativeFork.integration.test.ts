import { afterEach, beforeEach, test, type TestContext } from 'node:test';
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
import { getNode, updateNodeResumeBinding } from '../src/services/dbRepository';
import { getAgentConfig, loadAgentConfig, updateAgentConfig } from '../src/services/agentConfig';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions, getSession, dropSession } from '../src/agents/sessionRegistry';
import { NativeResumeUnavailableError } from '../src/services/nativeResume';
import { tryForkChatSession } from '../src/services/nativeFork';
import type { AgentRuntime, AgentSession, ForkAgentSessionOptions, NewAgentSessionOptions } from '../src/agents/types';

const originalEnv = { ...process.env };
let directory: string;
let server: ReturnType<typeof express.application.listen>;
let base: string;
let forks: ForkAgentSessionOptions[];
let fresh: NewAgentSessionOptions[];
let loads: string[];
let forkFailure: Error | undefined;
let runtime: AgentRuntime;
let manager: ChatManager;

beforeEach(async (t) => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-native-fork-'));
  process.env.MICHI_DATA_DIR = directory;
  delete process.env.MICHI_CLOUD;
  const configPath = path.join(os.homedir(), '.michi', 'config.json');
  const read = fs.readFileSync;
  const write = fs.writeFileSync;
  (t as TestContext).mock.method(fs, 'readFileSync', ((file: any, ...args: any[]) => file === configPath ? '{}' : (read as any)(file, ...args)) as typeof read);
  (t as TestContext).mock.method(fs, 'writeFileSync', ((file: any, ...args: any[]) => file === configPath ? undefined : (write as any)(file, ...args)) as typeof write);
  closeDb(); initDb(); clearAllSessions(); loadAgentConfig();
  forks = []; fresh = []; loads = []; forkFailure = undefined;
  const session = (opts: NewAgentSessionOptions, token: string): AgentSession => ({
    id: opts.sessionId!, nativeSessionId: token, runtimeId: 'codex', currentModelId: 'test-model',
    parentChatId: opts.parentChatId, getHistory: () => [], getPendingAssistant: () => undefined,
    async *send() { yield { kind: 'chunk', text: 'child response' }; yield { kind: 'turn_end', stopReason: 'end_turn' }; },
    async cancel() {},
  });
  runtime = {
    id: 'codex', label: 'Codex', capabilities: { modes: false, permissions: false, models: false,
      providerModels: false, reasoning: false, supportedReasoningLevels: [], apiKeys: false,
      warmSessions: false, saveContext: false, spawnBranches: true, nativeResume: true },
    async warm() {}, async shutdown() {}, async releaseSession(id) { dropSession(id); },
    async newSession(opts) { fresh.push(opts); return session(opts, `fresh-${fresh.length}`); },
    async forkSession(opts) {
      forks.push(opts);
      if (forkFailure) throw forkFailure;
      return session(opts, `fork-${forks.length}`);
    },
    async loadSession(opts) { loads.push(opts.sessionId); return session(opts, getNode(opts.sessionId)!.external_session_id!); },
  };
  registerRuntime(runtime);
  registerRuntime({ ...runtime, id: 'claude', label: 'Claude' });
  updateAgentConfig({ runtime: 'codex', modelByRuntime: { codex: 'test-model' } });
  getDb().prepare('INSERT INTO workspaces (id,name,cwd,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws', 'Fork Test', directory);
  getDb().prepare("INSERT INTO nodes (id,workspace_id,kind,status,created_at) VALUES ('parent','ws','chat','idle',1)").run();
  getDb().prepare("INSERT INTO nodes (id,workspace_id,parent_node_id,kind,status,created_at) VALUES ('child','ws','parent','chat','idle',2)").run();
  updateNodeResumeBinding('parent', { runtime_id: 'codex', acp_session_id: 'native-parent', model_id: 'test-model' });
  getDb().prepare("INSERT INTO messages (id,node_id,role,content,seq,created_at) VALUES ('parent-answer','parent','assistant','Parent answer',1,1)").run();
  const app = express();
  app.use(express.json());
  manager = new ChatManager(undefined, directory);
  app.use('/api', setupAgentRoutes());
  app.use('/api', setupMichiRoutes(manager));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearAllSessions(); closeDb(); process.env = { ...originalEnv };
  fs.rmSync(directory, { recursive: true, force: true });
});

async function post(endpoint: string, body: unknown) {
  return fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function ensure(extra: Record<string, unknown> = {}) {
  const response = await post('/nodes/child/ensure-session', { workspaceId: 'ws', cwd: directory, priorMessages: [], ...extra });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<any>;
}

test('HTTP branch forks once, persists a distinct child binding, and later resumes the child', async () => {
  const results = await Promise.all([ensure(), ensure(), ensure()]);
  assert.ok(results.some((result) => result.resumeReason === 'native_fork'));
  assert.equal(forks.length, 1);
  assert.equal(fresh.length, 0);
  assert.equal(forks[0].sourceNativeSessionId, 'native-parent');
  assert.equal(forks[0].parentChatId, 'parent');
  assert.deepEqual(forks[0].mergeContexts, []);
  assert.equal(getNode('parent')?.external_session_id, 'native-parent');
  assert.equal(getNode('child')?.external_session_id, 'fork-1');
  assert.equal(getSession('child')?.nativeSessionId, 'fork-1');
  clearAllSessions();
  assert.equal((await ensure()).resumeStrategy, 'exact');
  assert.deepEqual(loads, ['child']);
  assert.equal(forks.length, 1);
});

test('a first user message already persisted by the renderer does not disable native fork', async () => {
  getDb().prepare("INSERT INTO messages (id,node_id,role,content,seq,created_at) VALUES ('pending-user','child','user','branch question',1,2)").run();
  assert.equal((await ensure()).resumeReason, 'native_fork');
});

test('native fork skips textual ancestor replay but retains explicitly attached context', async () => {
  await ensure({ mergeContexts: ['explicit context'], extraContexts: [{ name: 'reference', filePath: 'notes.md' }] });
  assert.deepEqual(forks[0].mergeContexts, ['explicit context']);
  assert.equal(forks[0].extraContexts?.[0].filePath, 'notes.md');
});

for (const scenario of ['other-runtime', 'active-parent', 'no-native-id', 'existing-child', 'custom-agent', 'other-workspace', 'other-owner']) {
  test(`native fork conservatively declines ${scenario}`, async () => {
    if (scenario === 'other-runtime') getDb().prepare("UPDATE nodes SET runtime_id='kiro' WHERE id='parent'").run();
    if (scenario === 'active-parent') getDb().prepare("UPDATE nodes SET status='streaming' WHERE id='parent'").run();
    if (scenario === 'no-native-id') getDb().prepare("UPDATE nodes SET acp_session_id=NULL, external_session_id=NULL WHERE id='parent'").run();
    if (scenario === 'existing-child') getDb().prepare("INSERT INTO messages (id,node_id,role,content,seq,created_at) VALUES ('answer','child','assistant','Already answered',1,2)").run();
    if (scenario === 'custom-agent') getDb().prepare(`UPDATE nodes SET agent_effective_definition='{"version":1}' WHERE id='parent'`).run();
    if (scenario === 'other-workspace') {
      getDb().prepare("INSERT INTO workspaces (id,name,created_at,updated_at) VALUES ('other','Other',1,1)").run();
      getDb().prepare("UPDATE nodes SET workspace_id='other' WHERE id='parent'").run();
    }
    if (scenario === 'other-owner') getDb().prepare("UPDATE workspaces SET owner_user_id='other-user' WHERE id='ws'").run();
    assert.equal(await tryForkChatSession(runtime, { sessionId: 'child', cwd: directory, workspaceId: 'ws' }), null);
    assert.equal(forks.length, 0);
  });
}

test('unsupported native fork falls back to a fresh session with parent context', async () => {
  forkFailure = new NativeResumeUnavailableError('parent rollout missing');
  await ensure();
  assert.equal(forks.length, 1);
  assert.equal(fresh.length, 1);
  assert.match(fresh[0].mergeContexts!.join('\n'), /Parent answer/);
  assert.equal(getNode('parent')?.external_session_id, 'native-parent');
});

test('ambiguous fork errors do not silently downgrade or publish a child binding', async () => {
  forkFailure = new Error('connection timed out');
  const response = await post('/nodes/child/ensure-session', { cwd: directory, workspaceId: 'ws' });
  assert.equal(response.status, 500);
  assert.equal(fresh.length, 0);
  assert.equal(getNode('child')?.external_session_id, null);
  assert.equal(getNode('parent')?.external_session_id, 'native-parent');
});

test('Native Resume setting is per-runtime, preserves active sessions, and does not disable native fork', async () => {
  assert.equal((await post('/agent/options', { nativeResumeByRuntime: { codex: false } })).status, 200);
  assert.equal((await post('/agent/options', { nativeResumeByRuntime: { claude: true } })).status, 200);
  assert.deepEqual(getAgentConfig().nativeResumeByRuntime, { codex: false, claude: true });
  const status = await (await fetch(`${base}/agent/status`)).json() as any;
  assert.deepEqual(status.nativeResumeByRuntime, { codex: false, claude: true });
  await ensure();
  assert.equal(forks.length, 1);
  assert.equal((await ensure()).resumeStrategy, 'live');
  clearAllSessions();
  const rebuilt = await ensure();
  assert.equal(rebuilt.resumeStrategy, 'compatible');
  assert.equal(rebuilt.resumeReason, 'native_resume_disabled');
  assert.equal(loads.length, 0);
  assert.equal(fresh.length, 1);
  await post('/agent/options', { nativeResumeByRuntime: { codex: true } });
  clearAllSessions();
  assert.equal((await ensure()).resumeStrategy, 'exact');
  assert.equal(loads.length, 1);
});

test('explicit load and background parent recovery also respect Native Resume off', async () => {
  updateAgentConfig({ nativeResumeByRuntime: { codex: false } });
  const response = await post('/chats/parent/load', { nodeId: 'parent', cwd: directory, workspaceId: 'ws' });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(loads.length, 0);
  assert.match(fresh[0].mergeContexts!.join('\n'), /Parent answer/);
  clearAllSessions();
  const session = await manager.ensureParentSession({ ownerUserId: 'local-user', workspaceId: 'ws', nodeId: 'parent' });
  assert.ok(session);
  assert.equal(loads.length, 0);
  assert.match(fresh[1].mergeContexts!.join('\n'), /Parent answer/);
});

test('invalid setting maps are rejected without mutating saved preferences', async () => {
  for (const value of [null, [], true, { codex: 'false' }, { unknown: false }]) {
    assert.equal((await post('/agent/options', { nativeResumeByRuntime: value })).status, 400);
  }
  assert.deepEqual(getAgentConfig().nativeResumeByRuntime, {});
});
