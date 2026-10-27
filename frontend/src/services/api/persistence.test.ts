import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllWorkspacesMeta, fetchPersistenceCapabilities, fetchTreeMessages, supportsPaneInspection } from './persistence';
import { RemoteServiceRecoveryError } from './remoteRecovery';
import { fetchStream } from './streamTransport';

describe('fetchPersistenceCapabilities — paneInspection field', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({
      protocolVersion: 2,
      authoritativeTurnPersistence: true,
      durableNodePrerequisite: true,
      explicitCommands: true,
      backgroundWorkspaceSync: false,
      legacySyncAccepted: false,
      streamTransport: 'websocket-v1',
      paneInspection: 'v1',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('an old-gateway response with no paneInspection field is reported as unsupported', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      protocolVersion: 1,
      authoritativeTurnPersistence: false,
      durableNodePrerequisite: false,
      explicitCommands: false,
      backgroundWorkspaceSync: true,
      legacySyncAccepted: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const capabilities = await fetchPersistenceCapabilities('local');
    expect(supportsPaneInspection(capabilities)).toBe(false);
  });

  it('a scope probe does not replace the boot transport or change its protocol', async () => {
    vi.stubGlobal('WebSocket', class {});
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ protocolVersion: 1 })));
    await fetchPersistenceCapabilities('local');
    // A scope read can be for a newer backend (or fail during handover), but
    // only an explicit boot configuration owns authenticated stream sockets.
    await fetchPersistenceCapabilities('local', { configureTransport: false });
    fetchMock.mockResolvedValueOnce(new Response('data: {}\n\n'));
    await fetchStream('http://localhost:3000/api/chats/one/stream');
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://localhost:3000/api/chats/one/stream');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('tree message read deadlines', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('bounds a stalled response body and respects caller cancellation', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => ({
      ok: true,
      json: () => new Promise((_, reject) => {
        options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const caller = new AbortController();
    const pending = fetchTreeMessages('ws', 'tree', undefined, caller.signal);
    const failed = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(caller.signal.aborted).toBe(false);

    const next = fetchTreeMessages('ws', 'tree', undefined, caller.signal);
    const cancelled = expect(next).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    await cancelled;
  });
});

it('retains gateway recovery state for workspace retries and ignores a different machine’s status', async () => {
  const recovery = { connectionId: 'remote-c', phase: 'starting', message: 'Checking SSH…', diagnostic: { stage: 'ssh', log: 'Proxy waiting' } };
  const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: 'Starting remote Michi…', recovery }), { status: 502 }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const error = await fetchAllWorkspacesMeta('remote-c').catch(error => error);
    expect(error).toBeInstanceOf(RemoteServiceRecoveryError);
    expect(error.recovery).toEqual(recovery);
    expect(error.message).toContain('HTTP 502');
    const unrelated = await fetchAllWorkspacesMeta('other-machine').catch(error => error);
    expect(unrelated).not.toBeInstanceOf(RemoteServiceRecoveryError);
  } finally { vi.unstubAllGlobals(); }
});
