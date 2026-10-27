import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStatus } from '../services/api';
import { HttpResponseError } from '../services/api/httpError';

vi.mock('../services/api', () => ({ warmCwd: vi.fn() }));
import { warmCwd } from '../services/api';
import { useWorkspacePrewarm } from './useWorkspacePrewarm';

const status = { runtime: 'kiro', model: 'model-a' } as AgentStatus;
const workspace = { id: 'workspace', cwd: '/old/path', backendConnectionId: 'remote' };
const flush = () => act(async () => { await Promise.resolve(); });

describe('Workspace prewarming', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(warmCwd).mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('stops after one invalid-folder response despite unrelated project updates', async () => {
    vi.mocked(warmCwd).mockRejectedValue(new HttpResponseError('Missing folder', 400, 'WORKSPACE_CWD_INVALID'));
    const { rerender } = renderHook(({ project }) => useWorkspacePrewarm(true, project, status),
      { initialProps: { project: workspace } });
    await flush();
    rerender({ project: { ...workspace } });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(warmCwd).toHaveBeenCalledTimes(1);
  });

  it('retries temporary startup failures with backoff and keeps the owning Backend', async () => {
    vi.mocked(warmCwd).mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new HttpResponseError('Starting', 503)).mockResolvedValue(undefined);
    renderHook(() => useWorkspacePrewarm(true, workspace, status));
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(499); });
    expect(warmCwd).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(warmCwd).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(warmCwd).toHaveBeenCalledTimes(3);
    expect(warmCwd).toHaveBeenLastCalledWith(workspace.cwd, 'remote', expect.any(AbortSignal));
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(warmCwd).toHaveBeenCalledTimes(3);
  });

  it('bounds repeated transient failures', async () => {
    vi.mocked(warmCwd).mockRejectedValue(new HttpResponseError('Unavailable', 500));
    renderHook(() => useWorkspacePrewarm(true, workspace, status));
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(warmCwd).toHaveBeenCalledTimes(8);
  });

  it('aborts old work and cancels retries on folder changes and unmount', async () => {
    vi.mocked(warmCwd).mockRejectedValue(new TypeError('Failed to fetch'));
    const { rerender, unmount } = renderHook(({ project }) => useWorkspacePrewarm(true, project, status),
      { initialProps: { project: workspace } });
    await flush();
    const oldSignal = vi.mocked(warmCwd).mock.calls[0][2]!;
    rerender({ project: { ...workspace, cwd: '/new/path' } });
    await flush();
    expect(oldSignal.aborted).toBe(true);
    expect(warmCwd).toHaveBeenCalledTimes(2);
    const newSignal = vi.mocked(warmCwd).mock.calls[1][2]!;
    unmount();
    expect(newSignal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(warmCwd).toHaveBeenCalledTimes(2);
  });

  it('bounds a hung warm request and waits for hydration before starting', async () => {
    vi.mocked(warmCwd).mockImplementation(() => new Promise(() => {}));
    const { rerender } = renderHook(({ hydrated }) => useWorkspacePrewarm(hydrated, workspace, status),
      { initialProps: { hydrated: false } });
    expect(warmCwd).not.toHaveBeenCalled();
    rerender({ hydrated: true });
    const signal = vi.mocked(warmCwd).mock.calls[0][2]!;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(signal.aborted).toBe(true);
    expect(warmCwd).toHaveBeenCalledTimes(1);
  });
});
