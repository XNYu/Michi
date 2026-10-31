import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_STREAM_EVENTS, encodeChatStreamEvent } from 'michi-shared';
import { ensureSession, streamMessage } from './api';

describe('ensureSession', () => {
  it('preserves an explicit cleared reasoning value on the wire', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      chatId: 'n1', currentModeId: null, resumeStrategy: 'fresh',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await ensureSession({ nodeId: 'n1', reasoning: null });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({ reasoning: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['RUNTIME_SESSIONS_BUSY', 'codex', 'claude', 'Codex'],
    ['RUNTIME_SESSIONS_BUSY', 'claude', 'codex', 'Claude'],
    ['RUNTIME_SESSIONS_BUSY', 'kiro', undefined, 'Kiro'],
    ['CLAUDE_SESSIONS_BUSY', undefined, 'codex', 'Codex'],
    ['CLAUDE_SESSIONS_BUSY', undefined, undefined, 'Agent'],
  ] as const)('labels capacity errors using the runtime: %s %s %s', async (code, runtimeId, requestedRuntime, label) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code, runtimeId, error: 'concurrency limit reached' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    await expect(ensureSession({ nodeId: 'n1', runtimeId: requestedRuntime })).rejects.toThrow(
      `${label} session capacity is full. Wait for an idle session to be released, then retry.`,
    );
  });

  describe('while the previous turn still holds the session', () => {
    const busy = () => new Response(JSON.stringify({ code: 'turn_active', error: 'Cannot replace an active turn' }), {
      status: 409, headers: { 'Content-Type': 'application/json' },
    });
    const ensured = () => new Response(JSON.stringify({ chatId: 'n1', currentModeId: null, resumeStrategy: 'live' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    afterEach(() => { vi.useRealTimers(); });

    it('silently retries the same request until the session is free', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(busy()).mockResolvedValueOnce(ensured());
      vi.stubGlobal('fetch', fetchMock);
      const result = ensureSession({ nodeId: 'n1', workspaceId: 'ws-1', modelId: 'model-a' });
      await vi.advanceTimersByTimeAsync(149);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(300);
      await expect(result).resolves.toMatchObject({ chatId: 'n1', resumeStrategy: 'live' });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const [first, ...retries] = fetchMock.mock.calls;
      for (const retry of retries) {
        expect(retry[0]).toBe(first[0]);
        expect(retry[1].body).toBe(first[1].body);
      }
    });

    it('gives up after about ten seconds with the server error', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockImplementation(async () => busy());
      vi.stubGlobal('fetch', fetchMock);
      const result = ensureSession({ nodeId: 'n1' });
      const settled = expect(result).rejects.toMatchObject({ message: 'Cannot replace an active turn', code: 'turn_active' });
      await vi.advanceTimersByTimeAsync(10_000);
      await settled;
      // 150, 300, 600, 1200, 2400 and 4800 ms waits; a further 9600 ms wait would pass the bound.
      expect(fetchMock).toHaveBeenCalledTimes(7);
    });

    it('stops retrying when the caller aborts', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockImplementation(async () => busy());
      vi.stubGlobal('fetch', fetchMock);
      const controller = new AbortController();
      const result = ensureSession({ nodeId: 'n1', signal: controller.signal });
      const settled = expect(result).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      await settled;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not retry other conflicts', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'BRANCH_ANCHOR_UNAVAILABLE', error: 'anchor gone' }), { status: 409 }));
      vi.stubGlobal('fetch', fetchMock);
      await expect(ensureSession({ nodeId: 'n1' })).rejects.toMatchObject({ message: 'anchor gone', code: 'BRANCH_ANCHOR_UNAVAILABLE' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('carries the durable graph prerequisite in the same request as session creation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      chatId: 'chat-1', currentModeId: null, resumeStrategy: 'fresh',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const graphPrerequisite = {
      workspace: { id: 'ws-1', name: 'Workspace', createdAt: 1 },
      node: { id: 'n1', treeId: null, parentNodeId: null, kind: 'chat', createdAt: 1 },
      edges: [],
    };
    await ensureSession({ nodeId: 'n1', workspaceId: 'ws-1', graphPrerequisite });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body)).graphPrerequisite).toEqual(graphPrerequisite);
  });
});

// ── streamMessage terminal-state safety net ──
// A streamed assistant node leaves `status: 'streaming'` ONLY when a terminal
// `done`/`error` event is dispatched. If the SSE connection ends (or silently
// stalls) without one, the node must still be finalized — otherwise it stays
// pinned in "streaming" forever (frozen, no spinner, can't stop). These tests
// lock that safety net.

describe('streamMessage terminal-state safety net', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('writes captured file provenance into the durable POST envelope', async () => {
    const userMetadata = {quotedText:'selected passage',quoteSource:{type:'artifact' as const,filePath:'/doc.txt',snapshot:{
      hashKind:'sha256-text-utf8' as const,contentHash:'a'.repeat(64),backendConnectionId:'local',projectId:'p1',treeId:'t1',resolvedFilePath:'/doc.txt',
    }}};
    const fetchMock = vi.fn().mockResolvedValue(new Response(encodeChatStreamEvent({event:'done',data:{stopReason:'end_turn'}}),{
      status:200,headers:{'Content-Type':'text/event-stream'},
    }));
    vi.stubGlobal('fetch',fetchMock);
    const onDone = vi.fn();
    const stop = streamMessage('provenance-node','review this',{onDone},{turnId:'provenance-turn',userMetadata});
    try {
      await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).userMetadata).toEqual(userMetadata);
    } finally {stop();}
  });

  it('finalizes via onError when the stream goes silent past the watchdog timeout', async () => {
    vi.useFakeTimers();
    // First fetch: the message POST stream that stays open with no further
    // bytes. The watchdog abort must reject the in-flight read (like real
    // fetch does), after which the foreground resume replay subscribe gets a
    // 410 (non-retryable) so onError must fire.
    const enc = new TextEncoder();
    let streamCtrl!: ReadableStreamDefaultController<Uint8Array>;
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        streamCtrl = controller;
        controller.enqueue(enc.encode(
          encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.chunk, data: { text: 'partial' } }),
        ));
        // stays open, no further bytes ever arrive
      },
    });
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        init?.signal?.addEventListener('abort', () => {
          streamCtrl.error(new DOMException('aborted', 'AbortError'));
        });
        return Promise.resolve(new Response(stalled, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }));
      })
      .mockResolvedValue(new Response(null, { status: 410 })));

    const onDone = vi.fn<(s?: string) => void>();
    const onError = vi.fn<(m: string) => void>();
    streamMessage('c1', 'hi', { onDone, onError });

    // 30s silence watchdog (3× the 10s backend heartbeat) must finalize the node.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });
});


