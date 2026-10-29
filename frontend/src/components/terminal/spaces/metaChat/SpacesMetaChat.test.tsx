import { useContext, useEffect, useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatNodeState } from '../../../../state/chatTypes';
import { resetAssistantStoreForTests } from '../../../../state/assistant/assistantStore';
import { resetMetaAgentStore } from '../../../../state/metaAgent/useMetaAgent';
import { getAssistantComposer, requestAssistantSend, resetAssistantComposerForTests, takeAssistantSends } from '../../../../state/assistant/assistantComposer';
import { metaAgentTurnContextFor } from '../../../../services/api/assistant';
import { fetchTreeMessages } from '../../../../services/api/persistence';
import { MetaChatDecorationsContext } from '../../../../state/metaChat/metaChatDecorations';
import { MarkdownLinkRendererContext } from '../../../markdownLinkRenderer';
import { resetSpacesPagesForTests } from '../../../../state/metaChat/spacesPages';
import { useMetaChatWindow } from '../../../../state/metaChat/useMetaChatWindow';
import { getSourceNavState, resetSourceNavForTests } from '../../../../state/sourceNav/sourceNav';
import { SpacesMetaChat, useMetaChatTargeting, type MetaChatSource, type SpacesChatView } from './SpacesMetaChat';
import { FollowUpRow } from '../../../FollowUpRow';

vi.mock('../../../MentionEditor', () => import('../../../../test/mentionEditorStub'));
const resetApi = vi.hoisted(() => vi.fn());
vi.mock('../../../../services/api/assistant', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/api/assistant')>('../../../../services/api/assistant');
  return { ...actual, fetchAssistant: () => new Promise(() => {}), resetAssistant: resetApi };
});
vi.mock('../../../../state/assistant/useAssistantNode', () => ({ useAssistantNode: () => ({ state: 'ready', retry: () => {} }) }));
vi.mock('../../assistant/AssistantLinks', () => ({
  AssistantLinkScope: ({ children }: { children: unknown }) => children,
  AssistantLinkChip: ({ children }: { children: unknown }) => <button type="button">{children as string}</button>,
}));
vi.mock('../../../../state/metaChat/spacesPages', async () => {
  const actual = await vi.importActual<typeof import('../../../../state/metaChat/spacesPages')>('../../../../state/metaChat/spacesPages');
  return { ...actual, loadSpacesHomeIds: () => Promise.resolve(actual.getSpacesHomeIds()) };
});

const store = vi.hoisted(() => ({ nodes: {} as Record<string, ChatNodeState> }));
const chatActions = vi.hoisted(() => ({ dispatch: vi.fn(), setComposerDraft: vi.fn() }));
const extraProjects = vi.hoisted(() => ({ list: [] as Array<{ id: string; name: string; chatIds: string[] }> }));
vi.mock('../../../../state/chatStore', async () => {
  const actual = await vi.importActual<typeof import('../../../../state/chatStore')>('../../../../state/chatStore');
  return {
    ...actual,
    useChatProjects: () => ({
      projects: [{ id: 'ws-r', name: 'rabbitholes', chatIds: [] }, { id: 'p-assistant', name: 'Assistant', system: 'assistant', chatIds: ['n-a'] }, ...extraProjects.list],
      agentStatus: { availableRuntimes: [{ id: 'kiro', label: 'Kiro' }, { id: 'claude', label: 'Claude' }] },
    }),
    useStructuralSelector: (selector: (nodes: Record<string, ChatNodeState>) => unknown) => selector(store.nodes),
    useChatNodesSnapshot: () => store.nodes,
    useChatActions: () => chatActions,
  };
});

