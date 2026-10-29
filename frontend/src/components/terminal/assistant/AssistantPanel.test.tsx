import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantPanelHost } from './AssistantPanel';
import { AssistantApiError, MICHI_ASSISTANT_RESET_EVENT } from '../../../services/api/assistant';
import { openMichiAssistant } from '../../../state/content/assistantBridge';
import {
  getAssistantSnapshot,
  resetAssistantStoreForTests,
  toggleAssistantPanel,
} from '../../../state/assistant/assistantStore';
import { getAssistantComposer, resetAssistantComposerForTests } from '../../../state/assistant/assistantComposer';

const api = vi.hoisted(() => ({ fetchAssistant: vi.fn(), resetAssistant: vi.fn() }));
vi.mock('../../../services/api/assistant', async () => {
  const actual = await vi.importActual<typeof import('../../../services/api/assistant')>('../../../services/api/assistant');
  return { ...actual, fetchAssistant: api.fetchAssistant, resetAssistant: api.resetAssistant };
});
vi.mock('../../../services/api/persistence', () => ({ fetchWorkspace: vi.fn(), fetchTreeMessages: vi.fn() }));

vi.mock('../TPane', () => ({
  default: ({ nodeId, embedded, composerDisabled }: { nodeId: string; embedded?: boolean; composerDisabled?: boolean }) => (
    <div data-testid="tpane" data-node={nodeId} data-embedded={String(!!embedded)} data-composer-disabled={String(!!composerDisabled)}>
      <div contentEditable suppressContentEditableWarning data-testid="composer" />
    </div>
  ),
}));

const navigateToNode = vi.hoisted(() => vi.fn());
vi.mock('../../../state/navigateToNode', () => ({ navigateToNode }));

const chat = vi.hoisted(() => ({
  nodes: {} as Record<string, { nodeId: string; projectId: string; title: string; status: string; messages: unknown[]; messagesLoaded?: boolean; composerDraft?: { value: string; mentions: unknown[]; quotedText?: string } }>,
  focusedPane: null as string | null,
  openPanes: [] as string[],
  projects: [] as Array<{ id: string; activeTreeId: string | null }>,
  actions: {
    selectProject: vi.fn(), openPane: vi.fn(), openPaneInTree: vi.fn(), activateTree: vi.fn(), setFocusedNodeId: vi.fn(),
    sendMessage: vi.fn(), queueMessage: vi.fn(), setComposerDraft: vi.fn(), focusPane: vi.fn(),
    installWorkspaceSnapshot: vi.fn(), dispatch: vi.fn(),
  },
}));
vi.mock('../../../state/chatStore', () => ({
  useChatNode: (id: string) => chat.nodes[id],
  useChatProjects: () => ({ projects: chat.projects, activeProjectId: 'w1' }),
  useChatPanes: () => ({ focusedPane: chat.focusedPane, openPanes: chat.openPanes }),
  useChatActions: () => chat.actions,
  useStructuralSelector: (selector: (nodes: unknown) => unknown) => selector(chat.nodes),
  useChatNodeReader: () => (id: string) => chat.nodes[id],
  chatLabel: () => 'New thread',
}));


const INFO = { nodeId: 'n1', workspaceId: 'sys', treeId: 't1', settings: { runtimeId: 'claude', modelId: null, reasoning: null }, supportedRuntimes: ['claude'] };

function node(id: string, status = 'idle') {
  return { nodeId: id, projectId: 'sys', title: 'Assistant', status, messages: [], messagesLoaded: true };
}

beforeEach(() => {
  api.fetchAssistant.mockReset().mockResolvedValue(INFO);
  api.resetAssistant.mockReset();
  for (const fn of Object.values(chat.actions)) fn.mockReset();
  navigateToNode.mockReset();
  chat.nodes = { n1: node('n1') };
  chat.focusedPane = null;
  chat.openPanes = [];
  chat.projects = [];
  resetAssistantStoreForTests();
});
afterEach(() => {
  act(() => {
    resetAssistantStoreForTests();
    resetAssistantComposerForTests();
  });
});

