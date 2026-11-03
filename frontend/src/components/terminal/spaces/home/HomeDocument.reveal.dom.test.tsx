import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageDto } from 'michi-shared';
import { useHomeDocument } from './HomeDocument';

vi.mock('../../../../state/chatStore', () => ({
  useChatActions: () => ({ openPagePane: vi.fn(), revealBackendNode: vi.fn() }),
  useChatNodesSnapshot: () => ({}),
  useChatProjects: () => ({ projects: [{ id: 'ws-1', name: 'Example workspace' }], agentStatus: null }),
  useStructuralSelector: (selector: (nodes: Record<string, unknown>) => unknown) => selector({}),
}));

const PAGE = vi.hoisted(() => ({ current: null as unknown as PageDto }));
const home = (...ids: string[]) => ({
  id: 'wh', workspaceId: 'ws-1', parentId: null, position: 0, title: 'rabbitholes', color: null, updatedAt: 1, updatedBy: 'agent',
  pendingProposals: 0, helperNodeId: null, revision: 1, viewVersion: 1,
  blocks: ids.map((id) => ({ id, rev: 1, type: 'markdown', text: `Block ${id}` })),
}) as PageDto;

vi.mock('../../../../state/pages/usePage', () => ({ usePage: () => ({
  page: PAGE.current, changes: [], status: 'ready', error: null, stale: false, lastSeenChangeSeq: 0,
  refresh: vi.fn(), edit: vi.fn(), accept: vi.fn(), dismiss: vi.fn(), reopen: vi.fn(), revert: vi.fn(), redo: vi.fn(), acknowledgeThrough: vi.fn(),
}) }));
vi.mock('../../../../services/api/pages', () => ({ fetchPageActivitySeen: () => Promise.resolve({ lastSeenChangeSeq: 0 }) }));
vi.mock('../SpacesPage', () => ({ openNativePageRoute: vi.fn() }));
vi.mock('../NativeDatabase', () => ({ default: () => null }));

function Home() {
  const doc = useHomeDocument({ backendConnectionId: 'local', initial: PAGE.current });
  const blocks = doc.page?.blocks ?? [];
  return <>{doc.renderBlocks(blocks.slice(0, 1), 'lead')}{doc.renderBlocks(blocks.slice(1), 'rest')}</>;
}

describe('a home the Meta agent writes while it is on screen', () => {
  const animate = vi.fn();
  beforeEach(() => {
    animate.mockClear();
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  });
  afterEach(() => {
    cleanup();
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
    vi.useRealTimers();
  });

  it('opens settled, then raises the blocks it writes in order', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    PAGE.current = home();
    const { rerender } = render(<Home />);
    expect(animate).not.toHaveBeenCalled();

    vi.setSystemTime(5000);
    PAGE.current = home('a', 'b');
    act(() => { rerender(<Home />); });
    const raised = animate.mock.contexts.map((el) => (el as HTMLElement).id);
    expect(raised).toEqual(['page-block-a', 'page-block-b']);
    // 40ms apart, holding nothing once done.
    expect(animate.mock.calls.map(([, options]) => options.delay)).toEqual([0, 40]);
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: 200, fill: 'backwards' });
  });

  it('draws an already-written home settled', () => {
    PAGE.current = home('a', 'b');
    const { rerender } = render(<Home />);
    act(() => { rerender(<Home />); });
    expect(animate).not.toHaveBeenCalled();
  });
});
