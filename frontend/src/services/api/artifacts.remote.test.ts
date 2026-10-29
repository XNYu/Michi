import { expect, it, vi } from 'vitest';
import { fetchArtifactContent } from './artifacts';
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./backendRequest', () => ({ backendFetch: request }));
vi.mock('../../config/backendConnections', () => ({ workspaceBackendApiBase: () => '/remote/build/api' }));
vi.mock('../../config/backendIdentity', () => ({ serverEntityId: () => 'workspace' }));
it('reads absolute preview paths through the workspace authenticated remote connection', async () => {
  request.mockResolvedValue({ ok: true, json: async () => ({ imageMime: 'image/png', content: 'data:image/png;base64,AA==' }) });
  const result = await fetchArtifactContent('remote:build:workspace', '/home/me/a b.png', true);
  expect(request).toHaveBeenCalledWith('/remote/build/api/artifacts/workspace/read?path=%2Fhome%2Fme%2Fa%20b.png&preview=1');
  expect(result.imageMime).toBe('image/png');
});
