import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAuthConfig } from './auth';

afterEach(() => vi.restoreAllMocks());

describe('fetchAuthConfig', () => {
  it('keeps same-origin phone authentication on the configuration probe', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ requireAuth: true }));
    expect(await fetchAuthConfig()).toEqual({ requireAuth: true });
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/auth-config$/), { credentials: 'same-origin' });
  });
  it('preserves the legacy backend fallback when the endpoint is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    expect(await fetchAuthConfig()).toEqual({ requireAuth: false });
  });
});
