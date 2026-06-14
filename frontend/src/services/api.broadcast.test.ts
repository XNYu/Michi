import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_STREAM_EVENTS, encodeChatStreamEvent } from 'michi-shared';
import {
  cancelChat,
  claimPane,
  heartbeatPane,
  releasePane,
  streamMessage,
  subscribeChat,
} from './api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(frames: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(enc.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('pane ownership api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('claimPane posts ownerToken and windowId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ owner: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(claimPane('chat1', 'tokA', 'win-0')).resolves.toEqual({ owner: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/chats\/chat1\/claim$/);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      ownerToken: 'tokA',
      windowId: 'win-0',
    });
  });

  it('heartbeatPane returns false for a demotion response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: false }, 409)));

    await expect(heartbeatPane('chat1', 'tokA')).resolves.toBe(false);
  });

  it('releasePane posts the ownerToken', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await releasePane('chat1', 'tokA');

    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      ownerToken: 'tokA',
    });
  });
});

describe('broadcast stream api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('subscribeChat opens a replay cursor and dispatches events without posting cancel', async () => {
    const onTurnStart = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      encodeChatStreamEvent({
        event: CHAT_STREAM_EVENTS.turnStart,
        data: { turnId: 'T1', assistantId: 'a-n1-T1', nodeId: 'n1', userText: 'hi' },
      }),
    ]));
    vi.stubGlobal('fetch', fetchMock);

    subscribeChat('chat1', { onTurnStart }, { turnId: 'T0', seq: 4 });

    await vi.waitFor(() => expect(onTurnStart).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /\/chats\/chat1\/subscribe\?fromSeq=4&fromTurnId=T0$/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('streamMessage sends ownerToken with the message request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.done, data: { stopReason: 'end_turn' } }),
    ]));
    vi.stubGlobal('fetch', fetchMock);

    streamMessage('chat1', 'hello', { onDone: vi.fn() }, 'n1', 'tokA');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      text: 'hello',
      nodeId: 'n1',
      ownerToken: 'tokA',
    });
  });

  it('cancelChat sends ownerToken to the cancel endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await cancelChat('chat1', 'tokA');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/chats\/chat1\/cancel$/);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ ownerToken: 'tokA' });
  });
});