const firstRun = vi.hoisted(() => ({ data: null as unknown }));
vi.mock('../../../../state/metaAgent/spacesFirstRun', async () => {
  const actual = await vi.importActual<typeof import('../../../../state/metaAgent/spacesFirstRun')>('../../../../state/metaAgent/spacesFirstRun');
  return { ...actual, useSpacesFirstRun: () => ({ load: 'ready', data: firstRun.data, error: null, unreachable: false, schedulerOff: false, justFinished: false }) };
});
const tree = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../../../../services/api/persistence', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/api/persistence')>('../../../../services/api/persistence');
  return { ...actual, fetchTreeMessages: vi.fn(async () => tree.rows) };
});
const nav = vi.hoisted(() => ({ open: vi.fn(async (_input: unknown) => true) }));
vi.mock('../../../../state/sourceNav/sourceNav', async () => {
  const actual = await vi.importActual<typeof import('../../../../state/sourceNav/sourceNav')>('../../../../state/sourceNav/sourceNav');
  return { ...actual, openConversationFromSpaces: nav.open };
});

const sent = vi.hoisted(() => [] as string[]);
const metaApi = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../../../services/api/metaAgent', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/api/metaAgent')>('../../../../services/api/metaAgent');
  return { ...actual, fetchMetaAgent: metaApi.fetch };
});
const layout = vi.hoisted(() => ({ rules: null as unknown[] | null, pageIds: [] as Array<string | null> }));
vi.mock('../layoutRules/useLayoutRules', () => ({
  useLayoutRules: (pageId: string | null) => {
    layout.pageIds.push(pageId);
    return { rules: pageId ? layout.rules : null, error: null, refresh: () => {}, remove: async () => {} };
  },
}));

/** Stands in for the conversation: each message with its links, tool lines and divider, two fixed source links, and the follow-up rows. */
vi.mock('../../TPane', () => ({
  default: function TPaneStub({ nodeId, spacesAssistant, composerPreBlocks, draftRequest }: { nodeId: string; spacesAssistant?: boolean; composerPreBlocks?: ReactNode | ((draftHasText: boolean) => ReactNode); draftRequest?: { id: number; text: string } | null }) {
    const [draft, setDraft] = useState('');
    useEffect(() => { if (draftRequest) setDraft(draftRequest.text); }, [draftRequest]);
    const decorations = useContext(MetaChatDecorationsContext);
    const links = useContext(MarkdownLinkRendererContext);
    const node = store.nodes[nodeId];
    return (
      <div data-testid="tpane" data-shared-composer={spacesAssistant ? '' : undefined}>
        {typeof composerPreBlocks === 'function' ? composerPreBlocks(Boolean(draft.trim())) : composerPreBlocks}
        <textarea aria-label="Message the assistant" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
          if (event.key !== 'Enter') return;
          requestAssistantSend(nodeId, draft);
          store.nodes[nodeId].messages.push(message('typed-user', 'user', draft));
          setDraft('');
        }} />
        {(node?.messages ?? []).map((m) => (
          <div key={m.id}>
            {m.role === 'assistant' ? decorations?.assistantLabel : null}
            {m.text.split(/(\[[^\]]+\]\([^)]+\))/).map((part, i) => {
              const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
              return link ? <span key={i}>{links?.render(link[2]!, link[1])}</span> : part;
            })}
            {(m.toolCalls ?? []).map((tool) => <p key={tool.id}>{decorations?.toolLine?.(tool)}</p>)}
            {decorations?.afterMessage?.(m)}
          </div>
        ))}
        {links?.render('michi://node/n-src', '排查公证失败')}
        {links?.render('michi://node/n-src?message=a-7', '最后一条')}
        {(node?.followUps ?? []).map((q, i) => (
          <FollowUpRow key={q} index={i} question={q} onContinue={(text) => sent.push(text)} onBranch={(text) => sent.push(`branch:${text}`)} />
        ))}
      </div>
    );
  },
}));

