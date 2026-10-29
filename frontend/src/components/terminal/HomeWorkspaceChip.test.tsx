import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { HomeWorkspaceChip } from './HomeWorkspaceChip';
import { setKnownBackendConnections } from '../../config/backendConnections';

// ContextMenu fires an item's `run` after a ~160ms macOS-style confirm blink
// (see ContextMenu.tsx BLINK_MS), so clicks resolve on a timer, not
// synchronously. Drive that timer with fake timers.
afterEach(() => {
  vi.useRealTimers();
  setKnownBackendConnections([]);
});
function flushBlink() {
  act(() => {
    vi.advanceTimersByTime(200);
  });
}

const proj = (id: string, name: string, backendConnectionId?: string) => ({ id, name, backendConnectionId });

describe('HomeWorkspaceChip', () => {

  it('notes the remote backend after remote workspaces only', () => {
    setKnownBackendConnections([{ id: 'devbox', name: 'Dev desktop', transport: 'ssh', sshHost: 'dev.example', hasToken: true, createdAt: 0, updatedAt: 0 }]);
    render(
      <HomeWorkspaceChip
        active={proj('a', 'Stocks')}
        liveProjects={[proj('a', 'Stocks'), proj('b', 'Bonds', 'local'), proj('c', 'Futures', 'devbox')]}
        onSelect={() => {}}
        onNewWorkspace={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stocks' }));
    const notes = [...document.querySelectorAll('.michi-menu-sublabel')].map((el) => el.textContent);
    expect(notes).toEqual(['Remote · Dev desktop']);
    expect(screen.getByText('Futures').parentElement?.textContent).toBe('FuturesRemote · Dev desktop');
  });

  it('fires onNewWorkspace when "new workspace" row clicked', () => {
    vi.useFakeTimers();
    const onNew = vi.fn();
    render(
      <HomeWorkspaceChip
        active={null}
        liveProjects={[]}
        onSelect={() => {}}
        onNewWorkspace={onNew}
      />,
    );
    fireEvent.click(screen.getByText('no workspace'));
    fireEvent.click(screen.getByText('new workspace'));
    flushBlink();
    expect(onNew).toHaveBeenCalled();
  });

  it('toggles from the chip and shows it pressed while open', () => {
    vi.useFakeTimers();
    render(
      <HomeWorkspaceChip
        active={proj('a', 'Stocks')}
        liveProjects={[proj('a', 'Stocks'), proj('b', 'Bonds')]}
        onSelect={() => {}}
        onNewWorkspace={() => {}}
      />,
    );
    const chip = screen.getByRole('button', { name: 'Stocks' });
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu', { name: 'Workspaces' })).toBeTruthy();
    // The outside-press listener arms a frame after opening; a real second
    // click on the chip is mousedown then click, and must close, not reopen.
    act(() => { vi.advanceTimersByTime(20); });
    fireEvent.mouseDown(chip);
    fireEvent.click(chip);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });

  it('clears the workspace from the × over the folder icon without opening the menu', () => {
    const onClear = vi.fn();
    render(
      <HomeWorkspaceChip
        active={proj('a', 'Stocks')}
        liveProjects={[proj('a', 'Stocks')]}
        onSelect={() => {}}
        onNewWorkspace={() => {}}
        onClear={onClear}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Chat without a workspace' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('offers "no workspace" in the menu for touch and keyboard', () => {
    vi.useFakeTimers();
    const onClear = vi.fn();
    render(
      <HomeWorkspaceChip
        active={proj('a', 'Stocks')}
        liveProjects={[proj('a', 'Stocks')]}
        onSelect={() => {}}
        onNewWorkspace={() => {}}
        onClear={onClear}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stocks' }));
    fireEvent.click(screen.getByText('no workspace'));
    flushBlink();
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('has nothing to clear when no workspace is active', () => {
    render(
      <HomeWorkspaceChip
        active={null}
        liveProjects={[proj('a', 'Stocks')]}
        onSelect={() => {}}
        onNewWorkspace={() => {}}
        onClear={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Chat without a workspace' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'no workspace' }));
    expect(screen.getByText('new workspace')).toBeTruthy();
    // The chip's own label is the only "no workspace": the menu adds no row.
    expect(screen.getAllByText('no workspace')).toHaveLength(1);
  });
});
