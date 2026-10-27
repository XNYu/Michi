import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PaneCaption from './PaneCaption';
import { OPEN_BACKGROUND_WORK_EVENT, type OpenBackgroundWorkDetail } from './backgroundWork/backgroundWorkEvents';

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
  it('shows the warning glyph in error state', () => {
    render(<PaneCaption {...baseProps} error />);
    expect(screen.getByText('⚠')).toBeTruthy();
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

  describe('background work badge', () => {
    it('shows the running count with what runs', () => {
      render(<PaneCaption {...baseProps} backgroundWork={{ subagents: 2, workflows: 1 }} />);
      const badge = screen.getByTestId('pane-background-work-badge');
      expect(badge.textContent).toBe('◆3');
      expect(badge.getAttribute('aria-label')).toBe('2 subagents · 1 workflow running. Show background work');
      expect(badge.getAttribute('title')).toBe('2 subagents · 1 workflow running');
      // Clickable inside the window's drag region (Electron).
      expect((badge.style as unknown as Record<string, string>).WebkitAppRegion).toBe('no-drag');
    });

    it('is hidden while nothing runs and on non-chat panes', () => {
      const { rerender } = render(<PaneCaption {...baseProps} backgroundWork={{ subagents: 0, workflows: 0 }} />);
      expect(screen.queryByTestId('pane-background-work-badge')).toBeNull();
      rerender(<PaneCaption {...baseProps} kind="digest" backgroundWork={{ subagents: 1, workflows: 0 }} />);
      expect(screen.queryByTestId('pane-background-work-badge')).toBeNull();
      rerender(<PaneCaption {...baseProps} />);
      expect(screen.queryByTestId('pane-background-work-badge')).toBeNull();
    });

    it('opens the drawer on this conversation without focusing or dragging the pane', () => {
      const onFocus = vi.fn();
      const cellClick = vi.fn();
      const cellMouseDown = vi.fn();
      const requests: OpenBackgroundWorkDetail[] = [];
      const listener = (event: Event) => requests.push((event as CustomEvent<OpenBackgroundWorkDetail>).detail);
      window.addEventListener(OPEN_BACKGROUND_WORK_EVENT, listener);
      try {
        render(
          <div onClick={cellClick} onMouseDown={cellMouseDown}>
            <PaneCaption {...baseProps} onFocus={onFocus} backgroundWork={{ subagents: 1, workflows: 0 }} />
          </div>,
        );
        const badge = screen.getByRole('button', { name: '1 subagent running. Show background work' });
        expect(badge.getAttribute('draggable')).toBe('false');
        // Cancelled, so the draggable caption never starts a pane drag.
        expect(fireEvent.mouseDown(badge)).toBe(false);
        fireEvent.click(badge);
        expect(requests).toEqual([{ nodeId: 'n1' }]);
        expect(onFocus).not.toHaveBeenCalled();
        expect(cellClick).not.toHaveBeenCalled();
        expect(cellMouseDown).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener(OPEN_BACKGROUND_WORK_EVENT, listener);
      }
    });
  });
});
