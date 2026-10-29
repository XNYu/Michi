import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TiptapEditorHTMLElement } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import type { HomeCardsDto } from 'michi-shared';
import TerminalHome from './Home';
import { __resetManageComposerSessionStateForTests } from '../manage/ManageComposer';
import { __resetHomeCardsCacheForTests } from '../../../state/homeCards/useHomeCards';
import { HOME_STARTERS } from '../home/HomeGreeting';
import { docToDraft, draftToDoc } from '../../mentionDoc';
import type { ChatNodeState, Project } from '../../../state/chatTypes';

vi.mock('../../../state/prefs', async () => {
  const actual = await vi.importActual<typeof import('../../../state/prefs')>('../../../state/prefs');
  return { ...actual, usePrefs: () => ({ prefs: actual.DEFAULT_PREFS }) };
});

// Michi Home with the real shared composer and its TipTap editor.
const store = vi.hoisted(() => ({
  createThread: vi.fn(async () => 'new-node-id'),
  createChildChat: vi.fn(),
  sendMessage: vi.fn(),
  selectProject: vi.fn(),
}));
const projects = [
  { id: 'p1', name: 'rabbitholes', createdAt: 0, activeTreeId: 't1', chatIds: ['a'], edges: [], artifacts: [],
    trees: [{ id: 't1', rootNodeId: 'a', createdAt: 0, lastActiveAt: 10 }] },
] as unknown as Project[];
const nodes = { a: { nodeId: 'a', chatId: null, projectId: 'p1', kind: 'chat', title: 'a', messages: [], followUps: [], status: 'idle' } } as unknown as Record<string, ChatNodeState>;
vi.mock('../../../state/chatStore', async () => ({
  ...(await vi.importActual<object>('../../../state/chatStore')),
  useChatStore: () => ({
    ...store, projects, activeProject: projects[0], activeProjectId: 'p1', hydrated: true,
    agentStatus: null, refreshAgentStatus: vi.fn(), availableModes: [], defaultModeId: null,
  }),
  useStructuralSelector: (selector: (n: Record<string, ChatNodeState>) => unknown) => selector(nodes),
}));
vi.mock('../../../services/api', () => ({
  listPrimaryAgentDefinitions: vi.fn(async () => []),
  bindPendingPrimaryAgent: vi.fn(),
  fetchRuntimeCatalog: vi.fn(async () => ({ models: [], providers: [], capabilities: null })),
  saveAgentOptions: vi.fn(async () => ({})),
  getWebUploadCwd: vi.fn(async () => '/tmp'),
  importWorkspaceFileUpload: vi.fn(),
}));
const cards = vi.hoisted(() => ({ fetchHomeCards: vi.fn(), markHomeCardUsed: vi.fn() }));
vi.mock('../../../services/api/homeCards', async () => ({
  ...(await vi.importActual<object>('../../../services/api/homeCards')),
  fetchHomeCards: cards.fetchHomeCards,
  markHomeCardUsed: cards.markHomeCardUsed,
}));
vi.mock('../HomeWorkspaceChip', () => ({ HomeWorkspaceChip: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const answer: HomeCardsDto = {
  greeting: null, generatedAt: 1, inputFingerprint: 'fp',
  sets: [{ cards: [{ id: 'c1', kind: 'continue', label: '接着做 · rabbitholes', source: { workspaceId: 'p1' }, title: '增量读取停在边界验证',
    reason: '两个用例还没跑。', buttonText: '接着做', prompt: '把事务回滚和跨工作区移动两个用例跑完。', workspaceId: 'p1' }] }],
};

const editorOf = () => (document.querySelector('.ProseMirror') as TiptapEditorHTMLElement).editor!;
const composerText = () => docToDraft(editorOf().getJSON() as Parameters<typeof docToDraft>[0]).value;
const caretAtEnd = () => {
  const { selection, doc } = editorOf().state;
  return selection.empty && selection.from === TextSelection.atEnd(doc).from;
};

async function renderHome() {
  const onSubmitted = vi.fn();
  render(<TerminalHome onSubmitted={onSubmitted} />);
  await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy());
  await screen.findByTestId('home-card');
  await act(async () => {});
  return onSubmitted;
}

beforeEach(() => {
  __resetManageComposerSessionStateForTests();
  for (const fn of Object.values(store)) fn.mockClear();
  cards.fetchHomeCards.mockReset().mockResolvedValue(answer);
  cards.markHomeCardUsed.mockReset().mockResolvedValue(undefined);
  __resetHomeCardsCacheForTests();
});
afterEach(() => cleanup());

describe('Michi Home puts prompts into the shared composer', () => {
  it.each(HOME_STARTERS)('$label fills the editor with an editable prompt without sending', async ({ label, prompt }) => {
    const onSubmitted = await renderHome();
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(composerText()).toBe(prompt);
    await waitFor(() => expect(editorOf().view.dom.contains(document.activeElement)).toBe(true));
    expect(caretAtEnd()).toBe(true);
    act(() => { editorOf().commands.insertContent(' Include a short checklist.'); });
    expect(composerText()).toBe(`${prompt} Include a short checklist.`);
    expect(store.createThread).not.toHaveBeenCalled();
    expect(store.sendMessage).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('a card fills the empty composer, the caret waits after it, and nothing is sent', async () => {
    const onSubmitted = await renderHome();
    fireEvent.click(screen.getByTestId('home-card'));
    expect(composerText()).toBe('把事务回滚和跨工作区移动两个用例跑完。');
    await waitFor(() => expect(editorOf().view.dom.contains(document.activeElement)).toBe(true));
    expect(caretAtEnd()).toBe(true);
    expect(store.createThread).not.toHaveBeenCalled();
    expect(store.sendMessage).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('a card and a quick start go on new lines under what the user wrote', async () => {
    await renderHome();
    act(() => { editorOf().commands.setContent(draftToDoc('my own words', [])); });
    fireEvent.click(screen.getByTestId('home-card'));
    fireEvent.click(screen.getByRole('button', { name: 'Recap today' }));
    expect(composerText()).toBe(`my own words\n把事务回滚和跨工作区移动两个用例跑完。\n${HOME_STARTERS[0]!.prompt}`);
    expect(caretAtEnd()).toBe(true);
    expect(store.sendMessage).not.toHaveBeenCalled();
  });
});
