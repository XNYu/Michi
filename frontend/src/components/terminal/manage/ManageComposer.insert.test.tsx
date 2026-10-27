import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TiptapEditorHTMLElement } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import ManageComposer, { __resetManageComposerSessionStateForTests, type ManageComposerHandle } from './ManageComposer';
import { docToDraft, draftToDoc } from '../../mentionDoc';
import type { MentionRecord } from '../../mentions';

vi.mock('../../../state/prefs', async () => {
  const actual = await vi.importActual<typeof import('../../../state/prefs')>('../../../state/prefs');
  return { ...actual, usePrefs: () => ({ prefs: actual.DEFAULT_PREFS }) };
});

// The real TipTap composer: an insert must go through the same document and
// draft the user types into.
const createThread = vi.fn(async () => 'new-node-id');
const createChildChat = vi.fn(async () => 'child-node-id');
const sendMessage = vi.fn();
const storeState: Record<string, unknown> = {
  createThread, createChildChat, sendMessage, selectProject: vi.fn(), agentStatus: null, refreshAgentStatus: vi.fn(),
  availableModes: [], defaultModeId: null, projects: [],
};
vi.mock('../../../state/chatStore', () => ({
  useChatStore: () => storeState,
  useStructuralSelector: () => [],
  shallowArrayEqual: Object.is,
  chatLabel: () => 'New thread',
}));
vi.mock('../../../services/api', () => ({
  listPrimaryAgentDefinitions: vi.fn(async () => []),
  bindPendingPrimaryAgent: vi.fn(),
  fetchRuntimeCatalog: vi.fn(async () => ({ models: [], providers: [], capabilities: null })),
  saveAgentOptions: vi.fn(async () => ({})),
  getWebUploadCwd: vi.fn(async () => '/tmp'),
  importWorkspaceFileUpload: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const editorOf = () => (document.querySelector('.ProseMirror') as TiptapEditorHTMLElement).editor!;
const draft = () => docToDraft(editorOf().getJSON() as Parameters<typeof docToDraft>[0]);
const caretAtEnd = () => {
  const { selection, doc } = editorOf().state;
  return selection.empty && selection.from === TextSelection.atEnd(doc).from;
};
const focused = () => editorOf().view.dom.contains(document.activeElement);

async function mount(props: Partial<React.ComponentProps<typeof ManageComposer>> = {}) {
  const ref = React.createRef<ManageComposerHandle>();
  const onSubmitted = vi.fn();
  const view = render(<ManageComposer ref={ref} workspaceId="ws1" onSubmitted={onSubmitted} {...props} />);
  await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy());
  await act(async () => {});
  return { ref, onSubmitted, view };
}

function type(value: string, mentions: MentionRecord[] = []) {
  act(() => { editorOf().commands.setContent(draftToDoc(value, mentions)); });
}

beforeEach(() => {
  __resetManageComposerSessionStateForTests();
  createThread.mockClear();
  createChildChat.mockClear();
  sendMessage.mockClear();
  storeState.projects = [{ id: 'ws1', name: 'Workspace', cwd: '/tmp', artifacts: [] }];
});
afterEach(() => cleanup());

describe('ManageComposer insert', () => {
  it('puts the text into an empty composer, focused with the caret after it, and sends nothing', async () => {
    const { ref, onSubmitted } = await mount();
    act(() => { ref.current!.insert('接着跑完两个用例。'); });
    expect(draft()).toEqual({ value: '接着跑完两个用例。', mentions: [] });
    await waitFor(() => expect(focused()).toBe(true));
    expect(caretAtEnd()).toBe(true);
    expect(createThread).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('keeps what the user wrote, mentions included, and adds the text on the next line', async () => {
    const { ref } = await mount();
    const mention: MentionRecord = { start: 4, end: 10, kind: 'node', refId: 'n1', label: 'Pages' };
    type('Ask @Pages now', [mention]);
    act(() => { ref.current!.insert('Prompt'); });
    act(() => { ref.current!.insert('Recap today'); });
    expect(draft()).toEqual({ value: 'Ask @Pages now\nPrompt\nRecap today', mentions: [mention] });
    expect(caretAtEnd()).toBe(true);
    expect(createThread).not.toHaveBeenCalled();
  });

  it('leaves the draft alone for empty text but still focuses the composer', async () => {
    const { ref } = await mount();
    type('mine');
    act(() => { ref.current!.insert('   '); });
    expect(draft().value).toBe('mine');
    await waitFor(() => expect(focused()).toBe(true));
  });

  it('is the draft the user sends and keeps across a remount, like typed text', async () => {
    const first = await mount();
    act(() => { first.ref.current!.insert('Plan tomorrow'); });
    first.view.unmount();
    const second = await mount();
    expect(draft().value).toBe('Plan tomorrow');
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(sendMessage.mock.calls[0]!.slice(0, 2)).toEqual(['new-node-id', 'Plan tomorrow']);
    await waitFor(() => expect(second.onSubmitted).toHaveBeenCalledOnce());
  });

  it('types @ at the end to open the mention picker', async () => {
    const { ref } = await mount();
    type('Look at');
    act(() => { ref.current!.startMention(); });
    expect(draft().value).toBe('Look at @');
    expect(caretAtEnd()).toBe(true);
  });

  it('works the same in a digest follow-up composer', async () => {
    const { ref } = await mount({ parentNodeId: 'digest-1' });
    type('Explain this');
    act(() => { ref.current!.insert('Shorter, please'); });
    expect(draft().value).toBe('Explain this\nShorter, please');
    expect(createChildChat).not.toHaveBeenCalled();
  });
});
