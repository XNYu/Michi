import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CommandPalette from './CommandPalette';

vi.mock('../../state/chatStore', () => ({
  useChatStore: () => ({ activeProject: null, projects: [], selection: new Set(), clearSelection: vi.fn(), openPane: vi.fn(), openPaneInTree: vi.fn(), createDigest: vi.fn(), createMergedChat: vi.fn(), createThread: vi.fn(), activateTree: vi.fn(), archiveTree: vi.fn(), unarchiveTree: vi.fn(), selectProject: vi.fn(), setFocusedNodeId: vi.fn(), setSearchHighlightTerm: vi.fn(), agentStatus: { customAgentsEnabled: true } }),
  useChatNodesSnapshot: () => ({}),
  selectAllChats: () => [],
}));
vi.mock('../../state/prefs', () => ({ usePrefs: () => ({ prefs: { bypassPermissions: false }, setPref: vi.fn() }) }));
vi.mock('../../state/useServerSearch', () => ({ useServerSearch: () => ({ matches: [], truncated: false, totalUnbounded: 0 }) }));
vi.mock('../../state/navigateToNode', () => ({ navigateToNode: vi.fn() }));
vi.mock('../../lib/digestPrompt', () => ({ requestDigest: vi.fn() }));

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});

describe('CommandPalette Agent navigation', () => {
  it('opens the Agent Library without requiring an active Workspace', () => {
    const setPage = vi.fn(); const onClose = vi.fn();
    render(<CommandPalette activePage="home" setPage={setPage} onClose={onClose} />);
    fireEvent.click(screen.getByText('Open Agent Library'));
    expect(setPage).toHaveBeenCalledWith('agents');
    expect(onClose).toHaveBeenCalled();
  });

  it('finds Agent navigation by search and keeps existing empty-query number behavior', () => {
    const setPage = vi.fn(); const onClose = vi.fn();
    render(<CommandPalette activePage="dashboard" setPage={setPage} onClose={onClose} />);
    const input = screen.getByPlaceholderText('Search chats, commands, messages…');
    fireEvent.keyDown(input, { key: '1', metaKey: true });
    expect(setPage).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Agent Library' } });
    fireEvent.keyDown(input, { key: '1', metaKey: true });
    expect(setPage).toHaveBeenCalledWith('agents');
    expect(onClose).toHaveBeenCalled();
  });
});
