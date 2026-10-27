import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePageDatabase } from './usePageDatabase';

const api = vi.hoisted(() => ({ editPageDatabase: vi.fn(), fetchPageDatabase: vi.fn() }));

vi.mock('../../services/api/pages', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/api/pages')>(),
  ...api,
}));

afterEach(() => vi.clearAllMocks());

describe('usePageDatabase refresh state', () => {
  it('keeps a confirmed database editable during refresh and marks it stale when refresh fails', async () => {
    const database = {
      id: 'database-cache-state', workspaceId: 'workspace-cache-state', title: 'Confirmed',
      columns: [], rows: [], views: [], revision: 1, updatedAt: 1,
    };
    let resolveRefresh!: (value: typeof database) => void;
    api.fetchPageDatabase
      .mockResolvedValueOnce(database)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }))
      .mockResolvedValueOnce(database)
      .mockRejectedValueOnce(new Error('offline'));
    api.editPageDatabase.mockResolvedValue({
      database: { ...database, revision: 2 },
      changes: { resource: { kind: 'database', id: database.id }, revision: 2, applied: [], proposed: [], rejected: [] },
    });

    const { result } = renderHook(() => usePageDatabase({
      backendConnectionId: 'local', workspaceId: database.workspaceId, databaseId: database.id,
    }));
    await waitFor(() => expect(result.current.database?.revision).toBe(1));

    act(() => result.current.refresh());
    expect(result.current.stale).toBe(false);
    await act(async () => { await result.current.edit([]); });
    expect(api.editPageDatabase).toHaveBeenCalledTimes(1);

    resolveRefresh(database);
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.stale).toBe(true));
    await expect(result.current.edit([])).rejects.toThrow('Database is not ready for editing');
  });
});
