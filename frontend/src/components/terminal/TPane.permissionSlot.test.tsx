/**
 * The permission banner takes the composer's place in one slot: the outgoing
 * side fades (and stops being live at once), then the incoming one comes in.
 * The transcript's bottom clearance follows what is mounted, so it does not
 * drop while the composer is still fading out.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import TPane from './TPane';
import type { ChatNodeState, PermissionRequest } from '../../state/chatTypes';

if (typeof CSS === 'undefined') {
  (globalThis as any).CSS = {};
}
if (!(CSS as any).highlights) {
  (CSS as any).highlights = new Map();
}

const store = vi.hoisted(() => {
  let node: any = null;
  const listeners = new Set<() => void>();
  return {
    get: () => node,
    set: (next: any) => {
      node = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
});

// Lets a test stand in for the browser: something in the commit that swaps
// the leaving banner for the composer reads layout and scrollTop is clamped.
const swapHooks = vi.hoisted(() => ({ bannerRemoved: undefined as undefined | (() => void) }));
vi.mock('./PermissionBanner', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  const actual = await vi.importActual<typeof import('./PermissionBanner')>('./PermissionBanner');
  function PermissionBannerProbe(props: React.ComponentProps<typeof actual.default>) {
    ReactActual.useLayoutEffect(() => () => swapHooks.bannerRemoved?.(), []);
    return ReactActual.createElement(actual.default, props);
  }
  return { default: PermissionBannerProbe };
});

const baseNode: ChatNodeState = {
  nodeId: 'n1', chatId: null, projectId: 'p1', kind: 'chat',
  title: 't', messages: [], followUps: [], status: 'streaming',
};
const permission: PermissionRequest = {
  requestId: 7,
  title: 'Run npm test?',
  options: [
    { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
    { optionId: 'once', kind: 'allow_once', name: 'Allow Once' },
  ],
};
store.set(baseNode);

const mockProject = {
  id: 'p1', name: 'P', cwd: '/tmp/p1', chatIds: ['n1'], edges: [],
  trees: [{ id: 'tr1', rootNodeId: 'n1', createdAt: 0, lastActiveAt: 0 }],
  activeTreeId: 'tr1', artifacts: [], createdAt: 0,
};

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  const useNode = () => ReactActual.useSyncExternalStore(store.subscribe, store.get);
  const actions = () => ({
    createContext: () => {},
    focusPane: () => {},
    closePane: () => {},
    reorderPane: () => {},
    sendMessage: () => {},
    retryLastTurn: () => {},
    cancelStream: () => {},
    createChildChat: () => Promise.resolve(),
    fanoutBranches: () => Promise.resolve(),
    setFocusedNodeId: () => {},
    switchAgent: () => Promise.resolve(),
    resolvePermission: () => {},
    denyPermission: () => {},
    addPendingComment: () => {},
    removePendingComment: () => {},
    clearPendingComments: () => {},
    queueMessage: () => {},
    steerMessage: async () => false,
    dequeueMessage: () => {},
    setComposerDraft: () => {},
    deleteContext: () => {},
  });
  const projects = () => ({
    activeProject: mockProject,
    availableModes: [],
    agentStatus: null,
    refreshAgentStatus: () => {},
  });
  const panes = () => ({
    focusedPane: 'n1',
    openPanes: ['n1'],
    focusNonce: 0,
    paneItems: {},
    viewMode: 'single' as const,
  });
  return {
    ...actual,
    useChatStore: () => ({ ...projects(), ...panes(), ...actions() }),
    useChatActions: () => actions(),
    useChatProjects: () => projects(),
    useChatPanes: () => panes(),
    useStructuralSelector: (selector: (nodes: Record<string, ChatNodeState>) => unknown) =>
      selector({ n1: useNode() }),
    useChatNodesSnapshot: () => ({ n1: store.get() }),
    useChatNode: () => useNode(),
    chatLabel: () => '',
  };
});

vi.mock('../../state/prefs', async () => {
  const actual = await vi.importActual<any>('../../state/prefs');
  return {
    ...actual,
    usePrefs: () => ({
      prefs: {
        fontFamily: 'sans', showThoughts: false, terminalPalette: 'michi',
        terminalDensity: 'compact', paneRules: true, focusDim: 0, quoteMaxLines: 2,
      },
    }),
  };
});

vi.mock('../SelectionActions', () => ({ default: () => null }));
vi.mock('../SlashPopup', () => ({ default: () => null }));
vi.mock('../AtMentionPopup', () => ({ default: () => null }));
vi.mock('../MentionEditor', () => ({
  default: React.forwardRef((_props: any, ref: any) => {
    const field = React.useRef<HTMLTextAreaElement>(null);
    React.useImperativeHandle(ref, () => ({ editor: { commands: { focus: () => field.current?.focus() } } }));
    return <textarea ref={field} data-testid="composer" />;
  }),
}));
vi.mock('./PaneFind', () => ({ default: () => null }));
vi.mock('../ContextMenu', () => ({ default: () => null }));
vi.mock('../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));

const transcript = () => document.querySelector('.terminal-pane__transcript') as HTMLElement;
const composerCard = () => document.querySelector('.terminal-composer') as HTMLElement | null;
const banner = () => screen.queryByRole('group', { name: 'Permission request' });

describe('TPane bottom slot: permission banner ↔ composer', () => {
  it('fades the composer out before the banner comes in, and back again', async () => {
    store.set(baseNode);
    render(<TPane nodeId="n1" />);
    await screen.findByTestId('composer');
    // The floating composer's clearance: its height (96 before a measurement)
    // + 40. The banner, in the flow, leaves 12.
    const clearance = transcript().style.paddingBottom;
    expect(clearance).toMatch(/^calc\(136px \+ var\(/);

    act(() => store.set({ ...baseNode, pendingPermission: permission }));
    // The composer is on its way out: still drawn, no longer live, and the
    // transcript keeps its clearance until it has gone.
    const ghost = composerCard()!.parentElement!;
    expect(ghost.hasAttribute('inert')).toBe(true);
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(transcript().style.paddingBottom).toBe(clearance);
    expect(banner()).toBeNull();

    await waitFor(() => expect(banner()).toBeTruthy());
    expect(composerCard()).toBeNull();
    expect(transcript().style.paddingBottom).toMatch(/^calc\(12px \+ var\(/);
    expect(screen.getByRole('button', { name: 'Allow Once' })).toBeTruthy();

    act(() => store.set({ ...baseNode, pendingPermission: null }));
    // The answered banner can no longer be answered while it leaves.
    const leaving = document.querySelector('[aria-label="Permission request"]')!.parentElement!;
    expect(leaving.hasAttribute('inert')).toBe(true);
    expect(banner()).toBeNull();

    await waitFor(() => expect(composerCard()).toBeTruthy());
    expect(document.querySelector('[aria-label="Permission request"]')).toBeNull();
    expect(transcript().style.paddingBottom).toBe(clearance);
    expect(composerCard()!.parentElement!.hasAttribute('inert')).toBe(false);
  });

  it('focuses the composer once it is back when the turn ends as its request is withdrawn', async () => {
    store.set({ ...baseNode, pendingPermission: permission });
    render(<TPane nodeId="n1" />);
    expect(composerCard()).toBeNull();
    act(() => store.set({ ...baseNode, status: 'idle', pendingPermission: null }));
    const field = await screen.findByTestId('composer');
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  it('holds the 12px clearance while a request pending at mount leaves, even if the node arrived late', async () => {
    store.set(undefined);
    const view = render(<TPane nodeId="n1" />);
    act(() => store.set({ ...baseNode, pendingPermission: permission }));
    expect(banner()).toBeTruthy();
    expect(transcript().style.paddingBottom).toMatch(/^calc\(12px \+ var\(/);
    act(() => store.set({ ...baseNode, pendingPermission: null }));
    // The banner is leaving; the composer is not back yet.
    expect(composerCard()).toBeNull();
    expect(transcript().style.paddingBottom).toMatch(/^calc\(12px \+ var\(/);
    await waitFor(() => expect(composerCard()).toBeTruthy());
    expect(transcript().style.paddingBottom).toMatch(/^calc\(136px \+ var\(/);
    view.unmount();
  });

  it('puts the transcript back where it sat from its end when the composer returns', async () => {
    store.set({ ...baseNode, pendingPermission: permission });
    const view = render(<TPane nodeId="n1" />);
    const el = transcript();
    // Content 900px; the banner (108px, the composer's room) shortens the viewport.
    let bannerGone = false;
    let top = 0;
    const padding = () => Number(/^calc\((\d+)px/.exec(el.style.paddingBottom)?.[1] ?? 0);
    const scrollHeight = () => 900 + padding();
    const clientHeight = () => (bannerGone ? 508 : 400);
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: clientHeight });
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });
    top = scrollHeight() - clientHeight() - 40; // 40px above the end
    swapHooks.bannerRemoved = () => {
      // The banner is out and the clearance is still 12px: a layout read now
      // clamps scrollTop to the taller, less padded transcript.
      bannerGone = true;
      top = Math.min(top, scrollHeight() - clientHeight());
    };
    try {
      act(() => store.set({ ...baseNode, pendingPermission: null }));
      await waitFor(() => expect(composerCard()).toBeTruthy());
      expect(el.style.paddingBottom).toMatch(/^calc\(136px \+ var\(/);
      expect(scrollHeight() - clientHeight() - top).toBe(40);
    } finally {
      swapHooks.bannerRemoved = undefined;
      view.unmount();
    }
  });

  it('shows a request that is already pending as it is, without the composer', async () => {
    store.set({ ...baseNode, pendingPermission: permission });
    render(<TPane nodeId="n1" />);
    expect(banner()).toBeTruthy();
    expect(composerCard()).toBeNull();
    expect(transcript().style.paddingBottom).toMatch(/^calc\(12px \+ var\(/);
    const slot = banner()!.parentElement as HTMLElement;
    expect(slot.style.opacity).not.toBe('0');
  });
});

describe('TPane send scroll', () => {
  const msg = (id: string, role: 'user' | 'assistant', clientKey?: string) => ({
    id, role, text: id, toolCalls: [], blocks: [], createdAt: 1, ...(clientKey ? { clientKey } : {}),
  });

  it('scrolls a new send into place once, not again when realign-assistant-id renames it', async () => {
    const scrollTo = vi.fn();
    const original = (HTMLElement.prototype as any).scrollTo;
    (HTMLElement.prototype as any).scrollTo = scrollTo;
    try {
      const history = [msg('u1', 'user'), msg('a1', 'assistant')];
      store.set({ ...baseNode, messages: history });
      render(<TPane nodeId="n1" />);
      await screen.findByTestId('composer');
      const smooth = () => scrollTo.mock.calls.filter(([arg]) => arg?.behavior === 'smooth').length;
      expect(smooth()).toBe(0);

      act(() => store.set({ ...baseNode, messages: [...history, msg('u2-local', 'user'), msg('a2-local', 'assistant')] }));
      await waitFor(() => expect(smooth()).toBe(1));

      act(() => store.set({
        ...baseNode,
        messages: [...history, msg('u2', 'user', 'u2-local'), msg('a2', 'assistant', 'a2-local')],
      }));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(smooth()).toBe(1);
    } finally {
      (HTMLElement.prototype as any).scrollTo = original;
    }
  });
});
