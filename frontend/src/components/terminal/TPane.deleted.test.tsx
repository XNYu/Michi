/**
 * Fix A: a pane whose node is `deletedAt` must NOT render the chat surface /
 * composer — otherwise a lingering pane (e.g. opened in another tab before the
 * delete synced over) lets the user keep chatting with a deleted node. TPane
 * renders a "deleted" placeholder instead. Backstop for the reactive pane
 * prune (Fix B): even if a pane id lingers a frame, you can't send to it.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import TPane from './TPane';
import type { ChatNodeState } from '../../state/chatTypes';

if (typeof CSS === 'undefined') {
  (globalThis as any).CSS = {};
}
if (!(CSS as any).highlights) {
  (CSS as any).highlights = new Map();
}

const deletedNode: ChatNodeState = {
  nodeId: 'n1', chatId: null, projectId: 'p1', kind: 'chat',
  title: 't', messages: [], followUps: [], status: 'idle',
  deletedAt: Date.now(),
};

const mockProject = {
  id: 'p1', name: 'P', cwd: '/tmp/p1', chatIds: ['n1'], edges: [],
  trees: [{ id: 'tr1', rootNodeId: 'n1', createdAt: 0, lastActiveAt: 0 }],
  activeTreeId: 'tr1', artifacts: [], createdAt: 0,
};

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  const actions = () => ({
    createContext: () => {},
    focusPane: () => {},
    closePane: () => {},
    reorderPane: () => {},
    sendMessage: () => {},
    retryLastTurn: () => {},
    cancelStream: () => {},
    isObserver: () => false,
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
    dequeueMessage: () => {},
    setComposerDraft: () => {},
    deleteContext: () => {},
  });
  const projects = () => ({
    activeProject: mockProject,
    focusedPane: 'n1',
    openPanes: ['n1'],
    availableModes: [],
    agentStatus: null,
    refreshAgentStatus: () => {},
  });
  return {
    ...actual,
    useChatStore: () => ({ ...projects(), ...actions() }),
    useChatActions: () => actions(),
    useChatProjects: () => projects(),
    useStructuralSelector: (selector: (nodes: Record<string, ChatNodeState>) => unknown) =>
      selector({ n1: deletedNode }),
    useChatNodesSnapshot: () => ({ n1: deletedNode }),
    useChatNode: () => deletedNode,
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
  default: React.forwardRef((_props: any, _ref: any) => <textarea data-testid="composer" />),
}));
vi.mock('./PaneFind', () => ({ default: () => null }));
vi.mock('./PermissionBanner', () => ({ default: () => null }));
vi.mock('../ContextMenu', () => ({ default: () => null }));
vi.mock('../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));

describe('TPane with a deleted node', () => {
  it('renders a deleted placeholder and NO composer', () => {
    const { container, queryByTestId } = render(<TPane nodeId="n1" />);
    expect(container.textContent ?? '').toMatch(/deleted/i);
    // The composer (mocked MentionTextarea) must not be rendered for a deleted node.
    expect(queryByTestId('composer')).toBeNull();
  });
});
