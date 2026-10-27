import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageBlock, PageDto } from 'michi-shared';
import { pagePaneId, type PagePaneItem } from '../../../state/paneItems';
import { consumePageHelperDraft, pendingPageHelperDrafts } from '../../../state/pages/pageHelperDraft';
import { consumePageHelperSource } from '../../../state/pages/revealSource';

const mocks = vi.hoisted(() => ({
  page: null as PageDto | null,
  refresh: vi.fn(),
  edit: vi.fn(async () => undefined),
  revealBackendNode: vi.fn(async () => true),
  usePageIdentity: null as unknown,
  ownerOverrides: {} as Record<string, unknown>,
  pages: [] as Array<{ id: string; helperNodeId: string | null }>,
  sourceNodeId: 'helper-node',
  nodes: {} as Record<string, { projectId: string; pageId?: string | null }>,
}));

const item: PagePaneItem = {
  id: pagePaneId('backend-a', 'owner-ws', 'page-1'),
  kind: 'page', projectId: 'host-ws', treeId: 'host-tree', title: 'Page', createdAt: 1,
  backendConnectionId: 'backend-a', workspaceId: 'owner-ws', pageId: 'page-1',
};

vi.mock('../../../state/chatStore', () => ({
  useChatActions: () => ({ revealBackendNode: mocks.revealBackendNode }),
  useChatNodesSnapshot: () => mocks.nodes,
  useChatProjects: () => ({ projects: [
    { id: 'host-ws', name: 'Chat workspace' },
    { id: 'owner-ws', name: 'Page workspace', ...mocks.ownerOverrides },
  ] }),
}));
vi.mock('../../../state/pages/useSpaceTree', () => ({ useSpaceTree: () => ({ pages: mocks.pages, status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../../state/pages/usePage', () => ({
  usePage: (identity: unknown) => {
    mocks.usePageIdentity = identity;
    return { page: mocks.page, status: mocks.page ? 'ready' : 'loading', error: null, stale: false, refresh: mocks.refresh, edit: mocks.edit };
  },
}));
vi.mock('./NativePageDocument', () => ({
  default: ({ page, compact, readOnly, renderComponent, renderDatabaseRef, onOpenSource }: {
    page: PageDto; compact?: boolean; readOnly?: boolean;
    renderComponent?: (block: PageBlock) => React.ReactNode;
    renderDatabaseRef?: (block: Extract<PageBlock, { type: 'database-ref' }>) => React.ReactNode;
    onOpenSource?: (source: { nodeId: string; turnId: string; assistantId: string }) => void;
  }) => <div data-testid="native-document" data-compact={String(Boolean(compact))} data-read-only={String(Boolean(readOnly))}>
    {page.title}{renderComponent?.({ type: 'component', id: 'component-block', componentId: 'component-1', pinnedVersion: 1, props: {}, height: 200 } as PageBlock)}
    {renderDatabaseRef?.({ type: 'database-ref', id: 'database-block', databaseId: 'database-1', viewId: 'view-1' } as Extract<PageBlock, { type: 'database-ref' }>)}
    <button type="button" onClick={() => onOpenSource?.({ nodeId: mocks.sourceNodeId, turnId: 'turn-old', assistantId: 'answer-old' })}>Open helper source</button>
  </div>,
}));
vi.mock('./NativeDatabase', () => ({ default: ({ onAskDraft }: { onAskDraft?: (text: string) => void }) => <button type="button" onClick={() => onAskDraft?.('Help with this database view')}>Ask database helper</button> }));
vi.mock('./components/CustomBlock', () => ({ CustomBlock: ({ onAskDraft }: { onAskDraft?: (text: string) => void }) => <button type="button" onClick={() => onAskDraft?.('Help with this component')}>Ask component helper</button> }));

import PagePane from './PagePane';

describe('PagePane', () => {
  beforeEach(() => {
    mocks.revealBackendNode.mockReset().mockResolvedValue(true);
    mocks.page = {
      id: 'page-1', workspaceId: 'owner-ws', parentId: null, position: 0,
      title: 'Roadmap', color: null, updatedAt: 1, updatedBy: 'user', pendingProposals: 0,
      helperNodeId: null, revision: 1, viewVersion: 1, blocks: [],
    };
    mocks.ownerOverrides = {};
    mocks.pages = [{ id: 'page-1', helperNodeId: null }];
    mocks.sourceNodeId = 'helper-node';
    mocks.nodes = {};
  });

  it('loads using the owner identity, identifies a cross-workspace page, and opens standalone', () => {
    const onRoute = vi.fn();
    window.addEventListener('michi:open-native-page', onRoute);
    render(<PagePane item={item} />);
    expect(screen.getByText(/Belongs to Page workspace/)).toBeTruthy();
    expect(document.querySelector('[data-native-page-pane]')).toMatchObject({ dataset: {
      pageId: 'page-1', workspaceId: 'owner-ws', backendConnectionId: 'backend-a',
    } });
    expect(screen.getByTestId('native-document').getAttribute('data-compact')).toBe('true');
    expect(mocks.usePageIdentity).toEqual({ backendConnectionId: 'backend-a', workspaceId: 'owner-ws', pageId: 'page-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Open standalone' }));
    expect(onRoute).toHaveBeenCalledWith(expect.objectContaining({
      detail: { pageId: 'page-1', workspaceId: 'owner-ws', backendConnectionId: 'backend-a' },
    }));
    window.removeEventListener('michi:open-native-page', onRoute);
  });

  it('passes read-only state through for an archived or deleted owner workspace', () => {
    mocks.ownerOverrides = { archivedAt: 2 };
    render(<PagePane item={item} />);
    expect(screen.getByText('This workspace is archived or deleted. The page is read-only.')).toBeTruthy();
    expect(screen.getByTestId('native-document').getAttribute('data-read-only')).toBe('true');
  });

  it('queues custom block and database Ask drafts for the owning page without sending them', () => {
    const onRoute = vi.fn();
    window.addEventListener('michi:open-native-page', onRoute);
    render(<PagePane item={item} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask component helper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask database helper' }));
    const pending = pendingPageHelperDrafts({ backendConnectionId: 'backend-a', workspaceId: 'owner-ws', pageId: 'page-1' });
    expect(pending.map(({ text, blockContext }) => ({ text, blockContext }))).toEqual([
      { text: 'Help with this component', blockContext: { blockId: 'component-block', title: 'Component component-1', content: 'Custom page component' } },
      { text: 'Help with this database view', blockContext: { blockId: 'database-block', title: 'Database database-1', content: 'Native database view' } },
    ]);
    expect(onRoute).toHaveBeenCalledTimes(2);
    pending.forEach((request) => consumePageHelperDraft(request.requestId!));
    window.removeEventListener('michi:open-native-page', onRoute);
  });

  it('opens a bound helper source in its owning standalone page and retains the exact answer target', () => {
    mocks.pages = [{ id: 'page-1', helperNodeId: 'helper-node' }];
    const onRoute = vi.fn();
    window.addEventListener('michi:open-native-page', onRoute);
    render(<PagePane item={item} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open helper source' }));
    expect(onRoute).toHaveBeenCalledWith(expect.objectContaining({ detail: {
      pageId: 'page-1', workspaceId: 'owner-ws', backendConnectionId: 'backend-a',
    } }));
    expect(mocks.revealBackendNode).not.toHaveBeenCalled();
    expect(consumePageHelperSource({ backendConnectionId: 'backend-a', workspaceId: 'owner-ws' }, 'page-1', 'remote:backend-a:helper-node'))
      .toMatchObject({ nodeId: 'remote:backend-a:helper-node', turnId: 'turn-old', assistantId: 'answer-old' });
    window.removeEventListener('michi:open-native-page', onRoute);
  });

  it('routes another page’s currently bound helper to that source page', () => {
    mocks.pages = [{ id: 'page-1', helperNodeId: null }];
    mocks.nodes = { 'helper-node': { projectId: 'owner-ws', pageId: 'page-2' } };
    const onRoute = vi.fn();
    window.addEventListener('michi:open-native-page', onRoute);
    render(<PagePane item={item} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open helper source' }));
    expect(onRoute).toHaveBeenCalledWith(expect.objectContaining({ detail: {
      pageId: 'page-2', workspaceId: 'owner-ws', backendConnectionId: 'backend-a',
    } }));
    expect(mocks.revealBackendNode).not.toHaveBeenCalled();
    expect(consumePageHelperSource({ backendConnectionId: 'backend-a', workspaceId: 'owner-ws' }, 'page-2', 'remote:backend-a:helper-node'))
      .toMatchObject({ assistantId: 'answer-old' });
    window.removeEventListener('michi:open-native-page', onRoute);
  });

  it('opens a promoted former helper as an ordinary chat', async () => {
    mocks.sourceNodeId = 'promoted-node';
    mocks.pages = [{ id: 'page-1', helperNodeId: null }, { id: 'page-2', helperNodeId: 'promoted-node' }];
    mocks.nodes = { 'promoted-node': { projectId: 'owner-ws', pageId: null } };
    mocks.revealBackendNode.mockResolvedValue(true);
    render(<PagePane item={item} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open helper source' }));
    await vi.waitFor(() => expect(mocks.revealBackendNode).toHaveBeenCalledWith('remote:backend-a:owner-ws', 'remote:backend-a:promoted-node'));
  });
});
