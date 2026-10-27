// Isolate configuration before importing runtime modules; only the provider is faked.
import { isolatedIntegrationDataDir, resetIntegrationConfig } from './isolatedIntegrationEnvironment';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ChatHub, chatHub, type StartedRequestedSelfTurn } from '../src/agents/chatHub';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions, dropSession } from '../src/agents/sessionRegistry';
import { sendToThreadTool, type ThreadMessagingDeps } from '../src/agents/threadMessageTool';
import type { AgentRuntime, AgentSession, NewAgentSessionOptions } from '../src/agents/types';
import { ChatManager } from '../src/services/chatManager';
import { closeDb, getDb, initDb } from '../src/services/db';
import { getNode, listMessages, updateNodeResumeBinding } from '../src/services/dbRepository';
import { loadAgentConfig } from '../src/services/agentConfig';
import { acquireSessionRestoreLock } from '../src/services/nativeResume';
import { buildPiTools } from '../src/agents/pi/piTools';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { chatOwner } from './helpers/owners';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';

let directory: string;
let manager: ChatManager;
let hub: ChatHub;
let deps: ThreadMessagingDeps;
let loads: number;
let fresh: number;
let released: number;
let asked: number;
let sends: string[];
let started: Array<Promise<StartedRequestedSelfTurn>>;
let foregroundGate: Promise<void> | undefined;
let releaseForeground: (() => void) | undefined;
const priorCloud = process.env.MICHI_CLOUD;
const caller = { ownerUserId: null, workspaceId: 'ws', nodeId: 'child', isAgentRun: false };
const approve = async () => { asked++; return { approved: true as const }; };

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(isolatedIntegrationDataDir, 'thread-delivery-'));
  process.env.MICHI_DATA_DIR = directory;
  delete process.env.MICHI_CLOUD;
  resetIntegrationConfig();
  closeDb(); initDb(); clearAllSessions(); loadAgentConfig();
  loads = fresh = released = asked = 0;
  sends = []; started = []; foregroundGate = undefined; releaseForeground = undefined;
  // A real desktop workspace may retain a Better-Auth/cloud owner from an older login.
  getDb().prepare("INSERT INTO workspaces (id,name,cwd,owner_user_id,created_at,updated_at) VALUES ('ws','Workspace',?,'old-account',1,1)").run(directory);
  getDb().prepare("INSERT INTO nodes (id,workspace_id,kind,status,created_at) VALUES ('parent','ws','chat','idle',1)").run();
  getDb().prepare("INSERT INTO nodes (id,workspace_id,parent_node_id,kind,status,created_at) VALUES ('child','ws','parent','chat','idle',2)").run();
  updateNodeResumeBinding('parent', { runtime_id: 'codex', acp_session_id: 'native-parent', model_id: 'test-model' });
  const session = (opts: NewAgentSessionOptions): AgentSession => ({
    id: opts.sessionId!, nativeSessionId: 'native-parent', runtimeId: 'codex', currentModelId: 'test-model',
    owner: chatOwner(opts.sessionId!),
    getHistory: () => [], getPendingAssistant: () => undefined, cancel() {},
    async *send(text) {
      sends.push(text);
      if (text === 'foreground' && foregroundGate) await foregroundGate;
      yield { kind: 'chunk', text: 'Received.' };
      yield { kind: 'turn_end', stopReason: 'end_turn' };
    },
  });
  const runtime: AgentRuntime = {
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    id: 'codex', label: 'Test Codex', capabilities: {
      modes: false, permissions: false, models: false, providerModels: false, reasoning: false,
      supportedReasoningLevels: [], apiKeys: false, warmSessions: false, saveContext: false,
      spawnBranches: true, nativeResume: true,
    },
    async warm() {}, async shutdown() {}, async releaseSession(id) { released++; dropSession(id); },
    async newSession(opts) { fresh++; return session(opts); },
    async loadSession(opts) { loads++; return session(opts); },
  };
  registerRuntime(runtime);
  manager = new ChatManager(undefined, directory);
  hub = new ChatHub({ retentionMs: 10, titleGenerator: null, journal: null });
  let turn = 0;
  deps = {
    ensureSession: (input) => manager.ensureParentSession(input),
    startTurn: (args) => { const start = hub.startRequestedSelfTurn(args); started.push(start); return start; },
    acquireRestoreLock: acquireSessionRestoreLock,
    newTurnId: () => `message-${++turn}`,
    startWaitMs: 10,
  };
});

afterEach(async () => {
  releaseForeground?.();
  for (const start of started) await (await start).done;
  clearAllSessions(); closeDb();
  if (priorCloud === undefined) delete process.env.MICHI_CLOUD;
  else process.env.MICHI_CLOUD = priorCloud;
  fs.rmSync(directory, { recursive: true, force: true });
});

