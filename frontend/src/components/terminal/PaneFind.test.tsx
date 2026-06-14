import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import PaneFind from './PaneFind';
import type { ChatNodeState } from '../../state/chatTypes';

function nodeFixture(): ChatNodeState {
  return {
    nodeId: 'n1', chatId: null, projectId: 'p1', kind: 'chat',
    title: 'Test', followUps: [], status: 'idle',
    messages: [
      { id: 'm1', role: 'user', text: 'tier-3 pricing question', toolCalls: [] },
      { id: 'm2', role: 'assistant', text: 'tier-3 SLA detail; another tier-3 mention', toolCalls: [] },
      { id: 'm3', role: 'user', text: 'follow-up about tier-3', toolCalls: [] },
    ],
  };
}

describe('PaneFind', () => {
  it('returns null when open is false', () => {
    const node = nodeFixture();
    const { container } = render(
      <PaneFind open={false} node={node} onClose={vi.fn()} onScrollToMatch={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows total match count when query has matches', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const node = nodeFixture();
    render(<PaneFind open node={node} onClose={vi.fn()} onScrollToMatch={vi.fn()} />);
    const input = screen.getByPlaceholderText(/find in pane/i);
    fireEvent.change(input, { target: { value: 'tier-3' } });
    await vi.advanceTimersByTimeAsync(120);
    // 1 match in m1, 2 matches in m2, 1 match in m3 → 4 total. Counter shows 1/4.
    expect(screen.getByText(/1\s*\/\s*4/)).toBeTruthy();
    vi.useRealTimers();
  });

  it('Enter advances to next match (wraps at end)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const node = nodeFixture();
    const onScrollToMatch = vi.fn();
    render(<PaneFind open node={node} onClose={vi.fn()} onScrollToMatch={onScrollToMatch} />);
    const input = screen.getByPlaceholderText(/find in pane/i);
    fireEvent.change(input, { target: { value: 'tier-3' } });
    await vi.advanceTimersByTimeAsync(120);
    onScrollToMatch.mockClear();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText(/2\s*\/\s*4/)).toBeTruthy();
    expect(onScrollToMatch).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText(/4\s*\/\s*4/)).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Enter' });
    // wrap to 1
    expect(screen.getByText(/1\s*\/\s*4/)).toBeTruthy();
    vi.useRealTimers();
  });

  it('passes within-message occurrence + query to onScrollToMatch (drives the match flash)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const node = nodeFixture();
    const onScrollToMatch = vi.fn();
    render(<PaneFind open node={node} onClose={vi.fn()} onScrollToMatch={onScrollToMatch} />);
    const input = screen.getByPlaceholderText(/find in pane/i);
    fireEvent.change(input, { target: { value: 'tier-3' } });
    await vi.advanceTimersByTimeAsync(120);
    onScrollToMatch.mockClear();

    // Match list (message order): m1#0, m2#0, m2#1, m3#0.
    // occurrence = index of the hit WITHIN its own message; query is the term.
    const lastCall = () => onScrollToMatch.mock.calls[onScrollToMatch.mock.calls.length - 1];

    fireEvent.keyDown(input, { key: 'Enter' }); // → m2, first hit in m2
    expect(lastCall()[0]).toMatchObject({ messageId: 'm2' });
    expect(lastCall()[1]).toBe(0);
    expect(lastCall()[2]).toBe('tier-3');

    fireEvent.keyDown(input, { key: 'Enter' }); // → m2, second hit in m2
    expect(lastCall()[0]).toMatchObject({ messageId: 'm2' });
    expect(lastCall()[1]).toBe(1);

    fireEvent.keyDown(input, { key: 'Enter' }); // → m3, first hit
    expect(lastCall()[0]).toMatchObject({ messageId: 'm3' });
    expect(lastCall()[1]).toBe(0);

    fireEvent.keyDown(input, { key: 'Enter' }); // wrap → m1, first hit
    expect(lastCall()[0]).toMatchObject({ messageId: 'm1' });
    expect(lastCall()[1]).toBe(0);
    vi.useRealTimers();
  });

  it('Shift+Enter goes to previous match (wraps at start)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const node = nodeFixture();
    render(<PaneFind open node={node} onClose={vi.fn()} onScrollToMatch={vi.fn()} />);
    const input = screen.getByPlaceholderText(/find in pane/i);
    fireEvent.change(input, { target: { value: 'tier-3' } });
    await vi.advanceTimersByTimeAsync(120);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    // wrap to last (4)
    expect(screen.getByText(/4\s*\/\s*4/)).toBeTruthy();
    vi.useRealTimers();
  });

  it('Escape calls onClose', () => {
    const onClose = vi.fn();
    const node = nodeFixture();
    render(<PaneFind open node={node} onClose={onClose} onScrollToMatch={vi.fn()} />);
    const input = screen.getByPlaceholderText(/find in pane/i);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows 0/0 with empty query', () => {
    const node = nodeFixture();
    render(<PaneFind open node={node} onClose={vi.fn()} onScrollToMatch={vi.fn()} />);
    expect(screen.getByText(/0\s*\/\s*0/)).toBeTruthy();
  });
});
