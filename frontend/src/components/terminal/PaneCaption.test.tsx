import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PaneCaption from './PaneCaption';

const baseProps = {
  nodeId: 'n1',
  title: 'research-plan',
  focused: false,
  streaming: false,
  error: false,
  onFocus: () => {},
  onClose: () => {},
  onCloseOthers: () => {},
  canCloseOthers: true,
  onReorder: () => {},
};

describe('PaneCaption', () => {
  it('renders the title', () => {
    render(<PaneCaption {...baseProps} />);
    expect(screen.getByText('research-plan')).toBeTruthy();
  });

  it('shows the warning glyph in error state', () => {
    render(<PaneCaption {...baseProps} error />);
    expect(screen.getByText('⚠')).toBeTruthy();
  });

  it('does not show the warning glyph when not in error', () => {
    render(<PaneCaption {...baseProps} />);
    expect(screen.queryByText('⚠')).toBeNull();
  });

  it('calls onFocus on click', () => {
    const onFocus = vi.fn();
    render(<PaneCaption {...baseProps} onFocus={onFocus} />);
    fireEvent.click(screen.getByText('research-plan').parentElement!);
    expect(onFocus).toHaveBeenCalledWith('n1');
  });

  it('starts a drag with the pane MIME type', () => {
    render(<PaneCaption {...baseProps} />);
    const root = screen.getByText('research-plan').parentElement!;
    const data = new Map<string, string>();
    const types: string[] = [];
    const dataTransfer = {
      effectAllowed: '',
      setData: (k: string, v: string) => { data.set(k, v); types.push(k); },
      getData: (k: string) => data.get(k) ?? '',
      types,
    } as unknown as DataTransfer;
    fireEvent.dragStart(root, { dataTransfer });
    expect(data.get('application/x-michi-pane-id')).toBe('n1');
  });

  it('opens a context menu with Close and Close Others', () => {
    render(<PaneCaption {...baseProps} />);
    const root = screen.getByText('research-plan').parentElement!;
    fireEvent.contextMenu(root, { clientX: 10, clientY: 10 });
    expect(screen.getByText('Close')).toBeTruthy();
    expect(screen.getByText('Close Others')).toBeTruthy();
  });
});
