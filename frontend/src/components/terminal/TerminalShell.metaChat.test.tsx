import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import TerminalShell from './TerminalShell';
import { PrefsProvider } from '../../state/prefs';
import { getAssistantSnapshot, resetAssistantStoreForTests } from '../../state/assistant/assistantStore';
import { resetAssistantPaneStubDrafts } from '../../test/assistantPaneStub';

vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>('../../services/api');
  return { ...actual, fetchPrefs: vi.fn().mockResolvedValue(null) };
});
vi.mock('../../services/api/assistant', async () => {
  const actual = await vi.importActual<typeof import('../../services/api/assistant')>('../../services/api/assistant');
  return { ...actual, fetchAssistant: () => new Promise(() => {}) };
});
vi.mock('../MentionEditor', () => import('../../test/mentionEditorStub'));
vi.mock('./TPane', () => import('../../test/assistantPaneStub'));
vi.mock('../../state/assistant/useAssistantNode', () => ({ useAssistantNode: () => ({ state: 'ready', retry: vi.fn() }) }));
vi.mock('./pages/Home', () => ({ default: () => <div>Conversation home</div> }));
vi.mock('./pages/Dashboard', () => ({ default: () => <div>Conversation dashboard</div> }));
vi.mock('./spaces/SpaceView', () => ({ default: () => <div>Space view</div> }));
vi.mock('./assistant/AssistantPanel', () => ({
  AssistantPanelHost: () => <div data-testid="assistant-panel-host" />,
  assistantPanelTakesEscape: () => false,
}));
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
      selectAllTrees: () => {}, selectProject: () => {},
    }),
    useStructuralSelector: (s: (n: Record<string, unknown>) => unknown) => s({}),
    useChatNodesSnapshot: () => ({}),
    useNodesSelector: () => ({}),
    useChatNode: () => null,
    chatLabel: () => '',
  };
});

const rail = (name: string) => screen.getByRole('navigation', { name: 'Areas' }).querySelector<HTMLButtonElement>(`[data-area="${name}"]`)!;
const panel = () => document.querySelector<HTMLElement>('.meta-chat-panel')!;
const pressCmdJ = () => fireEvent.keyDown(window, { key: 'j', metaKey: true });

describe('TerminalShell Meta agent window', () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetAssistantPaneStubDrafts();
    localStorage.clear();
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false }));
    resetAssistantStoreForTests({ status: 'ready', info: { nodeId: 'assistant-node', workspaceId: 'system', treeId: 't', settings: { runtimeId: 'claude', modelId: null, reasoning: null }, supportedRuntimes: ['claude'] } });
  });
  afterEach(cleanup);

  it('shows the window only in Spaces and keeps its draft across areas', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    expect(panel().hidden).toBe(true);
    expect(screen.getByTestId('assistant-panel-host')).toBeTruthy();

    fireEvent.click(rail('spaces'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    expect(panel().hidden).toBe(false);
    expect(screen.queryByTestId('assistant-panel-host')).toBeNull();
    fireEvent.change(screen.getByLabelText('Message the assistant'), { target: { value: 'keep me' } });

    fireEvent.click(rail('conversations'));
    expect(await screen.findByText('Conversation home')).toBeTruthy();
    expect(panel().hidden).toBe(true);

    fireEvent.click(rail('spaces'));
    expect(panel().hidden).toBe(false);
    expect((screen.getByLabelText('Message the assistant') as HTMLTextAreaElement).value).toBe('keep me');
  });

  it('routes ⌘J to the window in Spaces and to the assistant panel elsewhere, once per press', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(rail('spaces'));
    await screen.findByRole('heading', { level: 1, name: 'Home' });

    pressCmdJ();
    expect(panel().hidden).toBe(true);
    expect(screen.getByRole('button', { name: /Ask assistant/ })).toBeTruthy();
    expect(getAssistantSnapshot().open).toBe(false);
    pressCmdJ();
    expect(panel().hidden).toBe(false);

    fireEvent.click(rail('conversations'));
    await screen.findByText('Conversation home');
    pressCmdJ();
    expect(getAssistantSnapshot().open).toBe(true);
    fireEvent.click(rail('spaces'));
    expect(panel().hidden).toBe(false);
  });

  it('preserves window placement from the sidebar Assistant row and toggles it from the topbar', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(rail('spaces'));
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(panel().dataset.form).toBe('float');

    fireEvent.click(screen.getByText('Assistant', { selector: '.area-side__label' }));
    expect(panel().dataset.form).toBe('float');

    fireEvent.click(panel().querySelector<HTMLButtonElement>('[aria-label="Dock as half screen"]')!);
    fireEvent.click(screen.getByText('Assistant', { selector: '.area-side__label' }));
    expect(panel().dataset.form).toBe('dock');

    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    fireEvent.click(screen.getByText('Assistant', { selector: '.area-side__label' }));
    expect(panel().dataset.form).toBe('full');
    fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));

    const toggle = document.querySelector<HTMLButtonElement>('button.t-icon-btn[aria-label="Assistant"]')!;
    fireEvent.click(toggle);
    expect(panel().hidden).toBe(true);
    fireEvent.click(toggle);
    expect(panel().hidden).toBe(false);
    expect(panel().dataset.form).toBe('dock');
  });

  it('reads Spaces › Home in the topbar on the Spaces Home', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(rail('spaces'));
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    const crumb = document.querySelector<HTMLElement>('.terminal-topbar-breadcrumb')!;
    expect(crumb.textContent).toBe('PAGES›Home');
  });
});
