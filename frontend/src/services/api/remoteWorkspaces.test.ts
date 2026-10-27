import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRemoteWorkspaces } from './remoteWorkspaces';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('fetchRemoteWorkspaces', () => {
  it('reads flat summaries from the selected proxy without using the HTTP cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ workspaces: [
      { id: 'one', name: 'Remote project', cwd: '/srv/project', archived_at: 1, deleted_at: null, settings: 'private settings' },
      { id: 'trash', name: 'Deleted workspace', deleted_at: 2 },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchRemoteWorkspaces('host/one')).resolves.toEqual([
      { id: 'one', name: 'Remote project', cwd: '/srv/project', archivedAt: 1, deletedAt: null },
      { id: 'trash', name: 'Deleted workspace', deletedAt: 2 },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/backend-connections/host%2Fone/proxy/workspaces'),
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
  });

  it('rejects ambiguous duplicate IDs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ workspaces: [{ id: 'same', name: 'One' }, { id: 'same', name: 'Two' }] })));
    await expect(fetchRemoteWorkspaces('remote')).rejects.toThrow('duplicate workspace IDs');
  });

  it('keeps useful gateway error details while redacting credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: 'SSH authentication expired. Authorization: Bearer private-value' }, 502)));
    await expect(fetchRemoteWorkspaces('remote')).rejects.toThrow('HTTP 502): SSH authentication expired. Authorization: Bearer [redacted]');
  });

  it('bounds an unresponsive remote with a useful timeout error', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    })));
    const result = fetchRemoteWorkspaces('remote');
    const rejected = expect(result).rejects.toThrow('Reading remote workspaces timed out.');
    deadline.abort();
    await rejected;
  });

  it('allows a cold SSH tunnel to open and still bounds an unresponsive gateway', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
      resolveFetch = resolve;
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    })));
    const result = fetchRemoteWorkspaces('remote');
    await vi.advanceTimersByTimeAsync(30_000);
    resolveFetch(response({ workspaces: [{ id: 'one', name: 'Remote project' }] }));
    await expect(result).resolves.toEqual([expect.objectContaining({ id: 'one' })]);
    const rejected = expect(fetchRemoteWorkspaces('stuck')).rejects.toThrow('Reading remote workspaces timed out.');
    await vi.advanceTimersByTimeAsync(45_000);
    await rejected;
  });
});
