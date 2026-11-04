import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryRecord } from 'michi-shared';
import {
  MemoryApiError,
  createMemory,
  deleteMemory,
  fetchMemoryExtractionStatus,
  isMemoryNotFound,
  isMemoryUnavailable,
  isMemoryVersionConflict,
  listMemories,
  saveMemorySettings,
  setMemoryExtractionPaused,
  subscribeMemoryChanges,
  updateMemory,
} from './memories';

const stream = vi.hoisted(() => ({ fetchStream: vi.fn() }));
vi.mock('./streamTransport', () => ({ fetchStream: stream.fetchStream }));

const RECORD: MemoryRecord = {
  id: 'mem-1', ownerUserId: 'local', scope: { kind: 'workspace', workspaceId: 'ws-1' }, kind: 'convention', body: 'use 2 spaces',
  source: { nodeId: 'n-1' }, status: 'active', origin: 'explicit', version: 3, supersedesId: null, sourceRisk: null, createdAt: 1, updatedAt: 2,
};

const fetchMock = vi.fn();
const answer = (status: number, body?: unknown) => fetchMock.mockResolvedValueOnce(
  new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
);
const lastCall = () => {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit | undefined];
  return { url: new URL(url, 'http://localhost'), init };
};

beforeEach(() => {
  fetchMock.mockReset();
  stream.fetchStream.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('memory REST client', () => {
  it('lists with scope, workspace, statuses, search and cursor, keeping only well-formed records', async () => {
    answer(200, { items: [RECORD, { id: 'broken' }], nextCursor: 'c2' });
    const page = await listMemories({ scope: 'workspace', workspaceId: 'ws-1', status: ['active', 'pending'], q: ' spaces ', cursor: 'c1', limit: 50 });
    expect(page).toEqual({ items: [RECORD], nextCursor: 'c2' });
    const { url } = lastCall();
    expect(url.pathname).toMatch(/\/memories$/);
    expect(Object.fromEntries(url.searchParams)).toEqual({ scope: 'workspace', workspaceId: 'ws-1', status: 'active,pending', q: 'spaces', cursor: 'c1', limit: '50' });
  });

  it('reads an answer of another shape, or a bare 404, as a backend without Memory', async () => {
    answer(200, { __unmocked: '/memories' });
    const shape = await listMemories().catch((error: unknown) => error);
    expect(isMemoryUnavailable(shape)).toBe(true);
    answer(404, '<html>Cannot GET</html>');
    const missing = await listMemories().catch((error: unknown) => error);
    expect(isMemoryUnavailable(missing)).toBe(true);
    // A memory that is gone is not a missing route.
    answer(404, { error: 'Memory not found', code: 'not_found' });
    const gone = await deleteMemory('mem-9').catch((error: unknown) => error);
    expect(isMemoryUnavailable(gone)).toBe(false);
    expect(isMemoryNotFound(gone)).toBe(true);
  });

  it('sends edits with the expected version and reports a conflict with the stored version', async () => {
    answer(409, { error: 'The memory changed since it was read', code: 'version_conflict', currentVersion: 4 });
    const conflict = await updateMemory('mem-1', { body: 'use tabs', expectedVersion: 3 }).catch((error: unknown) => error);
    expect(isMemoryVersionConflict(conflict)).toBe(true);
    expect((conflict as MemoryApiError).currentVersion).toBe(4);
    const { url, init } = lastCall();
    expect(url.pathname).toMatch(/\/memories\/mem-1$/);
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ body: 'use tabs', expectedVersion: 3 });

    answer(200, { memory: { ...RECORD, scope: { kind: 'user' }, version: 4 } });
    expect((await updateMemory('mem-1', { scope: { kind: 'user' }, expectedVersion: 3 })).version).toBe(4);
  });

  it('creates, deletes and saves the mode', async () => {
    answer(201, { memory: RECORD });
    expect(await createMemory({ scope: { kind: 'user' }, kind: 'fact', body: 'x' })).toEqual(RECORD);
    expect(lastCall().init?.method).toBe('POST');
    answer(204);
    await expect(deleteMemory('a/b')).resolves.toBeUndefined();
    expect(lastCall().url.pathname).toMatch(/\/memories\/a%2Fb$/);
    answer(409, { error: 'Memory is turned off', code: 'memory_disabled' });
    const off = await createMemory({ scope: { kind: 'user' }, kind: 'fact', body: 'x' }).catch((error: unknown) => error);
    expect((off as MemoryApiError).code).toBe('memory_disabled');
    answer(200, { mode: 'off' });
    expect(await saveMemorySettings('off')).toEqual({ mode: 'off' });
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({ mode: 'off' });
  });
});

