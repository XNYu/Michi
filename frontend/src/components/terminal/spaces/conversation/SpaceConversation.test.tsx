import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgressCardDto } from 'michi-shared';

const mocks = vi.hoisted(() => ({
  nodes: {} as Record<string, unknown>,
  activeProjectId: 'w2' as string | null,
  revealBackendNode: vi.fn(),
  dismissProgressCard: vi.fn(),
  cards: [] as unknown[],
  refresh: vi.fn(),
}));

vi.mock('../../../MentionEditor', () => import('../../../../test/mentionEditorStub'));
vi.mock('../../../../state/chatStore', () => ({
  useChatProjects: () => ({
    activeProjectId: mocks.activeProjectId,
    agentStatus: { label: 'Kiro', availableRuntimes: [{ id: 'kiro', label: 'Kiro' }] },
    projects: [
      { id: 'w1', name: 'rabbitholes' },
      { id: 'w2', name: 'agent-desk' },
      { id: 'w3', name: 'old', archivedAt: 1 },
      { id: 'sys', name: 'Assistant', system: true, settings: { system: 'assistant' } },
    ],
  }),
  useChatActions: () => ({ revealBackendNode: mocks.revealBackendNode }),
  useNodesSelector: (selector: (nodes: Record<string, unknown>) => unknown) => selector(mocks.nodes),
}));
vi.mock('../../../../state/assistant/systemWorkspace', () => ({ isSystemWorkspace: (project?: { system?: boolean }) => Boolean(project?.system) }));
vi.mock('../../../../services/api/spacesHome', () => ({ dismissProgressCard: mocks.dismissProgressCard }));
vi.mock('../../../../state/pages/useSpacesHome', () => ({
  useProgressCards: () => ({ data: mocks.cards, status: 'ready', error: null, stale: false, refresh: mocks.refresh }),
}));

import { NewChatSheetSlot, PageProgressCards, SpaceConversationSlot, SpaceProgressCardList } from './SpaceConversationSlot';
import { SPACE_CONVERSATION_OPENED_EVENT, type SpaceConversationOpened } from './openConversation';
import { getSourceNavState, registerSourceNavigator, resetSourceNavForTests } from '../../../../state/sourceNav/sourceNav';
import {
  markPendingCreated, openNewChatSheet, readSpaceConversations, requestSpaceConversation, resetSpaceConversationsForTests,
} from '../../../../state/spaceConversations/store';

const pageScope = { backendConnectionId: 'local', pageId: 'p1', workspaceId: 'w1', workspaceName: 'rabbitholes', pageTitle: 'Michi 0.9 发布' };
const homeScope = { backendConnectionId: 'local', pageId: 'home', workspaceId: null, workspaceName: null, pageTitle: 'Home' };

const card = (patch: Partial<ProgressCardDto> = {}): ProgressCardDto => ({
  threadNodeId: 'n1', startedFromPageId: 'p1', workspaceId: 'w1', workspaceName: 'rabbitholes', treeId: 't1',
  title: '把 Intel 机器手测的步骤写出来', runtimeId: 'kiro', status: 'running', summary: null,
  createdAt: Date.now(), seenAt: null, dismissedAt: null, expiresAt: null, ...patch,
});
const streaming = {
  nodeId: 'n1', projectId: 'w1', status: 'streaming', followUps: [],
  messages: [
    { id: 'u', role: 'user', text: '把 Intel 机器手测的步骤写出来', toolCalls: [] },
    { id: 'a', role: 'assistant', text: '', toolCalls: [{ id: 't', title: 'npm test', status: 'in_progress', kind: 'execute' }], blocks: [{ id: 'b', kind: 'answer', rawText: 'SECRET PARTIAL REPLY' }] },
  ],
};

beforeEach(() => {
  resetSpaceConversationsForTests();
  mocks.nodes = {};
  mocks.cards = [];
  mocks.activeProjectId = 'w2';
  mocks.revealBackendNode.mockReset().mockResolvedValue(true);
  mocks.dismissProgressCard.mockReset().mockResolvedValue({});
  mocks.refresh.mockReset();
});

