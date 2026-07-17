import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexSession } from '../src/agents/codex/CodexSession';
import type { CodexAppServerClient } from '../src/agents/codex/CodexAppServerClient';
import type { McpSlotRegistry } from '../src/services/mcpServer';
import type { AgentToolBridge } from '../src/agents/toolBridge';

// ---- Stubs ------------------------------------------------------------------

function makeStubClient(overrides: Partial<CodexAppServerClient> = {}): CodexAppServerClient {
  const notifHandlers = new Map<string, Set<(method: string, params: Record<string, unknown>) => void>>();
  const client: any = {
    ensureStarted: async () => {},
    request: async (_method: string, _params: unknown) => ({}),
    onNotification: (threadId: string, handler: (method: string, params: Record<string, unknown>) => void) => {
      let set = notifHandlers.get(threadId);
      if (!set) { set = new Set(); notifHandlers.set(threadId, set); }
      set.add(handler);
      return () => { set!.delete(handler); };
    },
    onServerRequest: (_h: unknown) => {},
    onExit: (_cb: () => void) => () => {},
    shutdown: async () => {},
    // Test helper: emit a notification to all handlers for a threadId
    _emit: (threadId: string, method: string, params: Record<string, unknown>) => {
      for (const h of notifHandlers.get(threadId) ?? []) h(method, params);
    },
    ...overrides,
  };
  return client as CodexAppServerClient;
}

function makeStubMcpRegistry(): McpSlotRegistry {
  const registry: any = {
    create: (_parentChatId: string, _cwd: string, _ownerUserId: string | null, cbs: any, _opts?: any) => {
      return { slotId: 'test-slot-id', parentChatId: _parentChatId, cwd: _cwd, workspaceId: null, nodeId: null, ownerUserId: null, ...cbs };
    },
    dispose: async (_slotId: string) => {},
    get: (_slotId: string) => undefined,
  };
  return registry as McpSlotRegistry;
}

function makeStubBridge(): AgentToolBridge {
  return {
    spawnBranches: async () => [],
    saveContext: () => null,
    updateContext: () => null,
  };
}

function makeSession(clientOverrides: Partial<CodexAppServerClient> = {}) {
  const client = makeStubClient(clientOverrides);
  const session = new CodexSession({
    nodeId: 'node-1',
    threadId: 'thread-1',
    cwd: '/tmp/test',
    workspaceId: null,
    client,
    mcpRegistry: makeStubMcpRegistry(),
    bridge: makeStubBridge(),
    mcpPort: 3001,
  });
  session.createMcpSlot();
  session.wireNotifications();
  return { session, client: client as any };
}

// ---- Tests ------------------------------------------------------------------

test('send streams chunks and ends on turn/completed; history is recorded', async () => {
  let requestedMethod = '';
  const client = makeStubClient({
    request: async (method: string, _params: unknown) => {
      requestedMethod = method;
      return {};
    },
  });
  const session = new CodexSession({
    nodeId: 'node-1',
    threadId: 'thread-1',
    cwd: '/tmp/test',
    workspaceId: null,
    client,
    mcpRegistry: makeStubMcpRegistry(),
    bridge: makeStubBridge(),
    mcpPort: 3001,
  });
  session.createMcpSlot();
  session.wireNotifications();

  const events: string[] = [];
  const turnPromise = (async () => {
    for await (const ev of session.send('hello')) {
      events.push(ev.kind);
    }
  })();

  // Give the turn/start request a tick to fire
  await new Promise((r) => setImmediate(r));

  // Emit notifications as codex app-server would
  (client as any)._emit('thread-1', 'item/agentMessage/delta', { threadId: 'thread-1', delta: 'Hello ' });
  (client as any)._emit('thread-1', 'item/agentMessage/delta', { threadId: 'thread-1', delta: 'world' });
  (client as any)._emit('thread-1', 'turn/completed', {
    threadId: 'thread-1',
    turn: { status: 'completed' },
  });

  await turnPromise;

  assert.equal(requestedMethod, 'turn/start');
  assert.ok(events.includes('chunk'), 'should have chunk events');
  assert.ok(events.includes('turn_end'), 'should end with turn_end');
  assert.ok(events.includes('usage_summary'), 'should have usage_summary from turn/completed');

  const history = session.getHistory();
  assert.equal(history.length, 2);
  assert.equal(history[0].role, 'user');
  assert.equal(history[0].content, 'hello');
  assert.equal(history[1].role, 'assistant');
  assert.equal(history[1].content, 'Hello world');
});