describe('automatic memory status', () => {
  const STATUS = { enabled: true, paused: false, lastRunAt: 5, lastError: null, pendingCount: 2, todayTokens: 1200, dailyTokenLimit: 50000 };

  it('reads the status, and null from a backend without it', async () => {
    answer(200, STATUS);
    expect(await fetchMemoryExtractionStatus()).toEqual(STATUS);
    answer(404, { error: 'not found' });
    expect(await fetchMemoryExtractionStatus()).toBeNull();
    answer(200, { __unmocked: '/memory-extraction/status' });
    expect(await fetchMemoryExtractionStatus()).toBeNull();
  });

  it('pauses and resumes, reading the status again when the answer has none', async () => {
    answer(200, { ...STATUS, paused: true });
    expect((await setMemoryExtractionPaused(true))?.paused).toBe(true);
    expect(lastCall().url.pathname).toMatch(/\/memory-extraction\/pause$/);
    answer(200, { ok: true });
    answer(200, STATUS);
    expect((await setMemoryExtractionPaused(false))?.paused).toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url), 'http://localhost').pathname.replace(/^.*\/memory/, '/memory')))
      .toEqual(['/memory-extraction/pause', '/memory-extraction/resume', '/memory-extraction/status']);
  });
});

describe('subscribeMemoryChanges', () => {
  const sse = (text: string) => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

  it('reads memory_changed frames through the stream transport and reports the end', async () => {
    const change = { ownerUserId: 'local', workspaceId: null, memoryId: 'mem-1', action: 'created', status: 'active', body: 'x', origin: 'explicit' };
    stream.fetchStream.mockResolvedValue(sse(`: connected\n\nevent: memory_changed\ndata: ${JSON.stringify(change)}\n\nevent: memory_changed\ndata: {"broken":true}\n\nevent: other\ndata: {}\n\n`));
    const onEvent = vi.fn();
    const onOpen = vi.fn();
    const ended = new Promise<Error | undefined>((resolve) => subscribeMemoryChanges({ onEvent, onOpen, onDisconnect: resolve }));
    expect(await ended).toBeUndefined();
    expect(String(stream.fetchStream.mock.calls[0][0])).toMatch(/\/memories\/changes\/stream$/);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onEvent.mock.calls).toEqual([[{ ...change, supersedesId: null }]]);
  });

  it('reports the HTTP status of a refused feed', async () => {
    stream.fetchStream.mockResolvedValue(new Response('{}', { status: 404 }));
    const error = await new Promise<Error | undefined>((resolve) => subscribeMemoryChanges({ onEvent: vi.fn(), onDisconnect: resolve }));
    expect((error as { status?: number }).status).toBe(404);
  });

  it('stays silent after unsubscribe', async () => {
    let release!: (response: Response) => void;
    stream.fetchStream.mockReturnValue(new Promise<Response>((resolve) => { release = resolve; }));
    const onDisconnect = vi.fn();
    const onOpen = vi.fn();
    const stop = subscribeMemoryChanges({ onEvent: vi.fn(), onOpen, onDisconnect });
    stop();
    expect((stream.fetchStream.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    release(sse(': connected\n\n'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});
