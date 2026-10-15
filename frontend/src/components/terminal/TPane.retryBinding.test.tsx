/**
 * Retrying a failed turn must use the composer's current runtime binding,
 * the same values a fresh send would carry, so a model picked after the
 * failure takes effect.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import TPane from './TPane';
import type { ChatNodeState } from '../../state/chatTypes';

if (typeof CSS === 'undefined') {
  (globalThis as any).CSS = {};
}
if (!(CSS as any).highlights) {
  (CSS as any).highlights = new Map();
}

const failedNode: ChatNodeState = {
  nodeId: 'n1', chatId: null, projectId: 'p1', kind: 'chat',
  title: 't', followUps: [], status: 'error',
  messages: [{ id: 'u1', role: 'user', text: 'hello', toolCalls: [] }],
};

const retryLastTurn = vi.fn();
const agentStatus = {
  runtime: 'kiro', label: 'Kiro', model: 'claude-opus-5.5', reasoning: 'high', hasRequiredKey: true,
  capabilities: { modes: true, permissions: true, models: true, providerModels: false, reasoning: true,
    supportedReasoningLevels: ['low', 'medium', 'high'], apiKeys: false, warmSessions: true, saveContext: true, spawnBranches: true },
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
    retryLastTurn,
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
    agentStatus,
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
      selector({ n1: failedNode }),
    useChatNodesSnapshot: () => ({ n1: failedNode }),
    useChatNode: () => failedNode,
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

describe('TPane retry binding', () => {
  it('passes the resolved runtime, model and effort to retryLastTurn', () => {
    render(<TPane nodeId="n1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry last turn' }));
    expect(retryLastTurn).toHaveBeenCalledExactlyOnceWith('n1', undefined, {
      runtimeId: 'kiro', providerId: undefined, modelId: 'claude-opus-5.5', reasoning: 'high',
    });
  });
});
