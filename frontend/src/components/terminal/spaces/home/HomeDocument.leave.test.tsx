import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageChangeDto, PageDto } from 'michi-shared';
import { useHomeDocument } from './HomeDocument';

const mocks = vi.hoisted(() => ({
  acknowledge: { a: vi.fn(), b: vi.fn() } as Record<string, ReturnType<typeof vi.fn>>,
  seen: { a: 1, b: 1 } as Record<string, number>,
}));

const home = (id: string) => ({
  id, workspaceId: `ws-${id}`, parentId: null, position: 0, title: id, color: null, updatedAt: 1, updatedBy: 'agent',
  pendingProposals: 0, helperNodeId: null, revision: 1, viewVersion: 1, blocks: [],
}) as PageDto;

vi.mock('../../../../state/chatStore', () => ({
  useChatActions: () => ({ openPagePane: vi.fn(), revealBackendNode: vi.fn() }),
  useChatNodesSnapshot: () => ({}),
  useChatProjects: () => ({ projects: [], agentStatus: null }),
  useStructuralSelector: (selector: (nodes: Record<string, unknown>) => unknown) => selector({}),
}));
vi.mock('../../../../state/pages/usePage', () => ({
  usePage: ({ pageId }: { pageId: string }) => ({
    page: home(pageId), changes: [{ seq: 5 } as PageChangeDto], status: 'ready', error: null, stale: false, lastSeenChangeSeq: 0,
    refresh: vi.fn(), edit: vi.fn(), accept: vi.fn(), dismiss: vi.fn(), reopen: vi.fn(), revert: vi.fn(), redo: vi.fn(),
    acknowledgeThrough: mocks.acknowledge[pageId],
  }),
}));
vi.mock('../../../../services/api/pages', () => ({
  fetchPageActivitySeen: (pageId: string) => Promise.resolve({ lastSeenChangeSeq: mocks.seen[pageId] }),
}));
vi.mock('../SpacesPage', () => ({ openNativePageRoute: vi.fn() }));
vi.mock('../NativeDatabase', () => ({ default: () => null }));

beforeEach(() => { for (const fn of Object.values(mocks.acknowledge)) fn.mockReset().mockResolvedValue(undefined); });

describe('leaving a home page', () => {
  it('acknowledges the page being left when the home switches to another workspace', async () => {
    const { rerender } = renderHook(({ id }) => useHomeDocument({ backendConnectionId: 'local', initial: home(id) }), { initialProps: { id: 'a' } });
    await act(async () => {});
    rerender({ id: 'b' });
    expect(mocks.acknowledge.a).toHaveBeenCalledWith(5);
    expect(mocks.acknowledge.b).not.toHaveBeenCalled();
  });
});
