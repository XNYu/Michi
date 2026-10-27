import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageBlock } from 'michi-shared';
import { consumePageHelperDraft, pendingPageHelperDrafts } from '../../../state/pages/pageHelperDraft';

const mocks = vi.hoisted(() => ({ edit: vi.fn(), readComponent: vi.fn(), layoutRules: vi.fn(), openTasks: vi.fn(), slotInsert: vi.fn() }));

vi.mock('../../../state/chatStore', () => ({
  useChatActions: () => ({ openPagePane: vi.fn(), revealBackendNode: vi.fn() }),
  useChatNodesSnapshot: () => ({}),
  useChatProjects: () => ({ projects: [{ id: 'workspace-1', name: 'Workspace' }] }),
}));
vi.mock('../../../state/pages/useSpaceTree', () => ({ useSpaceTree: () => ({ pages: [{ id: 'page-1', workspaceId: 'workspace-1', parentId: null, position: 0, title: 'Project Space' }], status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../../state/pages/usePage', () => ({ usePage: () => ({
  page: { id: 'page-1', workspaceId: 'workspace-1', parentId: null, position: 0, title: 'Project Space', color: null, updatedAt: 1, updatedBy: 'user', pendingProposals: 0, helperNodeId: null, revision: 1, viewVersion: 1, blocks: [{ id: 'md-1', rev: 1, type: 'markdown', text: 'Hello' }] },
  changes: [], status: 'ready', error: null, stale: false, refresh: vi.fn(), edit: mocks.edit, accept: vi.fn(), dismiss: vi.fn(), reopen: vi.fn(), revert: vi.fn(), redo: vi.fn(), revertBatch: vi.fn(),
}) }));
vi.mock('../../../state/pages/useSpaces', () => ({ useSpaces: () => ({ spaces: [], status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../../state/pages/revealSource', () => ({ revealPageSource: vi.fn() }));
vi.mock('../../../state/pages/pageEvents', () => ({ notifyPageChanged: vi.fn() }));
vi.mock('../../../services/api/pages', () => ({
  createWorkspaceDatabase: vi.fn(), listWorkspaceDatabases: vi.fn(), createPage: vi.fn(), deletePage: vi.fn(), fetchPage: vi.fn(), patchPage: vi.fn(),
}));
vi.mock('../../../services/api/pageComponents', () => ({ readPageComponent: mocks.readComponent }));
vi.mock('../../../services/api/taskDatabase', () => ({ openTaskDatabase: mocks.openTasks, fetchTaskDatabaseId: vi.fn() }));
vi.mock('../../../services/api/spacesHome', () => ({ fetchLayoutRules: mocks.layoutRules, deleteLayoutRule: vi.fn(), fetchLayoutPreferences: vi.fn().mockResolvedValue({ text: '', revision: 0, updatedAt: null, updatedBy: null }), saveLayoutPreferences: vi.fn() }));
vi.mock('./NativePageDocument', () => ({ default: ({ page, renderComponent, renderDatabaseRef, addEntries, slotAddEntries }: { page: { blocks: Array<{ type: string }> }; renderComponent?: (block: PageBlock) => React.ReactNode; renderDatabaseRef?: (block: Extract<PageBlock, { type: 'database-ref' }>) => React.ReactNode; addEntries?: (afterId: string, anchor: HTMLElement | null) => Array<{ id: string; label: string; onSelect(): void }>; slotAddEntries?: (insert: (block: { type: string }) => void) => Array<{ id: string; label: string; onSelect(): void }> }) => <div data-testid="native-document">{page.blocks.map((block, index) => <React.Fragment key={index}>{renderComponent?.(block as PageBlock)}</React.Fragment>)}{renderComponent?.({ id: 'component-block', rev: 1, type: 'component', componentId: 'component-1', props: {} })}{renderDatabaseRef?.({ id: 'database-block', rev: 1, type: 'database-ref', databaseId: 'database-1' })}{addEntries?.('', null).map(entry => <button key={entry.id} type="button" onClick={entry.onSelect}>{entry.label}</button>)}{slotAddEntries?.(mocks.slotInsert).map(entry => <button key={`slot-${entry.id}`} type="button" onClick={entry.onSelect}>{`Slot ${entry.label}`}</button>)}</div> }));
vi.mock('./NativeDatabase', () => ({ default: ({ onAskDraft }: { onAskDraft?: (text: string) => void }) => <button type="button" onClick={() => onAskDraft?.('Summarize this database')}>Ask database</button> }));
vi.mock('./components/CustomBlock', () => ({ CustomBlock: ({ block, onAskDraft }: { block: { componentId: string }; onAskDraft?(text: string): void }) => <div><div data-testid="custom-block">{block.componentId}</div><button type="button" onClick={() => onAskDraft?.('Summarize this component')}>Ask component</button></div> }));
vi.mock('./components/ComponentLibrary', () => ({ ComponentLibrary: ({ workspaceId, connectionId, onInsert }: { workspaceId: string; connectionId: string; onInsert(component: { id: string; enabled: boolean }, version: number): void }) => <div aria-label="Mock component library" data-workspace={workspaceId} data-connection={connectionId}><button type="button" onClick={() => onInsert({ id: 'component-1', enabled: true }, 3)}>Insert enabled component v3</button></div> }));
vi.mock('./MaintenanceStatus', () => ({ MaintenanceStatus: () => null }));
vi.mock('./conversation/SpaceConversationSlot', () => ({ NewChatSheetSlot: () => null, PageProgressCards: () => null }));

import { SpaceView } from './SpaceView';

describe('SpaceView components', () => {
  afterEach(() => {
    pendingPageHelperDrafts({ backendConnectionId: 'backend-1', workspaceId: 'workspace-1', pageId: 'page-1' })
      .forEach((request) => request.requestId !== undefined && consumePageHelperDraft(request.requestId));
  });

  beforeEach(() => {
    mocks.edit.mockReset().mockResolvedValue(undefined);
    mocks.openTasks.mockReset().mockResolvedValue({ database: { id: 'db-tasks' }, created: true });
    mocks.slotInsert.mockReset();
    mocks.layoutRules.mockReset().mockResolvedValue([{ id: 'rule-1', text: 'Progress: at most 3 items', createdBy: 'agent', createdAt: 1, sourceMessage: null }]);
    mocks.readComponent.mockReset().mockResolvedValue({ component: { id: 'component-1', enabled: true }, version: { version: 3, propsSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 3, maxLength: 8 } } } } });
    vi.spyOn(window, 'prompt').mockReturnValueOnce('{"title":"demo"}').mockReturnValueOnce('320');
  });

  it('opens the workspace component library and inserts the chosen enabled version as a bounded native block', async () => {
    render(<SpaceView route={{ type: 'space', pageId: 'page-1', workspaceId: 'workspace-1', backendConnectionId: 'backend-1' }} onBack={vi.fn()} onOpenPage={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Components/ }));
    const library = screen.getByLabelText('Mock component library');
    expect(library.getAttribute('data-workspace')).toBe('workspace-1');
    expect(library.getAttribute('data-connection')).toBe('backend-1');
    expect(screen.getByTestId('custom-block').textContent).toBe('component-1');
    fireEvent.click(screen.getByRole('button', { name: 'Insert enabled component v3' }));
    await waitFor(() => expect(mocks.readComponent).toHaveBeenCalledWith('component-1', 'workspace-1', 'backend-1', 3));
    await waitFor(() => expect(mocks.edit).toHaveBeenCalledWith([{
      op: 'insert', after: 'md-1', block: { type: 'component', componentId: 'component-1', pinnedVersion: 3, props: { title: 'demo' }, height: 320 },
    }]));
  });

  it('lists the page\'s layout rules from the Page actions menu', async () => {
    render(<SpaceView route={{ type: 'space', pageId: 'page-1', workspaceId: 'workspace-1', backendConnectionId: 'backend-1' }} onBack={vi.fn()} onOpenPage={vi.fn()} />);
    await waitFor(() => expect(mocks.layoutRules).toHaveBeenCalledWith('page-1', 'backend-1', expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /Layout preferences/ }).textContent).toContain('1'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Layout preferences/ }));
    expect(screen.getByRole('dialog', { name: 'Layout preferences' }).textContent).toContain('Progress: at most 3 items');
  });

  it('offers Add component from the native page insertion menu and keeps the top insertion anchor', async () => {
    render(<SpaceView route={{ type: 'space', pageId: 'page-1', workspaceId: 'workspace-1', backendConnectionId: 'backend-1' }} onBack={vi.fn()} onOpenPage={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add component' }));
    expect(screen.getByLabelText('Mock component library')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Insert enabled component v3' }));
    await waitFor(() => expect(mocks.edit).toHaveBeenCalledWith([{
      op: 'insert', after: null, block: { type: 'component', componentId: 'component-1', pinnedVersion: 3, props: { title: 'demo' }, height: 320 },
    }]));
  });

  it('prefills the page helper from component asks without sending immediately', () => {
    const onDraft = (event: Event) => expect((event as CustomEvent).detail).toMatchObject({
      backendConnectionId: 'backend-1', workspaceId: 'workspace-1', pageId: 'page-1',
      text: 'Summarize this component', blockContext: { blockId: 'component-block', title: 'Component component-1' },
    });
    window.addEventListener('michi:page-helper-draft', onDraft);
    render(<SpaceView route={{ type: 'space', pageId: 'page-1', workspaceId: 'workspace-1', backendConnectionId: 'backend-1' }} onBack={vi.fn()} onOpenPage={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask component' }));
    window.removeEventListener('michi:page-helper-draft', onDraft);
  });

  it('queues a database ask for the assistant window with the block attached', () => {
    render(<SpaceView route={{ type: 'space', pageId: 'page-1', workspaceId: 'workspace-1', backendConnectionId: 'backend-1' }} onBack={vi.fn()} onOpenPage={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Show assistant' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ask database' }));
    expect(pendingPageHelperDrafts({ backendConnectionId: 'backend-1', workspaceId: 'workspace-1', pageId: 'page-1' })[0]).toMatchObject({
      text: 'Summarize this database',
      blockContext: { blockId: 'database-block', title: 'Database database-1' },
    });
  });
  it('adds a task board from the page\u2019s + menu, making the workspace\u2019s task database first', async () => {
    render(<SpaceView route={{ type: 'space', pageId: 'page-1', workspaceId: 'workspace-1', backendConnectionId: 'backend-1' }} onBack={vi.fn()} onOpenPage={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Task board' }));
    await waitFor(() => expect(mocks.edit).toHaveBeenCalledWith([{ op: 'insert', block: { type: 'task-view' }, after: null }]));
    expect(mocks.openTasks).toHaveBeenCalledWith({ backendConnectionId: 'backend-1', workspaceId: 'workspace-1' });
  });

  it('adds a task board at the foot of a container\u2019s section too', async () => {
    render(<SpaceView route={{ type: 'space', pageId: 'page-1', workspaceId: 'workspace-1', backendConnectionId: 'backend-1' }} onBack={vi.fn()} onOpenPage={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Slot Task board' }));
    await waitFor(() => expect(mocks.slotInsert).toHaveBeenCalledWith({ type: 'task-view' }));
    expect(mocks.edit).not.toHaveBeenCalled();
  });

  it('says why a task board could not be added, and adds none', async () => {
    mocks.openTasks.mockRejectedValue(new Error('Workspace is archived'));
    render(<SpaceView route={{ type: 'space', pageId: 'page-1', workspaceId: 'workspace-1', backendConnectionId: 'backend-1' }} onBack={vi.fn()} onOpenPage={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Task board' }));
    expect(await screen.findByText('Workspace is archived')).toBeTruthy();
    expect(mocks.edit).not.toHaveBeenCalled();
  });
});
