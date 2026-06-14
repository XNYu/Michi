import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { HomeWorkspaceChip } from './HomeWorkspaceChip';

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
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('fires onNewWorkspace when "new workspace" row clicked', () => {
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
    expect(onNew).toHaveBeenCalled();
  });
});
