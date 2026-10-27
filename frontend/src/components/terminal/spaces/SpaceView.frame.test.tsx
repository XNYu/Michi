import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageChangeDto, SpaceSummaryDto } from 'michi-shared';

const NOW = Date.now();
const MIN = 60_000;
const state = vi.hoisted(() => ({
  spaces: [] as unknown[],
  tree: [] as unknown[],
  changes: [] as unknown[],
  databaseProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../state/chatStore', () => ({
  useChatActions: () => ({ openPagePane: vi.fn(), revealBackendNode: vi.fn() }),
  useChatNodesSnapshot: () => ({}),
  useChatProjects: () => ({ projects: [{ id: 'workspace-1', name: 'rabbitholes' }] }),
}));
vi.mock('../../../state/pages/useSpaces', () => ({ useSpaces: () => ({ spaces: state.spaces, status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../../state/pages/useSpaceTree', () => ({ useSpaceTree: () => ({ pages: state.tree, status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../../state/pages/usePage', () => ({ usePage: () => ({
  page: {
    id: 'page-1', workspaceId: 'workspace-1', parentId: null, position: 0, title: 'Michi 0.9', color: null, updatedAt: NOW - 5 * MIN, updatedBy: 'agent',
    pendingProposals: 0, helperNodeId: null, revision: 3, viewVersion: 1,
    blocks: [
      { id: 'blank', rev: 1, type: 'markdown', text: '' },
      { id: 'goal', rev: 2, type: 'markdown', text: '#### Goal\n\nShip the preview.', edit: { at: NOW - 60 * MIN } },
      { id: 'progress', rev: 4, type: 'callout', title: 'Progress', text: '8 of 12 done.', sources: [{ nodeId: 'n-chat', turnId: 't1', assistantId: 'a1' }] },
      { id: 'db', rev: 1, type: 'database-ref', databaseId: 'database-1', viewId: 'view-board' },
    ],
  },
  changes: state.changes, lastSeenChangeSeq: 0, status: 'ready', error: null, stale: false,
  refresh: vi.fn(), edit: vi.fn(), accept: vi.fn(), dismiss: vi.fn(), reopen: vi.fn(), revert: vi.fn(), redo: vi.fn(), revertBatch: vi.fn(),
}) }));
vi.mock('../../../state/pages/revealSource', () => ({ revealPageSource: vi.fn() }));
vi.mock('../../../state/pages/pageEvents', () => ({ notifyPageChanged: vi.fn() }));
vi.mock('../../../services/api/pages', () => ({
  createWorkspaceDatabase: vi.fn(), listWorkspaceDatabases: vi.fn(), createPage: vi.fn(), deletePage: vi.fn(), fetchPage: vi.fn(), patchPage: vi.fn(),
}));
vi.mock('../../../services/api/spacesHome', () => ({ fetchLayoutRules: vi.fn().mockResolvedValue([]), deleteLayoutRule: vi.fn() }));
vi.mock('./NativeDatabase', () => ({ default: (props: Record<string, unknown>) => { state.databaseProps.push(props); return <div data-testid="database" />; } }));
vi.mock('./MaintenanceStatus', () => ({ MaintenanceStatus: () => null }));
vi.mock('./conversation/SpaceConversationSlot', () => ({ NewChatSheetSlot: () => null, PageProgressCards: () => null }));

import { SpaceView, spaceCaption, spaceMetaLine } from './SpaceView';

const route = { type: 'space' as const, pageId: 'page-1', workspaceId: 'workspace-1', backendConnectionId: 'local' };
const summary = (extra: Partial<SpaceSummaryDto>): SpaceSummaryDto => ({
  id: 'page-1', workspaceId: 'workspace-1', parentId: null, position: 0, title: 'Michi 0.9', color: null, updatedAt: NOW, updatedBy: 'agent', pendingProposals: 0,
  helperNodeId: null, workspaceName: 'rabbitholes', childTitles: [], pageCount: 1, databaseCount: 1, contributorNodeIds: ['n-chat', 'n-other'], ...extra,
});
const agentChange = (): PageChangeDto => ({
  id: 'change-1', seq: 5, batchId: 'batch-1', target: { kind: 'block', pageId: 'page-1', blockId: 'progress' }, op: 'update', before: null, after: null,
  forward: { kind: 'block', op: 'delete', id: 'progress', expectedLocation: { parentId: null, slot: null, previousId: null, nextId: null } },
  inverse: { kind: 'block', op: 'delete', id: 'progress', expectedLocation: { parentId: null, slot: null, previousId: null, nextId: null } },
  baseRev: 3, appliedRev: 4, previousHeadId: null, source: { kind: 'chat', nodeId: 'n-chat', turnId: 't1', assistantId: 'a1' },
  proposalState: null, applicationState: 'applied', createdAt: NOW - 5 * MIN, resolvedAt: null,
});
const show = () => render(<SpaceView route={route} onBack={vi.fn()} onOpenPage={vi.fn()} />);

describe('A Space page laid out like the workspace homes', () => {
  afterEach(() => {
    cleanup();
    state.spaces = []; state.tree = []; state.changes = []; state.databaseProps = [];
  });

  it('renders in the homes\' borderless column with no outline card beside it', () => {
    state.tree = [{ id: 'page-1', workspaceId: 'workspace-1', parentId: null, position: 0, title: 'Michi 0.9' }];
    show();
    const main = screen.getByRole('main', { name: 'Michi 0.9' });
    expect(main.className).toContain('area-settings');
    expect(main.className).toContain('spaces-home');
    expect(main.querySelector('.area-settings__doc.spaces-home__doc')).toBeTruthy();
    expect(main.querySelector('.branches-document')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Page outline' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show pages' })).toBeNull();
  });

  it('marks a blank page\'s empty first block so the page can leave it out of its flow', () => {
    show();
    const block = (id: string) => document.querySelector<HTMLElement>(`.michi-doc-block[data-block-id="${id}"]`)!;
    expect(block('blank').dataset.empty).toBe('true');
    expect(block('goal').dataset.empty).toBeUndefined();
  });

  it('keeps the outline behind the page menu', () => {
    state.tree = [{ id: 'page-1', workspaceId: 'workspace-1', parentId: null, position: 0, title: 'Michi 0.9' }];
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Page outline/ }));
    expect(screen.getByRole('navigation', { name: 'Page outline' })).toBeTruthy();
  });

  it('says who made the Space and reads the line under the title like the mock', () => {
    state.spaces = [summary({ createdBy: 'meta-agent' })];
    state.tree = [
      { id: 'page-1', workspaceId: 'workspace-1', parentId: null, position: 0, title: 'Michi 0.9' },
      { id: 'child-1', workspaceId: 'workspace-1', parentId: 'page-1', position: 0, title: 'Notes' },
      { id: 'child-2', workspaceId: 'workspace-1', parentId: 'page-1', position: 1, title: 'Risks' },
    ];
    show();
    expect(screen.getByText('Page · rabbitholes · created by the Meta agent')).toBeTruthy();
    expect(document.querySelector('.space-doc__source')?.textContent).toBe('2 pages inside · 2 conversations wrote here · updated 5m ago');
  });

  it('leaves the page count out when there is no page inside, and words the creator for a person or a conversation', () => {
    expect(spaceCaption('个人', 'user')).toBe('Page · 个人 · created by you');
    expect(spaceCaption('个人', 'agent')).toBe('Page · 个人 · created by an agent');
    expect(spaceCaption('个人', undefined)).toBe('Page · 个人');
    expect(spaceMetaLine({ pagesInside: 0, parentTitle: null, conversations: 1, updatedAt: NOW - 50 * MIN, state: null, now: NOW })).toBe('1 conversation wrote here · updated 50m ago');
    expect(spaceMetaLine({ pagesInside: 0, parentTitle: null, conversations: 0, updatedAt: NOW, state: null, now: NOW })).toBe('Updated just now');
    expect(spaceMetaLine({ pagesInside: null, parentTitle: 'Release', conversations: null, updatedAt: NOW, state: 'saving…', now: NOW })).toBe('In Release · updated just now · saving…');
  });

  it('keeps source in the block toolbar and undo in Activity without repeating metadata under the block', () => {
    state.changes = [agentChange()];
    show();
    expect(screen.queryByRole('region', { name: 'Since you left' })).toBeNull();
    const progress = document.querySelector<HTMLElement>('.michi-doc-block[data-block-id="progress"]')!;
    expect(within(progress).queryByLabelText('Changes to this block')).toBeNull();
    expect((within(progress).getByRole('button', { name: 'Sources' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Activity/ }));
    expect(within(screen.getByRole('region', { name: 'Activity' })).getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('keeps agent labels off the page while preserving the person\'s edit mark', () => {
    show();
    const block = (id: string) => document.querySelector<HTMLElement>(`.michi-doc-block[data-block-id="${id}"]`)!;
    expect(block('progress').querySelector('.spaces-home-tag')).toBeNull();
    expect(block('goal').querySelector('.spaces-home-tag')).toBeNull();
  });

  it('keeps an accepted suggestion reversible without a repeated update label', () => {
    state.changes = [{ ...agentChange(), target: { kind: 'block', pageId: 'page-1', blockId: 'goal' }, proposalState: 'accepted', resolvedAt: NOW }];
    show();
    const goal = document.querySelector<HTMLElement>('.michi-doc-block[data-block-id="goal"]')!;
    expect(goal.querySelector('.page-change-targets')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Activity/ }));
    const activity = screen.getByRole('region', { name: 'Activity' });
    expect(within(activity).getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('shows its databases in the page presentation', () => {
    show();
    expect(state.databaseProps.at(-1)).toMatchObject({ databaseId: 'database-1', presentation: 'page' });
  });
});
