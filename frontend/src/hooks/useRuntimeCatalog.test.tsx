import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRuntimeCatalog, type RuntimeCatalogResponse } from '../services/api';
import { setActiveBackendConnectionId } from '../config/backendConnections';
import { useRuntimeCatalog } from './useRuntimeCatalog';

vi.mock('../services/api', () => ({ fetchRuntimeCatalog: vi.fn() }));
const catalog = (id: string): RuntimeCatalogResponse => ({ models: [{ id }], providers: [], capabilities: {
  models: true, modes: false, permissions: false, providerModels: false, reasoning: false,
  apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false,
} });

describe('useRuntimeCatalog', () => {
  beforeEach(() => { vi.resetAllMocks(); setActiveBackendConnectionId('local'); });

  it('keeps a catalog on menu reopen and supports explicit refresh', async () => {
    vi.mocked(fetchRuntimeCatalog).mockResolvedValue(catalog('opus'));
    const view = renderHook(({ enabled }) => useRuntimeCatalog({ enabled, runtime: 'claude' }),
      { initialProps: { enabled: true } });
    await waitFor(() => expect(view.result.current.models[0]?.id).toBe('opus'));
    view.rerender({ enabled: false });
    view.rerender({ enabled: true });
    expect(fetchRuntimeCatalog).toHaveBeenCalledTimes(1);
    await act(async () => view.result.current.retry());
    expect(fetchRuntimeCatalog).toHaveBeenLastCalledWith('claude', undefined, { refresh: true });
    view.rerender({ enabled: false });
    view.rerender({ enabled: true });
    expect(fetchRuntimeCatalog).toHaveBeenCalledTimes(2);
  });

  it('does not let a slow old runtime overwrite the selected backend catalog', async () => {
    let resolve!: (value: RuntimeCatalogResponse) => void;
    vi.mocked(fetchRuntimeCatalog).mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
      .mockResolvedValue(catalog('remote-opus'));
    const view = renderHook(() => useRuntimeCatalog({ enabled: true, runtime: 'claude' }));
    setActiveBackendConnectionId('remote-catalog-hook');
    view.rerender();
    await waitFor(() => expect(view.result.current.models[0]?.id).toBe('remote-opus'));
    await act(async () => resolve(catalog('stale-local')));
    expect(view.result.current.models[0]?.id).toBe('remote-opus');
    expect(fetchRuntimeCatalog).toHaveBeenCalledTimes(2);
    setActiveBackendConnectionId('local');
  });

  it('does not reuse the prior runtime after a cancelled catalog switch', async () => {
    vi.mocked(fetchRuntimeCatalog).mockResolvedValueOnce(catalog('opus'))
      .mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(catalog('opus'));
    const view = renderHook(({ runtime }) => useRuntimeCatalog({ enabled: true, runtime }),
      { initialProps: { runtime: 'claude' } });
    await waitFor(() => expect(view.result.current.models[0]?.id).toBe('opus'));
    view.rerender({ runtime: 'codex' });
    view.rerender({ runtime: 'claude' });
    await waitFor(() => expect(view.result.current.models[0]?.id).toBe('opus'));
    expect(fetchRuntimeCatalog).toHaveBeenCalledTimes(3);
  });
});
