import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAuthConfig } from './auth';

afterEach(() => vi.restoreAllMocks());

describe('fetchAuthConfig', () => {
  it.each([false, true])('probes the public endpoint without cookies (requireAuth=%s)', async (requireAuth) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ requireAuth })));
    expect(await fetchAuthConfig()).toEqual({ requireAuth });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/auth-config'), { credentials: 'omit' });
  });

  it('preserves the legacy backend fallback when the endpoint is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    expect(await fetchAuthConfig()).toEqual({ requireAuth: false });
  });
});
