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
// (CODEX_CLI_BIN, or codex on PATH) with its own credentials and three small
// model turns. Checks the capabilities probed in .probe/codex on codex 0.165:
// the auth gate without auth.json, collaboration modes (Plan blocks writes,
// survives a native resume, Default writes), goals off, steer and cancel.
const enabled = process.env.MICHI_CODEX_LIVE === '1';

test('real Codex: auth gate, collaboration modes, goals off, steer and cancel through the Michi adapter', {
  skip: !enabled, timeout: 420_000,
}, async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'michi-codex-live-')));
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
  const { CodexRuntime } = require('michi-runtime/internal/adapters/codex/CodexRuntime') as typeof import('michi-runtime/internal/adapters/codex/CodexRuntime');
  closeDb(); initDb();
  // Trust: Default-mode writes and shell commands run without an approval prompt.
  configureRuntimeDeps({ historyStore: { getNode: repo.getNode, listMessages: repo.listMessages,
    getWorkspace: repo.getWorkspace, getWorkspaceInstructions: repo.getWorkspaceInstructions }, dataDir: directory,
    providerKeys: { getProviderApiKey: () => null },
    agentConfig: { getAgentConfig: config.getAgentConfig, resolveModel: config.resolveModel, resolveReasoning: config.resolveReasoning },
    chatPermissions: { getMode: () => 'trust', hasGrant: () => false, grant: () => {} } });
  const registry = new McpSlotRegistry({ mcpPort: () => (server.address() as AddressInfo).port });
  const app = express(); app.use(express.json());
  const router = express.Router(); mountMcp(router, registry); app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };
  const runtime = new CodexRuntime({ ...codexAdapterOptions({ host: michiTestHost() }), bridge, mcpSlots: registry });
  const timer = setTimeout(() => { void runtime.shutdown(); }, 400_000);
  const nodeId = `codex-live-${randomUUID()}`;
  const options = { cwd: directory, workspaceId: 'live', enableFollowUps: false, reasoning: 'low' as const };
  const target = path.join(directory, 'mode-probe.txt');

  /** One turn; answers any question by skipping it, runs `onTool` at the first tool call. */
  async function turn(session: AgentSession, prompt: string, onTool?: () => Promise<void>) {
    const events: NormalizedEvent[] = [];
    let toolSeen = false;
    for await (const event of session.send(prompt)) {
      events.push(event);
      if (event.kind === 'runtime_error') throw new Error(event.error);
      if (event.kind === 'user_input_request') session.skipUserInput?.(event.requestId);
      if (event.kind === 'permission_request') session.respondToPermission?.(event.requestId, 'allow_once');
      if (event.kind === 'tool_call' && !toolSeen && onTool) { toolSeen = true; await onTool(); }
    }
    const text = events.filter((e) => e.kind === 'chunk').map((e) => (e as { text: string }).text).join('');
    const end = [...events].reverse().find((e) => e.kind === 'turn_end') as { stopReason?: string } | undefined;
    return { events, text, stopReason: end?.stopReason };
  }

  try {
    getDb().prepare('INSERT INTO workspaces (id,name,cwd,created_at,updated_at) VALUES (?,?,?,1,1)').run('live', 'Disposable Codex live test', directory);
    getDb().prepare("INSERT INTO nodes (id,workspace_id,parent_node_id,kind,status,created_at) VALUES (?,'live',NULL,'chat','idle',1)").run(nodeId);

    // Item 0: a Codex home without auth.json is not "unavailable" by itself.
    assert.equal(runtime.checkAvailability().available, true, runtime.checkAvailability().detail);
    const modes = await runtime.listModes('');
    assert.deepEqual(modes.map((mode) => mode.id).sort(), ['default', 'plan']);

    const session = await runtime.newSession({ ...options, sessionId: nodeId });
    assert.ok(session.nativeSessionId);
    assert.equal(runtime.checkAvailability().available, true, 'app-server confirmed the provider credentials');

    // Item 2: Plan explores and proposes, but does not write.
    await session.setMode!('plan');
    const plan = await turn(session, 'Create a file named mode-probe.txt in the current directory containing the word hello.');
    assert.equal(plan.stopReason, 'completed');
    assert.equal(fs.existsSync(target), false, 'Plan mode must not write the file');
    assert.ok(plan.text.trim().length > 0, 'the proposed plan is shown');
    const usage = plan.events.find((e) => e.kind === 'usage_summary') as { inputTokens?: number; source?: string } | undefined;
    assert.ok((usage?.inputTokens ?? 0) > 0 && usage?.source === 'native', 'thread/tokenUsage/updated reaches the turn summary');

    // A native resume keeps Plan, as Codex keeps it for the thread.
    const threadId = session.nativeSessionId!;
    repo.updateNodeResumeBinding(nodeId, { acp_session_id: threadId, runtime_id: 'codex', model_id: session.currentModelId ?? null, reasoning: 'low' });
    await runtime.releaseSession(nodeId);
    const resumed = await runtime.loadSession!({ ...options, sessionId: nodeId, nodeId });
    assert.equal(resumed.nativeSessionId, threadId);
    assert.equal(resumed.currentModeId, 'plan');

    // Item 3: goals are off in the resumed thread, so a goal starts no turn.
    const client = (runtime as unknown as { client: import('michi-runtime/internal/adapters/codex/CodexAppServerClient').CodexAppServerClient }).client;
    const selfStarted: string[] = [];
    const unsubscribe = client.onGlobalNotification((method, params) => {
      if (method === 'turn/started' && params.threadId === threadId) selfStarted.push(String((params.turn as { id?: string } | undefined)?.id));
    });
    await client.request('thread/goal/set', { threadId, origin: 'user', status: 'active', tokenBudget: 2_000, objective: 'Reply with the single word GOAL-DONE.' });
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    unsubscribe();
    await client.request('thread/goal/clear', { threadId, origin: 'user' }).catch(() => {});
    assert.deepEqual(selfStarted, [], 'Codex started a goal turn on its own');

    // Default writes again; turn/steer reaches the running turn.
    await resumed.setMode!('default');
    let steered: Awaited<ReturnType<NonNullable<AgentSession['steer']>>> | undefined;
    const work = await turn(resumed,
      'Run the shell command `sleep 6`. After it finishes, create mode-probe.txt in the current directory containing hello, then reply with the single word ORIGINAL.',
      async () => { steered = await resumed.steer!('New instruction: when you reply at the end, reply with the single word STEERED instead of ORIGINAL.'); });
    assert.equal(steered?.accepted, true, `steer: ${steered?.reason}`);
    assert.ok(fs.existsSync(target), 'Default mode wrote the file');
    assert.match(work.text, /STEERED/);

    // turn/interrupt is acknowledged natively and ends the turn as cancelled.
    let ack: { acknowledged: boolean; source?: string } | undefined;
    const stopped = await turn(resumed, 'Run the shell command `sleep 60`, then reply DONE.', async () => {
      ack = (await resumed.cancel()) as typeof ack;
    });
    assert.deepEqual(ack && { acknowledged: ack.acknowledged, source: ack.source }, { acknowledged: true, source: 'native' });
    assert.equal(stopped.stopReason, 'cancelled');
  } finally {
    clearTimeout(timer);
    await runtime.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearAllSessions(); __resetRuntimeDeps(); closeDb(); process.env = priorEnv;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
