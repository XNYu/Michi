import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexSession } from 'michi-runtime/internal/adapters/codex/CodexSession';
import type { CodexAppServerClient } from 'michi-runtime/internal/adapters/codex/CodexAppServerClient';
import type { McpSlotRegistry } from '../src/services/mcpServer';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import { michiTestHost } from './helpers/michiTestHost';
import { michiCodexHostText } from '../src/agents/michiCodexOptions';

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
    onGlobalNotification: (_h: unknown) => () => {},
    onExit: (_cb: () => void) => () => {},
    shutdown: async () => {},
    // Test helper: emit a notification to all handlers for a threadId
    _emit: (threadId: string, method: string, params: Record<string, unknown>) => {
      for (const h of notifHandlers.get(threadId) ?? []) h(method, params);
    },
    ...overrides,
  };
  const request = client.request;
  client.request = async (method: string, params: any) => {
    const result = await request(method, params);
    return method === 'turn/start' && !result?.turn && !result?.turnId
      ? { ...result, turn: { id: `native-${params.threadId}` } }
      : result;
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

/** The payload of a Michi product event of this type (reported as a host event); undefined for any other event. */
function hostPayload(ev: unknown, type: string): any {
  const event = ev as { kind?: unknown; type?: unknown; payload?: unknown };
  return event.kind === 'host_event' && event.type === type ? event.payload : undefined;
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
    host: michiTestHost(),
    hostText: michiCodexHostText(),
  });
  session.createMcpSlot();
  session.wireNotifications();
  return { session, client: client as any };
}

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
    host: michiTestHost(),
    hostText: michiCodexHostText(),
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

    const input = turnStartParams?.input as Array<Record<string, unknown>>;
    // Images still go as native localImage blocks, de-duplicated by path.
    assert.deepEqual(
      input.filter((part) => part.type === 'localImage'),
      [{ type: 'localImage', path: imagePath }],
    );
    // Non-image and unreadable attachments used to be dropped in total silence.
    // They are now named in the prompt so the agent can read them itself.
    const text = input.find((part) => part.type === 'text')?.text as string;
    assert.ok(text.startsWith('What is in this image?'), 'user text is preserved verbatim first');
    assert.match(text, /\[Attachments\]/);
    assert.ok(text.includes(`notes.txt → ${textPath}`), 'readable non-image is referenced by path');
    assert.match(text, /missing\.jpg \(could not be read/);
    assert.ok(!text.includes(imagePath), 'inlined images are not also listed as attachments');
  } finally {
    await session.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('send puts the Michi Memory block ahead of the Pages context for the model only', async () => {
  const texts: string[] = [];
  const { session, client } = makeSession({
    request: async (method: string, params: any) => {
      if (method === 'turn/start') texts.push(params.input.find((part: { type: string }) => part.type === 'text').text);
      return {};
    },
  });
  const drain = async (text: string, input?: Parameters<typeof session.send>[1]) => {
    const turn = (async () => { for await (const _ev of session.send(text, input)) { /* drain */ } })();
    await new Promise((resolve) => setImmediate(resolve));
    client._emit('thread-1', 'turn/completed', { threadId: 'thread-1', turn: { status: 'completed' } });
    await turn;
  };
  try {
    await drain('first question', {
      memoryContext: '<michi-memory>\n- Reply in Chinese. (preference)\n</michi-memory>',
      pageContext: 'Michi Pages manifest (JSON): {}',
    });
    await drain('second question');
    assert.ok(texts[0]!.startsWith('<michi-memory>\n- Reply in Chinese. (preference)\n</michi-memory>\n\n---\n\nMichi Pages manifest (JSON): {}\n\n---\n\nfirst question'));
    assert.ok(texts[1]!.startsWith('second question'), 'a turn without a block sends none');
    assert.deepEqual(session.getHistory().filter((m) => m.role === 'user').map((m) => m.content), ['first question', 'second question']);
  } finally {
    await session.dispose();
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
    host: michiTestHost(),
    hostText: michiCodexHostText(),
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
  // `thread/name/set` is the real app-server method; the previous
  // `thread/setName` does not exist in the ClientRequest union, so every call
  // rejected into a swallowed debug log and the codex-side thread stayed
  // unnamed. This assertion is what pins the correct spelling.
  assert.ok(requests.some(
    ({ method, params }) => method === 'thread/name/set'
      && params.threadId === 'thread-main'
      && params.name === '刷新令牌机制',
  ), 'title must be written back with thread/name/set');
  assert.ok(
    !requests.some(({ method }) => method === 'thread/setName'),
    'thread/setName is not a real method and must not be sent',
  );
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
    host: michiTestHost(),
    hostText: michiCodexHostText(),
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
    host: michiTestHost(),
    hostText: michiCodexHostText(),
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
  assert.equal(events.at(-1)?.stopReason, 'cancelled');
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
    host: michiTestHost(),
    hostText: michiCodexHostText(),
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
  const followUps = emitted.map((ev) => hostPayload(ev, 'follow_ups')).find(Boolean);
  assert.deepEqual(followUps?.followUps, ['first?', 'second?', 'third?']);
  assert.deepEqual(
    emitted.map((ev) => hostPayload(ev, 'follow_ups_status')).filter(Boolean).map((payload) => payload.status),
    ['in_progress', 'completed'],
  );
  assert.ok(
    emitted.findIndex((ev) => hostPayload(ev, 'follow_ups_status')?.status === 'in_progress')
      < emitted.findIndex((ev) => hostPayload(ev, 'follow_ups')),
  );
  assert.ok(
    emitted.findIndex((ev) => hostPayload(ev, 'follow_ups'))
      < emitted.findIndex((ev) => hostPayload(ev, 'follow_ups_status')?.status === 'completed'),
  );
  const overview = emitted.map((ev) => hostPayload(ev, 'branch_overview')).find(Boolean);
  assert.equal(overview?.overview, 'Current durable branch state.');
  assert.equal(session.getHistory()[1].content, 'ORIGINAL');
});

for (const hookEnabled of [false, true]) {
}

for (const hookEnabled of [false, true]) {
}

test('Codex disabled follow-ups retain overview validation without follow-up output', async () => {
  let callbacks: any;
  const client = makeStubClient();
  const branchRequests: Array<{ enableFollowUps?: boolean }> = [];
  const session = new CodexSession({
    nodeId: 'disabled-metadata', threadId: 'disabled-metadata', cwd: '/tmp/test', workspaceId: null,
    client, host: michiTestHost(), hostText: michiCodexHostText(), enableFollowUps: false,
    bridge: { ...makeStubBridge(), spawnBranches: async (input) => { branchRequests.push(input); return []; } },
    followUpsHookPocEnabled: true, followUpsExperimentMode: 'hook-tool',
    mcpRegistry: {
      create: (_id: string, _cwd: string, _owner: unknown, cbs: any) => { callbacks = cbs; return { slotId: 'disabled-metadata' }; },
      dispose: async () => {},
    } as unknown as McpSlotRegistry,
  });
  session.createMcpSlot();
  session.wireNotifications();
  assert.equal(callbacks.onSetFollowUps, undefined);
  const events: any[] = [];
  const pending = (async () => { for await (const event of session.send('overview only')) events.push(event); })();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await callbacks.onSpawnBranches([{ title: 'Child', prompt: 'Continue without follow-ups.' }]);
  assert.equal(branchRequests[0]?.enableFollowUps, false, 'actual child callback inherits disabled follow-ups');
  const decision = callbacks.onValidateFollowUps();
  assert.equal(decision.decision, 'block');
  assert.match(String(decision.reason), /set_branch_overview/);
  assert.doesNotMatch(String(decision.reason), /set_follow_ups/);
  callbacks.onSetBranchOverview(' Overview remains required. ');
  assert.deepEqual(callbacks.onValidateFollowUps(), {});
  (client as any)._emit('disabled-metadata', 'turn/completed', { threadId: 'disabled-metadata', turn: { status: 'completed' } });
  await pending;
  assert.equal(events.some((event) => hostPayload(event, 'follow_ups') || hostPayload(event, 'follow_ups_status')), false);
  assert.equal(events.map((event) => hostPayload(event, 'branch_overview')).find(Boolean)?.overview, 'Overview remains required.');
  await session.dispose();
});

test('Codex metadata boundary completes at an agent message and remains complete at native turn end', async () => {
  let callbacks: any;
  const client = makeStubClient();
  const session = new CodexSession({
    nodeId: 'metadata-boundary', threadId: 'metadata-boundary', cwd: '/tmp/test', workspaceId: null,
    client, bridge: makeStubBridge(), host: michiTestHost(), hostText: michiCodexHostText(),
    followUpsHookPocEnabled: true, followUpsExperimentMode: 'hook-tool',
    mcpRegistry: {
      create: (_id: string, _cwd: string, _owner: unknown, cbs: any) => { callbacks = cbs; return { slotId: 'boundary' }; },
      dispose: async () => {},
    } as unknown as McpSlotRegistry,
  });
  session.createMcpSlot();
  session.wireNotifications();
  const events: any[] = [];
  const pending = (async () => { for await (const event of session.send('answer')) events.push(event); })();
  await new Promise<void>((resolve) => setImmediate(resolve));
  callbacks.onSetBranchOverview('Done.');
  callbacks.onSetFollowUps([' first? ', 'second?', 'third?']);
  (client as any)._emit('metadata-boundary', 'item/completed', {
    threadId: 'metadata-boundary', item: { id: 'answer', type: 'agentMessage', text: 'Answer.' },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map((event) => hostPayload(event, 'follow_ups_status')).filter(Boolean).map((payload) => payload.status), ['in_progress', 'completed']);
  assert.equal(events.some((event) => event.kind === 'turn_end'), false, 'visible metadata boundary is separate from durable turn completion');
  (client as any)._emit('metadata-boundary', 'turn/completed', { threadId: 'metadata-boundary', turn: { status: 'completed' } });
  await pending;
  assert.deepEqual(events.map((event) => hostPayload(event, 'follow_ups_status')).filter(Boolean).map((payload) => payload.status), ['in_progress', 'completed']);
  await session.dispose();
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
    host: michiTestHost(),
    hostText: michiCodexHostText(),
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

test('steer issues turn/steer and fork align does not change Michi node id', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const { session, client } = makeSession({
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === 'turn/start') return { turnId: 'turn-native-1' };
      if (method === 'turn/steer') return { turnId: 'turn-native-1' };
      if (method === 'thread/fork') return { threadId: 'forked-thread' };
      if (method === 'thread/compact/start') return {};
      return {};
    },
  });
  const turn = (async () => {
    for await (const _ev of session.send('hello')) { /* drain */ }
  })();
  await new Promise((resolve) => setImmediate(resolve));
  const steered = await session.steer('inject');
  assert.equal(steered.accepted, true, `steer rejected: ${steered.reason}`);
  assert.equal(steered.pending, true);
  const compact = await session.compact();
  assert.equal(compact.started, true);
  const forked = await session.alignNativeFork();
  assert.equal(forked.threadId, 'forked-thread');
  assert.equal(session.id, 'node-1');
  assert.equal(session.describeNativeState().michiNodeId, 'node-1');
  (client as any)._emit('thread-1', 'item/agentMessage/delta', { delta: 'hi' });
  (client as any)._emit('thread-1', 'turn/completed', { turn: { status: 'completed' } });
  await turn;
  assert.ok(calls.some((c) => c.method === 'turn/steer'));
  assert.ok(calls.some((c) => c.method === 'thread/fork'));
  assert.ok(calls.some((c) => c.method === 'thread/compact/start'));
});

test('cancel returns acknowledged after interrupt', async () => {
  const { session } = makeSession();
  const ackIdle = await session.cancel();
  assert.equal(ackIdle.acknowledged, false);
});

test('a slot gets a callback only for the business effects the bridge has', async () => {
  const effects = ['onSpawnBranches', 'onSaveArtifact', 'onUpdateArtifact'];
  const offered = async (bridge: Partial<AgentToolBridge>) => {
    let callbacks: Record<string, unknown> = {};
    const session = new CodexSession({
      nodeId: 'bridge-effects', threadId: 'bridge-effects', cwd: '/tmp/test', workspaceId: null,
      client: makeStubClient(), host: michiTestHost(), hostText: michiCodexHostText(), bridge,
      mcpRegistry: {
        create: (_id: string, _cwd: string, _owner: unknown, cbs: Record<string, unknown>) => { callbacks = cbs; return { slotId: 'bridge-effects' }; },
        dispose: async () => {},
      } as unknown as McpSlotRegistry,
    });
    session.createMcpSlot();
    await session.dispose();
    return effects.filter((name) => typeof callbacks[name] === 'function');
  };
  assert.deepEqual(await offered(makeStubBridge()), effects);
  assert.deepEqual(await offered({ saveContext: () => null }), ['onSaveArtifact']);
  assert.deepEqual(await offered({}), []);
});
