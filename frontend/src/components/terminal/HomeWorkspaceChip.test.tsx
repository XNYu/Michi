import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { HomeWorkspaceChip } from './HomeWorkspaceChip';

// ContextMenu fires an item's `run` after a ~160ms macOS-style confirm blink
// (see ContextMenu.tsx BLINK_MS), so clicks resolve on a timer, not
// synchronously. Drive that timer with fake timers.
afterEach(() => {
  vi.useRealTimers();
});
function flushBlink() {
  act(() => {
    vi.advanceTimersByTime(200);
  });
}

const proj = (id: string, name: string) => ({ id, name });

describe('HomeWorkspaceChip', () => {
  it('shows the active workspace name on the chip', () => {
    render(
      <HomeWorkspaceChip
        active={proj('a', 'Stocks')}
        liveProjects={[proj('a', 'Stocks')]}
        onSelect={() => {}}
        onNewWorkspace={() => {}}
      />,
    );
    expect(screen.getByText('Stocks')).toBeTruthy();
  });

  it('shows "no workspace" when active is null', () => {
    render(
      <HomeWorkspaceChip
        active={null}
        liveProjects={[]}
        onSelect={() => {}}
        onNewWorkspace={() => {}}
      />,
    );
    expect(screen.getByText('no workspace')).toBeTruthy();
  });

  it('opens dropdown on chip click and selects on item click', () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    render(
      <HomeWorkspaceChip
        active={proj('a', 'Stocks')}
        liveProjects={[proj('a', 'Stocks'), proj('b', 'Bonds')]}
        onSelect={onSelect}
        onNewWorkspace={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('Stocks'));
    fireEvent.click(screen.getByText('Bonds'));
    flushBlink();
    expect(onSelect).toHaveBeenCalledWith('b');
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
});
