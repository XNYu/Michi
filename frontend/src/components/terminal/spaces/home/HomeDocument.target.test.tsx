import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageDto } from 'michi-shared';
import { resetAssistantStoreForTests } from '../../../../state/assistant/assistantStore';
import { getAssistantComposer, resetAssistantComposerForTests } from '../../../../state/assistant/assistantComposer';
import { metaAgentTurnContextFor } from '../../../../services/api/assistant';
import { useMetaChatWindow } from '../../../../state/metaChat/useMetaChatWindow';
import { SpacesMetaChat } from '../metaChat/SpacesMetaChat';
import { useHomeDocument } from './HomeDocument';

vi.mock('../../../MentionEditor', () => import('../../../../test/mentionEditorStub'));
vi.mock('../../TPane', () => import('../../../../test/assistantPaneStub'));
vi.mock('../../../../state/chatStore', () => ({
  useChatActions: () => ({ openPagePane: vi.fn(), revealBackendNode: vi.fn() }),
  useChatNodesSnapshot: () => ({}),
  useChatProjects: () => ({ projects: [{ id: 'ws-1', name: 'rabbitholes' }], agentStatus: null }),
  useStructuralSelector: (selector: (nodes: Record<string, unknown>) => unknown) => selector({}),
}));
vi.mock('../../../../state/assistant/useAssistantNode', () => ({ useAssistantNode: () => ({ state: 'ready', retry: vi.fn() }) }));
vi.mock('../../../../state/metaAgent/spacesFirstRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../state/metaAgent/spacesFirstRun')>()),
  useSpacesFirstRun: () => ({ load: 'ready', data: null, error: null, unreachable: false, schedulerOff: false, justFinished: false }),
}));

const HOME = vi.hoisted(() => ({
  id: 'wh', workspaceId: 'ws-1', parentId: null, position: 0, title: 'rabbitholes', color: null, updatedAt: 1, updatedBy: 'agent',
  pendingProposals: 0, helperNodeId: null, revision: 1, viewVersion: 1,
  blocks: [
    { id: 'lead', rev: 1, type: 'markdown', text: 'Michi merged into dev.' },
    { id: 'next', rev: 1, type: 'next-steps', title: 'Next steps', items: [{ who: 'user', text: 'Confirm the risk rewrite', unblocks: 'Release notes' }] },
  ],
}) as PageDto);

vi.mock('../../../../state/pages/usePage', () => ({ usePage: () => ({
  page: HOME, changes: [], status: 'ready', error: null, stale: false, lastSeenChangeSeq: 0,
  refresh: vi.fn(), edit: vi.fn(), accept: vi.fn(), dismiss: vi.fn(), reopen: vi.fn(), revert: vi.fn(), redo: vi.fn(), acknowledgeThrough: vi.fn(),
}) }));
vi.mock('../../../../services/api/pages', () => ({ fetchPageActivitySeen: () => Promise.resolve({ lastSeenChangeSeq: 0 }) }));
vi.mock('../SpacesPage', () => ({ openNativePageRoute: vi.fn() }));
vi.mock('../NativeDatabase', () => ({ default: () => null }));

function HomeBlocks() {
  const doc = useHomeDocument({ backendConnectionId: 'local', initial: HOME });
  return <>{doc.renderBlocks(HOME.blocks.slice(0, 1), 'lead')}{doc.renderBlocks(HOME.blocks.slice(1), 'rest')}</>;
}

function Harness() {
  const chat = useMetaChatWindow({ storage: null });
  return (
    <SpacesMetaChat controller={chat} active view={{ kind: 'workspace', workspaceId: 'ws-1', name: 'rabbitholes' }}>
      <HomeBlocks />
    </SpacesMetaChat>
  );
}

const block = (id: string) => document.querySelector<HTMLElement>(`.michi-doc-block[data-block-id="${id}"]`)!;
const chip = () => document.querySelector<HTMLElement>('.meta-chat-panel__target');

describe('Block targeting on a home page', () => {
  beforeEach(() => {
    resetAssistantStoreForTests({ status: 'ready', info: { nodeId: 'assistant-node', workspaceId: 'system', treeId: 't', settings: { runtimeId: 'claude', modelId: null, reasoning: null }, supportedRuntimes: ['claude'] } });
    resetAssistantComposerForTests();
  });
  afterEach(cleanup);

  it('outlines a clicked block in any segment, names it in the window and clears on a second click', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Confirm the risk rewrite'));
    expect(block('next').dataset.selected).toBe('true');
    expect(chip()?.textContent).toContain('Targeting: Next steps');

    fireEvent.click(screen.getByText('Michi merged into dev.'));
    expect(block('lead').dataset.selected).toBe('true');
    expect(block('next').dataset.selected).toBeUndefined();

    fireEvent.click(screen.getByText('Michi merged into dev.'));
    expect(block('lead').dataset.selected).toBeUndefined();
    expect(chip()).toBeNull();
  });

  it('Ask assistant targets the block and a send carries the home page and block', async () => {
    render(<Harness />);
    await screen.findByLabelText('Message the assistant');
    const ask = block('next').querySelector<HTMLButtonElement>('[aria-label="Ask assistant"]')!;
    expect(ask.getAttribute('aria-label')).toBe('Ask assistant');
    fireEvent.click(ask);
    expect(chip()?.textContent).toContain('Targeting: Next steps');
    const input = screen.getByLabelText('Message the assistant') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'Keep one step' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(getAssistantComposer('assistant-node').sends.map((send) => send.prompt)).toEqual(['Keep one step']);
    expect(metaAgentTurnContextFor('assistant-node')).toMatchObject({ pageId: 'wh', blockId: 'next' });
  });

  it('selects nothing outside Spaces, where no window takes the target', () => {
    render(<HomeBlocks />);
    fireEvent.click(screen.getByText('Confirm the risk rewrite'));
    expect(block('next').dataset.selected).toBeUndefined();
    expect(block('next').querySelector('.michi-doc-toolbar__btn')?.textContent).not.toBe('Ask assistant');
  });
});
