import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setActiveBackendConnectionId,
  setKnownBackendConnections,
} from '../../config/backendConnections';
import { fetchProfileActivity } from './persistence';

const responseBody = {
  totalNodes: 1,
  totalThreads: 1,
  totalBranches: 0,
  totalMessages: 2,
  days: [{ dateKey: '2026-09-16', nodes: 1, branches: 0, messages: 2 }],
};

afterEach(() => {
  setActiveBackendConnectionId('local');
  setKnownBackendConnections([]);
  vi.unstubAllGlobals();
});

describe('fetchProfileActivity', () => {
  it('queries the active remote backend', async () => {
    setKnownBackendConnections([{
      id: 'remote-a',
      name: 'Remote A',
      transport: 'direct',
      apiUrl: 'https://remote.example/api',
      hasToken: true,
      createdAt: 1,
      updatedAt: 1,
    }]);
    setActiveBackendConnectionId('remote-a');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchProfileActivity('Asia/Tokyo', { connectionId: 'remote-a' })).resolves.toEqual(responseBody);

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/backend-connections/remote-a/proxy/profile/activity?timeZone=Asia%2FTokyo',
    );
  });

  it('rejects malformed snapshots so Profile can use its local fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(fetchProfileActivity('UTC')).rejects.toThrow(/malformed/i);
  });
});