it('keeps the full typed error and finishes replay after the foreground response disconnects', async () => {
  const enc = new TextEncoder();
  const response = (event: Parameters<typeof encodeChatStreamEvent>[0]) => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(enc.encode(encodeChatStreamEvent(event))); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const fetchMock = vi.fn().mockResolvedValueOnce(response({ event: 'chunk', data: { text: 'partial', turnId: 'typed-replay', seq: 1 } }))
    .mockResolvedValueOnce(response({ event: 'error', data: { message: 'Persistence failed', code: 'turn_persistence_failed', recoverable: true, completedAt: 100, turnId: 'typed-replay', seq: 2 } }));
  vi.stubGlobal('fetch', fetchMock);
  const onErrorPayload = vi.fn();
  const onError = vi.fn();
  const stop = streamMessage('typed-node', 'hi', { onErrorPayload, onError });
  try {
    await vi.waitFor(() => expect(onErrorPayload).toHaveBeenCalledTimes(1));
    expect(onErrorPayload).toHaveBeenCalledWith(expect.objectContaining({ recoverable: true, completedAt: 100, code: 'turn_persistence_failed' }));
    expect(onError).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally { stop(); vi.unstubAllGlobals(); }
});

it('keeps a lost POST response outcome unknown with its original turn identity and never resends', async () => {
  const fetchMock = vi.fn().mockRejectedValue(new TypeError('response lost after side effect'));
  vi.stubGlobal('fetch', fetchMock);
  const onErrorPayload = vi.fn();
  streamMessage('lost-response-chat', 'perform side effect', { onErrorPayload }, { turnId: 'lost-original' });
  try {
    await vi.waitFor(() => expect(onErrorPayload).toHaveBeenCalledOnce());
    expect(onErrorPayload).toHaveBeenCalledWith(expect.objectContaining({ code: 'turn_outcome_unknown', turnId: 'lost-original' }));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).turnId).toBe('lost-original');
  } finally { vi.unstubAllGlobals(); }
});

it('keeps an externally aborted POST outcome unknown while an explicit user cancel stays aborted', async () => {
  const externalError = vi.fn();
  const externalAborted = vi.fn();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('connection generation changed', 'AbortError')));
  try {
    streamMessage('external-abort-chat', 'side effect', { onErrorPayload: externalError, onAborted: externalAborted }, { turnId: 'external-original' });
    await vi.waitFor(() => expect(externalError).toHaveBeenCalledOnce());
    expect(externalError).toHaveBeenCalledWith(expect.objectContaining({ code: 'turn_outcome_unknown', turnId: 'external-original' }));
    expect(externalAborted).not.toHaveBeenCalled();

    const userError = vi.fn();
    const userAborted = vi.fn();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('user cancelled', 'AbortError')), { once: true });
    })));
    const cancel = streamMessage('user-abort-chat', 'side effect', { onErrorPayload: userError, onAborted: userAborted }, { turnId: 'user-original' });
    cancel();
    await vi.waitFor(() => expect(userAborted).toHaveBeenCalledOnce());
    expect(userError).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