const info = (patch: Record<string, unknown> = {}) => ({
  nodeId: 'n-a', workspaceId: 'p-assistant', treeId: 't', supportedRuntimes: ['kiro', 'claude'],
  settings: { runtimeId: 'kiro', modelId: null, reasoning: null }, conversation: { runtimeId: 'kiro', modelId: null, reasoning: null },
  ...patch,
});
const message = (id: string, role: 'user' | 'assistant', text: string): ChatMessage => ({ id, role, text, toolCalls: [] } as unknown as ChatMessage);
const node = (patch: Partial<ChatNodeState> = {}) => ({ id: 'n-a', nodeId: 'n-a', status: 'idle', messages: [], followUps: [], ...patch } as unknown as ChatNodeState);
const activeRun = (state = 'reading', requestedAt = 500) => ({
  requestedAt, haltedReason: null, summary: { state: 'waiting', summarizedAt: null },
  workspaces: [{ workspaceId: 'ws-r', workspaceName: 'rabbitholes', homePageId: 'pg-r-home', hiddenAt: null,
    firstRun: { workspaceId: 'ws-r', startedAt: 1, startSeq: 0, readCount: 1, total: 3, state, error: null, updatedAt: 1 } }],
});
const panelHidden = () => (document.querySelector('.meta-chat-panel') as HTMLElement).hidden;
const narrationRow = (id: string, content: string, narration: Record<string, unknown>, seq: number) => ({
  id, node_id: 'n-a', role: 'assistant', content, seq, created_at: seq, metadata: JSON.stringify({ metaAgentNarration: narration }),
});

function TargetButton() {
  const targeting = useMetaChatTargeting();
  return (
    <><button type="button" onClick={() => targeting?.respondToBlock?.({ backendConnectionId: 'local', workspaceId: 'ws-r', pageId: 'pg-r-home', blockId: 'b-action', title: 'Release', content: 'Visible block' }, 'Review this draft', false)}>prefill block</button>
    <button type="button" onClick={() => targeting?.respondToBlock?.({ backendConnectionId: 'local', workspaceId: 'ws-r', pageId: 'pg-r-home', blockId: 'b-choice', title: 'Route', content: 'East or West' }, 'For “Route?” I pick: East', true)}>send choice</button>
    <button type="button" onClick={() => targeting?.askAbout({ backendConnectionId: 'local', workspaceId: 'ws-r', pageId: 'pg-r-home', blockId: 'b-next', title: '下一步', content: 'x' })}>
      target
    </button></>
  );
}

function Host({ view = { kind: 'workspace', workspaceId: 'ws-r', name: 'rabbitholes' }, onOpenSource }: { view?: SpacesChatView; onOpenSource?: (s: MetaChatSource) => boolean }) {
  const chat = useMetaChatWindow({ storage: null });
  return <SpacesMetaChat controller={chat} active view={view} {...(onOpenSource ? { onOpenSource } : {})}><TargetButton /></SpacesMetaChat>;
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const r = this.classList.contains('meta-chat-area') ? { left: 0, top: 0, width: 1000, height: 800 } : { left: 0, top: 0, width: 0, height: 0 };
    return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  });
  resetAssistantStoreForTests({ status: 'ready', info: info() as never });
  resetAssistantComposerForTests();
  resetSpacesPagesForTests({ home: { id: 'pg-home', title: 'Home' }, workspaces: { 'ws-r': 'pg-r-home' } });
  resetApi.mockReset();
  store.nodes = { 'n-a': node() };
  firstRun.data = null;
  tree.rows = [];
  sent.length = 0;
  layout.rules = null;
  layout.pageIds = [];
  extraProjects.list = [];
  resetMetaAgentStore();
  metaApi.fetch.mockReset().mockReturnValue(new Promise(() => {}));
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  chatActions.dispatch.mockReset();
  chatActions.setComposerDraft.mockReset();
  nav.open.mockClear();
});