async function send() {
  const result = await sendToThreadTool(caller, { nodeId: 'parent', text: 'Child finished; please review.' }, approve, deps);
  assert.equal(result.isError, undefined, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

test('a child restores its local parent with a legacy account owner and persists an attributed message without asking', async () => {
  assert.equal((await send()).status, 'started');
  await (await started[0]).done;
  assert.equal(asked, 0);
  assert.equal(loads, 1);
  assert.equal(fresh, 0);
  const messages = listMessages('parent');
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /Child finished; please review\./);
  assert.equal(JSON.parse(messages[0].metadata!).threadMessage.fromNodeId, 'child');
  assert.equal(messages[1].content, 'Received.');
  const durable = getDb().prepare('SELECT status FROM turns WHERE turn_id = ?').get('message-1') as { status: string };
  assert.equal(durable.status, 'completed');
});

test('a message to a busy parent queues on the same session and arrives once after the foreground completes', async () => {
  const session = await manager.ensureParentSession({ ownerUserId: 'local-user', workspaceId: 'ws', nodeId: 'parent' });
  assert.ok(session);
  foregroundGate = new Promise<void>((resolve) => { releaseForeground = resolve; });
  const foreground = await hub.startTurn({ chatId: 'parent', nodeId: 'parent', turnId: 'foreground', text: 'foreground', session });
  try {
    assert.equal((await send()).status, 'queued');
    assert.deepEqual(sends, ['foreground']);
    assert.equal(loads, 1, 'reuse the live session');
    assert.equal(released, 0);
  } finally {
    releaseForeground!();
    await foreground.done;
  }
  await (await started[0]).done;
  assert.equal(sends.length, 2);
  assert.match(sends[1], /Child finished; please review\./);
  assert.equal(asked, 0);
});

test('cloud recovery and messaging still reject a different account and allow the actual owner', async () => {
  process.env.MICHI_CLOUD = '1';
  const denied = await manager.ensureParentSession({ ownerUserId: 'other-account', workspaceId: 'ws', nodeId: 'parent' });
  assert.equal(denied, null);
  const result = await sendToThreadTool({ ...caller, ownerUserId: 'other-account' }, { nodeId: 'parent', text: 'hi' }, approve, deps);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^NOT_FOUND/);
  assert.equal(loads, 0);
  assert.equal(fresh, 0);
  const owned = await manager.ensureParentSession({ ownerUserId: 'old-account', workspaceId: 'ws', nodeId: 'parent' });
  assert.ok(owned);
  assert.equal(loads, 1);
});

test('parent recovery cannot replace a session while runtime cleanup still owns its turn', async (t) => {
  t.mock.method(chatHub, 'isActive', () => false);
  t.mock.method(chatHub, 'isOwnerTurnActive', () => true);
  await assert.rejects(manager.ensureParentSession({ ownerUserId: 'local-user', workspaceId: 'ws', nodeId: 'parent' }),
    (error: unknown) => error instanceof Error && (error as any).cause?.message === 'Cannot reload an active parent turn');
  assert.equal(loads, 0);
  assert.equal(fresh, 0);
  assert.equal(getNode('parent')!.acp_session_id, 'native-parent');
});

test('Pi forwards optional approval and delivers routine coordination without an approval callback', async () => {
  // Use the production-configured dependency path, as the Pi adapter does.
  const { configureThreadMessaging } = await import('../src/agents/threadMessageTool');
  configureThreadMessaging(deps);
  configureRuntimeDeps({
    dataDir: directory,
    historyStore: {
      getNode: () => null, listMessages: () => [], getWorkspace: () => null,
      getWorkspaceInstructions: () => null, hasGrant: () => false, grantPermission: () => {},
    },
    agentConfig: {
      getAgentConfig: () => ({ runtime: 'pi', provider: 'test', modelByRuntime: {}, reasoningByRuntime: {} }),
      resolveModel: () => 'test-model', resolveReasoning: () => undefined,
    },
  });
  try {
    const Type = new Proxy({}, { get: () => (..._args: unknown[]) => ({}) });
    const tool = buildPiTools({ bridge: {} as never, cwd: directory, parentChatId: 'child', workspaceId: 'ws',
      enableFollowUps: false, imageQuota: { usedBytes: 0, limitBytes: 1 } as never, seenPaths: new Set(), Type,
      owner: chatOwner('child'),
    }).find((candidate: any) => candidate.name === 'send_to_thread');
    assert.ok(tool);
    const sent = await tool.execute('send', { nodeId: 'parent', text: 'Pi report' });
    assert.equal(JSON.parse(sent.content[0].text).status, 'started');
    const blocked = await tool.execute('review', { nodeId: 'parent', text: 'Pi report', requestApproval: true });
    assert.match(blocked.content[0].text, /^APPROVAL_UNAVAILABLE/);
    assert.equal(started.length, 1);
  } finally {
    configureThreadMessaging(null);
    __resetRuntimeDeps();
  }
});
