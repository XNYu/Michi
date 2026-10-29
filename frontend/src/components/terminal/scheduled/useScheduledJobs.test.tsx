import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetScheduledJobsStore, useScheduledJobs } from './useScheduledJobs';
import { SCHEDULED_JOB_RUN_WINDOW_EVENT, SCHEDULED_JOBS_CHANGED_WINDOW_EVENT } from './scheduledNav';

const state = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('../../../services/api/scheduledJobs', () => ({
  listScheduledJobs: (...args: unknown[]) => state.list(...args),
}));

const scheduler = { active: true, serviceMode: false, timezone: 'UTC' };

beforeEach(() => {
  resetScheduledJobsStore();
  state.list.mockReset();
  state.list.mockResolvedValue({ jobs: [], scheduler });
});

describe('useScheduledJobs', () => {
  it('refreshes when a job changes elsewhere, e.g. through an agent tool', async () => {
    const { result } = renderHook(() => useScheduledJobs());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(state.list).toHaveBeenCalledTimes(1);

    state.list.mockResolvedValue({ jobs: [{ id: 'job-1' }], scheduler });
    window.dispatchEvent(new CustomEvent(SCHEDULED_JOBS_CHANGED_WINDOW_EVENT, { detail: { change: 'created', jobId: 'job-1' } }));
    await waitFor(() => expect(result.current.jobs).toHaveLength(1));
    expect(state.list).toHaveBeenCalledTimes(2);
  });

  it('coalesces a burst of run and change events into one refresh', async () => {
    const { result } = renderHook(() => useScheduledJobs());
    await waitFor(() => expect(result.current.loading).toBe(false));
    window.dispatchEvent(new CustomEvent(SCHEDULED_JOB_RUN_WINDOW_EVENT));
    window.dispatchEvent(new CustomEvent(SCHEDULED_JOBS_CHANGED_WINDOW_EVENT));
    window.dispatchEvent(new CustomEvent(SCHEDULED_JOBS_CHANGED_WINDOW_EVENT));
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(state.list).toHaveBeenCalledTimes(2);
  });

  it('stops listening after unmount', async () => {
    const { result, unmount } = renderHook(() => useScheduledJobs());
    await waitFor(() => expect(result.current.loading).toBe(false));
    unmount();
    window.dispatchEvent(new CustomEvent(SCHEDULED_JOBS_CHANGED_WINDOW_EVENT));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(state.list).toHaveBeenCalledTimes(1);
  });
  it('shares one request and preserves a warm list when another view mounts', async () => {
    state.list.mockResolvedValue({ jobs: [{ id: 'saved' }], scheduler });
    const first = renderHook(() => useScheduledJobs());
    const second = renderHook(() => useScheduledJobs());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(second.result.current.jobs[0].id).toBe('saved');
    expect(state.list).toHaveBeenCalledTimes(1);
    second.unmount();
    const reopened = renderHook(() => useScheduledJobs());
    expect(reopened.result.current.loading).toBe(false);
    expect(reopened.result.current.jobs[0].id).toBe('saved');
    expect(state.list).toHaveBeenCalledTimes(1);
  });

  it('keeps cached content after all views unmount and background refresh fails', async () => {
    state.list.mockResolvedValue({ jobs: [{ id: 'saved' }], scheduler });
    const first = renderHook(() => useScheduledJobs());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();
    state.list.mockRejectedValue(new Error('offline'));
    const reopened = renderHook(() => useScheduledJobs());
    expect(reopened.result.current.jobs[0].id).toBe('saved');
    expect(reopened.result.current.loading).toBe(false);
    await waitFor(() => expect(reopened.result.current.error).toBe('offline'));
    expect(reopened.result.current.jobs[0].id).toBe('saved');
  });

  it('rejects a stale read after a mutation and shares the follow-up refresh', async () => {
    let resolve!: (value: unknown) => void;
    state.list.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = renderHook(() => useScheduledJobs());
    const second = renderHook(() => useScheduledJobs());
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(1));
    act(() => first.result.current.upsert({ id: 'new' } as never));
    expect(second.result.current.jobs[0].id).toBe('new');
    state.list.mockResolvedValue({ jobs: [{ id: 'new' }], scheduler });
    await act(async () => { resolve({ jobs: [], scheduler }); });
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.jobs[0].id).toBe('new');
    expect(state.list).toHaveBeenCalledTimes(2);
  });

});
