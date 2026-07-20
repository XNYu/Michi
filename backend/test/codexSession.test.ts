import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('send includes existing image attachments as native localImage inputs', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-codex-image-'));
  const imagePath = path.join(tmpDir, 'screen.png');
  const textPath = path.join(tmpDir, 'notes.txt');
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(textPath, 'notes');

  let turnStartParams: Record<string, unknown> | undefined;
  const client = makeStubClient({
    request: async (method: string, params: unknown) => {
      if (method === 'turn/start') turnStartParams = params as Record<string, unknown>;
      return {};
    },
  });
  const session = new CodexSession({
    nodeId: 'node-image',
    threadId: 'thread-image',
    cwd: tmpDir,
    workspaceId: null,
    client,
    mcpRegistry: makeStubMcpRegistry(),
    bridge: makeStubBridge(),
    mcpPort: 3001,
  });
  session.createMcpSlot();
  session.wireNotifications();

  try {
    const turnPromise = (async () => {
      for await (const _ev of session.send('What is in this image?', {
        attachments: [
          { name: 'screen.png', absPath: imagePath },
          { name: 'screen-again.png', absPath: imagePath },
          { name: 'notes.txt', absPath: textPath },
          { name: 'missing.jpg', absPath: path.join(tmpDir, 'missing.jpg') },
        ],
      })) {
        // Drain through turn_end.
      }
    })();

    await new Promise((resolve) => setImmediate(resolve));
    (client as any)._emit('thread-image', 'turn/completed', {
      threadId: 'thread-image',
      turn: { status: 'completed' },
    });
    await turnPromise;

    assert.deepEqual(turnStartParams?.input, [
      { type: 'text', text: 'What is in this image?' },
      { type: 'localImage', path: imagePath },
    ]);
  } finally {
    await session.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('first Codex request streams reasoning immediately and delivers title whenever it finishes', async () => {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let client!: ReturnType<typeof makeStubClient> & { _emit: (...args: any[]) => void };
  client = makeStubClient({
    request: async (method: string, rawParams: unknown) => {
      const params = rawParams as Record<string, unknown>;
      requests.push({ method, params });
      if (method === 'thread/start') return { threadId: 'thread-title-ephemeral' };
      if (method === 'turn/start' && params.threadId === 'thread-title-ephemeral') {
        setImmediate(() => {
          client._emit('thread-title-ephemeral', 'item/agentMessage/delta', {
            threadId: 'thread-title-ephemeral',
            delta: '{"title":"刷新令牌机制"}',
          });
          client._emit('thread-title-ephemeral', 'turn/completed', {
            threadId: 'thread-title-ephemeral',
            turn: { status: 'completed' },
          });
        });
        return {};
      }
      if (method === 'turn/start' && params.threadId === 'thread-main') {
        setImmediate(() => {
          client._emit('thread-main', 'item/reasoning/summaryTextDelta', {
            threadId: 'thread-main',
            itemId: 'reasoning-1',
            summaryIndex: 0,
            delta: 'Thinking',
          });
          client._emit('thread-main', 'item/agentMessage/delta', {
            threadId: 'thread-main',
            delta: 'Body',
          });
          client._emit('thread-main', 'turn/completed', {
            threadId: 'thread-main',
            turn: { status: 'completed' },
          });
        });
      }
      return {};
    },
  }) as ReturnType<typeof makeStubClient> & { _emit: (...args: any[]) => void };

  const session = new CodexSession({
    nodeId: 'node-title-first',
    threadId: 'thread-main',
    cwd: '/tmp/test',
    workspaceId: null,
    client,
    mcpRegistry: makeStubMcpRegistry(),
    bridge: makeStubBridge(),
    mcpPort: 3001,
    model: 'gpt-test',
    generateTitleOnFirstTurn: true,
  });
  session.createMcpSlot();
  session.wireNotifications();

  const events: Array<Record<string, unknown>> = [];
  for await (const event of session.send('请解释刷新令牌机制')) {
    events.push(event as unknown as Record<string, unknown>);
  }

  assert.equal(
    requests.some(({ method, params }) => method === 'turn/start' && params.threadId === 'thread-main'),
    true,
    'the real turn should already be running while title generation completes',
  );

  const titleThreadStart = requests.find(({ method }) => method === 'thread/start');
  assert.equal(titleThreadStart?.params.ephemeral, true);
  assert.equal(titleThreadStart?.params.model, 'gpt-test');
  const titleTurnStart = requests.find(
    ({ method, params }) => method === 'turn/start' && params.threadId === 'thread-title-ephemeral',
  );
  assert.equal(titleTurnStart?.params.effort, 'low');
  assert.equal(titleTurnStart?.params.summary, 'none');
  assert.deepEqual(titleTurnStart?.params.outputSchema, {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
    additionalProperties: false,
  });
  assert.ok(requests.some(
    ({ method, params }) => method === 'thread/setName'
      && params.threadId === 'thread-main'
      && params.name === '刷新令牌机制',
  ));
  const kinds = events.map((event) => event.kind);
  assert.equal(kinds[0], 'thought');
  assert.ok(kinds.indexOf('chunk') < kinds.indexOf('title'), 'body must display without waiting for title');
  assert.ok(kinds.indexOf('title') < kinds.indexOf('turn_end'), 'title must arrive before SSE closes');
  assert.equal(events.find((event) => event.kind === 'title')?.title, '刷新令牌机制');
  assert.deepEqual(session.getHistory(), [
    { role: 'user', content: '请解释刷新令牌机制' },
    { role: 'assistant', content: 'Body' },
  ]);
});

test('Codex title generation failure yields a local fallback before the real turn', async () => {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let client!: ReturnType<typeof makeStubClient> & { _emit: (...args: any[]) => void };
  client = makeStubClient({
    request: async (method: string, rawParams: unknown) => {
      const params = rawParams as Record<string, unknown>;
      requests.push({ method, params });
      if (method === 'thread/start') throw new Error('title model unavailable');
      if (method === 'turn/start' && params.threadId === 'thread-fallback-main') {
        setImmediate(() => {
          client._emit('thread-fallback-main', 'turn/completed', {
            threadId: 'thread-fallback-main',
            turn: { status: 'completed' },
          });
        });
      }
      return {};
    },
  }) as ReturnType<typeof makeStubClient> & { _emit: (...args: any[]) => void };

  const session = new CodexSession({
    nodeId: 'node-title-fallback',
    threadId: 'thread-fallback-main',
    cwd: '/tmp/test',
    workspaceId: null,
    client,
    mcpRegistry: makeStubMcpRegistry(),
    bridge: makeStubBridge(),
    mcpPort: 3001,
    generateTitleOnFirstTurn: true,
  });
  session.createMcpSlot();
  session.wireNotifications();

  const events: Array<Record<string, unknown>> = [];
  for await (const event of session.send('/branch Diagnose the startup timeout. Include likely causes.')) {
    events.push(event as unknown as Record<string, unknown>);
  }
  assert.equal(events.find((event) => event.kind === 'title')?.title, 'Diagnose the startup timeout');
  assert.equal(
    requests.some(({ method, params }) => method === 'turn/start' && params.threadId === 'thread-fallback-main'),
    true,
    'fallback title generation must not delay the real turn',
  );
});

test('cancelling parallel Codex title and reasoning turns interrupts both', async () => {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let titleTurnStarted!: () => void;
  const titleTurnStartedPromise = new Promise<void>((resolve) => { titleTurnStarted = resolve; });
  let mainTurnStarted!: () => void;
  const mainTurnStartedPromise = new Promise<void>((resolve) => { mainTurnStarted = resolve; });
  let mainTurnCount = 0;
  let client!: ReturnType<typeof makeStubClient> & { _emit: (...args: any[]) => void };
  client = makeStubClient({
    request: async (method: string, rawParams: unknown) => {
      const params = rawParams as Record<string, unknown>;
      requests.push({ method, params });
      if (method === 'thread/start') return { threadId: 'thread-title-cancel' };
      if (method === 'turn/start' && params.threadId === 'thread-title-cancel') {
        titleTurnStarted();
        return {};
      }
      if (method === 'turn/start' && params.threadId === 'thread-main-cancel') {
        mainTurnCount += 1;
        if (mainTurnCount === 1) {
          mainTurnStarted();
        } else {
          setImmediate(() => {
            client._emit('thread-main-cancel', 'item/agentMessage/delta', {
              threadId: 'thread-main-cancel',
              delta: 'clean',
            });
            client._emit('thread-main-cancel', 'turn/completed', {
              threadId: 'thread-main-cancel',
              turn: { status: 'completed' },
            });
          });
        }
        return {};
      }
      if (method === 'turn/interrupt') {
        setImmediate(() => {
          client._emit(String(params.threadId), 'turn/completed', {
            threadId: params.threadId,
            turn: { status: 'interrupted' },
          });
        });
      }
      return {};
    },
  }) as ReturnType<typeof makeStubClient> & { _emit: (...args: any[]) => void };

  const session = new CodexSession({
    nodeId: 'node-title-cancel',
    threadId: 'thread-main-cancel',
    cwd: '/tmp/test',
    workspaceId: null,
    client,
    mcpRegistry: makeStubMcpRegistry(),
    bridge: makeStubBridge(),
    mcpPort: 3001,
    generateTitleOnFirstTurn: true,
  });
  session.createMcpSlot();
  session.wireNotifications();

  const iterator = session.send('cancel this request');
  const eventsPromise = (async () => {
    const events: Array<Record<string, unknown>> = [];
    for await (const event of iterator) events.push(event as unknown as Record<string, unknown>);
    return events;
  })();
  await Promise.all([titleTurnStartedPromise, mainTurnStartedPromise]);
  await session.cancel();
  const events = await eventsPromise;

  assert.equal(events.some((event) => event.kind === 'title'), false);
  assert.equal(events.at(-1)?.kind, 'turn_end');
  assert.equal(events.at(-1)?.stopReason, 'interrupted');
  assert.deepEqual(
    requests
      .filter(({ method }) => method === 'turn/interrupt')
      .map(({ params }) => params.threadId)
      .sort(),
    ['thread-main-cancel', 'thread-title-cancel'],
  );
  const resumedChunks: string[] = [];
  for await (const event of session.send('resume cleanly')) {
    if (event.kind === 'chunk') resumedChunks.push(event.text);
  }
  assert.deepEqual(resumedChunks, ['clean'], 'cancelled events must not leak into the next turn');
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
  assert.ok(events.includes('runtime_error'), 'markCrashed should push runtime_error');
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
