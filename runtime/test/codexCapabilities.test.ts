import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeHost } from '../src/contract/host';
import type { McpSlot, McpSlotCallbacks, McpSlotProvider } from '../src/contract/mcp';
import type { NormalizedEvent } from '../src/contract/events';
import { createDefaultHost } from '../src/core/defaultHost';
import type { CodexAppServerClient, ServerRequestHandler } from '../src/adapters/codex/CodexAppServerClient';
import { CodexRuntime } from '../src/adapters/codex/CodexRuntime';
import type { CodexSession } from '../src/adapters/codex/CodexSession';
import { CodexAuthMissingError, resetCodexBinaryCacheForTest } from '../src/adapters/codex/codexBinary';
import { createCodexTranslator } from '../src/adapters/codex/codexEventTranslator';
import {
  buildCodexCollaborationMode, CODEX_HOST_MCP_SERVER, CODEX_THREAD_FEATURES_OFF, codexAccountLoginMissing,
} from '../src/adapters/codex/codexProtocol';
import { CODEX_RESTRICTED_FEATURES_OFF } from '../src/adapters/codex/codexRestrictedProfile';

// Wire shapes below are the ones codex 0.165.0 sent in .probe/codex (item0c,
// item2, item3b): account/read, collaborationMode/list, plan items.

interface Request { method: string; params: Record<string, any> }

interface FakeOptions {
  accountRead?: unknown;
  modeList?: unknown | Error;
  resumeMode?: string | null;
}

function fakeAppServer(options: FakeOptions = {}) {
  const requests: Request[] = [];
  const turnIds = new Map<string, string>();
  const handlers = new Map<string, Set<(method: string, params: Record<string, unknown>) => void>>();
  let threads = 0;
  const emit = (threadId: string, method: string, params: Record<string, unknown>) => {
    for (const handler of handlers.get(threadId) ?? []) handler(method, params);
  };
  const client = {
    ensureStarted: async () => {},
    request: async (method: string, params: Record<string, any>) => {
      requests.push({ method, params });
      switch (method) {
        case 'account/read':
          return options.accountRead ?? { account: { type: 'amazonBedrock', usesCodexManagedCredentials: false }, requiresOpenaiAuth: false };
        case 'collaborationMode/list':
          if (options.modeList instanceof Error) throw options.modeList;
          return options.modeList ?? { data: [
            { name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'medium' },
            { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
          ] };
        case 'thread/start':
          return { thread: { id: `thread-${++threads}` } };
        case 'thread/fork':
          return { thread: { id: `fork-${++threads}` } };
        case 'thread/resume':
          return { thread: { id: params.threadId }, collaborationMode: options.resumeMode === undefined || options.resumeMode === null
            ? null : { mode: options.resumeMode, settings: { model: 'test-model', reasoning_effort: null, developer_instructions: null } } };
        case 'turn/start': {
          const id = `turn-${params.threadId}-${requests.length}`;
          turnIds.set(params.threadId, id);
          return { turn: { id } };
        }
        case 'model/list':
          return { data: [] };
        case 'config/read':
          return { config: { mcp_servers: {} }, origins: {} };
        case 'mcpServerStatus/list':
          return { data: [{ name: CODEX_HOST_MCP_SERVER, runtimeStatus: 'connected', tools: {} }] };
        default:
          return {};
      }
    },
    onNotification: (threadId: string, handler: (method: string, params: Record<string, unknown>) => void) => {
      let set = handlers.get(threadId);
      if (!set) handlers.set(threadId, (set = new Set()));
      set.add(handler);
      return () => { set.delete(handler); };
    },
    onGlobalNotification: () => () => {},
    onServerRequest: (_handler: ServerRequestHandler) => {},
    onExit: () => () => {},
    shutdown: async () => {},
    isRunning: () => true,
  };
  const turnStarts = (threadId: string) => requests.filter((r) => r.method === 'turn/start' && r.params.threadId === threadId);
  return {
    client: client as unknown as CodexAppServerClient,
    requests,
    turnStarts,
    count: (method: string) => requests.filter((r) => r.method === method).length,
    endTurn: (threadId: string) => emit(threadId, 'turn/completed', { threadId, turn: { id: turnIds.get(threadId), status: 'completed' } }),
  };
}

function slotProvider(): McpSlotProvider {
  let slots = 0;
  return {
    create: (parentChatId: string, cwd: string, ownerUserId: string | null, cbs: McpSlotCallbacks) =>
      ({ slotId: `slot-${++slots}`, parentChatId, cwd, ownerUserId, nodeId: null, workspaceId: null, ...cbs }) as McpSlot,
    dispose: async () => {},
    endpoint: (slotId: string) => ({ type: 'http', url: `http://127.0.0.1:1/api/mcp/${slotId}`, headers: [] }),
    hookEndpoint: (slotId: string) => `http://127.0.0.1:1/mcp-hooks/${slotId}/stop`,
  } as unknown as McpSlotProvider;
}

const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };

