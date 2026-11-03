/**
 * ActivityView shares WorkspaceTree's tree controller: switching threads keeps
 * every row's expand/collapse state, and the branch context menu offers the
 * same actions (including "Extract as new thread").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { act, render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import ActivityView from './ActivityView';
import { ChatProvider, useChatActions, useChatStore } from '../../state/chatStore';
import { PREFS_KEY, PrefsProvider } from '../../state/prefs';
import type { ChatNodeState, Project } from '../../state/chatTypes';

const mocks = vi.hoisted(() => ({ extractNodeTree: vi.fn() }));

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    listAgentModes: vi.fn().mockResolvedValue({ availableModes: [], defaultModeId: null }),
    fetchAllWorkspaces: vi.fn().mockResolvedValue([]),
    fetchAllWorkspacesMeta: vi.fn().mockResolvedValue([]),
    fetchTreeMessages: vi.fn().mockResolvedValue([]),
    fetchWorkspaces: vi.fn().mockResolvedValue([]),
    fetchWorkspace: vi.fn().mockResolvedValue(null),
    warmCwd: vi.fn().mockResolvedValue(undefined),
  };
});

// Spy on the store's extract action; everything else stays real.
vi.mock('../../state/chatStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/chatStore')>();
  return {
    ...actual,
    useChatActions: () => ({ ...actual.useChatActions(), extractNodeTree: mocks.extractNodeTree }),
  };
});

if (typeof (globalThis as { CSS?: unknown }).CSS === 'undefined') {
  (globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) };
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  mocks.extractNodeTree.mockReset();
  mocks.extractNodeTree.mockResolvedValue(false);
  Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
});

function chat(nodeId: string, projectId: string, title: string, parentNodeId?: string): ChatNodeState {
  return {
    nodeId, chatId: null, projectId, kind: 'chat', title,
    messages: [], followUps: [], status: 'idle',
    ...(parentNodeId ? { parentNodeId } : {}),
  };
}

function fixture() {
  const now = Date.now();
  const nodes: Record<string, ChatNodeState> = {
    rootA: chat('rootA', 'p1', 'Thread A'),
    childA: chat('childA', 'p1', 'Child of A', 'rootA'),
    childA2: chat('childA2', 'p1', 'Second child of A', 'rootA'),
    rootB: chat('rootB', 'p1', 'Thread B'),
    childB: chat('childB', 'p1', 'Child of B', 'rootB'),
    rootC: chat('rootC', 'p2', 'Thread C'),
    childC: chat('childC', 'p2', 'Child of C', 'rootC'),
  };
  const projects: Project[] = [
    {
      id: 'p1', name: 'Workspace one', cwd: '~/x',
      chatIds: ['rootA', 'childA', 'childA2', 'rootB', 'childB'],
      edges: [
        { source: 'rootA', target: 'childA', kind: 'branch' },
        { source: 'rootA', target: 'childA2', kind: 'branch' },
        { source: 'rootB', target: 'childB', kind: 'branch' },
      ],
      trees: [
        { id: 'tA', rootNodeId: 'rootA', createdAt: 0, lastActiveAt: now - 1_000 },
        { id: 'tB', rootNodeId: 'rootB', createdAt: 0, lastActiveAt: now - 2_000 },
      ],
      activeTreeId: 'tA', createdAt: 0,
    },
    {
      id: 'p2', name: 'Workspace two', cwd: '~/y',
      chatIds: ['rootC', 'childC'],
      edges: [{ source: 'rootC', target: 'childC', kind: 'branch' }],
      trees: [{ id: 'tC', rootNodeId: 'rootC', createdAt: 0, lastActiveAt: now - 3_000 }],
      activeTreeId: 'tC', createdAt: 0,
    },
  ];
  return { nodes, projects };
}

const storeRef: { current: ReturnType<typeof useChatStore> | null } = { current: null };
const actionsRef: { current: ReturnType<typeof useChatActions> | null } = { current: null };
function StoreProbe() {
  storeRef.current = useChatStore();
  actionsRef.current = useChatActions();
  return null;
}

function renderActivity() {
  const { nodes, projects } = fixture();
  localStorage.setItem(
    'michi:v1:state',
    JSON.stringify({ version: 2, projects, nodes, activeProjectId: 'p1' }),
  );
  localStorage.setItem('michi:migrated', '1');
  return render(
    <PrefsProvider>
      <ChatProvider>
        <StoreProbe />
        <ActivityView />
      </ChatProvider>
    </PrefsProvider>,
  );
}

const row = (nodeId: string) => document.querySelector<HTMLElement>(`[data-sidebar-row="${nodeId}"]`);

describe('ActivityView tree controller', () => {
  it('keeps the previous thread expanded when switching to another thread in the same workspace', async () => {
    renderActivity();
    await screen.findByText('Child of A');
    expect(row('childB')).toBeNull();

    fireEvent.click(screen.getByText('Thread B'));

    await waitFor(() => expect(row('childB')).not.toBeNull());
    expect(row('childA')).not.toBeNull();
  });

  it("keeps another workspace's expanded thread open when switching to it", async () => {
    renderActivity();
    await screen.findByText('Child of C');

    fireEvent.click(screen.getByText('Thread C'));

    await waitFor(() => expect(storeRef.current?.activeProject?.id).toBe('p2'));
    expect(row('childC')).not.toBeNull();
    expect(row('childA')).not.toBeNull();
  });

  it('extends the selection with shift+click from the last clicked branch', async () => {
    renderActivity();
    await screen.findByText('Second child of A');

    fireEvent.click(row('childA')!);
    fireEvent.click(row('childA2')!, { shiftKey: true });

    await waitFor(() => expect([...storeRef.current!.selection].sort()).toEqual(['childA', 'childA2']));
  });

  it('offers "Extract as new thread" for a live child and extracts it', async () => {
    renderActivity();
    await screen.findByText('Child of A');

    fireEvent.contextMenu(row('childA')!, { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Extract as new thread/ }));

    // The menu blinks the chosen row before running it.
    await waitFor(() => expect(mocks.extractNodeTree).toHaveBeenCalledWith('childA'));
  });
});

describe('ActivityView re-sort', () => {
  const labels = () => Array.from(document.querySelectorAll('.activity-time-label')).map((label) => label.textContent);

  it('moves a thread that starts streaming into Now without remounting its row', async () => {
    renderActivity();
    await screen.findByText('Child of C');
    const before = row('rootC');
    expect(labels()).toEqual(['Today']);

    act(() => {
      actionsRef.current!.dispatch({ type: 'user-send', nodeId: 'rootC', userText: 'hi', assistantId: 'a1' });
    });

    await waitFor(() => expect(labels()).toEqual(['Now', 'Today']));
    // The same element, now listed first: it glides to its new place
    // (layout="position") instead of being rebuilt under the Now label.
    expect(row('rootC')).toBe(before);
    const threadRows = Array.from(document.querySelectorAll('[data-sidebar-row]'))
      .map((el) => el.getAttribute('data-sidebar-row'))
      .filter((id) => id?.startsWith('root'));
    expect(threadRows).toEqual(['rootC', 'rootA', 'rootB']);
  });

  it('scrolls a revealed row into view, without gliding under reduce motion', async () => {
    const scroll = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>;
    renderActivity();
    await screen.findByText('Child of A');
    fireEvent.click(screen.getByText('Thread B'));
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(scroll.mock.calls.at(-1)?.[0]).toEqual({ block: 'nearest', behavior: 'smooth' });

    cleanup();
    localStorage.clear();
    scroll.mockClear();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ reduceMotion: true }));
    renderActivity();
    await screen.findByText('Child of A');
    fireEvent.click(screen.getByText('Thread B'));
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(scroll.mock.calls.at(-1)?.[0]).toEqual({ block: 'nearest', behavior: 'auto' });
  });
});
