import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { TaskActivity } from 'michi-shared';
import { fetchTaskActivity } from '../../../services/api/taskDatabase';
import { resetOpenedTasks, useTaskUpkeep } from './useTaskUpkeep';

vi.mock('../../../services/api/taskDatabase', () => ({ fetchTaskActivity: vi.fn() }));
vi.mock('../../../state/pages/pageEvents', () => ({ subscribePageChanges: vi.fn(() => () => {}) }));

const SEEN_KEY = 'michi.task-marks-seen.v1';
const HOUR = 60 * 60 * 1000;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const marked = (marks: TaskActivity['marks']): TaskActivity => ({ suggestions: [], marks, latestUpkeep: null });
const input = { connectionId: 'local', workspaceId: 'ws', databaseId: 'db', revision: 3, enabled: true };

beforeEach(() => {
  localStorage.clear();
  resetOpenedTasks();
  vi.mocked(fetchTaskActivity).mockReset();
});

describe('useTaskUpkeep', () => {
  it('marks a task until its details are opened, and again after a newer change', async () => {
    const now = Date.now();
    vi.mocked(fetchTaskActivity)
      .mockResolvedValueOnce(marked([{ rowId: 'r1', kind: 'updated', at: now - 1000 }]))
      .mockResolvedValue(marked([{ rowId: 'r1', kind: 'updated', at: now + 60_000 }]));
    const { result, rerender } = renderHook((props) => useTaskUpkeep(props), { initialProps: input });
    await flush();
    expect(fetchTaskActivity).toHaveBeenCalledWith({ backendConnectionId: 'local', workspaceId: 'ws', databaseId: 'db', signal: expect.any(AbortSignal) });
    expect(result.current.markOf('r1')).toBe('updated');
    act(() => result.current.seen('r1'));
    expect(result.current.markOf('r1')).toBeNull();
    expect(Object.keys(JSON.parse(localStorage.getItem(SEEN_KEY)!))).toEqual(['local:db:r1']);
    rerender({ ...input, revision: 4 });
    await flush();
    expect(result.current.markOf('r1')).toBe('updated');
  });

  it('remembers what was opened on this computer, and forgets it after two days', async () => {
    const now = Date.now();
    localStorage.setItem(SEEN_KEY, JSON.stringify({ 'local:db:r1': now, 'local:db:old': now - 49 * HOUR }));
    vi.mocked(fetchTaskActivity).mockResolvedValue(marked([{ rowId: 'r1', kind: 'new', at: now - 1000 }, { rowId: 'r2', kind: 'new', at: now - 1000 }]));
    const { result } = renderHook(() => useTaskUpkeep(input));
    await flush();
    expect([result.current.markOf('r1'), result.current.markOf('r2')]).toEqual([null, 'new']);
    act(() => result.current.seen('r2'));
    expect(Object.keys(JSON.parse(localStorage.getItem(SEEN_KEY)!)).sort()).toEqual(['local:db:r1', 'local:db:r2']);
  });

  it('groups the suggestions by task, and reads nothing while turned off', async () => {
    const { result, rerender } = renderHook((props) => useTaskUpkeep(props), { initialProps: { ...input, enabled: false } });
    await flush();
    expect(fetchTaskActivity).not.toHaveBeenCalled();
    expect(result.current.suggestionsOf('r1')).toEqual([]);
    const change = { id: 'chg', target: { kind: 'row', databaseId: 'db', rowId: 'r1', columnIds: ['status'] } };
    vi.mocked(fetchTaskActivity).mockResolvedValue({ suggestions: [change], marks: [], latestUpkeep: null } as unknown as TaskActivity);
    rerender(input);
    await flush();
    expect(result.current.suggestionsOf('r1')).toEqual([change]);
    expect(result.current.suggestionsOf('r2')).toEqual([]);
  });

  it('hands out a seen callback that keeps its identity across reads and re-renders', async () => {
    const now = Date.now();
    vi.mocked(fetchTaskActivity).mockResolvedValue(marked([{ rowId: 'r1', kind: 'new', at: now - 1000 }]));
    const { result, rerender } = renderHook((props) => useTaskUpkeep(props), { initialProps: input });
    const first = result.current.seen;
    await flush();
    rerender({ ...input });
    act(() => result.current.refresh());
    await flush();
    expect(result.current.seen).toBe(first);
    act(() => result.current.seen('r1'));
    expect(result.current.seen).toBe(first);
    expect(result.current.markOf('r1')).toBeNull();
  });

  it('shares what was opened between boards of one database, and keeps both entries on disk', async () => {
    const now = Date.now();
    vi.mocked(fetchTaskActivity).mockResolvedValue(marked([{ rowId: 'r1', kind: 'new', at: now - 1000 }, { rowId: 'r2', kind: 'new', at: now - 1000 }]));
    const first = renderHook(() => useTaskUpkeep(input));
    const second = renderHook(() => useTaskUpkeep(input));
    await flush();
    act(() => first.result.current.seen('r1'));
    expect(second.result.current.markOf('r1')).toBeNull();
    expect(second.result.current.markOf('r2')).toBe('new');
    act(() => second.result.current.seen('r2'));
    expect(first.result.current.markOf('r2')).toBeNull();
    expect(Object.keys(JSON.parse(localStorage.getItem(SEEN_KEY)!)).sort()).toEqual(['local:db:r1', 'local:db:r2']);
  });

  it('merges what another window saved instead of overwriting it', async () => {
    const now = Date.now();
    vi.mocked(fetchTaskActivity).mockResolvedValue(marked([{ rowId: 'r1', kind: 'new', at: now - 1000 }, { rowId: 'r2', kind: 'new', at: now - 1000 }]));
    const { result } = renderHook(() => useTaskUpkeep(input));
    await flush();
    localStorage.setItem(SEEN_KEY, JSON.stringify({ 'local:db:r2': now }));
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: SEEN_KEY })); });
    expect(result.current.markOf('r2')).toBeNull();
    act(() => result.current.seen('r1'));
    expect(Object.keys(JSON.parse(localStorage.getItem(SEEN_KEY)!)).sort()).toEqual(['local:db:r1', 'local:db:r2']);
  });

  it('shows no answer from another database while the new one is read', async () => {
    const now = Date.now();
    const upkeep = { batchId: 'b-old', at: now, added: 1, updated: 0, removed: 0, source: null };
    vi.mocked(fetchTaskActivity).mockResolvedValueOnce({ suggestions: [], marks: [], latestUpkeep: upkeep } as unknown as TaskActivity);
    const { result, rerender } = renderHook((props) => useTaskUpkeep(props), { initialProps: input });
    await flush();
    expect(result.current.activity?.latestUpkeep?.batchId).toBe('b-old');
    vi.mocked(fetchTaskActivity).mockRejectedValue(new Error('down'));
    rerender({ ...input, databaseId: 'db-2' });
    expect(result.current.activity).toBeNull();
    await flush();
    expect(result.current.activity).toBeNull();
  });
});
