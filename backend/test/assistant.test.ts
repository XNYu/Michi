import { PI_RUNTIME_DESCRIPTOR } from '../src/agents/pi/piDescriptor';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime';
/**
 * The Michi assistant's home and session binding: provisioning (idempotent,
 * concurrency-safe), settings, reset, the local-only routes, server-owned
 * workspace settings no workspace write can set, change or drop, and the
 * non-worker session options (profile, instructions, working directory)
 * every session path applies. Temp MICHI_DATA_DIR per test; runtimes are
 * fakes that record their session options.
 */

// Must stay first: agentConfig would otherwise persist these fixtures to ~/.michi/config.json.
import './isolatedConfigDir';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { MICHI_ASSISTANT_MARKER, parseEffectiveAgentDefinitionV1, type MichiAssistantInfo } from 'michi-shared';
import type { AgentRuntime, AgentSession, NewAgentSessionOptions } from '../src/agents/types';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions } from '../src/agents/sessionRegistry';
import { closeDb, getDb, getDbPath, initDb } from '../src/services/db';
import { dbWorker, initDbWorker, shutdownDbWorker } from '../src/services/dbWorkerClient';
import { getNode, getWorkspace, listMessages, listWorkspaces, loadFullWorkspace, saveMessage, saveWorkspace } from '../src/services/dbRepository';
import { resolveModel, updateAgentConfig } from '../src/services/agentConfig';
import { getMetaAgentSettings, updateMetaAgentSettings } from '../src/services/metaAgent/settings';
import { applyWorkspaceCommands } from '../src/services/domainCommands';
import { ChatManager, PrimaryAgentBindingError, primaryAgentSessionOptions } from '../src/services/chatManager';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { setupMichiRoutes } from '../src/routes/michi';
import { createRemoteAccessMiddleware } from '../src/services/remoteAccess';
import { setupAssistantRoutes } from '../src/routes/assistant';
import { createLocalOriginGuard } from '../src/routes/middleware/localControl';
import { setupBackupRoutes } from '../src/routes/backup';
import {
  activateAssistantConversation, assistantCwd, assistantCwdFor, assistantPurposeOf, ensureAssistant, ensureAssistantFor, isAssistantNode, isAssistantWorkspace,
  resetAssistant, updateAssistantSettings,
} from '../src/assistant/store';
import { ASSISTANT_ALLOWED_TOOL_NAMES, ASSISTANT_INSTRUCTIONS, SCHEDULE_ASSISTANT_INSTRUCTIONS } from '../src/assistant/policy';
import { createHash } from 'node:crypto';
import { ChatHub, chatHub } from '../src/agents/chatHub';

let captured: Array<NewAgentSessionOptions & { runtimeId: string }> = [];

function fakeRuntime(id: string, providerModels = false): AgentRuntime {
  const runtime: AgentRuntime = {
    descriptor: id === 'pi' ? PI_RUNTIME_DESCRIPTOR : UNKNOWN_RUNTIME_DESCRIPTOR,
    id, label: id,
    capabilities: {
      modes: false, permissions: true, models: false, providerModels,
      reasoning: true, supportedReasoningLevels: ['low', 'medium', 'high'], apiKeys: false,
      warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false,
    },
    async warm() {},
    async newSession(options) {
      captured.push({ ...options, runtimeId: id });
      const session: AgentSession = {
        id: options.sessionId!, runtimeId: id,
        runtimeProfileHash: options.profileHash ?? null,
        currentModelId: options.model ?? null, getHistory: () => [],
        getPendingAssistant: () => undefined,
        async *send() {}, async cancel() {},
      };
      return session;
    },
    async loadSession(options) {
      return runtime.newSession(options);
    },
    async releaseSession() {},
    async shutdown() {},
  };
  return runtime;
}

for (const id of ['claude', 'codex', 'kiro', 'crew']) registerRuntime(fakeRuntime(id));
registerRuntime(fakeRuntime('pi', true));

let tmpDir: string;
let server: http.Server;
let base: string;

const RUNTIMES = ['claude', 'codex', 'kiro', 'crew', 'pi'];

/** Replaces the global settings: the per-runtime maps merge on update, so every runtime's entry is reset. */
function setGlobal(runtime: string, model?: string): void {
  const none = Object.fromEntries(RUNTIMES.map((id) => [id, undefined])) as Record<string, never>;
  updateAgentConfig({
    runtime,
    providerByRuntime: { ...none, pi: 'anthropic' },
    modelByRuntime: { ...none, claude: 'claude-model', ...(model ? { [runtime]: model } : {}) },
    reasoningByRuntime: { ...none },
  });
}

function seedWorkspace(id: string, settings: string | null = null): void {
  saveWorkspace({ id, name: `Workspace ${id}`, cwd: tmpDir, created_at: 1, updated_at: 1, settings });
}