test('internal Michi metadata tool calls never enter the visible event stream', async () => {
  const { session, client } = makeSession();
  const events: Array<{ kind: string; title?: string }> = [];
  const turnPromise = (async () => {
    for await (const ev of session.send('hello')) {
      events.push(ev as { kind: string; title?: string });
    }
  })();

  await new Promise((r) => setImmediate(r));
  client._emit('thread-1', 'item/started', {
    item: {
      id: 'metadata-tool-1',
      type: 'mcpToolCall',
      server: '__michi_internal__',
      tool: 'michi_internal____set_branch_overview',
      status: 'inProgress',
      arguments: { overview: 'hidden' },
    },
  });
  client._emit('thread-1', 'item/completed', {
    item: {
      id: 'metadata-tool-1',
      type: 'mcpToolCall',
      server: '__michi_internal__',
      tool: 'michi_internal____set_branch_overview',
      status: 'completed',
      result: { content: [] },
    },
  });
  client._emit('thread-1', 'turn/completed', {
    threadId: 'thread-1',
    turn: { status: 'completed' },
  });

  await turnPromise;
  assert.equal(events.some((event) => event.kind === 'tool_call'), false);
  assert.equal(events.some((event) => event.kind === 'tool_call_update'), false);
});

test('cancel issues turn/interrupt', async () => {
  const requests: string[] = [];
  let resolveTurnStart!: () => void;
  const turnStartPromise = new Promise<void>((r) => { resolveTurnStart = r; });

  const client = makeStubClient({
    request: async (method: string, _params: unknown) => {
      requests.push(method);
      if (method === 'turn/start') {
        resolveTurnStart();
        // Never resolves on its own — simulates a long-running turn
        await new Promise(() => {});
      }
      return {};
    },
  });

  const session = new CodexSession({
    nodeId: 'node-2',
    threadId: 'thread-2',
    cwd: '/tmp/test',
    workspaceId: null,
    client,
    mcpRegistry: makeStubMcpRegistry(),
    bridge: makeStubBridge(),
    mcpPort: 3001,
  });
  session.createMcpSlot();
  session.wireNotifications();

  // Start turn (don't await — it hangs)
  const sendPromise = (async () => {
    for await (const _ev of session.send('do something long')) { /* drain */ }
  })();
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  sendPromise.catch(() => {}); // suppress unhandled rejection

  // Wait for turn/start to be issued
  await turnStartPromise;

  await session.cancel();

  assert.ok(requests.includes('turn/interrupt'), 'cancel should issue turn/interrupt');
});

test('markCrashed terminates an in-flight drain with turn_end (terminal safety)', async () => {
  let turnStartResolved = false;

  const client = makeStubClient({
    request: async (method: string, _params: unknown) => {
      if (method === 'turn/start') {
        turnStartResolved = true;
        // Resolve immediately — the session enters the drain loop
        return {};
      }
      return {};
    },
  });

  const session = new CodexSession({
    nodeId: 'node-3',
    threadId: 'thread-3',
    cwd: '/tmp/test',
    workspaceId: null,
    client,
    mcpRegistry: makeStubMcpRegistry(),
    bridge: makeStubBridge(),
    mcpPort: 3001,
  });
  session.createMcpSlot();
  session.wireNotifications();

  const events: string[] = [];
  const sendPromise = (async () => {
    for await (const ev of session.send('long task')) {
      events.push(ev.kind);
    }
  })();

  // Give the event loop a tick so send() enters the drain loop (awaiting queue.pull)
  await new Promise((r) => setImmediate(r));
  assert.ok(turnStartResolved, 'turn/start should have resolved');

  // Crash the session (simulate daemon exit) — this pushes events to the queue
  session.markCrashed('test crash reason');

  await sendPromise;

  assert.ok(events.includes('turn_end'), 'markCrashed should push turn_end to terminate the drain');
  assert.ok(events.includes('mcp_server_error'), 'markCrashed should push mcp_server_error');
  const turnEnd = events[events.length - 1];
  assert.equal(turnEnd, 'turn_end', 'turn_end should be last event');
});

