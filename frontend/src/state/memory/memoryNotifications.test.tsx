import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { MemoryChangedEvent, MemoryRecord } from 'michi-shared';
import type { MemoryChangeSubscription } from '../../services/api/memories';
import { MemoryApiError } from '../../services/api/memories';
import { SseHttpError } from '../../services/api/sseParser';
import {
  readMemoryBadge,
  resetMemoryNotifications,
  runSelfCreate,
  runSelfMutation,
  useMemoryBadge,
  useMemoryNotifications,
} from './memoryNotifications';

const api = vi.hoisted(() => ({
  subscriptions: [] as Array<{ options: MemoryChangeSubscription; stop: ReturnType<typeof vi.fn> }>,
  listMemories: vi.fn(),
  deleteMemory: vi.fn(),
}));
const toasts = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() });
  return { toast };
});

vi.mock('sonner', () => ({ toast: toasts.toast }));
vi.mock('../../services/api/memories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api/memories')>()),
  listMemories: api.listMemories,
  deleteMemory: api.deleteMemory,
  subscribeMemoryChanges: (options: MemoryChangeSubscription) => {
    const stop = vi.fn();
    api.subscriptions.push({ options, stop });
    return stop;
  },
}));

const event = (overrides: Partial<MemoryChangedEvent> = {}): MemoryChangedEvent => ({
  ownerUserId: 'local', workspaceId: null, memoryId: 'mem-1', action: 'created', status: 'active',
  body: 'Answer in Chinese', origin: 'explicit', supersedesId: null, ...overrides,
});

const record = (id: string): MemoryRecord => ({
  id, ownerUserId: 'local', scope: { kind: 'user' }, kind: 'preference', body: 'from Settings', source: null,
  status: 'active', origin: 'explicit', version: 1, supersedesId: null, sourceRisk: null, createdAt: 1, updatedAt: 1,
});

const page = (count: number, nextCursor: string | null = null) => ({
  items: Array.from({ length: count }, (_, i) => ({ ...record(`p-${i}`), status: 'pending' })), nextCursor,
});

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

function mount(onReview = vi.fn()) {
  const view = renderHook(() => { useMemoryNotifications(onReview); return useMemoryBadge(); });
  return { ...view, onReview, feed: () => api.subscriptions[api.subscriptions.length - 1] };
}

/** The toast message and options of every plain toast() call. */
const shown = () => toasts.toast.mock.calls.map(([message, options]) => ({ message, options }));

beforeEach(() => {
  resetMemoryNotifications();
  api.subscriptions = [];
  api.listMemories.mockReset().mockResolvedValue(page(0));
  api.deleteMemory.mockReset().mockResolvedValue(undefined);
  toasts.toast.mockReset();
  toasts.toast.success.mockReset();
  toasts.toast.error.mockReset();
  toasts.toast.dismiss.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetMemoryNotifications();
});