describe('Start a task sheet', () => {
  it('opens on the page in its workspace, with the runtime of the global settings, and starts on Start', async () => {
    render(<NewChatSheetSlot scope={pageScope} />);
    expect(screen.queryByRole('region', { name: 'Start a task' })).toBeNull();
    act(() => { openNewChatSheet(); });
    const sheet = await screen.findByRole('region', { name: 'Start a task' });
    expect(within(sheet).getByRole('button', { name: 'Workspace: rabbitholes' })).toBeTruthy();
    expect(sheet.textContent).toContain('Kiro · your global settings');
    expect(sheet.textContent).toContain('Follow progress here; the full chat and replies are on the chat page');
    const start = within(sheet).getByRole('button', { name: 'Start' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);

    const input = await within(sheet).findByRole('textbox');
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: '  把 Intel 机器手测的步骤写出来 ' } });
    fireEvent.click(start);
    expect(readSpaceConversations().pending).toEqual([expect.objectContaining({
      text: '把 Intel 机器手测的步骤写出来', workspaceId: 'w1', workspaceName: 'rabbitholes', backendConnectionId: 'local', startedFromPageId: 'p1', nodeId: null,
    })]);
    expect(screen.queryByRole('region', { name: 'Start a task' })).toBeNull();
  });

  it('starts in the last workspace on Home, lets you pick another, and sends on Enter', async () => {
    localStorage.setItem('michi:v1:space-new-chat-workspace', 'w2');
    mocks.activeProjectId = 'w1';
    render(<NewChatSheetSlot scope={homeScope} />);
    act(() => { openNewChatSheet(); });
    const sheet = await screen.findByRole('region', { name: 'Start a task' });
    const chip = within(sheet).getByRole('button', { name: 'Workspace: agent-desk' });
    fireEvent.click(chip);
    const menu = screen.getByRole('menu', { name: 'Start the chat in' });
    expect(within(menu).queryByText('old')).toBeNull();
    expect(within(menu).queryByText('Assistant')).toBeNull();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'rabbitholes' }));
    expect(within(sheet).getByRole('button', { name: 'Workspace: rabbitholes' })).toBeTruthy();

    const input = await within(sheet).findByRole('textbox');
    fireEvent.change(input, { target: { value: 'Run the rollback cases' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(readSpaceConversations().pending[0]).toMatchObject({ workspaceId: 'w1', startedFromPageId: 'home' });
  });

  it('takes a next step’s text and closes on Escape or ×', async () => {
    render(<NewChatSheetSlot scope={pageScope} />);
    act(() => { openNewChatSheet({ text: '跑完增量读取的事务回滚、跨工作区移动两个用例' }); });
    const sheet = await screen.findByRole('region', { name: 'Start a task' });
    const input = await within(sheet).findByRole('textbox') as HTMLTextAreaElement;
    expect(input.value).toBe('跑完增量读取的事务回滚、跨工作区移动两个用例');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Start a task' })).toBeNull();
    act(() => { openNewChatSheet(); });
    fireEvent.click(within(await screen.findByRole('region', { name: 'Start a task' })).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Start a task' })).toBeNull();
  });
});

