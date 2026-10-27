import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AreaRail } from './AreaRail';

describe('AreaRail', () => {
  it('shows four areas, Settings last, and marks the current one', () => {
    render(<AreaRail area="spaces" onSelect={vi.fn()} />);
    const buttons = within(screen.getByRole('navigation', { name: 'Areas' })).getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('data-area'))).toEqual(['conversations', 'spaces', 'scheduled', 'settings']);
    expect(buttons[1].getAttribute('aria-current')).toBe('page');
    expect(buttons.filter((button) => button.hasAttribute('aria-current'))).toHaveLength(1);
  });

  it('reports the area clicked', () => {
    const onSelect = vi.fn();
    render(<AreaRail area="conversations" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scheduled' }));
    expect(onSelect).toHaveBeenCalledWith('scheduled');
  });

  it('marks Settings as an open dialog while keeping the current area selected', () => {
    render(<AreaRail area="spaces" settingsOpen onSelect={vi.fn()} />);
    const settings = screen.getByRole('button', { name: 'Settings' });
    expect(settings.getAttribute('aria-haspopup')).toBe('dialog');
    expect(settings.getAttribute('aria-expanded')).toBe('true');
    expect(settings.hasAttribute('aria-current')).toBe(false);
    expect(screen.getByRole('button', { name: 'Pages' }).getAttribute('aria-current')).toBe('page');
  });

  it('renders badges only when their sources report something', () => {
    const view = render(<AreaRail area="conversations" onSelect={vi.fn()} />);
    expect(document.querySelector('.area-rail__count, .area-rail__dot')).toBeNull();
    view.rerender(<AreaRail area="conversations" onSelect={vi.fn()} badges={{ spacesWaiting: 2, scheduledRunning: true, conversationsDone: true, settingsAlert: true }} />);
    expect(screen.getByRole('button', { name: 'Pages, 2 waiting' }).textContent).toBe('2');
    expect(screen.getByRole('button', { name: 'Scheduled, running' }).querySelector('[data-tone="run"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Conversations, finished' }).querySelector('[data-tone="done"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Settings, needs attention' }).querySelector('[data-tone="warn"]')).not.toBeNull();
  });
});
