import { afterEach, expect, it, vi } from 'vitest';
import { importWorkspaceFileUpload } from './uploads';

const { fetchMock, getPath } = vi.hoisted(() => ({ fetchMock: vi.fn(), getPath: vi.fn(() => '/local/shot.png') }));
vi.mock('./backendRequest', () => ({ backendFetch: fetchMock, backendRequestOptions: (_url: string, options: unknown) => options }));
vi.mock('../../config/backendConnections', () => ({
  workspaceBackendApiBase: () => '/remote/api',
  backendConnectionIdForWorkspace: () => 'remote',
  LOCAL_BACKEND_CONNECTION_ID: 'local',
}));
vi.mock('../../config/backendIdentity', () => ({ connectionIdFromApiUrl: () => 'remote' }));
vi.mock('../../config/backendConnectionState', () => ({ backendConnectionGeneration: () => 1, backendConnectionUnavailable: () => false }));
afterEach(() => vi.unstubAllGlobals());

it('uploads local bytes instead of trying a local filesystem path on the remote host', async () => {
  vi.stubGlobal('window', { electron: { getPathForFile: getPath } });
  vi.stubGlobal('FileReader', class {
    result = new Uint8Array([0, 255, 128]).buffer;
    onload?: () => void;
    readAsArrayBuffer() { this.onload?.(); }
  });
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ name: 'shot', filePath: '.artifacts/shot.png', size: 3 }) });
  await importWorkspaceFileUpload('workspace', '/remote/cwd', { name: 'shot.png', size: 3 } as File);
  expect(getPath).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0][0]).toBe('/remote/api/workspaces/import-file');
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ originalName: 'shot.png', contentBase64: 'AP+A' });
});
