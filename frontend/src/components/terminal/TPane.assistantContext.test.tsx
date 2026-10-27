/**
 * The ⌘J assistant's attachments and page ride on the pane's next send as
 * its quote (like a Michi handoff), show as chips until then, and an embedded
 * pane (the floating panel) never opens itself in the current pane slot.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  allocateNodeIdsLocal: (() => { let i = 0; return (count = 1) => Array.from({ length: count }, () => `n-asst-${++i}`); })(),
  listAgentModes: () => Promise.resolve({ availableModes: [], defaultModeId: null }),
  fetchAgentStatus: () => Promise.resolve(null),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  warmCwd: () => Promise.resolve({ ok: true }),
  subscribeChat: vi.fn(() => () => {}),
  subscribeChats: vi.fn(() => () => {}),
  subscribeBackground: vi.fn(() => () => {}),
  cancelChatAndObserve: vi.fn(() => () => {}),
  fetchAllWorkspacesMeta: vi.fn(async () => []),
  fetchTreeMessages: vi.fn(async () => []),
  listBackendConnections: async () => [],
  ensureSession: vi.fn(() => Promise.reject(new Error('offline in tests'))),
  streamMessage: vi.fn(() => () => {}),
}));
vi.mock('../../services/notifications', () => ({ notify: vi.fn() }));
const selection = vi.hoisted(() => ({ onBranch: null as null | ((quote: string, prompt: string, anchor?: string) => void) }));
vi.mock('../SelectionActions', () => ({
  default: (props: { onBranch: (quote: string, prompt: string, anchor?: string) => void }) => {
    selection.onBranch = props.onBranch;
    return null;
  },
}));
vi.mock('../MentionEditor', () => ({
  default: React.forwardRef((_props: unknown, _ref: unknown) => <textarea data-testid="composer" />),
}));
vi.mock('./PaneFind', () => ({ default: () => null }));
vi.mock('./PermissionBanner', () => ({ default: () => null }));
vi.mock('../ContextMenu', () => ({ default: () => null }));
vi.mock('../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));

import TPane from './TPane';
import * as api from '../../services/api';
import { ChatProvider, useChatPanes, useChatStore, useChatNodesSnapshot } from '../../state/chatStore';
import { PrefsProvider } from '../../state/prefs';
import {
  addAssistantAttachments,
  getAssistantComposer,
  requestAssistantSend,
  resetAssistantComposerForTests,
  setAssistantPage,
} from '../../state/assistant/assistantComposer';

if (typeof CSS === 'undefined') (globalThis as { CSS?: unknown }).CSS = {};
if (!(CSS as unknown as { highlights?: unknown }).highlights) (CSS as unknown as { highlights: Map<string, unknown> }).highlights = new Map();
if (typeof Element.prototype.scrollTo !== 'function') Element.prototype.scrollTo = () => {};
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

let store: ReturnType<typeof useChatStore>;
let nodes: ReturnType<typeof useChatNodesSnapshot>;
let panes: ReturnType<typeof useChatPanes>;
let embeddedNodeId: string | null = null;
let draftRequestForTest: { id: number; text: string } | null = null;
let onDraftAppliedForTest: ((requestId: number) => void) | undefined;

function Harness() {
  store = useChatStore();
  nodes = useChatNodesSnapshot();
  panes = useChatPanes();
  if (embeddedNodeId) return <TPane nodeId={embeddedNodeId} embedded draftRequest={draftRequestForTest} onDraftRequestApplied={onDraftAppliedForTest} />;
  return panes.focusedPane ? <TPane nodeId={panes.focusedPane} /> : null;
}

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline in tests'))));
});
afterAll(() => {
  vi.unstubAllGlobals();
  resetAssistantComposerForTests();
});
beforeEach(() => {
  draftRequestForTest = null;
  onDraftAppliedForTest = undefined;
});

async function mount() {
  localStorage.clear();
  render(<PrefsProvider><ChatProvider><Harness /></ChatProvider></PrefsProvider>);
  await waitFor(() => expect(store.hydrated).toBe(true));
  await act(async () => { await store.createProject('Work', '/work'); });
  let nodeId: string | null = null;
  act(() => { nodeId = store.createThread(); });
  await waitFor(() => expect(panes.focusedPane).toBe(nodeId));
  return nodeId!;
}

describe('TPane — the assistant context', () => {
  it('sends the chips and page as the quote, shows what the user typed, then clears the chips', async () => {
    embeddedNodeId = null;
    const nodeId = await mount();
    act(() => {
      setAssistantPage(nodeId, { kind: 'home' });
      addAssistantAttachments(nodeId, [{ kind: 'thread', id: 't7', title: 'S7 · move MCP config', text: 'Stalled 4 days' }]);
    });
    expect(await screen.findByText('Thread · S7 · move MCP config')).toBeTruthy();

    act(() => store.setComposerDraft(nodeId, { value: 'What is left?', mentions: [] }));
    const send = await screen.findByRole('button', { name: 'Send (Enter)' });
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);

    await waitFor(() => expect(nodes[nodeId].messages.some((m) => m.role === 'user')).toBe(true));
    const sent = nodes[nodeId].messages.find((m) => m.role === 'user')!;
    expect(sent.text).toBe('What is left?');
    expect(sent.quotedText).toBe('On screen: Home\n- thread: S7 · move MCP config (michi://node/t7) — Stalled 4 days');
    expect(getAssistantComposer(nodeId).attachments).toEqual([]);
    expect(screen.queryByText('Thread · S7 · move MCP config')).toBeNull();
  });

  it('an embedded pane does not open itself as a pane on click', async () => {
    embeddedNodeId = null;
    const nodeId = await mount();
    act(() => { store.closePane(nodeId); });
    await waitFor(() => expect(panes.openPanes).not.toContain(nodeId));
    embeddedNodeId = nodeId;
    act(() => store.setComposerDraft(nodeId, { value: 'x', mentions: [] }));
    const composer = await screen.findByTestId('composer');
    fireEvent.mouseDown(composer);
    expect(panes.openPanes).not.toContain(nodeId);
    expect(panes.focusedPane).not.toBe(nodeId);
    embeddedNodeId = null;
  });

  it('prefills a page helper draft request without sending it', async () => {
    embeddedNodeId = null;
    draftRequestForTest = null;
    onDraftAppliedForTest = undefined;
    const nodeId = await mount();
    act(() => { store.closePane(nodeId); });
    await waitFor(() => expect(panes.openPanes).not.toContain(nodeId));
    embeddedNodeId = nodeId;
    draftRequestForTest = { id: 41, text: 'Please help fix this component.' };
    const applied = vi.fn();
    onDraftAppliedForTest = applied;
    const stream = vi.mocked(api.streamMessage);
    stream.mockClear();
    act(() => { store.setComposerDraft(nodeId, { value: 'existing notes', mentions: [] }); });
    await waitFor(() => expect(nodes[nodeId].composerDraft?.value ?? '').toContain('Please help fix this component.'));
    expect(nodes[nodeId].composerDraft?.value).toContain('existing notes');
    expect(applied).toHaveBeenCalledWith(41);
    expect(stream).not.toHaveBeenCalled();
    expect(nodes[nodeId].messages.some((message) => message.role === 'user' && message.text.includes('Please help fix this component.'))).toBe(false);
    draftRequestForTest = null;
    onDraftAppliedForTest = undefined;
    embeddedNodeId = null;
  });

  it('leaves attach and mention out of the assistant’s composer, keeping them on a worker’s', async () => {
    embeddedNodeId = null;
    const nodeId = await mount();
    expect(await screen.findByTitle('Mention context or node')).toBeTruthy();
    expect(screen.getByText('+')).toBeTruthy();
    act(() => { store.closePane(nodeId); });
    await waitFor(() => expect(panes.openPanes).not.toContain(nodeId));
    embeddedNodeId = nodeId;
    act(() => store.setComposerDraft(nodeId, { value: 'x', mentions: [] }));
    await screen.findByTestId('composer');
    expect(screen.queryByTitle('Mention context or node')).toBeNull();
    expect(screen.queryByTitle(/attach/i)).toBeNull();
    embeddedNodeId = null;
  });

  it('sends a requested prompt through the pane: context framed as attached, then queues behind the answer', async () => {
    embeddedNodeId = null;
    const nodeId = await mount();
    act(() => { store.closePane(nodeId); });
    await waitFor(() => expect(panes.openPanes).not.toContain(nodeId));
    embeddedNodeId = nodeId;
    vi.mocked(api.ensureSession).mockResolvedValue({ chatId: 'c1', currentModeId: null, resumeStrategy: 'fresh' } as never);
    const stream = vi.mocked(api.streamMessage);
    stream.mockClear();
    act(() => store.setComposerDraft(nodeId, { value: 'my own draft', mentions: [] }));
    await screen.findByTestId('composer');
    act(() => {
      setAssistantPage(nodeId, { kind: 'home' });
      requestAssistantSend(nodeId, 'Archive the chat-only ones');
    });
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    const wire = stream.mock.calls[0][1] as string;
    expect(wire).toContain('The user attached the material below in Michi');
    expect(wire).toContain('> On screen: Home');
    expect(wire).toContain("User's reply:\nArchive the chat-only ones");
    const sent = nodes[nodeId].messages.find((m) => m.role === 'user')!;
    expect(sent.text).toBe('Archive the chat-only ones');
    expect(sent.quotedText).toBe('On screen: Home');
    // The user's own draft is left alone.
    expect(nodes[nodeId].composerDraft?.value).toBe('my own draft');
    expect(getAssistantComposer(nodeId).sends).toEqual([]);

    // Mid-answer: a request and a reply to a selection both queue.
    await waitFor(() => expect(nodes[nodeId].status).toBe('streaming'));
    act(() => { requestAssistantSend(nodeId, 'and then?'); });
    await waitFor(() => expect(nodes[nodeId].pendingQueued?.map((q) => q.value)).toEqual(['and then?']));
    act(() => { selection.onBranch?.('the third one', 'why this?'); });
    await waitFor(() => expect(nodes[nodeId].pendingQueued?.map((q) => q.value)).toEqual(['and then?', 'why this?']));
    expect(nodes[nodeId].pendingQueued?.[1].quotedText).toBe('the third one');
    expect(stream).toHaveBeenCalledTimes(1);
    vi.mocked(api.ensureSession).mockReset().mockImplementation(() => Promise.reject(new Error('offline in tests')));
    embeddedNodeId = null;
  });

  it('an embedded pane sends a /branch request to the conversation itself', async () => {
    embeddedNodeId = null;
    const nodeId = await mount();
    act(() => { store.closePane(nodeId); });
    await waitFor(() => expect(panes.openPanes).not.toContain(nodeId));
    embeddedNodeId = nodeId;
    const before = Object.keys(nodes).length;
    act(() => store.setComposerDraft(nodeId, { value: '/branch What is left?', mentions: [] }));
    const send = await screen.findByRole('button', { name: 'Send (Enter)' });
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(nodes[nodeId].messages.some((m) => m.role === 'user')).toBe(true));
    expect(nodes[nodeId].messages.find((m) => m.role === 'user')!.text).toBe('What is left?');
    expect(Object.keys(nodes)).toHaveLength(before);
    embeddedNodeId = null;
  });
});