describe('Progress cards', () => {
  it('shows a running conversation’s status but none of its messages', () => {
    mocks.nodes = { n1: streaming };
    render(<SpaceProgressCardList scope={pageScope} cards={[card()]} />);
    const item = screen.getByRole('article', { name: 'Chat: 把 Intel 机器手测的步骤写出来' });
    expect(within(item).getByRole('img', { name: 'Running' })).toBeTruthy();
    expect(item.textContent).toContain('Kiro');
    expect(item.textContent).toContain('rabbitholes · Running tests…');
    expect(item.textContent).toContain('Every step shows on the chat page.');
    expect(item.textContent).not.toContain('SECRET');
    expect(within(item).queryByRole('button', { name: /Continue chatting/ })).toBeNull();
  });

  it('shows what a finished one concluded and Continue chatting', () => {
    render(<SpaceProgressCardList scope={pageScope} cards={[card({ status: 'done', summary: '写好了 Intel 机器手测的 6 步。' })]} />);
    const item = screen.getByRole('article');
    expect(within(item).getByLabelText('Done')).toBeTruthy();
    expect(item.textContent).toContain('写好了 Intel 机器手测的 6 步。');
    expect(item.textContent).toContain('rabbitholes · Done · just now');
    expect(within(item).getByRole('button', { name: /Continue chatting/ })).toBeTruthy();
  });

  it('tells a failed chat from a stopped one, each in its own words and look', () => {
    render(<SpaceProgressCardList scope={pageScope} cards={[
      card({ status: 'failed', summary: 'Starting on it.', error: 'spawn kiro-cli ENOENT' }),
      card({ threadNodeId: 'n2', title: 'Stopped chat', status: 'cancelled', summary: 'Half way' }),
    ]} />);
    const [failed, stopped] = screen.getAllByRole('article');
    expect(failed!.getAttribute('data-status')).toBe('failed');
    expect(within(failed!).getByLabelText('Failed')).toBeTruthy();
    expect(failed!.textContent).toContain('rabbitholes · Failed');
    expect(failed!.textContent).toContain('Stopped with an error: spawn kiro-cli ENOENT');
    expect(failed!.textContent).not.toContain('Starting on it.');
    expect(stopped!.getAttribute('data-status')).toBe('cancelled');
    expect(within(stopped!).getByLabelText('Stopped')).toBeTruthy();
    expect(within(stopped!).queryByLabelText('Failed')).toBeNull();
    expect(stopped!.textContent).toContain('rabbitholes · Stopped');
    expect(stopped!.textContent).toContain('Stopped before it finished.');
  });

  it('says what a waiting chat waits for and opens it at the request', async () => {
    const opened: SpaceConversationOpened[] = [];
    const listen = (event: Event) => opened.push((event as CustomEvent<SpaceConversationOpened>).detail);
    const stop = registerSourceNavigator({ currentOrigin: () => null, reveal: mocks.revealBackendNode, returnTo: vi.fn() });
    window.addEventListener(SPACE_CONVERSATION_OPENED_EVENT, listen);
    // The conversation's pane, as TPane renders its approval banner.
    const pane = document.createElement('div');
    pane.setAttribute('data-node-id', 'n1');
    pane.innerHTML = '<div tabindex="-1" id="banner"><div data-testid="permission-source">Michi tool</div><button>Allow</button></div>';
    document.body.appendChild(pane);
    try {
      render(<SpaceProgressCardList scope={pageScope} cards={[
        card({ statusLine: 'Waiting for your approval…', awaiting: 'approval', awaitingDetail: 'Run npm test' }),
        card({ threadNodeId: 'n2', title: 'Asks', statusLine: 'Waiting for your answer…', awaiting: 'question', awaitingDetail: 'Which branch?' }),
      ]} />);
      const [approval, question] = screen.getAllByRole('article');
      expect(within(approval!).getByLabelText('Waiting for you')).toBeTruthy();
      expect(approval!.textContent).toContain('rabbitholes · Waiting for your approval…');
      expect(approval!.textContent).toContain('Needs your approval for “Run npm test”');
      expect(question!.textContent).toContain('Asks you: “Which branch?”');
      expect(within(question!).getByRole('button', { name: 'Open chat to answer' })).toBeTruthy();
      fireEvent.click(within(approval!).getByRole('button', { name: 'Open chat to approve' }));
      await waitFor(() => expect(opened).toHaveLength(1));
      expect(opened[0]).toMatchObject({ nodeId: 'n1', continueChat: false });
      expect(getSourceNavState().focus).toBeNull();
      await waitFor(() => expect(document.activeElement?.id).toBe('banner'));
    } finally {
      pane.remove();
      window.removeEventListener(SPACE_CONVERSATION_OPENED_EVENT, listen);
      stop();
      resetSourceNavForTests();
    }
  });

  it('counts a finished card from when it finished, not from when it started', () => {
    const hour = 60 * 60 * 1000;
    render(<SpaceProgressCardList scope={pageScope} cards={[card({ status: 'done', summary: 'ok', createdAt: Date.now() - 3 * hour, finishedAt: Date.now() - 2 * 60_000 })]} />);
    expect(screen.getByRole('article').textContent).toContain('rabbitholes · Done · 2m ago');
  });

  it('shows what a conversation this window did not start is doing, as the backend reads it', () => {
    mocks.nodes = {};
    render(<SpaceProgressCardList scope={pageScope} cards={[card({ title: 'Run the rollback tests', statusLine: 'Waiting for your approval…', awaiting: 'approval' })]} />);
    const item = screen.getByRole('article', { name: 'Chat: Run the rollback tests' });
    expect(item.textContent).toContain('rabbitholes · Waiting for your approval…');
  });

  it('opens the conversation under the Back to the page bar; Continue chatting also asks for its composer', async () => {
    const origin = { kind: 'page' as const, backendConnectionId: 'local', workspaceId: 'w1', pageId: 'p1', title: 'Michi 0.9 发布' };
    const stop = registerSourceNavigator({ currentOrigin: () => origin, reveal: mocks.revealBackendNode, returnTo: vi.fn() });
    const opened: SpaceConversationOpened[] = [];
    const listen = (event: Event) => opened.push((event as CustomEvent<SpaceConversationOpened>).detail);
    window.addEventListener(SPACE_CONVERSATION_OPENED_EVENT, listen);
    try {
      render(<SpaceProgressCardList scope={pageScope} cards={[card({ status: 'done', summary: 'ok' })]} />);
      fireEvent.click(screen.getByRole('button', { name: /Open full chat/ }));
      await waitFor(() => expect(opened).toHaveLength(1));
      expect(mocks.revealBackendNode).toHaveBeenCalledWith('w1', 'n1');
      expect(opened[0]).toMatchObject({ nodeId: 'n1', continueChat: false, from: pageScope });
      expect(getSourceNavState().back?.origin).toEqual(origin);
      expect(getSourceNavState().focus).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: /Continue chatting/ }));
      await waitFor(() => expect(opened).toHaveLength(2));
      expect(opened[1]).toMatchObject({ continueChat: true });
      expect(getSourceNavState().focus).toMatchObject({ nodeId: 'n1' });
      expect(getSourceNavState().back?.origin).toEqual(origin);
    } finally {
      window.removeEventListener(SPACE_CONVERSATION_OPENED_EVENT, listen);
      stop();
      resetSourceNavForTests();
    }
  });

  it('goes on ×, and once 24 hours have passed since it was seen', async () => {
    const onChanged = vi.fn();
    render(<SpaceProgressCardList scope={pageScope} onChanged={onChanged} cards={[
      card({ status: 'done', summary: 'one' }),
      card({ threadNodeId: 'n2', status: 'done', summary: 'two', seenAt: Date.now() - 25 * 3600_000, expiresAt: Date.now() - 3600_000 }),
    ]} />);
    expect(screen.getAllByRole('article')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));
    // Folding away it is already out of reach; then the list lets it go.
    expect(screen.queryByRole('article')).toBeNull();
    await waitFor(() => expect(mocks.dismissProgressCard).toHaveBeenCalledWith('n1', 'local'));
    await waitFor(() => expect(document.querySelector('.space-live-card')).toBeNull());
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('shows a card that arrives while the last one folds away', async () => {
    const view = render(<SpaceProgressCardList scope={pageScope} cards={[card({ status: 'done', summary: 'one' })]} />);
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));
    expect(screen.queryByRole('article')).toBeNull();
    view.rerender(<SpaceProgressCardList scope={pageScope} cards={[
      card({ status: 'done', summary: 'one' }),
      card({ threadNodeId: 'n3', title: 'Next one', status: 'done', summary: 'three' }),
    ]} />);
    // The list it lands in is back in reach, and stays drawn once the old card has gone.
    expect(screen.getByRole('article', { name: 'Chat: Next one' })).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll('.space-live-card')).toHaveLength(1));
    const list = document.querySelector('.space-live-cards') as HTMLElement;
    expect(list.getAttribute('aria-hidden')).toBeNull();
    expect(list.style.opacity).not.toBe('0');
    expect(screen.getByRole('article', { name: 'Chat: Next one' })).toBeTruthy();
  });

  it('shows a start right away, before the backend lists its card, on its page and on Home', () => {
    mocks.nodes = { 'n-new': { ...streaming, nodeId: 'n-new', title: undefined } };
    const id = requestSpaceConversation({ text: 'q', workspaceId: 'w1', workspaceName: 'rabbitholes', backendConnectionId: 'local', startedFromPageId: 'p1' });
    markPendingCreated(id, 'n-new');
    mocks.cards = [card({ threadNodeId: 'other', startedFromPageId: 'p2', status: 'done', summary: 'elsewhere' })];
    const { unmount } = render(<PageProgressCards scope={pageScope} />);
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByRole('article').textContent).toContain('Running tests…');
    expect(screen.queryByRole('button', { name: /Dismiss/ })).toBeNull();
    unmount();
    render(<SpaceConversationSlot scope={homeScope} cards={mocks.cards as ProgressCardDto[]} />);
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });
});
