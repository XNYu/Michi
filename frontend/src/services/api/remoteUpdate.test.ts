import { afterEach, expect, it, vi } from 'vitest';
import { checkRemoteVersion, fetchRemoteUpdate } from './remoteUpdate';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('waits for cold SSH startup before reading a version and preserves caller cancellation', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  let resolveFetch!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
    resolveFetch = resolve;
    options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
  })));
  const result = checkRemoteVersion('remote');
  await vi.advanceTimersByTimeAsync(30_000);
  const version = { state: 'current', canUpdate: false };
  resolveFetch(new Response(JSON.stringify(version)));
  await expect(result).resolves.toEqual(version);

  const controller = new AbortController();
  const reason = new Error('Closed connection settings');
  const rejected = expect(checkRemoteVersion('remote', controller.signal)).rejects.toBe(reason);
  controller.abort(reason);
  await rejected;

  const timedOut = expect(checkRemoteVersion('stuck')).rejects.toBeDefined();
  await vi.advanceTimersByTimeAsync(45_000);
  await timedOut;
});

it('reads the gateway update attempt and treats a missing or unrecognised one as none', async () => {
  const running = { connectionId: 'remote', attemptId: 'attempt', phase: 'running', stage: 'build', message: 'Building remotely…', startedAt: '2026-10-23T00:00:00.000Z' };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ update: running })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ update: null })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ __unmocked: '/backend-connections/remote/update' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(fetchRemoteUpdate('remote')).resolves.toEqual(running);
  expect(fetchMock.mock.calls[0][0]).toMatch(/\/backend-connections\/remote\/update$/);
  await expect(fetchRemoteUpdate('remote')).resolves.toBeNull();
  await expect(fetchRemoteUpdate('remote')).resolves.toBeNull();
  await expect(fetchRemoteUpdate('remote')).rejects.toThrow('HTTP 403');
});