describe('memory change toasts', () => {
  it('shows “Remembered” with Undo for a memory an agent saved, and Undo deletes it', async () => {
    const { feed } = mount();
    await flush();
    act(() => feed().options.onEvent(event({ memoryId: 'mem-agent', body: '  Use   pnpm,\nnot npm  ' })));
    expect(shown()).toHaveLength(1);
    const [{ message, options }] = shown();
    expect(message).toBe('Remembered: Use pnpm, not npm');
    expect(options.id).toBe('memory:mem-agent');
    expect(options.action.label).toBe('Undo');
    await act(async () => { options.action.onClick(); });
    await flush();
    expect(api.deleteMemory).toHaveBeenCalledExactlyOnceWith('mem-agent');
    expect(toasts.toast.success).toHaveBeenCalledWith('Memory removed');
    // The deletion Undo caused shows nothing more and closes the toast.
    act(() => feed().options.onEvent(event({ memoryId: 'mem-agent', action: 'deleted' })));
    expect(shown()).toHaveLength(1);
    expect(toasts.toast.dismiss).toHaveBeenCalledWith('memory:mem-agent');
  });

  it('says so when Undo finds the memory already gone, and reports other failures', async () => {
    const { feed } = mount();
    await flush();
    act(() => feed().options.onEvent(event({ memoryId: 'gone' })));
    act(() => feed().options.onEvent(event({ memoryId: 'broken' })));
    api.deleteMemory.mockRejectedValueOnce(new MemoryApiError(404, 'Memory not found', { code: 'not_found' }));
    await act(async () => { shown()[0].options.action.onClick(); });
    await flush();
    expect(toasts.toast).toHaveBeenLastCalledWith('That memory was already removed');
    api.deleteMemory.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { shown()[1].options.action.onClick(); });
    await flush();
    expect(toasts.toast.error).toHaveBeenCalledWith('Couldn’t remove the memory: offline');
  });

  it('announces a memory waiting for approval with Review, counting the ones that follow in the same toast', async () => {
    const { feed, onReview } = mount();
    await flush();
    act(() => feed().options.onEvent(event({ memoryId: 'p1', status: 'pending', body: 'Deploy on Fridays' })));
    act(() => feed().options.onEvent(event({ memoryId: 'p2', status: 'pending' })));
    const [first, second] = shown();
    expect(first.message).toBe('1 memory is waiting for your confirmation');
    expect(first.options.description).toBe('Deploy on Fridays');
    expect(second.message).toBe('2 memories are waiting for your confirmation');
    expect(second.options.id).toBe(first.options.id);
    second.options.action.onClick();
    expect(onReview).toHaveBeenCalledOnce();
    // Once dismissed, the next one counts from one again.
    act(() => second.options.onDismiss());
    act(() => feed().options.onEvent(event({ memoryId: 'p3', status: 'pending' })));
    expect(shown()[2].message).toBe('1 memory is waiting for your confirmation');
  });

  it('offers Review rather than Undo for a correction, since deleting it would not restore the old memory', async () => {
    const { feed } = mount();
    await flush();
    act(() => feed().options.onEvent(event({ memoryId: 'new', supersedesId: 'old', body: 'Use 4 spaces' })));
    act(() => feed().options.onEvent(event({ memoryId: 'old', action: 'superseded', status: 'superseded' })));
    expect(shown()).toHaveLength(1);
    expect(shown()[0].message).toBe('Memory updated: Use 4 spaces');
    expect(shown()[0].options.action.label).toBe('Review');
  });

  it('shows nothing for updates, approvals and deletions, or twice for one memory', async () => {
    const { feed } = mount();
    await flush();
    for (const action of ['updated', 'approved', 'deleted', 'rejected', 'superseded'] as const) {
      act(() => feed().options.onEvent(event({ memoryId: `m-${action}`, action })));
    }
    expect(shown()).toHaveLength(0);
    act(() => feed().options.onEvent(event({ memoryId: 'twice' })));
    act(() => feed().options.onEvent(event({ memoryId: 'twice' })));
    expect(shown()).toHaveLength(1);
  });
});