/**
 * checkAvailability looks up the Codex CLI before it reports the login state.
 * A placeholder file passed as binaryPath (the host's CODEX_CLI_BIN) satisfies
 * that lookup, so these tests do not depend on a codex install.
 */
function fakeCodexBinary(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-capabilities-bin-'));
  const binary = path.join(dir, 'codex');
  fs.writeFileSync(binary, '');
  resetCodexBinaryCacheForTest();
  t.after(() => {
    resetCodexBinaryCacheForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return binary;
}

function codexRuntime(t: TestContext, options: FakeOptions & { host?: RuntimeHost; authFileMissing?: string } = {}) {
  const server = fakeAppServer(options);
  const runtime = new CodexRuntime(
    { host: options.host ?? createDefaultHost({ logLevel: 'silent' }), bridge, mcpSlots: slotProvider(), binaryPath: fakeCodexBinary(t) },
    { client: server.client, followUpsHookPocEnabled: false, ...(options.authFileMissing ? { authFileMissing: options.authFileMissing } : {}) },
  );
  t.after(() => runtime.shutdown());
  return { server, runtime };
}

/** Runs one turn of `session` to its end, completing it on the fake server once it started. */
async function runTurn(server: ReturnType<typeof fakeAppServer>, session: CodexSession, text = 'hello') {
  const before = server.turnStarts(session.threadId).length;
  const events: NormalizedEvent[] = [];
  const drain = (async () => { for await (const event of session.send(text)) events.push(event); })();
  for (let i = 0; i < 200 && server.turnStarts(session.threadId).length === before; i += 1) await new Promise((r) => setTimeout(r, 2));
  const turnStart = server.turnStarts(session.threadId).at(-1)!;
  assert.ok(turnStart, 'turn/start was sent');
  await new Promise((r) => setImmediate(r));
  server.endTurn(session.threadId);
  await drain;
  return { turnStart, events };
}

describe('Codex auth: a missing auth.json is a hint, app-server decides', () => {
  it('opens sessions for a provider that manages its own credentials (Amazon Bedrock)', async (t) => {
    const { server, runtime } = codexRuntime(t, { authFileMissing: 'No Codex auth found. Expected /home/u/.codex/auth.json.' });
    assert.deepEqual(runtime.checkAvailability(), { available: true });
    await runtime.newSession({ sessionId: 'chat-a', cwd: os.tmpdir(), model: 'test-model' });
    await runtime.newSession({ sessionId: 'chat-b', cwd: os.tmpdir(), model: 'test-model' });
    assert.equal(server.count('account/read'), 1, 'asked once per app-server process');
    assert.deepEqual(server.requests.find((r) => r.method === 'account/read')!.params, { refreshToken: false });
    assert.deepEqual(runtime.checkAvailability(), { available: true });
  });

  it('refuses the session before any thread when app-server says the OpenAI login is missing', async (t) => {
    const { server, runtime } = codexRuntime(t, {
      authFileMissing: 'No Codex auth found. Expected /home/u/.codex/auth.json.',
      accountRead: { account: null, requiresOpenaiAuth: true, workspaceRouting: null },
    });
    await assert.rejects(runtime.newSession({ sessionId: 'chat-a', cwd: os.tmpdir(), model: 'test-model' }), (err: unknown) => {
      assert.ok(err instanceof CodexAuthMissingError);
      assert.match((err as Error).message, /codex login/);
      return true;
    });
    assert.equal(server.count('thread/start'), 0);
    const availability = runtime.checkAvailability();
    assert.equal(availability.available, false);
    assert.match(availability.detail ?? '', /Codex needs a login/);
  });

  it('sends no account/read when auth.json exists', async (t) => {
    const { server, runtime } = codexRuntime(t);
    await runtime.newSession({ sessionId: 'chat-a', cwd: os.tmpdir(), model: 'test-model' });
    assert.equal(server.count('account/read'), 0);
  });

  it('reads account/read the way 0.165 answers it', () => {
    assert.equal(codexAccountLoginMissing({ account: { type: 'amazonBedrock', usesCodexManagedCredentials: false }, requiresOpenaiAuth: false }), false);
    assert.equal(codexAccountLoginMissing({ account: null, requiresOpenaiAuth: true, workspaceRouting: null }), true);
    assert.equal(codexAccountLoginMissing({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }), false);
    assert.equal(codexAccountLoginMissing({}), false);
    assert.equal(codexAccountLoginMissing(null), false);
  });
});

describe('Codex collaboration modes', () => {
  it('reports modes as a capability and lists Default and Plan from collaborationMode/list once', async (t) => {
    const { server, runtime } = codexRuntime(t);
    assert.equal(runtime.capabilities.modes, true);
    const modes = await runtime.listModes('');
    assert.deepEqual(modes.map((mode) => [mode.id, mode.label]), [['plan', 'Plan'], ['default', 'Default']]);
    assert.ok(modes.every((mode) => mode.description));
    await runtime.listModes('');
    assert.equal(server.count('collaborationMode/list'), 1);
  });

  it('lists no modes when app-server has no collaborationMode/list', async (t) => {
    const { runtime } = codexRuntime(t, { modeList: new Error('codex collaborationMode/list failed: method not found (code -32601)') });
    assert.deepEqual(await runtime.listModes(''), []);
  });

  it('sends the chosen mode with every later turn, and nothing before one is chosen', async (t) => {
    const { server, runtime } = codexRuntime(t);
    const session = await runtime.newSession({ sessionId: 'chat-a', cwd: os.tmpdir(), model: 'test-model', reasoning: 'low' }) as CodexSession;
    const plain = await runTurn(server, session);
    assert.equal('collaborationMode' in plain.turnStart.params, false);
    assert.equal(session.currentModeId, null);

    await session.setMode('plan');
    assert.equal(session.currentModeId, 'plan');
    const plan = await runTurn(server, session);
    assert.deepEqual(plan.turnStart.params.collaborationMode, {
      mode: 'plan', settings: { model: 'test-model', reasoning_effort: 'low', developer_instructions: null },
    });
    // Codex keeps the last mode, so later turns repeat it…
    const again = await runTurn(server, session);
    assert.equal(again.turnStart.params.collaborationMode.mode, 'plan');
    // …and leaving Plan means sending Default explicitly.
    await session.setMode('default');
    const back = await runTurn(server, session);
    assert.deepEqual(back.turnStart.params.collaborationMode, buildCodexCollaborationMode('default', 'test-model', 'low'));
  });

  it('refuses unknown modes and modes for the restricted assistant', async (t) => {
    const { runtime } = codexRuntime(t);
    const session = await runtime.newSession({ sessionId: 'chat-a', cwd: os.tmpdir(), model: 'test-model' }) as CodexSession;
    await assert.rejects(session.setMode('architect'), /Unknown Codex collaboration mode/);
    assert.equal(session.currentModeId, null);
    const restricted = await runtime.newSession({
      sessionId: 'chat-r', cwd: os.tmpdir(), model: 'test-model', toolProfile: { allowedToolNames: ['read_node'], restricted: true },
    }) as CodexSession;
    await assert.rejects(restricted.setMode('plan'), /default mode/);
  });

  it('keeps Plan for a thread that resumes in Plan, and adopts nothing for Default', async (t) => {
    const node = (id: string, thread: string) => ({ id, workspace_id: '', kind: 'chat', status: 'idle', runtime_id: 'codex', external_session_id: thread });
    const host = createDefaultHost({ logLevel: 'silent', nodes: [node('chat-plan', 'thread-plan')] });
    const { runtime } = codexRuntime(t, { host, resumeMode: 'plan' });
    const resumed = await runtime.loadSession({ sessionId: 'chat-plan', cwd: os.tmpdir(), model: 'test-model' }) as CodexSession;
    assert.equal(resumed.currentModeId, 'plan');

    const hostDefault = createDefaultHost({ logLevel: 'silent', nodes: [node('chat-default', 'thread-default')] });
    const { runtime: other } = codexRuntime(t, { host: hostDefault, resumeMode: 'default' });
    const plain = await other.loadSession({ sessionId: 'chat-default', cwd: os.tmpdir(), model: 'test-model' }) as CodexSession;
    assert.equal(plain.currentModeId, null);
  });

  it('carries a live parent\'s mode into its native fork', async (t) => {
    const host = createDefaultHost({ logLevel: 'silent' });
    const { runtime } = codexRuntime(t, { host });
    const parent = await runtime.newSession({ sessionId: 'chat-parent', cwd: os.tmpdir(), model: 'test-model' }) as CodexSession;
    await parent.setMode('plan');
    const child = await runtime.forkSession({
      sessionId: 'chat-child', cwd: os.tmpdir(), model: 'test-model', parentChatId: 'chat-parent', sourceNativeSessionId: parent.threadId,
    }) as CodexSession;
    assert.equal(child.currentModeId, 'plan');
  });
});

describe('Codex goals stay off in every Michi thread', () => {
  it('turns goals off on thread/start, thread/resume and thread/fork, ordinary and restricted', async (t) => {
    const host = createDefaultHost({ logLevel: 'silent', nodes: [{ id: 'chat-old', workspace_id: '', kind: 'chat', status: 'idle', runtime_id: 'codex', external_session_id: 'thread-old' }] });
    const { server, runtime } = codexRuntime(t, { host });
    const parent = await runtime.newSession({ sessionId: 'chat-a', cwd: os.tmpdir(), model: 'test-model' }) as CodexSession;
    await runtime.forkSession({ sessionId: 'chat-b', cwd: os.tmpdir(), model: 'test-model', parentChatId: 'chat-a', sourceNativeSessionId: parent.threadId });
    await runtime.loadSession({ sessionId: 'chat-old', cwd: os.tmpdir(), model: 'test-model' });
    for (const method of ['thread/start', 'thread/fork', 'thread/resume']) {
      const request = server.requests.find((r) => r.method === method)!;
      assert.equal(request.params.config.features.goals, false, `${method} turns goals off`);
    }
    assert.deepEqual(server.requests.find((r) => r.method === 'thread/start')!.params.config.features, CODEX_THREAD_FEATURES_OFF);
    assert.equal(CODEX_RESTRICTED_FEATURES_OFF.goals, false);
  });

  it('keeps the follow-ups hook feature next to goals off', async (t) => {
    const server = fakeAppServer();
    const runtime = new CodexRuntime(
      { host: createDefaultHost({ logLevel: 'silent' }), bridge, mcpSlots: slotProvider() },
      { client: server.client, followUpsHookPocEnabled: true },
    );
    t.after(() => runtime.shutdown());
    await runtime.newSession({ sessionId: 'chat-a', cwd: os.tmpdir(), model: 'test-model' });
    assert.deepEqual(server.requests.find((r) => r.method === 'thread/start')!.params.config.features, { hooks: true, goals: false });
  });
});

describe('Codex Plan-mode output', () => {
  const plan = (text: string, id = 'turn-1-plan') => ({ threadId: 't', turnId: 'turn-1', item: { type: 'plan', id, text } });

  it('shows the completed proposed plan as answer text, separated from other messages', () => {
    const events: NormalizedEvent[] = [];
    const translator = createCodexTranslator((event) => events.push(event));
    translator.feed('item/agentMessage/delta', { threadId: 't', turnId: 'turn-1', itemId: 'msg-1', delta: 'Exploring first.' });
    translator.feed('item/started', plan(''));
    translator.feed('item/plan/delta', { threadId: 't', turnId: 'turn-1', itemId: 'turn-1-plan', delta: 'draft that may differ' });
    translator.feed('item/completed', plan('Create `a.txt` containing hello.\n'));
    translator.feed('item/agentMessage/delta', { threadId: 't', turnId: 'turn-1', itemId: 'msg-2', delta: 'Switch to Default to apply it.' });
    const text = events.filter((event) => event.kind === 'chunk').map((event) => (event as { text: string }).text).join('');
    assert.equal(text, 'Exploring first.\n\nCreate `a.txt` containing hello.\n\n\nSwitch to Default to apply it.');
    assert.ok(!text.includes('draft'), 'plan deltas are not shown');
  });

  it('shows nothing for an empty plan item', () => {
    const events: NormalizedEvent[] = [];
    const translator = createCodexTranslator((event) => events.push(event));
    translator.feed('item/completed', plan('  '));
    assert.deepEqual(events, []);
  });
});
