import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatHub, type SidecarTitleRequest } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import type { ChatStreamEvent, DurableTurnSnapshot } from 'michi-shared';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function asyncIteratorFrom(events: NormalizedEvent[]): AsyncIterableIterator<NormalizedEvent> {
  let i = 0;
  return {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      if (i >= events.length) return { done: true, value: undefined };
      return { done: false, value: events[i++] };
    },
  };
}

/** A session whose turn stays open until `finish()` is called. */
function holdingSession(runtimeId: AgentSession['runtimeId'] = 'kiro', owner?: AgentSession['owner']) {
  const gate = deferred<void>();
  const session: AgentSession = {
    id: 'session-1',
    runtimeId,
    owner,
    getHistory: () => [],
    getPendingAssistant: () => undefined,
    send: () => (async function* (): AsyncIterableIterator<NormalizedEvent> {
      yield { kind: 'chunk', text: 'thinking…' } as NormalizedEvent;
      await gate.promise;
      yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent;
    })(),
    cancel: () => {},
  };
  return { session, finish: () => gate.resolve() };
}

function makeHub(opts: {
  titleGenerator?: ((request: SidecarTitleRequest) => Promise<string | null>) | null;
  nodeTitle?: (nodeId: string) => string | null;
  checkpoints?: DurableTurnSnapshot[];
}) {
  return new ChatHub({
    retentionMs: 100,
    workspaceIdForNode: () => 'ws-test',
    persistence: {
      begin: () => {},
      checkpoint: (snapshot) => { opts.checkpoints?.push(snapshot); },
      finalize: () => {},
    },
    titleGenerator: opts.titleGenerator,
    nodeTitle: opts.nodeTitle ?? (() => null),
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('ChatHub sidecar title generation', () => {
  it('emits a title event and checkpoints it while the turn is still streaming', async () => {
    const title = deferred<string | null>();
    const requests: SidecarTitleRequest[] = [];
    const checkpoints: DurableTurnSnapshot[] = [];
    const hub = makeHub({
      titleGenerator: (request) => { requests.push(request); return title.promise; },
      checkpoints,
    });
    const { session, finish } = holdingSession();
    const seen: ChatStreamEvent[] = [];

    const { done, turnId } = await hub.startTurn({
      chatId: 'chat-1',
      nodeId: 'node-1',
      text: 'expanded @mention wire text',
      displayText: 'How do I fix flaky tests?',
      session,
      enableKiroSidecarTitle: true,
    });
    hub.subscribeTurn('chat-1', turnId, { send: (event) => seen.push(event), close: () => {} });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].userText, 'How do I fix flaky tests?');
    assert.equal(requests[0].nodeId, 'node-1');

    title.resolve('  Fixing flaky tests  ');
    await flush();

    const titleEvents = seen.filter((event) => event.event === 'title');
    assert.equal(titleEvents.length, 1);
    assert.deepEqual(titleEvents[0].data.title, 'Fixing flaky tests');
    assert.equal(checkpoints.at(-1)?.nodeMetadata.title, 'Fixing flaky tests');
    assert.equal(seen.some((event) => event.event === 'done'), false, 'turn must still be running');

    finish();
    await done;
  });

  it('forwards the quoted reply text as title context', async () => {
    const requests: SidecarTitleRequest[] = [];
    const hub = makeHub({ titleGenerator: async (request) => { requests.push(request); return 'S3 序列化 GZIP 修复'; } });
    const { session, finish } = holdingSession();
    const { done } = await hub.startTurn({
      chatId: 'chat-ctx',
      nodeId: 'node-ctx',
      text: 'wire text',
      displayText: '具体修复的原理是什么？',
      userMetadata: { quotedText: '持久修复序列化：应让 Jackson 直接写入 GZIP' },
      session,
      enableKiroSidecarTitle: true,
    });
    await flush();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].userText, '具体修复的原理是什么？');
    assert.equal(requests[0].contextText, '持久修复序列化：应让 Jackson 直接写入 GZIP');
    finish();
    await done;
  });

  it('skips generation when the node already has a title', async () => {
    let calls = 0;
    const hub = makeHub({
      titleGenerator: async () => { calls += 1; return 'unused'; },
      nodeTitle: () => 'Existing title',
    });
    const { session, finish } = holdingSession();
    const { done } = await hub.startTurn({ chatId: 'chat-2', nodeId: 'node-2', text: 'hello', session, enableKiroSidecarTitle: true });
    finish();
    await done;
    assert.equal(calls, 0);
  });

  it('skips generation for non-chat owners such as agent runs', async () => {
    let calls = 0;
    const hub = makeHub({ titleGenerator: async () => { calls += 1; return 'unused'; } });
    const { session, finish } = holdingSession('kiro', { kind: 'agent_run', attemptId: 'attempt-1' } as AgentSession['owner']);
    const { done } = await hub.startTurn({ chatId: 'chat-3', nodeId: 'node-3', text: 'hello', session, enableKiroSidecarTitle: true });
    finish();
    await done;
    assert.equal(calls, 0);
  });

  it('drops a sidecar title that resolves after the turn ended', async () => {
    const title = deferred<string | null>();
    const hub = makeHub({ titleGenerator: () => title.promise });
    const seen: ChatStreamEvent[] = [];
    const session: AgentSession = {
      id: 'session-1',
      runtimeId: 'claude',
      getHistory: () => [],
      getPendingAssistant: () => undefined,
      send: () => asyncIteratorFrom([{ kind: 'turn_end', stopReason: 'end_turn' }]),
      cancel: () => {},
    };
    const { done, turnId } = await hub.startTurn({ chatId: 'chat-4', nodeId: 'node-4', text: 'quick', session });
    hub.subscribeTurn('chat-4', turnId, { send: (event) => seen.push(event), close: () => {} });
    await done;

    title.resolve('Late title');
    await flush();
    assert.equal(seen.some((event) => event.event === 'title'), false);
  });

  it('lets an agent-produced title win when it arrives first', async () => {
    const title = deferred<string | null>();
    const hub = makeHub({ titleGenerator: () => title.promise });
    const seen: ChatStreamEvent[] = [];
    const gate = deferred<void>();
    const session: AgentSession = {
      id: 'session-1',
      runtimeId: 'kiro',
      getHistory: () => [],
      getPendingAssistant: () => undefined,
      send: () => (async function* (): AsyncIterableIterator<NormalizedEvent> {
        yield { kind: 'title', title: 'Agent title' } as NormalizedEvent;
        await gate.promise;
        yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent;
      })(),
      cancel: () => {},
    };
    const { done, turnId } = await hub.startTurn({ chatId: 'chat-5', nodeId: 'node-5', text: 'race', session, enableKiroSidecarTitle: true });
    hub.subscribeTurn('chat-5', turnId, { send: (event) => seen.push(event), close: () => {} });
    await flush();

    title.resolve('Sidecar title');
    await flush();
    gate.resolve();
    await done;

    const titles = seen.filter((event) => event.event === 'title').map((event) => event.data.title);
    assert.deepEqual(titles, ['Agent title']);
  });

  it('swallows generator failures without affecting the turn', async () => {
    const hub = makeHub({ titleGenerator: async () => { throw new Error('boom'); } });
    const { session, finish } = holdingSession();
    const seen: ChatStreamEvent[] = [];
    const { done, turnId } = await hub.startTurn({ chatId: 'chat-6', nodeId: 'node-6', text: 'hello', session, enableKiroSidecarTitle: true });
    hub.subscribeTurn('chat-6', turnId, { send: (event) => seen.push(event), close: () => {} });
    await flush();
    finish();
    await done;
    assert.equal(seen.some((event) => event.event === 'error'), false);
    assert.equal(seen.at(-1)?.event, 'done');
  });
});
