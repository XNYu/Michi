import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_STREAM_EVENTS, encodeChatStreamEvent } from 'michi-shared';
import { allocateNodeIds, ensureSession, streamMessage } from './api';

describe('ensureSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps Claude session capacity errors to a user-facing message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        code: 'CLAUDE_SESSIONS_BUSY',
        error: 'ClaudeRuntime concurrency limit 10 reached',
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    await expect(ensureSession({ nodeId: 'n1' })).rejects.toThrow(
      'Claude slots are busy. Stop a running reply or wait for one to finish, then retry.',
    );
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

describe('allocateNodeIds', () => {
  it('returns backend-minted node ids', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      nodeIds: ['n-server-1', 'n-server-2'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(allocateNodeIds(2)).resolves.toEqual(['n-server-1', 'n-server-2']);
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ count: 2 });
  });
});

// ── streamMessage terminal-state safety net ──
// A streamed assistant node leaves `status: 'streaming'` ONLY when a terminal
// `done`/`error` event is dispatched. If the SSE connection ends (or silently
// stalls) without one, the node must still be finalized — otherwise it stays
// pinned in "streaming" forever (frozen, no spinner, can't stop). These tests
// lock that safety net.

/** Build a Response whose body streams the given pre-encoded SSE frames. */
function sseResponse(frames: string[], opts: { close?: boolean } = {}): Response {
  const close = opts.close ?? true;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      if (close) controller.close();
      // when close === false the stream stays open with no further bytes,
      // simulating a half-open / silently-stalled connection.
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('streamMessage terminal-state safety net', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('finalizes via onError when the stream closes without a terminal event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.chunk, data: { text: 'partial' } }),
      // connection then closes with NO done/error frame
    ])));

    const onChunk = vi.fn<(t: string) => void>();
    const onDone = vi.fn<(s?: string) => void>();
    const onError = vi.fn<(m: string) => void>();
    streamMessage('c1', 'hi', { onChunk, onDone, onError });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onChunk).toHaveBeenCalledWith('partial', undefined, undefined, undefined);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('fires onDone (and not onError) when the stream sends a done event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.chunk, data: { text: 'hello' } }),
      encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.done, data: { stopReason: 'end_turn' } }),
    ])));

    const onDone = vi.fn<(s?: string) => void>();
    const onError = vi.fn<(m: string) => void>();
    streamMessage('c1', 'hi', { onDone, onError });

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onError).not.toHaveBeenCalled();
  });

  it('sends the display/wire split and exposes the persisted terminal boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      encodeChatStreamEvent({
        event: CHAT_STREAM_EVENTS.done,
        data: { stopReason: 'end_turn', persisted: true },
      }),
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn();
    streamMessage('n1', 'wire prompt', { onDone }, undefined, {
      displayText: 'visible text',
      userMetadata: { quotedText: 'quote' },
    });

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      text: 'wire prompt',
      displayText: 'visible text',
      userMetadata: { quotedText: 'quote' },
    });
    expect(onDone).toHaveBeenCalledWith('end_turn', undefined, undefined, true);
  });

  it('finalizes via onError when the stream goes silent past the watchdog timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.chunk, data: { text: 'partial' } }),
    ], { close: false }))); // stays open, no further bytes ever arrive

    const onDone = vi.fn<(s?: string) => void>();
    const onError = vi.fn<(m: string) => void>();
    streamMessage('c1', 'hi', { onDone, onError });

    // 30s silence watchdog (3× the 10s backend heartbeat) must finalize the node.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });
});
