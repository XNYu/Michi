/**
 * Tests for the Topbar activity-view toggle button (formerly the unread button).
 * The button toggles the sidebar between Structure and Activity views.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import TerminalTopbar from './Topbar';
import { ChatProvider } from '../../state/chatStore';
import { PrefsProvider } from '../../state/prefs';
import type { ChatNodeState, Project } from '../../state/chatTypes';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    checkVersion: vi.fn().mockResolvedValue({ updateAvailable: false }),
    triggerUpdate: vi.fn(),
    listAgentModes: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue({ models: [], defaultModel: null }),
    fetchAllWorkspaces: vi.fn().mockResolvedValue([]),
    fetchAllWorkspacesMeta: vi.fn().mockResolvedValue([]),
    fetchTreeMessages: vi.fn().mockResolvedValue([]),
    fetchWorkspaces: vi.fn().mockResolvedValue([]),
    fetchWorkspace: vi.fn().mockResolvedValue(null),
    fetchPersistenceCapabilities: vi.fn().mockRejectedValue('not available'),
    warmCwd: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../lib/electronBridge', () => ({
  getElectron: () => null,
}));

beforeEach(() => {
  if (typeof window !== 'undefined') window.localStorage.clear();
});

const NOW = 1_000_000;
const BEFORE = NOW - 10_000;

function makeNode(id: string, unread: boolean): ChatNodeState {
  return {
    nodeId: id,
    chatId: null,
    projectId: 'p1',
    kind: 'chat',
    title: id,
    messages: [],
    followUps: [],
    status: 'idle',
    lastAssistantAt: unread ? NOW : BEFORE - 1000,
    viewedAt: BEFORE,
  };
}

/** Seed localStorage so ChatProvider hydrates with pre-built nodes. */
function seedNodes(nodes: Record<string, ChatNodeState>) {
  const proj: Project = {
    id: 'p1',
    name: 'Test',
    chatIds: Object.keys(nodes),
    trees: [],
    activeTreeId: null,
    edges: [],
    createdAt: BEFORE,
  };
  localStorage.setItem(
    'michi:v1:state',
    JSON.stringify({ version: 6, projects: [proj], nodes, activeProjectId: proj.id }),
  );
  localStorage.setItem('michi:migrated', '1');
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <PrefsProvider>
      <ChatProvider>{children}</ChatProvider>
    </PrefsProvider>
  );
}

const baseProps = {
  page: 'workspaces' as const,
  sidebarCollapsed: false,
  onToggleSidebar: vi.fn(),
};

describe('Topbar activity toggle button', () => {
  it('renders the activity toggle button', async () => {
    seedNodes({ n1: makeNode('n1', false) });
    const onNav = vi.fn();
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} onNav={onNav} />
      </Wrap>,
    );
    await act(async () => {});
    const btn = screen.getByRole('button', { name: /activity view/i });
    expect(btn).toBeTruthy();
  });

  it('still shows unread badge count', async () => {
    seedNodes({ n1: makeNode('n1', true), n2: makeNode('n2', true) });
    const onNav = vi.fn();
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} onNav={onNav} />
      </Wrap>,
    );
    await act(async () => {});
    const btn = screen.getByRole('button', { name: /activity view/i });
    expect(btn.textContent?.trim()).toContain('2');
  });

  it('caps display at "9+" when total >= 10', async () => {
    const nodes: Record<string, ChatNodeState> = {};
    for (let i = 0; i < 10; i++) nodes[`n${i}`] = makeNode(`n${i}`, true);
    seedNodes(nodes);
    const onNav = vi.fn();
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} onNav={onNav} />
      </Wrap>,
    );
    await act(async () => {});
    const btn = screen.getByRole('button', { name: /activity view/i });
    expect(btn.textContent?.trim()).toContain('9+');
  });

  it('click toggles to activity view and does not navigate', async () => {
    seedNodes({});
    const onNav = vi.fn();
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} onNav={onNav} />
      </Wrap>,
    );
    await act(async () => {});
    const btn = screen.getByRole('button', { name: /activity view/i });
    await act(async () => { fireEvent.click(btn); });
    expect(onNav).not.toHaveBeenCalled();
    // After clicking, aria-label changes to indicate switching to structure
    expect(screen.getByRole('button', { name: /switch to structure/i })).toBeTruthy();
  });

  it('clicking toggles the button to active state', async () => {
    seedNodes({});
    const onNav = vi.fn();
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} onNav={onNav} />
      </Wrap>,
    );
    await act(async () => {});
    // Initially the button is not in "active" state (sidebarView = 'structure')
    const btn = screen.getByRole('button', { name: /activity view/i });
    // The button's background should be transparent (not active)
    expect(btn.style.background).toBe('transparent');
    // After click, it should become active
    await act(async () => { fireEvent.click(btn); });
    expect(onNav).not.toHaveBeenCalled();
  });

  it('clicking while sidebar is collapsed opens the sidebar', async () => {
    seedNodes({});
    const onToggleSidebar = vi.fn();
    render(
      <Wrap>
        <TerminalTopbar
          {...baseProps}
          onNav={vi.fn()}
          sidebarCollapsed={true}
          onToggleSidebar={onToggleSidebar}
        />
      </Wrap>,
    );
    await act(async () => {});
    const btn = screen.getByRole('button', { name: /activity view/i });
    await act(async () => { fireEvent.click(btn); });
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it('clicking while sidebar is open does not toggle the sidebar', async () => {
    seedNodes({});
    const onToggleSidebar = vi.fn();
    render(
      <Wrap>
        <TerminalTopbar
          {...baseProps}
          onNav={vi.fn()}
          sidebarCollapsed={false}
          onToggleSidebar={onToggleSidebar}
        />
      </Wrap>,
    );
    await act(async () => {});
    const btn = screen.getByRole('button', { name: /activity view/i });
    await act(async () => { fireEvent.click(btn); });
    expect(onToggleSidebar).not.toHaveBeenCalled();
  });
});
