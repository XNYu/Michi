import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentModesResult, AgentStatus } from '../services/api';

vi.mock('../services/api', () => ({ listAgentModes: vi.fn() }));
import { listAgentModes } from '../services/api';
import { useAgentModeCatalog } from './useAgentModeCatalog';

const status = { runtime: 'kiro', capabilities: { modes: true } } as AgentStatus;
const catalog: AgentModesResult = { availableModes: [{ id: 'vibe', name: 'Default' }], defaultModeId: 'vibe' };
const flush = () => act(async () => { await Promise.resolve(); });

describe('useAgentModeCatalog', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(listAgentModes).mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('loads agents independently of warm readiness and treats a successful empty list as empty', async () => {
    vi.mocked(listAgentModes).mockResolvedValue({ availableModes: [], defaultModeId: null });
    const { result } = renderHook(() => useAgentModeCatalog('workspace', 'local', status));
    expect(result.current.agentModesLoading).toBe(true);
    await flush();
    expect(result.current.agentModesLoading).toBe(false);
    expect(result.current.agentModesError).toBeNull();
    expect(result.current.availableModes).toEqual([]);
    expect(listAgentModes).toHaveBeenCalledTimes(1);
  });

  it('automatically retries a transient failure', async () => {
    vi.mocked(listAgentModes).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(catalog);
    const { result } = renderHook(() => useAgentModeCatalog('workspace', 'local', status));
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(result.current.availableModes).toEqual(catalog.availableModes);
    expect(result.current.agentModesLoading).toBe(false);
  });

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

  it('retains a loaded workspace catalog during refresh and when returning to that workspace', async () => {
    vi.mocked(listAgentModes).mockResolvedValueOnce(catalog).mockImplementation(() => new Promise(() => {}));
    const { result, rerender } = renderHook(({ workspace }) => useAgentModeCatalog(workspace, 'local', status),
      { initialProps: { workspace: 'a' } });
    await flush();
    await act(async () => { result.current.retryAgentModes(); });
    expect(result.current.availableModes).toEqual(catalog.availableModes);
    rerender({ workspace: 'b' });
    expect(result.current.availableModes).toEqual(catalog.availableModes);
    expect(result.current.defaultModeId).toBeNull();
    rerender({ workspace: 'a' });
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

  it('does not reuse agents across Backend or runtime boundaries', async () => {
    vi.mocked(listAgentModes).mockResolvedValueOnce(catalog).mockImplementation(() => new Promise(() => {}));
    const { result, rerender } = renderHook(({ backend, runtime }) =>
      useAgentModeCatalog('a', backend, { ...status, runtime }),
    { initialProps: { backend: 'local', runtime: 'kiro' } });
    await flush();
    rerender({ backend: 'remote', runtime: 'kiro' });
    expect(result.current.availableModes).toEqual([]);
    rerender({ backend: 'local', runtime: 'crew' });
    expect(result.current.availableModes).toEqual([]);
  });

  it('does not share session-scoped catalogs between workspaces of other runtimes', async () => {
    vi.mocked(listAgentModes).mockResolvedValueOnce(catalog).mockImplementation(() => new Promise(() => {}));
    const crew = { ...status, runtime: 'crew' };
    const { result, rerender } = renderHook(({ workspace }) => useAgentModeCatalog(workspace, 'local', crew),
      { initialProps: { workspace: 'a' } });
    await flush();
    rerender({ workspace: 'b' });
    expect(result.current.availableModes).toEqual([]);
    expect(result.current.defaultModeId).toBeNull();
  });

  it('reloads on the existing status refresh event', async () => {
    vi.mocked(listAgentModes).mockResolvedValue(catalog);
    renderHook(() => useAgentModeCatalog('workspace', 'local', status));
    await flush();
    await act(async () => { window.dispatchEvent(new CustomEvent('michi:reload-agent-status')); });
    expect(listAgentModes).toHaveBeenCalledTimes(2);
  });

  it('skips discovery for runtimes without modes', async () => {
    const { result } = renderHook(() => useAgentModeCatalog('a', 'local', { ...status, capabilities: { ...status.capabilities, modes: false } }));
    await flush();
    expect(listAgentModes).not.toHaveBeenCalled();
    expect(result.current.agentModesLoading).toBe(false);
  });
});
