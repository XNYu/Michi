import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAssistantStoreForTests } from '../../../state/assistant/assistantStore';
import { getAssistantComposer, resetAssistantComposerForTests } from '../../../state/assistant/assistantComposer';
import { metaAgentTurnContextFor } from '../../../services/api/assistant';
import { useMetaChatWindow } from '../../../state/metaChat/useMetaChatWindow';
import { SpacesMetaChat } from './metaChat/SpacesMetaChat';
import { SpaceView } from './SpaceView';

vi.mock('../../MentionEditor', () => import('../../../test/mentionEditorStub'));
vi.mock('../TPane', () => import('../../../test/assistantPaneStub'));
vi.mock('../../../state/chatStore', () => ({
  useChatActions: () => ({ openPagePane: vi.fn(), revealBackendNode: vi.fn() }),
  useChatNodesSnapshot: () => ({}),
  useChatProjects: () => ({ projects: [{ id: 'workspace-1', name: 'Workspace' }], agentStatus: null }),
  useStructuralSelector: (selector: (nodes: Record<string, unknown>) => unknown) => selector({}),
}));
vi.mock('../../../state/assistant/useAssistantNode', () => ({ useAssistantNode: () => ({ state: 'ready', retry: vi.fn() }) }));
vi.mock('../../../state/pages/useSpaceTree', () => ({ useSpaceTree: () => ({ pages: [{ id: 'page-1', workspaceId: 'workspace-1', parentId: null, position: 0, title: 'Release' }], status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../../state/pages/usePage', () => ({ usePage: () => ({
  page: {
    id: 'page-1', workspaceId: 'workspace-1', parentId: null, position: 0, title: 'Release', color: null, updatedAt: 1, updatedBy: 'user', pendingProposals: 0, helperNodeId: null, revision: 1, viewVersion: 1,
    blocks: [
      { id: 'next', rev: 1, type: 'checklist', title: 'Next steps', items: [{ id: 'i1', text: 'Ship it', done: false }] },
      { id: 'notes', rev: 1, type: 'markdown', text: 'Plain notes' },
      { id: 'db', rev: 1, type: 'database-ref', databaseId: 'database-1' },
    ],
  },
  changes: [], status: 'ready', error: null, stale: false, refresh: vi.fn(), edit: vi.fn(), accept: vi.fn(), dismiss: vi.fn(), reopen: vi.fn(), revert: vi.fn(), redo: vi.fn(), revertBatch: vi.fn(),
}) }));
vi.mock('../../../state/pages/useSpaces', () => ({ useSpaces: () => ({ spaces: [], status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../../state/pages/revealSource', () => ({ revealPageSource: vi.fn() }));
vi.mock('../../../state/pages/pageEvents', () => ({ notifyPageChanged: vi.fn() }));
vi.mock('../../../services/api/pages', () => ({
  createWorkspaceDatabase: vi.fn(), listWorkspaceDatabases: vi.fn(), createPage: vi.fn(), deletePage: vi.fn(), fetchPage: vi.fn(), patchPage: vi.fn(),
}));
vi.mock('./NativeDatabase', () => ({ default: ({ onAskDraft, compact }: { onAskDraft?: (text: string) => void; compact?: boolean }) => <button type="button" data-compact={compact ? '' : undefined} onClick={() => onAskDraft?.('Summarize this database')}>Ask database</button> }));
vi.mock('./MaintenanceStatus', () => ({ MaintenanceStatus: () => null }));
vi.mock('./conversation/SpaceConversationSlot', () => ({ NewChatSheetSlot: () => null, PageProgressCards: () => null }));

const route = { type: 'space' as const, pageId: 'page-1', workspaceId: 'workspace-1', backendConnectionId: 'local' };

function Harness() {
  const chat = useMetaChatWindow({ storage: null });
  return (
    <SpacesMetaChat controller={chat} active view={{ kind: 'page', backendConnectionId: 'local', workspaceId: 'workspace-1', pageId: 'page-1' }}>
      <SpaceView route={route} onBack={vi.fn()} onOpenPage={vi.fn()} />
    </SpacesMetaChat>
  );
}

const block = (id: string) => document.querySelector<HTMLElement>(`.michi-doc-block[data-block-id="${id}"]`)!;
const chip = () => document.querySelector<HTMLElement>('.meta-chat-panel__target');

describe('Block targeting in Spaces', () => {
  beforeEach(() => {
    resetAssistantStoreForTests({ status: 'ready', info: { nodeId: 'assistant-node', workspaceId: 'system', treeId: 't', settings: { runtimeId: 'claude', modelId: null, reasoning: null }, supportedRuntimes: ['claude'] } });
    resetAssistantComposerForTests();
  });
  afterEach(cleanup);

  it('outlines a clicked block, shows the target chip and clears on a second click or ×', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Plain notes'));
    expect(block('notes').dataset.selected).toBe('true');
    expect(chip()?.textContent).toContain('Targeting: Page section');

    fireEvent.click(screen.getByText('Plain notes'));
    expect(block('notes').dataset.selected).toBeUndefined();
    expect(chip()).toBeNull();

    fireEvent.click(screen.getByText('Ship it'));
    expect(block('next').dataset.selected).toBe('true');
    expect(chip()?.textContent).toContain('Targeting: Next steps');
    fireEvent.click(chip()!.querySelector('button')!);
    expect(block('next').dataset.selected).toBeUndefined();
    expect(chip()).toBeNull();
  });

  it('Ask assistant targets the block and focuses the window input; a send carries the block in its context', async () => {
    render(<Harness />);
    await screen.findByLabelText('Message the assistant');
    const ask = block('next').querySelector<HTMLButtonElement>('[aria-label="Ask assistant"]')!;
    expect(ask.getAttribute('aria-label')).toBe('Ask assistant');
    fireEvent.click(ask);
    expect(chip()?.textContent).toContain('Targeting: Next steps');
    const input = screen.getByLabelText('Message the assistant') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: 'Trim this to one step' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const composer = getAssistantComposer('assistant-node');
    expect(composer.sends.map((send) => send.prompt)).toEqual(['Trim this to one step']);
    expect(composer.attachments).toEqual([]);
    expect(metaAgentTurnContextFor('assistant-node')).toMatchObject({ pageId: 'page-1', blockId: 'next' });
  });

  it('Ask on one checklist item targets that item, without toggling the block; a send names the item', async () => {
    render(<Harness />);
    await screen.findByLabelText('Message the assistant');
    fireEvent.click(screen.getByRole('button', { name: 'Ask assistant about “Ship it”' }));
    expect(chip()?.textContent).toContain('Targeting: Ship it');
    expect(block('next').dataset.selected).toBe('true');
    const input = screen.getByLabelText('Message the assistant') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole('checkbox', { name: 'Ship it' }).getAttribute('aria-checked')).toBe('false');

    fireEvent.change(input, { target: { value: 'What is left before shipping?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(metaAgentTurnContextFor('assistant-node')).toMatchObject({ pageId: 'page-1', blockId: 'next', blockItem: { index: 0, text: 'Ship it' } });

    // Clicking the block afterwards targets the whole block again.
    fireEvent.click(chip()!.querySelector('button')!);
    fireEvent.click(screen.getByText('Ship it'));
    expect(chip()?.textContent).toContain('Targeting: Next steps');
    expect(metaAgentTurnContextFor('assistant-node')).not.toHaveProperty('blockItem');
  });

  it('lays a database out narrow while the window is docked, and keeps blocks selectable', () => {
    render(<Harness />);
    const database = () => screen.getByRole('button', { name: 'Ask database' });
    expect(database().hasAttribute('data-compact')).toBe(false);
    fireEvent.click(screen.getByLabelText('Dock as half screen'));
    expect(database().hasAttribute('data-compact')).toBe(true);
    fireEvent.click(screen.getByText('Plain notes'));
    expect(block('notes').dataset.selected).toBe('true');
    fireEvent.click(screen.getByLabelText('Back to floating'));
    expect(database().hasAttribute('data-compact')).toBe(false);
  });

  it('puts a database ask into the window input with the block targeted, without sending', async () => {
    render(<Harness />);
    await screen.findByLabelText('Message the assistant');
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Ask database' })); });
    expect((screen.getByLabelText('Message the assistant') as HTMLTextAreaElement).value).toBe('Summarize this database');
    expect(chip()?.textContent).toContain('Targeting: Database database-1');
    expect(getAssistantComposer('assistant-node').sends).toEqual([]);
  });
});