function raw(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname, port: url.port, method, path: p,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const get = () => raw('GET', '/api/assistant');

function assistantWorkspaces() {
  return listWorkspaces().filter((ws) => isAssistantWorkspace(ws.id));
}

describe('Michi assistant', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-assistant-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    // Agent Desk off, as a backend starts by default.
    delete process.env.MICHI_DESK;
    closeDb(); initDb(); captured = []; clearAllSessions();
    setGlobal('claude');
    const app = express();
    app.use(express.json());
    app.use('/api', createRemoteAccessMiddleware());
    app.use('/api', setupAssistantRoutes());
    app.use('/api', setupMichiRoutes(new ChatManager(undefined, tmpDir)));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    clearAllSessions();
    await shutdownDbWorker();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('runs in a folder Agent Desk takes for temporary, whatever the data directory, keeping production’s', () => {
    const home = path.join(path.sep, 'Users', 'me');
    assert.equal(assistantCwdFor(path.join(home, '.michi')), path.join(home, '.michi', 'assistant'));
    assert.equal(assistantCwdFor(path.join(home, '.michi-dev')), path.join(home, '.michi-dev', 'assistant', '.michi'));
    assert.equal(assistantCwdFor(path.join(path.sep, 'tmp', 'run', 'data')), path.join(path.sep, 'tmp', 'run', 'data', 'assistant', '.michi'));
  });

  test('makes its own folders private and leaves the data directory as it was', () => {
    // Production's layout: the data directory is the `.michi` folder itself.
    const dataDir = path.join(tmpDir, '.michi');
    fs.mkdirSync(dataDir, { mode: 0o755 });
    fs.chmodSync(dataDir, 0o755);
    process.env.MICHI_DATA_DIR = dataDir;
    try {
      const cwd = assistantCwd();
      assert.equal(cwd, path.join(path.resolve(dataDir), 'assistant'));
      assert.equal(fs.statSync(cwd).mode & 0o777, 0o700);
      assert.equal(fs.statSync(dataDir).mode & 0o777, 0o755);
    } finally {
      process.env.MICHI_DATA_DIR = tmpDir;
    }
  });

  test('opens every conversation with the marker Michi filtering relies on', () => {
    assert.ok(ASSISTANT_INSTRUCTIONS.startsWith(MICHI_ASSISTANT_MARKER));
    // Michi titles a Codex conversation by its first line, cut to 96 characters.
    assert.ok(MICHI_ASSISTANT_MARKER.length <= 96 && !MICHI_ASSISTANT_MARKER.includes('\n'));
  });

  test('GET provisions one hidden workspace and conversation, idempotently', async () => {
    const first = await get();
    assert.equal(first.status, 200);
    const info = first.body as MichiAssistantInfo;
    assert.deepEqual(info.supportedRuntimes, ['claude', 'codex', 'pi', 'kiro'], 'Crew cannot host the assistant');
    assert.deepEqual(info.settings, { runtimeId: 'claude', providerId: null, modelId: 'claude-model', reasoning: 'high' },
      'new conversations run on the global settings');
    assert.deepEqual(info.conversation, info.settings, 'and so does one with no pick of its own');
    assert.equal(info.conversationFollowsGlobal, true);
    assert.deepEqual(info.runtimeSwitches, []);

    const workspace = getWorkspace(info.workspaceId)!;
    assert.equal(workspace.name, 'Michi assistant');
    assert.equal(JSON.parse(workspace.settings!).system, 'assistant');
    assert.equal(workspace.active_tree_id, info.treeId);
    // Inside a `.michi` folder, which Agent Desk never makes a project of.
    const cwd = path.join(path.resolve(tmpDir), 'assistant', '.michi');
    assert.equal(workspace.cwd, cwd);
    assert.equal(fs.statSync(cwd).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.dirname(cwd)).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(cwd), [], 'nothing in it for the assistant to read');

    const node = getDb().prepare('SELECT * FROM nodes WHERE id = ?').get(info.nodeId) as any;
    assert.equal(node.kind, 'chat');
    assert.equal(node.title, 'Assistant');
    assert.equal(node.tree_id, info.treeId);
    assert.ok(isAssistantNode(info.nodeId));

    const second = await get();
    assert.deepEqual(second.body, info);
    assert.equal(assistantWorkspaces().length, 1);
  });

  test('concurrent first calls create exactly one workspace and one node', async () => {
    const answers = await Promise.all(Array.from({ length: 8 }, () => get()));
    assert.ok(answers.every((a) => a.status === 200));
    assert.equal(new Set(answers.map((a) => a.body.nodeId)).size, 1);
    const workspaces = assistantWorkspaces();
    assert.equal(workspaces.length, 1);
    const nodes = getDb().prepare('SELECT COUNT(*) AS n FROM nodes WHERE workspace_id = ?').get(workspaces[0].id) as { n: number };
    assert.equal(nodes.n, 1);
  });

  test('a pick in a conversation: validated, kept for it alone, and a runtime switch starts from that runtime\'s global settings', async () => {
    await get();
    assert.equal((await raw('PUT', '/api/assistant/settings', { runtimeId: 'gemini' })).status, 400, 'only registered runtimes');
    assert.equal((await raw('PUT', '/api/assistant/settings', { runtimeId: null })).status, 400);
    // Whether a runtime can host the assistant is decided when its session starts.
    for (const runtimeId of ['kiro', 'crew', 'claude']) {
      const answer = await raw('PUT', '/api/assistant/settings', { runtimeId });
      assert.equal(answer.status, 200, runtimeId);
      assert.equal(answer.body.conversation.runtimeId, runtimeId);
      assert.equal(answer.body.settings.runtimeId, 'claude', 'the global settings stay as they are');
    }
    assert.equal((await raw('PUT', '/api/assistant/settings', { reasoning: 'loud' })).status, 400);
    assert.equal((await raw('PUT', '/api/assistant/settings', { modelId: '' })).status, 400);
    assert.equal((await raw('PUT', '/api/assistant/settings', { modelId: '--dangerously-skip-permissions' })).status, 400, 'a model id never reads as a CLI flag');
    assert.equal((await raw('PUT', '/api/assistant/settings', { modelId: 'opus; rm -rf /' })).status, 400);
    assert.equal((await raw('PUT', '/api/assistant/settings', { runtimeId: 'claude', extra: 1 })).status, 400);
    assert.equal((await raw('PUT', '/api/assistant/settings', { providerId: '--x' })).status, 400);
    seedWorkspace('ws-plain');
    getDb().prepare(`INSERT INTO nodes (id,workspace_id,kind,status,minimized,spawned_by_agent,created_at)
      VALUES ('n-plain','ws-plain','chat','idle',0,0,1)`).run();
    assert.equal((await raw('PUT', '/api/assistant/settings', { nodeId: 'n-plain', modelId: 'opus' })).status, 400, 'only the assistant\'s own conversations');
    assert.equal((await raw('PUT', '/api/assistant/settings', { nodeId: 7 })).status, 400);
    for (const modelId of ['claude-sonnet-4-5', 'global.anthropic.claude-opus-5-5[1m]', 'openai/gpt-5', 'arn:aws:bedrock:us-east-1:1:inference-profile/x']) {
      assert.equal((await raw('PUT', '/api/assistant/settings', { modelId })).status, 200, modelId);
    }

    const model = await raw('PUT', '/api/assistant/settings', { modelId: 'opus', reasoning: 'low' });
    assert.equal(model.status, 200);
    assert.deepEqual(model.body.conversation, { runtimeId: 'claude', providerId: null, modelId: 'opus', reasoning: 'low' });
    assert.equal(model.body.conversationFollowsGlobal, false);

    const switched = await raw('PUT', '/api/assistant/settings', { runtimeId: 'codex' });
    assert.deepEqual(switched.body.conversation, { runtimeId: 'codex', providerId: null, modelId: null, reasoning: 'xhigh' },
      'Codex\'s own global settings, not Claude\'s model or reasoning');
    assert.deepEqual((await get()).body.conversation, switched.body.conversation);

    // Global changes reach new conversations, never a picked one.
    setGlobal('kiro', 'kiro-model');
    const later = (await get()).body as MichiAssistantInfo;
    assert.deepEqual(later.conversation, switched.body.conversation);
    assert.equal(later.settings.runtimeId, 'kiro');
  });

  test('an existing assistant\'s own settings move into the Meta agent record once; the assistant follows global', async () => {
    saveWorkspace({ id: 'p-assistant-old', name: 'Michi assistant', cwd: tmpDir, created_at: 1, updated_at: 1, settings: null });
    getDb().prepare('UPDATE workspaces SET settings = ? WHERE id = ?').run(JSON.stringify({
      system: 'assistant', assistant: { nodeId: null, runtimeId: 'codex', modelId: 'gpt-x', reasoning: null },
    }), 'p-assistant-old');
    const info = (await get()).body as MichiAssistantInfo;
    assert.equal(info.workspaceId, 'p-assistant-old');
    const record = getMetaAgentSettings();
    assert.deepEqual({ runtimeId: record.runtimeId, modelId: record.modelId }, { runtimeId: 'codex', modelId: 'gpt-x' });
    assert.equal(info.conversation.runtimeId, 'claude', 'the assistant itself runs on the global settings');
    assert.deepEqual(JSON.parse(getWorkspace(info.workspaceId)!.settings!).assistant, { nodeId: info.nodeId });

    // A pick lives outside the workspace row; the old keys never come back.
    const changed = (await raw('PUT', '/api/assistant/settings', { runtimeId: 'pi' })).body as MichiAssistantInfo;
    assert.equal(changed.conversation.runtimeId, 'pi');
    assert.deepEqual(JSON.parse(getWorkspace(info.workspaceId)!.settings!).assistant, { nodeId: info.nodeId });
    assert.equal(getMetaAgentSettings().runtimeId, 'codex', 'nor does it change the Meta agent record');
    assert.deepEqual((await get()).body, changed);
  });

  test('reset archives the conversation and starts a fresh one on the global settings', async () => {
    const before = (await raw('PUT', '/api/assistant/settings', { runtimeId: 'pi' })).body as MichiAssistantInfo;
    saveMessage({ id: 'before-new-conversation', node_id: before.nodeId, role: 'user', content: 'Keep the previous conversation', seq: 0, created_at: 1 });
    const reset = await raw('POST', '/api/assistant/reset');
    assert.equal(reset.status, 200);
    const after = reset.body as MichiAssistantInfo;
    assert.notEqual(after.nodeId, before.nodeId);
    assert.notEqual(after.treeId, before.treeId);
    assert.equal(after.workspaceId, before.workspaceId);
    assert.equal(before.conversation.runtimeId, 'pi');
    assert.equal(after.conversation.runtimeId, 'claude', 'a pick stays with its conversation');
    assert.equal(after.conversationFollowsGlobal, true);
    const oldTree = getDb().prepare('SELECT archived_at FROM trees WHERE id = ?').get(before.treeId) as any;
    assert.ok(oldTree.archived_at, 'old conversation is archived, not deleted');
    assert.equal(listMessages(before.nodeId)[0].content, 'Keep the previous conversation');
    assert.equal(listMessages(after.nodeId).length, 0);
    assert.ok(isAssistantNode(before.nodeId), 'an archived conversation still runs as the assistant');
    assert.deepEqual((await get()).body, after);
    assert.equal(getWorkspace(after.workspaceId)!.active_tree_id, after.treeId);

    // A window still showing the old conversation does not archive the new one.
    const stale = await raw('POST', '/api/assistant/reset', { nodeId: before.nodeId });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'assistant_changed');
    assert.deepEqual(stale.body.current, after);
    assert.equal((await raw('POST', '/api/assistant/reset', { nodeId: 7 })).status, 400);
    const again = await raw('POST', '/api/assistant/reset', { nodeId: after.nodeId });
    assert.equal(again.status, 200);
    assert.notEqual(again.body.nodeId, after.nodeId);
  });

  test('a deleted assistant workspace is replaced on the next call', async () => {
    const first = (await get()).body as MichiAssistantInfo;
    getDb().prepare('UPDATE workspaces SET deleted_at = 5 WHERE id = ?').run(first.workspaceId);
    const second = (await get()).body as MichiAssistantInfo;
    assert.notEqual(second.workspaceId, first.workspaceId);
  });

  test('history is paged newest first, survives reset and resumes the original conversation', async () => {
    assert.deepEqual((await raw('GET', '/api/assistant/conversations')).body, { items: [], nextCursor: null });
    const saved: MichiAssistantInfo[] = [];
    for (let i = 0; i < 7; i++) {
      const info = (await get()).body as MichiAssistantInfo;
      saved.push(info);
      saveMessage({ id: `history-${i}`, node_id: info.nodeId, role: 'user', content: `Question ${i}`, seq: 0, created_at: 100 + i });
      await raw('POST', '/api/assistant/reset', { nodeId: info.nodeId });
    }
    const current = (await get()).body as MichiAssistantInfo;
    const first = await raw('GET', '/api/assistant/conversations?limit=5');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.items.map((item: any) => item.title), ['Question 6', 'Question 5', 'Question 4', 'Question 3', 'Question 2']);
    const second = await raw('GET', `/api/assistant/conversations?cursor=${encodeURIComponent(first.body.nextCursor)}`);
    assert.deepEqual(second.body.items.map((item: any) => item.title), ['Question 1', 'Question 0']);
    assert.equal(second.body.nextCursor, null);
    const resumed = await raw('POST', `/api/assistant/conversations/${saved[0].nodeId}/activate`, { currentNodeId: current.nodeId });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.nodeId, saved[0].nodeId);
    assert.equal((await get()).body.nodeId, saved[0].nodeId);
    assert.equal(listMessages(saved[0].nodeId)[0].content, 'Question 0');
    const tree = getDb().prepare('SELECT archived_at FROM trees WHERE id = ?').get(saved[0].treeId) as any;
    assert.equal(tree.archived_at, null);
    const stale = await raw('POST', `/api/assistant/conversations/${saved[1].nodeId}/activate`, { currentNodeId: current.nodeId });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'assistant_changed');
    assert.equal((await raw('GET', '/api/assistant/conversations?limit=999')).status, 400);
    assert.equal((await raw('GET', '/api/assistant/conversations?cursor=broken')).status, 400);
    seedWorkspace('other');
    assert.equal((await raw('POST', '/api/assistant/conversations/not-an-assistant-node/activate', { currentNodeId: saved[0].nodeId })).status, 400);
    getDb().prepare('UPDATE nodes SET deleted_at = 1 WHERE id = ?').run(saved[1].nodeId);
    assert.ok(!(await raw('GET', '/api/assistant/conversations?limit=50')).body.items.some((item: any) => item.nodeId === saved[1].nodeId));
    assert.equal((await raw('POST', `/api/assistant/conversations/${saved[1].nodeId}/activate`, { currentNodeId: saved[0].nodeId })).status, 400);
  });

  test('switching history waits for the active turn and runtime cleanup', async (t) => {
    const previous = (await get()).body as MichiAssistantInfo;
    await raw('POST', '/api/assistant/reset', { nodeId: previous.nodeId });
    const current = (await get()).body as MichiAssistantInfo;
    for (const guard of ['isActive', 'isOwnerTurnActive', 'hasPendingSelfTurn'] as const) {
      const mocked = t.mock.method(chatHub, guard, (id: string) => id === current.nodeId);
      const blocked = await raw('POST', `/api/assistant/conversations/${previous.nodeId}/activate`, { currentNodeId: current.nodeId });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.code, 'assistant_busy');
      assert.equal((await get()).body.nodeId, current.nodeId);
      mocked.mock.restore();
    }
  });

  test('the Scheduled window has its own conversation: own pointer, reset, instructions and hash, never in Spaces history', async () => {
    const spaces = (await get()).body as MichiAssistantInfo;
    const activeTree = getWorkspace(spaces.workspaceId)!.active_tree_id;
    const opened = await raw('GET', '/api/assistant/schedule');
    assert.equal(opened.status, 200);
    const first = opened.body as MichiAssistantInfo;
    assert.equal(first.workspaceId, spaces.workspaceId, 'one hidden workspace: Pages Home keeps its home');
    assert.equal(assistantWorkspaces().length, 1);
    assert.notEqual(first.nodeId, spaces.nodeId);
    assert.deepEqual((await raw('GET', '/api/assistant/schedule')).body, first, 'idempotent');
    assert.equal((await get()).body.nodeId, spaces.nodeId, 'the Spaces conversation stays current');
    assert.equal(getWorkspace(spaces.workspaceId)!.active_tree_id, activeTree, 'the active tree stays the Spaces one');
    assert.equal(assistantPurposeOf(first.nodeId), 'schedule');
    assert.equal(assistantPurposeOf(spaces.nodeId), 'spaces');
    assert.ok(isAssistantNode(first.nodeId), 'it runs as the assistant, never as a worker');

    const manager = new ChatManager(undefined, tmpDir);
    const bindingOf = async (nodeId: string) => (await manager.resolvePrimaryAgentBinding({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: first.workspaceId, nodeId }))!;
    const scheduleBinding = await bindingOf(first.nodeId);
    const spacesBinding = await bindingOf(spaces.nodeId);
    assert.equal(primaryAgentSessionOptions(scheduleBinding).bootstrapInstructions, SCHEDULE_ASSISTANT_INSTRUCTIONS);
    assert.ok(SCHEDULE_ASSISTANT_INSTRUCTIONS.startsWith(MICHI_ASSISTANT_MARKER), 'opens with the marker Michi filtering relies on');
    assert.equal(primaryAgentSessionOptions(spacesBinding).bootstrapInstructions, ASSISTANT_INSTRUCTIONS);
    assert.notEqual(scheduleBinding.profileHash, spacesBinding.profileHash, 'its sessions are its own');
    assert.equal(spacesBinding.profileHash, createHash('sha256').update(JSON.stringify({
      assistant: 2, instructions: ASSISTANT_INSTRUCTIONS, tools: ASSISTANT_ALLOWED_TOOL_NAMES,
      runtimeProfile: spacesBinding.effectiveDefinition.runtimeProfile,
    })).digest('hex'), 'the Spaces hash is unchanged, so its live sessions are kept');

    // A composer pick in the Scheduled window answers with that window's conversation.
    const picked = await raw('PUT', '/api/assistant/settings', { nodeId: first.nodeId, runtimeId: 'pi' });
    assert.equal(picked.status, 200, JSON.stringify(picked.body));
    assert.equal(picked.body.nodeId, first.nodeId);
    assert.equal(picked.body.conversation.runtimeId, 'pi');
    assert.equal((await get()).body.conversation.runtimeId, 'claude');

    // Starting over touches only its own window.
    saveMessage({ id: 'schedule-q', node_id: first.nodeId, role: 'user', content: 'Every weekday at nine', seq: 0, created_at: 50 });
    saveMessage({ id: 'spaces-q', node_id: spaces.nodeId, role: 'user', content: 'What changed today', seq: 0, created_at: 40 });
    const stale = await raw('POST', '/api/assistant/schedule/reset', { nodeId: spaces.nodeId });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'assistant_changed');
    assert.equal(stale.body.current.nodeId, first.nodeId);
    const reset = await raw('POST', '/api/assistant/schedule/reset', { nodeId: first.nodeId });
    assert.equal(reset.status, 200);
    const second = reset.body as MichiAssistantInfo;
    assert.notEqual(second.nodeId, first.nodeId);
    assert.equal(assistantPurposeOf(second.nodeId), 'schedule');
    assert.ok((getDb().prepare('SELECT archived_at FROM trees WHERE id = ?').get(first.treeId) as any).archived_at);
    assert.equal((await get()).body.nodeId, spaces.nodeId);
    const spacesReset = await raw('POST', '/api/assistant/reset', { nodeId: spaces.nodeId });
    assert.equal(spacesReset.status, 200);
    assert.equal((await raw('GET', '/api/assistant/schedule')).body.nodeId, second.nodeId);

    // History and switching belong to the Spaces window.
    const history = (await raw('GET', '/api/assistant/conversations?limit=50')).body.items.map((item: any) => item.nodeId);
    assert.deepEqual(history, [spaces.nodeId]);
    const refused = await raw('POST', `/api/assistant/conversations/${first.nodeId}/activate`, { currentNodeId: spacesReset.body.nodeId });
    assert.equal(refused.status, 400);
    assert.equal((await get()).body.nodeId, spacesReset.body.nodeId);
  });

  test('a Scheduled conversation made first leaves the Spaces one its own pointer and active tree', () => {
    const schedule = ensureAssistantFor('schedule');
    const spaces = ensureAssistant();
    assert.equal(spaces.workspaceId, schedule.workspaceId);
    assert.notEqual(spaces.nodeId, schedule.nodeId);
    assert.equal(ensureAssistantFor('schedule').nodeId, schedule.nodeId);
    assert.equal(ensureAssistant().nodeId, spaces.nodeId);
    assert.equal(getWorkspace(spaces.workspaceId)!.active_tree_id, spaces.treeId);
    assert.equal(assistantWorkspaces().length, 1);
  });

  test('ChatHub hands uploaded text and native images to the assistant without changing ordinary chat attachments', async () => {
    const info = (await get()).body as MichiAssistantInfo;
    const dir = path.join(assistantCwd(), '.attachments'); fs.mkdirSync(dir);
    const text = path.join(dir, 'notes.txt'); fs.writeFileSync(text, 'Uploaded release context');
    const image = path.join(dir, 'screen.png'); fs.writeFileSync(image, 'image fixture');
    const attachments = [{ name: 'notes', absPath: text }, { name: 'screen', absPath: image }];
    const received: Array<{ text: string; attachments: unknown }> = [];
    const session: AgentSession = {
      id: info.nodeId, runtimeId: 'claude', getHistory: () => [], getPendingAssistant: () => undefined,
      async *send(text, options) { received.push({ text, attachments: options?.attachments }); yield { kind: 'turn_end', stopReason: 'end_turn' }; },
      cancel() {},
    };
    const noop = () => {};
    const hub = new ChatHub({ retentionMs: 1, workspaceIdForNode: () => info.workspaceId,
      persistence: { begin: noop, checkpoint: noop, finalize: noop }, pageManifestBuilder: () => '' });
    const first = await hub.startTurn({ chatId: info.nodeId, nodeId: info.nodeId, text: 'Review', userMetadata: { attachments }, session });
    await first.done;
    assert.match(received[0].text, /Uploaded release context/);
    assert.deepEqual(received[0].attachments, [{ name: 'screen', absPath: fs.realpathSync(image) }]);
    const ordinary = await hub.startTurn({ chatId: 'ordinary', nodeId: 'ordinary', text: 'Review', userMetadata: { attachments }, session });
    await ordinary.done;
    assert.deepEqual(received[1], { text: 'Review', attachments });
  });

  test('authenticated remote owners can open, configure and switch assistant conversations', async () => {
    const priorRemote = process.env.MICHI_REMOTE_ACCESS;
    const priorToken = process.env.MICHI_REMOTE_TOKEN;
    process.env.MICHI_REMOTE_ACCESS = '1';
    process.env.MICHI_REMOTE_TOKEN = 'assistant-test-owner-token';
    const headers = { host: 'michi.example', origin: 'https://michi.example', authorization: 'Bearer assistant-test-owner-token' };
    try {
      for (const authorization of ['', 'Bearer wrong']) {
        assert.equal((await raw('GET', '/api/assistant', undefined, { ...headers, authorization })).status, 401);
        assert.equal((await raw('POST', '/api/assistant/reset', {}, { ...headers, authorization })).status, 401);
      }
      const initial = await raw('GET', '/api/assistant', undefined, headers);
      assert.equal(initial.status, 200);
      assert.ok(initial.body.nodeId);
      assert.equal((await raw('PUT', '/api/assistant/settings', { modelId: 'opus' }, headers)).status, 200);
      assert.equal((await raw('GET', '/api/assistant/conversations', undefined, headers)).status, 200);
      const reset = await raw('POST', '/api/assistant/reset', { nodeId: initial.body.nodeId }, headers);
      assert.equal(reset.status, 200);
      assert.notEqual(reset.body.nodeId, initial.body.nodeId);
      const activated = await raw('POST', '/api/assistant/conversations/' + initial.body.nodeId + '/activate', { currentNodeId: reset.body.nodeId }, headers);
      assert.equal(activated.status, 200);
      assert.equal(activated.body.nodeId, initial.body.nodeId);
    } finally {
      if (priorRemote === undefined) delete process.env.MICHI_REMOTE_ACCESS; else process.env.MICHI_REMOTE_ACCESS = priorRemote;
      if (priorToken === undefined) delete process.env.MICHI_REMOTE_TOKEN; else process.env.MICHI_REMOTE_TOKEN = priorToken;
    }
  });

  test('routes are local-only', async (t) => {
    const devRenderer = process.env.MICHI_DEV_RENDERER;
    process.env.MICHI_DEV_RENDERER = '1';
    t.after(() => { if (devRenderer === undefined) delete process.env.MICHI_DEV_RENDERER; else process.env.MICHI_DEV_RENDERER = devRenderer; });
    assert.equal((await raw('GET', '/api/assistant', undefined, { host: 'evil.example' })).status, 403);
    assert.equal((await raw('GET', '/api/assistant', undefined, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await raw('POST', '/api/assistant/reset', undefined, { host: 'evil.example' })).status, 403);
    // Michi's own renderers pass, also behind server.ts's app-wide origin guard:
    // the app's loopback origin and the Vite dev server.
    const guarded = express();
    guarded.use(createLocalOriginGuard({ loopbackListener: true }));
    guarded.use(express.json());
    guarded.use('/api', setupAssistantRoutes());
    const guardedServer = guarded.listen(0, '127.0.0.1');
    await new Promise((resolve) => guardedServer.once('listening', resolve));
    const direct = base;
    base = `http://127.0.0.1:${(guardedServer.address() as AddressInfo).port}`;
    try {
      for (const origin of [base, 'http://localhost:3001']) {
        assert.equal((await raw('GET', '/api/assistant', undefined, { origin })).status, 200, origin);
      }
      for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { host: 'evil.example' }] as Record<string, string>[]) {
        assert.equal((await raw('GET', '/api/assistant', undefined, headers)).status, 403, JSON.stringify(headers));
      }
    } finally {
      base = direct;
      await new Promise<void>((resolve) => { guardedServer.close(() => resolve()); guardedServer.closeAllConnections(); });
    }
  });

  test('workspace writes can neither drop, change nor set the server-owned settings', async () => {
    const info = (await raw('PUT', '/api/assistant/settings', { modelId: 'opus' })).body as MichiAssistantInfo;
    // The frontend rebuilds settings from the fields it knows.
    applyWorkspaceCommands(info.workspaceId, {
      operationId: 'op-1',
      commands: [{ type: 'workspace.upsert', payload: { id: info.workspaceId, name: 'Michi assistant', settings: JSON.stringify({ aiGlobalContext: false }) } }],
    });
    const settings = JSON.parse(getWorkspace(info.workspaceId)!.settings!);
    assert.equal(settings.system, 'assistant');
    assert.deepEqual(settings.assistant, { nodeId: info.nodeId }, 'a conversation\'s pick lives outside the workspace row');
    assert.equal(info.conversation.modelId, 'opus');
    assert.equal(settings.aiGlobalContext, false, 'the client\'s own keys are kept');
    saveWorkspace({ id: info.workspaceId, name: 'Michi assistant', created_at: 1, updated_at: 2, settings: null });
    assert.ok(isAssistantWorkspace(info.workspaceId));
    assert.deepEqual((await get()).body, info);

    // Nor can a write unmark it or point it at another conversation or runtime.
    saveWorkspace({
      id: info.workspaceId, name: 'Michi assistant', created_at: 1, updated_at: 3,
      settings: JSON.stringify({ system: null, assistant: { nodeId: 'n-other', runtimeId: 'kiro' } }),
    });
    assert.ok(isAssistantWorkspace(info.workspaceId));
    assert.deepEqual((await get()).body, info);

    // A client cannot mark an ordinary workspace (new or existing) as the assistant's.
    seedWorkspace('ws-plain', JSON.stringify({ instructions: 'x' }));
    saveWorkspace({ id: 'ws-plain', name: 'Plain', created_at: 1, updated_at: 2, settings: JSON.stringify({ system: 'assistant', instructions: 'y' }) });
    assert.equal(isAssistantWorkspace('ws-plain'), false);
    assert.deepEqual(JSON.parse(getWorkspace('ws-plain')!.settings!), { instructions: 'y' });
    applyWorkspaceCommands('ws-new', {
      operationId: 'op-2',
      commands: [{ type: 'workspace.upsert', payload: { id: 'ws-new', name: 'New', settings: JSON.stringify({ system: 'assistant', assistant: { nodeId: 'n-x' } }) } }],
    });
    assert.equal(isAssistantWorkspace('ws-new'), false);
    assert.equal(assistantWorkspaces().length, 1);

    saveWorkspace({ id: 'ws-plain', name: 'Plain', created_at: 1, updated_at: 3, settings: null });
    assert.equal(getWorkspace('ws-plain')!.settings, null, 'ordinary workspaces keep last-writer-wins settings');
  });

  test('the frontend\'s full upsert of the hidden workspace keeps the assistant (main thread and DB worker)', async () => {
    const info = (await raw('PUT', '/api/assistant/settings', { modelId: 'opus' })).body as MichiAssistantInfo;
    const stored = () => JSON.parse(getWorkspace(info.workspaceId)!.settings!);
    const expected = stored().assistant;
    // What the frontend sends once ⌘J installs the workspace in its dirty tracker: the marker only.
    for (const settings of [{ system: 'assistant' }, {}, { system: null }, { system: 'other', assistant: null }]) {
      applyWorkspaceCommands(info.workspaceId, {
        operationId: `op-${JSON.stringify(settings)}`,
        commands: [{ type: 'workspace.upsert', payload: { id: info.workspaceId, name: 'Michi assistant', settings: JSON.stringify(settings) } }],
      });
      assert.equal(stored().system, 'assistant', JSON.stringify(settings));
      assert.deepEqual(stored().assistant, expected, JSON.stringify(settings));
    }

    try {
      await initDbWorker(getDbPath());
      await dbWorker.ensureDurableGraphNode({
        workspace: { id: info.workspaceId, name: 'Michi assistant', createdAt: 1, activeTreeId: info.treeId, settings: { system: 'assistant' } },
        tree: { id: 't-worker-a', rootNodeId: 'n-worker-a', lastActiveAt: 1, createdAt: 1 },
        node: { id: 'n-worker-a', treeId: 't-worker-a', kind: 'chat', createdAt: 1 },
        edges: [],
        ownerUserId: null,
      } as any);
      assert.deepEqual(stored().assistant, expected, 'the DB worker keeps them too');
      await dbWorker.ensureDurableGraphNode({
        workspace: { id: 'ws-worker', name: 'W', createdAt: 1, settings: { system: 'assistant', assistant: { nodeId: 'n-x' } } },
        node: { id: 'n-worker', kind: 'chat', createdAt: 1 },
        edges: [],
        ownerUserId: null,
      } as any);
      assert.equal(isAssistantWorkspace('ws-worker'), false, 'nor can the worker path mark a workspace');
    } finally {
      await shutdownDbWorker();
    }
    assert.deepEqual((await get()).body, info);
  });

  test('cloud mode has no assistant workspace', async () => {
    const info = (await get()).body as MichiAssistantInfo;
    process.env.MICHI_CLOUD = '1';
    try {
      assert.equal(isAssistantWorkspace(info.workspaceId), false);
      assert.equal(isAssistantNode(info.nodeId), false);
    } finally {
      delete process.env.MICHI_CLOUD;
    }
  });

  test('every session path binds the assistant profile and pins its runtime', async () => {
    const info = (await raw('PUT', '/api/assistant/settings', { runtimeId: 'claude', reasoning: 'low' })).body as MichiAssistantInfo;
    const manager = new ChatManager(undefined, tmpDir);
    const binding = await manager.resolvePrimaryAgentBinding({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: info.workspaceId, nodeId: info.nodeId });
    assert.ok(binding);
    parseEffectiveAgentDefinitionV1(binding.effectiveDefinition);
    assert.equal(binding.effectiveDefinition.runtimeProfile.runtimeId, 'claude');
    const options = primaryAgentSessionOptions(binding);
    assert.equal(options.bootstrapInstructions, ASSISTANT_INSTRUCTIONS);
    assert.equal(options.toolProfile?.restricted, undefined);
    assert.deepEqual(options.toolProfile?.allowedToolNames, undefined);
    assert.equal(options.profileHash, binding.profileHash);
    // ensure-session ignores a pane asking for another runtime, provider,
    // model, reasoning, Agent or folder.
    const assistantDir = assistantCwdFor(tmpDir);
    const project = fs.mkdtempSync(path.join(tmpDir, 'project-'));
    const ensured = await raw('POST', `/api/nodes/${info.nodeId}/ensure-session`, {
      cwd: project, workspaceId: info.workspaceId, runtimeId: 'kiro', providerId: 'anthropic', modelId: 'other', reasoning: 'high',
    });
    assert.equal(ensured.status, 200, JSON.stringify(ensured.body));
    assert.equal(ensured.body.runtimeId, 'claude');
    assert.equal(ensured.body.providerId, null);
    assert.equal(ensured.body.modelId, 'claude-model', 'a null model follows the global one for that runtime');
    assert.equal(ensured.body.reasoning, 'low');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].runtimeId, 'claude');
    assert.equal(captured[0].toolProfile?.restricted, undefined);
    assert.equal(captured[0].bootstrapInstructions, ASSISTANT_INSTRUCTIONS);
    assert.equal(captured[0].cwd, assistantDir, 'the assistant never runs in the folder a client names');

    // Reloading the session cannot move it to another runtime or model either.
    clearAllSessions();
    captured = [];
    const loaded = await raw('POST', `/api/chats/${info.nodeId}/load`, {
      cwd: project, nodeId: info.nodeId, runtimeId: 'pi', model: 'other',
    });
    assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
    assert.equal(loaded.body.runtimeId, 'claude');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].runtimeId, 'claude');
    assert.equal(captured[0].model, 'claude-model');
    assert.equal(captured[0].reasoning, 'low');
    assert.equal(captured[0].toolProfile?.restricted, undefined);
    assert.equal(captured[0].cwd, assistantDir);

    // ChatManager.ensureParentSession (Watch delivery, thread messages) binds the same.
    clearAllSessions();
    captured = [];
    const restored = await manager.ensureParentSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: info.workspaceId, nodeId: info.nodeId });
    assert.ok(restored);
    assert.equal(captured[0].toolProfile?.restricted, undefined);
    assert.equal(captured[0].cwd, assistantDir);

    // Ordinary chats are untouched.
    seedWorkspace('ws-a');
    getDb().prepare(`INSERT INTO nodes (id,workspace_id,kind,status,minimized,spawned_by_agent,created_at)
      VALUES ('n-plain','ws-a','chat','idle',0,0,1)`).run();
    assert.equal(await manager.resolvePrimaryAgentBinding({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: 'ws-a', nodeId: 'n-plain' }), null);
  });

  test('every message runs on the conversation\'s pick, else the global settings resolved when its session binds', async () => {
    const info = ensureAssistant();
    const manager = new ChatManager(undefined, tmpDir);
    const profile = async () => (await manager.resolvePrimaryAgentBinding({
      ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: info.workspaceId, nodeId: info.nodeId,
    }))!.effectiveDefinition.runtimeProfile;
    const hash = async () => (await manager.resolvePrimaryAgentBinding({
      ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: info.workspaceId, nodeId: info.nodeId,
    }))!.profileHash;

    assert.equal((await profile()).runtimeId, 'claude', 'following global');
    const firstHash = await hash();
    saveMessage({ id: 'm-1', node_id: info.nodeId, role: 'user', content: 'hello', seq: 1, created_at: 1 });
    setGlobal('kiro', 'kiro-model');
    assert.deepEqual({ ...(await profile()) }, { version: 1, runtimeId: 'kiro', providerId: null, modelId: 'kiro-model', reasoning: 'high' },
      'a conversation with messages follows a global change too');
    assert.notEqual(await hash(), firstHash, 'a different runtime profile rebuilds the live session');

    // The Meta agent's own runtime is for background maintenance only.
    updateMetaAgentSettings({ runtimeId: 'codex', modelId: 'gpt-x', reasoning: 'medium' });
    assert.equal((await profile()).runtimeId, 'kiro');

    // Global runtimes the assistant cannot run on give the first one it can.
    setGlobal('crew');
    assert.equal((await profile()).runtimeId, 'claude');

    updateAssistantSettings({ runtimeId: 'codex', modelId: 'gpt-x', reasoning: 'medium' });
    setGlobal('pi');
    const answer = (await get()).body as MichiAssistantInfo;
    assert.deepEqual(answer.conversation, { runtimeId: 'codex', providerId: null, modelId: 'gpt-x', reasoning: 'medium' });
    assert.equal(answer.settings.runtimeId, 'pi');
    assert.equal((await profile()).runtimeId, 'codex', 'a pick is not affected by global');

    // A new conversation after reset follows the global settings again.
    const fresh = (await raw('POST', '/api/assistant/reset')).body as MichiAssistantInfo;
    assert.equal(fresh.conversation.runtimeId, 'pi');
    assert.equal(fresh.conversationFollowsGlobal, true);
  });

  test('a runtime pick starts from that runtime\'s global settings, whatever the conversation ran on', async () => {
    ensureAssistant();
    setGlobal('codex');
    // A composer whose chips still showed Claude picks Codex, the runtime it already resolves to.
    const picked = updateAssistantSettings({ runtimeId: 'codex', providerId: null, modelId: null, reasoning: null });
    assert.deepEqual(picked.conversation, { runtimeId: 'codex', providerId: null, modelId: null, reasoning: 'xhigh' });
    assert.equal(picked.conversationFollowsGlobal, false);
  });

  test('another provider without a model named starts on its own model', async () => {
    ensureAssistant();
    updateAssistantSettings({ runtimeId: 'pi' });
    const openai = updateAssistantSettings({ providerId: 'openai', modelId: null });
    assert.equal(openai.conversation.providerId, 'openai');
    assert.equal(openai.conversation.modelId, 'gpt-5.5', 'not the global provider\'s model');
    const back = updateAssistantSettings({ providerId: 'anthropic' });
    assert.equal(back.conversation.modelId, resolveModel('pi'), 'the global provider brings back the global model');
    assert.equal(updateAssistantSettings({ providerId: 'openai', modelId: 'gpt-x' }).conversation.modelId, 'gpt-x');
  });

  test('a conversation reopened from history keeps its pick', async () => {
    const first = ensureAssistant();
    updateAssistantSettings({ runtimeId: 'codex', modelId: 'gpt-x' });
    saveMessage({ id: 'h-1', node_id: first.nodeId, role: 'user', content: 'Keep this one', seq: 0, created_at: 1 });
    const second = resetAssistant().info;
    assert.equal(second.conversation.runtimeId, 'claude');
    const reopened = activateAssistantConversation(first.nodeId);
    assert.equal(reopened.nodeId, first.nodeId);
    assert.deepEqual(reopened.conversation, { runtimeId: 'codex', providerId: null, modelId: 'gpt-x', reasoning: 'xhigh' });
  });

  test('a runtime change continues the conversation in a new native session that carries its history', async () => {
    const info = (await get()).body as MichiAssistantInfo;
    const ensure = () => raw('POST', `/api/nodes/${info.nodeId}/ensure-session`, { workspaceId: info.workspaceId });
    setGlobal('codex');
    const first = await ensure();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.runtimeId, 'codex');
    saveMessage({ id: 'm-1', node_id: info.nodeId, role: 'user', content: 'What changed in Atlas?', seq: 1, created_at: 1 });
    saveMessage({ id: 'm-2', node_id: info.nodeId, role: 'assistant', content: 'Atlas moved to the new scheduler.', seq: 2, created_at: 2 });
    assert.equal((await ensure()).body.resumeStrategy, 'live', 'no change, no new session');
    assert.equal(captured.length, 1);

    setGlobal('pi');
    const switched = await ensure();
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.equal(switched.body.runtimeId, 'pi');
    assert.equal(switched.body.resumeStrategy, 'compatible');
    assert.equal(captured.length, 2);
    assert.equal(captured[1].runtimeId, 'pi');
    assert.equal(captured[1].toolProfile?.assistant, true);
    assert.deepEqual(captured[1].replayHistory?.map((message) => message.content),
      ['What changed in Atlas?', 'Atlas moved to the new scheduler.'], 'Pi replays the visible history');
    assert.equal(getNode(info.nodeId)?.runtime_id, 'pi');
    assert.deepEqual(listMessages(info.nodeId).map((message) => message.id), ['m-1', 'm-2'], 'the history is kept');

    const shown = (await get()).body as MichiAssistantInfo;
    assert.equal(shown.runtimeSwitches?.length, 1);
    assert.deepEqual({ ...shown.runtimeSwitches![0], switchedAt: 0 },
      { afterMessageId: 'm-2', previousRuntimeId: 'codex', runtimeId: 'pi', switchedAt: 0 });
    assert.equal((await ensure()).body.resumeStrategy, 'live');
    assert.equal(captured.length, 2);
    assert.equal(((await get()).body as MichiAssistantInfo).runtimeSwitches?.length, 1, 'staying on a runtime records nothing');

    // A pick in the composer, through the path Watch delivery and thread messages
    // use; other runtimes get the visible history as a prior-context block.
    saveMessage({ id: 'm-3', node_id: info.nodeId, role: 'user', content: 'And Borealis?', seq: 3, created_at: 3 });
    updateAssistantSettings({ runtimeId: 'claude' });
    const manager = new ChatManager(undefined, tmpDir);
    const restored = await manager.ensureParentSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: info.workspaceId, nodeId: info.nodeId });
    assert.equal(restored?.runtimeId, 'claude');
    assert.equal(captured.length, 3);
    assert.equal(captured[2].toolProfile?.assistant, true);
    const prior = (captured[2].mergeContexts ?? []).join('\n');
    for (const line of ['What changed in Atlas?', 'Atlas moved to the new scheduler.', 'And Borealis?']) assert.ok(prior.includes(line), line);
    const both = ((await get()).body as MichiAssistantInfo).runtimeSwitches!;
    assert.deepEqual(both.map(({ afterMessageId, previousRuntimeId, runtimeId }) => ({ afterMessageId, previousRuntimeId, runtimeId })), [
      { afterMessageId: 'm-2', previousRuntimeId: 'codex', runtimeId: 'pi' },
      { afterMessageId: 'm-3', previousRuntimeId: 'pi', runtimeId: 'claude' },
    ]);
  });

  test('reloading after a runtime change continues on the new runtime with the history, as a send does', async () => {
    const info = (await get()).body as MichiAssistantInfo;
    setGlobal('codex');
    assert.equal((await raw('POST', `/api/nodes/${info.nodeId}/ensure-session`, { workspaceId: info.workspaceId })).body.runtimeId, 'codex');
    saveMessage({ id: 'm-1', node_id: info.nodeId, role: 'user', content: 'What changed in Atlas?', seq: 1, created_at: 1 });
    saveMessage({ id: 'm-2', node_id: info.nodeId, role: 'assistant', content: 'Atlas moved to the new scheduler.', seq: 2, created_at: 2 });

    clearAllSessions();
    captured = [];
    updateAssistantSettings({ runtimeId: 'claude' });
    const loaded = await raw('POST', `/api/chats/${info.nodeId}/load`, { cwd: tmpDir, nodeId: info.nodeId });
    assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
    assert.equal(loaded.body.runtimeId, 'claude');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].runtimeId, 'claude');
    const prior = (captured[0].mergeContexts ?? []).join('\n');
    for (const line of ['What changed in Atlas?', 'Atlas moved to the new scheduler.']) assert.ok(prior.includes(line), line);
    assert.equal(getNode(info.nodeId)?.runtime_id, 'claude');
    assert.deepEqual(((await get()).body as MichiAssistantInfo).runtimeSwitches?.map(({ previousRuntimeId, runtimeId }) => ({ previousRuntimeId, runtimeId })),
      [{ previousRuntimeId: 'codex', runtimeId: 'claude' }]);

    // An ordinary chat moved to another runtime does not take the old runtime's model along.
    seedWorkspace('ws-load');
    getDb().prepare(`INSERT INTO nodes (id,workspace_id,kind,status,minimized,spawned_by_agent,created_at,runtime_id,model_id,acp_session_id)
      VALUES ('n-load','ws-load','chat','idle',0,0,1,'claude','claude-model','n-load')`).run();
    saveMessage({ id: 'p-1', node_id: 'n-load', role: 'user', content: 'Plan the release', seq: 1, created_at: 1 });
    captured = [];
    const moved = await raw('POST', '/api/chats/n-load/load', { cwd: tmpDir, nodeId: 'n-load', workspaceId: 'ws-load', runtimeId: 'pi' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(captured[0].runtimeId, 'pi');
    assert.notEqual(captured[0].model, 'claude-model');
    assert.deepEqual(captured[0].replayHistory?.map((message) => message.content), ['Plan the release'], 'Pi replays the history');
  });

  test('a runtime switched back before the next message shows no separator', async () => {
    const info = (await get()).body as MichiAssistantInfo;
    const ensure = () => raw('POST', `/api/nodes/${info.nodeId}/ensure-session`, { workspaceId: info.workspaceId });
    await ensure();
    saveMessage({ id: 'm-1', node_id: info.nodeId, role: 'user', content: 'hello', seq: 1, created_at: 1 });
    updateAssistantSettings({ runtimeId: 'codex' });
    await ensure();
    updateAssistantSettings({ runtimeId: 'claude' });
    await ensure();
    assert.equal(getNode(info.nodeId)?.runtime_id, 'claude');
    assert.deepEqual(((await get()).body as MichiAssistantInfo).runtimeSwitches, []);
    updateAssistantSettings({ runtimeId: 'pi' });
    await ensure();
    assert.deepEqual(((await get()).body as MichiAssistantInfo).runtimeSwitches?.map((change) => change.runtimeId), ['pi']);
  });

  test('an ordinary workspace\'s runtime changes record no separator', async () => {
    seedWorkspace('ws-plain');
    getDb().prepare(`INSERT INTO nodes (id,workspace_id,kind,status,minimized,spawned_by_agent,created_at,runtime_id)
      VALUES ('n-plain','ws-plain','chat','idle',0,0,1,'claude')`).run();
    saveMessage({ id: 'm-plain', node_id: 'n-plain', role: 'user', content: 'hello', seq: 1, created_at: 1 });
    getDb().prepare("UPDATE nodes SET runtime_id = 'codex' WHERE id = 'n-plain'").run();
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM assistant_runtime_switches').get() as { n: number }).n, 0);
  });

  test('a deleted or purged assistant workspace\'s conversations still bind as the assistant, never as a worker', async () => {
    const info = ensureAssistant();
    const manager = new ChatManager(undefined, tmpDir);
    const bind = () => manager.resolvePrimaryAgentBinding({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: info.workspaceId, nodeId: info.nodeId });
    getDb().prepare('UPDATE workspaces SET deleted_at = 5 WHERE id = ?').run(info.workspaceId);
    assert.equal(primaryAgentSessionOptions(await bind()).toolProfile?.restricted, undefined);
    getDb().prepare('UPDATE workspaces SET purged_at = 6 WHERE id = ?').run(info.workspaceId);
    assert.equal(getWorkspace(info.workspaceId), null, 'hidden from ordinary reads');
    const purged = await bind();
    assert.ok(purged, 'not an unbound (worker) chat');
    assert.equal(primaryAgentSessionOptions(purged).toolProfile?.restricted, undefined);
  });

  test('a cloud backend refuses to bind an assistant conversation', async () => {
    const info = ensureAssistant();
    const manager = new ChatManager(undefined, tmpDir);
    process.env.MICHI_CLOUD = '1';
    try {
      await assert.rejects(
        manager.resolvePrimaryAgentBinding({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: info.workspaceId, nodeId: info.nodeId }),
        (error: Error) => error instanceof PrimaryAgentBindingError && /desktop app/.test(error.message),
      );
    } finally {
      delete process.env.MICHI_CLOUD;
    }
  });

  test('the local-only guard answers in the assistant\'s own words', async () => {
    const refused = await raw('GET', '/api/assistant', undefined, { host: 'evil.example' });
    assert.deepEqual(refused.body, { error: 'The Michi assistant requires local or authenticated remote access' });
    const control = await raw('GET', '/api/assistant', undefined, { origin: 'https://evil.example' });
    assert.deepEqual(control.body, { error: 'The Michi assistant requires local or authenticated remote access' });
  });

  test('backups neither export nor import the assistant\'s workspace', async () => {
    const backups = express();
    backups.use(express.json({ limit: '10mb' }));
    backups.use('/api', setupBackupRoutes());
    const backupServer = backups.listen(0, '127.0.0.1');
    await new Promise((resolve) => backupServer.once('listening', resolve));
    const backupBase = `http://127.0.0.1:${(backupServer.address() as AddressInfo).port}`;
    const call = async (method: string, p: string, body?: unknown) => {
      const res = await fetch(`${backupBase}${p}`, {
        method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      return { status: res.status, body: await res.json() as any };
    };
    try {
      const info = ensureAssistant();
      saveMessage({ id: 'm-asst', node_id: info.nodeId, role: 'user', content: 'what waits on me?', seq: 1, created_at: 1 });
      seedWorkspace('ws-a');

      const all = await call('GET', '/api/backup/export');
      assert.equal(all.status, 200);
      assert.deepEqual(all.body.workspaces.map((w: any) => w.workspace.id), ['ws-a']);
      assert.doesNotMatch(JSON.stringify(all.body), /what waits on me/);
      assert.equal((await call('GET', `/api/backup/export/${info.workspaceId}`)).status, 404);

      // A backup written before this rule, holding the assistant's workspace.
      const legacy = {
        version: 1, app: 'michi', exportedAt: 1,
        workspaces: [loadFullWorkspace(info.workspaceId), loadFullWorkspace('ws-a')],
      };
      const before = listWorkspaces().length;
      const imported = await call('POST', '/api/backup/import', legacy);
      assert.equal(imported.status, 200, JSON.stringify(imported.body));
      assert.equal(imported.body.workspaceCount, 1);
      assert.deepEqual(Object.keys(imported.body.workspaceIds), ['ws-a']);
      assert.equal(listWorkspaces().length, before + 1);
      const copies = getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE content = 'what waits on me?'").get() as { n: number };
      assert.equal(copies.n, 1, 'its conversation did not come back as an ordinary thread');
      assert.equal(assistantWorkspaces().length, 1);
    } finally {
      await new Promise<void>((resolve) => { backupServer.close(() => resolve()); backupServer.closeAllConnections(); });
    }
  });
});
