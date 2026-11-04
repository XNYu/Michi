// Michi Memory agent tools (agents/memoryTools.ts): the scope rule, turn
// trust gating, mode off, owner/workspace isolation and argument errors, on
// the shared executor and through both tool surfaces (Michi's MCP server and
// Pi's built-in tools), plus their catalog, trust and permission entries.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { MemoryChangedEvent, MemoryRecord } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';
import {
  createMemory, getMemory, listMemories, memoryEvents, searchMemories, setMemorySettings,
} from '../src/services/memory/memoryService';
import { memoryOwnerId } from '../src/services/memory/memoryOwner';
import { setupMemoryRoutes } from '../src/routes/memories';
import { recordUntrustedSource, classifyToolTrust, MICHI_TOOL_NAMES } from '../src/services/turnTrust';
import { MEMORY_TOOL_NAMES, memoryTool, type MemoryToolCaller, type MemoryToolName } from '../src/agents/memoryTools';
import { BUILTIN_TOOLS, CHAT_ONLY_BUILTIN_TOOLS } from '../src/agents/builtinTools';
import { resolveChatPolicy } from '../src/agents/permissionPolicy';
import { META_AGENT_MAINTENANCE_TOOL_NAMES } from '../src/agents/maintenancePolicy';
import { isMaintenanceInternalTool } from '../src/services/metaAgent/maintenanceAccess';
import { ASSISTANT_ALLOWED_TOOL_NAMES, SCHEDULE_ASSISTANT_TOOL_NAMES } from '../src/assistant/policy';
import { McpSlotRegistry, buildMcpServerForSlot } from '../src/services/mcpServer';
import { buildPiTools } from '../src/agents/pi/piTools';
import { loadPiAi, loadPiTypebox } from '../src/agents/pi/piAi';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { acpPermissionToolName } from 'michi-runtime/internal/adapters/kiro/kiroToolNames';
import { chatOwner, runOwner } from './helpers/owners';

const saved = { cloud: process.env.MICHI_CLOUD, dataDir: process.env.MICHI_DATA_DIR };
let dataDir: string;
let turnSerial = 0;

function workspace(id: string, ownerUserId: string | null): void {
  saveWorkspace({ id, name: 'Project', created_at: 1, updated_at: 1, active_tree_id: `tree-${id}`, owner_user_id: ownerUserId } as never);
  saveTree({ id: `tree-${id}`, workspace_id: id, root_node_id: `n-${id}`, last_active_at: 1, created_at: 1 } as never);
}

function node(id: string, workspaceId: string): void {
  saveNode({
    id, workspace_id: workspaceId, tree_id: `tree-${workspaceId}`, parent_node_id: null,
    kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1,
  } as never);
}

/** Starts a running turn on the node (as chatHub's durable turn row); returns its id. */
function runningTurn(nodeId: string): string {
  const turnId = `turn-${++turnSerial}-${Date.now()}`;
  getDb().prepare(`INSERT INTO turns (turn_id, node_id, user_message_id, assistant_message_id, status, last_seq, started_at, updated_at)
    VALUES (?, ?, NULL, ?, 'active', 0, ?, ?)`).run(turnId, nodeId, `a-${turnId}`, Date.now(), Date.now());
  return turnId;
}

function endTurns(nodeId: string): void {
  getDb().prepare("UPDATE turns SET status = 'completed' WHERE node_id = ?").run(nodeId);
}

/** alice's thread n-a in her workspace ws-a. */
const aliceChat: MemoryToolCaller = { ownerUserId: 'alice', workspaceId: 'ws-a', nodeId: 'n-a', isAgentRun: false };

function call(name: MemoryToolName, args: unknown, caller: MemoryToolCaller = aliceChat) {
  const result = memoryTool(name, caller, args);
  const text = result.content.map((part) => part.text).join('');
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* an error result is text */ }
  return { result, text, json };
}

function all(ownerUserId = 'alice'): MemoryRecord[] {
  return listMemories({ ownerUserId }, { status: ['active', 'pending', 'superseded'], limit: 200 }).items;
}

