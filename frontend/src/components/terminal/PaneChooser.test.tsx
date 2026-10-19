import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PaneChooser from './PaneChooser';
import type { LauncherPaneItem } from '../../state/paneItems';

const state = vi.hoisted(() => ({
  activateLauncherPane: vi.fn(() => Promise.resolve('L')),
  adoptTerminalPane: vi.fn(), focusPane: vi.fn(), setFocusedNodeId: vi.fn(),
}));
vi.mock('../../state/chatStore', () => ({
  useChatActions: () => state,
  useChatPanes: () => ({ paneItems: {}, openPanes: ['L'] }),
}));
vi.mock('../../hooks/usePaneShellStyle', () => ({ usePaneShellStyle: () => ({}) }));

const item: LauncherPaneItem = { id: 'L', kind: 'launcher', projectId: 'p1', treeId: null, title: 'New pane', createdAt: 0 };

beforeEach(() => vi.clearAllMocks());

describe('PaneChooser', () => {
  // TerminalShell binds no launcher shortcuts (and ⌘P belongs to Profile), so
  // the chooser must not advertise any.
  it('lists the pane choices without keyboard shortcut hints', () => {
    const { container } = render(<PaneChooser item={item} />);
    for (const label of ['Review', 'Terminal', 'Files', 'Side chat']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(container.querySelector('kbd')).toBeNull();
  });

  it('activates the launcher with the clicked choice', () => {
    render(<PaneChooser item={item} />);
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(state.activateLauncherPane).toHaveBeenCalledWith('L', 'terminal');
  });
});
