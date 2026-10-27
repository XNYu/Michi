import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyPageChanged } from './pageEvents';
import { useSpaces } from './useSpaces';

const api = vi.hoisted(() => ({ fetchSpaces: vi.fn() }));

vi.mock('../../services/api/pages', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/api/pages')>(),
  ...api,
}));

afterEach(() => vi.clearAllMocks());

describe('useSpaces invalidation', () => {
  it('refreshes for same-backend page events and ignores other backends', async () => {
    api.fetchSpaces.mockResolvedValue([]);
    const { result } = renderHook(() => useSpaces('spaces-event-test'));
    await waitFor(() => expect(api.fetchSpaces).toHaveBeenCalledTimes(1));

    act(() => notifyPageChanged({
      backendConnectionId: 'another-backend', workspaceId: 'workspace', pageId: 'page',
    }));
    expect(api.fetchSpaces).toHaveBeenCalledTimes(1);

    act(() => notifyPageChanged({
      backendConnectionId: 'spaces-event-test', workspaceId: 'workspace', pageId: 'page',
    }));
    await waitFor(() => expect(api.fetchSpaces).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe('ready');
  });
});