function seed(ownerUserId: string, body: string, scope: MemoryRecord['scope'] = { kind: 'user' }): MemoryRecord {
  return createMemory({ ownerUserId }, { scope, kind: 'preference', body, status: 'active', origin: 'explicit' });
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-memory-tools-'));
  process.env.MICHI_DATA_DIR = dataDir;
  process.env.MICHI_CLOUD = '1';
  closeDb();
  initDb();
  workspace('ws-a', 'alice');
  workspace('ws-a2', 'alice');
  workspace('ws-b', 'bob');
  node('n-a', 'ws-a');
  node('n-a2', 'ws-a2');
  node('n-b', 'ws-b');
});

afterEach(() => {
  closeDb();
  if (saved.cloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = saved.cloud;
  if (saved.dataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = saved.dataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('memory_save', () => {
  test('everywhere goes to the user scope, this_workspace to the thread\'s workspace; arguments name neither', () => {
    const turnId = runningTurn('n-a');
    const style = call('memory_save', { body: 'Reply in Chinese.', kind: 'preference', appliesTo: 'everywhere' });
    assert.equal(style.json.status, 'saved');
    assert.equal(style.json.memory.appliesTo, 'everywhere');
    assert.equal(style.json.memory.status, 'active');
    const project = call('memory_save', {
      body: 'This repo uses pnpm, not npm.', kind: 'convention', appliesTo: 'this_workspace',
      // Ignored: the owner and workspace come from the session.
      workspaceId: 'ws-a2', ownerUserId: 'bob', scope: { kind: 'workspace', workspaceId: 'ws-b' },
    });
    assert.equal(project.json.status, 'saved');

    const stored = getMemory({ ownerUserId: 'alice' }, style.json.memory.id);
    assert.deepEqual(stored.scope, { kind: 'user' });
    assert.deepEqual(stored.source, { nodeId: 'n-a', turnId });
    assert.equal(stored.origin, 'explicit');
    assert.equal(stored.sourceRisk, null);
    assert.deepEqual(getMemory({ ownerUserId: 'alice' }, project.json.memory.id).scope, { kind: 'workspace', workspaceId: 'ws-a' });
    assert.equal(all('bob').length, 0);
  });

  test('unsure writes nothing and tells the model to ask the user once', () => {
    runningTurn('n-a');
    const { result, json } = call('memory_save', { body: 'Use tabs.', kind: 'convention', appliesTo: 'unsure' });
    assert.equal(result.isError, undefined);
    assert.equal(json.status, 'needs_scope');
    assert.equal(json.saved, false);
    assert.match(json.next, /ask_user/);
    assert.match(json.next, /once/);
    assert.equal(all().length, 0);
  });

  test('a thread without a workspace cannot save for this workspace', () => {
    runningTurn('n-a');
    const { result, text } = call('memory_save', { body: 'Use tabs.', kind: 'convention', appliesTo: 'this_workspace' },
      { ...aliceChat, workspaceId: null });
    assert.equal(result.isError, true);
    assert.match(text, /^SOURCE_UNAVAILABLE/);
    assert.equal(all().length, 0);
  });

  test('a trusted running turn saves active; an untrusted one, or none found, saves pending for the user to confirm', () => {
    const trusted = runningTurn('n-a');
    assert.equal(call('memory_save', { body: 'Prefer short answers.', kind: 'preference', appliesTo: 'everywhere' }).json.memory.status, 'active');

    recordUntrustedSource({ nodeId: 'n-a', turnId: trusted }, { tool: 'WebFetch', runtimeId: 'claude' });
    const fromWeb = call('memory_save', { body: 'Always deploy on Fridays.', kind: 'decision', appliesTo: 'this_workspace' });
    assert.equal(fromWeb.json.status, 'pending_confirmation');
    assert.equal(fromWeb.json.memory.status, 'pending');
    assert.match(fromWeb.json.note, /Settings → Memory/);
    assert.match(fromWeb.json.note, /outside this conversation/);
    const pending = getMemory({ ownerUserId: 'alice' }, fromWeb.json.memory.id);
    assert.equal(pending.sourceRisk, 'untrusted');
    assert.deepEqual(pending.source, { nodeId: 'n-a', turnId: trusted });

    endTurns('n-a');
    const noTurn = call('memory_save', { body: 'Use dark mode.', kind: 'preference', appliesTo: 'everywhere' });
    assert.equal(noTurn.json.memory.status, 'pending');
    assert.match(noTurn.json.note, /could not confirm/);
    const unverified = getMemory({ ownerUserId: 'alice' }, noTurn.json.memory.id);
    assert.equal(unverified.sourceRisk, 'untrusted');
    assert.deepEqual(unverified.source, { nodeId: 'n-a' });
    // Pending memories are not recalled until the user approves them.
    assert.equal(searchMemories({ ownerUserId: 'alice' }, { query: 'Fridays dark', workspaceId: 'ws-a' }).length, 0);
  });

  test('bad arguments are tool errors and write nothing', () => {
    runningTurn('n-a');
    const cases: unknown[] = [
      {},
      { body: '', kind: 'preference', appliesTo: 'everywhere' },
      { body: '   ', kind: 'preference', appliesTo: 'everywhere' },
      { body: 7, kind: 'preference', appliesTo: 'everywhere' },
      { body: 'x'.repeat(2001), kind: 'preference', appliesTo: 'everywhere' },
      { body: 'ok', kind: 'secret', appliesTo: 'everywhere' },
      { body: 'ok', kind: 'preference' },
      { body: 'ok', kind: 'preference', appliesTo: 'ws-b' },
      'not an object',
    ];
    for (const args of cases) {
      const { result, text } = call('memory_save', args);
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(text, /^INVALID_ARGUMENT/, JSON.stringify(args));
    }
    assert.equal(all().length, 0);
  });

  test('the service announces the change with the thread as its source', () => {
    runningTurn('n-a');
    const events: MemoryChangedEvent[] = [];
    const listener = (event: MemoryChangedEvent) => events.push(event);
    memoryEvents.on('changed', listener);
    try {
      call('memory_save', { body: 'Reply in Chinese.', kind: 'preference', appliesTo: 'everywhere' });
    } finally {
      memoryEvents.off('changed', listener);
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'created');
    assert.equal(events[0].status, 'active');
    assert.equal(events[0].ownerUserId, 'alice');
    assert.equal(events[0].nodeId, 'n-a');
  });

  test('on the desktop memories are the local user\'s, as Settings → Memory reads them', () => {
    delete process.env.MICHI_CLOUD;
    runningTurn('n-a');
    const { json } = call('memory_save', { body: 'Reply in Chinese.', kind: 'preference', appliesTo: 'everywhere' },
      { ...aliceChat, ownerUserId: null });
    assert.equal(json.status, 'saved');
    assert.equal(getMemory({ ownerUserId: 'local-user' }, json.memory.id).body, 'Reply in Chinese.');
  });
});

describe('memory_search', () => {
  test('finds the user scope and this workspace only, by short keywords including Chinese', () => {
    seed('alice', '回复用中文');
    seed('alice', 'Run tests with pnpm test', { kind: 'workspace', workspaceId: 'ws-a' });
    seed('alice', 'Other project uses pnpm too', { kind: 'workspace', workspaceId: 'ws-a2' });
    seed('bob', 'Bob also likes pnpm');
    const { json } = call('memory_search', { query: 'pnpm 中文' });
    assert.deepEqual(json.memories.map((memory: any) => memory.body).sort(), ['Run tests with pnpm test', '回复用中文']);
    assert.deepEqual(json.memories.map((memory: any) => memory.appliesTo).sort(), ['everywhere', 'this_workspace']);
    assert.match(json.note, /Settings → Memory/);

    const none = call('memory_search', { query: 'kubernetes' }).json;
    assert.equal(none.count, 0);
    assert.match(none.next, /keywords/);
    assert.equal(call('memory_search', { query: 'pnpm' }, { ...aliceChat, workspaceId: null }).json.count, 0);
  });

  test('bad arguments are tool errors', () => {
    for (const args of [{}, { query: '  ' }, { query: 'x', limit: 0 }, { query: 'x', limit: 21 }, { query: 'x', limit: 1.5 }]) {
      const { result, text } = call('memory_search', args);
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(text, /^INVALID_ARGUMENT/);
    }
  });
});

describe('memory_update', () => {
  test('a correction supersedes the memory: search returns only the new version', () => {
    runningTurn('n-a');
    const old = seed('alice', 'Use npm for this repo.', { kind: 'workspace', workspaceId: 'ws-a' });
    const { json } = call('memory_update', { id: old.id, body: 'Use pnpm for this repo, not npm.', kind: 'convention' });
    assert.equal(json.status, 'updated');
    assert.equal(json.replaces, old.id);
    assert.equal(json.memory.status, 'active');
    assert.equal(json.memory.kind, 'convention');
    assert.equal(json.memory.appliesTo, 'this_workspace');
    assert.equal(getMemory({ ownerUserId: 'alice' }, old.id).status, 'superseded');
    const corrected = getMemory({ ownerUserId: 'alice' }, json.memory.id);
    assert.equal(corrected.supersedesId, old.id);
    assert.deepEqual(corrected.scope, { kind: 'workspace', workspaceId: 'ws-a' });
    assert.deepEqual(call('memory_search', { query: 'npm' }).json.memories.map((memory: any) => memory.id), [json.memory.id]);

    const again = call('memory_update', { id: old.id, body: 'Use yarn.' });
    assert.equal(again.result.isError, true);
    assert.match(again.text, /^INVALID_STATE/);
    assert.equal(call('memory_update', { id: json.memory.id, body: 'Use pnpm for this repo, not npm.' }).json.status, 'unchanged');
  });

  test('a correction from an untrusted turn waits for the user while the old memory stays active', () => {
    const turnId = runningTurn('n-a');
    recordUntrustedSource({ nodeId: 'n-a', turnId }, { tool: 'web_search', runtimeId: 'pi' });
    const old = seed('alice', 'Answer in English.');
    const { json } = call('memory_update', { id: old.id, body: 'Answer in French.' });
    assert.equal(json.status, 'pending_confirmation');
    assert.equal(json.memory.status, 'pending');
    assert.match(json.note, /old memory stays in effect/);
    assert.equal(getMemory({ ownerUserId: 'alice' }, old.id).status, 'active');
    assert.equal(getMemory({ ownerUserId: 'alice' }, json.memory.id).sourceRisk, 'untrusted');
  });

  test('bad arguments are tool errors and change nothing', () => {
    runningTurn('n-a');
    const old = seed('alice', 'Answer in English.');
    for (const args of [{ body: 'x' }, { id: old.id }, { id: old.id, body: '' }, { id: old.id, body: 'x', kind: 'mood' }]) {
      const { result, text } = call('memory_update', args);
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(text, /^INVALID_ARGUMENT/);
    }
    assert.deepEqual(all().map((record) => [record.body, record.status]), [['Answer in English.', 'active']]);
  });
});

describe('memory_delete', () => {
  test('deletes the memory so search no longer finds it', () => {
    runningTurn('n-a');
    const memory = seed('alice', 'Prefer tabs.');
    const { json } = call('memory_delete', { id: memory.id });
    assert.equal(json.status, 'deleted');
    assert.equal(json.id, memory.id);
    assert.equal(all().length, 0);
    assert.equal(call('memory_search', { query: 'tabs' }).json.count, 0);
    assert.match(call('memory_delete', { id: memory.id }).text, /^NOT_FOUND/);
    assert.match(call('memory_delete', {}).text, /^INVALID_ARGUMENT/);
  });
});

describe('isolation', () => {
  test('another owner\'s and another workspace\'s ids read as not found for update and delete', () => {
    runningTurn('n-a');
    const bobs = seed('bob', 'Bob prefers vim.');
    const otherWorkspace = seed('alice', 'Project two uses Go.', { kind: 'workspace', workspaceId: 'ws-a2' });
    for (const id of [bobs.id, otherWorkspace.id, 'mem-missing']) {
      for (const [name, args] of [['memory_update', { id, body: 'changed' }], ['memory_delete', { id }]] as const) {
        const { result, text } = call(name, args);
        assert.equal(result.isError, true, `${name} ${id}`);
        assert.match(text, /^NOT_FOUND: Memory not found/, `${name} ${id}`);
      }
    }
    assert.deepEqual(getMemory({ ownerUserId: 'bob' }, bobs.id).body, 'Bob prefers vim.');
    assert.equal(getMemory({ ownerUserId: 'alice' }, otherWorkspace.id).status, 'active');
    assert.equal(all().length, 1);
  });

  test('Agent Runs, unbound sessions and cloud sessions without a user get nothing', () => {
    runningTurn('n-a');
    const save = { body: 'x', kind: 'fact', appliesTo: 'everywhere' };
    assert.match(call('memory_save', save, { ...aliceChat, isAgentRun: true }).text, /^UNSUPPORTED/);
    assert.match(call('memory_save', save, { ...aliceChat, nodeId: null }).text, /^SOURCE_UNAVAILABLE/);
    assert.match(call('memory_save', save, { ...aliceChat, ownerUserId: null }).text, /^UNAVAILABLE/);
    assert.equal(all().length, 0);
  });
});

describe('memory turned off', () => {
  test('every tool says so and nothing is read or written', () => {
    runningTurn('n-a');
    const existing = seed('alice', 'Reply in Chinese.');
    setMemorySettings('alice', { mode: 'off' });
    for (const [name, args] of [
      ['memory_save', { body: 'Use tabs.', kind: 'convention', appliesTo: 'this_workspace' }],
      ['memory_search', { query: 'Chinese' }],
      ['memory_update', { id: existing.id, body: 'Reply in English.' }],
      ['memory_delete', { id: existing.id }],
    ] as const) {
      const { result, text } = call(name, args);
      assert.equal(result.isError, true, name);
      assert.match(text, /^MEMORY_OFF: Michi Memory is turned off/, name);
    }
    assert.deepEqual(all().map((record) => [record.id, record.status, record.body]), [[existing.id, 'active', 'Reply in Chinese.']]);
  });
});

// ── Tool surfaces ────────────────────────────────────────────────────────────

const slotCallbacks = { onSpawnBranches: async () => [], onSaveArtifact: () => null, onUpdateArtifact: () => null, onAskUser: async () => null };

async function mcpClient(t: any, ownerUserId: string | null, binding: { nodeId: string | null; workspaceId: string | null }, extra: Record<string, unknown> = {}) {
  const slot = new McpSlotRegistry().create('runtime-session', '/tmp', ownerUserId, { ...slotCallbacks, ...extra } as never, binding);
  const server = buildMcpServerForSlot(slot);
  const client = new Client({ name: 'memory-tools', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(a);
  await client.connect(b);
  return client;
}

describe('Michi MCP server (Claude, Codex, Kiro, Crew)', () => {
  test('chat slots serve the four tools, bound to the slot\'s node and workspace', async (t) => {
    const turnId = runningTurn('n-a');
    const client = await mcpClient(t, 'alice', { nodeId: 'n-a', workspaceId: 'ws-a' });
    const tools = (await client.listTools()).tools;
    for (const name of MEMORY_TOOL_NAMES) assert.ok(tools.some((tool) => tool.name === name), name);
    assert.equal(tools.find((tool) => tool.name === 'memory_search')?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((tool) => tool.name === 'memory_delete')?.annotations?.destructiveHint, true);

    const saved: any = await client.callTool({ name: 'memory_save', arguments: { body: 'Use pnpm.', kind: 'convention', appliesTo: 'this_workspace', workspaceId: 'ws-a2' } });
    const savedJson = JSON.parse(saved.content[0].text);
    assert.equal(savedJson.status, 'saved');
    const stored = getMemory({ ownerUserId: 'alice' }, savedJson.memory.id);
    assert.deepEqual(stored.scope, { kind: 'workspace', workspaceId: 'ws-a' });
    assert.deepEqual(stored.source, { nodeId: 'n-a', turnId });

    const found: any = await client.callTool({ name: 'memory_search', arguments: { query: 'pnpm' } });
    assert.equal(JSON.parse(found.content[0].text).count, 1);

    const invalid: any = await client.callTool({ name: 'memory_save', arguments: { body: 'x', kind: 'mood', appliesTo: 'everywhere' } });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /Input validation error/);
    const missingScope: any = await client.callTool({ name: 'memory_save', arguments: { body: 'x', kind: 'fact' } });
    assert.equal(missingScope.isError, true);
    assert.equal(all().length, 1);

    const deleted: any = await client.callTool({ name: 'memory_delete', arguments: { id: savedJson.memory.id } });
    assert.equal(JSON.parse(deleted.content[0].text).status, 'deleted');
    assert.equal(all().length, 0);
  });

  test('an untrusted turn on the slot\'s node saves pending', async (t) => {
    const turnId = runningTurn('n-a');
    recordUntrustedSource({ nodeId: 'n-a', turnId }, { tool: 'WebSearch', runtimeId: 'claude' });
    const client = await mcpClient(t, 'alice', { nodeId: 'n-a', workspaceId: 'ws-a' });
    const result: any = await client.callTool({ name: 'memory_save', arguments: { body: 'Ship on Fridays.', kind: 'decision', appliesTo: 'this_workspace' } });
    assert.equal(JSON.parse(result.content[0].text).memory.status, 'pending');
  });

  test('a slot cannot reach another owner\'s workspace through its cached binding', async (t) => {
    runningTurn('n-b');
    // alice's slot pointing at bob's node: the binding lookup fails, the cached workspace is bob's.
    const client = await mcpClient(t, 'alice', { nodeId: 'n-b', workspaceId: 'ws-b' });
    const result: any = await client.callTool({ name: 'memory_save', arguments: { body: 'x', kind: 'fact', appliesTo: 'this_workspace' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^NOT_FOUND/);
    assert.equal(all('alice').length + all('bob').length, 0);
  });

  test('Agent Run slots, the assistant and maintenance never get them', async (t) => {
    const run = await mcpClient(t, 'alice', { nodeId: null, workspaceId: 'ws-a' }, { owner: runOwner('run-1', 'attempt-1') });
    const runTools = (await run.listTools()).tools.map((tool) => tool.name);
    for (const name of MEMORY_TOOL_NAMES) assert.ok(!runTools.includes(name), name);
    const fenced = await mcpClient(t, 'alice', { nodeId: 'n-a', workspaceId: 'ws-a' }, { restricted: true });
    const fencedTools = fenced.getServerCapabilities()?.tools ? (await fenced.listTools()).tools.map((tool) => tool.name) : [];
    for (const name of MEMORY_TOOL_NAMES) assert.ok(!fencedTools.includes(name), name);
    for (const name of MEMORY_TOOL_NAMES) {
      assert.ok(!META_AGENT_MAINTENANCE_TOOL_NAMES.includes(name), `${name} not in the maintenance catalog`);
      assert.equal(isMaintenanceInternalTool(name), false, `${name} not reachable through maintenance_call_tool`);
      assert.ok(!ASSISTANT_ALLOWED_TOOL_NAMES.includes(name), `${name} not in the Spaces assistant catalog`);
      assert.ok(!SCHEDULE_ASSISTANT_TOOL_NAMES.includes(name), `${name} not in the Scheduled assistant catalog`);
    }
  });
});

describe('the owner Settings → Memory uses', () => {
  test('memoryOwnerId: the session user in cloud mode, the local identity on the desktop', () => {
    assert.equal(memoryOwnerId(' alice '), 'alice');
    assert.equal(memoryOwnerId(null), null);
    assert.equal(memoryOwnerId('  '), null);
    delete process.env.MICHI_CLOUD;
    assert.equal(memoryOwnerId('alice'), 'local-user');
    assert.equal(memoryOwnerId(null), 'local-user');
  });

  async function settingsList(t: any, user: string | null): Promise<string[]> {
    const app = express();
    app.use(express.json());
    // Stands in for the session gate, as in memoryRoutes.test.ts.
    app.use((req, _res, next) => { if (user) req.user = { id: user, email: `${user}@example.com` } as never; next(); });
    app.use('/api', setupMemoryRoutes());
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/memories`);
    assert.equal(response.status, 200);
    return ((await response.json()) as { items: MemoryRecord[] }).items.map((item) => item.body);
  }

  for (const cloud of [true, false]) {
    test(`a memory an agent saves is listed by GET /api/memories for the route's owner (${cloud ? 'cloud' : 'desktop'})`, async (t) => {
      if (!cloud) delete process.env.MICHI_CLOUD;
      runningTurn('n-a');
      // On the desktop the slot's user, whatever it is, is not the memory owner.
      const client = await mcpClient(t, cloud ? 'alice' : 'signed-in-elsewhere', { nodeId: 'n-a', workspaceId: 'ws-a' });
      const result: any = await client.callTool({ name: 'memory_save', arguments: { body: 'Reply in Chinese.', kind: 'preference', appliesTo: 'everywhere' } });
      assert.equal(JSON.parse(result.content[0].text).status, 'saved');
      assert.deepEqual(await settingsList(t, cloud ? 'alice' : null), ['Reply in Chinese.']);
      if (cloud) assert.deepEqual(await settingsList(t, 'bob'), []);
    });
  }
});

describe('Pi built-in tools', () => {
  async function piTools(owner: unknown, extra: Record<string, unknown> = {}) {
    configureRuntimeDeps({
      historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null } as any,
      agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined } as any,
      dataDir,
    });
    const pi: any = await loadPiAi();
    const { Type } = await loadPiTypebox();
    try {
      return { pi, tools: buildPiTools({
        bridge: {} as any, cwd: '/tmp', parentChatId: 'p', workspaceId: 'ws-a', enableFollowUps: false,
        imageQuota: { usedBytes: 0, limitBytes: 1 } as any, seenPaths: new Set<string>(), Type,
        ownerUserId: 'alice', owner, ...extra,
      } as any) };
    } finally {
      __resetRuntimeDeps();
    }
  }

  test('chat threads get the four tools, bound to the thread; saves gate on its turn', async () => {
    const { pi, tools } = await piTools(chatOwner('n-a'));
    for (const name of MEMORY_TOOL_NAMES) assert.ok(tools.some((tool: any) => tool.name === name), name);
    const save = tools.find((tool: any) => tool.name === 'memory_save');
    assert.equal(save.executionMode, 'sequential');
    const valid = { body: 'x', kind: 'fact', appliesTo: 'everywhere', __tool_use_purpose: 'p' };
    assert.doesNotThrow(() => pi.validateToolArguments(save, { name: 'memory_save', arguments: valid }));
    assert.throws(() => pi.validateToolArguments(save, { name: 'memory_save', arguments: { ...valid, appliesTo: 'ws-b' } }));
    assert.throws(() => pi.validateToolArguments(save, { name: 'memory_save', arguments: { ...valid, kind: 'mood' } }));

    const turnId = runningTurn('n-a');
    const result = await save.execute('call-1', { __tool_use_purpose: 'remember', body: 'Reply in Chinese.', kind: 'preference', appliesTo: 'everywhere' });
    const json = JSON.parse(result.content[0].text);
    assert.equal(json.status, 'saved');
    assert.deepEqual(getMemory({ ownerUserId: 'alice' }, json.memory.id).source, { nodeId: 'n-a', turnId });

    recordUntrustedSource({ nodeId: 'n-a', turnId }, { tool: 'fetch_content', runtimeId: 'pi', detail: 'https://example.com' });
    const update = tools.find((tool: any) => tool.name === 'memory_update');
    const corrected = JSON.parse((await update.execute('call-2', { id: json.memory.id, body: 'Reply in Japanese.' })).content[0].text);
    assert.equal(corrected.memory.status, 'pending');

    const del = tools.find((tool: any) => tool.name === 'memory_delete');
    const refused = await del.execute('call-3', { id: 'mem-unknown' });
    assert.equal(refused.isError, true);
    assert.equal(refused.details.isError, true);
  });

  test('Agent Runs get none', async () => {
    const { tools } = await piTools(runOwner('run-1', 'attempt-1'));
    for (const name of MEMORY_TOOL_NAMES) assert.ok(!tools.some((tool: any) => tool.name === name), name);
  });

  test('in Ask mode PiSession runs search, save and update without a card and asks before delete', async (t) => {
    delete process.env.MICHI_CLOUD;
    const restores: Array<() => void> = [];
    const patch = (modulePath: string, key: string, value: unknown) => {
      const mod = require(modulePath);
      const original = mod[key];
      mod[key] = value;
      restores.push(() => { mod[key] = original; });
    };
    t.after(() => {
      while (restores.length > 0) restores.pop()!();
      __resetRuntimeDeps();
      delete require.cache[require.resolve('../src/agents/pi/PiSession')];
    });
    configureRuntimeDeps({
      historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null },
      providerKeys: { getProviderApiKey: () => 'test-key' },
      agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'deepseek', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => 'pi-model', resolveReasoning: () => undefined },
      dataDir,
    });
    let beforeToolCall: ((context: { toolCall: { name: string }; args: unknown }) => Promise<{ block: boolean; reason?: string } | undefined>) | undefined;
    const piAiPath = require.resolve('../src/agents/pi/piAi');
    patch(require.resolve('../src/agents/pi/piTools'), 'buildPiTools', () => []);
    patch(require.resolve('../src/services/piMcpConfig'), 'readPiMcpServers', () => []);
    patch(piAiPath, 'loadPiAi', async () => ({
      Type: {}, clampThinkingLevel: (_model: unknown, level: string) => level,
      getModel: () => ({ contextWindow: 1000 }), streamSimple: () => { throw new Error('not used'); },
    }));
    patch(piAiPath, 'loadPiAgentCore', async () => ({
      Agent: class {
        state = { messages: [] };
        private subscriber: ((event: any) => void) | undefined;
        constructor(opts: any) { beforeToolCall = opts.beforeToolCall; }
        subscribe(fn: (event: any) => void) { this.subscriber = fn; return () => { this.subscriber = undefined; }; }
        async prompt() { this.subscriber?.({ type: 'agent_end' }); }
      },
    }));
    const { PiSession } = require('../src/agents/pi/PiSession') as typeof import('../src/agents/pi/PiSession');
    const chat = new PiSession('pi-memory-chat', {
      bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
      preamble: '', cwd: process.cwd(), enableFollowUps: false, workspaceId: 'ws-a', ownerUserId: null,
      owner: chatOwner('n-a'),
    });
    for await (const event of chat.send('build tools')) { if (event.kind === 'turn_end') break; }
    const events: any[] = [];
    (chat as any).activePush = (event: unknown) => { events.push(event); };
    for (const name of ['memory_search', 'memory_save', 'memory_update']) {
      assert.equal(await beforeToolCall!({ toolCall: { name }, args: {} }), undefined, name);
    }
    assert.equal(events.length, 0, 'no permission card for search, save or update');

    const pending = beforeToolCall!({ toolCall: { name: 'memory_delete' }, args: { id: 'mem-1' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.at(-1)?.kind, 'permission_request');
    chat.respondToPermission(events.at(-1).requestId, 'reject_once');
    assert.deepEqual(await pending, { block: true, reason: 'user denied' });

    const approved = beforeToolCall!({ toolCall: { name: 'memory_delete' }, args: { id: 'mem-1' } });
    await new Promise((resolve) => setImmediate(resolve));
    chat.respondToPermission(events.at(-1).requestId, 'allow_once');
    assert.equal(await approved, undefined);
  });
});

// ── Catalog, trust and permission entries ────────────────────────────────────

describe('catalog entries', () => {
  test('defined once, chat-only (never Agent capabilities) and trusted Michi tools', () => {
    for (const name of MEMORY_TOOL_NAMES) {
      assert.equal(BUILTIN_TOOLS.filter((tool) => tool.name === name).length, 1, name);
      assert.ok(CHAT_ONLY_BUILTIN_TOOLS.has(name), name);
      assert.ok(MICHI_TOOL_NAMES.has(name), name);
      assert.equal(classifyToolTrust({ runtimeId: 'claude', toolName: name, mcpServer: '__michi_internal__', hostTool: true }), 'trusted');
    }
    const save = BUILTIN_TOOLS.find((tool) => tool.name === 'memory_save')!;
    for (const pattern of [/temporary to-dos/, /test data/, /guesses/, /web pages, files or tool output/, /Settings → Memory/, /edit or delete/]) {
      assert.match(save.description, pattern);
    }
    assert.match(BUILTIN_TOOLS.find((tool) => tool.name === 'memory_search')!.description, /short keywords separated by spaces/);
    assert.deepEqual(Object.keys(save.parameters.object).sort(), ['appliesTo', 'body', 'kind']);
  });

  test('Ask mode runs search, save and update without a prompt under every runtime\'s name; delete asks', () => {
    configureRuntimeDeps({
      dataDir,
      historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null },
      agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined },
      chatPermissions: { getMode: (id) => (id === 'trusting' ? 'trust' : 'ask'), hasGrant: () => false, grant: () => {} },
    });
    try {
      const names = (tool: string) => [tool, `mcp____michi_internal____${tool}`, `@michi/${tool}`];
      for (const tool of ['memory_search', 'memory_save', 'memory_update']) {
        for (const name of names(tool)) {
          assert.equal(resolveChatPolicy(chatOwner('n-a'), null, name), 'allow', `Pi ${name}`);
          assert.equal(resolveChatPolicy(chatOwner('n-a'), null, name, true), 'allow', `native ${name}`);
        }
      }
      for (const name of names('memory_delete')) {
        assert.equal(resolveChatPolicy(chatOwner('n-a'), null, name), 'ask', `Pi ${name}`);
        assert.equal(resolveChatPolicy(chatOwner('n-a'), null, name, true), 'ask', `native ${name}`);
        assert.equal(resolveChatPolicy(chatOwner('trusting'), null, name, true), 'allow', `Trust ${name}`);
      }
    } finally {
      __resetRuntimeDeps();
    }
    // Kiro names a Michi tool's permission request by its title: the policy sees the tool.
    for (const tool of MEMORY_TOOL_NAMES) {
      assert.equal(acpPermissionToolName({ title: `@michi/${tool}` }), `@michi/${tool}`, tool);
    }
  });
});
