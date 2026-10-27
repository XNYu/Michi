import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentModesResult, AgentStatus } from '../services/api';

vi.mock('../services/api', () => ({ listAgentModes: vi.fn() }));
import { listAgentModes } from '../services/api';
import { useAgentModeCatalog } from './useAgentModeCatalog';
import { HttpResponseError } from '../services/api/httpError';

const status = { runtime: 'kiro', capabilities: { modes: true } } as AgentStatus;
const catalog: AgentModesResult = { availableModes: [{ id: 'vibe', name: 'Default' }], defaultModeId: 'vibe' };
const flush = () => act(async () => { await Promise.resolve(); });

describe('useAgentModeCatalog', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(listAgentModes).mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('bounds a hung request, aborts it, and allows retry without reloading the page', async () => {
    let resolveOld!: (value: typeof catalog) => void;
    vi.mocked(listAgentModes).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue(catalog);
    const { result } = renderHook(() => useAgentModeCatalog('workspace', 'local', status));
    const signal = vi.mocked(listAgentModes).mock.calls[0][1]!;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(signal.aborted).toBe(true);
    expect(result.current.agentModesLoading).toBe(false);
    expect(result.current.agentModesError).toContain('retry');
    await act(async () => { result.current.retryAgentModes(); });
    expect(result.current.availableModes).toEqual(catalog.availableModes);
    expect(result.current.agentModesError).toBeNull();
    await act(async () => { resolveOld({ availableModes: [], defaultModeId: null }); });
    expect(result.current.availableModes).toEqual(catalog.availableModes);
  });

  it('rejects stale responses after switching Backend, runtime, or workspace', async () => {
    let resolveOld!: (value: typeof catalog) => void;
    vi.mocked(listAgentModes).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue({ availableModes: [{ id: 'other', name: 'Other' }], defaultModeId: 'other' });
    const { result, rerender } = renderHook(({ backend, workspace, runtime }) =>
      useAgentModeCatalog(workspace, backend, { ...status, runtime }),
    { initialProps: { backend: 'local', workspace: 'a', runtime: 'kiro' } });
    rerender({ backend: 'remote', workspace: 'b', runtime: 'crew' });
    await flush();
    await act(async () => { resolveOld(catalog); });
    expect(result.current.availableModes.map((mode) => mode.id)).toEqual(['other']);
  });

  it('stops on a permanent folder error and lets the user retry after repairing it', async () => {
    const message = 'Workspace folder does not exist: /old/path. Select an existing folder.';
    vi.mocked(listAgentModes).mockRejectedValueOnce(new HttpResponseError(message, 400, 'WORKSPACE_CWD_INVALID'))
      .mockResolvedValue(catalog);
    const { result } = renderHook(() => useAgentModeCatalog('workspace', 'local', status));
    await flush();
    expect(result.current.agentModesLoading).toBe(false);
    expect(result.current.agentModesError).toBe(message);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(listAgentModes).toHaveBeenCalledTimes(1);
    expect(result.current.agentModesError).toBe(message);
    await act(async () => { result.current.retryAgentModes(); });
    expect(result.current.availableModes).toEqual(catalog.availableModes);
    expect(result.current.agentModesError).toBeNull();
  });

  it('backs off transient failures and recovers within the loading window', async () => {
    vi.mocked(listAgentModes).mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new HttpResponseError('Starting', 503))
      .mockRejectedValueOnce(new HttpResponseError('Busy', 429))
      .mockResolvedValue(catalog);
    const { result } = renderHook(() => useAgentModeCatalog('workspace', 'local', status));
    await flush();
    for (const delay of [500, 1000, 2000]) {
      const attempts = vi.mocked(listAgentModes).mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
      expect(listAgentModes).toHaveBeenCalledTimes(attempts);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(listAgentModes).toHaveBeenCalledTimes(attempts + 1);
    }
    expect(result.current.availableModes).toEqual(catalog.availableModes);
    expect(result.current.agentModesLoading).toBe(false);
  });

  it('bounds repeated server failures without flooding the Backend', async () => {
    vi.mocked(listAgentModes).mockRejectedValue(new HttpResponseError('Unavailable', 500));
    const { result } = renderHook(() => useAgentModeCatalog('workspace', 'local', status));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(vi.mocked(listAgentModes).mock.calls.length).toBeLessThanOrEqual(16);
    expect(result.current.agentModesLoading).toBe(false);
    expect(result.current.agentModesError).toContain('retry');
    const attempts = vi.mocked(listAgentModes).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(listAgentModes).toHaveBeenCalledTimes(attempts);
  });

  it('rediscovers the catalog when the folder of the same Workspace changes', async () => {
    vi.mocked(listAgentModes).mockRejectedValueOnce(new HttpResponseError('Missing folder', 400))
      .mockResolvedValue(catalog);
    const { result, rerender } = renderHook(({ cwd }) => useAgentModeCatalog('workspace', 'local', status, cwd),
      { initialProps: { cwd: '/old' } });
    await flush();
    expect(result.current.agentModesError).toBe('Missing folder');
    rerender({ cwd: '/new' });
    await flush();
    expect(listAgentModes).toHaveBeenCalledTimes(2);
    expect(result.current.availableModes).toEqual(catalog.availableModes);
    expect(result.current.agentModesError).toBeNull();
  });
});