test('Codex MCP slot routes ask_user through the session user-input flow', async () => {
  let callbacks: Record<string, (...args: any[]) => any> = {};
  const registry = {
    create: (_parentChatId: string, _cwd: string, _ownerUserId: string | null, cbs: typeof callbacks) => {
      callbacks = cbs;
      return { slotId: 'codex-ask-user-slot', ...cbs };
    },
    dispose: async () => {},
    get: () => undefined,
  } as unknown as McpSlotRegistry;
  const session = new CodexSession({
    nodeId: 'node-ask-user',
    threadId: 'thread-ask-user',
    cwd: '/tmp/test',
    workspaceId: null,
    client: makeStubClient(),
    mcpRegistry: registry,
    bridge: makeStubBridge(),
    mcpPort: 3001,
  });
  session.createMcpSlot();

  assert.equal(typeof callbacks.onAskUser, 'function');
  const answerPromise = callbacks.onAskUser([{
    question: 'Pick one',
    header: 'Choice',
    options: [
      { label: 'A', description: 'First option' },
      { label: 'B', description: 'Second option' },
    ],
    multiSelect: false,
  }]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.pendingPermissions.size, 0);
  const pendingUserInputs = (session as any).pendingUserInputs as Map<number, unknown>;
  assert.equal(pendingUserInputs.size, 1);
  const [requestId] = pendingUserInputs.keys();
  session.respondToUserInput(requestId, [{ question: 'Pick one', answer: 'A' }]);

  assert.deepEqual(await answerPromise, { 'Pick one': 'A' });
  assert.equal(pendingUserInputs.size, 0);
  await session.dispose();
});

test('Codex metadata Hook POC requires overview and follow-ups while hiding repair text', async () => {
  let callbacks: Record<string, (...args: any[]) => any> = {};
  const capturedTurnStartParams: Record<string, unknown>[] = [];
  const client = makeStubClient({
    request: async (method: string, params: unknown) => {
      if (method === 'turn/start') capturedTurnStartParams.push(params as Record<string, unknown>);
      return {};
    },
  });
  const registry = {
    create: (_parentChatId: string, _cwd: string, _ownerUserId: string | null, cbs: typeof callbacks) => {
      callbacks = cbs;
      return { slotId: 'codex-poc-slot', ...cbs };
    },
    dispose: async () => {},
    get: () => undefined,
  } as unknown as McpSlotRegistry;
  const session = new CodexSession({
    nodeId: 'node-poc',
    threadId: 'thread-poc',
    cwd: '/tmp/test',
    workspaceId: null,
    client,
    mcpRegistry: registry,
    bridge: makeStubBridge(),
    mcpPort: 3001,
    followUpsHookPocEnabled: true,
    followUpsExperimentMode: 'hook-tool',
  });
  session.createMcpSlot();
  session.wireNotifications();

  const emitted: Array<Record<string, unknown>> = [];
  const turnPromise = (async () => {
    for await (const ev of session.send('hello')) emitted.push(ev as unknown as Record<string, unknown>);
  })();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(capturedTurnStartParams.length, 1);
  assert.match(
    String(((capturedTurnStartParams[0].input as Array<{ text: string }> | undefined)?.[0]?.text) ?? ''),
    /set_follow_ups/,
  );
  assert.match(
    String(((capturedTurnStartParams[0].input as Array<{ text: string }> | undefined)?.[0]?.text) ?? ''),
    /set_branch_overview/,
  );
  (client as any)._emit('thread-poc', 'item/agentMessage/delta', {
    threadId: 'thread-poc',
    delta: 'ORIGINAL',
  });

  const firstDecision = callbacks.onValidateFollowUps();
  assert.equal(firstDecision.decision, 'block');
  assert.match(String(firstDecision.reason), /set_branch_overview/);
  assert.match(String(firstDecision.reason), /set_follow_ups/);

  (client as any)._emit('thread-poc', 'item/reasoning/textDelta', {
    threadId: 'thread-poc',
    delta: 'repair thought',
  });
  (client as any)._emit('thread-poc', 'item/agentMessage/delta', {
    threadId: 'thread-poc',
    delta: 'REPAIR TEXT',
  });
  callbacks.onSetBranchOverview(' Current durable branch state. ');
  callbacks.onSetFollowUps([' first? ', 'second?', 'third?', 'fourth?']);
  assert.deepEqual(callbacks.onValidateFollowUps(), {});

  (client as any)._emit('thread-poc', 'turn/completed', {
    threadId: 'thread-poc',
    turn: { status: 'completed' },
  });
  await turnPromise;

  const chunks = emitted.filter((ev) => ev.kind === 'chunk').map((ev) => ev.text);
  assert.deepEqual(chunks, ['ORIGINAL']);
  assert.equal(emitted.some((ev) => ev.kind === 'thought'), false);
  const followUps = emitted.find((ev) => ev.kind === 'follow_ups');
  assert.deepEqual(followUps?.followUps, ['first?', 'second?', 'third?']);
  assert.deepEqual(
    emitted.filter((ev) => ev.kind === 'follow_ups_status').map((ev) => ev.status),
    ['in_progress', 'completed'],
  );
  assert.ok(
    emitted.findIndex((ev) => ev.kind === 'follow_ups_status' && ev.status === 'in_progress')
      < emitted.findIndex((ev) => ev.kind === 'follow_ups'),
  );
  assert.ok(
    emitted.findIndex((ev) => ev.kind === 'follow_ups')
      < emitted.findIndex((ev) => ev.kind === 'follow_ups_status' && ev.status === 'completed'),
  );
  const overview = emitted.find((ev) => ev.kind === 'branch_overview');
  assert.equal(overview?.overview, 'Current durable branch state.');
  assert.equal(session.getHistory()[1].content, 'ORIGINAL');
});

