/**
 * Tests for the Topbar unread button: 4 visual states + filter toggle behaviour.
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
    fetchWorkspaces: vi.fn().mockResolvedValue([]),
    fetchWorkspace: vi.fn().mockResolvedValue(null),
    warmCwd: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../lib/electronBridge', () => ({
  getElectron: () => null,
}));

vi.mock('../ContextsPopover', () => ({
  default: () => <div data-testid="contexts-popover-stub" />,
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
    JSON.stringify({ version: 2, projects: [proj], nodes, activeProjectId: proj.id }),
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

describe('Topbar unread button', () => {
  it('renders with no number when unreadTotal === 0', async () => {
    seedNodes({ n1: makeNode('n1', false) });
    const onNav = vi.fn();
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} onNav={onNav} />
      </Wrap>,
    );
    await act(async () => {});
    const btn = screen.getByRole('button', { name: /unread/i });
    expect(btn).toBeTruthy();
    // No number span — button text content is empty (svg is aria-hidden)
    expect(btn.textContent?.trim()).toBe('');
  });

  it('renders with the number when unreadTotal > 0', async () => {
    seedNodes({ n1: makeNode('n1', true), n2: makeNode('n2', true) });
    const onNav = vi.fn();
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} onNav={onNav} />
      </Wrap>,
    );
    await act(async () => {});
    const btn = screen.getByRole('button', { name: /unread/i });
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
    const btn = screen.getByRole('button', { name: /unread/i });
    expect(btn.textContent?.trim()).toContain('9+');
  });

  // Regression: the unread button is a pure filter toggle and must NEVER call
  // onNav. It used to call onNav('workspaces') on the OFF->ON edge, which collided
  // with TerminalShell.handleNav's toggle semantics ('workspaces' is a TOGGLE_PAGE)
  // and produced a period-4 page cycle (workspace -> home -> workspace). No
  // navigation at the source = the loop cannot exist.
  it('click while OFF turns filter on and NEVER navigates', async () => {
    seedNodes({});
    const onNav = vi.fn();
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} onNav={onNav} />
      </Wrap>,
    );
    await act(async () => {});
    const btn = screen.getByRole('button', { name: /unread/i });
    await act(async () => { fireEvent.click(btn); });
    expect(onNav).not.toHaveBeenCalled();
    // After turning on, aria-label changes to include "Filter: unread only"
    expect(screen.getByRole('button', { name: /filter.*unread/i })).toBeTruthy();
  });

  it('click while ON turns filter off and never navigates', async () => {
    seedNodes({});
    const onNav = vi.fn();
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} onNav={onNav} />
      </Wrap>,
    );
    await act(async () => {});
    const btn = screen.getByRole('button', { name: /unread/i });
    // Turn ON
    await act(async () => { fireEvent.click(btn); });
    // Turn OFF
    const activeBtn = screen.getByRole('button', { name: /filter.*unread/i });
    await act(async () => { fireEvent.click(activeBtn); });
    // onNav untouched across both the ON and OFF clicks.
    expect(onNav).not.toHaveBeenCalled();
    // aria-label reverts to the default "X unread" form
    expect(screen.getByRole('button', { name: /unread/i })).toBeTruthy();
  });

  // "Force-show unread": the filtered/force-expanded tree lives in the sidebar,
  // so turning the filter on opens a collapsed sidebar to surface those items.
  it('turning the filter on opens the sidebar when it is collapsed', async () => {
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
    const btn = screen.getByRole('button', { name: /unread/i });
    await act(async () => { fireEvent.click(btn); });
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it('turning the filter on leaves an already-open sidebar alone', async () => {
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
    const btn = screen.getByRole('button', { name: /unread/i });
    // Turn ON (no-op for sidebar) then OFF — sidebar must never be toggled.
    await act(async () => { fireEvent.click(btn); });
    const activeBtn = screen.getByRole('button', { name: /filter.*unread/i });
    await act(async () => { fireEvent.click(activeBtn); });
    expect(onToggleSidebar).not.toHaveBeenCalled();
  });
});
