import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useScheduledJobs } from './useScheduledJobs';
import { SCHEDULED_JOB_RUN_WINDOW_EVENT, SCHEDULED_JOBS_CHANGED_WINDOW_EVENT } from './scheduledNav';

const state = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('../../../services/api/scheduledJobs', () => ({
  listScheduledJobs: (...args: unknown[]) => state.list(...args),
}));

const scheduler = { active: true, serviceMode: false, timezone: 'UTC' };

beforeEach(() => {
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
});