describe('changes Settings makes itself', () => {
  it('stays quiet for a memory Settings is changing, and for a while after', async () => {
    const { feed } = mount();
    await flush();
    let finish!: () => void;
    const done = runSelfMutation('mem-self', () => new Promise<void>((resolve) => { finish = resolve; }));
    act(() => feed().options.onEvent(event({ memoryId: 'mem-self' })));
    finish();
    await act(async () => { await done; });
    act(() => feed().options.onEvent(event({ memoryId: 'mem-self', status: 'pending' })));
    expect(shown()).toHaveLength(0);
    // Another memory meanwhile still shows.
    act(() => feed().options.onEvent(event({ memoryId: 'mem-agent' })));
    expect(shown().map(({ message }) => message)).toEqual(['Remembered: Answer in Chinese']);
  });

  it('holds new memories while Settings adds one, then shows only the ones Settings did not add', async () => {
    const { feed } = mount();
    await flush();
    let answer!: (record: MemoryRecord) => void;
    const adding = runSelfCreate(() => new Promise<MemoryRecord>((resolve) => { answer = resolve; }));
    // The feed announces the addition before its HTTP answer arrives.
    act(() => feed().options.onEvent(event({ memoryId: 'mem-added', body: 'from Settings' })));
    act(() => feed().options.onEvent(event({ memoryId: 'mem-agent', body: 'from an agent' })));
    expect(shown()).toHaveLength(0);
    answer(record('mem-added'));
    await act(async () => { await adding; });
    expect(shown().map(({ message }) => message)).toEqual(['Remembered: from an agent']);
  });

  it('shows held memories when the addition fails', async () => {
    const { feed } = mount();
    await flush();
    const adding = runSelfCreate(() => Promise.reject(new Error('memory_disabled')));
    act(() => feed().options.onEvent(event({ memoryId: 'mem-agent' })));
    await act(async () => { await adding.catch(() => {}); });
    expect(shown()).toHaveLength(1);
  });
});

describe('the pending count', () => {
  it('reads the count when the feed opens and again shortly after each change', async () => {
    vi.useFakeTimers();
    api.listMemories.mockResolvedValue(page(2));
    const { result, feed } = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.listMemories).toHaveBeenCalledWith({ status: ['pending'], limit: 200 });
    expect(result.current).toEqual({ pendingCount: 2, pendingMore: false });
    api.listMemories.mockResolvedValue(page(200, 'next'));
    act(() => feed().options.onOpen?.());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current).toEqual({ pendingCount: 200, pendingMore: true });
    api.listMemories.mockClear().mockResolvedValue(page(1));
    act(() => {
      feed().options.onEvent(event({ memoryId: 'a', action: 'approved' }));
      feed().options.onEvent(event({ memoryId: 'b', action: 'rejected', status: 'pending' }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(api.listMemories).toHaveBeenCalledOnce();
    expect(result.current.pendingCount).toBe(1);
  });

  it('shows none on a backend without Memory', async () => {
    api.listMemories.mockRejectedValue(new MemoryApiError(404, 'Not found'));
    const { result } = mount();
    await flush();
    expect(result.current.pendingCount).toBe(0);
  });

  it('re-reads the count when the window regains focus', async () => {
    mount();
    await flush();
    api.listMemories.mockClear().mockResolvedValue(page(4));
    act(() => { window.dispatchEvent(new Event('focus')); });
    await flush();
    expect(api.listMemories).toHaveBeenCalledOnce();
    expect(readMemoryBadge().pendingCount).toBe(4);
  });
});

describe('the feed', () => {
  it('opens one feed for every listener and closes it with the last', async () => {
    const first = mount();
    const second = mount();
    await flush();
    expect(api.subscriptions).toHaveLength(1);
    first.unmount();
    expect(api.subscriptions[0].stop).not.toHaveBeenCalled();
    second.unmount();
    expect(api.subscriptions[0].stop).toHaveBeenCalledOnce();
  });

  it('reconnects with a growing delay, and stops on a backend without the feed', async () => {
    vi.useFakeTimers();
    const { feed } = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => feed().options.onDisconnect?.(new Error('network')));
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(api.subscriptions).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.subscriptions).toHaveLength(2);
    act(() => feed().options.onDisconnect?.(new Error('network')));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
    expect(api.subscriptions).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.subscriptions).toHaveLength(3);
    act(() => feed().options.onDisconnect?.(new SseHttpError(404)));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.subscriptions).toHaveLength(3);
  });

  it('never moves focus or navigates when a change arrives', async () => {
    const { feed, onReview } = mount();
    await flush();
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    act(() => {
      feed().options.onEvent(event({ memoryId: 'a' }));
      feed().options.onEvent(event({ memoryId: 'b', status: 'pending' }));
    });
    expect(document.activeElement).toBe(button);
    expect(onReview).not.toHaveBeenCalled();
    button.remove();
  });
});
