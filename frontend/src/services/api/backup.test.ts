import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportBackup, parseBackup, restoreBackup } from './backup';
const backup = { app: 'michi' as const, version: 1 as const, workspaces: [] };
afterEach(() => vi.unstubAllGlobals());
describe('portable backup API', () => {
  it('supports legacy files and rejects unsupported or incomplete archives', () => {
    expect(parseBackup(JSON.stringify(backup))).toEqual(backup);
    for (const value of [null, {}, { ...backup, version: 3 }, { ...backup, version: 2 },
      { ...backup, workspaces: [{}] }]) {
      expect(() => parseBackup(JSON.stringify(value))).toThrow();
    }
  });
  it('always imports with merge and preserves archive IDs', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ workspaceCount: 0 })));
    vi.stubGlobal('fetch', fetch);
    await restoreBackup(backup);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/backup/import?mode=merge'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify(backup) }));
  });
  it('surfaces server errors and never retries an import automatically', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Invalid backup' }), { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    await expect(restoreBackup(backup)).rejects.toThrow('Invalid backup');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('checks exported responses before downloading', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(backup))));
    await expect(exportBackup()).resolves.toEqual(backup);
  });
});
