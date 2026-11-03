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
it('names the missing path for bodyless 404s and keeps backend error text', async () => {
  request.mockResolvedValueOnce({ ok: false, status: 404, json: async () => { throw new SyntaxError('empty'); } });
  await expect(fetchArtifactContent('remote:build:workspace', 'runtimeCopy.ts', true))
    .rejects.toThrow('File not found in this workspace: runtimeCopy.ts');
  request.mockResolvedValueOnce({ ok: false, status: 413, json: async () => ({ error: 'File too large' }) });
  await expect(fetchArtifactContent('remote:build:workspace', 'big.log', true)).rejects.toThrow('File too large');
});