test('Codex sentinel experiment reminds every turn and Hook requires only Overview', async () => {
  let callbacks: Record<string, (...args: any[]) => any> = {};
  const capturedTurnStartParams: Record<string, unknown>[] = [];
  const client = makeStubClient({
    request: async (method: string, params: unknown) => {
      if (method === 'turn/start') capturedTurnStartParams.push(params as Record<string, unknown>);
      return {};
    },
  });
  const registry = {
    create: (_parentChatId: string, _cwd: string, _ownerUserId: string | null, cbs: typeof callbacks) => {
      callbacks = cbs;
      return { slotId: 'codex-sentinel-slot', ...cbs };
    },
    dispose: async () => {},
    get: () => undefined,
  } as unknown as McpSlotRegistry;
  const session = new CodexSession({
    nodeId: 'node-sentinel',
    threadId: 'thread-sentinel',
    cwd: '/tmp/test',
    workspaceId: null,
    client,
    mcpRegistry: registry,
    bridge: makeStubBridge(),
    mcpPort: 3001,
    followUpsHookPocEnabled: true,
    followUpsExperimentMode: 'sentinel',
  });
  session.createMcpSlot();
  session.wireNotifications();

  const emitted: Array<Record<string, unknown>> = [];
  const turnPromise = (async () => {
    for await (const event of session.send('hello')) emitted.push(event as unknown as Record<string, unknown>);
  })();
  await new Promise((resolve) => setImmediate(resolve));

  const prompt = String(
    ((capturedTurnStartParams[0].input as Array<{ text: string }> | undefined)?.[0]?.text) ?? '',
  );
  assert.match(prompt, /do not call set_follow_ups/i);
  assert.match(prompt, /FOLLOW-UP 1\/3/);
  assert.match(prompt, /FOLLOW-UP 3\/3/);
  assert.equal(callbacks.onSetFollowUps, undefined);
  (client as any)._emit('thread-sentinel', 'item/agentMessage/delta', {
    threadId: 'thread-sentinel',
    delta: 'answer\n[FOLLOW-UP 1/3: one?]\n[FOLLOW-UP 2/3: two?]\n[FOLLOW-UP 3/3: three?]',
  });
  callbacks.onSetBranchOverview('Sentinel experiment overview.');
  assert.deepEqual(callbacks.onValidateFollowUps(), {});
  (client as any)._emit('thread-sentinel', 'item/agentMessage/delta', {
    threadId: 'thread-sentinel',
    delta: 'SHOULD STAY HIDDEN',
  });

  (client as any)._emit('thread-sentinel', 'turn/completed', {
    threadId: 'thread-sentinel',
    turn: { status: 'completed' },
  });
  await turnPromise;
  assert.deepEqual(
    emitted.filter((event) => event.kind === 'chunk').map((event) => event.text),
    ['answer\n[FOLLOW-UP 1/3: one?]\n[FOLLOW-UP 2/3: two?]\n[FOLLOW-UP 3/3: three?]'],
  );
});

test('Codex follow-ups Hook POC fails open after one missing repair attempt', async () => {
  let callbacks: Record<string, (...args: any[]) => any> = {};
  const client = makeStubClient();
  const registry = {
    create: (_parentChatId: string, _cwd: string, _ownerUserId: string | null, cbs: typeof callbacks) => {
      callbacks = cbs;
      return { slotId: 'codex-poc-fail-open-slot', ...cbs };
    },
    dispose: async () => {},
    get: () => undefined,
  } as unknown as McpSlotRegistry;
  const session = new CodexSession({
    nodeId: 'node-poc-fail-open',
    threadId: 'thread-poc-fail-open',
    cwd: '/tmp/test',
    workspaceId: null,
    client,
    mcpRegistry: registry,
    bridge: makeStubBridge(),
    mcpPort: 3001,
    followUpsHookPocEnabled: true,
  });
  session.createMcpSlot();
  session.wireNotifications();

  const turnPromise = (async () => {
    for await (const _ev of session.send('hello')) { /* drain */ }
  })();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(callbacks.onValidateFollowUps().decision, 'block');
  assert.deepEqual(callbacks.onValidateFollowUps(), {});
  (client as any)._emit('thread-poc-fail-open', 'turn/completed', {
    threadId: 'thread-poc-fail-open',
    turn: { status: 'completed' },
  });
  await turnPromise;
});
