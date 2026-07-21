/**
 * Tests for the Topbar right-cluster thread-view toggles (Branches / Map /
 * Digest) and the ‹ back crumb shown on those thread-scoped fullscreen pages.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import TerminalTopbar from './Topbar';
import { ChatProvider } from '../../state/chatStore';
import { PrefsProvider } from '../../state/prefs';
import type { ChatNodeState, Project, Tree } from '../../state/chatTypes';

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

function makeChatNode(id: string): ChatNodeState {
  return {
    nodeId: id,
    chatId: null,
    projectId: 'p1',
    kind: 'chat',
    title: `title-${id}`,
    messages: [],
    followUps: [],
    status: 'idle',
  };
}

function makeUnreadDigestNode(id: string, sources: string[] = ['n1']): ChatNodeState {
  return {
    ...makeChatNode(id),
    kind: 'digest',
    digest: {
      sources,
      sourceFingerprints: {},
      content: 'digest body',
      generatedAt: NOW,
      viewedAt: BEFORE,
      status: 'idle',
    },
  };
}

/** Seed localStorage so ChatProvider hydrates with pre-built nodes/trees. */
function seed(nodes: Record<string, ChatNodeState>, trees: Tree[] = [], activeTreeId: string | null = null) {
  const proj: Project = {
    id: 'p1',
    name: 'Test workspace',
    chatIds: Object.keys(nodes),
    trees,
    activeTreeId,
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
  page: 'dashboard' as const,
  sidebarCollapsed: false,
  onToggleSidebar: vi.fn(),
};

describe('Topbar thread-view toggles', () => {
  it('renders Overview / Map / Digest toggles when a workspace is active and navigates on click', async () => {
    seed({ n1: makeChatNode('n1') });
    const onNav = vi.fn();
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} onNav={onNav} />
      </Wrap>,
    );
    await act(async () => {});
    expect(await screen.findByLabelText('Overview')).toBeTruthy();
    expect(screen.getByLabelText('Digest')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Map'));
    expect(onNav).toHaveBeenCalledWith('map');
  });

  it('shows the unread dot on the Digest toggle when a digest is unread', async () => {
    seed(
      { n1: makeChatNode('n1'), d1: makeUnreadDigestNode('d1') },
      [{ id: 't1', rootNodeId: 'n1', createdAt: BEFORE, lastActiveAt: BEFORE }],
      't1',
    );
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} onNav={vi.fn()} />
      </Wrap>,
    );
    await act(async () => {});
    const digestBtn = await screen.findByLabelText('Digest');
    expect(digestBtn.querySelector('span[aria-hidden]')).not.toBeNull();
    // A read digest (or no digest) renders no dot — the Map toggle never has one.
    const mapBtn = screen.getByLabelText('Map');
    expect(mapBtn.querySelector('span[aria-hidden]')).toBeNull();
  });

  it('does not show another thread’s unread digest', async () => {
    seed(
      {
        n1: makeChatNode('n1'),
        n2: makeChatNode('n2'),
        d2: makeUnreadDigestNode('d2', ['n2']),
      },
      [
        { id: 't1', rootNodeId: 'n1', createdAt: BEFORE, lastActiveAt: BEFORE },
        { id: 't2', rootNodeId: 'n2', createdAt: BEFORE, lastActiveAt: BEFORE },
      ],
      't1',
    );
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} onNav={vi.fn()} />
      </Wrap>,
    );
    await act(async () => {});
    const digestBtn = await screen.findByLabelText('Digest');
    expect(digestBtn.querySelector('span[aria-hidden]')).toBeNull();
  });

  it('renders the ‹ back crumb with the active thread title on the Map page', async () => {
    seed(
      { n1: makeChatNode('n1') },
      [{ id: 't1', rootNodeId: 'n1', createdAt: BEFORE, lastActiveAt: BEFORE, name: 'My thread' }],
      't1',
    );
    const onNav = vi.fn();
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} page="map" onNav={onNav} />
      </Wrap>,
    );
    await act(async () => {});
    expect(await screen.findByText('MAP')).toBeTruthy();
    // The crumb labels the page with the thread, not the workspace.
    expect(screen.getByText('My thread')).toBeTruthy();
    fireEvent.click(screen.getByText('‹ back'));
    expect(onNav).toHaveBeenCalledWith('dashboard');
  });

  it('falls back to the root node title when the active thread is unnamed', async () => {
    seed(
      { n1: makeChatNode('n1') },
      [{ id: 't1', rootNodeId: 'n1', createdAt: BEFORE, lastActiveAt: BEFORE }],
      't1',
    );
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} page="digest" onNav={vi.fn()} />
      </Wrap>,
    );
    await act(async () => {});
    expect(await screen.findByText('title-n1')).toBeTruthy();
  });
});
