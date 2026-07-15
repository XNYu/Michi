import { describe, expect, it, vi } from 'vitest';
import { WorkspaceSyncQueue } from './workspaceSyncQueue';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('WorkspaceSyncQueue', () => {
  it('allows only one in-flight task per workspace', async () => {
    const queue = new WorkspaceSyncQueue();
    const first = deferred();
    const second = deferred();
    const started: string[] = [];

    queue.enqueue('ws-1', async () => {
      started.push('first');
      await first.promise;
    });
    queue.enqueue('ws-1', async () => {
      started.push('second');
      await second.promise;
    });

    expect(started).toEqual(['first']);
    expect(queue.isInFlight('ws-1')).toBe(true);
    expect(queue.hasPending('ws-1')).toBe(true);

    first.resolve();
    await vi.waitFor(() => expect(started).toEqual(['first', 'second']));
    second.resolve();
    await queue.whenIdle('ws-1');
  });

  it('coalesces multiple queued tasks to the latest workspace snapshot', async () => {
    const queue = new WorkspaceSyncQueue();
    const first = deferred();
    const latest = deferred();
    const started: string[] = [];

    queue.enqueue('ws-1', async () => {
      started.push('first');
      await first.promise;
    });
    queue.enqueue('ws-1', async () => {
      started.push('superseded');
    });
    queue.enqueue('ws-1', async () => {
      started.push('latest');
      await latest.promise;
    });

    first.resolve();
    await vi.waitFor(() => expect(started).toEqual(['first', 'latest']));
    latest.resolve();
    await queue.whenIdle('ws-1');
  });

  it('allows different workspaces to sync concurrently', async () => {
    const queue = new WorkspaceSyncQueue();
    const a = deferred();
    const b = deferred();
    const started: string[] = [];

    queue.enqueue('ws-a', async () => {
      started.push('a');
      await a.promise;
    });
    queue.enqueue('ws-b', async () => {
      started.push('b');
      await b.promise;
    });

    expect(started).toEqual(['a', 'b']);
    a.resolve();
    b.resolve();
    await Promise.all([queue.whenIdle('ws-a'), queue.whenIdle('ws-b')]);
  });

  it('drains the latest queued task after an in-flight failure', async () => {
    const onTaskError = vi.fn();
    const queue = new WorkspaceSyncQueue(onTaskError);
    const first = deferred();
    const second = deferred();
    const started: string[] = [];

    queue.enqueue('ws-1', async () => {
      started.push('first');
      await first.promise;
    });
    queue.enqueue('ws-1', async () => {
      started.push('second');
      await second.promise;
    });

    first.reject(new Error('network down'));
    await vi.waitFor(() => expect(started).toEqual(['first', 'second']));
    expect(onTaskError).toHaveBeenCalledOnce();
    second.resolve();
    await queue.whenIdle('ws-1');
  });
});