describe('SpacesMetaChat', () => {
  it('prefills block actions and targets a visible choice before its send is queued', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'prefill block' }));
    expect((screen.getByRole('textbox', { name: 'Message the assistant' }) as HTMLTextAreaElement).value).toBe('Review this draft');
    expect(takeAssistantSends('n-a')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'send choice' }));
    expect(takeAssistantSends('n-a').map((item) => item.prompt)).toEqual(['For “Route?” I pick: East']);
    expect(JSON.stringify(metaAgentTurnContextFor('n-a'))).toContain('b-choice');
  });

  it('starts a fresh conversation once, clears its target and draft, and retains the previous history', async () => {
    store.nodes['n-a'] = node({ messages: [message('m1', 'assistant', 'Previous answer')] });
    store.nodes['n-new'] = node({ nodeId: 'n-new', messages: [] });
    let finish!: (value: unknown) => void;
    resetApi.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'target' }));
    const input = await screen.findByRole('textbox', { name: 'Message the assistant' });
    fireEvent.change(input, { target: { value: 'Old draft' } });
    const button = screen.getByRole('button', { name: 'New conversation' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(resetApi).toHaveBeenCalledTimes(1);
    expect(resetApi).toHaveBeenCalledWith('n-a');
    expect(screen.getByText('Previous answer')).toBeTruthy();
    await act(async () => { finish(info({ nodeId: 'n-new', treeId: 't-new' })); });
    expect(screen.queryByText('Previous answer')).toBeNull();
    expect(screen.queryByText(/Targeting:/)).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Message the assistant' }) as HTMLTextAreaElement).value).toBe('');
    expect(store.nodes['n-a'].messages[0].text).toBe('Previous answer');
    expect(metaAgentTurnContextFor('n-new')).toMatchObject({ blockId: null });
  });

  it('keeps the old conversation and draft when starting a new one fails', async () => {
    store.nodes['n-a'] = node({ messages: [message('m1', 'assistant', 'Previous answer')] });
    resetApi.mockRejectedValue(new Error('Could not start a new conversation'));
    render(<Host />);
    const input = await screen.findByRole('textbox', { name: 'Message the assistant' });
    fireEvent.change(input, { target: { value: 'Keep my draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not start a new conversation');
    expect(screen.getByText('Previous answer')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Message the assistant' }) as HTMLTextAreaElement).value).toBe('Keep my draft');
  });

  it('does not start over while the assistant is answering', () => {
    store.nodes['n-a'] = node({ status: 'streaming' });
    render(<Host />);
    const button = screen.getByRole('button', { name: 'New conversation' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(resetApi).not.toHaveBeenCalled();
  });

  it("gives each message the page on screen and the selected block, and sends the text alone", () => {
    render(<Host />);
    expect(metaAgentTurnContextFor('n-a')).toMatchObject({ pageId: 'pg-r-home', blockId: null });
    fireEvent.click(screen.getByRole('button', { name: 'target' }));
    expect(screen.getByText(/Targeting: 下一步/)).toBeTruthy();
    expect(metaAgentTurnContextFor('n-a')).toMatchObject({ pageId: 'pg-r-home', blockId: 'b-next', pages: expect.arrayContaining([{ id: 'pg-r-home', title: 'rabbitholes', workspaceId: 'ws-r' }]) });

    fireEvent.click(screen.getByRole('button', { name: 'Start a conversation for the next step' }));
    expect(getAssistantComposer('n-a').attachments).toEqual([]);
    expect(takeAssistantSends('n-a').map((s) => s.prompt)).toEqual(['Start a conversation for the next step']);
  });

  it('stops giving context once the window leaves Spaces', () => {
    const { unmount } = render(<Host view={{ kind: 'home' }} />);
    expect(metaAgentTurnContextFor('n-a')).toMatchObject({ pageId: 'pg-home' });
    unmount();
    expect(metaAgentTurnContextFor('n-a')).toBeUndefined();
  });

  it('shows the suggestions for the page type and disables them while the Meta agent answers', () => {
    store.nodes = { 'n-a': node({ status: 'streaming' }) };
    render(<Host view={{ kind: 'home' }} />);
    const asked = screen.getByRole('button', { name: 'Who is waiting on me?' }) as HTMLButtonElement;
    expect(asked.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Start a conversation for the next step' })).toBeNull();
  });

  it('hides “Stalled: only the last 3 days” while the Home has that rule and brings it back once deleted', () => {
    const view = render(<Host view={{ kind: 'home' }} />);
    expect(layout.pageIds).toContain('pg-home');
    expect(screen.getByRole('button', { name: 'Stalled: only the last 3 days' })).toBeTruthy();

    layout.rules = [{ id: 'r1', text: 'Stalled: last 3 days', sourceMessage: null, createdBy: 'agent', createdAt: 1, sectionLimit: { section: 'stalled', maxAgeDays: 3 } }];
    view.rerender(<Host view={{ kind: 'home' }} />);
    expect(screen.queryByRole('button', { name: 'Stalled: only the last 3 days' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add a block: release countdown' })).toBeTruthy();

    layout.rules = [];
    view.rerender(<Host view={{ kind: 'home' }} />);
    expect(screen.getByRole('button', { name: 'Stalled: only the last 3 days' })).toBeTruthy();
  });

  it('reads no layout rules where no suggestion asks for one', () => {
    render(<Host />);
    expect(layout.pageIds.every((id) => id === null)).toBe(true);
  });

  it('names the conversation speaker Michi and shows only the page context beside Assistant', () => {
    store.nodes = { 'n-a': node({ messages: [message('a-1', 'assistant', 'Here is the latest.')] }) };
    render(<Host />);
    expect(screen.getByText('Michi', { selector: '.meta-chat-speaker' })).toBeTruthy();
    expect(screen.queryByText('Meta agent', { selector: '.meta-chat-speaker' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^meta agent ·/i })).toBeNull();
    expect(screen.getByTitle('Viewing: rabbitholes')).toBeTruthy();
  });

  it('hides the starter questions immediately after a suggestion is sent and across page changes', () => {
    const view = render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Start a conversation for the next step' }));
    expect(takeAssistantSends('n-a').map((s) => s.prompt)).toEqual(['Start a conversation for the next step']);
    expect(screen.queryByRole('group', { name: 'Suggested questions' })).toBeNull();
    view.rerender(<Host view={{ kind: 'home' }} />);
    expect(screen.queryByRole('group', { name: 'Suggested questions' })).toBeNull();
  });

  it('hides starter questions after a typed first message and keeps them hidden from the restored transcript', async () => {
    const view = render(<Host />);
    const input = await screen.findByLabelText('Message the assistant');
    expect(screen.getByRole('group', { name: 'Suggested questions' })).toBeTruthy();
    fireEvent.change(input, { target: { value: '请你' } });
    expect(screen.queryByRole('group', { name: 'Suggested questions' })).toBeNull();
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByRole('group', { name: 'Suggested questions' })).toBeTruthy();
    fireEvent.change(input, { target: { value: 'What should I focus on?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(takeAssistantSends('n-a').map((s) => s.prompt)).toEqual(['What should I focus on?']);
    view.rerender(<Host />);
    expect(screen.queryByRole('group', { name: 'Suggested questions' })).toBeNull();
    view.unmount();

    store.nodes = { 'n-a': node({ messages: [message('u-1', 'user', 'What should I focus on?'), message('a-1', 'assistant', 'Start here.')] }) };
    render(<Host view={{ kind: 'home' }} />);
    expect(screen.queryByRole('group', { name: 'Suggested questions' })).toBeNull();
  });

  it('keeps starter questions for automatic narration until the transcript includes a user message', () => {
    store.nodes = { 'n-a': node({ messages: [message('mna-start', 'assistant', 'Reading your workspaces.')] }) };
    const view = render(<Host view={{ kind: 'home' }} />);
    expect(screen.getByRole('group', { name: 'Suggested questions' })).toBeTruthy();

    store.nodes = { 'n-a': node({ messages: [message('mna-start', 'assistant', 'Reading your workspaces.'), message('u-1', 'user', 'Thanks.')] }) };
    view.rerender(<Host view={{ kind: 'home' }} />);
    expect(screen.queryByRole('group', { name: 'Suggested questions' })).toBeNull();
  });

  it('marks where the conversation moved to another runtime', () => {
    store.nodes = { 'n-a': node({ messages: [message('u-1', 'user', 'q1'), message('a-1', 'assistant', 'r1'), message('u-2', 'user', 'q2')] }) };
    resetAssistantStoreForTests({ status: 'ready', info: info({ runtimeSwitches: [{ afterMessageId: 'a-1', previousRuntimeId: 'claude', runtimeId: 'kiro', switchedAt: 1 }] }) as never });
    render(<Host />);
    const divider = screen.getByRole('separator');
    expect(divider.textContent).toBe('From here on: Kiro');
    expect(divider.parentElement!.textContent).toContain('r1');
  });

  it('shows a one-line notice with the way to Settings when the restriction check failed', () => {
    store.nodes = { 'n-a': node({ status: 'error', errorKind: 'meta_agent_guard_failed', error: 'extra tools: desk_now' }) };
    const opened: unknown[] = [];
    const onSection = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener('michi:open-settings-section', onSection);
    render(<Host />);
    expect(screen.getByRole('alert').textContent).toContain("The Meta agent's tool check failed.");
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings › Meta agent' }));
    window.removeEventListener('michi:open-settings-section', onSection);
    expect(opened).toEqual([{ section: 'meta-agent' }]);
  });

  it('says Spaces doesn’t support a remote workspace, offers no suggestions for it, and tells the Meta agent so', () => {
    extraProjects.list = [{ id: 'remote:box:ws-far', name: 'Far away', chatIds: [] }];
    const view = render(<Host view={{ kind: 'workspace', workspaceId: 'remote:box:ws-far', name: 'Far away' }} />);
    expect(document.querySelector('.meta-chat-panel__notice[data-tone="info"]')?.textContent).toBe('Pages doesn’t support remote connections yet, so the Meta agent can\'t read Far away.');
    expect(document.querySelectorAll('.t-followup-row')).toHaveLength(0);
    expect(metaAgentTurnContextFor('n-a')).toMatchObject({ pageId: null, remoteWorkspaces: ['Far away'], remoteOnScreen: 'Far away' });
    view.unmount();
    render(<Host view={{ kind: 'home' }} />);
    expect(screen.queryByText(/remote connections/)).toBeNull();
    expect(metaAgentTurnContextFor('n-a')).toMatchObject({ pageId: 'pg-home', remoteWorkspaces: ['Far away'], remoteOnScreen: null });
  });

  it('hands a cited conversation to onOpenSource, and by default opens the source popover', () => {
    const onOpenSource = vi.fn(() => true);
    render(<Host onOpenSource={onOpenSource} />);
    fireEvent.click(screen.getByRole('button', { name: /排查公证失败/ }));
    const page = { pageId: 'pg-r-home', workspaceId: 'ws-r', backendConnectionId: 'local', title: 'rabbitholes' };
    expect(onOpenSource).toHaveBeenCalledWith({ backendConnectionId: 'local', nodeId: 'n-src', title: '排查公证失败', page });
    cleanup();

    resetSourceNavForTests();
    render(<Host />);
    act(() => { fireEvent.click(screen.getByRole('button', { name: /排查公证失败/ })); });
    expect(getSourceNavState().popover).toMatchObject({
      target: { backendConnectionId: 'local', nodeId: 'n-src', messageId: null },
      page: { backendConnectionId: 'local', workspaceId: 'ws-r', pageId: 'pg-r-home', title: 'rabbitholes' },
    });
    resetSourceNavForTests();
  });

  it('passes the message a citation names, so the popover quotes it', () => {
    const onOpenSource = vi.fn(() => true);
    render(<Host onOpenSource={onOpenSource} />);
    fireEvent.click(screen.getByRole('button', { name: /最后一条/ }));
    expect(onOpenSource).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'n-src', assistantId: 'a-7', title: '最后一条' }));
    cleanup();

    resetSourceNavForTests();
    render(<Host />);
    act(() => { fireEvent.click(screen.getByRole('button', { name: /最后一条/ })); });
    expect(getSourceNavState().popover).toMatchObject({ target: { backendConnectionId: 'local', nodeId: 'n-src', messageId: 'a-7' } });
    resetSourceNavForTests();
  });

  it('opens floating once when a first run starts, and not again after the user minimises it or comes back', () => {
    const view = render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(panelHidden()).toBe(true);
    firstRun.data = activeRun('reading');
    view.rerender(<Host />);
    expect(panelHidden()).toBe(false);
    expect(document.querySelector('.meta-chat-panel')!.getAttribute('data-form')).toBe('float');

    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    firstRun.data = activeRun('writing');
    view.rerender(<Host />);
    expect(panelHidden()).toBe(true);
    view.unmount();

    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(panelHidden()).toBe(true);
  });

  it('reads back what the first run posted and puts its question options in the follow-up rows', async () => {
    firstRun.data = activeRun('done');
    store.nodes = { 'n-a': node({ messages: [message('mna-start-500', 'assistant', 'Reading.')] }) };
    tree.rows = [
      narrationRow('mna-start-500', 'Reading.', { kind: 'start' }, 0),
      narrationRow('mna-end-500', 'Done. Waiting for review, or dropped?', { kind: 'end', options: [{ label: 'Still waiting for review' }, { label: 'Dropped, archive it' }] }, 1),
    ];
    render(<Host />);
    await waitFor(() => expect(chatActions.dispatch).toHaveBeenCalledTimes(2));
    const [installed, followUps] = chatActions.dispatch.mock.calls.map((call) => call[0]);
    expect(installed).toMatchObject({ type: 'messages-loaded', nodeIds: ['n-a'] });
    expect(installed.messagesByNode['n-a'].map((m: ChatMessage) => m.id)).toEqual(['mna-start-500', 'mna-end-500']);
    expect(followUps).toEqual({ type: 'set-follow-ups', nodeId: 'n-a', followUps: ['Still waiting for review', 'Dropped, archive it'] });
  });

  it('shows the narration with its links; an answer is sent, "continue in that conversation" opens it with the text unsent', async () => {
    const open = { nodeId: 'n-b', workspaceId: 'ws-b', draft: 'Is the review still pending?' };
    store.nodes = { 'n-a': node({
      messages: [
        message('mna-ws', 'assistant', '[rabbitholes](michi://page/pg-r-home) home is written: Michi 已合入 dev'),
        message('mna-end-500', 'assistant', 'sample-dashboard 两周没动，是在等审阅，还是不做了？'),
      ],
      followUps: ['还在等审阅', 'Ask in that conversation'],
    }) };
    tree.rows = [
      narrationRow('mna-ws', '[rabbitholes](michi://page/pg-r-home) home is written: Michi 已合入 dev', { kind: 'workspace' }, 0),
      narrationRow('mna-end-500', 'sample-dashboard 两周没动，是在等审阅，还是不做了？', { kind: 'end', options: [{ label: '还在等审阅' }, { label: 'Ask in that conversation', open }] }, 1),
    ];
    render(<Host view={{ kind: 'home' }} />);
    expect(screen.getByRole('button', { name: 'rabbitholes' })).toBeTruthy();
    expect(screen.getByText(/home is written: Michi 已合入 dev/)).toBeTruthy();
    await waitFor(() => expect(vi.mocked(fetchTreeMessages)).toHaveBeenCalled());
    await act(async () => {});
    expect(document.querySelector('.meta-chat-conversation')!.hasAttribute('data-question')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Continue follow-up in current pane: 还在等审阅/ }));
    expect(sent).toEqual(['还在等审阅']);
    expect(nav.open).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Continue follow-up in current pane: Ask in that conversation/ })); });
    expect(sent).toEqual(['还在等审阅']);
    expect(nav.open).toHaveBeenCalledWith({ backendConnectionId: 'local', workspaceId: 'ws-b', nodeId: 'n-b', focus: true });
    expect(chatActions.setComposerDraft).toHaveBeenCalledWith('n-b', { value: 'Is the review still pending?', mentions: [] });
  });

  it('says when a page change waits for the first run', () => {
    const held = { id: 't1', title: 'Running: @michi/edit_page', status: 'failed', kind: 'other', inputJson: JSON.stringify({ pageId: 'pg-r-home' }),
      output: "HELD: the Meta agent's first-time generation is still writing (1 of 2 workspace homes written, then the Spaces Home)." };
    store.nodes = { 'n-a': node({ messages: [{ ...message('a-1', 'assistant', "I'll add it once the first run is done."), toolCalls: [held] } as ChatMessage] }) };
    render(<Host />);
    expect(screen.getByText('Write rabbitholes · held until the first run finishes')).toBeTruthy();
    expect(document.querySelector('.meta-chat-conversation')!.hasAttribute('data-question')).toBe(false);
  });
});
