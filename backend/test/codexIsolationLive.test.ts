import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AgentSession } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';

// Explicit opt-in: drives Michi's Codex adapter against the installed CLI
// (CODEX_CLI_BIN, or codex on PATH) with its own credentials and two small
// model turns (plus one sub-agent turn that Michi stops). Checks, on codex 0.165:
//  - an ordinary chat thread runs none of the user's MCP servers (disabled by name);
//  - a restricted session's spawn_agent is refused by Codex (no child thread);
//  - without that limit, the session's guard stops the turn and the child.
const enabled = process.env.MICHI_CODEX_LIVE === '1';

const SPAWN_PROMPT = 'Use your spawn_agent tool to start exactly one sub-agent with this task: "Write the numbers from 1 to 400, one per line, and nothing else." '
  + 'Wait for it to finish, then reply with the last line it wrote. If spawning fails, reply SPAWN-FAILED followed by the exact error text.';

test('real Codex: MCP isolation in ordinary chats and no sub-agents in restricted sessions', { skip: !enabled, timeout: 420_000 }, async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'michi-codex-isolation-live-')));
  const priorEnv = { ...process.env };
  Object.assign(process.env, { MICHI_DATA_DIR: directory, MICHI_TITLE_MODEL_CODEX: 'off', MICHI_CODEX_FOLLOW_UPS_HOOK_POC: '0' });
  delete process.env.MICHI_CLOUD;
  const { closeDb, getDb, initDb } = require('../src/services/db') as typeof import('../src/services/db');
  const repo = require('../src/services/dbRepository') as typeof import('../src/services/dbRepository');
  const { configureRuntimeDeps, __resetRuntimeDeps } = require('../src/agents/runtimeDeps') as typeof import('../src/agents/runtimeDeps');
  const { clearAllSessions } = require('../src/agents/sessionRegistry') as typeof import('../src/agents/sessionRegistry');
  const config = require('../src/services/agentConfig') as typeof import('../src/services/agentConfig');
  const { McpSlotRegistry, mountMcp } = require('../src/services/mcpServer') as typeof import('../src/services/mcpServer');
  const { codexAdapterOptions } = require('../src/agents/runtimeFactories') as typeof import('../src/agents/runtimeFactories');
  const { michiTestHost } = require('./helpers/michiTestHost') as typeof import('./helpers/michiTestHost');
  const { restrictedChatProfile } = require('./helpers/restrictedChatProfile') as typeof import('./helpers/restrictedChatProfile');
  const { CodexRuntime } = require('michi-runtime/internal/adapters/codex/CodexRuntime') as typeof import('michi-runtime/internal/adapters/codex/CodexRuntime');
  const { CODEX_HOST_MCP_SERVER } = require('michi-runtime/internal/adapters/codex/codexProtocol') as typeof import('michi-runtime/internal/adapters/codex/codexProtocol');
  type Client = import('michi-runtime/internal/adapters/codex/CodexAppServerClient').CodexAppServerClient;
  closeDb(); initDb();
  configureRuntimeDeps({ historyStore: { getNode: repo.getNode, listMessages: repo.listMessages,
    getWorkspace: repo.getWorkspace, getWorkspaceInstructions: repo.getWorkspaceInstructions }, dataDir: directory,
    providerKeys: { getProviderApiKey: () => null },
    agentConfig: { getAgentConfig: config.getAgentConfig, resolveModel: config.resolveModel, resolveReasoning: config.resolveReasoning } });
  const registry = new McpSlotRegistry({ mcpPort: () => (server.address() as AddressInfo).port });
  const app = express(); app.use(express.json());
  const router = express.Router(); mountMcp(router, registry); app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };
  const options = () => ({ ...codexAdapterOptions({ host: michiTestHost() }), bridge, mcpSlots: registry });
  const runtime = new CodexRuntime(options());
  // The same adapter without the restricted sub-agent limit: only the session's guard is left.
  const unguarded = new CodexRuntime(options(), { restrictedSubagentLimit: false });
  const timer = setTimeout(() => { void runtime.shutdown(); void unguarded.shutdown(); }, 400_000);
  const base = { cwd: directory, workspaceId: 'live', enableFollowUps: false, reasoning: 'low' as const };
  const clientOf = (r: unknown) => (r as { client: Client }).client;

  /** Every notification of `client` while `run` runs. */
  async function recording<T>(client: Client, run: () => Promise<T>) {
    const seen: Array<{ method: string; params: Record<string, any>; at: number }> = [];
    const off = client.onGlobalNotification((method, params) => { seen.push({ method, params, at: Date.now() }); });
    try { return { result: await run(), seen }; } finally { off(); }
  }
  async function turn(session: AgentSession, prompt: string) {
    const events: NormalizedEvent[] = [];
    for await (const event of session.send(prompt)) events.push(event);
    return events;
  }

  try {
    getDb().prepare('INSERT INTO workspaces (id,name,cwd,created_at,updated_at) VALUES (?,?,?,1,1)').run('live', 'Disposable Codex isolation test', directory);

    // 1. Ordinary chat: the user's configured MCP servers are disabled in its thread (no model call).
    const chat = await runtime.newSession({ ...base, sessionId: `chat-${randomUUID()}` });
    const client = clientOf(runtime);
    const configured = Object.keys(((await client.request('config/read', { cwd: directory })) as any)?.config?.mcp_servers ?? {})
      .filter((name) => name !== CODEX_HOST_MCP_SERVER);
    const statuses = ((await client.request('mcpServerStatus/list', { threadId: chat.nativeSessionId, detail: 'toolsAndAuthOnly' })) as any).data as Array<{ name: string; runtimeStatus: string }>;
    for (const name of configured) {
      assert.equal(statuses.find((s) => s.name === name)?.runtimeStatus, 'disabled', `${name} runs in an ordinary chat`);
    }
    assert.ok(statuses.some((s) => s.name === CODEX_HOST_MCP_SERVER), 'Michi\'s own server stays');
    if (configured.length === 0) console.warn('[codexIsolationLive] this Codex home configures no MCP servers; isolation was not exercised');

    // 2. Restricted session: Codex refuses spawn_agent itself; no child thread, no Michi error.
    const assistant = await runtime.newSession({ ...base, sessionId: `assistant-${randomUUID()}`, toolProfile: restrictedChatProfile() });
    const prevented = await recording(client, () => turn(assistant, SPAWN_PROMPT));
    const threadId = assistant.nativeSessionId!;
    const foreignTurns = prevented.seen.filter((n) => n.method === 'turn/started' && n.params.threadId !== threadId && n.params.turn?.rootTurnId
      && prevented.seen.some((p) => p.method === 'turn/started' && p.params.threadId === threadId && p.params.turn?.id === n.params.turn.rootTurnId));
    assert.deepEqual(foreignTurns, [], 'no sub-agent turn started');
    assert.ok(!prevented.seen.some((n) => n.params.threadId === threadId && n.params.item?.type === 'subAgentActivity'), 'no subAgentActivity');
    assert.ok(!prevented.result.some((e) => e.kind === 'runtime_error'), 'the turn ends normally');
    const rollout = findRollout(threadId);
    assert.ok(rollout, 'the thread\'s rollout exists');
    const transcript = fs.readFileSync(rollout!, 'utf8');
    assert.match(transcript, /"name":"spawn_agent"/, 'the model tried spawn_agent');
    assert.match(transcript, /agent thread limit reached/, 'and Codex refused it');

    // 3. Without the limit, the session's guard stops the turn and the child before it finishes.
    const guarded = await unguarded.newSession({ ...base, sessionId: `assistant-${randomUUID()}`, toolProfile: restrictedChatProfile() });
    const stopped = await recording(clientOf(unguarded), () => turn(guarded, SPAWN_PROMPT));
    const error = stopped.result.find((e) => e.kind === 'runtime_error') as Extract<NormalizedEvent, { kind: 'runtime_error' }> | undefined;
    assert.equal(error?.code, 'codex_subagent_blocked', `turn events: ${stopped.result.map((e) => e.kind).join(',')}`);
    const spawn = stopped.seen.find((n) => n.params.threadId === guarded.nativeSessionId && n.method === 'item/started' && n.params.item?.type === 'subAgentActivity');
    const childId = spawn?.params.item.agentThreadId as string;
    assert.ok(childId, 'Codex started a child (the limit was off)');
    // The child's turn ends interrupted; wait briefly for its terminal frame.
    const childEnd = async () => {
      for (let i = 0; i < 100; i += 1) {
        const end = stopped.seen.find((n) => n.method === 'turn/completed' && n.params.threadId === childId);
        if (end) return end;
        await new Promise((r) => setTimeout(r, 100));
      }
      return undefined;
    };
    const off = clientOf(unguarded).onGlobalNotification((method, params) => { stopped.seen.push({ method, params, at: Date.now() }); });
    const end = await childEnd();
    off();
    assert.equal(end?.params.turn?.status, 'interrupted', 'the child turn was interrupted');
    const childText = stopped.seen.filter((n) => n.method === 'item/agentMessage/delta' && n.params.threadId === childId).map((n) => n.params.delta).join('');
    assert.doesNotMatch(childText.trim(), /(^|\n)400$/, 'the child did not finish');
  } finally {
    clearTimeout(timer);
    await runtime.shutdown();
    await unguarded.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearAllSessions(); __resetRuntimeDeps(); closeDb(); process.env = priorEnv;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** The rollout Codex wrote for a thread under its home's sessions directory (read-only). */
function findRollout(threadId: string): string | undefined {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const found = fs.readdirSync(root, { recursive: true }).map(String).find((file) => file.includes(threadId) && file.endsWith('.jsonl'));
  return found ? path.join(root, found) : undefined;
}
