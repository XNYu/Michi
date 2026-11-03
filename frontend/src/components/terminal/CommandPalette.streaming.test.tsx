/**
 * A reply streaming in any pane updates the chat nodes many times a second.
 * The palette must keep the row the user moved to: before, every update put
 * the highlight (and the list's scroll) back on the first row.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CommandPalette from './CommandPalette';

const nodes = vi.hoisted(() => {
  let snapshot: Record<string, unknown> = {};
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    /** One streamed chunk: a new snapshot identity, as chatStore publishes. */
    chunk: () => { snapshot = { ...snapshot }; listeners.forEach((fn) => fn()); },
  };
});

vi.mock('../../state/chatStore', async () => {
  const { useSyncExternalStore } = await import('react');
  // Stable across renders, like the real store's state and actions.
  const project = { id: 'workspace-1', name: 'Workspace A', trees: [], activeTreeId: null, chatIds: [] };
  const store = {
    activeProject: project,
    projects: [project],
    selection: new Set<string>(),
    clearSelection: vi.fn(),
    openPane: vi.fn(),
    openPaneInTree: vi.fn(),
    createDigest: vi.fn(),
    createMergedChat: vi.fn(),
    createThread: vi.fn(),
    activateTree: vi.fn(),
    archiveTree: vi.fn(),
    unarchiveTree: vi.fn(),
    selectProject: vi.fn(),
    setFocusedNodeId: vi.fn(),
    setSearchHighlightTerm: vi.fn(),
  };
  return {
    useChatStore: () => store,
    useChatNodesSnapshot: () => useSyncExternalStore(nodes.subscribe, nodes.get),
    // A fresh array on every call, like the real selector.
    selectAllChats: () => [
      { id: 'chat-1', title: 'Pricing', projectId: 'workspace-1', projectName: 'Workspace A' },
      { id: 'chat-2', title: 'Roadmap', projectId: 'workspace-1', projectName: 'Workspace A' },
      { id: 'chat-3', title: 'Hiring', projectId: 'workspace-1', projectName: 'Workspace A' },
    ],
  };
});

vi.mock('../../state/prefs', () => ({
  usePrefs: () => ({ prefs: { bypassPermissions: false }, setPref: vi.fn() }),
}));
vi.mock('../../state/navigateToNode', () => ({ navigateToNode: vi.fn() }));
vi.mock('../../lib/digestPrompt', () => ({ requestDigest: vi.fn() }));

const scrollIntoView = vi.fn();
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  scrollIntoView.mockClear();
});

const activeRow = () => document.querySelector('[data-active="true"]')?.textContent ?? null;

describe('CommandPalette while a reply streams', () => {
  it('keeps the highlighted row and the list scroll across streamed updates', () => {
    render(<CommandPalette activePage="dashboard" setPage={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search chats, commands, messages…');
    const first = activeRow();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const moved = activeRow();
    expect(moved).not.toBe(first);

    scrollIntoView.mockClear();
    for (let i = 0; i < 5; i += 1) act(() => nodes.chunk());

    expect(activeRow()).toBe(moved);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('still moves the highlight to the top when the query changes', () => {
    render(<CommandPalette activePage="dashboard" setPage={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search chats, commands, messages…');
    const first = activeRow();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeRow()).not.toBe(first);
    fireEvent.change(input, { target: { value: 'R' } });
    fireEvent.change(input, { target: { value: '' } });
    expect(activeRow()).toBe(first);
  });
});
