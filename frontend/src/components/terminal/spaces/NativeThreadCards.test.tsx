import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ThreadCardItem } from 'michi-shared';
import { NativeThreadCards, threadCardKind, useThreadCardItems } from './NativeThreadCards';

const fetchThreadCards = vi.fn();
vi.mock('../../../services/api/spacesHome', () => ({ fetchThreadCards: (...args: unknown[]) => fetchThreadCards(...args) }));

const NOW = new Date(2026, 9, 21, 12).getTime();
function card(nodeId: string, extra: Partial<ThreadCardItem> = {}): ThreadCardItem {
  return { nodeId, workspaceId: 'w1', title: `Conversation ${nodeId}`, state: 'done', summary: `Where ${nodeId} stands`, at: NOW - 3_600_000, messageId: null, ...extra };
}

afterEach(() => { fetchThreadCards.mockReset(); });

describe('thread cards on a native page', () => {
  it('keeps the block order, opens a card, and says when a conversation is gone', () => {
    const onOpen = vi.fn();
    const asked = card('n2', { state: 'waiting', summary: 'Asked: which day?' });
    render(<NativeThreadCards block={{ title: 'Sessions', nodeIds: ['n1', 'n2', 'n3', 'gone'] }}
      items={[asked, card('n1'), card('n3', { state: 'idle', summary: '' })]} onOpen={onOpen} now={NOW} />);
    expect(screen.getByRole('heading', { name: 'Sessions 4' })).toBeTruthy();
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Conversation n1Where n1 stands1h',
      'Conversation n2Asked: which day?1h',
      'Conversation n3Not started yet1h',
      'This conversation is no longer here',
    ]);
    fireEvent.click(screen.getByRole('button', { name: /Conversation n2/ }));
    expect(onOpen).toHaveBeenCalledWith(asked);
  });

  it('shows when the cards are still being read, or could not be', () => {
    const { rerender } = render(<NativeThreadCards block={{ nodeIds: ['n1'] }} items={null} onOpen={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toBe('Reading these conversations…');
    expect(screen.getByRole('heading', { name: 'Threads 1' })).toBeTruthy();
    rerender(<NativeThreadCards block={{ nodeIds: ['n1'] }} items={null} failed onOpen={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toBe('These conversations could not be read.');
  });

  it('leads each card with where its conversation stands', () => {
    expect(['waiting', 'stalled', 'running', 'done', 'idle'].map((state) => threadCardKind(card('a', { state: state as ThreadCardItem['state'] }))))
      .toEqual(['waiting', 'stalled', 'doing', 'done', 'idea']);
  });

  it('reads the named conversations of the page workspace, again when the window comes back', async () => {
    fetchThreadCards.mockResolvedValue([card('n1')]);
    const { result, unmount } = renderHook(() => useThreadCardItems('remote-1', 'w1', ['n1', 'n2']));
    expect(result.current.items).toBeNull();
    await waitFor(() => expect(result.current.items).toEqual([card('n1')]));
    expect(fetchThreadCards).toHaveBeenCalledWith('remote-1', expect.objectContaining({ workspaceId: 'w1', nodeIds: ['n1', 'n2'] }));
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(fetchThreadCards).toHaveBeenCalledTimes(2);
    fetchThreadCards.mockRejectedValue(new Error('offline'));
    act(() => { window.dispatchEvent(new Event('focus')); });
    // A failed refresh keeps what was read, and says it failed.
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.items).toEqual([card('n1')]);
    unmount();
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(fetchThreadCards).toHaveBeenCalledTimes(3);
  });
});
