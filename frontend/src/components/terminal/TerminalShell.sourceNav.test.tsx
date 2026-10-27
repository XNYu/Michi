import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import TerminalShell from './TerminalShell';
import { PrefsProvider } from '../../state/prefs';
import { OPEN_NATIVE_PAGE_EVENT } from './spaces/SpacesPage';
import { publishSpaceTopbar } from '../../state/pages/spaceTopbar';
import { getSourceNavState, returnToSourceOrigin } from '../../state/sourceNav/sourceNav';

const reveal = vi.hoisted(() => vi.fn(async () => {
  window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'dashboard' } }));
  return true;
}));
const api = vi.hoisted(() => ({ fetchSourcePreview: vi.fn(), describePageReference: vi.fn(async () => null) }));

vi.mock('../../state/sourceNav/sourceApi', () => api);
vi.mock('./pages/Home', () => ({ default: () => <div>Conversation home</div> }));
vi.mock('./pages/Dashboard', () => ({ default: () => <div>Conversation dashboard</div> }));
vi.mock('./pages/Scheduled', () => ({ default: () => <div>Scheduled page</div> }));
vi.mock('./spaces/SpaceView', async () => {
  const { SpaceProgressCardList } = await vi.importActual<typeof import('./spaces/conversation/SpaceConversationSlot')>('./spaces/conversation/SpaceConversationSlot');
  const scope = { backendConnectionId: 'local', pageId: 'p1', workspaceId: 'ws-1', workspaceName: 'rabbitholes', pageTitle: 'Michi 0.9 发布' };
  const card = {
    threadNodeId: 'n-live', startedFromPageId: 'p1', workspaceId: 'ws-1', workspaceName: 'rabbitholes', treeId: null,
    title: '跑完事务回滚用例', runtimeId: 'claude', status: 'done' as const, summary: '回滚用例全部通过。', createdAt: 1, seenAt: null, dismissedAt: null, expiresAt: null,
  };
  // A page tall enough to scroll, like the Space page's document.
  const sized = (element: HTMLDivElement | null) => {
    if (!element) return;
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 800 });
  };
  return {
    default: function MockSpaceView({ onOpenSource }: { onOpenSource: (source: { kind: 'chat'; nodeId: string; turnId: string; assistantId: string }) => void }) {
      React.useEffect(() => { publishSpaceTopbar({ title: 'Michi 0.9 发布', onOpenBeside: () => {} }); return () => publishSpaceTopbar(null); }, []);
      return (
        <div className="michi-doc" data-testid="space-doc" ref={sized} style={{ overflowY: 'auto' }}>
          Space view<button type="button" onClick={() => onOpenSource({ kind: 'chat', nodeId: 'n1', turnId: 't4', assistantId: 'm4' })}>from “排查公证失败”</button>
          <SpaceProgressCardList scope={scope} cards={[card]} />
        </div>
      );
    },
  };
});
vi.mock('./scheduled/useScheduledJobs', () => ({ useScheduledJobs: () => ({ jobs: [], loading: false, unavailable: false }) }));
vi.mock('../../state/pages/useSpaces', () => ({ useSpaces: () => ({ spaces: [], status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  return {
    ...actual,
    useChatProjects: () => ({
      activeProject: null, activeProjectId: null, projects: [], order: [], edges: [], theme: 'light', availableModes: [],
      agentStatus: null, warmFailedError: null, focusedNodeId: null, selection: new Set<string>(), hydrated: true,
      treeSelection: new Set<string>(), searchHighlightTerm: null,
    }),
    useChatPanes: () => ({ openPanes: [], focusedPane: null, focusNonce: 0, paneItems: {}, viewMode: 'single' as const }),
    useChatActions: () => ({
      createProject: vi.fn(), enterChatsWorkspace: () => Promise.resolve('chats-default'), focusPane: () => {}, closePane: () => {},
      openPane: () => {}, createBlankChild: vi.fn(), restoreLastDeletion: vi.fn(), clearSelection: () => {}, clearTreeSelection: () => {},
      selectAllTrees: () => {}, selectProject: () => {}, revealBackendNode: reveal,
    }),
    useStructuralSelector: (s: (n: Record<string, unknown>) => unknown) => s({}),
    useChatNodesSnapshot: () => ({}),
    useNodesSelector: () => ({}),
    useChatNode: () => null,
    chatLabel: () => '',
  };
});

const rail = (name: string) => screen.getByRole('navigation', { name: 'Areas' }).querySelector<HTMLButtonElement>(`[data-area="${name}"]`)!;
const backBar = () => screen.queryByRole('navigation', { name: 'Back to Pages' });

/**
 * Opens the Space page and waits until its title has reached the shell (the
 * top bar's crumb shows it). The page publishes it from an effect, which can
 * run after its links are on screen; a jump made before then names no page.
 */
async function openSpacePage() {
  act(() => { window.dispatchEvent(new CustomEvent(OPEN_NATIVE_PAGE_EVENT, { detail: { pageId: 'p1', workspaceId: 'ws-1', backendConnectionId: 'local' } })); });
  await screen.findByTitle('Michi 0.9 发布');
}

describe('TerminalShell: from a page source to its conversation and back', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false }));
    reveal.mockClear();
    api.fetchSourcePreview.mockResolvedValue({
      nodeId: 'n1', workspaceId: 'ws-1', workspaceName: 'rabbitholes', title: '排查公证失败', runtimeId: 'claude', state: 'live',
      message: { id: 'm4', role: 'assistant', text: '公证通过（Accepted）。', truncated: false, turnId: 't4', at: Date.now() },
    });
  });

  it('opens the source popover, continues in Conversations without a banner and preserves the source return location', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    await openSpacePage();
    fireEvent.click(await screen.findByRole('button', { name: 'from “排查公证失败”' }));
    expect(await screen.findByRole('dialog', { name: 'Source: 排查公证失败' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Continue this chat/ }));

    expect(await screen.findByText('Conversation dashboard')).toBeTruthy();
    expect(reveal).toHaveBeenCalledWith('ws-1', 'n1');
    expect(backBar()).toBeNull();

    fireEvent.click(rail('scheduled'));
    expect(await screen.findByText('Scheduled page')).toBeTruthy();
    fireEvent.click(rail('conversations'));
    expect(await screen.findByText('Conversation dashboard')).toBeTruthy();
    expect(backBar()).toBeNull();

    act(() => { returnToSourceOrigin(); });
    expect(await screen.findByText('Space view')).toBeTruthy();
    expect(backBar()).toBeNull();
  });

  it('going back to Spaces by the rail clears the source return location', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    await openSpacePage();
    fireEvent.click(await screen.findByRole('button', { name: 'from “排查公证失败”' }));
    const popover = await screen.findByRole('dialog', { name: 'Source: 排查公证失败' });
    fireEvent.click(within(popover).getByRole('button', { name: 'Open full chat' }));
    expect(await screen.findByText('Conversation dashboard')).toBeTruthy();
    expect(backBar()).toBeNull();
    fireEvent.click(rail('spaces'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    fireEvent.keyDown(window, { key: '1', metaKey: true });
    expect(await screen.findByText('Conversation dashboard')).toBeTruthy();
    expect(backBar()).toBeNull();
  });

  it.each([
    ['Open full chat', false],
    ['Continue chatting', true],
  ])('%s on a progress card opens a banner-free chat and retains the scrolled source location', async (label, composer) => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    await openSpacePage();
    const doc = await screen.findByTestId('space-doc');
    doc.scrollTop = 420;
    fireEvent.click(screen.getByRole('button', { name: new RegExp(label) }));

    expect(await screen.findByText('Conversation dashboard')).toBeTruthy();
    expect(reveal).toHaveBeenCalledWith('ws-1', 'n-live');
    expect(backBar()).toBeNull();
    expect(getSourceNavState().focus?.nodeId ?? null).toBe(composer ? 'n-live' : null);

    act(() => { returnToSourceOrigin(); });
    const back = await screen.findByTestId('space-doc');
    await waitFor(() => expect(back.scrollTop).toBe(420));
    expect(backBar()).toBeNull();
  });
});