async function openPanel(page: React.ComponentProps<typeof AssistantPanelHost>['page'] = 'threads') {
  const view = render(<AssistantPanelHost page={page} />);
  act(() => { toggleAssistantPanel(); });
  await screen.findByTestId('tpane');
  return view;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('AssistantPanelHost', () => {
  it('follows another window that already started over instead of failing', async () => {
    const elsewhere = { ...INFO, nodeId: 'n2', treeId: 't2' };
    api.resetAssistant.mockRejectedValue(new AssistantApiError(409, 'The assistant already started over', false, elsewhere));
    chat.nodes = { n1: node('n1'), n2: node('n2') };
    await openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    await waitFor(() => expect(screen.getByTestId('tpane').getAttribute('data-node')).toBe('n2'));
    expect(getAssistantSnapshot().info?.nodeId).toBe('n2');
  });

  it('starts a new conversation from its header, not while the assistant answers', async () => {
    const fresh = { ...INFO, nodeId: 'n2', treeId: 't2' };
    api.resetAssistant.mockResolvedValue(fresh);
    chat.nodes = { n1: node('n1', 'streaming'), n2: node('n2') };
    const resets: unknown[] = [];
    const onReset = (event: Event) => resets.push((event as CustomEvent).detail);
    window.addEventListener(MICHI_ASSISTANT_RESET_EVENT, onReset);
    try {
      const view = await openPanel();
      const button = screen.getByRole('button', { name: 'New conversation' }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      chat.nodes = { ...chat.nodes, n1: node('n1') };
      view.rerender(<AssistantPanelHost page="threads" />);
      expect(button.disabled).toBe(false);
      const pending = deferred<typeof fresh>();
      api.resetAssistant.mockReturnValue(pending.promise);
      fireEvent.click(button);
      // No message goes to the conversation being archived.
      expect(screen.getByTestId('tpane').getAttribute('data-composer-disabled')).toBe('true');
      await act(async () => { pending.resolve(fresh); });
      await waitFor(() => expect(screen.getByTestId('tpane').getAttribute('data-node')).toBe('n2'));
      expect(screen.getByTestId('tpane').getAttribute('data-composer-disabled')).toBe('false');
      expect(api.resetAssistant).toHaveBeenCalledWith('n1');
      expect(resets).toEqual([fresh]);
      expect(getAssistantSnapshot().info?.nodeId).toBe('n2');
    } finally {
      window.removeEventListener(MICHI_ASSISTANT_RESET_EVENT, onReset);
    }
  });

  it('renders nothing until opened, then the assistant conversation', async () => {
    const answer = deferred<typeof INFO>();
    api.fetchAssistant.mockReturnValue(answer.promise);
    const { container } = render(<AssistantPanelHost page="home" />);
    expect(container.innerHTML).toBe('');
    act(() => { toggleAssistantPanel(); });
    // A first probe gets a moment before the skeleton shows.
    expect(container.innerHTML).toBe('');
    expect(await screen.findByLabelText('Loading the assistant')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Assistant' })).toBeTruthy();
    await act(async () => { answer.resolve(INFO); });
    const pane = await screen.findByTestId('tpane');
    expect(pane.getAttribute('data-node')).toBe('n1');
    expect(pane.getAttribute('data-embedded')).toBe('true');
    expect(screen.getByText('Assistant · on Home')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('composer')));
  });

  it('never flashes on a backend without an assistant', async () => {
    const answer = deferred<typeof INFO>();
    api.fetchAssistant.mockReturnValue(answer.promise);
    const { container } = render(<AssistantPanelHost page="home" />);
    act(() => { toggleAssistantPanel(); });
    expect(container.innerHTML).toBe('');
    await act(async () => { answer.reject(new AssistantApiError(404, 'Not found')); });
    expect(getAssistantSnapshot().status).toBe('unsupported');
    expect(container.innerHTML).toBe('');
  });

  it('comes back after a reload without taking focus, and takes it when opened again', async () => {
    resetAssistantStoreForTests({ open: true });
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    try {
      outside.focus();
      render(<AssistantPanelHost page="home" />);
      await screen.findByTestId('tpane');
      await new Promise((r) => setTimeout(r, 120));
      expect(document.activeElement).toBe(outside);
      act(() => { toggleAssistantPanel(); });
      act(() => { toggleAssistantPanel(); });
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('composer')));
    } finally {
      outside.remove();
    }
  });

  it('does not take focus when it follows a reset', async () => {
    await openPanel();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('composer')));
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    try {
      outside.focus();
      chat.nodes = { ...chat.nodes, n2: node('n2') };
      act(() => {
        window.dispatchEvent(new CustomEvent(MICHI_ASSISTANT_RESET_EVENT, { detail: { ...INFO, nodeId: 'n2' } }));
      });
      await waitFor(() => expect(screen.getByTestId('tpane').getAttribute('data-node')).toBe('n2'));
      await new Promise((r) => setTimeout(r, 120));
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });

  it('drops a request when the panel closes before the assistant is ready', async () => {
    const answer = deferred<typeof INFO>();
    api.fetchAssistant.mockReturnValue(answer.promise);
    render(<AssistantPanelHost page="home" />);
    act(() => openMichiAssistant({ prompt: 'Summarize', send: true }));
    act(() => { toggleAssistantPanel(); });
    await act(async () => { answer.resolve(INFO); });
    act(() => { toggleAssistantPanel(); });
    await screen.findByTestId('tpane');
    await new Promise((r) => setTimeout(r, 50));
    expect(chat.actions.sendMessage).not.toHaveBeenCalled();
    expect(chat.actions.setComposerDraft).not.toHaveBeenCalled();
  });

  it('closes on Esc and on ×', async () => {
    await openPanel();
    fireEvent.keyDown(screen.getByTestId('composer'), { key: 'Escape' });
    expect(getAssistantSnapshot().open).toBe(false);
    expect(screen.queryByRole('complementary')).toBeNull();
    act(() => { toggleAssistantPanel(); });
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('leaves Esc to an open menu or an Esc-closing layer on top of it or inside it', async () => {
    await openPanel();
    const panel = screen.getByRole('complementary', { name: 'Assistant' });
    for (const [name, value, parent] of [
      ['role', 'menu', document.body],
      ['data-escape-layer', 'over', document.body],
      ['data-escape-layer', 'pane', panel],
    ] as const) {
      const layer = document.createElement('div');
      layer.setAttribute(name, value);
      parent.appendChild(layer);
      try {
        fireEvent.keyDown(screen.getByTestId('composer'), { key: 'Escape' });
        expect(getAssistantSnapshot().open).toBe(true);
      } finally {
        layer.remove();
      }
    }
  });

  it('closes on Esc even with a find bar left open in a pane behind it', async () => {
    await openPanel();
    const behind = document.createElement('div');
    behind.setAttribute('data-escape-layer', 'pane');
    document.body.appendChild(behind);
    try {
      fireEvent.keyDown(screen.getByTestId('composer'), { key: 'Escape' });
      expect(getAssistantSnapshot().open).toBe(false);
    } finally {
      behind.remove();
    }
  });

  it('never appears when the backend has no assistant', async () => {
    api.fetchAssistant.mockRejectedValue(new AssistantApiError(404, 'Not found'));
    const { container } = render(<AssistantPanelHost page="home" />);
    act(() => { toggleAssistantPanel(); });
    await waitFor(() => expect(getAssistantSnapshot().status).toBe('unsupported'));
    expect(container.innerHTML).toBe('');
    act(() => { expect(toggleAssistantPanel()).toBe(false); });
    act(() => openMichiAssistant({ prompt: 'hi' }));
    expect(container.innerHTML).toBe('');
  });

  it('shows one muted line and Retry when the assistant cannot be reached', async () => {
    api.fetchAssistant.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<AssistantPanelHost page="home" />);
    act(() => { toggleAssistantPanel(); });
    await screen.findByText("Couldn't reach the assistant");
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('tpane');
    expect(api.fetchAssistant).toHaveBeenCalledTimes(2);
  });

  it('names Home when the grid shows it, after the last pane (the assistant’s own) closed', async () => {
    // The assistant was open as the only pane of its workspace, then closed.
    chat.projects = [{ id: 'w1', activeTreeId: 't1' }];
    chat.openPanes = [];
    chat.focusedPane = 'n1';
    await openPanel('dashboard');
    expect(screen.getByText('Assistant · on Home')).toBeTruthy();
    expect(getAssistantComposer('n1').page).toEqual({ kind: 'home' });
  });

  it('takes attachments, a page and a prompt from openMichiAssistant', async () => {
    render(<AssistantPanelHost page="home" />);
    act(() => openMichiAssistant({
      attachments: [{ kind: 'block', id: 'b1', title: 'Plan vs actual', projectId: 'p1', text: '14 / 22' }],
      prompt: 'Why 3 days late?',
      page: { kind: 'page', projectId: 'p1' },
    }));
    await screen.findByTestId('tpane');
    await waitFor(() => expect(chat.actions.setComposerDraft).toHaveBeenCalledWith('n1', { value: 'Why 3 days late?', mentions: [] }));
    expect(getAssistantComposer('n1').attachments.map((i) => i.id)).toEqual(['b1']);
    expect(screen.getByText('Assistant · on Workspace document')).toBeTruthy();
    expect(chat.actions.sendMessage).not.toHaveBeenCalled();
  });

  it('hands a send it was asked for to the pane, with the chips and page still pending for it', async () => {
    render(<AssistantPanelHost page="home" />);
    act(() => openMichiAssistant({
      attachments: [{ kind: 'thread', id: 't7', title: 'S7' }],
      prompt: 'Archive the chat-only ones',
      send: true,
    }));
    await waitFor(() => expect(getAssistantComposer('n1').sends).toHaveLength(1));
    // TPane sends it through its own send path (TPane.assistantContext.test).
    expect(getAssistantComposer('n1').sends[0].prompt).toBe('Archive the chat-only ones');
    expect(getAssistantComposer('n1').attachments.map((i) => i.id)).toEqual(['t7']);
    expect(chat.actions.sendMessage).not.toHaveBeenCalled();
    expect(chat.actions.setComposerDraft).not.toHaveBeenCalled();
  });

  it('focuses the assistant pane already in the grid instead of opening a second view', async () => {
    resetAssistantStoreForTests({ status: 'ready', info: INFO });
    chat.openPanes = ['n1'];
    const grid = document.createElement('div');
    grid.dataset.nodeId = 'n1';
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.tabIndex = 0;
    grid.appendChild(editor);
    document.body.appendChild(grid);
    try {
      const { container } = render(<AssistantPanelHost page="dashboard" />);
      act(() => openMichiAssistant({ attachments: [{ kind: 'block', id: 'b1', title: 'Plan' }], prompt: 'Why?' }));
      expect(container.innerHTML).toBe('');
      expect(getAssistantSnapshot().open).toBe(false);
      expect(chat.actions.focusPane).toHaveBeenCalledWith('n1');
      expect(document.activeElement).toBe(editor);
      expect(getAssistantComposer('n1').attachments.map((i) => i.id)).toEqual(['b1']);
      expect(chat.actions.setComposerDraft).toHaveBeenCalledWith('n1', { value: 'Why?', mentions: [] });
    } finally {
      grid.remove();
    }
  });

  it('leaves an Esc that ends an IME composition alone', async () => {
    await openPanel();
    fireEvent.keyDown(screen.getByTestId('composer'), { key: 'Escape', isComposing: true });
    expect(getAssistantSnapshot().open).toBe(true);
  });

  it('gives focus back to where it was when dismissed', async () => {
    const field = document.createElement('input');
    document.body.appendChild(field);
    try {
      field.focus();
      await openPanel();
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('composer')));
      fireEvent.keyDown(screen.getByTestId('composer'), { key: 'Escape' });
      expect(document.activeElement).toBe(field);
    } finally {
      field.remove();
    }
  });

  it('opens as a pane and closes the panel', async () => {
    await openPanel();
    const nav = vi.fn();
    window.addEventListener('michi:nav-page', nav);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Open as pane' }));
    } finally {
      window.removeEventListener('michi:nav-page', nav);
    }
    expect(navigateToNode).toHaveBeenCalledWith(expect.objectContaining({ activeProjectId: 'w1' }), 'n1', 'sys');
    expect((nav.mock.calls[0][0] as CustomEvent).detail).toEqual({ page: 'dashboard' });
    expect(getAssistantSnapshot().open).toBe(false);
    expect(getAssistantComposer('n1').page).toBeNull();
  });

  describe('a prompt it put in the composer', () => {
    const PROMPT = 'A conversation is missing from this workspace:';
    async function inject(page: React.ComponentProps<typeof AssistantPanelHost>['page'] = 'threads') {
      const view = render(<AssistantPanelHost page={page} />);
      act(() => openMichiAssistant({ page: { kind: 'threads' }, prompt: `${PROMPT} ` }));
      await screen.findByTestId('tpane');
      await waitFor(() => expect(chat.actions.setComposerDraft).toHaveBeenCalledWith('n1', { value: PROMPT, mentions: [] }));
      chat.actions.setComposerDraft.mockClear();
      return view;
    }
    const cleared = () => chat.actions.setComposerDraft.mock.calls.some(([id, draft]) => id === 'n1' && draft === null);
    /**
     * The composer's draft as the store holds it. Nothing re-renders: an
     * edit made within the frame before Esc must count all the same.
     */
    const holdDraft = (_view: ReturnType<typeof render>, value: string) => {
      chat.nodes.n1 = { ...chat.nodes.n1, composerDraft: { value, mentions: [] } };
    };

    it('is cleared when the page it was for is gone, if the user left it as it was', async () => {
      const view = await inject();
      // Same page: still the prompt's page.
      holdDraft(view, PROMPT);
      expect(cleared()).toBe(false);
      view.rerender(<AssistantPanelHost page="home" />);
      await waitFor(() => expect(cleared()).toBe(true));
    });

    it('is kept once the user edited it, on another page or after closing', async () => {
      const view = await inject();
      holdDraft(view, `${PROMPT} the S7 move`);
      view.rerender(<AssistantPanelHost page="home" />);
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      act(() => { toggleAssistantPanel(); });
      await screen.findByTestId('tpane');
      expect(cleared()).toBe(false);
    });

    it('is cleared when the panel is dismissed, if untouched', async () => {
      const view = await inject();
      holdDraft(view, PROMPT);
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(cleared()).toBe(true));
    });

    it('goes along to the pane when the panel opens as one', async () => {
      const view = await inject();
      holdDraft(view, PROMPT);
      fireEvent.click(screen.getByRole('button', { name: 'Open as pane' }));
      expect(getAssistantSnapshot().open).toBe(false);
      await new Promise((r) => setTimeout(r, 20));
      expect(cleared()).toBe(false);
    });
  });

  it('follows a reset to the new conversation', async () => {
    await openPanel();
    chat.nodes = { ...chat.nodes, n2: node('n2') };
    act(() => {
      window.dispatchEvent(new CustomEvent(MICHI_ASSISTANT_RESET_EVENT, { detail: { ...INFO, nodeId: 'n2' } }));
    });
    await waitFor(() => expect(screen.getByTestId('tpane').getAttribute('data-node')).toBe('n2'));
  });
});
