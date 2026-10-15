import { afterEach, describe, expect, it, vi } from 'vitest';
import { setActiveBackendConnectionId } from '../config/backendConnections';
import { fetchRuntimeCatalog, listAgentModels } from './api/agentRuntime';

const catalog = (id: string) => ({ models: [{ id }], providers: [], capabilities: { models: true } });

describe('agent catalog request caching', () => {
  afterEach(() => {
    setActiveBackendConnectionId('local');
    vi.unstubAllGlobals();
  });

  it('shares simultaneous requests and cached snapshots, with explicit refresh', async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }))
      .mockResolvedValue(new Response(JSON.stringify(catalog('new'))));
    vi.stubGlobal('fetch', fetch);
    const first = fetchRuntimeCatalog('cache-concurrent');
    const second = fetchRuntimeCatalog('cache-concurrent');
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve(new Response(JSON.stringify(catalog('old'))));
    expect(await first).toEqual(await second);
    expect((await fetchRuntimeCatalog('cache-concurrent')).models[0].id).toBe('old');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await fetchRuntimeCatalog('cache-concurrent', undefined, { refresh: true })).models[0].id).toBe('new');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('isolates backend, runtime and provider and reuses an earlier scope on return', async () => {
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(catalog(url))));
    vi.stubGlobal('fetch', fetch);
    const first = await fetchRuntimeCatalog('cache-scope', 'a');
    await fetchRuntimeCatalog('cache-scope', 'b');
    await fetchRuntimeCatalog('cache-other', 'a');
    setActiveBackendConnectionId('remote-catalog');
    const remote = await fetchRuntimeCatalog('cache-scope', 'a');
    expect(remote.models).not.toEqual(first.models);
    setActiveBackendConnectionId('local');
    expect(await fetchRuntimeCatalog('cache-scope', 'a')).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('allows failed and unavailable catalogs to recover and retains a snapshot on refresh failure', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [], providers: [], capabilities: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify(catalog('recovered'))))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchRuntimeCatalog('cache-fail')).rejects.toThrow('503');
    expect((await fetchRuntimeCatalog('cache-fail')).capabilities).toBeNull();
    expect((await fetchRuntimeCatalog('cache-fail')).models[0].id).toBe('recovered');
    await expect(fetchRuntimeCatalog('cache-fail', undefined, { refresh: true })).rejects.toThrow('503');
    expect((await fetchRuntimeCatalog('cache-fail')).models[0].id).toBe('recovered');
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('caches active-model requests only with an explicit runtime scope', async () => {
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify({ models: [{ id: url }], sanitizedModel: null })));
    vi.stubGlobal('fetch', fetch);
    await listAgentModels({ runtime: 'cache-active', provider: 'a' });
    await listAgentModels({ runtime: 'cache-active', provider: 'a' });
    await listAgentModels({ runtime: 'cache-active', provider: 'a', refresh: true });
    await listAgentModels({ runtime: 'cache-active-other', provider: 'a' });
    await listAgentModels();
    await listAgentModels();
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});
