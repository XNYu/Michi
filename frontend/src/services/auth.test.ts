import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAuthConfig } from './auth';

afterEach(() => vi.restoreAllMocks());

describe('fetchAuthConfig', () => {
  it('preserves the legacy backend fallback when the endpoint is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    expect(await fetchAuthConfig()).toEqual({ requireAuth: false });
  });
});
