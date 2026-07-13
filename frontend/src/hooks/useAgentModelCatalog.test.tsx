import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/api', () => ({
  listAgentModels: vi.fn(),
}));

import { listAgentModels } from '../services/api';
import { useAgentModelCatalog } from './useAgentModelCatalog';

describe('useAgentModelCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports loading and stores a successful catalog', async () => {
    let resolve!: (value: { models: Array<{ id: string; label: string }>; sanitizedModel: null }) => void;
    (listAgentModels as any).mockImplementation(() => new Promise((r) => { resolve = r; }));

    const { result } = renderHook(() => useAgentModelCatalog({
      enabled: true,
      runtime: 'gemini',
      provider: 'google',
    }));

    await waitFor(() => expect(result.current.loading).toBe(true));

    await act(async () => {
      resolve({ models: [{ id: 'gemini-pro', label: 'Gemini Pro' }], sanitizedModel: null });
    });

    await waitFor(() => expect(result.current.models).toEqual([
      { id: 'gemini-pro', label: 'Gemini Pro' },
    ]));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('automatically retries a transient failure', async () => {
    vi.useFakeTimers();
    (listAgentModels as any)
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValue({ models: [{ id: 'gemini-flash' }], sanitizedModel: null });

    const { result } = renderHook(() => useAgentModelCatalog({
      enabled: true,
      runtime: 'gemini',
      provider: 'google',
    }));

    await act(async () => { await Promise.resolve(); });
    expect(result.current.error).toContain('Retrying');
    expect(result.current.loading).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listAgentModels).toHaveBeenCalledTimes(2);
    expect(result.current.models).toEqual([{ id: 'gemini-flash' }]);
    expect(result.current.error).toBeNull();
  });

  it('ignores a stale response after the runtime changes', async () => {
    let resolveKiro!: (value: { models: Array<{ id: string }>; sanitizedModel: null }) => void;
    (listAgentModels as any)
      .mockImplementationOnce(() => new Promise((r) => { resolveKiro = r; }))
      .mockResolvedValueOnce({ models: [{ id: 'gemini-pro' }], sanitizedModel: null });

    const { result, rerender } = renderHook(
      ({ runtime }) => useAgentModelCatalog({ enabled: true, runtime, provider: 'provider' }),
      { initialProps: { runtime: 'kiro' } },
    );

    rerender({ runtime: 'gemini' });
    await waitFor(() => expect(result.current.models).toEqual([{ id: 'gemini-pro' }]));

    await act(async () => {
      resolveKiro({ models: [{ id: 'stale-kiro' }], sanitizedModel: null });
    });

    expect(result.current.models).toEqual([{ id: 'gemini-pro' }]);
  });
});