describe('foreground resume after the live replay is gone', () => {
  const enc = new TextEncoder();
  const partial = () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(enc.encode(encodeChatStreamEvent({ event: 'turn_start', data: { turnId: 'gone-turn', assistantId: 'saved-answer', nodeId: 'gone-node', userText: 'hi', seq: 0 } })));
    controller.enqueue(enc.encode(encodeChatStreamEvent({ event: 'chunk', data: { text: 'partial', turnId: 'gone-turn', assistantId: 'saved-answer', seq: 1 } })));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const gone = (code: string) => new Response(JSON.stringify({ error: 'The live reply is no longer available.', code }), { status: 410, headers: { 'Content-Type': 'application/json' } });
  const saved = (status: string, completedAt: number | null = 20) => new Response(JSON.stringify({
    turnId: 'gone-turn', assistantId: 'saved-answer', status, stopReason: 'end_turn', completedAt, lastSeq: 4,
    message: { id: 'saved-answer', node_id: 'gone-node', role: 'assistant', content: 'Saved reply', seq: 1, created_at: 3 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  afterEach(() => vi.unstubAllGlobals());

  it('hands a 410 turn_replay_unavailable to the saved-turn read and shows no error when the handler finishes it', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(partial()).mockResolvedValueOnce(gone('turn_replay_unavailable')).mockResolvedValueOnce(saved('completed'));
    vi.stubGlobal('fetch', fetchMock);
    const onSavedTurn = vi.fn(() => true);
    const onErrorPayload = vi.fn();
    const stop = streamMessage('gone-node', 'hi', { onSavedTurn, onErrorPayload }, { turnId: 'gone-turn' });
    try {
      await vi.waitFor(() => expect(onSavedTurn).toHaveBeenCalledOnce());
      expect(onSavedTurn).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'gone-turn', status: 'completed', completedAt: 20, lastSeq: 4 }));
      expect(String(fetchMock.mock.calls[1][0])).toContain('/chats/gone-node/stream?fromSeq=2&fromTurnId=gone-turn');
      expect(String(fetchMock.mock.calls[2][0])).toContain('/chats/gone-node/turns/gone-turn');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(onErrorPayload).not.toHaveBeenCalled();
    } finally { stop(); }
  });

  it.each([
    ['turn_replay_unavailable', () => saved('active', null), true],
    ['backend_restarted', () => saved('error'), true],
    ['turn_replay_unavailable', () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }), false],
  ])('keeps the %s error when the saved turn is not finished', async (code, savedResponse, readable) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(partial()).mockResolvedValueOnce(gone(code)).mockResolvedValueOnce(savedResponse()));
    const onSavedTurn = vi.fn(() => false);
    const onErrorPayload = vi.fn();
    const stop = streamMessage('gone-node', 'hi', { onSavedTurn, onErrorPayload }, { turnId: 'gone-turn' });
    try {
      await vi.waitFor(() => expect(onErrorPayload).toHaveBeenCalledOnce());
      expect(onErrorPayload).toHaveBeenCalledWith(expect.objectContaining({ code, turnId: 'gone-turn' }));
      expect(onSavedTurn).toHaveBeenCalledTimes(readable ? 1 : 0);
    } finally { stop(); }
  });

  it('gives up on a saved-turn read that does not answer and keeps the error', async () => {
    vi.useFakeTimers();
    const hung = (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(partial()).mockResolvedValueOnce(gone('turn_replay_unavailable')).mockImplementationOnce(hung));
    const onSavedTurn = vi.fn(() => true);
    const onErrorPayload = vi.fn();
    const stop = streamMessage('gone-node', 'hi', { onSavedTurn, onErrorPayload }, { turnId: 'gone-turn' });
    try {
      await vi.advanceTimersByTimeAsync(9_000);
      expect(onErrorPayload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(onErrorPayload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'turn_replay_unavailable' }));
      expect(onSavedTurn).not.toHaveBeenCalled();
    } finally { stop(); vi.useRealTimers(); }
  });

  it('does not read the saved turn for other replay failures', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(partial()).mockResolvedValueOnce(gone('turn_outcome_unknown'));
    vi.stubGlobal('fetch', fetchMock);
    const onSavedTurn = vi.fn(() => true);
    const onErrorPayload = vi.fn();
    const stop = streamMessage('gone-node', 'hi', { onSavedTurn, onErrorPayload }, { turnId: 'gone-turn' });
    try {
      await vi.waitFor(() => expect(onErrorPayload).toHaveBeenCalledOnce());
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(onSavedTurn).not.toHaveBeenCalled();
    } finally { stop(); }
  });
});
